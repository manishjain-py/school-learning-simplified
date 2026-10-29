"""T21 teaching-final output scope: immutable requests, native graph and stop guards."""
import ast
from copy import deepcopy
import json
from pathlib import Path

import pytest

from test_translate import runner, invoke, offline, PACKS, EXAMPLE
from reference.factories import translate
from reference.factories.translate_fixture import payload
from reference.inputs import ROOT, canonical, load_manifest, read, sha
from reference.providers import Bedrock, Fixture
from reference.runtime import Runner, model_response_json, report


SCOPE = (
    '\nOutput scope: task_inputs, source/input objects, draft, review and pre_revision_diagnostics '
    'are input-only; do not reproduce them in the response. This does not exclude the required '
    'slot and source_hash values or translated title_display and lines:[{display,audio}] fields: '
    'preserve those exactly as instructed above. Return the complete final translated content once '
    'in artifact; do not copy another complete item batch into audit or disposition fields. '
    'Keep only the existing allowed audit/disposition fields outside artifact.')


def request_cases():
    bundle, _ = load_manifest(EXAMPLE, translate)
    for stream, items in translate.project(bundle)['streams'].items():
        for number in (1, 7, 1007):
            for phase in translate.PHASES:
                role = translate.role_key({'stream': stream, 'batch': number}, phase)
                declared = {'stream': stream, 'items': deepcopy(items[:2]), 'grade': 4,
                            'subject': 'SYNTHETIC SUBJECT "quoted" \\ path\nनमूना', 'language': 'hi'}
                if phase != 'author':
                    declared.update(draft={'schema_version': 2, 'items': []},
                                    pre_revision_diagnostics={'observations': ['SYNTHETIC DIAGNOSTIC'],
                                                              'advisory_only': True})
                if phase == 'final':
                    declared['review'] = {'verdicts': [], 'batch_issues': ['SYNTHETIC ADVICE']}
                yield role, declared


def scenario_bundle(size):
    bundle, _ = load_manifest(EXAMPLE, translate)
    if size is None:
        bundle['metadata'].pop('batch_size', None)
    else:
        bundle['metadata']['batch_size'] = size
    if size == 50:
        template = bundle['declared']['deck']['cards'][0]
        bundle['declared']['deck']['cards'] = [dict(deepcopy(template), card_idx=i,
            title=f'SYNTHETIC FULL BATCH {i}') for i in range(1, 52)]
    return bundle


def capture(workspace):
    """Captured on immutable Git base BEFORE the runtime edit; never rewrites fixtures."""
    requests = {}
    for role, declared in request_cases():
        request = translate.request(None, role, declared, [], [], True)
        requests[role] = {'request_sha256': sha(canonical(request)),
            'declared_sha256': sha(canonical(declared)),
            'user_blocks_sha256': [sha(b['text'].encode()) for b in request['messages'][0]['content']]}
    scenarios = {}
    for size in (None, 2, 50):
        path = workspace/str(size)
        run = runner(path, scenario_bundle(size))
        invoke(run)
        scenarios[str(size)] = {
            'requests': {role: sha(canonical(read(path/'requests'/f'{role}.json')))
                         for role in translate.report_roles(path)},
            'outputs': {role: sha(canonical(run.output(role))) for role in translate.report_roles(path)},
            'files': {folder: {p.name: sha(p.read_bytes()) for p in sorted((path/folder).glob('*.json'))}
                      for folder in ('views', 'artifacts', 'diagnostics')}}
    module = ast.parse(Path(translate.__file__).read_text())
    module.body = [n for n in module.body if not (isinstance(n, ast.FunctionDef) and n.name == 'request')]
    files = lambda paths: {str(p.relative_to(ROOT)): sha(p.read_bytes()) for p in sorted(paths)}
    return {'requests': requests, 'scenarios': scenarios,
        'outside_request_ast_sha256': sha(ast.dump(module).encode()),
        'reference_sha256': files((ROOT/'reference').rglob('*.py')),
        'prompt_sha256': files(p for p in (ROOT/'prompts').rglob('*') if p.is_file()),
        'historical_fixtures_sha256': files(p for p in (ROOT/'tests/fixtures').glob('*.json')
                                          if p.name not in ('translate-teaching-final-system-baseline.json',
                                                            'guideline-refresher-system-baseline.json',
                                                            'explain-splitter-system-baseline.json',
                                                            'translate-teaching-final-nesting-baseline.json')),
        'requirements_sha256': sha((ROOT/'requirements.lock').read_bytes())}


