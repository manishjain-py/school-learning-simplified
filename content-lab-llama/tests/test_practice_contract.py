"""Practice response placement and exact pre-edit graph behavior; no live inference."""
import ast
from copy import deepcopy
import json
from pathlib import Path

import pytest

from test_practice import EXAMPLE, offline, runner, invoke
from reference.factories import practice
from reference.factories.practice_fixture import payload
from reference.inputs import ROOT, canonical, load_manifest, read, sha
from reference.providers import Bedrock, Fixture
from reference.runtime import Runner, model_response_json, report

ROLES = ('practice_blueprint', 'practice_slot_1', 'practice_slot_5',
         'practice_review', 'practice_final')


def seed_bundle():
    bundle, _ = load_manifest(EXAMPLE.parent/'seed-manifest.json', practice)
    bundle['metadata'].update(add=30, run_cap=30)
    return bundle


def tree_hash(paths):
    return sha(canonical({str(p.relative_to(ROOT)): sha(p.read_bytes()) for p in sorted(paths)}))


def capture(workspace, *, appended):
    """Same real graph and synthetic inputs used to capture the pre-edit fixture."""
    seed = runner(workspace/'seed', seed_bundle())
    invoke(seed)
    growth = runner(workspace/'growth')
    invoke(growth)
    bundle, _ = load_manifest(EXAMPLE, practice)
    cache = read(growth.workspace/'artifacts/blueprint-cache.json')
    bundle['declared']['blueprint'] = cache
    bundle['file_identity']['blueprint'] = {'type': 'json', 'sha256': sha(canonical(cache))}
    cached = runner(workspace/'cached_growth', bundle)
    invoke(cached)
    reached = runner(workspace/'reached_target', manifest=EXAMPLE.parent/'noop-manifest.json')
    invoke(reached)
    zero_bundle = deepcopy(bundle)
    zero_bundle['metadata']['add'] = 0
    zero = runner(workspace/'add_zero', zero_bundle)
    invoke(zero)
    traces = {}
    for run in (seed, growth, cached, reached, zero):
        roles = [call['role'] for call in run.ledger['calls']]
        requests = {}
        for role in roles:
            request = read(run.workspace/'requests'/f'{role}.json')
            content = request['messages'][0]['content']
            assert len(request['messages']) == 1
            assert len(content) == (2 if appended else 1)
            if appended:
                assert content[1]['text'].startswith('Final response contract for '+role+':\n')
            request['messages'][0]['content'] = content[:1]
            requests[role] = {'request_sha256': sha(canonical(request)),
                             'first_block_sha256': sha(content[0]['text'].encode()),
                             'declared_sha256': sha(canonical(payload(request)))}
        traces[run.workspace.name] = {
            'roles': roles, 'requests': requests,
            'artifacts': {p.name: sha(p.read_bytes()) for p in sorted((run.workspace/'artifacts').glob('*.json'))},
            'diagnostics': {p.name: sha(p.read_bytes()) for p in sorted((run.workspace/'diagnostics').glob('*.json'))},
            'metrics': read(run.workspace/'metrics/practice-run.json'),
        }
        assert report(run.workspace, practice)['status'] == 'complete'
        ledger = read(run.ledger_path)
        invoke(Runner(run.workspace, practice, resume=True))
        assert read(run.ledger_path) == ledger
    assert len(traces['seed']['roles']) == 8  # five dynamically allocated slots
    assert traces['growth']['roles'] == ['practice_blueprint', 'practice_slot_1',
        'practice_slot_2', 'practice_review', 'practice_final']
    assert traces['cached_growth']['roles'] == traces['growth']['roles'][1:]
    assert traces['reached_target']['roles'] == traces['add_zero']['roles'] == []
    module = ast.parse(Path(practice.__file__).read_text())
    module.body = [node for node in module.body if not (
        isinstance(node, ast.FunctionDef) and node.name == 'request')]
    return {'scenarios': traces, 'outside_request_ast_sha256': sha(ast.dump(module).encode()),
            'prompt_tree_sha256': tree_hash(p for p in (ROOT/'prompts').rglob('*') if p.is_file()),
            'other_reference_tree_sha256': tree_hash(p for p in (ROOT/'reference').rglob('*.py')
                                                   if p != Path(practice.__file__)),
            'requirements_sha256': sha((ROOT/'requirements.lock').read_bytes())}


def test_exact_pre_edit_requests_projections_exports_and_versioned_sources(tmp_path):
    baseline = read(ROOT/'tests/fixtures/practice-request-baseline.json')
    # T11–T19 version the non-Practice tree; T19 changes only Explain request().
    # Keep the immutable T10 fixture and all
    # request/export/prompt/lock comparisons exact.
    expected = {**baseline['snapshot'], 'other_reference_tree_sha256':
                '9476900fc753f9add8f79cba5d1d557f17e556001b73b3415fff227cfc956305'}
    assert capture(tmp_path, appended=True) == expected


