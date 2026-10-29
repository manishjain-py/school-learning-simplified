"""T20 native final-author contract, exact request preservation and synthetic transport."""
import ast
from copy import deepcopy
import json
from pathlib import Path

import pytest

from test_visuals_boards import make_run, offline, local_stubs
from test_visuals_pixi_body_contract import request_cases as visual_cases, evidence
from reference.factories import boards, visuals, media_common as c
from reference.factories.visuals_fixture import payload
from reference.inputs import ROOT, canonical, load_manifest, read, sha
from reference.providers import Bedrock, Fixture
from reference.runtime import Runner, model_response_json, report


CONTRACT = (
    'For this final board-author revision, return one complete strict JSON object with no text outside it. '
    'Return {"artifact":<complete native board plan>,"dispositions":[],"note":"..."}. '
    'The object-valued artifact contains the original card_idx and complete route ("board" or "hold"), '
    'rationale, nodes, beats and needs, using the native types and supplied identity and scripts already instructed. '
    'A justified hold with empty nodes and beats remains valid. '
    'Preserve the existing dispositions/note envelope; keep reasoning and explanations inside the allowed JSON fields. '
    'Do not include a preamble, postscript, heading, Markdown fence or file-write receipt. '
    'Review is advisory; this final author revision is authoritative content with no later content-quality review or veto.')


def request_cases():
    for language in ('en', 'hi'):
        for idx in (2, 19, 1007):
            for route in ('board', 'hold'):
                for phase in ('author', 'review', 'final'):
                    role = f'boards_c{idx:03d}_{phase}'
                    declared = {'grade': 4, 'subject': 'SYNTHETIC SUBJECT', 'mode': 'board', 'phase': phase,
                        'card': {'card_idx': idx, 'card_type': 'concept', 'title': 'SYNTHETIC "TITLE"',
                            'lines': [{'display': 'SYNTHETIC \\ DISPLAY', 'audio': 'SYNTHETIC AUDIO'}]},
                        'guideline': {'note': 'DECLARED GUIDELINE ONLY'},
                        'narration': {'blocks': [{'script': 'नमूना \\ "आवाज़"\n' if language == 'hi' else
                                                'SYNTHETIC \\ "AUDIO"\n'}],
                                      'language': language, 'alignment_verified': False}}
                    if phase in ('review', 'final'):
                        declared.update(draft={'card_idx': idx, 'route': route, 'rationale': 'SYNTHETIC REASON',
                                                'nodes': [], 'beats': [], 'needs': []},
                                        render_evidence={'status': 'complete', 'frames': []})
                    if phase == 'final':
                        declared['review'] = {'ok': False, 'findings': ['SYNTHETIC NEGATIVE ADVICE'], 'note': ''}
                    yield f'{language}:{route}:{role}', boards, role, declared
    # T18's exact route/phase matrix includes unchanged Pixi system content.
    for key, factory, role, declared in visual_cases():
        yield 't18:'+key, factory, role, declared


def frame_cases():
    for mode in ('board', 'pixi', 'svg', 'interactive'):
        role = ('boards' if mode == 'board' else 'visuals')+'_c1007_review'
        prompt = 'board_verify' if mode == 'board' else visuals.prompt_for(role, mode)
        yield mode, c.request(None, role, {'mode': mode, 'render_evidence': {'status': 'complete'}},
            [], [], True, prompt, [{'format': 'png', 'data': b'EXACT SYNTHETIC FRAME \x00\xff'}])


