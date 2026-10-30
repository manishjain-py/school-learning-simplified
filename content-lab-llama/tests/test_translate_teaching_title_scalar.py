"""T25 fixed scalar suffix only; exact Git-base requests and unchanged native failures."""
import ast
from copy import deepcopy
import json
from pathlib import Path

import pytest

from guideline_refresher_object_support import restore_guideline_base

from translate_practice_review_support import strip_practice_review_ast

from test_translate import runner, invoke, offline, PACKS, intercept
from test_translate_teaching_final_system import request_cases, scenario_bundle
from reference.factories import translate
from reference.factories.translate_fixture import payload
from reference.inputs import ROOT, canonical, read, sha
from reference.providers import Bedrock, Fixture
from reference.runtime import Runner, report
from test_translate_teaching_line_string import LINE, strip_line
from test_translate_teaching_identity_string import IDENTITY

SCALAR = (
    '\nScalar member syntax: title_display has exactly one JSON string value in each teaching item. '
    'Write its property name once, one colon, and one quoted string value. Keep Markdown and Unicode '
    'within that string; escape any embedded quotes, backslashes and line breaks as JSON requires. '
    'Syntax-only illustration: {"title_display":"Example title"}. This demonstrates one member\'s '
    'syntax, not a replacement title, item or response. Supply each item\'s actual translated title '
    'and preserve all required items, fields, identities and envelope.')
BASELINE = ROOT/'tests/fixtures/translate-teaching-title-scalar-baseline.json'


def baseline():
    return read(BASELINE)


def strip_scalar(request, stream, phase):
    """Remove only the exact T25 suffix, keeping all previous system bytes."""
    strip_line(request, stream, phase)
    if stream == 'teaching' and phase == 'final':
        assert set(request['system'][0]) == {'text'} and len(request['system']) == 1
        text = request['system'][0]['text']
        assert text.endswith(SCALAR) and text.count(SCALAR) == 1
        request['system'][0]['text'] = text[:-len(SCALAR)]
    else:
        assert 'system' not in request
    return request


@pytest.mark.parametrize('case', list(request_cases()), ids=lambda c: c[0])
def test_full_immutable_base_matrix_preserves_prefix_user_blocks_and_declarations(case, monkeypatch):
    role, declared = case
    monkeypatch.setenv('PRIVATE_OPERATOR_HISTORY', 'OPERATOR_SENTINEL')
    before = deepcopy(declared)
    request = translate.request(None, role, declared, [], [], True)
    old = baseline()['full_cases'][role]
    assert declared == before == old['declared'] == payload(request)
    assert request['messages'] == old['request']['messages']
    if declared['stream'] == 'teaching' and role.endswith('_final'):
        text = request['system'][0]['text']
        assert text == old['request']['system'][0]['text']+SCALAR+LINE+IDENTITY
        for forbidden in ('SYNTHETIC', 'नमूना', 'OPERATOR_SENTINEL', 'AGENTS', 'SKILL', str(ROOT)):
            assert forbidden not in text
        for item in declared['items']:
            assert item['slot'] not in text and item['source_hash'] not in text
    strip_scalar(request, declared['stream'], role.rsplit('_', 1)[1])
    assert request == old['request']
    assert sha(canonical(request)) == baseline()['requests'][role]['request_sha256']


