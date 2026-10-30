"""Bounded same-role technical recovery with offline settled provider responses."""
from copy import deepcopy
import json
from pathlib import Path
import socket
import sys
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from reference import runtime
from reference.inputs import ROOT, canonical, load_manifest, read, save, sha, strict_json
from reference.providers import Fixture, validate_config
from reference.runtime import Runner, report

CONFIG = {'provider': 'bedrock', 'image_limit': 3, 'model': 'offline-test-model',
          'region': 'us-east-2', 'max_output_tokens': 8192, 'input_token_bound': 1000000,
          'input_per_million': .24, 'output_per_million': .97, 'cap_usd': 1}
REQUEST = {'system': [{'text': 'Original role contract only.'}], 'messages': [
    {'role': 'user', 'content': [{'text': 'Explicit task only; return artifact object.'},
     {'image': {'format': 'png', 'source': {'bytes': b'original image bytes'}}}]}]}
GOOD = '{"artifact":{"text":"  नमस्ते\\nPreserve this final author text.  "},"note":"exact"}'


def parse(text):
    value = strict_json(text)
    if not isinstance(value.get('artifact'), dict):
        raise ValueError('Private parser context /private/not-for-model AGENTS.md SECRET')
    return value


FACTORY = SimpleNamespace(NAME='technical-test', ROLES=('author',),
                          observations=lambda results: [], parse=lambda role, text, pages: parse(text),
                          request=lambda *args: deepcopy(REQUEST))


@pytest.fixture(autouse=True)
def offline(monkeypatch):
    def forbidden(*args, **kwargs):
        raise AssertionError('No live provider or network in recovery tests')
    import boto3
    monkeypatch.setattr(boto3, 'client', forbidden)
    monkeypatch.setattr(socket.socket, 'connect', forbidden)
    # Other bounded workers can edit different runtime modules in this checkout.
    # Identity behavior is exercised explicitly below with a frozen test marker.
    monkeypatch.setattr(runtime, 'runtime_identity', lambda: {'offline-runtime': 1})


def response(text, *, stop='end_turn', usage=True):
    value = {'output': {'message': {'content': [{'text': text}]}}, 'stopReason': stop}
    if usage is True:
        value['usage'] = {'inputTokens': 1000, 'outputTokens': 100}
    elif usage is not False:
        value['usage'] = usage
    return value


class Sequence:
    def __init__(self, *values):
        self.values, self.calls = list(values), []

    def invoke(self, request, *, role, notes_pages):
        self.calls.append((deepcopy(request), role, notes_pages))
        value = self.values.pop(0)
        if isinstance(value, Exception):
            raise value
        return deepcopy(value)


def runner(path, *responses, config=None):
    path.mkdir(exist_ok=True)
    bundle = {'metadata': {}, 'pages': [], 'declared': {}, 'file_identity': {}}
    run = Runner(path, FACTORY, bundle=bundle, blobs={}, config=config or CONFIG)
    run.provider = Sequence(*responses)
    return run


def invoke(run, request=REQUEST):
    return run.invoke('author', 'author', request, parse)


def file_hashes(path):
    return {str(p.relative_to(path)): sha(p.read_bytes()) for p in path.rglob('*') if p.is_file()}


