"""T18 synthetic request preservation, native transport and completed resume."""
from copy import deepcopy
import json

import pytest

from test_visuals_boards import make_run, offline, local_stubs
from reference.factories import boards, visuals, media_common as c
from reference.factories.visuals_fixture import payload
from reference.inputs import ROOT, canonical, read, sha
from reference.providers import Bedrock, Fixture
from reference.runtime import Runner, model_response_json, report


CONTRACT = (
    'pixi_code is the executable body of an already-invoked async function, '
    'with initialized app and PIXI supplied by the host. Execute scene setup in that body. '
    'Merely defining a helper function does not execute it; explicitly invoke any helper needed for setup. '
    'Assign globalThis.renderAt to a function accepting t_ms before the body completes. '
    'duration_ms belongs in the returned visual_explanation JSON metadata, not in pixi_code. '
    'The host does not inject a JavaScript variable named visual_explanation. '
    'Preserve the native artifact envelope and the pixi_code string field; '
    'all existing authoring and final-revision instructions remain in force.')


def request_cases():
    """Identical explicit synthetic task projections captured before the runtime edit."""
    for idx in (2, 19):
        card = {'card_idx': idx, 'card_type': 'concept', 'title': 'SYNTHETIC TITLE',
                'lines': [{'display': 'SYNTHETIC DISPLAY', 'audio': 'SYNTHETIC AUDIO'}]}
        base = {'grade': 4, 'subject': 'SYNTHETIC SUBJECT',
                'guideline': {'synthetic': 'DECLARED GUIDELINE ONLY'}, 'card': card}
        for mode in ('pixi', 'svg', 'interactive', 'board'):
            factory = boards if mode == 'board' else visuals
            for revision in ((False, True) if mode == 'interactive' else (False,)):
                for phase in ('author', 'review', 'final'):
                    role = f'{factory.NAME}_c{idx:03d}' + ('_interactive' if revision else '') + '_'+phase
                    declared = {**base, 'mode': mode, 'phase': phase, 'interactive_revision': revision,
                                'decision': {'card_idx': idx, 'decision': 'animated_visual',
                                             'visual_spec': 'SYNTHETIC SPEC'}}
                    if revision:
                        declared['base_visual'] = {'visuals': [{'card_idx': idx}]}
                    if phase in ('review', 'final'):
                        declared.update(draft={'visuals': [{'card_idx': idx}]},
                                        render_evidence={'status': 'failed', 'frames': []})
                    if phase == 'final':
                        declared['review'] = {'ok': False, 'findings': ['SYNTHETIC NEGATIVE ADVICE']}
                    yield mode+':'+role, factory, role, declared
        yield f'decide:{idx}', visuals, 'visuals_decide', {**base, 'mode': 'decide', 'targets': []}


def baseline_requests():
    rows = {}
    for key, factory, role, declared in request_cases():
        request = factory.request(None, role, declared, [], [], True)
        rows[key] = sha(canonical(request))
    # Actual graph reviews bypass visuals.request and attach pixels only here.
    for mode in ('pixi', 'svg', 'interactive', 'board'):
        role = ('boards' if mode == 'board' else 'visuals')+'_c002_review'
        prompt = 'board_verify' if mode == 'board' else visuals.prompt_for(role, mode)
        rows['frames:'+mode] = sha(canonical(evidence(c.request(None, role,
            {'mode': mode, 'render_evidence': {'status': 'complete'}}, [], [], True, prompt,
            [{'format': 'png', 'data': b'SYNTHETIC FRAME BYTES'}]))))
    return rows


def evidence(request):
    return json.loads(json.dumps(request, default=lambda data: {'sha256': sha(data), 'bytes': len(data)}))


@pytest.mark.parametrize('case', list(request_cases()), ids=lambda case: case[0])
def test_exact_base_requests_only_pixi_author_and_final_add_system(case):
    key, factory, role, declared = case
    original = deepcopy(declared)
    request = factory.request(None, role, declared, [], [], True)
    assert declared == original
    assert payload(request) == declared
    assert len(request['messages']) == len(request['messages'][0]['content']) == 1
    if declared['mode'] == 'pixi' and role.endswith(('_author', '_final')):
        assert request.pop('system') == [{'text': CONTRACT}]
    else:
        assert 'system' not in request
    baseline = read(ROOT/'tests/fixtures/visuals-pixi-body-baseline.json')
    assert sha(canonical(request)) == baseline['requests'][key]


