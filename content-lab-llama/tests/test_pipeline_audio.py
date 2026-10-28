"""R10 audio identity/reuse contracts; synthetic bytes, no speech tools or network."""
import builtins
from copy import deepcopy
from pathlib import Path
import re
import socket
import sys
import wave

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import run_audio
from reference import pipeline_audio as audio
from reference.factories import translate
from reference.inputs import ROOT, canonical, load_manifest, read, save, sha
from reference.runtime import Runner


@pytest.fixture(autouse=True)
def offline(monkeypatch):
    original = builtins.__import__

    def no_sdk(name, *args, **kwargs):
        if name.split('.')[0] in ('boto3', 'botocore'):
            raise AssertionError('Hosted SDK forbidden')
        return original(name, *args, **kwargs)

    def forbidden(*args, **kwargs):
        raise AssertionError('Network forbidden')

    monkeypatch.setattr(builtins, '__import__', no_sdk)
    for method in ('connect', 'connect_ex', 'send', 'sendall', 'sendto'):
        monkeypatch.setattr(socket.socket, method, forbidden)
    monkeypatch.setattr(socket, 'create_connection', forbidden)


def descriptor(path, root):
    return {'file': str(path.relative_to(root)), 'sha256': sha(path.read_bytes()), 'bytes': path.stat().st_size}


def wav(path, pcm):
    with wave.open(str(path), 'wb') as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(24000)
        out.writeframes(pcm)


def synthetic_audio(scripts, output_dir, config, supplied, *, allowed_roots):
    """Write native evidence without claiming these mock bytes are speech proof."""
    workspace = output_dir.parent
    assert allowed_roots == [workspace]
    assert read(workspace/'scripts.json') == scripts
    identity = read(workspace/'identity.json')
    assert identity['runtime'] and identity['execution'] and identity['paid_calls'] == 0
    for name, row in identity['frozen_files'].items():
        assert descriptor(workspace/name, workspace) == {'file': name, **row}
    output_dir.mkdir()
    save(output_dir/'scripts.json', scripts)
    clips, blocks, words = [], [], []
    pcm = b'\x10\x01' * 2400
    for index, script in enumerate(scripts):
        (output_dir/f'script-{index:03d}.txt').write_text(script['script'])
        source = output_dir/f'clip-{index:03d}.source.bin'
        source.write_bytes(supplied[index]['path'].read_bytes() if supplied else b'SYNTHETIC SOURCE '+bytes([index]))
        decoded = output_dir/f'clip-{index:03d}.wav'
        wav(decoded, pcm)
        clip = {**descriptor(decoded, output_dir), 'index': index, 'script': script['script'],
                'script_sha256': sha(script['script'].encode()), 'source_file': descriptor(source, output_dir)}
        clips.append(clip)
        blocks.append({'index': index, **script, 'clip_sha256': clip['sha256'],
                       'start_ms': index*100, 'end_ms': (index+1)*100})
        matches = list(re.finditer(r'\S+', script['script']))
        words.extend({'block': index, 'text': match.group(), 'char_start': match.start(), 'char_end': match.end(),
                      'start_ms': index*100+j*100/len(matches), 'end_ms': index*100+(j+1)*100/len(matches)}
                     for j, match in enumerate(matches))
    wav(output_dir/'narration.wav', pcm*len(scripts))
    result = {'schema': 'local-narration/v1', 'audio': descriptor(output_dir/'narration.wav', output_dir),
              'clips': clips, 'blocks': blocks, 'words': words, 'word_timing': 'estimated',
              'alignment_verified': False, 'scripts_sha256': sha((output_dir/'scripts.json').read_bytes())}
    save(output_dir/'narration.json', result)
    # Every audio-tree file is hashed, including additional cue artifacts.
    save(output_dir/'cues.json', {'blocks': blocks, 'words': words})
    return result


@pytest.fixture
def local_audio(monkeypatch):
    calls = []
    monkeypatch.setattr(audio, 'runtime_identity', lambda: {'python_code': 'frozen-synthetic-runtime'})
    monkeypatch.setattr(audio.media, 'runtime_identity', lambda: {'tools': 'frozen-synthetic-tool-binaries'})

    def tracked(*args, **kwargs):
        calls.append((deepcopy(args[0]), args[1], deepcopy(args[2]), deepcopy(args[3]), kwargs))
        return synthetic_audio(*args, **kwargs)

    monkeypatch.setattr(audio.media, 'synthesize', tracked)
    return calls