def test_only_request_changed_and_exact_source_restoration_reconstructs_prior_trees():
    old = baseline()
    files = lambda paths: {str(p.relative_to(ROOT)): sha(p.read_bytes()) for p in sorted(paths)}
    current = restore_guideline_base(files((ROOT/'reference').rglob('*.py')))
    changed = 'reference/factories/translate.py'
    assert current[changed] != old['reference_sha256'][changed]
    restored = {**current, changed: sha(old['translate_source'].encode())}
    assert restored == old['reference_sha256']
    current_source = Path(translate.__file__).read_text()
    original_ast, current_ast = ast.parse(old['translate_source']), ast.parse(current_source)
    strip_practice_review_ast(current_ast)
    constants = [n for n in ast.walk(current_ast) if isinstance(n, ast.Constant)
                 and isinstance(n.value, str) and n.value.endswith(SCALAR+LINE+IDENTITY)]
    assert len(constants) == 1
    constants[0].value = constants[0].value[:-len(SCALAR+LINE+IDENTITY)]
    assert ast.dump(current_ast) == ast.dump(original_ast)
    before = next(n for n in original_ast.body if isinstance(n, ast.FunctionDef) and n.name == 'request')
    after = next(n for n in current_ast.body if isinstance(n, ast.FunctionDef) and n.name == 'request')
    old_lines, new_lines = old['translate_source'].splitlines(keepends=True), current_source.splitlines(keepends=True)
    assert old_lines[:before.lineno-1] == new_lines[:after.lineno-1]
    assert old_lines[before.end_lineno:] == new_lines[after.end_lineno:]
    module = ast.parse(current_source)
    module.body = [n for n in module.body if not (isinstance(n, ast.FunctionDef) and n.name == 'request')]
    assert sha(ast.dump(module).encode()) == old['outside_request_ast_sha256']
    assert files(p for p in (ROOT/'prompts').rglob('*') if p.is_file()) == old['prompt_sha256']
    assert files(p for p in (ROOT/'tests/fixtures').glob('*.json') if p != BASELINE and p.name not in ('translate-teaching-line-string-baseline.json', 'translate-teaching-identity-string-baseline.json', 'translate-practice-review-system-baseline.json', 'guideline-refresher-object-syntax-baseline.json')) == old['all_historical_fixtures_sha256']
    assert sha((ROOT/'requirements.lock').read_bytes()) == old['requirements_sha256']
    prior = old['prior_tree_sha256']
    for excluded, expected in prior.items():
        assert sha(canonical({k:v for k,v in restored.items() if k != f'reference/factories/{excluded}.py'})) == expected


def snapshot(path):
    return {str(p.relative_to(path)):p.read_bytes() for p in path.rglob('*') if p.is_file()}


