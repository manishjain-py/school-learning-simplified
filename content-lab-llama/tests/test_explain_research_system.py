"""T16 request delivery only; synthetic graphs and in-memory Converse, no SDK client."""
from copy import deepcopy
import json

import pytest

from test_explain import offline, runner, invoke, payload
from reference.factories import explain
from reference.inputs import ROOT, canonical, read, sha
from reference.providers import Bedrock, Fixture
from reference.runtime import Runner


def test_only_research_system_added_to_exact_base_requests_and_projections(tmp_path):
    baseline = read(ROOT/'tests/fixtures/explain-system-request-baseline.json')
    run = runner(tmp_path)
    invoke(run)
    assert set(baseline['request_sha256']) == set(explain.ROLES)
    for role in explain.ROLES:
        request = read(tmp_path/'requests'/f'{role}.json')
        assert sha(canonical(payload(request))) == baseline['declared_sha256'][role]
        if role == 'explain_research':
            assert set(request) == {'messages', 'system'}
            assert request.pop('system') == [{'text': request['messages'][0]['content'][-1]['text']}]
        else:
            assert set(request) == {'messages'}
        # Remove ONLY the added field; both existing user blocks stay intact.
        assert sha(canonical(request)) == baseline['request_sha256'][role]


@pytest.mark.parametrize('mode', ['absent', 'empty', 'null', 'text'])
def test_optional_system_forwarded_by_key_presence_without_other_fields(mode):
    request = {'messages': [{'role': 'user', 'content': [{'text': 'SYNTHETIC'}]}],
               'modelId': 'MUST_NOT_FORWARD', 'inferenceConfig': {'temperature': 99},
               'toolConfig': {'private': 'MUST_NOT_FORWARD'}, 'arbitrary': 'MUST_NOT_FORWARD'}
    if mode != 'absent':
        request['system'] = {'empty': [], 'null': None, 'text': [{'text': 'EXACT SYNTHETIC CONTRACT'}]}[mode]
    before = deepcopy(request)
    response, calls = {'synthetic_transport_only': True}, []

    class Client:
        def converse(self, **kwargs):
            calls.append(kwargs)
            return response

    provider = Bedrock({'model': 'synthetic-no-service', 'max_output_tokens': 123})
    provider.client = Client()
    assert provider.invoke(request, role='explain_research', notes_pages=None) is response
    expected = {'modelId': 'synthetic-no-service', 'messages': request['messages'],
                'inferenceConfig': {'maxTokens': 123, 'temperature': .1}}
    if mode != 'absent':
        expected['system'] = request['system']
        assert calls[0]['system'] is request['system']
    assert calls == [expected]
    assert calls[0]['messages'] is request['messages']
    assert request == before


def test_system_contains_only_existing_contract_never_task_or_operator_data(tmp_path, monkeypatch):
    monkeypatch.setenv('PRIVATE_OPERATOR_HISTORY', 'OPERATOR_SENTINEL_MUST_NOT_ENTER')
    run = runner(tmp_path)
    run.bundle['declared']['research']['context'] = 'DECLARED_TASK_SENTINEL'
    declared = explain.declared(run, 'explain_research')
    request = explain.request(run, 'explain_research', declared, [], [], True)
    assert payload(request) == declared
    system = request['system']
    assert system == [{'text': request['messages'][0]['content'][-1]['text']}]
    assert 'DECLARED_TASK_SENTINEL' in request['messages'][0]['content'][0]['text']
    assert 'DECLARED_TASK_SENTINEL' not in json.dumps(system)
    for private in ('OPERATOR_SENTINEL_MUST_NOT_ENTER', 'AGENTS.md', 'SKILL.md',
                    str(tmp_path), 'AWS_PROFILE', 'manifest.json'):
        assert private not in json.dumps(request)


def test_actual_transport_graph_saved_hashes_deterministic_and_completed_resume_zero_repeat(tmp_path):
    snapshots = []
    for name in ('first', 'second'):
        workspace = tmp_path/name
        run = runner(workspace)
        calls = []

        class Client:
            def converse(self, **kwargs):
                role = explain.ROLES[len(calls)]
                calls.append(kwargs)
                if role == 'explain_research':
                    assert kwargs['system'] == [{'text': kwargs['messages'][0]['content'][-1]['text']}]
                else:
                    assert 'system' not in kwargs
                return Fixture().invoke({'messages': kwargs['messages']}, role=role, notes_pages=None)

        provider = Bedrock({'model': 'synthetic-no-service', 'max_output_tokens': 100})
        provider.client = Client()
        run.provider = provider  # fixture accounting, actual transport method, in-memory client only
        invoke(run)
        assert len(calls) == 16 and run.exposure() == 0
        assert not (workspace/'ledger.json').exists()
        ledger = read(run.ledger_path)
        for call in ledger['calls']:
            request = read(workspace/'requests'/f'{call["key"]}.json')
            checkpoint = read(workspace/'checkpoints'/f'{call["key"]}.json')
            assert call['request_sha256'] == sha(canonical(request))
            assert call['checkpoint_sha256'] == sha(canonical(checkpoint))
            assert call['actual_usd'] == call['reserved_usd'] == 0
        saved = {str(p.relative_to(workspace)): sha(p.read_bytes())
                 for folder in ('requests', 'checkpoints') for p in (workspace/folder).glob('*.json')}
        resumed = Runner(workspace, explain, resume=True)
        resumed.provider = provider
        invoke(resumed)
        assert len(calls) == 16 and read(run.ledger_path) == ledger
        assert saved == {str(p.relative_to(workspace)): sha(p.read_bytes())
                         for folder in ('requests', 'checkpoints') for p in (workspace/folder).glob('*.json')}
        snapshots.append(saved)
    assert snapshots[0] == snapshots[1]