def baseline():
    return read(ROOT/'tests/fixtures/translate-teaching-final-system-baseline.json')


def strip_new_system(request, stream, phase):
    from test_translate_teaching_final_nesting import strip_nesting
    strip_nesting(request, stream, phase)
    if stream == 'teaching' and phase == 'final':
        assert request.pop('system') == [{'text': request['messages'][0]['content'][1]['text']+SCOPE}]
    else:
        assert 'system' not in request
    return request


@pytest.mark.parametrize('case', list(request_cases()), ids=lambda c: c[0])
def test_exact_base_matrix_all_streams_phases_and_dynamic_batches(case):
    role, data = case
    original = deepcopy(data)
    request = translate.request(None, role, data, [], [], True)
    assert data == original == payload(request)
    assert len(request['messages']) == 1 and request['messages'][0]['role'] == 'user'
    assert len(request['messages'][0]['content']) == 2
    strip_new_system(request, data['stream'], role.rsplit('_', 1)[1])
    expected = baseline()['requests'][role]
    assert sha(canonical(request)) == expected['request_sha256']
    assert sha(canonical(data)) == expected['declared_sha256']
    assert [sha(b['text'].encode()) for b in request['messages'][0]['content']] == expected['user_blocks_sha256']


def test_system_is_existing_contract_plus_fixed_scope_without_task_data(monkeypatch):
    monkeypatch.setenv('PRIVATE_OPERATOR_HISTORY', 'OPERATOR_SENTINEL')
    for role, data in request_cases():
        request = translate.request(None, role, data, [], [], True)
        if data['stream'] != 'teaching' or not role.endswith('_final'):
            assert 'system' not in request
            continue
        from test_translate_teaching_final_nesting import strip_nesting
        strip_nesting(request, data['stream'], 'final')
        text = request['system'][0]['text']
        assert text == request['messages'][0]['content'][1]['text']+SCOPE
        for forbidden in ('SYNTHETIC', 'नमूना', 'OPERATOR_SENTINEL', 'AGENTS', 'SKILL', str(ROOT)):
            assert forbidden not in text
        for item in data['items']:
            assert item['slot'] not in text and item['source_hash'] not in text
        assert all(term in text for term in ('schema_version 2', 'source order', 'authoritative',
            'title_display', 'lines:[{display,audio}]', 'task_inputs', 'pre_revision_diagnostics',
            'source/input objects', 'draft', 'review', 'input-only', 'content once'))


def test_only_request_changes_and_all_historical_sources_remain_exact():
    current = capture_sources()
    old = baseline()
    for key in ('outside_request_ast_sha256', 'prompt_sha256', 'historical_fixtures_sha256', 'requirements_sha256'):
        assert current[key] == old[key]
    changed = 'reference/factories/translate.py'
    # T22/T23 change only Guideline/Explain request bytes; retain the T21 fixture.
    expected = {**old['reference_sha256'], 'reference/factories/guideline.py':
                'fb3c1a3f6b9bdc8de7f9d44ddea70348472a7cfd6347ec67b7645da851e378de',
                'reference/factories/explain.py':
                'ce0a5fdc0d4fe2076d8275c8475a3533cba2ae324782486d3bec4807ebee97c6'}
    assert current['reference_sha256'].keys() == expected.keys()
    assert current['reference_sha256'][changed] != expected[changed]
    assert {k:v for k,v in current['reference_sha256'].items() if k != changed} == {
        k:v for k,v in expected.items() if k != changed}


