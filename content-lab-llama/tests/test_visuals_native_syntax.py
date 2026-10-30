"""Current Pixi syntax preflight; authored JavaScript never runs under Node."""
from copy import deepcopy
import json
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from reference import media
from reference.factories import visuals
from reference.inputs import read
from reference.providers import Fixture
from reference.runtime import NativeContractError, Runner, report
from test_visuals_boards import local_stubs, make_run, offline


SETUP = ('const mark = new PIXI.Graphics().rect(0,0,20,20); app.stage.addChild(mark); '
         'globalThis.renderAt = t_ms => { mark.x = t_ms; };')
BAD = '// Synthetic anonymous wrapper is not an executable body.\nfunction(app, PIXI) {'+SETUP+'}'
CARD = {'card_idx': 2, 'card_type': 'concept', 'title': 'SYNTHETIC NATIVE IDENTITY'}


def envelope(code=SETUP):
    return {'artifact': {'visuals': [{'card_idx': CARD['card_idx'],
        'expected_card_type': CARD['card_type'], 'expected_title': CARD['title'],
        'visual_explanation': {'output_type': 'animated_visual', 'pixi_code': code, 'duration_ms': 1000}}]},
        'dispositions': [{'action': 'declined', 'reason': 'Author decision remains final'}],
        'note': '  Exact author note  '}


@pytest.mark.parametrize('code,valid', [
    (SETUP, True),
    ('async function setup() {'+SETUP+'} await setup();', True),
    ('await Promise.resolve(); '+SETUP, True),
    ('async function setup() {'+SETUP+'}', True),  # Syntax only, no setup-quality judgment.
    (BAD, False),
    ('const broken = ;', False),
    ('await Promise.resolve( ;', False),
    ('const unterminated = "text', False),
])
def test_actual_node_parser_accepts_exact_async_body_and_rejects_actual_syntax_errors(code, valid):
    assert media.visual_body_syntax(code) is valid


def test_parser_never_invokes_authored_body_or_nested_helpers(tmp_path):
    marker = tmp_path/'authored-code-must-not-run.txt'
    code = ("require('node:fs').writeFileSync("+json.dumps(str(marker))+", 'UNEXPECTED EXECUTION'); "
            "process.exit(17); throw new Error('AUTHORED EXECUTION'); while (true) {} "
            "globalThis.renderAt = t_ms => {}; async function nested(){ await missingService(); } await nested();")
    assert media.visual_body_syntax(code) is True
    assert not marker.exists()


def test_checker_receives_unmodified_source_only_on_stdin_and_uses_exact_viewer_constructor(monkeypatch):
    calls = []
    code = '/* literal ` ${source} \\ " हिंदी */ '+SETUP
    def run(args, **kwargs):
        calls.append((args, kwargs))
        return SimpleNamespace(returncode=0, stdout='valid', stderr='')
    monkeypatch.setattr(media, '_tool', lambda name: '/synthetic/node')
    monkeypatch.setattr(media.subprocess, 'run', run)
    assert media.visual_body_syntax(code)
    args, kwargs = calls[0]
    assert args[:2] == ['/synthetic/node', '-e'] and len(args) == 3
    assert code not in args[2] and kwargs['input'] == code
    assert "new Function('app', 'PIXI', '\"use strict\"; return (async()=>{' + source + '\\n})();');" in args[2]
    assert kwargs == {'input': code, 'text': True, 'stdout': subprocess.PIPE,
                      'stderr': subprocess.PIPE, 'timeout': 10}


@pytest.mark.parametrize('failure', ('missing_tool', 'os_error', 'timeout', 'nonzero', 'bad_protocol'))
def test_local_checker_failures_remain_nonrecoverable_media_errors(monkeypatch, failure):
    def tool(name):
        if failure == 'missing_tool':
            raise media.MediaError('Required local tool unavailable: node; no fallback media created')
        return '/synthetic/node'
    def run(*args, **kwargs):
        if failure == 'os_error':
            raise OSError('PRIVATE_HOST_PATH')
        if failure == 'timeout':
            raise subprocess.TimeoutExpired('node', 10)
        return SimpleNamespace(returncode=1 if failure == 'nonzero' else 0,
                               stdout='syntax_error' if failure == 'nonzero' else 'UNEXPECTED_PROTOCOL',
                               stderr='PRIVATE_HOST_PATH')
    monkeypatch.setattr(media, '_tool', tool)
    monkeypatch.setattr(media.subprocess, 'run', run)
    with pytest.raises(media.MediaError) as rejected:
        media.visual_body_syntax(SETUP)
    assert not isinstance(rejected.value, ValueError)
    assert 'PRIVATE_HOST_PATH' not in str(rejected.value)


