"""T22 final-refresher placement only; synthetic exact-base and failure evidence."""
import ast
from copy import deepcopy
import json
from pathlib import Path

import pytest

from test_guideline_batches import runner, task_data
from test_guideline_inspection_system import LABELS, CASES, case_inputs, evidence, inspection_text
from test_guideline_completion import offline
from reference.factories import guideline as factory
from reference.inputs import ROOT, canonical, read, sha
from reference.providers import Bedrock, Fixture
from reference.runtime import Runner, report

FIXTURE = 'guideline-refresher-system-baseline.json'
GUIDELINE = 'reference/factories/guideline.py'


def source_snapshot():
    module = ast.parse(Path(factory.__file__).read_text())
    module.body = [n for n in module.body if not (isinstance(n, ast.FunctionDef) and n.name == 'request')]
    files = lambda paths: {str(p.relative_to(ROOT)): sha(p.read_bytes()) for p in sorted(paths)}
    return {'outside_request_ast_sha256': sha(ast.dump(module).encode()),
            'reference_sha256': files((ROOT/'reference').rglob('*.py')),
            'prompt_sha256': files(p for p in (ROOT/'prompts').rglob('*') if p.is_file()),
            'historical_fixtures_sha256': files(p for p in (ROOT/'tests/fixtures').glob('*.json')
                                              if p.name not in (FIXTURE, 'explain-splitter-system-baseline.json',
                                                                'translate-teaching-final-nesting-baseline.json',
                                                                'translate-teaching-title-scalar-baseline.json',
                                                            'translate-teaching-line-string-baseline.json')),
            'requirements_sha256': sha((ROOT/'requirements.lock').read_bytes())}


def capture(workspace):
    """Run on the exact Git base BEFORE the runtime edit; no fixture regeneration in tests."""
    run = runner(workspace, LABELS)
    rows = {}
    for role in factory.ROLES:
        rows[role] = {}
        for case in CASES:
            declared, batch, notes, final = case_inputs(run, role, case)
            req = factory.request(run, role, declared, batch, notes, final)
            rows[role][case] = {'request_sha256': sha(canonical(evidence(req))),
                'declared_sha256': sha(canonical(declared)),
                'notes_sha256': sha(canonical(notes)),
                'user_blocks_sha256': sha(canonical(evidence(req['messages'])))}
    return {'requests': rows, **source_snapshot()}


def baseline():
    return read(ROOT/'tests/fixtures'/FIXTURE)


@pytest.mark.parametrize('role', factory.ROLES)
@pytest.mark.parametrize('case', CASES)
def test_exact_base_requests_declarations_images_and_notes(tmp_path, monkeypatch, role, case):
    monkeypatch.setenv('PRIVATE_OPERATOR_HISTORY', 'OPERATOR_SENTINEL')
    run = runner(tmp_path, LABELS)
    declared, batch, notes, final = case_inputs(run, role, case)
    before = deepcopy((declared, batch, notes, run.bundle, run.blobs))
    req = factory.request(run, role, declared, batch, notes, final)
    assert (declared, batch, notes, run.bundle, run.blobs) == before
    expected = baseline()['requests'][role][case]
    assert sha(canonical(declared)) == expected['declared_sha256']
    assert sha(canonical(notes)) == expected['notes_sha256']
    assert sha(canonical(evidence(req['messages']))) == expected['user_blocks_sha256']
    content = req['messages'][0]['content']
    assert task_data(req)['task_inputs'] == declared
    assert task_data(req)['role_local_page_notes'] == notes
    originals = content[1:-1] if final else content[1:]
    assert originals == [item for p in batch for item in (
        {'text': f'Original printed page {p["printed_page"]}:'},
        {'image': {'format': p['format'], 'source': {'bytes': run.blobs[p['file']]}}})]
    if final and role == 'refresher':
        assert set(req) == {'messages', 'system'}
        system = req.pop('system')
        assert system == [{'text': content[-1]['text']}]
        for prohibited in ('DECLARED_TASK_SENTINEL', 'OWN-NOTES', 'OPERATOR_SENTINEL', 'AGENTS.md', 'SKILL.md', str(ROOT), str(tmp_path)):
            assert prohibited not in json.dumps(system)
    elif final:
        assert set(req) == {'messages'}
    else:
        assert req['system'] == [{'text': inspection_text([p['printed_page'] for p in batch])}]
    assert sha(canonical(evidence(req))) == expected['request_sha256']


def test_only_request_delta_preserves_sources_and_reconstructs_prior_trees():
    old = baseline()
    current = source_snapshot()
    for key in ('outside_request_ast_sha256', 'prompt_sha256', 'historical_fixtures_sha256', 'requirements_sha256'):
        assert current[key] == old[key]
    assert current['reference_sha256'][GUIDELINE] != old['reference_sha256'][GUIDELINE]
    # T23 versions only Explain request bytes; the historical T22 fixture stays exact.
    assert current['reference_sha256']['reference/factories/explain.py'] == (
        'ce0a5fdc0d4fe2076d8275c8475a3533cba2ae324782486d3bec4807ebee97c6')
    # T24/T25/T26 change only Translate request(); restore that exact base hash for prior trees.
    assert current['reference_sha256']['reference/factories/translate.py'] == (
        'ad6138e850f73b13673be3d1d5f75c1bc6faa73df1c0a13eb1da465a4360a3b5')
    restored = {**current['reference_sha256'], GUIDELINE: old['reference_sha256'][GUIDELINE],
                'reference/factories/explain.py': old['reference_sha256']['reference/factories/explain.py'],
                'reference/factories/translate.py': old['reference_sha256']['reference/factories/translate.py']}
    assert restored == old['reference_sha256']
    prior = {'practice': 'e4541da543ffd27e8c3636267b89370189603cbbfbc7498ee8ad91d706663976',
             'revise': 'dc92655aeacc5e6f5d38cabf4ab2368a154ec6da53b6db7ef483fa9f5875b87c',
             'translate': '7efd51e58498311a5242194295eb4ae3733a76b5d142aadbba3e41ff3b0faa2b'}
    for excluded, expected in prior.items():
        assert sha(canonical({k:v for k,v in restored.items() if k != f'reference/factories/{excluded}.py'})) == expected