@pytest.mark.parametrize('raw,category,inside,objects,arrays,mismatch,root_closure', [
    (json.dumps({'artifact': {'text': 'Literal { } [ ] and "quote" and \\slash',
                             'items': [{'text': 'नमस्ते'}]}})[:-1],
     'unexpected_eof', False, 1, 0, False, '}'),
    (' \n{"artifact":{"items":[{"text":"complete"}',
     'unexpected_eof', False, 2, 1, False, '}'),
    ('{"artifact":{"text":'+json.dumps('Unclosed { [ and "quote" and \\slash')[:-1],
     'unexpected_eof', True, 2, 0, False, '}'),
    ('{"artifact":{"text":"Trailing escape'+chr(92),
     'unexpected_eof', True, 2, 0, False, '}'),
    ('{"artifact":{"text":"one" "two"}}',
     'syntax_error', False, 0, 0, False, None),
    ('{"artifact":[1}', 'syntax_error', False, 1, 1, True, None),
    ('{"artifact":{}} {', 'syntax_error', False, 1, 0, False, None),
    ('{"artifact":{"text":"Invalid literal newline\n',
     'syntax_error', True, 2, 0, False, '}'),
    ('', 'unexpected_eof', False, 0, 0, False, None),
    ('[{"artifact":{}}', 'unexpected_eof', False, 0, 1, False, ']'),
])
def test_json_feedback_distinguishes_eof_strings_and_structural_containers(
        raw, category, inside, objects, arrays, mismatch, root_closure):
    with pytest.raises(json.JSONDecodeError) as rejected:
        runtime.model_response_json(raw)
    error = rejected.value
    assert runtime.technical_feedback(error, 'json') == {
        'kind': 'invalid_json', 'line': error.lineno, 'column': error.colno,
        'offset': error.pos, 'length': len(raw), 'offset_equals_length': error.pos == len(raw),
        'json_error': category, 'inside_string': inside,
        'unclosed_containers': {'object': objects, 'array': arrays},
        'container_mismatch': mismatch, 'expected_root_closure': root_closure}


def test_json_feedback_has_fixed_bounded_shape_without_exception_or_source_text():
    secret = '/private/account/AGENTS.md SECRET-PRIVATE@example.invalid'
    raw = json.dumps({'artifact': {'text': secret}})[:-1]
    error = json.JSONDecodeError('Private parser diagnostic '+secret, raw, len(raw))
    feedback = runtime.technical_feedback(error, 'json')
    assert feedback['json_error'] == 'unexpected_eof'
    assert secret not in json.dumps(feedback)
    assert all(word not in json.dumps(feedback) for word in ('AGENTS.md', 'SECRET', 'artifact', 'parser'))
    deep = '{"artifact":'+'['*200
    with pytest.raises(json.JSONDecodeError) as rejected:
        strict_json(deep)
    nested_feedback = runtime.technical_feedback(rejected.value, 'json')
    assert set(nested_feedback) == set(feedback)
    assert nested_feedback['unclosed_containers'] == {'object': 1, 'array': 200}
    assert len(json.dumps(nested_feedback)) < 400
    assert runtime.technical_feedback(ValueError(secret), 'native') == {'kind': 'native_contract_mismatch'}


@pytest.mark.parametrize('framing', ['plain', 'fenced', 'eof_fence'])
def test_eof_feedback_describes_decoder_body_and_same_author_regenerates_whole_response(tmp_path, framing):
    body = '{"artifact":{"text":"Do not lose this authored {text}."}'
    bad = {'plain': body, 'fenced': '```json\n'+body+'\n```',
           'eof_fence': '```json\n'+body}[framing]
    run = runner(tmp_path, response(bad), response(GOOD))
    parsed = []
    def native(text):
        parsed.append(text)
        return parse(text)
    assert run.invoke('author', 'author', REQUEST, native)['output'] == strict_json(GOOD)
    assert parsed == [GOOD]  # The rejected incomplete body is never parsed as an artifact.
    failed = read(tmp_path/'attempts/author/001/checkpoint.json')
    feedback = failed['technical_feedback']
    assert feedback['json_error'] == 'unexpected_eof'
    assert feedback['offset'] == feedback['length'] == len(body)
    assert feedback['offset_equals_length'] is True and feedback['inside_string'] is False
    assert feedback['unclosed_containers'] == {'object': 1, 'array': 0}
    assert feedback['expected_root_closure'] == '}'
    retry, role, _ = run.provider.calls[1]
    assert role == 'author'
    assert retry['system'] == REQUEST['system']
    assert retry['messages'][0]['content'][:-1] == REQUEST['messages'][0]['content']
    instruction = retry['messages'][0]['content'][-1]['text']
    assert 'TECHNICAL RESPONSE CORRECTION, SAME ROLE:' in instruction
    assert 'Regenerate the complete response for this same task as one strict JSON object' in instruction
    assert 'including all required items and closing delimiters' in instruction
    assert 'return a continuation or patch' in instruction
    assert json.loads(instruction.split('\n')[-1]) == {
        'technical_feedback': feedback, 'previous_response_text': bad}
    assert read(tmp_path/'attempts/author/001/response.json') == response(bad)