@pytest.mark.parametrize('mode,role', [('pixi', 'visuals_c002_author'), ('pixi', 'visuals_c002_final'),
                                    ('interactive', 'visuals_c002_author'),
                                    ('interactive', 'visuals_c002_interactive_author'),
                                    ('interactive', 'visuals_c002_interactive_final')])
def test_author_and_interactive_native_preflight_preserves_exact_envelope(mode, role):
    value = envelope()
    original = deepcopy(value)
    assert visuals.parse_declared(role, json.dumps(value), {'mode': mode, 'card': CARD}) == original
    assert value == original
    bad = envelope(BAD)
    with pytest.raises(NativeContractError) as rejected:
        visuals.parse_declared(role, json.dumps(bad), {'mode': mode, 'card': CARD})
    assert rejected.value.constraint == 'visual_executable_body'


@pytest.mark.parametrize('code', (None, '', ' \n ', 17, {'code': SETUP}))
def test_required_code_is_a_nonblank_native_string(code):
    with pytest.raises(ValueError, match='pixi_code must be a nonblank string'):
        visuals.parse_declared('visuals_c002_final', json.dumps(envelope(code)), {'mode': 'pixi', 'card': CARD})


@pytest.mark.parametrize('rows', (None, {}, [], [None], ['not-an-object'], [{}, {}],
                                 [{'visual_explanation': None}], [{'visual_explanation': []}],
                                 [{'visual_explanation': 'not-an-object'}]))
def test_malformed_native_rows_and_explanations_raise_fixed_recoverable_value_errors(rows):
    value = {'artifact': {'visuals': rows}}
    with pytest.raises(ValueError) as rejected:
        visuals.parse_declared('visuals_c002_final', json.dumps(value), {'mode': 'pixi', 'card': CARD})
    assert type(rejected.value) is ValueError
    assert str(rejected.value) in ('Visual native artifact requires one object-valued visual',
                                  'Visual native explanation must be an object')


@pytest.mark.parametrize('role,mode,value', [
    ('visuals_decide', 'decide', {'artifact': {'decisions': [], 'interactive_candidates': []}}),
    ('visuals_c002_review', 'pixi', {'ok': False, 'findings': ['Advisory concern']}),
    ('visuals_c002_interactive_review', 'interactive', {'ok': False, 'findings': []}),
    ('visuals_c002_author', 'svg', envelope(BAD)),
    ('visuals_c002_final', 'svg', envelope(BAD)),
])
def test_decider_review_and_svg_routes_never_enter_javascript_checker(monkeypatch, role, mode, value):
    def forbidden(*args, **kwargs):
        raise AssertionError('Excluded route cannot use JavaScript syntax checker')
    monkeypatch.setattr(media, 'visual_body_syntax', forbidden)
    assert visuals.parse_declared(role, json.dumps(value), {'mode': mode}) == value


@pytest.mark.parametrize('target', ('visuals_c002_author', 'visuals_c002_final',
                                  'visuals_c003_interactive_author', 'visuals_c003_interactive_final'))