def manifest(directory, *, supplied=False):
    directory.mkdir()
    save(directory/'pack.json', {'cards': [{'card_idx': 7, 'card_type': 'text', 'lines': [
        {'display': 'Different display one', 'audio': 'Synthetic final author one.'},
        {'display': 'Different display two', 'audio': 'Synthetic final author two.'}]}]})
    value = {'factory': 'audio', 'metadata': {'kind': 'explain'}, 'pages': [],
             'files': {'pack': {'path': 'pack.json', 'type': 'json'}}}
    if supplied:
        for index in range(1, 3):
            name = f'clip_{index:03d}'
            (directory/f'{name}.bin').write_bytes(f'SYNTHETIC SUPPLIED {index}'.encode())
            value['files'][name] = {'path': f'{name}.bin', 'type': 'binary'}
        save(directory/'speech.json', {'language': 'en', 'clips': ['clip_001', 'clip_002']})
        alignment = [{'words': [], 'provenance': {'method': 'synthetic binding only'}} for _ in range(2)]
        save(directory/'alignment.json', {'blocks': alignment})
        value['files'].update(speech={'path': 'speech.json', 'type': 'json'},
                              alignment={'path': 'alignment.json', 'type': 'json'})
    save(directory/'manifest.json', value)
    return directory/'manifest.json'


def snapshot(workspace):
    return {str(p.relative_to(workspace)): p.read_bytes() for p in workspace.rglob('*')
            if p.is_file() and p.name != 'operator.lock'}


def test_actual_r6_final_checkin_reveal_is_projected_exactly_in_native_order(tmp_path):
    bundle, blobs = load_manifest(ROOT/'examples/translate/manifest.json', translate)
    # The stock example has no reveal_text. Declare one in a new frozen synthetic
    # source so the actual R6 feedback stream must export final reveal_audio.
    bundle['declared']['checkins']['check_ins'][0]['reveal_text'] = 'SYNTHETIC FINAL REVEAL INPUT'
    source = canonical(bundle['declared']['checkins'])
    bundle['file_identity']['checkins']['sha256'] = sha(source)
    blobs[bundle['file_identity']['checkins']['file']] = source
    workspace = tmp_path/'translate'
    workspace.mkdir()
    run = Runner(workspace, translate, bundle=bundle, blobs=blobs, config={'provider': 'fixture', 'image_limit': 3})
    translate.graph(run).invoke({'last_role': 'start'})
    pack = read(workspace/'artifacts/deck_hi.json')
    frozen = canonical(pack)
    ordinal, item = next((i, row) for i, row in enumerate(pack['items'], 1)
                         if row['source']['card_type'] == 'check_in')
    assert item['reveal_audio'] and 'नमूना' in item['reveal_audio']
    scripts, origins = run_audio.blocks({'metadata': {'kind': 'translate_deck'}, 'declared': {
        'pack': pack, 'selection': {'indices': [ordinal]}}})
    expected = [item['question_audio'], *item.get('options_audio', []), item.get('explanation_display', ''),
                item.get('hint_audio', ''), item.get('success_audio', ''), item['reveal_audio']]
    assert [row['script'] for row in scripts] == [text for text in expected if text]
    assert scripts[-1]['script'] == item['reveal_audio']
    assert all(row['ordinal'] == ordinal and row['native_card_idx'] == item['source']['card_idx'] for row in origins)
    assert canonical(pack) == frozen


def test_complete_reuse_verifies_every_file_without_repeating_synthesis(tmp_path, local_audio):
    source = manifest(tmp_path/'source')
    workspace = tmp_path/'audio-stage'
    first = audio.ensure_audio(source, workspace)
    before = snapshot(workspace)
    second = audio.ensure_audio(source, workspace)
    assert first['status'] == second['status'] == 'complete'
    assert first['reused'] is False and second['reused'] is True and len(local_audio) == 1
    assert first['audio'] == second['audio'] and before == snapshot(workspace)
    files = read(workspace/'outputs.json')['files']
    assert set(files) == {str(p.relative_to(workspace/'audio')) for p in (workspace/'audio').rglob('*') if p.is_file()}
    assert {'narration.wav', 'narration.json', 'scripts.json', 'cues.json', 'clip-000.wav', 'clip-000.source.bin'} <= set(files)
    assert read(workspace/'origins.json')['blocks'][0]['native_card_idx'] == 7