def test_repairable_eof_is_never_appended_adopted_or_repeated_after_two_corrections(tmp_path):
    bad = '{"artifact":{"text":"Complete authored content"}'
    run = runner(tmp_path, *[response(bad)]*3)
    failed = invoke(run)
    assert failed['status'] == 'failed' and 'output' not in failed
    assert len(run.provider.calls) == 3
    assert run.exposure() == pytest.approx(3*.000337)
    for number, (request, role, _) in enumerate(run.provider.calls, 1):
        assert role == 'author'
        assert read(tmp_path/'attempts/author'/f'{number:03d}'/'response.json') == response(bad)
        if number > 1:
            assert request['messages'][0]['content'][:-1] == REQUEST['messages'][0]['content']
            assert request['messages'][0]['content'][-1]['text'].count('TECHNICAL RESPONSE CORRECTION, SAME ROLE:') == 1
    before = file_hashes(tmp_path)
    resumed = Runner(tmp_path, FACTORY, resume=True)
    resumed.provider = Sequence()
    assert invoke(resumed) == failed and resumed.provider.calls == []
    assert file_hashes(tmp_path) == before


@pytest.mark.parametrize('bad', ['{"artifact":{"text":"authored"}', 'Here is the completed artifact.',
                                  '{"artifact":[]}'])
def test_corrected_response_preserves_all_attempts_costs_author_export_and_resume(tmp_path, bad):
    run = runner(tmp_path, response(bad), response(GOOD))
    original = deepcopy(REQUEST)
    assert invoke(run)['output'] == strict_json(GOOD)
    assert REQUEST == original
    assert len(run.provider.calls) == 2
    assert [entry['attempt'] for entry in run.ledger['calls']] == [1, 2]
    assert [entry['key'] for entry in run.ledger['calls']] == ['author', 'author']
    assert run.exposure() == pytest.approx(2*.000337)
    for index, raw in enumerate((bad, GOOD), 1):
        directory = tmp_path/'attempts/author'/f'{index:03d}'
        assert read(directory/'response.json') == response(raw)
        assert read(directory/'checkpoint.json')['status'] == ('failed' if index == 1 else 'ok')
        assert read(directory/'request.json') == runtime.request_evidence(run.provider.calls[index-1][0])
    retry, role, notes = run.provider.calls[-1]
    assert role == 'author' and notes is None
    assert retry['system'] == REQUEST['system']
    assert retry['messages'][0]['content'][:-1] == REQUEST['messages'][0]['content']
    assert json.loads(retry['messages'][0]['content'][-1]['text'].split('\n')[-1])['previous_response_text'] == bad
    assert all(word not in retry['messages'][0]['content'][-1]['text']
               for word in ('/private/not-for-model', 'AGENTS.md', 'SECRET'))
    assert read(tmp_path/'responses/author.json') == response(bad)
    run.export('author', 'final.json')
    assert read(tmp_path/'artifacts/final.json') == strict_json(GOOD)['artifact']
    summary = report(tmp_path, FACTORY)
    assert summary['requests'] == 2 and summary['status'] == 'complete'
    assert summary['actual_estimate_usd'] == pytest.approx(2*.000337)
    assert summary['unreconciled_reserved_usd'] == 0
    before = file_hashes(tmp_path)
    resumed = Runner(tmp_path, FACTORY, resume=True)
    resumed.provider = Sequence()
    assert invoke(resumed) == run.result('author')
    assert resumed.provider.calls == [] and file_hashes(tmp_path) == before


@pytest.mark.parametrize('limit', [0, 1, 2])
def test_frozen_attempt_bound_and_exhausted_resume(tmp_path, limit):
    run = runner(tmp_path, *[response('broken')]*3, config={**CONFIG, 'technical_retries': limit})
    assert invoke(run)['status'] == 'failed'
    assert len(run.provider.calls) == limit+1
    assert run.identity['technical_recovery']['max_additional_attempts'] == limit
    resumed = Runner(tmp_path, FACTORY, resume=True)
    resumed.provider = Sequence()
    assert invoke(resumed)['status'] == 'failed'
    assert resumed.provider.calls == []