def capture():
    rows = {}
    for key, factory, role, declared in request_cases():
        request = factory.request(None, role, declared, [], [], True)
        rows[key] = {'request_sha256': sha(canonical(request)), 'declared_sha256': sha(canonical(declared))}
    module = ast.parse(Path(boards.__file__).read_text())
    module.body = [n for n in module.body if not (isinstance(n, ast.FunctionDef) and n.name == 'request')]
    return {'requests': rows, 'frames': {key: sha(canonical(evidence(req))) for key, req in frame_cases()},
            'outside_request_ast_sha256': sha(ast.dump(module).encode()),
            'reference_sha256': {str(p.relative_to(ROOT)): sha(p.read_bytes())
                                for p in sorted((ROOT/'reference').rglob('*.py'))},
            'prompt_sha256': {str(p.relative_to(ROOT)): sha(p.read_bytes())
                             for p in sorted((ROOT/'prompts').rglob('*')) if p.is_file()},
            'historical_fixtures_sha256': {p.name: sha(p.read_bytes()) for p in sorted((ROOT/'tests/fixtures').glob('*.json'))
                                         if p.name not in ('boards-final-system-baseline.json',
                                                           'translate-teaching-final-system-baseline.json',
                                                           'guideline-refresher-system-baseline.json',
                                                           'explain-splitter-system-baseline.json',
                                                           'translate-teaching-final-nesting-baseline.json',
                                                           'translate-teaching-title-scalar-baseline.json',
                                                            'translate-teaching-line-string-baseline.json')},
            'requirements_sha256': sha((ROOT/'requirements.lock').read_bytes())}


@pytest.mark.parametrize('case', list(request_cases()), ids=lambda case: case[0])
def test_only_boards_final_system_changes_and_original_user_bytes_exact(case):
    key, factory, role, declared = case
    original = deepcopy(declared)
    request = factory.request(None, role, declared, [], [], True)
    assert declared == original and payload(request) == original
    assert len(request['messages']) == len(request['messages'][0]['content']) == 1
    if factory is boards and role.endswith('_final'):
        assert request.pop('system') == [{'text': CONTRACT}]
    baseline = read(ROOT/'tests/fixtures/boards-final-system-baseline.json')
    assert sha(canonical(request)) == baseline['requests'][key]['request_sha256']
    assert sha(canonical(declared)) == baseline['requests'][key]['declared_sha256']


def test_frames_sources_historical_fixtures_and_nonrequest_definitions_unchanged():
    baseline = read(ROOT/'tests/fixtures/boards-final-system-baseline.json')
    current = capture()
    for key in ('frames', 'outside_request_ast_sha256', 'prompt_sha256',
                'historical_fixtures_sha256', 'requirements_sha256'):
        assert current[key] == baseline[key]
    # T21/T22/T23/T24/T25/T26 version Translate/Guideline/Explain request bytes; the T20 fixture stays
    # unchanged, and all other reference files retain their exact assertions.
    before = {**baseline['reference_sha256'], 'reference/factories/translate.py':
              'ad6138e850f73b13673be3d1d5f75c1bc6faa73df1c0a13eb1da465a4360a3b5',
              'reference/factories/guideline.py':
              'fb3c1a3f6b9bdc8de7f9d44ddea70348472a7cfd6347ec67b7645da851e378de',
              'reference/factories/explain.py':
              'ce0a5fdc0d4fe2076d8275c8475a3533cba2ae324782486d3bec4807ebee97c6'}
    assert set(current['reference_sha256']) == set(before)
    changed = 'reference/factories/boards.py'
    assert current['reference_sha256'][changed] != before[changed]
    assert {k: v for k, v in current['reference_sha256'].items() if k != changed} == {
        k: v for k, v in before.items() if k != changed}


def test_fixed_system_has_no_task_data_or_added_user_block(monkeypatch):
    monkeypatch.setenv('PRIVATE_OPERATOR_HISTORY', 'OPERATOR_SENTINEL')
    systems = []
    for _, factory, role, declared in request_cases():
        if factory is not boards or not role.endswith('_final'):
            continue
        request = boards.request(None, role, declared, [], [], True)
        systems.append(request['system'])
        assert len(request['messages'][0]['content']) == 1
        for forbidden in ('SYNTHETIC', 'नमूना', 'AGENTS', 'SKILL', 'OPERATOR_SENTINEL', str(ROOT),
                          'AWS_', 'cap_usd', 'local-board/v', 'schema_version'):
            assert forbidden not in json.dumps(request['system'], ensure_ascii=False)
    assert systems and all(system == [{'text': CONTRACT}] for system in systems)
    # Even with final=True, the wrapper must not affect another role family.
    assert 'system' not in boards.request(None, 'visuals_c002_final', {'mode': 'board'}, [], [], True)