@pytest.mark.parametrize('size', (None, 2, 50))
def test_inert_converse_exact_graph_outputs_hashes_exports_and_zero_call_byte_stable_resume(tmp_path, size):
    run = runner(tmp_path, scenario_bundle(size))
    roles = [translate.role_key(b, p) for b in translate.batches(run.bundle, translate.project(run.bundle))
             for p in translate.PHASES]
    calls = []
    class Client:
        def converse(self, **kwargs):
            role = roles[len(calls)]
            calls.append(deepcopy(kwargs))
            request = {'messages': kwargs['messages']}
            assert kwargs['modelId'] == 'synthetic-no-service'
            assert kwargs['inferenceConfig'] == {'maxTokens':8192, 'temperature':.1}
            if 'system' in kwargs:
                request['system'] = kwargs['system']
                if role.startswith('translate_teaching_') and role.endswith('_final'):
                    assert kwargs['system'][0]['text'].endswith(SCALAR+LINE+IDENTITY)
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
        data = payload(request)
        phase = role.rsplit('_', 1)[1]
        if phase == 'final':
            assert data['review']['verdicts'] and all(v['pass'] is False for v in data['review']['verdicts'])
            output = run.output(role)
            assert all(d['action'] == 'declined' for d in output['dispositions'])
            assert read(tmp_path/'artifacts'/f'{role}.json') == output['artifact']
        strip_scalar(request, data['stream'], phase)
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
@pytest.mark.parametrize('kind', ('extra_colon', 'second_string', 'label_fragment_extra_colon', 'missing_outer', 'misnested_incomplete', 'max_complete', 'max_misnested'))
def test_raw_failed_envelope_never_salvaged_exported_assembled_or_retried(tmp_path, monkeypatch, kind, all_pass):
    original = Fixture.invoke
    target = 'translate_teaching_b001_final'
    responses, framed = [], []
    from reference import runtime
    original_frame = runtime.model_response_json
    def frame(raw):
        framed.append(raw)
        return original_frame(raw)
    monkeypatch.setattr(runtime, 'model_response_json', frame)
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
            if kind in ('misnested_incomplete', 'max_misnested'):
                value['artifact'].update(verdicts=[], batch_issues=[],
                    dispositions=value.pop('dispositions'), pre_revision_diagnostics={'observations':[]})
            raw = json.dumps(value, ensure_ascii=False)
            if kind in ('extra_colon', 'second_string', 'label_fragment_extra_colon'):
                item = value['artifact']['items'][0]
                item['title_display'] = 'SYNTHETIC unique scalar failure target'
                title = json.dumps(item['title_display'], ensure_ascii=False)
                if kind == 'label_fragment_extra_colon':
                    item['lines'][0]['display'] = 'SYNTHETIC label fragment title_display: '
                raw = json.dumps(value, ensure_ascii=False)
                second = json.dumps('SYNTHETIC second title', ensure_ascii=False)
                bad = title+(':'+second if kind != 'second_string' else ' '+second)
                assert raw.count('"title_display": '+title) == 1
                raw = raw.replace('"title_display": '+title, '"title_display": '+bad, 1)
            if kind in ('missing_outer', 'misnested_incomplete'):
                raw = raw[:-1]
            response['output']['message']['content'][0]['text'] = raw
            response['stopReason'] = 'max_tokens' if kind.startswith('max_') else 'end_turn'
            responses.append(deepcopy(response))
            framed.clear()
        return response
    monkeypatch.setattr(Fixture, 'invoke', altered)
    run = runner(tmp_path)
    with pytest.raises(ValueError, match='required stage unavailable'):
        invoke(run)
    result = run.result(target)
    assert result['status'] == 'failed' and 'output' not in result
    assert read(tmp_path/'responses'/f'{target}.json') == responses[0]
    raw = responses[0]['output']['message']['content'][0]['text']
    if kind.startswith('max_'):
        assert result['error'].startswith('Non-final provider stop')
        assert framed == [] and 'response_framing' not in result
    else:
        with pytest.raises(json.JSONDecodeError) as error:
            json.loads(raw)
        assert framed == [raw] and result['error'] == str(error.value)
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


def test_parseable_native_imperfections_and_additional_fields_remain_preserved(tmp_path, monkeypatch):
    target = 'translate_teaching_b001_final'
    def imperfect(role, data, value):
        if role == target:
            value['artifact']['items'][0]['title_display'] = None
            value['artifact']['items'][0]['lines'] = [{'display':'**imperfect**', 'audio':''}]
            value['artifact'].update(verdicts=[], batch_issues=[], pre_revision_diagnostics={'native':'extra'})
            value['extra_author_field'] = {'native':'retained'}
    intercept(monkeypatch, imperfect)
    run = runner(tmp_path)
    invoke(run)
    value = run.output(target)
    assert value['artifact']['items'][0]['title_display'] is None
    assert value['artifact']['pre_revision_diagnostics'] == {'native':'extra'}
    assert value['artifact']['verdicts'] == value['artifact']['batch_issues'] == []
    assert value['extra_author_field'] == {'native':'retained'}
    assert read(tmp_path/'artifacts'/f'{target}.json') == value['artifact']
    assert report(tmp_path, translate)['status'] == 'complete'


@pytest.mark.parametrize('title', ('**नमूना शीर्षक**', 'SYNTHETIC "quoted" title',
                                   'SYNTHETIC \\ path', 'SYNTHETIC title\nsecond line'))
def test_valid_scalar_title_text_is_preserved_in_final_export_and_native_pack(tmp_path, monkeypatch, title):
    target = 'translate_teaching_b001_final'
    def titled(role, data, value):
        if role == target:
            value['artifact']['items'][0]['title_display'] = title
    intercept(monkeypatch, titled)
    run = runner(tmp_path)
    invoke(run)
    final = run.output(target)['artifact']
    assert final['items'][0]['title_display'] == title
    assert read(tmp_path/'artifacts'/f'{target}.json') == final
    assert read(tmp_path/'artifacts/deck_hi.json')['items'][0]['title_display'] == title