@pytest.mark.parametrize('raw', [response('broken', usage=False), response('broken', usage=None),
    response('broken', usage={'inputTokens': True, 'outputTokens': 100}),
    response('broken', usage={'inputTokens': 1000, 'outputTokens': -1}),
    response('broken', stop='max_tokens'), RuntimeError('Ambiguous transport /private/account')])
def test_unsettled_or_nonfinal_calls_never_repeat(tmp_path, raw):
    run = runner(tmp_path, raw)
    failed = invoke(run)
    assert failed['status'] == 'failed' and not failed.get('retry_eligible')
    assert len(run.provider.calls) == 1
    resumed = Runner(tmp_path, FACTORY, resume=True)
    resumed.provider = Sequence()
    assert invoke(resumed) == failed and resumed.provider.calls == []
    assert len(resumed.ledger['calls']) == 1
    if not isinstance(raw, dict) or raw.get('usage') != {'inputTokens': 1000, 'outputTokens': 100}:
        assert 'actual_usd' not in resumed.ledger['calls'][0]


def test_successful_response_with_unknown_usage_keeps_reservation_and_never_repeats(tmp_path):
    run = runner(tmp_path, response(GOOD, usage=False))
    assert invoke(run)['status'] == 'ok'
    assert run.exposure() == pytest.approx(.24794624)
    assert invoke(run)['status'] == 'ok' and len(run.provider.calls) == 1


def test_each_recovery_reserves_again_before_transport(tmp_path):
    run = runner(tmp_path, response('broken'), config={**CONFIG, 'cap_usd': .248})
    with pytest.raises(RuntimeError, match='cap'):
        invoke(run)
    assert len(run.provider.calls) == len(run.ledger['calls']) == 1
    assert run.exposure() == pytest.approx(.000337)
    assert not (tmp_path/'attempts/author/002').exists()
    resumed = Runner(tmp_path, FACTORY, resume=True)
    resumed.provider = Sequence()
    with pytest.raises(RuntimeError, match='cap'):
        invoke(resumed)
    assert resumed.provider.calls == []


@pytest.mark.parametrize('gap', ['response.json', 'checkpoint.json', 'logical_checkpoint'])
def test_recording_crash_never_duplicates_known_or_ambiguous_call(tmp_path, monkeypatch, gap):
    run = runner(tmp_path, response('broken'))
    original = runtime.save
    def crash(path, value):
        path = Path(path)
        selected = path == (tmp_path/'checkpoints/author.json' if gap == 'logical_checkpoint'
                             else tmp_path/'attempts/author/001'/gap)
        if selected:
            raise OSError('simulated recording crash')
        return original(path, value)
    monkeypatch.setattr(runtime, 'save', crash)
    with pytest.raises(OSError, match='recording crash'):
        invoke(run)
    monkeypatch.setattr(runtime, 'save', original)
    resumed = Runner(tmp_path, FACTORY, resume=True)
    resumed.provider = Sequence()
    with pytest.raises(RuntimeError, match='manual reconciliation'):
        invoke(resumed)
    assert len(run.provider.calls) == 1 and resumed.provider.calls == []


def test_settled_failed_checkpoint_can_resume_remaining_attempt_only(tmp_path, monkeypatch):
    run = runner(tmp_path, response('broken'))
    original = runtime.recovery_request
    def crash(*args):
        raise RuntimeError('stopped between attempts')
    monkeypatch.setattr(runtime, 'recovery_request', crash)
    with pytest.raises(RuntimeError, match='between attempts'):
        invoke(run)
    monkeypatch.setattr(runtime, 'recovery_request', original)
    first = file_hashes(tmp_path/'attempts/author/001')
    resumed = Runner(tmp_path, FACTORY, resume=True)
    resumed.provider = Sequence(response(GOOD))
    changed_request = deepcopy(REQUEST)
    changed_request['messages'][0]['content'][0]['text'] += ' changed'
    with pytest.raises(RuntimeError, match='Original role request changed'):
        invoke(resumed, changed_request)
    assert invoke(resumed)['status'] == 'ok'
    assert len(resumed.provider.calls) == 1 and len(resumed.ledger['calls']) == 2
    assert file_hashes(tmp_path/'attempts/author/001') == first