def capture_sources():
    module = ast.parse(Path(translate.__file__).read_text())
    module.body = [n for n in module.body if not (isinstance(n, ast.FunctionDef) and n.name == 'request')]
    files = lambda paths: {str(p.relative_to(ROOT)): sha(p.read_bytes()) for p in sorted(paths)}
    return {'outside_request_ast_sha256': sha(ast.dump(module).encode()),
        'reference_sha256': files((ROOT/'reference').rglob('*.py')),
        'prompt_sha256': files(p for p in (ROOT/'prompts').rglob('*') if p.is_file()),
        'historical_fixtures_sha256': files(p for p in (ROOT/'tests/fixtures').glob('*.json')
                                          if p.name not in ('translate-teaching-final-system-baseline.json',
                                                            'guideline-refresher-system-baseline.json',
                                                            'explain-splitter-system-baseline.json',
                                                            'translate-teaching-final-nesting-baseline.json')),
        'requirements_sha256': sha((ROOT/'requirements.lock').read_bytes())}


@pytest.mark.parametrize('size', (None, 2, 50))
def test_actual_converse_full_graph_native_exports_hashes_and_zero_request_resume(tmp_path, size):
    run = runner(tmp_path, scenario_bundle(size))
    roles = [translate.role_key(b, p) for b in translate.batches(run.bundle, translate.project(run.bundle))
             for p in translate.PHASES]
    calls = []
    class Client:
        def converse(self, **kwargs):
            role = roles[len(calls)]
            calls.append(deepcopy(kwargs))
            request = {'messages': kwargs['messages']}
            if 'system' in kwargs:
                request['system'] = kwargs['system']
            assert kwargs['modelId'] == 'synthetic-no-service'
            assert kwargs['inferenceConfig'] == {'maxTokens': 8192, 'temperature': .1}
            assert set(kwargs) == {'modelId', 'messages', 'inferenceConfig',
                *({'system'} if role.startswith('translate_teaching_') and role.endswith('_final') else set())}
            return Fixture().invoke(request, role=role, notes_pages=None)
    provider = Bedrock({'model': 'synthetic-no-service', 'max_output_tokens': 8192})
    provider.client = Client()
    run.provider = provider
    invoke(run)
    expected = baseline()['scenarios'][str(size)]
    assert len(calls) == len(roles) == len(run.ledger['calls'])
    assert run.exposure() == 0 and report(tmp_path, translate)['status'] == 'complete'
    assert run.bundle['metadata'].get('batch_size', 12) == (12 if size is None else size)
    if size == 50:
        assert [len(b['items']) for b in read(tmp_path/'views/batches.json') if b['stream'] == 'teaching'] == [50, 1]
    for call in run.ledger['calls']:
        role = call['role']
        request = read(tmp_path/'requests'/f'{role}.json')
        assert call['request_sha256'] == sha(canonical(request))
        assert call['checkpoint_sha256'] == sha(canonical(read(tmp_path/'checkpoints'/f'{role}.json')))
        assert call['actual_usd'] == call['reserved_usd'] == 0
        data = payload(request)
        phase = role.rsplit('_', 1)[1]
        if phase == 'final':
            assert data['review']['verdicts'] and all(v['pass'] is False for v in data['review']['verdicts'])
            assert run.output(role)['dispositions'] and all(d['action'] == 'declined' for d in run.output(role)['dispositions'])
            assert read(tmp_path/'artifacts'/f'{role}.json') == run.output(role)['artifact']
        strip_new_system(request, data['stream'], phase)
        assert sha(canonical(request)) == expected['requests'][role]
        assert sha(canonical(run.output(role))) == expected['outputs'][role]
    for folder, files in expected['files'].items():
        assert {p.name:sha(p.read_bytes()) for p in (tmp_path/folder).glob('*.json')} == files
    before = {str(p.relative_to(tmp_path)):p.read_bytes() for p in tmp_path.rglob('*') if p.is_file()}
    resumed = Runner(tmp_path, translate, resume=True)
    resumed.provider = provider
    invoke(resumed)
    assert len(calls) == len(roles)
    assert before == {str(p.relative_to(tmp_path)):p.read_bytes() for p in tmp_path.rglob('*') if p.is_file()}


