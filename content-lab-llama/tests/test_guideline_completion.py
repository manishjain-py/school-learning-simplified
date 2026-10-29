"""Versioned operational completion, using synthetic content and no live clients."""
import json
import socket

import pytest

import run_factory as cli
from test_guideline_batches import runner, task_data
from reference import pipeline as p
from reference.factories import explain, guideline as f, toc
from reference.inputs import ROOT, canonical, read, save, sha
from reference.pipeline_fixture import PipelineFixture
from reference.runtime import Runner, report


def response(value):
    return {'output': {'message': {'content': [{'text': json.dumps(value)}]}}, 'stopReason': 'end_turn'}


class Attempt4Fixture(PipelineFixture):
    """Actual failure classes, synthetic values; candidate 2 keeps its original ID."""
    def invoke(self, request, *, role, notes_pages):
        if role == 'draft_1' and notes_pages is None:
            return response({'artifact': []})  # strict object-envelope failure
        if role == 'structure' and notes_pages is not None:
            return response({'ok': False, 'findings': ['SYNTHETIC failed inspection'], 'note': 'SYNTHETIC'})
        if role == 'selection' and notes_pages is None:
            assert [c['index'] for c in task_data(request)['task_inputs']['candidates']] == [2]
            return response({'winner_index': 2})
        return super().invoke(request, role=role, notes_pages=notes_pages)


@pytest.fixture(autouse=True)
def offline(monkeypatch):
    def forbidden(*args, **kwargs):
        raise AssertionError('Live provider/client/network forbidden')
    import boto3
    monkeypatch.setattr(boto3, 'client', forbidden)
    monkeypatch.setattr(socket.socket, 'connect', forbidden)


def completed(tmp_path, provider=None, labels=None):
    run = runner(tmp_path, labels or [57, 58, 59, 60, 61])
    run.provider = provider or Attempt4Fixture()
    f.graph(run).invoke({'last_role': 'start'})
    return run


def rewrite_result(run, key, value):
    """Coherent synthetic checkpoint/ledger edits to test independent prerequisites."""
    save(run.workspace/'checkpoints'/f'{key}.json', value)
    call = next(c for c in run.ledger['calls'] if c['key'] == key)
    call['checkpoint_sha256'] = sha(canonical(value))
    save(run.ledger_path, run.ledger)


def evidence_bytes(run):
    return {str(path.relative_to(run.workspace)): path.read_bytes() for path in run.workspace.rglob('*')
            if path.is_file() and path.name not in ('report.html', 'summary.json')}


@pytest.mark.parametrize('page_count', [5, 7])
def test_attempt4_shape_operational_complete_failed_and_unexecuted_roles_visible(tmp_path, page_count):
    run = completed(tmp_path, labels=list(range(57, 57+page_count)))
    before = evidence_bytes(run)
    summary = report(run.workspace, f)
    assert summary['status'] == 'complete'
    assert summary['completion_contract'] == f.COMPLETION_CONTRACT
    assert summary['role_execution_status'] == 'partial_or_failed'
    assert summary['roles'] == {role: ('failed' if role == 'draft_1' else 'unavailable' if role == 'structure' else 'ok')
                                for role in f.ROLES}
    assert summary['checkpoint_statuses']['draft_1'] == 'failed'
    assert summary['checkpoint_statuses']['structure__batch_1'] == 'failed'
    assert summary['checkpoint_statuses']['structure'] == 'not_executed_after_failure'
    assert not summary['completion_blockers']
    batches = (page_count+2)//3
    assert len(run.ledger['calls']) == summary['requests'] == 7*batches+1
    assert summary['exposure_usd'] == 0
    assert all(row['status'] == 'intact' for row in summary['final_outputs'].values())
    assert run.output('accuracy')['ok'] is False
    revision = read(run.workspace/'requests/revision.json')
    reviews = task_data(revision)['task_inputs']['reviews']
    assert reviews['accuracy'] == run.output('accuracy')
    assert reviews['structure'] == {'technical_failure': {'role': 'structure', 'status': 'unavailable'}}
    assert 'SYNTHETIC failed inspection' not in json.dumps(revision)
    for role, filename in f.FINAL_EXPORTS.items():
        assert read(run.workspace/'artifacts'/filename) == run.output(role)['artifact']
    html = (run.workspace/'report.html').read_text()
    assert 'Operational status: complete. Role execution status: partial_or_failed' in html
    assert evidence_bytes(run) == before