@pytest.mark.parametrize('filename', ['request.json', 'response.json', 'checkpoint.json'])
def test_attempt_evidence_tampering_blocks_completed_reuse(tmp_path, filename):
    run = runner(tmp_path, response(GOOD))
    invoke(run)
    save(tmp_path/'attempts/author/001'/filename, {'tampered': True})
    with pytest.raises(RuntimeError, match='[Aa]ttempt'):
        invoke(Runner(tmp_path, FACTORY, resume=True))


@pytest.mark.parametrize('target', ['identity.json', 'ledger.json'])
def test_changed_recovery_policy_cannot_expand_paid_attempts(tmp_path, target):
    run = runner(tmp_path, response(GOOD), config={**CONFIG, 'technical_retries': 1})
    value = read(tmp_path/target)
    value['technical_recovery']['max_additional_attempts'] = 2
    save(tmp_path/target, value)
    with pytest.raises(RuntimeError, match='technical recovery policy'):
        Runner(tmp_path, FACTORY, resume=True)


def test_runtime_change_refuses_historical_resume(tmp_path, monkeypatch):
    runner(tmp_path, response(GOOD))
    monkeypatch.setattr(runtime, 'runtime_identity', lambda: {'offline-runtime': 2})
    with pytest.raises(RuntimeError, match='Frozen runtime changed'):
        Runner(tmp_path, FACTORY, resume=True)


@pytest.mark.parametrize('value', [-1, 3, True, 1.0, None])
def test_config_recovery_limit_rejects_invalid_values(value):
    with pytest.raises(ValueError, match='technical_retries'):
        validate_config({**CONFIG, 'technical_retries': value})


def test_declared_native_contract_hook_runs_before_success_checkpoint(tmp_path, monkeypatch):
    run = runner(tmp_path, response('{"artifact":{}}'), response(GOOD))
    declared = {'expected_slots': ['a']}
    seen = []
    def parse_declared(role, text, inputs, notes_pages=None):
        seen.append((role, inputs, notes_pages))
        value = parse(text)
        if 'text' not in value['artifact']:
            raise ValueError('Required native text shape missing')
        return value
    monkeypatch.setattr(FACTORY, 'parse_declared', parse_declared, raising=False)
    assert run.role('author', declared)['status'] == 'ok'
    assert seen == [('author', declared, None)]*2
    assert read(tmp_path/'attempts/author/001/checkpoint.json')['technical_feedback'] == {
        'kind': 'native_contract_mismatch'}


def recovered_guideline(path, role='revision', inspection=False):
    from reference.factories import guideline
    bundle, blobs = load_manifest(ROOT/'examples/guideline/manifest.json', guideline)
    run = Runner(path, guideline, bundle=bundle, blobs=blobs, config=CONFIG)
    class SettledGuideline(Fixture):
        def __init__(self):
            self.failed = False
        def invoke(self, request, *, role, notes_pages):
            if role == wanted and bool(notes_pages) == inspection and not self.failed:
                self.failed = True
                return response('{}' if inspection else '{"artifact":{"text":"complete"}')
            result = super().invoke(request, role=role, notes_pages=notes_pages)
            result['usage'] = {'inputTokens': 1000, 'outputTokens': 100}
            return result
    wanted = role
    run.provider = SettledGuideline()
    guideline.graph(run).invoke({'last_role': 'start'})
    return run, guideline


