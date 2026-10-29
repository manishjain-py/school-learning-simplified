"""T23 initial-splitter-only contract placement; synthetic data and inert transport."""
import ast
from copy import deepcopy
import json
from pathlib import Path

import pytest

from test_explain import offline, runner, invoke, payload
from reference.factories import explain
from reference.inputs import ROOT, canonical, read, sha
from reference.providers import Bedrock, Fixture
from reference.runtime import Runner, model_response_json, report

SPLITTER = 'explain_split'
SYSTEM_ROLES = ('explain_research', 'explain_winner_revision', SPLITTER)
BASELINE = ROOT/'tests/fixtures/explain-splitter-system-baseline.json'


def files(paths):
    return {str(p.relative_to(ROOT)): sha(p.read_bytes()) for p in sorted(paths)}


def capture(run):
    requests = {role: read(run.workspace/'requests'/f'{role}.json') for role in explain.ROLES}
    module = ast.parse(Path(explain.__file__).read_text())
    module.body = [n for n in module.body if not (isinstance(n, ast.FunctionDef) and n.name == 'request')]
    return {'base_commit': 'c1ae0a3a92fc4bd8abdfc5810c6314bcefa7f53e',
        'request_sha256': {role: sha(canonical(q)) for role, q in requests.items()},
        'declared_sha256': {role: sha(canonical(payload(q))) for role, q in requests.items()},
        'user_blocks_sha256': {role: sha(canonical(q['messages'])) for role, q in requests.items()},
        'outside_request_ast_sha256': sha(ast.dump(module).encode()),
        'reference_sha256': files((ROOT/'reference').rglob('*.py')),
        'prompt_sha256': files(p for p in (ROOT/'prompts').rglob('*') if p.is_file()),
        'historical_fixtures_sha256': files(p for p in (ROOT/'tests/fixtures').glob('*.json')
                                          if p != BASELINE and p.name not in ('translate-teaching-final-nesting-baseline.json',
                                                                          'translate-teaching-title-scalar-baseline.json',
                                                            'translate-teaching-line-string-baseline.json')),
        'requirements_sha256': sha((ROOT/'requirements.lock').read_bytes())}


@pytest.mark.parametrize('role', explain.ROLES)
def test_only_initial_splitter_adds_exact_system_all_full_requests_and_declarations_preserved(tmp_path, role):
    baseline = read(BASELINE)
    run = runner(tmp_path)
    invoke(run)
    request = read(tmp_path/'requests'/f'{role}.json')
    assert sha(canonical(payload(request))) == baseline['declared_sha256'][role]
    assert sha(canonical(request['messages'])) == baseline['user_blocks_sha256'][role]
    assert len(request['messages']) == 1 and len(request['messages'][0]['content']) == 2
    if role in SYSTEM_ROLES:
        assert request['system'] == [{'text': request['messages'][0]['content'][-1]['text']}]
    else:
        assert set(request) == {'messages'}
    if role == SPLITTER:
        assert set(request) == {'messages', 'system'}
        request.pop('system')
    # Existing research/winner systems stay in the exact Git-base comparison.
    assert sha(canonical(request)) == baseline['request_sha256'][role]


def test_nonrequest_definitions_sources_prompts_lock_and_historical_fixture_bytes_unchanged(tmp_path):
    run = runner(tmp_path)
    invoke(run)
    current, baseline = capture(run), read(BASELINE)
    for key in ('outside_request_ast_sha256', 'prompt_sha256', 'requirements_sha256',
                'historical_fixtures_sha256'):
        assert current[key] == baseline[key]
    changed = 'reference/factories/explain.py'
    assert current['reference_sha256'].keys() == baseline['reference_sha256'].keys()
    assert current['reference_sha256'][changed] != baseline['reference_sha256'][changed]
    # T24/T25/T26 version only Translate request bytes; keep the full other-file comparison.
    expected = {**baseline['reference_sha256'], 'reference/factories/translate.py':
                'ad6138e850f73b13673be3d1d5f75c1bc6faa73df1c0a13eb1da465a4360a3b5'}
    assert {k:v for k,v in current['reference_sha256'].items() if k != changed} == {
        k:v for k,v in expected.items() if k != changed}


def test_system_contains_only_existing_contract_without_declared_or_operator_data(tmp_path, monkeypatch):
    monkeypatch.setenv('PRIVATE_OPERATOR_HISTORY', 'OPERATOR_SENTINEL_MUST_NOT_ENTER')
    run = runner(tmp_path)
    invoke(run)
    declared = explain.declared(run, SPLITTER)
    declared['final_prose'] = 'DECLARED_SENTINEL \\ "नमूना"\r\n'
    original = deepcopy(declared)
    request = explain.request(run, SPLITTER, declared, [], [], True)
    assert declared == original == payload(request)
    assert 'DECLARED_SENTINEL' in request['messages'][0]['content'][0]['text']
    assert request['system'] == [{'text': request['messages'][0]['content'][-1]['text']}]
    for private in ('DECLARED_SENTINEL', 'OPERATOR_SENTINEL_MUST_NOT_ENTER', 'AGENTS.md',
                    'SKILL.md', str(tmp_path), 'AWS_PROFILE', 'manifest.json'):
        assert private not in json.dumps(request['system'])
    for private in ('OPERATOR_SENTINEL_MUST_NOT_ENTER', 'AGENTS.md', 'SKILL.md',
                    str(tmp_path), 'AWS_PROFILE', 'manifest.json'):
        assert private not in json.dumps(request)


def snapshot(workspace):
    return {str(p.relative_to(workspace)): p.read_bytes() for p in workspace.rglob('*') if p.is_file()}


