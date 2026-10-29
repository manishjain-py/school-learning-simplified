"""T26 suffix-only clarification; actual Git-base capture and strict synthetic failures."""
import ast
from copy import deepcopy
import json
from pathlib import Path

import pytest

from test_translate import runner, invoke, offline, PACKS, intercept
from test_translate_teaching_final_system import request_cases, scenario_bundle
from reference.factories import translate
from reference.factories.translate_fixture import payload
from reference.inputs import ROOT, canonical, read, sha
from reference.providers import Bedrock, Fixture
from reference.runtime import Runner, report

from test_translate_teaching_identity_string import IDENTITY, strip_identity

LINE = (
    '\nTeaching-line string syntax: Each display and audio value is one JSON string. Use exactly one '
    'opening and one closing delimiter quote around its entire text; escape any quote that belongs '
    'to the text instead of emitting another delimiter quote. Syntax-only illustration: '
    '{"display":"Example line","audio":"Example line"}. This illustrates string delimiters, not '
    'replacement content. Use each actual translated line and preserve every required line, item, '
    'identity and the complete envelope.')
BASELINE = ROOT/'tests/fixtures/translate-teaching-line-string-baseline.json'


def baseline():
    return read(BASELINE)


def strip_line(request, stream, phase):
    """Remove exact T27 then T26, retaining every byte of the T21/T24/T25 prefix."""
    strip_identity(request, stream, phase)
    if stream == 'teaching' and phase == 'final':
        assert len(request['system']) == 1 and set(request['system'][0]) == {'text'}
        text = request['system'][0]['text']
        assert text.endswith(LINE) and text.count(LINE) == 1
        request['system'][0]['text'] = text[:-len(LINE)]
    else:
        assert 'system' not in request
    return request


@pytest.mark.parametrize('case', list(request_cases()), ids=lambda c: c[0])
def test_complete_git_base_requests_declarations_user_blocks_and_prefix(case, monkeypatch):
    role, declared = case
    monkeypatch.setenv('PRIVATE_OPERATOR_HISTORY', 'OPERATOR_SENTINEL')
    before = deepcopy(declared)
    request = translate.request(None, role, declared, [], [], True)
    old = baseline()['full_cases'][role]
    assert declared == before == old['declared'] == payload(request)
    assert request['messages'] == old['request']['messages']
    if declared['stream'] == 'teaching' and role.endswith('_final'):
        text = request['system'][0]['text']
        assert text == old['request']['system'][0]['text']+LINE+IDENTITY
        for forbidden in ('SYNTHETIC', 'नमूना', 'OPERATOR_SENTINEL', 'AGENTS', 'SKILL', str(ROOT)):
            assert forbidden not in text
        for item in declared['items']:
            assert item['slot'] not in text and item['source_hash'] not in text
    strip_line(request, declared['stream'], role.rsplit('_', 1)[1])
    assert request == old['request']
    assert sha(canonical(request)) == baseline()['requests'][role]['request_sha256']


def test_only_request_changes_and_actual_base_bytes_reconstruct_prior_trees():
    old = baseline()
    assert old['synthetic'] is True and old['base_commit'] == 'cfda48eaf860f0ee69deb21a478252145503db82'
    files = lambda paths: {str(p.relative_to(ROOT)):sha(p.read_bytes()) for p in sorted(paths)}
    current = files((ROOT/'reference').rglob('*.py'))
    changed = 'reference/factories/translate.py'
    assert current[changed] != old['reference_sha256'][changed]
    restored = {**current, changed:sha(old['translate_source'].encode())}
    assert restored == old['reference_sha256']
    current_source = Path(translate.__file__).read_text()
    before_ast, after_ast = ast.parse(old['translate_source']), ast.parse(current_source)
    constants = [n for n in ast.walk(after_ast) if isinstance(n, ast.Constant)
                 and isinstance(n.value, str) and n.value.endswith(LINE+IDENTITY)]
    assert len(constants) == 1
    constants[0].value = constants[0].value[:-len(LINE+IDENTITY)]
    assert ast.dump(after_ast) == ast.dump(before_ast)
    before = next(n for n in before_ast.body if isinstance(n, ast.FunctionDef) and n.name == 'request')
    after = next(n for n in after_ast.body if isinstance(n, ast.FunctionDef) and n.name == 'request')
    old_lines, new_lines = old['translate_source'].splitlines(True), current_source.splitlines(True)
    assert old_lines[:before.lineno-1] == new_lines[:after.lineno-1]
    assert old_lines[before.end_lineno:] == new_lines[after.end_lineno:]
    module = ast.parse(current_source)
    module.body = [n for n in module.body if not (isinstance(n, ast.FunctionDef) and n.name == 'request')]
    assert sha(ast.dump(module).encode()) == old['outside_request_ast_sha256']
    assert files(p for p in (ROOT/'prompts').rglob('*') if p.is_file()) == old['prompt_sha256']
    assert files(p for p in (ROOT/'tests/fixtures').glob('*.json') if p != BASELINE and p.name != 'translate-teaching-identity-string-baseline.json') == old['all_historical_fixtures_sha256']
    assert sha((ROOT/'requirements.lock').read_bytes()) == old['requirements_sha256']
    for excluded, expected in old['prior_tree_sha256'].items():
        assert sha(canonical({k:v for k,v in restored.items() if k != f'reference/factories/{excluded}.py'})) == expected


