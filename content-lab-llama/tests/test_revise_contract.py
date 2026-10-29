"""Revise final response instructions; synthetic graph and strict boundaries only."""
import ast
import json
from pathlib import Path

import pytest

from test_revise import offline, runner, invoke
from reference.factories import revise
from reference.factories.revise_fixture import payload
from reference.inputs import ROOT, canonical, read, sha
from reference.providers import Bedrock, Fixture
from reference.runtime import Runner, model_response_json, report


def tree_hash(paths):
    return sha(canonical({str(p.relative_to(ROOT)): sha(p.read_bytes()) for p in sorted(paths)}))


def capture(workspace, *, appended):
    run = runner(workspace)
    invoke(run)
    requests = {}
    for role in revise.ROLES:
        request = read(workspace/'requests'/f'{role}.json')
        content = request['messages'][0]['content']
        assert len(request['messages']) == 1
        assert len(content) == (2 if appended else 1)
        request['messages'][0]['content'] = content[:1]
        requests[role] = {'request_sha256': sha(canonical(request)),
                         'first_block_sha256': sha(content[0]['text'].encode()),
                         'declared_sha256': sha(canonical(payload(request)))}
    assert report(workspace, revise)['status'] == 'complete'
    assert [c['role'] for c in run.ledger['calls']] == list(revise.ROLES)
    ledger = read(run.ledger_path)
    saved_requests = {p.name: p.read_bytes() for p in (workspace/'requests').glob('*.json')}
    invoke(Runner(workspace, revise, resume=True))
    assert read(run.ledger_path) == ledger
    assert {p.name: p.read_bytes() for p in (workspace/'requests').glob('*.json')} == saved_requests
    module = ast.parse(Path(revise.__file__).read_text())
    module.body = [node for node in module.body if not (
        isinstance(node, ast.FunctionDef) and node.name == 'request')]
    return {'requests': requests,
            'outputs': {role: sha(canonical(run.output(role))) for role in revise.ROLES},
            'files': {folder: {p.name: sha(p.read_bytes()) for p in sorted((workspace/folder).glob('*.json'))}
                      for folder in ('views', 'artifacts', 'diagnostics')},
            'outside_request_ast_sha256': sha(ast.dump(module).encode()),
            'prompt_tree_sha256': tree_hash(p for p in (ROOT/'prompts').rglob('*') if p.is_file()),
            'other_reference_tree_sha256': tree_hash(p for p in (ROOT/'reference').rglob('*.py')
                                                   if p != Path(revise.__file__)),
            'requirements_sha256': sha((ROOT/'requirements.lock').read_bytes())}


def test_exact_pre_edit_requests_projections_exports_and_sources(tmp_path):
    baseline = read(ROOT/'tests/fixtures/revise-request-baseline.json')
    # T14 changes Translate request(); T15 changes runtime.py. Retain the immutable T13 fixture.
    expected = {**baseline['snapshot'], 'other_reference_tree_sha256':
                'f013945ef45d8112aaa50c954fcda96ff61d57874a13b1bf93c6b8accb246c84'}
    assert capture(tmp_path, appended=True) == expected