def graph_run(tmp_path, language):
    bundle, blobs = load_manifest(ROOT/'examples/visuals/boards-manifest.json', boards)
    if language == 'hi':
        from reference.factories.translate_inputs import teaching_hash
        card = next(card for card in c.cards(bundle) if card['card_idx'] == 2)
        bundle['declared']['speech'].update(language='hi', voice='Lekha')
        bundle['declared']['translated_deck'] = {'language': 'hi', 'items': [{'source': {
            'card_idx': 7, 'original_card_idx': 2, 'card_type': card['card_type'],
            'source_card_hash': teaching_hash(card)},
            'lines': [{'display': 'नमूना पाठ', 'audio': 'नमूना आवाज़'} for _ in card['lines']]}]}
        bundle['declared']['index_map'] = [{'kind': 'teaching', 'card_idx': 7, 'original_card_idx': 2}]
        bundle['declared']['translated_identity'] = {'source_file_sha256': {
            'deck': bundle['file_identity']['deck']['sha256']}}
        for key in ('speech', 'translated_deck', 'index_map', 'translated_identity'):
            data = canonical(bundle['declared'][key])
            name = f'declared-{key}.json'
            bundle['file_identity'][key] = {'type': 'json', 'sha256': sha(data), 'file': name}
            blobs[name] = data
    tmp_path.mkdir(exist_ok=True)
    return Runner(tmp_path, boards, bundle=bundle, blobs=blobs, config={'provider': 'fixture', 'image_limit': 3})


@pytest.mark.parametrize('language', ('en', 'hi'))
@pytest.mark.parametrize('route', ('board', 'hold'))
def test_converse_graph_final_author_hashes_exports_and_completed_resume(tmp_path, local_stubs, language, route):
    run = graph_run(tmp_path, language)
    calls = []

    class Client:
        def converse(self, **kwargs):
            role = boards.report_roles(tmp_path)[len(calls)]
            calls.append(deepcopy(kwargs))
            request = {'messages': kwargs['messages']}
            assert kwargs['modelId'] == 'synthetic-no-service'
            assert kwargs['inferenceConfig'] == {'maxTokens': 100, 'temperature': .1}
            assert set(kwargs) == {'modelId', 'messages', 'inferenceConfig',
                                   *({'system'} if role.endswith('_final') else set())}
            if role.endswith('_final'):
                assert kwargs['system'] == [{'text': CONTRACT}]
                request['system'] = kwargs['system']
            response = Fixture().invoke(request, role=role, notes_pages=None)
            if role.endswith('_final') and route == 'hold':
                value = json.loads(response['output']['message']['content'][0]['text'])
                value['artifact'].update(route='hold', rationale='SYNTHETIC justified hold', nodes=[], beats=[],
                                         needs=[{'name': 'depiction', 'description': 'SYNTHETIC unmet need'}])
                response['output']['message']['content'][0]['text'] = json.dumps(value)
            return response

    provider = Bedrock({'model': 'synthetic-no-service', 'max_output_tokens': 100})
    provider.client = Client()
    run.provider = provider
    boards.graph(run).invoke({'last_role': 'start'})
    assert len(calls) == len(run.ledger['calls']) == 3
    assert run.exposure() == 0 and not (tmp_path/'ledger.json').exists()
    assert report(tmp_path, boards)['status'] == 'complete'
    for call in run.ledger['calls']:
        request = read(tmp_path/'requests'/f'{call["key"]}.json')
        assert call['request_sha256'] == sha(canonical(request))
        assert call['checkpoint_sha256'] == sha(canonical(read(tmp_path/'checkpoints'/f'{call["key"]}.json')))
        assert call['actual_usd'] == call['reserved_usd'] == 0
        images = [b for b in request['messages'][0]['content'] if 'image' in b]
        assert bool(images) == call['role'].endswith('_review')
        if call['role'].endswith('_final'):
            assert request['system'] == [{'text': CONTRACT}]
            old = deepcopy(request); old.pop('system')
            assert sha(canonical(old)) != call['request_sha256']
            assert payload(request)['review']['ok'] is False
            assert run.output(call['role'])['dispositions'][0]['action'] == 'declined'
            assert read(tmp_path/'artifacts'/f'{call["role"]}.json') == run.output(call['role'])['artifact']
            assert run.output(call['role'])['artifact']['route'] == route
            script = payload(request)['narration']['blocks'][0]['script']
            assert ('नमूना' in script) == (language == 'hi')
    before = {str(p.relative_to(tmp_path)): p.read_bytes() for p in tmp_path.rglob('*') if p.is_file()}
    resumed = Runner(tmp_path, boards, resume=True)
    resumed.provider = provider
    boards.graph(resumed).invoke({'last_role': 'start'})
    assert len(calls) == 3
    assert before == {str(p.relative_to(tmp_path)): p.read_bytes() for p in tmp_path.rglob('*') if p.is_file()}


