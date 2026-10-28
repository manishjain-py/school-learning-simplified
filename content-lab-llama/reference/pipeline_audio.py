"""One frozen local narration execution; completed evidence can be verified/reused."""
from pathlib import Path
import re
import stat

from . import media
from .inputs import canonical, frozen_inputs, load_manifest, read, runtime_identity, save, sha
from .runtime import exclusive


def _safe_tree(root):
    root = Path(root)
    if root.is_symlink() or any(p.is_symlink() for p in root.rglob('*')):
        raise ValueError('Audio evidence may not contain symlinks')
    if any(not (p.is_dir() or stat.S_ISREG(p.stat().st_mode)) for p in root.rglob('*')):
        raise ValueError('Audio evidence requires ordinary files and directories')


def _file(root, name):
    if not isinstance(name, str):
        raise ValueError('Audio evidence filename must be text')
    relative = Path(name)
    if relative.is_absolute() or '..' in relative.parts:
        raise ValueError('Audio evidence filename must be inside its explicit root')
    path = root/relative
    if not path.resolve().is_relative_to(root.resolve()) or not path.is_file() or path.is_symlink():
        raise ValueError('Audio evidence file missing or outside its explicit root')
    return path


def _hashes(root, names=None):
    _safe_tree(root)
    names = sorted(str(p.relative_to(root)) for p in root.rglob('*') if p.is_file()) if names is None else sorted(names)
    return {name: {'sha256': sha(_file(root, name).read_bytes()), 'bytes': _file(root, name).stat().st_size}
            for name in names}


def _origins(bundle, rows):
    return {'kind': bundle['metadata']['kind'], 'input_sha256': bundle['file_identity']['pack']['sha256'],
            'selection_namespace': 'one-based native pack array ordinal', 'blocks': rows}


def _descriptor(root, value):
    path = _file(root, value['file'])
    if sha(path.read_bytes()) != value['sha256'] or path.stat().st_size != value['bytes']:
        raise ValueError('Audio descriptor file hash/size changed')


def _narration(workspace, scripts, result=None):
    """Check the exact projection and the native combined/clip/timing evidence."""
    root = workspace/'audio'
    _safe_tree(root)
    narration = read(root/'narration.json')
    if result is not None and narration != result:
        raise ValueError('Saved narration differs from media return value')
    if narration['schema'] != 'local-narration/v1' or read(root/'scripts.json') != scripts:
        raise ValueError('Narration scripts differ from frozen author projection')
    if narration['scripts_sha256'] != sha((root/'scripts.json').read_bytes()):
        raise ValueError('Narration scripts hash changed')
    _descriptor(root, narration['audio'])
    if len(narration['clips']) != len(scripts) or len(narration['blocks']) != len(scripts):
        raise ValueError('Narration clip/cue count differs from author projection')
    expected_words = []
    for index, (script, clip, block) in enumerate(zip(scripts, narration['clips'], narration['blocks'])):
        if clip['index'] != index or clip['script'] != script['script'] or clip['script_sha256'] != sha(script['script'].encode()):
            raise ValueError('Narration clip script/order changed')
        if (root/f'script-{index:03d}.txt').read_bytes() != script['script'].encode():
            raise ValueError('Narration script text file changed')
        _descriptor(root, clip)
        _descriptor(root, clip['source_file'])
        if any(block[key] != value for key, value in {'index': index, **script, 'clip_sha256': clip['sha256']}.items()):
            raise ValueError('Narration block cues differ from author projection')
        expected_words.extend((index, match.group(), match.start(), match.end()) for match in re.finditer(r'\S+', script['script']))
    words = [(row['block'], row['text'], row['char_start'], row['char_end']) for row in narration['words']]
    if words != expected_words:
        raise ValueError('Narration word cues differ from author projection')
    return narration


def _summary(workspace, scripts, narration):
    return {'status': 'complete', 'blocks': len(scripts), 'paid_calls': 0,
            'audio': narration['audio'], 'word_timing': narration['word_timing'],
            'alignment_verified': narration['alignment_verified'], 'output_manifest': 'outputs.json',
            'identity_sha256': sha((workspace/'identity.json').read_bytes()),
            'outputs_sha256': sha((workspace/'outputs.json').read_bytes())}


