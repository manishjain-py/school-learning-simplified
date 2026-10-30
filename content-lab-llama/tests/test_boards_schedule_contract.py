"""Synthetic phrase timing/dependency semantics; no audio tools or model calls."""
from copy import deepcopy
import json
from pathlib import Path
import re
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from reference import media
from reference.factories import boards, media_common
from reference.factories.translate_inputs import teaching_hash
from reference.factories.visuals_fixture import payload
from reference.inputs import ROOT, canonical, load_manifest, read, sha
from reference.providers import Fixture
from reference.runtime import NativeContractError, Runner, report
from test_visuals_boards import local_stubs, make_run, offline


def narration():
    scripts = ['Draw symbol then emphasize symbol', 'Later emphasis']
    blocks, words = [], []
    for index, script in enumerate(scripts):
        start = index*4000
        matches = list(re.finditer(r'\S+', script))
        blocks.append({'index': index, 'script': script, 'start_ms': start,
                       'end_ms': start+len(matches)*500})
        words.extend({'block': index, 'text': match.group(), 'char_start': match.start(),
                      'char_end': match.end(), 'start_ms': start+j*500, 'end_ms': start+(j+1)*500,
                      'timing_basis': 'estimated uniform word interpolation', 'alignment_verified': False}
                     for j, match in enumerate(matches))
    return {'blocks': blocks, 'words': words, 'audio': {'duration_ms': 5000},
            'word_timing': 'estimated', 'alignment_verified': False}


def plan(draw_phrase='Draw symbol', emphasis_phrase='emphasize symbol', emphasis_line=0):
    return {'card_idx': 2, 'route': 'board', 'rationale': 'Synthetic dependency exercise', 'needs': [],
            'nodes': [{'id': 'mark', 'type': 'rect', 'x': 20, 'y': 20, 'width': 100, 'height': 60}],
            'beats': [{'id': 'draw', 'line': 0, 'phrase': draw_phrase, 'action': 'draw', 'targets': ['mark']},
                      {'id': 'emphasis', 'line': emphasis_line, 'phrase': emphasis_phrase,
                       'action': 'emphasize', 'targets': ['mark']}]}


@pytest.mark.parametrize('reverse_array', (False, True))
@pytest.mark.parametrize('emphasis_phrase', ('Draw symbol then emphasize symbol', 'emphasize symbol'))
def test_identical_or_nested_phrase_emphasis_during_drawing_is_invalid(emphasis_phrase, reverse_array):
    value = plan(draw_phrase='Draw symbol then emphasize symbol', emphasis_phrase=emphasis_phrase)
    if reverse_array:
        value['beats'].reverse()
    before = deepcopy(value)
    with pytest.raises(media.MediaError, match='Emphasis requires an already completed node'):
        media.compile_board(value, narration())
    assert value == before


def test_array_position_cannot_move_emphasis_after_its_exact_phrase_time():
    value = plan(draw_phrase='Draw symbol then emphasize symbol', emphasis_phrase='Draw symbol then emphasize symbol')
    value['nodes'].append({'id': 'later', 'type': 'text', 'x': 20, 'y': 200,
                           'font_size': 20, 'text': 'SYNTHETIC'})
    value['beats'].insert(1, {'id': 'later', 'line': 1, 'phrase': 'Later emphasis',
                              'action': 'draw', 'targets': ['later']})
    assert value['beats'][-1]['action'] == 'emphasize'
    with pytest.raises(media.MediaError, match='Emphasis requires an already completed node'):
        media.compile_board(value, narration())


@pytest.mark.parametrize('emphasis_phrase,emphasis_line,expected_start',
                         (('then', 0, 1000), ('emphasize symbol', 0, 1500), ('Later emphasis', 1, 4000)))