def snapshot(path):
    return {str(p.relative_to(path)):p.read_bytes() for p in path.rglob('*') if p.is_file()}


@pytest.mark.parametrize('size', (None, 2, 50))
def test_native_converse_graph_exports_hashes_and_byte_stable_zero_call_resume(tmp_path, size):
    run = runner(tmp_path, scenario_bundle(size))
    roles = [translate.role_key(b, p) for b in translate.batches(run.bundle, translate.project(run.bundle))
             for p in translate.PHASES]
    calls = []
    class Client:
        def converse(self, **kwargs):
            role = roles[len(calls)]
            calls.append(deepcopy(kwargs))
            request = {'messages':kwargs['messages']}
            assert kwargs['modelId'] == 'synthetic-no-service'
            assert kwargs['inferenceConfig'] == {'maxTokens':8192, 'temperature':.1}
            if 'system' in kwargs:
                request['system'] = kwargs['system']
                assert kwargs['system'][0]['text'].endswith(LINE+IDENTITY)
            assert set(kwargs) == {'modelId', 'messages', 'inferenceConfig', *({'system'} if 'system' in request else set())}
            return Fixture().invoke(request, role=role, notes_pages=None)
    provider = Bedrock({'model':'synthetic-no-service', 'max_output_tokens':8192})
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
        data, phase = payload(request), role.rsplit('_', 1)[1]
        if phase == 'final':
            assert data['review']['verdicts'] and all(v['pass'] is False for v in data['review']['verdicts'])
            output = run.output(role)
            assert all(d['action'] == 'declined' for d in output['dispositions'])
            assert read(tmp_path/'artifacts'/f'{role}.json') == output['artifact']
        strip_line(request, data['stream'], phase)
        assert sha(canonical(request)) == expected['requests'][role]
        assert sha(canonical(run.output(role))) == expected['outputs'][role]
    for folder, files in expected['files'].items():
        assert {p.name:sha(p.read_bytes()) for p in (tmp_path/folder).glob('*.json')} == files
    before = snapshot(tmp_path)
    resumed = Runner(tmp_path, translate, resume=True)
    resumed.provider = provider
    invoke(resumed)
    assert len(calls) == len(roles) and snapshot(tmp_path) == before


@pytest.mark.parametrize('all_pass', (False, True))
@pytest.mark.parametrize('field', ('display', 'audio'))
@pytest.mark.parametrize('side', ('opening', 'closing'))
def test_doubled_line_delimiter_is_raw_failed_without_export_assembly_repair_retry(tmp_path, monkeypatch, all_pass, field, side):
    original = Fixture.invoke
    target = 'translate_teaching_b001_final'
    responses = []
    def altered(self, request, *, role, notes_pages):
        response = original(self, request, role=role, notes_pages=notes_pages)
        if role == 'translate_teaching_b001_review' and all_pass:
            value = json.loads(response['output']['message']['content'][0]['text'])
            for verdict in value['verdicts']:
                verdict['pass'] = True
            value['batch_issues'] = []
            response['output']['message']['content'][0]['text'] = json.dumps(value)
        if role == target:
            value = json.loads(response['output']['message']['content'][0]['text'])
            value['artifact']['items'][0]['lines'][0][field] = 'SYNTHETIC unique delimiter target'
            raw = json.dumps(value, ensure_ascii=False)
            quoted = json.dumps('SYNTHETIC unique delimiter target')
            member = json.dumps(field)+': '+quoted
            assert raw.count(member) == 1
            malformed = ('"'+quoted) if side == 'opening' else (quoted+'"')
            raw = raw.replace(member, json.dumps(field)+': '+malformed, 1)
            response['output']['message']['content'][0]['text'] = raw
            responses.append(deepcopy(response))
        return response
    monkeypatch.setattr(Fixture, 'invoke', altered)
    run = runner(tmp_path)
    with pytest.raises(ValueError, match='required stage unavailable'):
        invoke(run)
    result = run.result(target)
    raw = responses[0]['output']['message']['content'][0]['text']
    with pytest.raises(json.JSONDecodeError) as error:
        json.loads(raw)
    assert result['status'] == 'failed' and 'output' not in result and result['error'] == str(error.value)
    assert read(tmp_path/'responses'/f'{target}.json') == responses[0]
    assert not (tmp_path/'artifacts'/f'{target}.json').exists()
    assert not any((tmp_path/'artifacts'/name).exists() for name in PACKS)
    assert not (tmp_path/'metrics/assembly.json').exists()
    assert len(run.ledger['calls']) == 3
    review = payload(read(tmp_path/'requests'/f'{target}.json'))['review']
    assert all(v['pass'] is all_pass for v in review['verdicts'])
    before = snapshot(tmp_path)
    with pytest.raises(ValueError, match='required stage unavailable'):
        invoke(Runner(tmp_path, translate, resume=True))
    assert len(responses) == 1 and snapshot(tmp_path) == before