def create_audio(bundle, blobs, manifest_bytes, workspace, *, factory):
    """Execute once in an already locked, empty workspace (also used by the CLI)."""
    scripts, origins = factory.blocks(bundle)
    save(workspace/'inputs.json', bundle)
    (workspace/'manifest.json').write_bytes(manifest_bytes)
    for name, data in blobs.items():
        if Path(name).name != name:
            raise ValueError('Invalid frozen audio input filename')
        (workspace/'inputs').mkdir(exist_ok=True)
        (workspace/'inputs'/name).write_bytes(data)
    save(workspace/'scripts.json', scripts)
    save(workspace/'origins.json', _origins(bundle, origins))
    frozen_names = {'inputs.json', 'manifest.json', 'scripts.json', 'origins.json',
                    *(f'inputs/{name}' for name in blobs)}
    # All bytes and the selected local tool/runtime identity are durable before
    # speech execution. Even an interrupted/failed execution occupies this run.
    save(workspace/'identity.json', {'schema': 'local-audio-run/v1', 'factory': 'audio',
         'input_sha256': sha(canonical(bundle)), 'manifest_sha256': sha(manifest_bytes),
         'runtime': runtime_identity(), 'execution': media.runtime_identity(),
         'frozen_files': _hashes(workspace, frozen_names), 'paid_calls': 0})
    try:
        speech, supplied = factory.narration_inputs(bundle, workspace)
        result = media.synthesize(scripts, workspace/'audio', speech, supplied, allowed_roots=[workspace])
        narration = _narration(workspace, scripts, result)
        save(workspace/'outputs.json', {'schema': 'local-audio-files/v1', 'files': _hashes(workspace/'audio')})
        summary = _summary(workspace, scripts, narration)
        save(workspace/'summary.json', summary)
        return summary
    except Exception as error:
        save(workspace/'summary.json', {'status': 'failed', 'paid_calls': 0,
             'kind': 'local_audio_execution', 'error_type': type(error).__name__, 'error': str(error)})
        raise


def _completed(bundle, blobs, manifest_bytes, workspace, factory):
    identity = read(workspace/'identity.json')
    if not isinstance(identity, dict) or identity.get('schema') != 'local-audio-run/v1' or identity.get('factory') != 'audio':
        raise ValueError('Audio identity lacks the frozen resume contract')
    if identity['runtime'] != runtime_identity() or identity['execution'] != media.runtime_identity():
        raise ValueError('Frozen audio runtime or local tools changed')
    if identity['manifest_sha256'] != sha(manifest_bytes) or identity['input_sha256'] != sha(canonical(bundle)):
        raise ValueError('Declared audio input bytes changed')
    frozen, frozen_blobs = frozen_inputs(workspace)
    if frozen != bundle or frozen_blobs != blobs:
        raise ValueError('Frozen audio inputs differ from declared bytes')
    names = {'inputs.json', 'manifest.json', 'scripts.json', 'origins.json',
             *(f'inputs/{name}' for name in blobs)}
    if identity['frozen_files'] != _hashes(workspace, names):
        raise ValueError('Frozen audio evidence file hashes changed')
    scripts, origins = factory.blocks(frozen)
    if read(workspace/'scripts.json') != scripts or read(workspace/'origins.json') != _origins(frozen, origins):
        raise ValueError('Frozen audio scripts/origins differ from native projection')
    outputs = read(workspace/'outputs.json')
    if not isinstance(outputs, dict) or outputs.get('schema') != 'local-audio-files/v1' or outputs.get('files') != _hashes(workspace/'audio'):
        raise ValueError('Audio output file hashes or file set changed')
    narration = _narration(workspace, scripts)
    summary = _summary(workspace, scripts, narration)
    if read(workspace/'summary.json') != summary:
        raise ValueError('Audio summary differs from frozen evidence')
    return summary


def ensure_audio(manifest: Path, workspace: Path) -> dict:
    """Create once or verify/reuse COMPLETE audio; never repeat incomplete speech.

    The native manifest explicitly declares every input. Media receives only this
    frozen workspace as its allowed root. Legacy or partial evidence requires
    manual reconciliation; no evidence is deleted and no replacement run is made.
    """
    import run_audio

    manifest, workspace = Path(manifest), Path(workspace)
    _safe_tree(workspace)
    bundle, blobs = load_manifest(manifest, run_audio)
    manifest_bytes = manifest.read_bytes()
    with exclusive(workspace) as workspace:
        _safe_tree(workspace)
        if not any(p.name != 'operator.lock' for p in workspace.iterdir()):
            return {**create_audio(bundle, blobs, manifest_bytes, workspace, factory=run_audio), 'reused': False}
        try:
            summary = read(workspace/'summary.json') if (workspace/'summary.json').is_file() else None
            if not isinstance(summary, dict) or summary.get('status') != 'complete':
                raise RuntimeError('Audio workspace is incomplete; manual reconciliation required; no automatic resynthesis')
            return {**_completed(bundle, blobs, manifest_bytes, workspace, run_audio), 'reused': True}
        except (ValueError, KeyError, TypeError, OSError) as error:
            raise RuntimeError(f'Audio reuse refused: {error}; manual reconciliation required') from error