@pytest.mark.parametrize('name', ['audio/narration.wav', 'audio/narration.json', 'audio/cues.json',
    'audio/clip-000.wav', 'audio/clip-000.source.bin', 'audio/script-000.txt', 'audio/scripts.json',
    'scripts.json', 'origins.json', 'inputs/declared-pack.json', 'manifest.json', 'inputs.json',
    'outputs.json', 'summary.json', 'identity.json'])
def test_modified_audio_or_frozen_evidence_refuses_reuse_without_writes(tmp_path, local_audio, name):
    source = manifest(tmp_path/'source')
    workspace = tmp_path/'audio-stage'
    audio.ensure_audio(source, workspace)
    if name == 'summary.json':
        changed = read(workspace/name)
        changed['blocks'] += 1
        save(workspace/name, changed)
    else:
        with (workspace/name).open('ab') as out:
            out.write(b' ')
    before = snapshot(workspace)
    with pytest.raises(RuntimeError, match='reuse refused'):
        audio.ensure_audio(source, workspace)
    assert len(local_audio) == 1 and snapshot(workspace) == before


@pytest.mark.parametrize('change', ['add', 'remove'])
def test_output_file_set_must_match_exactly(tmp_path, local_audio, change):
    source = manifest(tmp_path/'source')
    workspace = tmp_path/'audio-stage'
    audio.ensure_audio(source, workspace)
    if change == 'add':
        (workspace/'audio/untracked-output.bin').write_bytes(b'SYNTHETIC EXTRA')
    else:
        (workspace/'audio/clip-000.source.bin').unlink()
    with pytest.raises(RuntimeError, match='file set changed'):
        audio.ensure_audio(source, workspace)
    assert len(local_audio) == 1


@pytest.mark.parametrize('change', ['manifest', 'pack', 'runtime', 'tools'])
def test_declared_byte_runtime_and_tool_identity_are_frozen(tmp_path, local_audio, monkeypatch, change):
    source = manifest(tmp_path/'source')
    workspace = tmp_path/'audio-stage'
    audio.ensure_audio(source, workspace)
    if change in ('manifest', 'pack'):
        with (source if change == 'manifest' else source.parent/'pack.json').open('ab') as out:
            out.write(b'\n')  # Semantically equal JSON still changes declared byte identity.
    elif change == 'runtime':
        monkeypatch.setattr(audio, 'runtime_identity', lambda: {'python_code': 'changed'})
    else:
        monkeypatch.setattr(audio.media, 'runtime_identity', lambda: {'tools': 'changed'})
    before = snapshot(workspace)
    with pytest.raises(RuntimeError, match='reuse refused'):
        audio.ensure_audio(source, workspace)
    assert len(local_audio) == 1 and snapshot(workspace) == before


def test_failure_keeps_frozen_author_and_partial_evidence_and_never_repeats(tmp_path, local_audio, monkeypatch):
    source = manifest(tmp_path/'source')
    workspace = tmp_path/'audio-stage'
    failed_calls = []

    def fail(scripts, output_dir, *args, **kwargs):
        failed_calls.append(1)
        assert read(workspace/'identity.json')['frozen_files']
        output_dir.mkdir()
        save(output_dir/'scripts.json', scripts)
        (output_dir/'partial.wav').write_bytes(b'SYNTHETIC PARTIAL')
        raise audio.media.MediaError('Synthetic local speech failure')

    monkeypatch.setattr(audio.media, 'synthesize', fail)
    with pytest.raises(audio.media.MediaError, match='Synthetic local speech failure'):
        audio.ensure_audio(source, workspace)
    before = snapshot(workspace)
    assert read(workspace/'summary.json')['status'] == 'failed'
    assert read(workspace/'scripts.json')[0]['script'] == 'Synthetic final author one.'
    assert (workspace/'inputs/declared-pack.json').read_bytes() == (source.parent/'pack.json').read_bytes()
    monkeypatch.setattr(audio.media, 'synthesize', synthetic_audio)
    with pytest.raises(RuntimeError, match='manual reconciliation required; no automatic resynthesis'):
        audio.ensure_audio(source, workspace)
    assert failed_calls == [1] and not local_audio and before == snapshot(workspace)