@pytest.mark.parametrize('frame', ('plain', 'whole', 'eof', 'adjacent'))
@pytest.mark.parametrize('route', ('board', 'hold'))
def test_existing_transport_and_native_final_shapes_remain_accepted(frame, route):
    value = {'artifact': {'card_idx': 1007, 'route': route, 'rationale': 'नमूना "reason"',
                         'nodes': [], 'beats': [], 'needs': []},
             'dispositions': [{'action': 'declined', 'reason': 'advisory'}], 'note': 'unchanged'}
    body = json.dumps(value, ensure_ascii=False)
    text = {'plain': body, 'whole': '```json\n'+body+'\n```',
            'eof': '```json\n'+body, 'adjacent': '```json\n'+body+'```'}[frame]
    native, _ = model_response_json(text)
    assert boards.parse('boards_c1007_final', native) == value


@pytest.mark.parametrize('text', ['To create a comprehensive plan, return JSON.',
    'Procedure first: {"artifact":{}}', '{"artifact":{}}}\n```', '{"artifact":[]}', '{"findings":[]}'])
def test_prose_and_malformed_or_nonobject_artifacts_stay_failed(text):
    with pytest.raises(ValueError):
        native, _ = model_response_json(text)
        boards.parse('boards_c002_final', native)


def test_failed_final_prose_is_raw_unexported_and_not_repeated(tmp_path, local_stubs, monkeypatch):
    original = Fixture.invoke
    text = 'To create a comprehensive plan, follow these steps.'
    def invalid(self, request, *, role, notes_pages):
        if role.endswith('_final'):
            return {'output': {'message': {'content': [{'text': text}]}}, 'stopReason': 'end_turn'}
        return original(self, request, role=role, notes_pages=notes_pages)
    monkeypatch.setattr(Fixture, 'invoke', invalid)
    run = make_run(tmp_path, boards)
    with pytest.raises(ValueError, match='required model stage unavailable'):
        boards.graph(run).invoke({'last_role': 'start'})
    assert run.result('boards_c002_final')['status'] == 'failed'
    assert read(tmp_path/'responses/boards_c002_final.json')['output']['message']['content'][0]['text'] == text
    assert not (tmp_path/'artifacts/boards_c002_final.json').exists()
    ledger = read(run.ledger_path)
    assert len(ledger['calls']) == 3
    with pytest.raises(ValueError, match='required model stage unavailable'):
        boards.graph(Runner(tmp_path, boards, resume=True)).invoke({'last_role': 'start'})
    assert read(run.ledger_path) == ledger
