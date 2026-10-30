"""Durable local speech recovery; deterministic PCM, no hosted or speech calls."""
from pathlib import Path
import socket
import sys
import wave

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import run_audio
from reference import media, pipeline_audio
from reference.inputs import read, save, sha


@pytest.fixture
def local_tools(tmp_path, monkeypatch):
    binary = tmp_path/'local-tool'
    binary.write_bytes(b'fixed local tool identity')
    monkeypatch.setattr(media, '_tool', lambda name: str(binary))
    monkeypatch.setattr(media, 'installed_voices', lambda: [{'voice': 'Samantha', 'locale': 'en_US'}])
    monkeypatch.setattr(media, 'runtime_identity', lambda: {'local_tools': 'fixed'})
    monkeypatch.setattr(pipeline_audio, 'runtime_identity', lambda: {'runtime': 'fixed'})
    def no_network(*args, **kwargs):
        raise AssertionError('No network in local recovery checks')
    monkeypatch.setattr(socket, 'create_connection', no_network)
    state = {'calls': [], 'decode_calls': [], 'errors': {}}
    def speech(args, timeout=120):
        script = Path(args[args.index('-f')+1]).read_text()
        target = Path(args[args.index('-o')+1])
        state['calls'].append(script)
        target.write_bytes(b'retained local source: '+script.encode())
        failure = state['errors'].get(len(state['calls']))
        if failure:
            raise failure
        return ''
    def decode(source, target):
        state['decode_calls'].append(str(source))
        pcm = b'\x10\x01'*2400
        with wave.open(str(target), 'wb') as out:
            out.setnchannels(1)
            out.setsampwidth(2)
            out.setframerate(24000)
            out.writeframes(pcm)
        return pcm, 100.0, 272.0
    monkeypatch.setattr(media, '_run', speech)
    monkeypatch.setattr(media, '_decode', decode)
    return state


def snapshot(root):
    return {str(p.relative_to(root)): p.read_bytes() for p in root.rglob('*')
            if p.is_file() and p.name != 'operator.lock'}


def synthesize(root, scripts=None, config=None):
    return media.synthesize(scripts or ['First authored line.', 'Second authored line.'], root,
                            config, allowed_roots=[root.parent])


def manifest(root):
    root.mkdir()
    save(root/'pack.json', {'cards': [{'card_idx': 1, 'card_type': 'text', 'lines': [
        {'display': 'First display', 'audio': 'First authored line.'},
        {'display': 'Second display', 'audio': 'Second authored line.'}]}]})
    save(root/'manifest.json', {'factory': 'audio', 'metadata': {'kind': 'explain'}, 'pages': [],
                               'files': {'pack': {'path': 'pack.json', 'type': 'json'}}})
    return root/'manifest.json'


def test_timeout_retries_once_retaining_partial_files_and_error(tmp_path, local_tools):
    out = tmp_path/'audio'
    error = media.MediaTimeout('local speech timed out')
    error.stderr, error.stdout = 'retained diagnostic', 'partial diagnostic'
    local_tools['errors'][1] = error
    result = synthesize(out)
    assert local_tools['calls'] == ['First authored line.', 'First authored line.', 'Second authored line.']
    failed = read(out/'attempts/clip-000/01/result.json')
    assert failed['status'] == 'failed' and failed['retryable']
    assert failed['stderr'] == 'retained diagnostic'
    assert (out/'attempts/clip-000/01/source.aiff').read_bytes().endswith(b'First authored line.')
    assert result['clips'][0]['file'] == 'attempts/clip-000/02/decoded.wav'
    before = snapshot(out)
    assert synthesize(out) == result
    assert len(local_tools['calls']) == 3 and len(local_tools['decode_calls']) == 2
    assert snapshot(out) == before


def test_interrupted_resume_reuses_completed_clip_without_speech_or_decode(tmp_path, local_tools):
    out = tmp_path/'audio'
    local_tools['errors'][2] = KeyboardInterrupt()
    with pytest.raises(KeyboardInterrupt):
        synthesize(out)
    first = snapshot(out/'attempts/clip-000')
    partial = (out/'attempts/clip-001/01/source.aiff').read_bytes()
    result = synthesize(out)
    assert local_tools['calls'] == ['First authored line.', 'Second authored line.', 'Second authored line.']
    assert len(local_tools['decode_calls']) == 2 and len(result['clips']) == 2
    assert snapshot(out/'attempts/clip-000') == first
    assert (out/'attempts/clip-001/01/source.aiff').read_bytes() == partial
    assert read(out/'attempts/clip-001/01/result.json')['status'] == 'interrupted'