def test_actual_optional_transport_saved_hashes_exports_and_zero_request_resume(tmp_path):
    run = runner(tmp_path, LABELS)
    calls = []
    class Client:
        def converse(self, **kwargs):
            role, turn = factory.ROLES[len(calls)//3], len(calls) % 3
            calls.append(deepcopy(kwargs))
            labels = LABELS[turn*3:turn*3+3] if turn < 2 else None
            expected = ([{'text': inspection_text(labels)}] if labels is not None else
                        [{'text': kwargs['messages'][0]['content'][-1]['text']}] if role == 'refresher' else None)
            req = {'messages': kwargs['messages']}
            assert set(kwargs) == {'modelId', 'messages', 'inferenceConfig', *({'system'} if expected is not None else set())}
            assert kwargs['inferenceConfig'] == {'maxTokens': 100, 'temperature': .1}
            assert kwargs['modelId'] == 'synthetic-no-service'
            if expected is not None:
                assert kwargs['system'] == expected
                req['system'] = kwargs['system']
            return Fixture().invoke(req, role=role, notes_pages=labels)
    provider = Bedrock({'model': 'synthetic-no-service', 'max_output_tokens': 100})
    provider.client = Client()
    run.provider = provider
    factory.graph(run).invoke({'last_role': 'start'})
    assert len(calls) == len(run.ledger['calls']) == 24
    assert report(run.workspace, factory)['status'] == 'complete'
    for role in ('coverage', 'accuracy', 'structure'):
        assert run.output(role)['ok'] is False
        assert task_data(read(run.workspace/'requests/revision.json'))['task_inputs']['reviews'][role] == run.output(role)
    for role, filename in factory.FINAL_EXPORTS.items():
        assert read(run.workspace/'artifacts'/filename) == run.output(role)['artifact']
    for call in run.ledger['calls']:
        req = read(run.workspace/'requests'/f'{call["key"]}.json')
        assert call['request_sha256'] == sha(canonical(req))
        assert call['checkpoint_sha256'] == sha(canonical(read(run.workspace/'checkpoints'/f'{call["key"]}.json')))
        assert call['reserved_usd'] == call['actual_usd'] == 0
        if call['key'] == 'refresher':
            assert req['system'] == [{'text': req['messages'][0]['content'][-1]['text']}]
            legacy = deepcopy(req); legacy.pop('system')
            assert sha(canonical(legacy)) != call['request_sha256']
    before = {str(p.relative_to(run.workspace)): p.read_bytes() for p in run.workspace.rglob('*') if p.is_file()}
    resumed = Runner(run.workspace, factory, resume=True)
    resumed.provider = provider
    factory.graph(resumed).invoke({'last_role': 'start'})
    assert len(calls) == 24
    assert {str(p.relative_to(run.workspace)): p.read_bytes() for p in run.workspace.rglob('*') if p.is_file()} == before


@pytest.mark.parametrize('body', [
    '{"artifact":{"prerequisites":[{"why_needed":"SYNTHETIC"": "bad"}]}}',
    '{"artifact":{"prerequisites":[{"why_needed":"SYNTHETIC"},]}}',
    'First I will explain SYNTHETIC prerequisites.',
    '{"artifact":[]}',
])
def test_malformed_required_refresher_fails_without_repair_export_or_retry(tmp_path, monkeypatch, body):
    original = Fixture.invoke
    raw = {'output': {'message': {'content': [{'text': body}]}}, 'stopReason': 'end_turn'}
    calls = []
    def response(self, request, *, role, notes_pages):
        calls.append(role)
        if role == 'refresher' and notes_pages is None:
            return raw
        return original(self, request, role=role, notes_pages=notes_pages)
    monkeypatch.setattr(Fixture, 'invoke', response)
    run = runner(tmp_path, LABELS[:5])
    factory.graph(run).invoke({'last_role': 'start'})
    summary = report(run.workspace, factory)
    assert len(calls) == len(run.ledger['calls']) == 16
    assert run.result('refresher')['status'] == 'failed'
    assert run.result('refresher__batch_1')['status'] == 'ok'
    assert read(run.workspace/'responses/refresher.json') == raw
    assert (run.workspace/'artifacts/guideline.json').exists()
    assert not (run.workspace/'artifacts/refresher-guideline.json').exists()
    assert summary['status'] == 'partial_or_failed'
    assert {'required_author_dependency:refresher', 'final_export_required:refresher'} <= set(summary['completion_blockers'])
    before = {str(p.relative_to(run.workspace)): p.read_bytes() for p in run.workspace.rglob('*') if p.is_file()}
    monkeypatch.setattr(Fixture, 'invoke', lambda *a, **k: pytest.fail('Failed request repeated'))
    factory.graph(Runner(run.workspace, factory, resume=True)).invoke({'last_role': 'start'})
    assert {str(p.relative_to(run.workspace)): p.read_bytes() for p in run.workspace.rglob('*') if p.is_file()} == before
