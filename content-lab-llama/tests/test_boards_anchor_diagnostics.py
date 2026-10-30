"""Exact narration anchors get bounded, numeric-only same-author diagnostics."""
from copy import deepcopy
import json
import math
import re

import pytest

from test_visuals_boards import local_stubs, make_run, offline
from reference import media, runtime
from reference.factories import boards, media_common as c
from reference.inputs import canonical, read, sha
from reference.providers import Fixture


def speech():
    scripts = ['पहला चित्र बनता है।', 'अब कोशिका साफ दिखती है। कोशिका फिर दिखती है।']
    blocks, words = [], []
    for block_index, script in enumerate(scripts):
        matches = list(re.finditer(r'\S+', script))
        start = block_index*10000
        blocks.append({'index': block_index, 'script': script, 'start_ms': start,
                       'end_ms': start+len(matches)*100})
        words.extend({'block': block_index, 'text': match.group(), 'char_start': match.start(),
                      'char_end': match.end(), 'start_ms': start+index*100,
                      'end_ms': start+(index+1)*100,
                      'timing_basis': 'estimated uniform word interpolation',
                      'alignment_verified': False} for index, match in enumerate(matches))
    return {'blocks': blocks, 'words': words, 'audio': {'duration_ms': blocks[-1]['end_ms']},
            'word_timing': 'estimated', 'alignment_verified': False}


def plan():
    return {'card_idx': 2, 'route': 'board', 'rationale': '  लेखक का अपरिवर्तित कारण  ', 'needs': [],
            'nodes': [{'id': f'node_{index}', 'type': 'rect', 'x': 20+index*100, 'y': 20,
                       'width': 80, 'height': 60} for index in range(4)],
            'beats': [{'id': f'beat_{index}', 'line': 0 if index < 3 else 1,
                       'phrase': phrase, 'action': 'draw' if index < 4 else 'emphasize',
                       'targets': [f'node_{index if index < 4 else 3}']}
                      for index, phrase in enumerate(('पहला', 'चित्र', 'बनता', 'कोशिका साफ', 'फिर'))]}


def rejected(value):
    before = deepcopy(value)
    with pytest.raises(media.BoardAnchorError) as failure:
        media.compile_board(value, speech())
    assert value == before
    assert str(failure.value) == 'Exact phrase requires a valid narration occurrence'
    return failure.value


def details(**changes):
    return {'beat_index': 3, 'narration_block_index': 1, 'exact_match_count': 1,
            'requested_occurrence_type': 1, 'requested_occurrence': 2, **changes}


@pytest.mark.parametrize('phrase', ('कोशीका साफ', 'कोशिका  साफ', 'कोशिका\u200b साफ', 'कोशिका साफ!'))
def test_hindi_literal_typo_spacing_and_punctuation_do_not_get_repaired(phrase):
    value = plan()
    value['beats'][3]['phrase'] = phrase
    error = rejected(value)
    assert error.details == {'beat_index': 3, 'narration_block_index': 1,
                             'exact_match_count': 0, 'requested_occurrence_type': 0}
    assert phrase not in json.dumps(error.details, ensure_ascii=False)


@pytest.mark.parametrize('occurrence', (None, 0, -1, 2, True, False, 1.0, 2.5,
                                      float('nan'), float('inf'), 'PRIVATE /Users/source',
                                      ['PRIVATE'], {'PRIVATE': '/Users/source'}, 10**100))
def test_missing_phrase_reports_count_and_safe_requested_occurrence(occurrence):
    value = plan()
    value['beats'][3].update(phrase='कोशीका साफ', occurrence=occurrence)
    error = rejected(value)
    expected_kind = (0 if occurrence is None else
                     1 if type(occurrence) is int and abs(occurrence) <= 10**12 else 2)
    expected = {'beat_index': 3, 'narration_block_index': 1, 'exact_match_count': 0,
                'requested_occurrence_type': expected_kind}
    if expected_kind == 1: expected['requested_occurrence'] = occurrence
    assert error.details == expected
    feedback = runtime.technical_feedback(runtime.NativeContractError(
        'board_exact_phrase_occurrence', details=error.details), 'native')
    assert feedback['details'] == expected
    assert all(secret not in json.dumps(feedback, ensure_ascii=False)
               for secret in ('PRIVATE', '/Users/', 'कोशीका'))
    assert all(type(item) is int and math.isfinite(item) for item in expected.values())


@pytest.mark.parametrize('occurrence', (0, -1, 2, True, False, 1.0, '1', [], {}, 10**100))
def test_one_exact_match_rejects_out_of_range_or_noninteger_occurrence(occurrence):
    value = plan(); value['beats'][3]['occurrence'] = occurrence
    error = rejected(value)
    assert error.details['beat_index'] == 3 and error.details['exact_match_count'] == 1
    assert error.details['requested_occurrence_type'] == (
        1 if type(occurrence) is int and abs(occurrence) <= 10**12 else 2)