def test_retry_limit_persists_across_resume_without_reset(tmp_path, local_tools):
    out = tmp_path/'audio'
    local_tools['errors'] = {1: media.MediaTimeout('one'), 2: media.MediaTimeout('two')}
    with pytest.raises(media.MediaError, match='exhausted its 2'):
        synthesize(out)
    before = snapshot(out)
    with pytest.raises(media.MediaError, match='exhausted its 2'):
        synthesize(out)
    assert len(local_tools['calls']) == 2 and snapshot(out) == before


def test_non_timeout_failure_is_not_retried(tmp_path, local_tools):
    out = tmp_path/'audio'
    local_tools['errors'][1] = media.MediaError('voice failed')
    with pytest.raises(media.MediaError, match='voice failed'):
        synthesize(out)
    before = snapshot(out)
    with pytest.raises(media.MediaError, match='manual reconciliation'):
        synthesize(out)
    assert len(local_tools['calls']) == 1 and snapshot(out) == before


@pytest.mark.parametrize('change', ['script', 'config', 'clip', 'attempt'])
def test_partial_recovery_rejects_changed_identity_or_completed_evidence(tmp_path, local_tools, change):
    out = tmp_path/'audio'
    local_tools['errors'][2] = KeyboardInterrupt()
    with pytest.raises(KeyboardInterrupt):
        synthesize(out)
    kwargs = {}
    if change == 'script':
        kwargs['scripts'] = ['Changed authored line.', 'Second authored line.']
    elif change == 'config':
        kwargs['config'] = {'rate': 200}
    elif change == 'clip':
        (out/'attempts/clip-000/01/decoded.wav').write_bytes(b'changed')
    else:
        (out/'attempts/clip-000/01/attempt.json').write_text('{}')
    before = snapshot(out)
    with pytest.raises(media.MediaError):
        synthesize(out, **kwargs)
    assert snapshot(out) == before and len(local_tools['calls']) == 2


def test_supplied_source_hash_and_alignment_are_frozen(tmp_path, local_tools):
    supplied = tmp_path/'supplied.wav'
    supplied.write_bytes(b'explicit source')
    binding = {0: {'path': supplied, 'sha256': sha(supplied.read_bytes())}}
    out = tmp_path/'audio'
    first = media.synthesize(['Supplied authored line.'], out, supplied_clips=binding, allowed_roots=[tmp_path])
    assert not local_tools['calls']
    binding[0]['alignment'] = {'words': [], 'provenance': {'method': 'changed'}}
    before = snapshot(out)
    with pytest.raises(media.MediaError, match='Frozen narration evidence changed'):
        media.synthesize(['Supplied authored line.'], out, supplied_clips=binding, allowed_roots=[tmp_path])
    assert snapshot(out) == before
    binding[0].pop('alignment')
    supplied.write_bytes(b'changed source')
    with pytest.raises(media.MediaError, match='hash mismatch'):
        media.synthesize(['Supplied authored line.'], out, supplied_clips=binding, allowed_roots=[tmp_path])
    assert first['clips'][0]['source']['kind'] == 'supplied'


@pytest.mark.parametrize('change', ['clip', 'extra', 'script'])
def test_complete_narration_refuses_mutated_tree(tmp_path, local_tools, change):
    out = tmp_path/'audio'
    synthesize(out)
    path = {'clip': 'attempts/clip-000/01/decoded.wav', 'extra': 'untracked.bin', 'script': 'scripts.json'}[change]
    (out/path).write_bytes(b'changed')
    before = snapshot(out)
    with pytest.raises(media.MediaError, match='Completed narration'):
        synthesize(out)
    assert snapshot(out) == before and len(local_tools['calls']) == 2


def test_pipeline_partial_resume_keeps_identity_and_completed_clip(tmp_path, local_tools):
    source, workspace = manifest(tmp_path/'source'), tmp_path/'stage'
    local_tools['errors'][2] = KeyboardInterrupt()
    with pytest.raises(KeyboardInterrupt):
        pipeline_audio.ensure_audio(source, workspace)
    identity = (workspace/'identity.json').read_bytes()
    assert read(workspace/'identity.json')['schema'] == 'local-audio-run/v2'
    first = snapshot(workspace/'audio/attempts/clip-000')
    result = pipeline_audio.ensure_audio(source, workspace)
    assert result['status'] == 'complete' and result['resumed']
    assert (workspace/'identity.json').read_bytes() == identity
    assert snapshot(workspace/'audio/attempts/clip-000') == first
    before = snapshot(workspace)
    assert pipeline_audio.ensure_audio(source, workspace)['reused']
    assert snapshot(workspace) == before and len(local_tools['calls']) == 3
    with pytest.raises(ValueError, match='fresh workspace'):
        run_audio.main([str(source), '--workspace', str(workspace)])