def test_native_final_blocks_reach_transport_after_unchanged_data(tmp_path):
    run = runner(tmp_path)
    invoke(run)
    calls = []
    class Client:
        def converse(self, **kwargs):
            calls.append(kwargs)
            return {'synthetic_transport_only': True}
    provider = Bedrock({'model': 'synthetic-no-service', 'max_output_tokens': 100})
    provider.client = Client()
    requests = {}
    for role in revise.ROLES:
        request = read(tmp_path/'requests'/f'{role}.json')
        requests[role] = request
        first, last = request['messages'][0]['content']
        contract = last['text']
        assert 'Declared task data:\n' in first['text']
        assert 'Final response contract:' not in first['text']
        assert contract.startswith('Final response contract:\n')
        for phrase in ('one complete strict JSON object', 'first non-whitespace character must be {',
                       'last must be }', 'preamble', 'postscript', 'procedure narration', 'headings',
                       'Markdown fences', 'extra objects', 'comments', 'trailing commas', 'file receipts',
                       'Markdown inside JSON strings', "role's existing instructions"):
            assert phrase in contract
        if role == 'revise_select':
            assert 'object-valued artifact containing the native concepts array' in contract
            assert all(k in contract for k in ('concept_key', 'section_key', 'section_seq', 'gist', 'source_card_idxs'))
        elif role in revise.AUTHORS or role == 'revise_final':
            assert 'complete object-valued artifact containing the native cards' in contract
            assert all(k in contract for k in ('idx', 'question', 'answer', 'display', 'audio',
                                              'source_card_idxs', 'concept_key', 'section_key', 'section_seq'))
            if role == 'revise_final':
                assert all(k in contract for k in ('cards_changed', 'notes', 'dispositions'))
                assert 'even when accepted_findings is empty' in contract
                assert 'authoritative' in contract and 'no later quality gate' in contract
        elif role == 'revise_selection':
            assert 'unenveloped verdict' in contract
            assert 'winner A/B/tie, margin clear/slight and reasons' in contract
            assert 'Tie selects A' in contract and 'No replacement deck' in contract
            assert 'Do not wrap the verdict in artifact' in contract
        else:
            assert 'unenveloped JSON root with findings array' in contract
            assert 'Do not wrap the review in artifact' in contract
            assert 'YOUR ONLY LENS: '+role[7:] in contract
            assert 'Empty findings and negative advisory feedback remain valid' in contract
            assert all(k in contract for k in ('card_idx', 'lens', 'severity', 'issue', 'evidence', 'suggested_fix'))
        provider.invoke(request, role=role, notes_pages=None)
        assert calls[-1]['messages'] is request['messages']
    assert len(calls) == 8
    assert requests['revise_author_a'] == requests['revise_author_b']


def native_result(role):
    if role == 'revise_selection':
        return {'winner': 'tie', 'margin': 'slight', 'reasons': []}
    if role[7:] in revise.LENSES:
        return {'findings': [], 'ok': False, 'note': 'negative advisory opinion'}
    return {'artifact': {'concepts': []} if role == 'revise_select' else
            {'cards': []} if role in revise.AUTHORS else {'unknown_native': 'imperfect and preserved'}}


@pytest.mark.parametrize('role', revise.ROLES)
def test_existing_framing_native_fields_and_negative_feedback_remain_valid(role):
    value = {**native_result(role), 'extra_audit': '## SYNTHETIC\nHe says "hello".\nC:\\example'}
    raw = json.dumps(value)
    for response in (raw, '```json\n'+raw+'\n```', '```\n'+raw+'\n```', '```json\n'+raw):
        text, _ = model_response_json(response)
        assert revise.parse(role, text) == value


@pytest.mark.parametrize('role', tuple(r for r in revise.ROLES if r not in revise.AUTHORS))
@pytest.mark.parametrize('kind', ['narrated', 'malformed', 'wrong_envelope'])
def test_required_invalid_response_stays_raw_failed_and_unrepeated(tmp_path, monkeypatch, role, kind):
    original = Fixture.invoke
    invalid_text = []
    failing_role = role
    def invalid(self, request, *, role, notes_pages):
        response = original(self, request, role=role, notes_pages=notes_pages)
        if role != failing_role:
            return response
        raw = response['output']['message']['content'][0]['text']
        value = json.loads(raw)
        if kind == 'narrated':
            text = 'To solve this task...\n```json\n'+raw+'\n```'
        elif kind == 'malformed':
            text = raw[:-1]+',}'
        else:
            text = json.dumps(value['artifact'] if 'artifact' in value else {'artifact': value})
        invalid_text.append(text)
        response['output']['message']['content'][0]['text'] = text
        return response
    monkeypatch.setattr(Fixture, 'invoke', invalid)
    run = runner(tmp_path)
    with pytest.raises(ValueError, match='required stage unavailable'):
        invoke(run)
    assert run.result(role)['status'] == 'failed'
    assert read(tmp_path/'responses'/f'{role}.json')['output']['message']['content'][0]['text'] == invalid_text[0]
    assert not (tmp_path/'artifacts/revise_deck.json').exists()
    assert report(tmp_path, revise)['status'] == 'partial_or_failed'
    before = read(run.ledger_path)
    # Existing independent lenses all run; feedback() requires them before final.
    expected = revise.ROLES[:-1] if role[7:] in revise.LENSES else revise.ROLES[:revise.ROLES.index(role)+1]
    assert [c['role'] for c in before['calls']] == list(expected)
    with pytest.raises(ValueError, match='required stage unavailable'):
        invoke(Runner(tmp_path, revise, resume=True))
    assert read(run.ledger_path) == before and len(invalid_text) == 1