def test_completed_resume_no_requests_and_all_evidence_bytes_unchanged(tmp_path, monkeypatch):
    run = completed(tmp_path)
    before = evidence_bytes(run)
    monkeypatch.setattr(PipelineFixture, 'invoke', lambda *a, **k: pytest.fail('Repeated request'))
    resumed = Runner(run.workspace, f, resume=True)
    f.graph(resumed).invoke({'last_role': 'start'})
    assert report(run.workspace, f)['status'] == 'complete'
    assert evidence_bytes(run) == before
    assert resumed.exposure() == 0


def test_legacy_identity_keeps_failed_status_under_new_renderer(tmp_path):
    run = completed(tmp_path)
    identity = read(run.workspace/'identity.json')
    identity.pop('completion_contract')
    identity['runtime'] = {'historical': 'SYNTHETIC legacy renderer identity'}
    save(run.workspace/'identity.json', identity)
    before = evidence_bytes(run)
    summary = report(run.workspace, f)
    assert summary['status'] == 'partial_or_failed'
    assert 'completion_contract' not in summary
    assert evidence_bytes(run) == before


def test_only_guideline_new_identities_opt_in(tmp_path):
    run = runner(tmp_path, [57])
    assert read(run.workspace/'identity.json')['completion_contract'] == f.COMPLETION_CONTRACT
    other = tmp_path/'toc'; other.mkdir()
    bundle = {**run.bundle, 'factory': 'toc'}
    other_run = Runner(other, toc, bundle=bundle, blobs=run.blobs, config=run.config)
    assert 'completion_contract' not in other_run.identity


@pytest.mark.parametrize('role', ['draft_2', 'selection', 'revision', 'refresher'])
@pytest.mark.parametrize('inspection', [False, True])
def test_failed_required_author_or_inspection_blocks(tmp_path, role, inspection):
    run = completed(tmp_path)
    key = role+'__batch_1' if inspection else role
    rewrite_result(run, key, {'status': 'failed', 'error': 'SYNTHETIC failure'})
    assert report(run.workspace, f)['status'] == 'partial_or_failed'


@pytest.mark.parametrize('winner', [1, 0, True, '2'])
def test_failed_candidate_or_invalid_original_selection_blocks(tmp_path, winner):
    run = completed(tmp_path)
    rewrite_result(run, 'selection', {'status': 'ok', 'output': {'winner_index': winner}})
    assert report(run.workspace, f)['status'] == 'partial_or_failed'


def test_both_drafts_fail_no_final_author_or_downstream_start(tmp_path):
    class NoDraft(PipelineFixture):
        def invoke(self, request, *, role, notes_pages):
            if role.startswith('draft') and notes_pages is None:
                return response({'artifact': []})
            return super().invoke(request, role=role, notes_pages=notes_pages)
    run = runner(tmp_path, [57, 58, 59, 60, 61]); run.provider = NoDraft()
    with pytest.raises(ValueError, match='No usable draft'):
        f.graph(run).invoke({'last_role': 'start'})
    assert report(run.workspace, f)['status'] == 'partial_or_failed'
    assert not (run.workspace/'artifacts/guideline.json').exists()


@pytest.mark.parametrize('filename', f.FINAL_EXPORTS.values())
@pytest.mark.parametrize('mode', ['missing', 'changed', 'malformed', 'nonfinite'])
def test_final_exports_block_report_explicit_resume_reconstructs_without_calls(tmp_path, filename, mode):
    run = completed(tmp_path)
    pristine = evidence_bytes(run)
    path = run.workspace/'artifacts'/filename
    if mode == 'missing':
        path.unlink()
    else:
        path.write_text({'changed': '{}', 'malformed': '{', 'nonfinite': '{"x":NaN}'}[mode])
    before = evidence_bytes(run)
    assert report(run.workspace, f)['status'] == 'partial_or_failed'
    assert evidence_bytes(run) == before
    f.graph(Runner(run.workspace, f, resume=True)).invoke({'last_role': 'start'})
    assert evidence_bytes(run) == pristine
    assert report(run.workspace, f)['status'] == 'complete'