def test_all_dynamic_slots_native_contracts_reach_provider_after_data(tmp_path):
    run = runner(tmp_path, seed_bundle())
    invoke(run)
    requests = {role: read(tmp_path/'requests'/f'{role}.json') for role in ROLES}
    requests['practice_slot_97'] = practice.request(run, 'practice_slot_97',
        payload(requests['practice_slot_1']), None, None, True)
    calls = []
    class Client:
        def converse(self, **kwargs):
            calls.append(kwargs)
            return {'synthetic_transport_only': True}
    provider = Bedrock({'model': 'synthetic-no-service', 'max_output_tokens': 100})
    provider.client = Client()
    for role, request in requests.items():
        first, last = request['messages'][0]['content']
        contract = last['text']
        assert 'Declared task data:\n' in first['text']
        assert 'Final response contract for' not in first['text']
        assert contract.startswith('Final response contract for '+role+':\n')
        for phrase in ('one complete strict JSON object', 'first non-whitespace character must be {',
                       'last must be }', 'preamble', 'postscript', 'headings', 'Markdown fences',
                       'extra objects', 'comments', 'trailing commas', 'file receipts',
                       'Markdown inside JSON strings', "role's existing instructions"):
            assert phrase in contract
        if role == 'practice_blueprint':
            assert 'object-valued artifact' in contract and 'skills, digest and theme_wheel' in contract
            assert all(field in contract for field in (*practice.SKILL_FIELDS, *practice.DIGEST_FIELDS))
        elif role.startswith('practice_slot_') or role == 'practice_final':
            assert 'object-valued artifact with questions' in contract
            assert all(field in contract for field in (*practice.FORMATS, 'correct_answer_bool',
                'correct_index', 'correct_indices', 'zero-based', 'exact-set'))
            if role == 'practice_final':
                assert 'dispositions' in contract and 'declines' in contract and 'unresolved locator mismatches' in contract
        else:
            assert 'wrong array, boolean holistic_pass, holistic_issues array and optional comment' in contract
            assert 'Do not wrap the review in artifact' in contract
            assert 'ORIGINAL signature' in contract
        provider.invoke(request, role=role, notes_pages=None)
        assert calls[-1]['messages'] is request['messages']
    assert len(calls) == len(ROLES)+1


@pytest.mark.parametrize('role', ROLES)
def test_existing_framing_unknown_fields_and_negative_feedback_remain_valid(role):
    value = ({'wrong': [], 'holistic_pass': False, 'holistic_issues': [], 'comment': 'negative opinion'}
             if role == 'practice_review' else {'artifact': {'unknown_native': '## Text\nWith Markdown'}})
    value['extra_audit'] = ['unresolved synthetic observation']
    for raw in (json.dumps(value), '```json\n'+json.dumps(value)+'\n```', '```\n'+json.dumps(value)+'\n```'):
        text, _ = model_response_json(raw)
        assert practice.parse(role, text) == value


@pytest.mark.parametrize('role', ROLES)
@pytest.mark.parametrize('kind', ['narrated', 'malformed', 'wrong_envelope'])
def test_invalid_response_raw_retention_failed_checkpoint_and_no_repeat(tmp_path, monkeypatch, role, kind):
    original = Fixture.invoke
    invalid_text = []
    def invalid(self, request, *, role: str, notes_pages):
        response = original(self, request, role=role, notes_pages=notes_pages)
        if role != failing_role:
            return response
        raw = response['output']['message']['content'][0]['text']
        if kind == 'narrated':
            text = 'Here is the requested JSON.\n```json\n'+raw+'\n```'
        elif kind == 'malformed':
            text = raw[:-1]+',}'
        else:
            value = json.loads(raw)
            text = json.dumps({'artifact': value} if role == 'practice_review' else value['artifact'])
        invalid_text.append(text)
        response['output']['message']['content'][0]['text'] = text
        return response
    failing_role = role
    monkeypatch.setattr(Fixture, 'invoke', invalid)
    run = runner(tmp_path, seed_bundle())
    with pytest.raises(ValueError, match='required stage unavailable'):
        invoke(run)
    assert run.result(role)['status'] == 'failed'
    assert read(tmp_path/'responses'/f'{role}.json')['output']['message']['content'][0]['text'] == invalid_text[0]
    assert not (tmp_path/'artifacts/questions.json').exists()
    assert report(tmp_path, practice)['status'] == 'partial_or_failed'
    expected_roles = ['practice_blueprint', *(f'practice_slot_{i}' for i in range(1, 6)),
                      'practice_review', 'practice_final']
    before = read(run.ledger_path)
    assert [call['role'] for call in before['calls']] == expected_roles[:expected_roles.index(role)+1]
    with pytest.raises(ValueError, match='required stage unavailable'):
        invoke(Runner(tmp_path, practice, resume=True))
    assert read(run.ledger_path) == before and len(invalid_text) == 1
