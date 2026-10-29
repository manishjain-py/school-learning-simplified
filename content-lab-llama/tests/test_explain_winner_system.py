"""T19 exact winner-revision contract placement; no live provider or private inputs."""
import ast
import json
from pathlib import Path

import pytest

from test_explain import offline, runner, invoke, payload
from reference.factories import explain
from reference.inputs import ROOT, canonical, read, sha
from reference.providers import Bedrock, Fixture
from reference.runtime import Runner, report

WINNER = 'explain_winner_revision'


def test_only_winner_system_added_research_and_other_fifteen_requests_exact(tmp_path):
    baseline = read(ROOT/'tests/fixtures/explain-winner-system-request-baseline.json')
    run = runner(tmp_path)
    invoke(run)
    assert set(baseline['request_sha256']) == set(explain.ROLES)
    for role in explain.ROLES:
        request = read(tmp_path/'requests'/f'{role}.json')
        assert sha(canonical(payload(request))) == baseline['declared_sha256'][role]
        content = request['messages'][0]['content']
        assert sha(content[-1]['text'].encode()) == baseline['final_block_sha256'][role]
        if role == WINNER:
            assert set(request) == {'messages', 'system'}
            assert request.pop('system') == [{'text': content[-1]['text']}]
        elif role == 'explain_research':
            assert request['system'] == [{'text': content[-1]['text']}]
        else:
            assert set(request) == {'messages'}
        # Remove ONLY T19's new field, leaving research's T16 field untouched.
        assert sha(canonical(request)) == baseline['request_sha256'][role]
    definitions = {node.name: sha(ast.dump(node).encode())
                   for node in ast.parse(Path(explain.__file__).read_text()).body
                   if isinstance(node, ast.FunctionDef) and node.name != 'request'}
    assert definitions == baseline['unchanged_definitions_sha256']


def test_winner_system_is_only_existing_contract_and_never_task_or_operator_data(tmp_path, monkeypatch):
    monkeypatch.setenv('PRIVATE_OPERATOR_HISTORY', 'OPERATOR_SENTINEL_MUST_NOT_ENTER')
    run = runner(tmp_path)
    invoke(run)
    declared = explain.declared(run, WINNER)
    declared['your_draft'] = 'DECLARED_DRAFT_SENTINEL'
    request = explain.request(run, WINNER, declared, [], [], True)
    assert payload(request) == declared
    system = request['system']
    assert system == [{'text': request['messages'][0]['content'][-1]['text']}]
    assert 'DECLARED_DRAFT_SENTINEL' in request['messages'][0]['content'][0]['text']
    assert 'DECLARED_DRAFT_SENTINEL' not in json.dumps(system)
    for private in ('OPERATOR_SENTINEL_MUST_NOT_ENTER', 'AGENTS.md', 'SKILL.md',
                    str(tmp_path), 'AWS_PROFILE', 'manifest.json'):
        assert private not in json.dumps(request)


def test_real_graph_converse_saved_system_hashes_final_authors_and_zero_repeat_resume(tmp_path):
    snapshots = []
    for name in ('first', 'second'):
        workspace = tmp_path/name
        run = runner(workspace)
        calls = []

        class Client:
            def converse(self, **kwargs):
                role = explain.ROLES[len(calls)]
                calls.append(kwargs)
                if role in ('explain_research', WINNER):
                    assert kwargs['system'] == [{'text': kwargs['messages'][0]['content'][-1]['text']}]
                else:
                    assert 'system' not in kwargs
                return Fixture().invoke({'messages': kwargs['messages']}, role=role, notes_pages=None)

        provider = Bedrock({'model': 'synthetic-no-service', 'max_output_tokens': 100})
        provider.client = Client()
        run.provider = provider
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
            if call['role'] == WINNER:
                without_system = {k: v for k, v in request.items() if k != 'system'}
                assert call['request_sha256'] != sha(canonical(without_system))
        for role, filename in explain.EXPORTS.items():
            artifact = run.output(role)['artifact']
            path = workspace/'artifacts'/filename
            assert (path.read_bytes() if path.suffix == '.md' else read(path)) == (
                artifact.encode() if path.suffix == '.md' else artifact)
        assert payload(read(workspace/'requests/explain_split_final.json'))['split_review']['ok'] is False
        assert payload(read(workspace/'requests/explain_checkins_final.json'))['checkin_review']['holistic_pass'] is False
        assert report(workspace, explain)['status'] == 'complete'
        saved = {str(p.relative_to(workspace)): sha(p.read_bytes())
                 for folder in ('requests', 'checkpoints', 'artifacts')
                 for p in (workspace/folder).iterdir() if p.is_file()}
        resumed = Runner(workspace, explain, resume=True)
        resumed.provider = provider
        invoke(resumed)
        assert len(calls) == 16 and read(run.ledger_path) == ledger
        assert saved == {str(p.relative_to(workspace)): sha(p.read_bytes())
                         for folder in ('requests', 'checkpoints', 'artifacts')
                         for p in (workspace/folder).iterdir() if p.is_file()}
        snapshots.append(saved)
    assert snapshots[0] == snapshots[1]


def test_malformed_extra_brace_and_fence_stays_failed_raw_and_unrepeated(tmp_path, monkeypatch):
    text = json.dumps({'artifact': 'SYNTHETIC unchanged prose', 'dispositions': []})+'}\n```'
    original = Fixture.invoke

    def invalid(self, request, *, role, notes_pages):
        if role == WINNER:
            return {'output': {'message': {'content': [{'text': text}]}}, 'stopReason': 'end_turn'}
        return original(self, request, role=role, notes_pages=notes_pages)

    monkeypatch.setattr(Fixture, 'invoke', invalid)
    run = runner(tmp_path)
    with pytest.raises(ValueError, match='required stage unavailable'):
        invoke(run)
    assert run.result(WINNER)['status'] == 'failed'
    assert read(tmp_path/'responses'/f'{WINNER}.json')['output']['message']['content'][0]['text'] == text
    assert not (tmp_path/'artifacts/explanation.md').exists()
    ledger = read(run.ledger_path)
    assert len(ledger['calls']) == 6
    with pytest.raises(ValueError, match='required stage unavailable'):
        invoke(Runner(tmp_path, explain, resume=True))
    assert read(run.ledger_path) == ledger
