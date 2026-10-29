"""Explain final-block placement; native result types and unchanged failure behavior."""
import ast
import json
from pathlib import Path

import pytest

from test_explain import offline, runner, invoke, payload
from reference.factories import explain
from reference.inputs import ROOT, canonical, read, sha
from reference.providers import Bedrock, Fixture
from reference.runtime import Runner, model_response_json, report

ROLES = tuple(role for role in explain.ROLES if role != 'explain_research')


def test_exact_pre_edit_t08_requests_and_all_projections(tmp_path):
    # Independently captured from git archive of this exact version BEFORE editing.
    # The older pre-T08 fixture is retained byte-for-byte in its own regression.
    baseline = read(ROOT/'tests/fixtures/explain-t08-request-baseline.json')
    run = runner(tmp_path)
    invoke(run)
    assert set(baseline['request_sha256']) == set(explain.ROLES)
    for role in explain.ROLES:
        request = read(tmp_path/'requests'/f'{role}.json')
        assert sha(canonical(payload(request))) == baseline['declared_sha256'][role]
        content = request['messages'][0]['content']
        assert len(content) == 2
        if role == 'explain_research':
            assert sha(content[1]['text'].encode()) == baseline['research_final_block_sha256']
        else:
            request['messages'][0]['content'] = content[:1]
        assert sha(canonical(request)) == baseline['request_sha256'][role]
    definitions = {node.name: sha(ast.dump(node).encode())
                   for node in ast.parse(Path(explain.__file__).read_text()).body
                   if isinstance(node, ast.FunctionDef) and node.name != 'request'}
    assert definitions == baseline['unchanged_definitions_sha256']


def native_result(role):
    if role in explain.TEXT_ROLES:
        return {'artifact': '  ## SYNTHETIC\nHe says "hello".\nC:\\example  \n'}
    if role in explain.ARTIFACT_ROLES:
        return {'artifact': {'unknown_native_field': 'imperfect and preserved'}}
    if role == 'explain_selection':
        return {'winner_index': 2, 'scores': {}, 'reasons': [], 'concerns': []}
    if role == 'explain_checkin_review':
        return {'wrong': [], 'holistic_pass': False, 'holistic_issues': [], 'comment': 'negative opinion'}
    return {'findings': [], **({'ok': False, 'note': 'negative opinion'}
                              if role == 'explain_split_review' else {})}


def test_final_blocks_classify_native_shapes_and_reach_transport(tmp_path):
    run = runner(tmp_path)
    invoke(run)
    calls = []
    class Client:
        def converse(self, **kwargs):
            calls.append(kwargs)
            return {'synthetic_transport_only': True}
    provider = Bedrock({'model': 'synthetic-no-service', 'max_output_tokens': 100})
    provider.client = Client()
    for role in ROLES:
        request = read(tmp_path/'requests'/f'{role}.json')
        first, last = request['messages'][0]['content']
        contract = last['text']
        assert contract.startswith('Final response contract for '+role+':\n')
        assert 'Final response contract for' not in first['text']
        assert 'first non-whitespace character must be {' in contract and 'last must be }' in contract
        assert 'procedure narration outside JSON' in contract
        assert 'Markdown fences, surrounding prose, multiple objects' in contract
        assert 'fields allowed by this role\'s existing instructions' in contract
        if role in explain.TEXT_ROLES:
            assert 'artifact as a JSON STRING, never an object or array' in contract
            assert 'Markdown headings inside that string remain valid' in contract
            example = contract.split('Syntax-only escaping illustration:\n')[1].split('\n')[0]
            assert explain.parse(role, example) == {'artifact': '## Heading\nHe says "hello".\nC:\\example'}
            assert 'not replacement prose' in contract
        elif role in explain.ARTIFACT_ROLES:
            assert 'object-valued artifact field' in contract
            expected = ('book_treatment_present boolean' if role == 'explain_arc' else
                        'cards and summary' if 'split' in role else 'check_ins array')
            assert expected in contract
        elif role == 'explain_selection':
            assert 'integer winner_index (1 or 2)' in contract
            assert 'per-candidate scores, reasons and concerns' in contract
            assert 'Do not wrap the verdict in artifact' in contract
        elif role == 'explain_checkin_review':
            assert 'wrong array, boolean holistic_pass, holistic_issues array and comment' in contract
            assert 'Do not wrap the review in artifact' in contract
        else:
            assert 'JSON root with' in contract and 'findings array' in contract
            assert ('not an artifact envelope' in contract or 'Do not wrap the review in artifact' in contract)
        provider.invoke(request, role=role, notes_pages=None)
        assert calls[-1]['messages'] is request['messages']
    assert len(calls) == 15


@pytest.mark.parametrize('role', ROLES)
def test_existing_framing_native_unknown_fields_and_negative_reviews_remain_valid(role):
    value = {**native_result(role), 'extra_audit': ['unresolved SYNTHETIC observation']}
    text, framing = model_response_json('```json\n'+json.dumps(value)+'\n```')
    assert framing == 'markdown_json_fence'
    assert explain.parse(role, text) == value


@pytest.mark.parametrize('role', ROLES)
@pytest.mark.parametrize('kind', ['narrated', 'malformed', 'wrong_envelope'])
def test_invalid_role_stays_failed_raw_and_unrepeated(tmp_path, monkeypatch, role, kind):
    value = native_result(role)
    if kind == 'narrated':
        text = '## Procedure\nNarrating the work.\n'+json.dumps(value)
    elif kind == 'malformed':
        text = json.dumps(value)[:-1]+',}'
    elif role in explain.TEXT_ROLES:
        text = json.dumps({'artifact': {'prose': value['artifact']}})
    elif role in explain.ARTIFACT_ROLES:
        text = json.dumps({'artifact': json.dumps(value['artifact'])})
    else:
        text = json.dumps({'artifact': value})
    original = Fixture.invoke
    def invalid(self, request, *, role: str, notes_pages):
        if role == failing_role:
            return {'output': {'message': {'content': [{'text': text}]}}, 'stopReason': 'end_turn'}
        return original(self, request, role=role, notes_pages=notes_pages)
    failing_role = role
    monkeypatch.setattr(Fixture, 'invoke', invalid)
    run = runner(tmp_path)
    with pytest.raises(ValueError, match='required stage unavailable'):
        invoke(run)
    assert run.result(role)['status'] == 'failed'
    assert read(tmp_path/'responses'/f'{role}.json')['output']['message']['content'][0]['text'] == text
    assert report(tmp_path, explain)['status'] == 'partial_or_failed'
    before = read(tmp_path/'synthetic-ledger.json')
    assert len(before['calls']) == explain.ROLES.index(role)+1
    for author, filename in explain.EXPORTS.items():
        if explain.ROLES.index(author) >= explain.ROLES.index(role):
            assert not (tmp_path/'artifacts'/filename).exists()
    with pytest.raises(ValueError, match='required stage unavailable'):
        invoke(Runner(tmp_path, explain, resume=True))
    assert read(tmp_path/'synthetic-ledger.json') == before