def test_completed_node_emphasis_preserves_exact_authored_plan_and_phrase_timing(
        emphasis_phrase, emphasis_line, expected_start):
    value = plan(emphasis_phrase=emphasis_phrase, emphasis_line=emphasis_line)
    value['beats'].reverse()  # Author array order does not change spoken timing.
    before = deepcopy(value)
    scene = media.compile_board(value, narration())
    assert value == before
    assert scene['nodes'] == before['nodes']
    assert [cue['action'] for cue in scene['cues']] == ['draw', 'emphasize']
    assert scene['cues'][0]['start_ms'] == 0
    assert scene['cues'][0]['end_ms'] == 1000
    assert scene['cues'][1]['start_ms'] == expected_start
    assert scene['cues'][1]['phrase'] == emphasis_phrase
    assert scene['cues'][1]['targets'] == ['mark']
    assert scene['timing']['alignment_verified'] is False


def test_hold_duration_does_not_complete_a_node_before_its_draw_phrase_ends():
    value = plan(draw_phrase='Draw symbol then emphasize symbol')
    value['beats'][0]['hold_ms'] = 60000
    with pytest.raises(media.MediaError, match='Emphasis requires an already completed node'):
        media.compile_board(value, narration())


def test_undrawn_node_is_an_operational_observation_without_content_veto():
    value = plan()
    value['nodes'].append({'id': 'unreferenced', 'type': 'text', 'x': 20, 'y': 200,
                           'font_size': 20, 'text': ''})
    scene = media.compile_board(value, narration())
    assert scene['nodes'] == value['nodes']
    assert scene['diagnostics'] == [{'kind': 'undrawn_nodes', 'targets': ['unreferenced']}]


@pytest.mark.parametrize('phase', ('author', 'final'))
def test_native_preflight_preserves_exact_author_envelope_and_rejects_invalid_schedule(phase, monkeypatch):
    def forbidden(*args, **kwargs):
        raise AssertionError('Native preflight cannot run media tools')
    monkeypatch.setattr(media, '_tool', forbidden)
    role = 'boards_c002_'+phase
    declared = {'card': {'card_idx': 2}, 'narration': narration()}
    value = {'artifact': plan(), 'dispositions': [{'action': 'declined', 'reason': 'Author decision'}],
             'note': '  Preserve final author wording  ', 'extra_author_metadata': {'untouched': True}}
    before = deepcopy(value)
    assert boards.parse_declared(role, json.dumps(value), declared) == before
    assert value == before
    value['artifact'] = plan(draw_phrase='Draw symbol then emphasize symbol')
    with pytest.raises(NativeContractError) as rejected:
        boards.parse_declared(role, json.dumps(value), declared)
    assert rejected.value.constraint == 'board_emphasis_after_draw'


@pytest.mark.parametrize('phase', ('author', 'final'))
def test_native_hold_and_negative_review_do_not_add_quality_requirements(phase):
    value = {'artifact': {'card_idx': 2, 'route': 'hold', 'rationale': 'Author limitation',
                          'nodes': [], 'beats': [], 'needs': []}, 'note': 'Exact author hold'}
    assert boards.parse_declared('boards_c002_'+phase, json.dumps(value),
                                  {'card': {'card_idx': 2}, 'narration': narration()}) == value
    review = {'ok': False, 'findings': ['Advisory concern remains'], 'note': ''}
    assert boards.parse_declared('boards_c002_review', json.dumps(review), {}) == review


@pytest.mark.parametrize('defect', ('wrong_card', 'unknown_target', 'missing_phrase', 'invalid_geometry'))
def test_other_native_execution_failures_are_fixed_value_errors_without_private_text(defect):
    value = {'artifact': plan(), 'note': 'PRIVATE_OUTPUT_SENTINEL'}
    if defect == 'wrong_card':
        value['artifact']['card_idx'] = 999
    elif defect == 'unknown_target':
        value['artifact']['beats'][0]['targets'] = ['PRIVATE_TARGET_SENTINEL']
    elif defect == 'missing_phrase':
        value['artifact']['beats'][0]['phrase'] = 'PRIVATE_MISSING_PHRASE_SENTINEL'
    else:
        value['artifact']['nodes'][0]['width'] = -10
    with pytest.raises(ValueError) as rejected:
        boards.parse_declared('boards_c002_final', json.dumps(value),
                              {'card': {'card_idx': 2}, 'narration': narration()})
    assert type(rejected.value) is ValueError
    assert 'PRIVATE_' not in str(rejected.value)