@pytest.mark.parametrize('mode', ('pixi', 'svg', 'interactive', 'board'))
def test_review_pixels_and_original_blocks_are_unchanged(mode):
    role = ('boards' if mode == 'board' else 'visuals')+'_c002_review'
    prompt = 'board_verify' if mode == 'board' else visuals.prompt_for(role, mode)
    pixels = b'SYNTHETIC FRAME BYTES'
    request = c.request(None, role, {'mode': mode, 'render_evidence': {'status': 'complete'}},
                        [], [], True, prompt, [{'format': 'png', 'data': pixels}])
    assert set(request) == {'messages'}
    assert request['messages'][0]['content'][1] == {'image': {'format': 'png', 'source': {'bytes': pixels}}}
    baseline = read(ROOT/'tests/fixtures/visuals-pixi-body-baseline.json')
    assert sha(canonical(evidence(request))) == baseline['requests']['frames:'+mode]


def test_actual_transport_graph_hashes_exports_and_completed_resume(tmp_path, local_stubs):
    run = make_run(tmp_path, visuals)
    calls = []

    class Client:
        def converse(self, **kwargs):
            role = visuals.roles_for(run.bundle)[len(calls)]
            calls.append(deepcopy(kwargs))
            request = {'messages': kwargs['messages']}
            data = payload(request)
            affected = data['mode'] == 'pixi' and role.endswith(('_author', '_final'))
            assert set(kwargs) == {'modelId', 'messages', 'inferenceConfig', *({'system'} if affected else set())}
            assert kwargs['modelId'] == 'synthetic-no-service'
            assert kwargs['inferenceConfig'] == {'maxTokens': 100, 'temperature': .1}
            if affected:
                assert kwargs['system'] == [{'text': CONTRACT}]
                request['system'] = kwargs['system']
            return Fixture().invoke(request, role=role, notes_pages=None)

    provider = Bedrock({'model': 'synthetic-no-service', 'max_output_tokens': 100})
    provider.client = Client()
    run.provider = provider
    visuals.graph(run).invoke({'last_role': 'start'})
    assert len(calls) == len(run.ledger['calls']) == 13
    assert report(tmp_path, visuals)['status'] == 'complete'
    assert run.exposure() == 0 and not (tmp_path/'ledger.json').exists()
    for call in run.ledger['calls']:
        request = read(tmp_path/'requests'/f'{call["key"]}.json')
        assert call['request_sha256'] == sha(canonical(request))
        assert call['checkpoint_sha256'] == sha(canonical(read(tmp_path/'checkpoints'/f'{call["key"]}.json')))
        if 'system' in request:
            assert request['system'] == [{'text': CONTRACT}]
            legacy = deepcopy(request); legacy.pop('system')
            assert sha(canonical(legacy)) != call['request_sha256']
        for prohibited in ('AGENTS.md', 'SKILL.md', str(ROOT), str(tmp_path)):
            assert prohibited not in json.dumps(request)
        assert call['actual_usd'] == call['reserved_usd'] == 0
        if call['role'].endswith('_final'):
            assert read(tmp_path/'artifacts'/f'{call["role"]}.json') == run.output(call['role'])['artifact']
            assert payload(request)['review']['ok'] is False
    assert sum('system' in kwargs for kwargs in calls) == 2
    before = {str(p.relative_to(tmp_path)): p.read_bytes() for p in tmp_path.rglob('*') if p.is_file()}
    resumed = Runner(tmp_path, visuals, resume=True)
    resumed.provider = provider
    visuals.graph(resumed).invoke({'last_role': 'start'})
    assert len(calls) == 13
    assert {str(p.relative_to(tmp_path)): p.read_bytes() for p in tmp_path.rglob('*') if p.is_file()} == before


@pytest.mark.parametrize('text', ['Procedure first: {"artifact":{}}', '{"artifact":[]}', '{"findings":[]}'])
def test_native_author_parser_stays_strict(text):
    with pytest.raises(ValueError):
        framed, _ = model_response_json(text)
        visuals.parse('visuals_c002_final', framed)