def test_diagnostics_preserve_each_original_beat_index_without_counting_beats_as_occurrences():
    value = plan()
    for index in (3, 4): value['beats'][index]['occurrence'] = 2
    assert rejected(value).details == details()
    value['beats'][3]['occurrence'] = 1
    assert rejected(value).details == details(beat_index=4)


@pytest.mark.parametrize('occurrence', (None, 0, 3))
def test_repeated_phrase_counts_matches_in_selected_script(occurrence):
    value = plan(); value['beats'][3].update(phrase='कोशिका', occurrence=occurrence)
    assert rejected(value).details['exact_match_count'] == 2
    # The same phrase in another block does not contribute to this block's count.
    value['beats'][3].update(line=0, occurrence=1)
    assert rejected(value).details['exact_match_count'] == 0


@pytest.mark.parametrize('occurrence,start', ((1, 10100), (2, 10500)))
def test_repeated_phrase_selects_exact_existing_occurrence(occurrence, start):
    value = plan(); value['beats'][3].update(phrase='कोशिका', occurrence=occurrence)
    before = deepcopy(value)
    assert media.compile_board(value, speech())['cues'][3]['start_ms'] == start
    assert value == before


@pytest.mark.parametrize('occurrence', ('omitted', None, 1))
def test_unique_phrase_default_and_explicit_one_keep_identical_scene_bytes(occurrence):
    value = plan()
    baseline = canonical(media.compile_board(value, speech()))
    if occurrence != 'omitted': value['beats'][3]['occurrence'] = occurrence
    assert canonical(media.compile_board(value, speech())) == baseline


def test_multiple_beats_may_reference_same_occurrence_without_reserving_it():
    value = plan()
    value['beats'][1].update(line=0, phrase='पहला', occurrence=1)
    scene = media.compile_board(value, speech())
    assert [cue['start_ms'] for cue in scene['cues'][:2]] == [0, 0]
    assert [cue['occurrence'] for cue in scene['cues'][:2]] == [1, 1]


@pytest.mark.parametrize('phase', ('author', 'final'))
def test_native_preflight_emits_only_allowlisted_anchor_feedback(phase):
    value = {'artifact': plan(), 'note': 'PRIVATE_NOTE /Users/source', 'dispositions': []}
    value['artifact']['beats'][3].update(id='PRIVATE_BEAT /Users/source', occurrence=2)
    value['artifact']['nodes'][0]['id'] = 'PRIVATE_NODE'
    value['artifact']['beats'][0]['targets'] = ['PRIVATE_NODE']
    with pytest.raises(runtime.NativeContractError) as failure:
        boards.parse_declared('boards_c002_'+phase, json.dumps(value),
                              {'card': {'card_idx': 2}, 'narration': speech()})
    assert failure.value.constraint == 'board_exact_phrase_occurrence'
    failure.value.args = ('PRIVATE_EXCEPTION /Users/source',)
    feedback = runtime.technical_feedback(failure.value, 'native')
    assert feedback['details'] == details()
    request = {'system': [{'text': 'ORIGINAL'}], 'messages': [{'role': 'user', 'content': [{'text': 'TASK'}]}]}
    retry = runtime.recovery_request(request, json.dumps(value), feedback)
    system = retry['system'][-1]['text']
    for forbidden in ('PRIVATE', '/Users/', 'कोशिका साफ'):
        assert forbidden not in system
    for required in ('not beat order', 'Multiple beats', 'If exact_match_count is 1',
                     'If it is 0', 'artifact.beats', 'task_inputs.narration.blocks',
                     'exact narration phrase/occurrence anchor constraint'):
        assert required in system
    assert retry['system'][:-1] == request['system']
    assert retry['messages'][0]['content'][:-1] == request['messages'][0]['content']
    assert json.loads(retry['messages'][0]['content'][-1]['text'].split('\n')[-1]) == {
        'previous_response_text': json.dumps(value)}


@pytest.mark.parametrize('defect', ('text', 'missing', 'boolean_index', 'float_index', 'nan_count',
    'infinite_count', 'negative_count', 'float_count', 'boolean_count', 'big_count', 'invalid_kind',
    'boolean_kind', 'float_kind', 'missing_value', 'string_value', 'boolean_value', 'float_value',
    'oversized_value', 'nan_value', 'value_for_omitted', 'value_for_invalid', 'valid_integer',
    'valid_default'))