@pytest.mark.parametrize('phase', ('author', 'final'))
@pytest.mark.parametrize('failures', (1, 2, 3))
def test_invalid_schedule_gets_bounded_same_author_correction_or_frozen_failure(
        tmp_path, local_stubs, monkeypatch, phase, failures):
    original_provider = Fixture.invoke
    original_render = boards.media.render_board
    target = 'boards_c002_'+phase
    calls, raw_responses, rendered = [], [], []

    def provider(self, request, *, role, notes_pages):
        calls.append((role, deepcopy(request)))
        response = original_provider(self, request, role=role, notes_pages=notes_pages)
        response['usage'] = {'inputTokens': 100, 'outputTokens': 20}
        if role == target:
            value = json.loads(response['output']['message']['content'][0]['text'])
            number = sum(called_role == target for called_role, _ in calls)
            if number <= failures:
                # Identical resolved draw/emphasis intervals are not executable,
                # irrespective of the author's beat-array ordering.
                value['artifact']['beats'][2]['phrase'] = value['artifact']['beats'][0]['phrase']
            value['note'] = 'PRIVATE_OUTPUT_SENTINEL /Users/private/source-path'
            response['output']['message']['content'][0]['text'] = json.dumps(value)
            raw_responses.append(deepcopy(response))
        return response

    def render(value, *args, **kwargs):
        rendered.append(deepcopy(value))
        return original_render(value, *args, **kwargs)

    monkeypatch.setattr(Fixture, 'invoke', provider)
    monkeypatch.setattr(boards.media, 'render_board', render)
    run = make_run(tmp_path, boards)
    if failures < 3:
        boards.graph(run).invoke({'last_role': 'start'})
        assert report(tmp_path, boards)['status'] == 'complete'
        accepted = json.loads(raw_responses[-1]['output']['message']['content'][0]['text'])
        assert run.output(target) == accepted
        assert read(tmp_path/'artifacts'/f'{target}.json') == accepted['artifact']
        assert accepted['artifact'] in rendered
        assert len(rendered) == 2
        assert len(calls) == 3+failures
    else:
        with pytest.raises(ValueError, match='required model stage unavailable'):
            boards.graph(run).invoke({'last_role': 'start'})
        assert run.result(target)['status'] == 'failed'
        assert not (tmp_path/'artifacts'/f'{target}.json').exists()
        assert len(rendered) == (0 if phase == 'author' else 1)
        assert len(calls) == (3 if phase == 'author' else 5)
    target_calls = [request for role, request in calls if role == target]
    assert len(target_calls) == min(failures+1, 3)
    for index, response in enumerate(raw_responses, 1):
        directory = tmp_path/'attempts'/target/f'{index:03d}'
        assert read(directory/'response.json') == response
        checkpoint = read(directory/'checkpoint.json')
        if index <= failures:
            assert checkpoint['status'] == 'failed' and 'output' not in checkpoint
            assert checkpoint['technical_feedback']['constraint'] == 'board_emphasis_after_draw'
        else:
            assert checkpoint['status'] == 'ok'
        request = target_calls[index-1]
        if index > 1:
            assert request['system'][:-1] == target_calls[0].get('system', [])
            assert request['messages'][0]['content'][:-1] == target_calls[0]['messages'][0]['content']
            correction = request['system'][-1]['text']
            assert 'board_emphasis_after_draw' in correction
            assert 'draw end_ms must be <= the emphasis start_ms' in correction
            assert 'Beat array order does not change' in correction
            assert 'PRIVATE_OUTPUT_SENTINEL' not in correction and 'draw-box' not in correction
            prior_data = request['messages'][0]['content'][-1]['text']
            assert json.loads(prior_data.split('\n')[-1])['previous_response_text'] == (
                raw_responses[index-2]['output']['message']['content'][0]['text'])
    assert run.exposure() == 0
    before = {path.relative_to(tmp_path): path.read_bytes() for path in tmp_path.rglob('*') if path.is_file()}
    resumed = Runner(tmp_path, boards, resume=True)
    if failures < 3:
        boards.graph(resumed).invoke({'last_role': 'start'})
    else:
        with pytest.raises(ValueError, match='required model stage unavailable'):
            boards.graph(resumed).invoke({'last_role': 'start'})
    assert len(calls) == len(run.ledger['calls'])
    assert before == {path.relative_to(tmp_path): path.read_bytes() for path in tmp_path.rglob('*') if path.is_file()}