@pytest.mark.parametrize('damage', ['checkpoint_missing', 'checkpoint_changed', 'request_missing', 'request_changed', 'dependency_changed',
                                  'ledger_missing_call', 'ledger_duplicate_call', 'ledger_role', 'ledger_request_hash',
                                  'ledger_config', 'unexplained_skip', 'input_image', 'input_bundle', 'contract'])
def test_missing_or_mismatched_evidence_blocks(tmp_path, damage):
    run = completed(tmp_path)
    key = 'draft_1'  # even the tolerated failed draft must have intact evidence
    checkpoint = run.workspace/'checkpoints'/f'{key}.json'
    request = run.workspace/'requests'/f'{key}.json'
    if damage == 'checkpoint_missing': checkpoint.unlink()
    elif damage == 'checkpoint_changed': save(checkpoint, {'status': 'failed', 'error': 'CHANGED'})
    elif damage == 'request_missing': request.unlink()
    elif damage == 'request_changed': save(request, {'CHANGED': True})
    elif damage == 'dependency_changed':
        save(request, {'CHANGED': True})
        next(c for c in run.ledger['calls'] if c['key'] == key)['request_sha256'] = sha(canonical(read(request)))
        save(run.ledger_path, run.ledger)
    elif damage.startswith('ledger_'):
        call = next(c for c in run.ledger['calls'] if c['key'] == key)
        if damage == 'ledger_missing_call': run.ledger['calls'].remove(call)
        elif damage == 'ledger_duplicate_call': run.ledger['calls'].append(call.copy())
        elif damage == 'ledger_role': call['role'] = 'draft_2'
        elif damage == 'ledger_request_hash': call['request_sha256'] = 'CHANGED'
        else: run.ledger['config'] = {'provider': 'fixture', 'image_limit': 1}
        save(run.ledger_path, run.ledger)
    elif damage == 'unexplained_skip':
        for key in ('coverage__batch_1', 'coverage'):
            (run.workspace/'checkpoints'/f'{key}.json').unlink()
        run.ledger['calls'] = [c for c in run.ledger['calls'] if c['role'] != 'coverage']
        save(run.ledger_path, run.ledger)
    elif damage == 'input_image': (run.workspace/'inputs/page-0.png').write_bytes(b'CHANGED')
    elif damage == 'input_bundle':
        bundle = read(run.workspace/'inputs.json'); bundle['metadata']['grade'] = 99
        save(run.workspace/'inputs.json', bundle)
    else:
        identity = read(run.workspace/'identity.json')
        identity['completion_contract'] = 'CHANGED'
        save(run.workspace/'identity.json', identity)
    assert report(run.workspace, f)['status'] == 'partial_or_failed'


def test_new_renderer_can_report_but_changed_runtime_cannot_resume(tmp_path, monkeypatch):
    run = completed(tmp_path)
    from reference import runtime
    monkeypatch.setattr(runtime, 'runtime_identity', lambda: {'unrelated_renderer_change': True})
    assert report(run.workspace, f)['status'] == 'complete'
    with pytest.raises(RuntimeError, match='Frozen runtime changed'):
        Runner(run.workspace, f, resume=True)


def test_uncheckpointed_extra_call_blocks_and_reservation_is_not_hidden(tmp_path):
    run = completed(tmp_path)
    run.ledger['calls'].append({'key': 'interrupted', 'role': 'structure', 'reserved_usd': .25, 'status': 'reserved'})
    save(run.ledger_path, run.ledger)
    summary = report(run.workspace, f)
    assert summary['status'] == 'partial_or_failed'
    assert summary['requests'] == 16
    assert summary['unreconciled_reserved_usd'] == summary['exposure_usd'] == .25
    assert summary['checkpoint_statuses']['interrupted'] == 'interrupted_without_checkpoint'