def test_pipeline_retains_previous_failure_summary_and_validates_attempt_logs(tmp_path, local_tools, monkeypatch):
    source, workspace = manifest(tmp_path/'source'), tmp_path/'stage'
    original = media.synthesize
    def interrupted_closeout(*args, **kwargs):
        original(*args, **kwargs)
        raise media.MediaError('Failure after durable narration before stage closeout')
    monkeypatch.setattr(media, 'synthesize', interrupted_closeout)
    with pytest.raises(media.MediaError, match='stage closeout'):
        pipeline_audio.ensure_audio(source, workspace)
    failed = (workspace/'summary.json').read_bytes()
    monkeypatch.setattr(media, 'synthesize', original)
    assert pipeline_audio.ensure_audio(source, workspace)['status'] == 'complete'
    assert (workspace/'execution-attempts/002/previous-summary.json').read_bytes() == failed
    assert len(local_tools['calls']) == 2
    (workspace/'execution-attempts/001/result.json').write_text('{}')
    before = snapshot(workspace)
    with pytest.raises(RuntimeError, match='execution attempt evidence changed'):
        pipeline_audio.ensure_audio(source, workspace)
    assert snapshot(workspace) == before


def test_stage_closeout_failure_preserves_successful_media_receipt(tmp_path, local_tools, monkeypatch):
    source, workspace = manifest(tmp_path/'source'), tmp_path/'stage'
    original_save = pipeline_audio.save
    failed = []
    def fail_outputs_once(path, value):
        if Path(path).name == 'outputs.json' and not failed:
            failed.append(True)
            raise OSError('interrupted stage evidence recording')
        return original_save(path, value)
    monkeypatch.setattr(pipeline_audio, 'save', fail_outputs_once)
    with pytest.raises(OSError, match='evidence recording'):
        pipeline_audio.ensure_audio(source, workspace)
    attempt = workspace/'execution-attempts/001'
    receipt = (attempt/'result.json').read_bytes()
    assert read(attempt/'result.json')['status'] == 'complete'
    assert read(attempt/'closeout-error.json')['status'] == 'failed'
    assert pipeline_audio.ensure_audio(source, workspace)['status'] == 'complete'
    assert (attempt/'result.json').read_bytes() == receipt
    assert len(local_tools['calls']) == 2


def test_pipeline_partial_changed_input_refuses_before_writes(tmp_path, local_tools):
    source, workspace = manifest(tmp_path/'source'), tmp_path/'stage'
    local_tools['errors'][2] = KeyboardInterrupt()
    with pytest.raises(KeyboardInterrupt):
        pipeline_audio.ensure_audio(source, workspace)
    pack = read(source.parent/'pack.json')
    pack['cards'][0]['lines'][0]['audio'] = 'Changed authored line.'
    save(source.parent/'pack.json', pack)
    before = snapshot(workspace)
    with pytest.raises(RuntimeError, match='input bytes changed'):
        pipeline_audio.ensure_audio(source, workspace)
    assert snapshot(workspace) == before and len(local_tools['calls']) == 2


@pytest.mark.parametrize('nested', [False, True])
def test_symlink_refused_before_any_write(tmp_path, local_tools, nested):
    out, target = tmp_path/'audio', tmp_path/'target'
    target.mkdir()
    if nested:
        out.mkdir()
        (out/'linked').symlink_to(target, target_is_directory=True)
    else:
        out.symlink_to(target, target_is_directory=True)
    with pytest.raises(media.MediaError, match='symlink'):
        synthesize(out)
    assert not list(target.iterdir()) and not local_tools['calls']


def test_legacy_partial_narration_refuses_without_changes(tmp_path, local_tools):
    out = tmp_path/'audio'
    out.mkdir()
    (out/'partial.wav').write_bytes(b'legacy evidence')
    before = snapshot(out)
    with pytest.raises(media.MediaError, match='lacks the local recovery contract'):
        synthesize(out)
    assert snapshot(out) == before and not local_tools['calls']