def test_converse_saved_system_hashes_advisory_reviews_final_authors_and_byte_stable_zero_call_resume(tmp_path):
    run = runner(tmp_path)
    calls = []

    class Client:
        def converse(self, **kwargs):
            role = explain.ROLES[len(calls)]
            calls.append(deepcopy(kwargs))
            assert set(kwargs) == {'modelId', 'messages', 'inferenceConfig',
                                   *({'system'} if role in SYSTEM_ROLES else set())}
            assert kwargs['modelId'] == 'synthetic-no-service'
            assert kwargs['inferenceConfig'] == {'maxTokens': 100, 'temperature': .1}
            if role in SYSTEM_ROLES:
                assert kwargs['system'] == [{'text': kwargs['messages'][0]['content'][-1]['text']}]
            return Fixture().invoke({'messages': kwargs['messages']}, role=role, notes_pages=None)

    provider = Bedrock({'model': 'synthetic-no-service', 'max_output_tokens': 100})
    provider.client = Client()
    run.provider = provider
    invoke(run)
    assert len(calls) == len(run.ledger['calls']) == 16 and run.exposure() == 0
    assert not (tmp_path/'ledger.json').exists()
    for call in run.ledger['calls']:
        request = read(tmp_path/'requests'/f'{call["key"]}.json')
        checkpoint = read(tmp_path/'checkpoints'/f'{call["key"]}.json')
        assert call['request_sha256'] == sha(canonical(request))
        assert call['checkpoint_sha256'] == sha(canonical(checkpoint))
        assert call['actual_usd'] == call['reserved_usd'] == 0
        if call['role'] == SPLITTER:
            request.pop('system')
            assert call['request_sha256'] != sha(canonical(request))
    for role, filename in explain.EXPORTS.items():
        artifact = run.output(role)['artifact']
        path = tmp_path/'artifacts'/filename
        assert (path.read_bytes() if path.suffix == '.md' else read(path)) == (
            artifact.encode() if path.suffix == '.md' else artifact)
    final = payload(read(tmp_path/'requests/explain_split_final.json'))
    assert final['split_review']['ok'] is False and final['split_review']['findings']
    assert final['draft_deck'] == run.output(SPLITTER)['artifact']
    assert final['final_prose'] == run.output('explain_prose_final')['artifact']
    checkins = payload(read(tmp_path/'requests/explain_checkins_final.json'))
    assert checkins['checkin_review']['holistic_pass'] is False
    assert report(tmp_path, explain)['status'] == 'complete'
    before = snapshot(tmp_path)
    resumed = Runner(tmp_path, explain, resume=True)
    resumed.provider = provider
    invoke(resumed)
    assert len(calls) == 16 and snapshot(tmp_path) == before


def missing_brace():
    body = json.dumps({'artifact': {'cards': [{'card_idx': 1, 'lines': [
        {'display': 'SYNTHETIC A', 'audio': 'SYNTHETIC A'},
        {'display': 'SYNTHETIC B', 'audio': 'SYNTHETIC B'}]}], 'summary': {}}})
    return '```json\n'+body.replace('"audio": "SYNTHETIC A"},', '"audio": "SYNTHETIC A",')


@pytest.mark.parametrize('text', [missing_brace(), 'Procedure before JSON: {"artifact":{}}',
    '{"cards":[],"summary":{}}', '{"artifact":"wrong native envelope"}',
    '{"artifact":[]}', '{"artifact":{}}}\n```', '```json\n{"artifact":{},}'])
def test_invalid_initial_splitter_is_raw_failed_no_final_deck_rescue_or_retry(tmp_path, monkeypatch, text):
    original = Fixture.invoke
    def invalid(self, request, *, role, notes_pages):
        if role == SPLITTER:
            return {'output': {'message': {'content': [{'text': text}]}}, 'stopReason': 'end_turn'}
        return original(self, request, role=role, notes_pages=notes_pages)
    monkeypatch.setattr(Fixture, 'invoke', invalid)
    run = runner(tmp_path)
    with pytest.raises(ValueError, match='required stage unavailable'):
        invoke(run)
    assert run.result(SPLITTER)['status'] == 'failed'
    assert read(tmp_path/'responses'/f'{SPLITTER}.json')['output']['message']['content'][0]['text'] == text
    assert len(run.ledger['calls']) == 11
    assert (tmp_path/'artifacts/explanation.md').exists()
    assert not (tmp_path/'artifacts/deck.json').exists()
    assert not (tmp_path/'requests/explain_split_review.json').exists()
    assert not (tmp_path/'requests/explain_split_final.json').exists()
    assert not (tmp_path/'artifacts/check-ins.json').exists()
    assert report(tmp_path, explain)['status'] == 'partial_or_failed'
    before = snapshot(tmp_path)
    with pytest.raises(ValueError, match='required stage unavailable'):
        invoke(Runner(tmp_path, explain, resume=True))
    assert snapshot(tmp_path) == before


@pytest.mark.parametrize('frame', ('plain', 'whole', 'eof', 'adjacent'))
def test_existing_framing_and_imperfect_native_artifacts_preserved(frame):
    value = {'artifact': {'cards': 'imperfect', 'unknown': 'PRESERVED'}, 'note': 'advisory'}
    body = json.dumps(value)
    text = {'plain': body, 'whole': '```json\n'+body+'\n```',
            'eof': '```json\n'+body, 'adjacent': '```json\n'+body+'```'}[frame]
    native, _ = model_response_json(text)
    assert explain.parse(SPLITTER, native) == value