def test_anchor_diagnostic_schema_rejects_text_malformed_types_and_contradictions(defect):
    value = details()
    if defect == 'text': value['phrase'] = 'PRIVATE'
    elif defect == 'missing': value.pop('narration_block_index')
    elif defect == 'boolean_index': value['beat_index'] = True
    elif defect == 'float_index': value['narration_block_index'] = 1.0
    elif defect == 'nan_count': value['exact_match_count'] = float('nan')
    elif defect == 'infinite_count': value['exact_match_count'] = float('inf')
    elif defect == 'negative_count': value['exact_match_count'] = -1
    elif defect == 'float_count': value['exact_match_count'] = 1.0
    elif defect == 'boolean_count': value['exact_match_count'] = True
    elif defect == 'big_count': value['exact_match_count'] = 10**100
    elif defect == 'invalid_kind': value['requested_occurrence_type'] = 3
    elif defect == 'boolean_kind': value['requested_occurrence_type'] = True
    elif defect == 'float_kind': value['requested_occurrence_type'] = 1.0
    elif defect == 'missing_value': value.pop('requested_occurrence')
    elif defect == 'string_value': value['requested_occurrence'] = 'PRIVATE'
    elif defect == 'boolean_value': value['requested_occurrence'] = True
    elif defect == 'float_value': value['requested_occurrence'] = 2.0
    elif defect == 'oversized_value': value['requested_occurrence'] = 10**100
    elif defect == 'nan_value': value['requested_occurrence'] = float('nan')
    elif defect == 'value_for_omitted': value['requested_occurrence_type'] = 0
    elif defect == 'value_for_invalid': value['requested_occurrence_type'] = 2
    elif defect == 'valid_integer': value['requested_occurrence'] = 1
    else:
        value['requested_occurrence_type'] = 0; value.pop('requested_occurrence')
    with pytest.raises(ValueError, match='Invalid native execution diagnostic'):
        runtime.NativeContractError('board_exact_phrase_occurrence', details=value)


def test_diagnostic_copy_and_second_validation_prevent_mutable_text_injection():
    value = details()
    error = runtime.NativeContractError('board_exact_phrase_occurrence', details=value)
    value['beat_index'] = 'PRIVATE'
    assert runtime.technical_feedback(error, 'native')['details'] == details()
    error.details['beat_index'] = 'PRIVATE'
    with pytest.raises(ValueError, match='Invalid native execution diagnostic'):
        runtime.technical_feedback(error, 'native')


@pytest.mark.parametrize('index,value', ((0, True), (1, 'PRIVATE'), (2, float('nan')), (2, -1)))
def test_board_anchor_error_never_retains_non_numeric_source_indices(index, value):
    args = [3, 1, 1, 2]; args[index] = value
    with pytest.raises(ValueError, match='Invalid board anchor diagnostic'):
        media.BoardAnchorError(*args)


@pytest.mark.parametrize('phase', ('author', 'final'))
@pytest.mark.parametrize('failures', (1, 2, 3))
def test_runner_anchor_recovery_is_bounded_raw_preserved_and_resume_unchanged(
        tmp_path, local_stubs, monkeypatch, phase, failures):
    role = 'boards_c002_'+phase
    declared = {'card': {'card_idx': 2}, 'narration': boards.timing_view(speech()), 'mode': 'board'}
    accepted = {'artifact': plan(), 'dispositions': [{'action': 'declined', 'reason': ' लेखक का निर्णय '}],
                'note': '  PRIVATE_NOTE /Users/source — अपरिवर्तित  '}
    calls, responses = [], []
    def provider(self, request, *, role, notes_pages):
        calls.append(deepcopy(request))
        value = deepcopy(accepted)
        if len(calls) <= failures:
            if len(calls) == 1: value['artifact']['beats'][3]['phrase'] = 'कोशीका साफ'
            else: value['artifact']['beats'][3]['occurrence'] = 2
        if len(calls) > 1:
            feedback = json.loads(request['system'][-1]['text'].split('\n')[-1])['technical_feedback']
            assert feedback['constraint'] == 'board_exact_phrase_occurrence'
            assert feedback['details']['exact_match_count'] == (0 if len(calls) == 2 else 1)
        response = {'stopReason': 'end_turn', 'usage': {'inputTokens': 100, 'outputTokens': 20},
                    'output': {'message': {'content': [{'text': json.dumps(value, ensure_ascii=False)}]}}}
        responses.append(deepcopy(response))
        return response
    monkeypatch.setattr(Fixture, 'invoke', provider)
    run = make_run(tmp_path, boards)
    result = run.role(role, declared)
    run.export(role, role+'.json')
    assert len(calls) == min(failures+1, 3)
    assert result['status'] == ('ok' if failures < 3 else 'failed')
    if failures < 3:
        assert run.output(role) == accepted
        assert read(tmp_path/'artifacts'/f'{role}.json') == accepted['artifact']
    else:
        assert not (tmp_path/'artifacts'/f'{role}.json').exists()
    for number, response in enumerate(responses, 1):
        directory = tmp_path/'attempts'/role/f'{number:03d}'
        assert read(directory/'response.json') == response
        checkpoint = read(directory/'checkpoint.json')
        if number <= failures:
            assert checkpoint['status'] == 'failed' and 'output' not in checkpoint
        if number > 1:
            request = calls[number-1]
            assert request['system'][:-1] == calls[0]['system']
            assert request['messages'][0]['content'][:-1] == calls[0]['messages'][0]['content']
            assert 'PRIVATE' not in request['system'][-1]['text']
            assert json.loads(request['messages'][0]['content'][-1]['text'].split('\n')[-1]) == {
                'previous_response_text': responses[number-2]['output']['message']['content'][0]['text']}
    before = {str(path.relative_to(tmp_path)): path.read_bytes()
              for path in tmp_path.rglob('*') if path.is_file()}
    runtime.Runner(tmp_path, boards, resume=True).role(role, declared)
    assert len(calls) == min(failures+1, 3) and run.exposure() == 0
    assert before == {str(path.relative_to(tmp_path)): path.read_bytes()
                      for path in tmp_path.rglob('*') if path.is_file()}