@pytest.mark.parametrize('route', ('board', 'hold'))
def test_hindi_native_graph_corrects_same_author_anchors_and_preserves_final_route(
        tmp_path, local_stubs, monkeypatch, route):
    bundle, blobs = load_manifest(ROOT/'examples/visuals/boards-manifest.json', boards)
    card = next(card for card in media_common.cards(bundle) if card['card_idx'] == 2)
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
    original = Fixture.invoke
    calls, final_values = [], []

    def provider(self, request, *, role, notes_pages):
        calls.append(role)
        response = original(self, request, role=role, notes_pages=notes_pages)
        response['usage'] = {'inputTokens': 100, 'outputTokens': 20}
        if not role.endswith('_review'):
            value = json.loads(response['output']['message']['content'][0]['text'])
            first_word, later_word = payload(request)['narration']['blocks'][0]['script'].split()
            assert (first_word, later_word) == ('नमूना', 'आवाज़')
            value['artifact']['beats'] = [
                {'id': 'draw-both', 'line': 0, 'phrase': first_word, 'action': 'draw',
                 'targets': ['box', 'label']},
                {'id': 'focus-box', 'line': 0, 'phrase': later_word, 'action': 'emphasize',
                 'targets': ['box']}]
            if role.endswith('_author') and calls.count(role) == 1:
                value['artifact']['beats'][1]['phrase'] = first_word
            if role.endswith('_final'):
                assert payload(request)['review']['ok'] is False
                if route == 'hold':
                    value['artifact'].update(route='hold', rationale='Synthetic author limitation',
                                             nodes=[], beats=[], needs=[])
                final_values.append(deepcopy(value))
            response['output']['message']['content'][0]['text'] = json.dumps(value, ensure_ascii=False)
        return response

    monkeypatch.setattr(Fixture, 'invoke', provider)
    run = Runner(tmp_path, boards, bundle=bundle, blobs=blobs,
                 config={'provider': 'fixture', 'image_limit': 3})
    boards.graph(run).invoke({'last_role': 'start'})
    assert calls == ['boards_c002_author', 'boards_c002_author', 'boards_c002_review', 'boards_c002_final']
    assert report(tmp_path, boards)['status'] == 'complete'
    assert run.output('boards_c002_final') == final_values[0]
    assert final_values[0]['artifact']['route'] == route
    assert read(tmp_path/'artifacts/boards_c002_final.json') == final_values[0]['artifact']
    failed = read(tmp_path/'attempts/boards_c002_author/001/checkpoint.json')
    assert failed['technical_feedback']['constraint'] == 'board_emphasis_after_draw'
    before = {path.relative_to(tmp_path): path.read_bytes() for path in tmp_path.rglob('*') if path.is_file()}
    boards.graph(Runner(tmp_path, boards, resume=True)).invoke({'last_role': 'start'})
    assert len(calls) == 4 and run.exposure() == 0
    assert before == {path.relative_to(tmp_path): path.read_bytes() for path in tmp_path.rglob('*') if path.is_file()}