@pytest.mark.parametrize('frame', ('plain', 'whole', 'eof', 'adjacent'))
def test_existing_complete_response_framing_stays_accepted(frame):
    value = {'artifact': {'schema_version': 2, 'items': [{'slot': 'teaching:1007',
        'source_hash': 'opaque', 'title_display': 'नमूना', 'lines': [{'display': '**text**', 'audio': 'speech'}]}]},
        'dispositions': [{'action': 'declined', 'reason': 'advisory'}]}
    body = json.dumps(value, ensure_ascii=False)
    raw = {'plain':body, 'whole':'```json\n'+body+'\n```',
           'eof':'```json\n'+body, 'adjacent':'```json\n'+body+'```'}[frame]
    text, _ = model_response_json(raw)
    assert translate.parse('translate_teaching_b1007_final', text) == value


@pytest.mark.parametrize('all_pass', (False, True))
@pytest.mark.parametrize('kind', ('complete_early_artifact', 'echo_truncated', 'procedural'))
def test_final_failure_raw_unrepeated_no_export_or_early_artifact_salvage(tmp_path, monkeypatch, all_pass, kind):
    original = Fixture.invoke
    target = 'translate_teaching_b001_final'
    received = []
    def altered(self, request, *, role, notes_pages):
        response = original(self, request, role=role, notes_pages=notes_pages)
        if role == 'translate_teaching_b001_review' and all_pass:
            value = json.loads(response['output']['message']['content'][0]['text'])
            for verdict in value['verdicts']:
                verdict['pass'] = True
            response['output']['message']['content'][0]['text'] = json.dumps(value)
        if role == target:
            body = response['output']['message']['content'][0]['text']
            raw = {'complete_early_artifact':body, 'echo_truncated':body[:-1]+',"task_inputs":'+
                   json.dumps(payload(request))[:-20], 'procedural':'Procedure first: '+body}[kind]
            response['output']['message']['content'][0]['text'] = raw
            response['stopReason'] = 'end_turn' if kind == 'procedural' else 'max_tokens'
            received.append(deepcopy(response))
        return response
    monkeypatch.setattr(Fixture, 'invoke', altered)
    run = runner(tmp_path)
    with pytest.raises(ValueError, match='required stage unavailable'):
        invoke(run)
    result = run.result(target)
    assert result['status'] == 'failed' and 'output' not in result and 'response_framing' not in result
    if kind != 'procedural':
        assert result['error'].startswith('Non-final provider stop')
    assert read(tmp_path/'responses'/f'{target}.json') == received[0]
    assert not (tmp_path/'artifacts'/f'{target}.json').exists()
    assert not any((tmp_path/'artifacts'/name).exists() for name in PACKS)
    assert not (tmp_path/'metrics/assembly.json').exists()
    assert len(run.ledger['calls']) == 3
    review = payload(read(tmp_path/'requests'/f'{target}.json'))['review']
    assert all(v['pass'] is all_pass for v in review['verdicts'])
    before = {str(p.relative_to(tmp_path)):p.read_bytes() for p in tmp_path.rglob('*') if p.is_file()}
    with pytest.raises(ValueError, match='required stage unavailable'):
        invoke(Runner(tmp_path, translate, resume=True))
    assert len(received) == 1
    assert before == {str(p.relative_to(tmp_path)):p.read_bytes() for p in tmp_path.rglob('*') if p.is_file()}