@pytest.mark.parametrize('all_pass', (False, True))
def test_complete_looking_max_tokens_rejected_before_framing_and_parser(tmp_path, monkeypatch, all_pass):
    from reference import runtime
    original, original_frame, original_parse = Fixture.invoke, runtime.model_response_json, translate.parse
    target = 'translate_teaching_b001_final'
    framed, parsed, responses = [], [], []
    def frame(raw):
        framed.append(raw)
        return original_frame(raw)
    def parse(role, text, notes_pages=None):
        parsed.append(role)
        return original_parse(role, text, notes_pages)
    def altered(self, request, *, role, notes_pages):
        response = original(self, request, role=role, notes_pages=notes_pages)
        if role == 'translate_teaching_b001_review' and all_pass:
            value = json.loads(response['output']['message']['content'][0]['text'])
            for verdict in value['verdicts']:
                verdict['pass'] = True
            value['batch_issues'] = []
            response['output']['message']['content'][0]['text'] = json.dumps(value)
        if role == target:
            response['stopReason'] = 'max_tokens'
            responses.append(deepcopy(response))
            framed.clear()
            parsed.clear()
        return response
    monkeypatch.setattr(runtime, 'model_response_json', frame)
    monkeypatch.setattr(translate, 'parse', parse)
    monkeypatch.setattr(Fixture, 'invoke', altered)
    run = runner(tmp_path)
    with pytest.raises(ValueError, match='required stage unavailable'):
        invoke(run)
    assert json.loads(responses[0]['output']['message']['content'][0]['text'])['artifact']['items']
    result = run.result(target)
    assert result['status'] == 'failed' and result['error'].startswith('Non-final provider stop')
    assert framed == parsed == [] and 'output' not in result and 'response_framing' not in result
    assert read(tmp_path/'responses'/f'{target}.json') == responses[0]
    assert not (tmp_path/'artifacts'/f'{target}.json').exists()
    assert not any((tmp_path/'artifacts'/name).exists() for name in PACKS)
    assert not (tmp_path/'metrics/assembly.json').exists() and len(run.ledger['calls']) == 3
    before = snapshot(tmp_path)
    with pytest.raises(ValueError, match='required stage unavailable'):
        invoke(Runner(tmp_path, translate, resume=True))
    assert len(responses) == 1 and snapshot(tmp_path) == before


@pytest.mark.parametrize('field', ('display', 'audio'))
@pytest.mark.parametrize('text', ('**नमूना पंक्ति**', 'SYNTHETIC "quoted" line',
                                  'SYNTHETIC \\ path', 'SYNTHETIC first\nsecond'))
def test_valid_line_strings_remain_verbatim_in_final_export_and_pack(tmp_path, monkeypatch, field, text):
    target = 'translate_teaching_b001_final'
    def line(role, data, value):
        if role == target:
            value['artifact']['items'][0]['lines'][0][field] = text
    intercept(monkeypatch, line)
    run = runner(tmp_path)
    invoke(run)
    final = run.output(target)['artifact']
    assert final['items'][0]['lines'][0][field] == text
    assert read(tmp_path/'artifacts'/f'{target}.json') == final
    assert read(tmp_path/'artifacts/deck_hi.json')['items'][0]['lines'][0][field] == text


@pytest.mark.parametrize('lines', ([{'display':None, 'audio':None}],
                                 [{'display':'', 'audio':'', 'native_extra':{'x':None}}], []))
def test_parseable_null_empty_additional_native_fields_are_not_filtered_or_coerced(tmp_path, monkeypatch, lines):
    target = 'translate_teaching_b001_final'
    def imperfect(role, data, value):
        if role == target:
            value['artifact']['items'][0].update(title_display=None, lines=deepcopy(lines))
            value['artifact'].update(verdicts=[], batch_issues=[], pre_revision_diagnostics=None)
            value['extra_author_field'] = {'native':'retained'}
    intercept(monkeypatch, imperfect)
    run = runner(tmp_path)
    invoke(run)
    value = run.output(target)
    assert value['artifact']['items'][0]['lines'] == lines
    assert value['artifact']['pre_revision_diagnostics'] is None
    assert value['artifact']['verdicts'] == value['artifact']['batch_issues'] == []
    assert value['extra_author_field'] == {'native':'retained'}
    assert read(tmp_path/'artifacts'/f'{target}.json') == value['artifact']
    first = read(tmp_path/'artifacts/deck_hi.json')['items'][0]
    assert first['title_display'] is None and first['lines'] == lines
    assert report(tmp_path, translate)['status'] == 'complete'