@pytest.mark.parametrize('status', [None, 'running', 'failed', 'complete'])
def test_occupied_legacy_or_incomplete_workspace_is_not_restarted(tmp_path, local_audio, status):
    source = manifest(tmp_path/'source')
    workspace = tmp_path/'audio-stage'
    workspace.mkdir()
    (workspace/'old-evidence.txt').write_text('SYNTHETIC PRIOR EVIDENCE')
    if status:
        save(workspace/'summary.json', {'status': status, 'paid_calls': 0})
    before = snapshot(workspace)
    with pytest.raises(RuntimeError, match='manual reconciliation required'):
        audio.ensure_audio(source, workspace)
    assert not local_audio and before == snapshot(workspace)


def test_malformed_summary_refuses_manual_reconciliation_without_synthesis(tmp_path, local_audio):
    source = manifest(tmp_path/'source')
    workspace = tmp_path/'audio-stage'
    workspace.mkdir()
    (workspace/'summary.json').write_bytes(b'{"status":')
    before = snapshot(workspace)
    with pytest.raises(RuntimeError, match='manual reconciliation required'):
        audio.ensure_audio(source, workspace)
    assert not local_audio and before == snapshot(workspace)


def test_supplied_clips_and_alignment_bind_only_to_frozen_allowed_root(tmp_path, local_audio):
    source = manifest(tmp_path/'source', supplied=True)
    workspace = tmp_path/'audio-stage'
    audio.ensure_audio(source, workspace)
    scripts, output, speech, supplied, kwargs = local_audio[0]
    assert speech == {'language': 'en'} and output == workspace/'audio'
    assert kwargs['allowed_roots'] == [workspace]
    for index in range(len(scripts)):
        frozen = workspace/'inputs'/f'declared-clip_{index+1:03d}.binary'
        assert supplied[index]['path'] == frozen and supplied[index]['sha256'] == sha(frozen.read_bytes())
        assert supplied[index]['alignment']['provenance']['method'] == 'synthetic binding only'
    assert audio.ensure_audio(source, workspace)['reused'] is True and len(local_audio) == 1


def test_standalone_still_refuses_occupied_workspace_but_creates_reusable_hashes(tmp_path, local_audio):
    source = manifest(tmp_path/'source')
    workspace = tmp_path/'audio-stage'
    assert run_audio.main([str(source), '--workspace', str(workspace)]) == 0
    assert audio.ensure_audio(source, workspace)['reused'] is True
    with pytest.raises(ValueError, match='contains evidence; use a fresh workspace'):
        run_audio.main([str(source), '--workspace', str(workspace)])
    assert len(local_audio) == 1


def test_changed_native_script_from_synthesizer_is_a_technical_failure(tmp_path, local_audio, monkeypatch):
    source = manifest(tmp_path/'source')
    workspace = tmp_path/'audio-stage'

    def changed(*args, **kwargs):
        result = synthetic_audio(*args, **kwargs)
        result['blocks'][0]['script'] = 'UNAUTHORIZED REPLACEMENT'
        save(args[1]/'narration.json', result)
        return result

    monkeypatch.setattr(audio.media, 'synthesize', changed)
    with pytest.raises(ValueError, match='block cues differ'):
        audio.ensure_audio(source, workspace)
    assert read(workspace/'summary.json')['status'] == 'failed'
    assert read(workspace/'scripts.json')[0]['script'] == 'Synthetic final author one.'
    assert not (workspace/'outputs.json').exists()


def test_audio_symlinks_are_refused_before_execution(tmp_path, local_audio):
    source = manifest(tmp_path/'source')
    real = tmp_path/'real'
    real.mkdir()
    linked = tmp_path/'linked'
    linked.symlink_to(real, target_is_directory=True)
    with pytest.raises(ValueError, match='symlinks'):
        audio.ensure_audio(source, linked)
    assert not local_audio and not list(real.iterdir())
