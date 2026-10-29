"""T12 native empty-array contract and exact request boundary; synthetic only."""
from copy import deepcopy
from types import SimpleNamespace

import pytest

from test_practice import offline
from reference.factories import practice
from reference.factories.practice_fixture import output
from reference.inputs import canonical, sha


ARRAY_CONTRACT = (' Every skill must include misconceptions as an array of strings: use [] when no relevant guideline '
                  'entries apply; never omit it, use null or a string, or invent misconceptions to fill it.')

# Captured from unchanged main 44856c4 before editing request(); entire requests,
# including both text blocks. Existing T10 fixtures remain untouched.
PRE_EDIT_REQUESTS = {
    'practice_blueprint': '17db8a8c886874fc94e24a773d93f5e92e23b7a095f6baddc51d6b55f79a0cd1',
    'practice_slot_1': '01b86cb6f8f3b7ebbcfb79acc7ade7cb5b820a27c2f5347e8780e81ee998c3ba',
    'practice_slot_2': '065ee00788e177e3bfdc1b705ae5f0fa7aed060183b92fce55e154641f7abc43',
    'practice_slot_3': 'bab60c63a5d323fd5e83153b33aab2aabab31a8cb56ee6bf1711dcbbe5a5af72',
    'practice_slot_4': '03c8e281e91cdc3d7cbf85d93f2a4dac22b93cb07cba7d92e48b05e49d0daa3a',
    'practice_slot_5': 'e15a3f0f1a423ea26d277e87c3b5fb0110e81a0160dea7bba5e4c4fe0d40b525',
    'practice_slot_97': 'a40028b71ba0ce7342fc7ec1ba4ae31071c0a5eed9c8e5a3b900e8aa3e75a484',
    'practice_review': 'a2f53695b2a8245c146832f759aba9f426fbc115ad83bbbf358bac23b8289bbd',
    'practice_final': 'e79a14b42aadcdd4cbd3809aff25dfe29572547e4af93bfbe9f7ee63a381ad29',
}


def request(role, declared):
    run = SimpleNamespace(bundle={'metadata': {'grade': 4}})
    return practice.request(run, role, declared, None, None, True)


@pytest.mark.parametrize('role', PRE_EDIT_REQUESTS)
def test_only_blueprint_final_second_block_changes(role):
    value = request(role, {'synthetic_sentinel': 'T12 request identity only'})
    first, final = value['messages'][0]['content']
    assert ARRAY_CONTRACT not in first['text']
    if role == 'practice_blueprint':
        assert final['text'].count(ARRAY_CONTRACT) == 1
        final['text'] = final['text'].replace(ARRAY_CONTRACT, '')
    else:
        assert ARRAY_CONTRACT not in final['text']
    assert sha(canonical(value)) == PRE_EDIT_REQUESTS[role]


def native_blueprint():
    value = request('practice_blueprint', {'guideline': {'sections': [
        {'section_key': 'synthetic-a'}, {'section_key': 'synthetic-b'}]}})
    return output('practice_blueprint', value)['artifact']


def test_native_empty_and_nonempty_arrays_are_preserved():
    value = native_blueprint()
    value['skills'][1]['misconceptions'] = ['Synthetic guideline misconception']
    before = deepcopy(value)
    result = practice.blueprint_view(value, {'synthetic-a', 'synthetic-b'})
    assert result['skills'][0]['misconceptions'] == []
    assert result['skills'][1]['misconceptions'] == ['Synthetic guideline misconception']
    assert value == before


@pytest.mark.parametrize('skill_index', [0, 1])
@pytest.mark.parametrize('kind', ['missing', 'null', 'string', 'nonstring_array'])
def test_every_skill_still_requires_native_string_array(skill_index, kind):
    value = native_blueprint()
    skill = value['skills'][skill_index]
    if kind == 'missing':
        skill.pop('misconceptions')
    else:
        skill['misconceptions'] = {'null': None, 'string': 'Synthetic text',
                                   'nonstring_array': ['Synthetic text', 1]}[kind]
    before = deepcopy(value)
    with pytest.raises(ValueError, match='misconceptions array'):
        practice.blueprint_view(value, {'synthetic-a', 'synthetic-b'})
    assert value == before  # no repair, wrapping or missing-field default