def test_durable_nonfinal_transport_failure_tolerated_without_hiding_exposure(tmp_path):
    class AmbiguousReview(Attempt4Fixture):
        def invoke(self, request, *, role, notes_pages):
            if role == 'structure':
                raise OSError('SYNTHETIC ambiguous call; no actual transport')
            return super().invoke(request, role=role, notes_pages=notes_pages)
    run = completed(tmp_path, AmbiguousReview())
    call = next(c for c in run.ledger['calls'] if c['role'] == 'structure')
    call['reserved_usd'] = .25  # synthetic unresolved-exposure accounting sentinel
    save(run.ledger_path, run.ledger)
    summary = report(run.workspace, f)
    assert summary['status'] == 'complete'
    assert summary['role_execution_status'] == 'partial_or_failed'
    assert summary['unreconciled_reserved_usd'] == summary['exposure_usd'] == .25


def test_missing_ledger_refuses_report_and_resume(tmp_path):
    run = completed(tmp_path)
    run.ledger_path.unlink()
    with pytest.raises(OSError):
        report(run.workspace, f)
    with pytest.raises(RuntimeError, match='Missing ledger'):
        Runner(run.workspace, f, resume=True)


def test_single_batch_negative_reviews_and_minimal_object_are_not_quality_gated(tmp_path):
    run = completed(tmp_path, PipelineFixture(), labels=[57])
    summary = report(run.workspace, f)
    assert summary['status'] == summary['role_execution_status'] == 'complete'
    assert all(run.output(role)['ok'] is False for role in ('coverage', 'accuracy', 'structure'))
    assert len(summary['checkpoint_statuses']) == 8


def test_pipeline_consumes_selected_candidate2_preserves_edges_and_completed_evidence(tmp_path, monkeypatch):
    monkeypatch.setattr(p.media, 'runtime_identity', lambda: {'synthetic_tools': True})
    monkeypatch.setattr(p, 'PipelineFixture', Attempt4Fixture)
    workspace = tmp_path/'pipeline'
    result = p.start(ROOT/'examples/pipeline/manifest.json', workspace, 'fixture', stop_after='explain')
    summary = result['stages']['guideline']
    assert summary['status'] == 'complete' and summary['role_execution_status'] == 'partial_or_failed'
    assert result['stages']['explain']['status'] == 'complete'
    guideline = read(workspace/'stages/guideline/artifacts/guideline.json')
    assert read(workspace/'stages/explain/inputs.json')['declared']['guideline'] == guideline
    assert 'guideline</a>: complete (operational); role execution: partial_or_failed' in (workspace/'pipeline-report.html').read_text()
    assert 'Only historical G1 has live Llama evidence' not in (workspace/'pipeline-report.html').read_text()
    before = p.file_hashes(workspace/'stages')
    second = p.resume(workspace, stop_after='explain')
    assert result['model_requests'] == second['model_requests']
    assert p.file_hashes(workspace/'stages') == before
    edge = next(e for e in second['lineage']['explain']['edges'] if e.get('slot') == 'guideline')
    assert edge['sha256'] == sha((workspace/edge['source']).read_bytes())
    (workspace/'stages/guideline/requests/selection.json').write_text('{}')
    with pytest.raises(RuntimeError, match='completed stage evidence changed'):
        p.resume(workspace, stop_after='explain')


def test_cli_exposes_distinction_and_keeps_legacy_nonzero_exit(tmp_path, capsys):
    run = completed(tmp_path)
    assert cli.main(['report', '--workspace', str(run.workspace)]) == 0
    assert '"role_execution_status": "partial_or_failed"' in capsys.readouterr().out
    identity = read(run.workspace/'identity.json'); identity.pop('completion_contract')
    save(run.workspace/'identity.json', identity)
    assert cli.main(['report', '--workspace', str(run.workspace)]) == 1


def test_operational_output_availability_does_not_promise_explain_compatibility(tmp_path):
    # Standalone Fixture's valid object artifacts have no native sections.
    run = runner(tmp_path, [57])
    f.graph(run).invoke({'last_role': 'start'})
    assert report(run.workspace, f)['status'] == 'complete'
    bundle = {'metadata': {'grade': 5, 'subject': 'Synthetic'}, 'pages': [],
              'file_identity': {}, 'declared': {'guideline': run.output('revision')['artifact']}}
    with pytest.raises(ValueError):
        explain.validate_inputs(bundle)  # unchanged, before model/client creation