@pytest.mark.parametrize('role,inspection', [('revision', False), ('revision', True), ('coverage', True)])
def test_guideline_completion_accepts_exact_accounted_final_or_inspection_recovery(tmp_path, role, inspection):
    run, guideline = recovered_guideline(tmp_path, role, inspection)
    key = role+'__batch_1' if inspection else role
    summary = report(tmp_path, guideline)
    assert summary['status'] == summary['role_execution_status'] == 'complete'
    assert summary['completion_blockers'] == []
    assert summary['checkpoint_statuses'][key] == 'ok'
    assert summary['requests'] == 17
    assert summary['actual_estimate_usd'] == pytest.approx(17*.000337)
    assert read(tmp_path/'attempts'/key/'001/checkpoint.json')['status'] == 'failed'
    assert read(tmp_path/'attempts'/key/'002/checkpoint.json')['status'] == 'ok'
    before = file_hashes(tmp_path)
    resumed = Runner(tmp_path, guideline, resume=True)
    resumed.provider = Sequence()
    guideline.graph(resumed).invoke({'last_role': 'start'})
    assert resumed.provider.calls == []
    assert report(tmp_path, guideline)['status'] == 'complete'
    assert file_hashes(tmp_path) == before


@pytest.mark.parametrize('damage', ['attempt_number', 'old_checkpoint', 'old_response', 'retry_request',
    'retry_feedback', 'reservation', 'actual_charge', 'usage', 'policy', 'required_inspection'])
def test_guideline_recovery_report_rejects_damaged_chain_accounting_or_missing_inspection(tmp_path, damage):
    run, guideline = recovered_guideline(tmp_path)
    matches = [call for call in run.ledger['calls'] if call['key'] == 'revision']
    first, last = matches
    if damage == 'attempt_number':
        last['attempt'] = 3
    elif damage == 'old_checkpoint':
        save(tmp_path/'attempts/revision/001/checkpoint.json', {'status': 'failed', 'error': 'changed'})
    elif damage == 'old_response':
        save(tmp_path/'attempts/revision/001/response.json', response('changed'))
    elif damage == 'retry_request':
        changed = read(tmp_path/'attempts/revision/002/request.json')
        changed['messages'][0]['content'][-1]['text'] += ' hidden instructions'
        save(tmp_path/'attempts/revision/002/request.json', changed)
        last['request_sha256'] = sha(canonical(changed))
    elif damage == 'retry_feedback':
        changed = read(tmp_path/'attempts/revision/001/checkpoint.json')
        changed['technical_feedback']['kind'] = 'private leaked feedback'
        save(tmp_path/'attempts/revision/001/checkpoint.json', changed)
        first['checkpoint_sha256'] = sha(canonical(changed))
    elif damage == 'reservation':
        last['reserved_usd'] = 0
    elif damage == 'actual_charge':
        last['actual_usd'] = 0
    elif damage == 'usage':
        last['usage'] = {'inputTokens': 0, 'outputTokens': 0}
        last['actual_usd'] = 0
    elif damage == 'policy':
        run.ledger['technical_recovery']['max_additional_attempts'] = 0
    else:
        (tmp_path/'checkpoints/revision__batch_1.json').unlink()
    save(run.ledger_path, run.ledger)
    before = file_hashes(tmp_path)
    summary = report(tmp_path, guideline)
    assert summary['status'] == 'partial_or_failed'
    assert summary['completion_blockers']
    assert {k: v for k, v in file_hashes(tmp_path).items() if k not in ('report.html', 'summary.json')} == before


def test_guideline_legacy_single_call_evidence_remains_reportable(tmp_path):
    from reference.factories import guideline
    bundle, blobs = load_manifest(ROOT/'examples/guideline/manifest.json', guideline)
    run = Runner(tmp_path, guideline, bundle=bundle, blobs=blobs,
                 config={'provider': 'fixture', 'image_limit': 3})
    guideline.graph(run).invoke({'last_role': 'start'})
    # Represent a pre-recovery identity using its unchanged single-call evidence.
    identity = read(tmp_path/'identity.json')
    identity.pop('technical_recovery')
    identity['runtime'] = {'historical': 'original frozen runtime'}
    save(tmp_path/'identity.json', identity)
    run.ledger.pop('technical_recovery')
    for call in run.ledger['calls']:
        call.pop('attempt')
    save(run.ledger_path, run.ledger)
    assert report(tmp_path, guideline)['status'] == 'complete'
