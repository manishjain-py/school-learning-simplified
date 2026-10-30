"""Numeric-only native timing feedback; accepted compiler output stays exact."""
from copy import deepcopy
import json
import math
import re

import pytest

from test_boards_schedule_contract import narration, plan
from test_visuals_boards import local_stubs, make_run, offline
from reference import media
from reference.factories import boards
from reference.factories.visuals_fixture import payload
from reference.inputs import read, sha
from reference.providers import Fixture
from reference.runtime import Runner, report, technical_feedback


def rejected(value, speech=None):
    before = deepcopy(value)
    with pytest.raises(media.BoardTimingError) as failure:
        media.compile_board(value, speech or narration())
    assert value == before
    assert str(failure.value) == 'Emphasis requires an already completed node'
    return failure.value


@pytest.mark.parametrize('reverse', (False, True))
@pytest.mark.parametrize('phrase,start', (('Draw symbol then emphasize symbol', 0), ('emphasize symbol', 1500)))
def test_same_or_nested_phrase_reports_original_indices_and_actual_end_times(reverse, phrase, start):
    value = plan(draw_phrase='Draw symbol then emphasize symbol', emphasis_phrase=phrase)
    if reverse: value['beats'].reverse()
    error = rejected(value)
    assert error.details == {'beat_index': 0 if reverse else 1, 'target_node_indices': [0],
        'emphasis_start_ms': start,
        'target_draws': [{'node_index': 0, 'beat_index': 1 if reverse else 0, 'end_ms': 2500}],
        'missing_draw_target_node_indices': [], 'latest_target_draw_end_ms': 2500,
        'eligible_word_indices': [5, 6]}


def test_draw_later_in_time_is_reported_without_inventing_an_eligible_anchor():
    value = plan(emphasis_phrase='then')
    value['beats'][0].update(line=1, phrase='Later emphasis')
    error = rejected(value)
    assert error.details['beat_index'] == 1
    assert error.details['emphasis_start_ms'] == 1000
    assert error.details['target_draws'] == [{'node_index': 0, 'beat_index': 0, 'end_ms': 5000}]
    assert error.details['latest_target_draw_end_ms'] == 5000
    assert error.details['eligible_word_indices'] == []


def test_missing_draw_has_explicit_source_node_indices_without_fake_end_time():
    value = plan(); value['beats'].pop(0)
    error = rejected(value)
    assert error.details['beat_index'] == 0
    assert error.details['target_draws'] == []
    assert error.details['missing_draw_target_node_indices'] == [0]
    assert error.details['eligible_word_indices'] == []
    assert 'latest_target_draw_end_ms' not in error.details


def test_duplicate_future_draws_are_reported_without_choosing_a_replacement_schedule():
    value = plan(draw_phrase='Draw symbol then emphasize symbol')
    value['beats'].append({'id': 'duplicate', 'line': 1, 'phrase': 'Later emphasis',
                           'action': 'draw', 'targets': ['mark']})
    error = rejected(value)
    assert error.details['target_draws'] == [
        {'node_index': 0, 'beat_index': 0, 'end_ms': 2500},
        {'node_index': 0, 'beat_index': 2, 'end_ms': 5000}]
    assert error.details['missing_draw_target_node_indices'] == []
    assert error.details['eligible_word_indices'] == []
    assert 'latest_target_draw_end_ms' not in error.details


def test_all_targets_contribute_to_latest_draw_end_and_original_node_positions():
    value = plan(draw_phrase='Draw', emphasis_phrase='emphasize symbol')
    value['nodes'].insert(0, {'id': 'unused', 'type': 'text', 'x': 20, 'y': 200, 'font_size': 20, 'text': ''})
    value['nodes'].append({'id': 'later-mark', 'type': 'rect', 'x': 200, 'y': 20, 'width': 100, 'height': 60})
    value['beats'].insert(1, {'id': 'later-draw', 'line': 0, 'phrase': 'Draw symbol then emphasize symbol',
                             'action': 'draw', 'targets': ['later-mark']})
    value['beats'][2]['targets'] = ['mark', 'later-mark']
    error = rejected(value)
    assert error.details['target_node_indices'] == [1, 2]
    assert error.details['target_draws'] == [
        {'node_index': 1, 'beat_index': 0, 'end_ms': 500},
        {'node_index': 2, 'beat_index': 1, 'end_ms': 2500}]
    assert error.details['latest_target_draw_end_ms'] == 2500
    assert error.details['eligible_word_indices'] == [5, 6]