@pytest.mark.parametrize('failures', (1, 2, 3))
def test_syntax_recovery_is_same_author_bounded_with_exact_evidence_and_unchanged_resume(
        tmp_path, local_stubs, monkeypatch, target, failures):
    original = Fixture.invoke
    calls, responses = [], []
    def provider(self, request, *, role, notes_pages):
        calls.append((role, deepcopy(request)))
        response = original(self, request, role=role, notes_pages=notes_pages)
        response['usage'] = {'inputTokens': 100, 'outputTokens': 20}
        if role == target:
            value = json.loads(response['output']['message']['content'][0]['text'])
            if sum(called_role == target for called_role, _ in calls) <= failures:
                value['artifact']['visuals'][0]['visual_explanation']['pixi_code'] = BAD
            value['note'] = 'PRIVATE_AUTHOR_NOTE /Users/private/synthetic-path'
            response['output']['message']['content'][0]['text'] = json.dumps(value)
            responses.append(deepcopy(response))
        return response
    monkeypatch.setattr(Fixture, 'invoke', provider)
    run = make_run(tmp_path, visuals)
    roles = visuals.roles_for(run.bundle)
    if failures < 3:
        visuals.graph(run).invoke({'last_role': 'start'})
        assert report(tmp_path, visuals)['status'] == 'complete'
        accepted = json.loads(responses[-1]['output']['message']['content'][0]['text'])
        assert run.output(target) == accepted
        assert read(tmp_path/'artifacts'/f'{target}.json') == accepted['artifact']
        assert BAD not in json.dumps(accepted)
        assert len(calls) == len(roles)+failures
    else:
        with pytest.raises(ValueError, match='required model stage unavailable'):
            visuals.graph(run).invoke({'last_role': 'start'})
        assert run.result(target)['status'] == 'failed'
        assert not (tmp_path/'artifacts'/f'{target}.json').exists()
        assert not (tmp_path/'media'/target/'manifest.json').exists()
        assert len(calls) == roles.index(target)+3
    target_calls = [request for role, request in calls if role == target]
    assert len(target_calls) == min(failures+1, 3)
    for index, response in enumerate(responses, 1):
        directory = tmp_path/'attempts'/target/f'{index:03d}'
        assert read(directory/'response.json') == response
        checkpoint = read(directory/'checkpoint.json')
        if index <= failures:
            assert checkpoint['status'] == 'failed' and 'output' not in checkpoint
            assert checkpoint['technical_feedback']['constraint'] == 'visual_executable_body'
        else:
            assert checkpoint['status'] == 'ok'
        if index > 1:
            request = target_calls[index-1]
            assert request['system'][:-1] == target_calls[0].get('system', [])
            assert request['messages'][0]['content'][:-1] == target_calls[0]['messages'][0]['content']
            correction = request['system'][-1]['text']
            assert 'visual_executable_body' in correction
            assert 'valid JavaScript statements inside the supplied async function body' in correction
            assert 'PRIVATE_AUTHOR_NOTE' not in correction and BAD not in correction
            data = request['messages'][0]['content'][-1]['text']
            assert json.loads(data.split('\n')[-1])['previous_response_text'] == (
                responses[index-2]['output']['message']['content'][0]['text'])
    assert run.exposure() == 0
    before = {path.relative_to(tmp_path): path.read_bytes() for path in tmp_path.rglob('*') if path.is_file()}
    resumed = Runner(tmp_path, visuals, resume=True)
    if failures < 3:
        visuals.graph(resumed).invoke({'last_role': 'start'})
    else:
        with pytest.raises(ValueError, match='required model stage unavailable'):
            visuals.graph(resumed).invoke({'last_role': 'start'})
    assert len(calls) == len(run.ledger['calls'])
    assert before == {path.relative_to(tmp_path): path.read_bytes() for path in tmp_path.rglob('*') if path.is_file()}


def test_checker_host_failure_never_repeats_settled_author_call(tmp_path, local_stubs, monkeypatch):
    original = Fixture.invoke
    calls = []
    def provider(self, request, *, role, notes_pages):
        calls.append(role)
        response = original(self, request, role=role, notes_pages=notes_pages)
        response['usage'] = {'inputTokens': 100, 'outputTokens': 20}
        return response
    def unavailable(code):
        raise media.MediaTimeout('Synthetic local syntax checker timeout')
    monkeypatch.setattr(Fixture, 'invoke', provider)
    monkeypatch.setattr(media, 'visual_body_syntax', unavailable)
    run = make_run(tmp_path, visuals)
    with pytest.raises(ValueError, match='required model stage unavailable'):
        visuals.graph(run).invoke({'last_role': 'start'})
    target = 'visuals_c002_author'
    checkpoint = read(tmp_path/'checkpoints'/f'{target}.json')
    assert checkpoint['status'] == 'failed' and 'retry_eligible' not in checkpoint
    assert 'technical_feedback' not in checkpoint
    assert calls == ['visuals_decide', target]
    assert not (tmp_path/'artifacts'/f'{target}.json').exists()


@pytest.mark.parametrize('defect', ('null_row', 'null_explanation'))
def test_malformed_native_object_is_corrected_by_same_author_before_export(
        tmp_path, local_stubs, monkeypatch, defect):
    original = Fixture.invoke
    calls = []
    def provider(self, request, *, role, notes_pages):
        calls.append(role)
        response = original(self, request, role=role, notes_pages=notes_pages)
        response['usage'] = {'inputTokens': 100, 'outputTokens': 20}
        if role == 'visuals_c002_author' and calls.count(role) == 1:
            value = json.loads(response['output']['message']['content'][0]['text'])
            if defect == 'null_row':
                value['artifact']['visuals'] = [None]
            else:
                value['artifact']['visuals'][0]['visual_explanation'] = None
            response['output']['message']['content'][0]['text'] = json.dumps(value)
        return response
    monkeypatch.setattr(Fixture, 'invoke', provider)
    run = make_run(tmp_path, visuals)
    visuals.graph(run).invoke({'last_role': 'start'})
    assert report(tmp_path, visuals)['status'] == 'complete'
    assert calls[:3] == ['visuals_decide', 'visuals_c002_author', 'visuals_c002_author']
    failed = read(tmp_path/'attempts/visuals_c002_author/001/checkpoint.json')
    assert failed['technical_feedback'] == {'kind': 'native_contract_mismatch'}
    assert failed['retry_eligible'] is True and 'output' not in failed
    accepted = read(tmp_path/'attempts/visuals_c002_author/002/checkpoint.json')
    assert accepted['status'] == 'ok'
    assert read(tmp_path/'artifacts/visuals_c002_author.json') == accepted['output']['artifact']