@pytest.mark.parametrize('phase', ('author', 'review', 'final'))
def test_initial_boards_contract_changes_only_native_author_system_blocks(phase):
    role = 'boards_c002_'+phase
    declared = {'card': {'card_idx': 2}, 'narration': speech(), 'mode': 'board', 'PRIVATE': '/Users/source'}
    before = deepcopy(declared)
    baseline = c.request(None, role, declared, [], [], True,
                         'board_verify' if phase == 'review' else 'board_author')
    request = boards.request(None, role, declared, [], [], True)
    assert request['messages'] == baseline['messages'] and declared == before
    if phase == 'review':
        assert request == baseline
    else:
        assert len(request['system']) == (2 if phase == 'final' else 1)
        contract = request['system'][-1]['text']
        assert 'PRIVATE' not in contract and '/Users/' not in contract
        for text in ('strict JSON object', 'exact contiguous text', 'not a beat number',
                     'Multiple beats', 'draw end_ms <= emphasis start_ms', 'same phrase',
                     'beat array order does not move cues', 'Review remains advisory'):
            assert text in contract
        if phase == 'final':
            assert request['system'][0]['text'].startswith('For this final board-author revision,')
    other = 'visuals_c002_'+phase
    assert boards.request(None, other, declared, [], [], True) == c.request(
        None, other, declared, [], [], True, 'board_verify' if phase == 'review' else 'board_author')


# Captured from the tracked 101be8f runtime before this anchor change. Both
# historical v1 and ordinary v2 requests retain exact serialized byte identity.
@pytest.mark.parametrize('case,version,digest', [
    ('native', 1, 'c5548819c6739f3e7374d8f43dbcd77ed3170f26a2b22a13a334c213e0d58e77'),
    ('native', 2, '2342465a70779aa108a198112bd348a019e9b9977634c82eb669d7f3934c39e3'),
    ('json', 1, 'c63728c8afdab4104620251bd064a94c63eebb8901a02e031287de438be8e028'),
    ('json', 2, '7c7fa670be04f4c4385bae33f5aed7a13751ca0d91098aaa9deba64492d9dc72'),
    ('timing', 1, 'ed722bd31c5941367f1201013a13dcdc2639fe0f03bc45aa576a5ac3ef21d613'),
    ('timing', 2, 'db5a1219e2ac61ef0ec928aa784e12ca389d25754e0bb9fc4709558b9db37ee0'),
    ('visual', 1, 'ffdd5f92637ade154a3eb2ec34413c1f188cffa6c032a03df513bc8fe02e886b'),
    ('visual', 2, '4bc01212e3c334852d81544fab4592f1c9ca6b71ea35bfb425a4a63ef69df91d')])
def test_unflagged_recovery_requests_remain_exact_101be8f_bytes(case, version, digest):
    request = {'system': [{'text': 'Original role contract only.'}],
               'messages': [{'role': 'user', 'content': [{'text': 'TASK EXACT'}]}]}
    feedback = {'native': runtime.technical_feedback(ValueError(), 'native'),
                'json': {'kind': 'invalid_json'},
                'timing': runtime.technical_feedback(runtime.NativeContractError('board_emphasis_after_draw'), 'native'),
                'visual': runtime.technical_feedback(runtime.NativeContractError('visual_executable_body'), 'native')}[case]
    assert sha(canonical(runtime.recovery_request(request, 'REJECTED EXACT', feedback, version=version))) == digest