def test_eligible_word_indices_include_exact_boundary_and_are_capped_at_eight():
    value = plan(emphasis_phrase='Draw')
    error = rejected(value)
    assert error.details['latest_target_draw_end_ms'] == 1000
    assert error.details['eligible_word_indices'][0] == 2
    speech = narration()
    speech['blocks'][1]['script'] = 'Later '+' '.join(f'word{i}' for i in range(12))
    speech['words'] = speech['words'][:5]
    for index, match in enumerate(re.finditer(r'\S+', speech['blocks'][1]['script'])):
        speech['words'].append({'block': 1, 'text': match.group(), 'char_start': match.start(),
                                'char_end': match.end(), 'start_ms': 4000+index*500,
                                'end_ms': 4500+index*500, 'timing_basis': 'estimated uniform word interpolation',
                                'alignment_verified': False})
    speech['blocks'][1]['end_ms'] = speech['audio']['duration_ms'] = 10500
    error = rejected(plan(draw_phrase='Draw symbol then emphasize symbol'), speech)
    assert error.details['eligible_word_indices'] == list(range(5, 13))


def test_details_contain_only_numeric_positions_and_no_authored_strings():
    value = plan(draw_phrase='Draw symbol then emphasize symbol')
    value['nodes'][0]['id'] = 'PRIVATE_NODE_SENTINEL'
    for index, beat in enumerate(value['beats']):
        beat['id'] = f'/Users/private/PRIVATE_BEAT_{index}'
        beat['targets'] = ['PRIVATE_NODE_SENTINEL']
    error = rejected(value)
    def numeric_leaves(value):
        if isinstance(value, dict):
            return all(numeric_leaves(item) for item in value.values())
        if isinstance(value, list): return all(numeric_leaves(item) for item in value)
        return type(value) in (int, float) and math.isfinite(value) and value >= 0
    assert numeric_leaves(error.details)
    encoded = json.dumps(error.details)
    assert all(secret not in encoded for secret in ('PRIVATE', '/Users/', 'Draw symbol', 'emphasize symbol'))
    declared = {'card': {'card_idx': 2}, 'narration': narration()}
    with pytest.raises(ValueError) as native:
        boards.parse_declared('boards_c002_author', json.dumps({'artifact': value}), declared)
    feedback = technical_feedback(native.value, 'native')
    assert feedback['details'] == error.details
    assert 'PRIVATE' not in json.dumps(feedback) and '/Users/' not in json.dumps(feedback)


# Actual serialized scene-byte hashes captured read-only from compile_board at
# 77e861423fe97e7dbd18f7bfc132be97229e7eed, using these synthetic inputs only.
@pytest.mark.parametrize('case,digest', [
    ('ordered', 'e057ac461a797769fe39bbb0ca9467dae23391a78e8ca9624aee03ae9cc62b65'),
    ('reversed', 'e057ac461a797769fe39bbb0ca9467dae23391a78e8ca9624aee03ae9cc62b65'),
    ('boundary', '424a510d4252947befcc971715dbebe8e252615a6159564e0888c3e22c41d884'),
    ('later_block', '731d3894aaf84c792db504a3d37e1888f431415e1c552e76693b50e25a91fcef'),
    ('undrawn', '747d85f56fbf878e93d80405f76c65e8bf9f2897e9bf0fa64f9e30fe8d0d5116'),
    ('hold', 'bd125a8dcf2d1d4780da88b7070296d4e2c3e092e463c1a479ff1072c4face74')])
def test_valid_scene_bytes_remain_exactly_equal_to_77e8614(case, digest):
    value = plan()
    if case == 'reversed': value['beats'].reverse()
    elif case == 'boundary': value['beats'][1]['phrase'] = 'then'
    elif case == 'later_block': value['beats'][1].update(line=1, phrase='Later emphasis')
    elif case == 'undrawn': value['nodes'].append({'id': 'unused', 'type': 'text', 'x': 20, 'y': 200, 'font_size': 20, 'text': ''})
    elif case == 'hold': value = {'card_idx': 2, 'route': 'hold', 'rationale': 'Synthetic author hold', 'nodes': [], 'beats': [], 'needs': []}
    before = deepcopy(value)
    scene = media.compile_board(value, narration())
    assert sha((json.dumps(scene, ensure_ascii=False, indent=2, allow_nan=False)+'\n').encode()) == digest
    assert value == before


@pytest.mark.parametrize('phase', ('author', 'final'))
def test_same_author_receives_numeric_feedback_and_returns_own_valid_plan(
        tmp_path, local_stubs, monkeypatch, phase):
    original = Fixture.invoke
    target = 'boards_c002_'+phase
    calls, responses = [], []
    def provider(self, request, *, role, notes_pages):
        calls.append((role, deepcopy(request)))
        response = original(self, request, role=role, notes_pages=notes_pages)
        response['usage'] = {'inputTokens': 100, 'outputTokens': 20}
        if role == target:
            value = json.loads(response['output']['message']['content'][0]['text'])
            plan_value = value['artifact']
            renamed = {node['id']: f'PRIVATE_NODE_{index}' for index, node in enumerate(plan_value['nodes'])}
            for node in plan_value['nodes']: node['id'] = renamed[node['id']]
            for index, beat in enumerate(plan_value['beats']):
                beat['id'] = f'PRIVATE_BEAT_{index}'
                beat['targets'] = [renamed[node] for node in beat['targets']]
            count = sum(called_role == target for called_role, _ in calls)
            if count == 1:
                plan_value['beats'][2]['phrase'] = plan_value['beats'][0]['phrase']
            else:
                # The inert synthetic author, not production host code, chooses
                # a valid supplied anchor from its delivered numeric feedback.
                feedback = json.loads(request['system'][-1]['text'].split('\n')[-1])['technical_feedback']
                details = feedback['details']
                task = payload(request)
                word = task['narration']['words'][details['eligible_word_indices'][0]]
                assert word['start_ms'] >= details['latest_target_draw_end_ms']
                beat = plan_value['beats'][details['beat_index']]
                script = task['narration']['blocks'][word['block']]['script']
                positions = [match.start() for match in re.finditer(re.escape(word['text']), script)]
                beat.update(line=word['block'], phrase=word['text'], occurrence=positions.index(word['char_start'])+1)
            value['note'] = 'PRIVATE_NOTE /Users/private/source'
            response['output']['message']['content'][0]['text'] = json.dumps(value)
            responses.append(deepcopy(response))
        return response
    monkeypatch.setattr(Fixture, 'invoke', provider)
    run = make_run(tmp_path, boards)
    boards.graph(run).invoke({'last_role': 'start'})
    assert report(tmp_path, boards)['status'] == 'complete' and len(calls) == 4
    target_calls = [request for role, request in calls if role == target]
    correction = target_calls[1]['system'][-1]['text']
    assert all(secret not in correction for secret in ('PRIVATE_NODE', 'PRIVATE_BEAT', 'PRIVATE_NOTE', '/Users/'))
    assert all(label in correction for label in ('artifact.beats', 'artifact.nodes', 'task_inputs.narration.words'))
    assert target_calls[1]['system'][:-1] == target_calls[0].get('system', [])
    assert target_calls[1]['messages'][0]['content'][:-1] == target_calls[0]['messages'][0]['content']
    prior = json.loads(target_calls[1]['messages'][0]['content'][-1]['text'].split('\n')[-1])
    assert prior['previous_response_text'] == responses[0]['output']['message']['content'][0]['text']
    for attempt, response in enumerate(responses, 1):
        assert read(tmp_path/'attempts'/target/f'{attempt:03d}'/'response.json') == response
    accepted = json.loads(responses[1]['output']['message']['content'][0]['text'])
    assert run.output(target) == accepted
    assert read(tmp_path/'artifacts'/f'{target}.json') == accepted['artifact']
    before = {str(path.relative_to(tmp_path)): path.read_bytes() for path in tmp_path.rglob('*') if path.is_file()}
    boards.graph(Runner(tmp_path, boards, resume=True)).invoke({'last_role': 'start'})
    assert len(calls) == 4 and run.exposure() == 0
    assert before == {str(path.relative_to(tmp_path)): path.read_bytes() for path in tmp_path.rglob('*') if path.is_file()}
