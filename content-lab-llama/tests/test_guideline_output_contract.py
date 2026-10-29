"""Synthetic final-response contracts, without provider calls or chapter content."""
import json
import socket

import pytest

from test_guideline_batches import runner, task_data
from reference.factories import guideline as factory
from reference.inputs import read
from reference.providers import Fixture
from reference.runtime import Runner


@pytest.fixture(autouse=True)
def offline(monkeypatch):
    def forbidden(*args, **kwargs):
        raise AssertionError('SDK/network forbidden in synthetic contract checks')
    import boto3
    monkeypatch.setattr(boto3, 'client', forbidden)
    monkeypatch.setattr(socket.socket, 'connect', forbidden)


@pytest.mark.parametrize('role', factory.ROLES)
@pytest.mark.parametrize('page_count', [2, 5])
def test_final_contract_is_last_after_declared_data_and_every_original(tmp_path, role, page_count):
    run = runner(tmp_path, list(range(57, 57 + page_count)))
    batch = run.bundle['pages'][-2:]
    declared = {'candidates': [{'index': 2, 'draft': {'synthetic': True}}]} if role == 'selection' else {}
    notes = [{'printed_page': 57, 'observations': 'SYNTHETIC own prior note'}] if page_count == 5 else []
    request = factory.request(run, role, declared, batch, notes, True)
    content = request['messages'][0]['content']
    assert len(request['messages']) == 1
    assert request['messages'][0]['role'] == 'user'
    assert task_data(request)['task_inputs'] == declared
    assert task_data(request)['role_local_page_notes'] == notes
    assert task_data(request)['current_batch_printed_pages'] == [p['printed_page'] for p in batch]
    assert [item['image']['source']['bytes'] for item in content if 'image' in item] == [
        run.blobs[p['file']] for p in batch]
    assert len(content) == 2 + 2 * len(batch)
    assert set(content[-1]) == {'text'}
    assert content[-1]['text'].startswith('Final output contract:\n')
    assert 'strict JSON object' in content[-1]['text']
    assert 'no surrounding prose, comments or trailing commas' in content[-1]['text']
    assert all('Final output contract:' not in item.get('text', '') for item in content[:-1])
    assert 'use the full sequential context' in content[0]['text']
    assert 'The final revision is authoritative' in content[0]['text']
    if batch:
        assert 'image' in content[-2]
    # The inspection contract has no appended final instruction, even with prior notes.
    inspection = factory.request(run, role, declared, batch, notes, False)
    assert 'Do not produce final role output yet.' in inspection['messages'][0]['content'][0]['text']
    assert all('Final output contract:' not in item.get('text', '')
               for item in inspection['messages'][0]['content'])


@pytest.mark.parametrize('role', ['draft_1', 'draft_2', 'revision', 'refresher'])
def test_author_illustration_is_valid_nested_json_and_not_substitute_content(tmp_path, role):
    run = runner(tmp_path, [57])
    contract = factory.request(run, role, {}, run.bundle['pages'], [], True)['messages'][0]['content'][-1]['text']
    native = 'refresher' if role == 'refresher' else 'chapter'
    assert f'complete requested native {native} JSON as the object-valued artifact field' in contract
    assert 'examples describe the VALUE of artifact, not the response root' in contract
    illustration = contract.split('Syntax-only envelope illustration:\n')[1].split('\n')[0]
    assert json.loads(illustration) == {'artifact': {}}
    assert factory.parse(role, illustration) == {'artifact': {}}
    assert 'replace it with the complete requested native artifact, including all its fields' in contract
    assert 'do not return an empty or template response' in contract
    assert 'separately requested author audit fields beside artifact' in contract
    assert 'winner_index' not in contract
    assert '...' not in contract and '<' not in contract


@pytest.mark.parametrize('indices', [[1], [2], [1, 2], [2, 1]])
def test_selection_contract_keeps_actual_available_indices_without_example_winner(tmp_path, indices):
    run = runner(tmp_path, [57])
    declared = {'candidates': [{'index': index, 'draft': {'synthetic': True}} for index in indices]}
    contract = factory.request(run, 'selection', declared, run.bundle['pages'], [], True)['messages'][0]['content'][-1]['text']
    assert 'Available candidate indices: '+json.dumps(indices)+'.' in contract
    assert 'winner_index as a JSON integer copied from the explicit index' in contract
    assert 'Preserve the original index; do not renumber candidates' in contract
    assert 'scores, concerns and note' in contract
    assert 'Do not use an artifact envelope' in contract
    assert 'illustration' not in contract and '{' not in contract


@pytest.mark.parametrize('role', ['coverage', 'accuracy', 'structure'])
def test_review_contract_retains_native_feedback_and_advisory_meaning(tmp_path, role):
    run = runner(tmp_path, [57])
    contract = factory.request(run, role, {}, run.bundle['pages'], [], True)['messages'][0]['content'][-1]['text']
    assert 'source lens feedback object directly, with ok, findings and note' in contract
    assert "source role's shape and meaning" in contract
    assert 'Do not use an artifact envelope' in contract
    assert 'Feedback remains advisory for the final author' in contract
    assert 'winner_index' not in contract
    feedback = {'ok': False, 'findings': [{'issue': 'SYNTHETIC feedback'}], 'note': 'SYNTHETIC'}
    assert factory.parse(role, json.dumps(feedback)) == feedback


# Same failure classes as attempt 3, using only synthetic values and native key names.
BARE_CHAPTER = json.dumps({'chapter_display_name': 'SYNTHETIC', 'chapter_summary': '',
    'chapter_overview': '', 'planning_rationale': '', 'milestones': [], 'sections': []})


@pytest.mark.parametrize('fenced', [False, True])
@pytest.mark.parametrize('body,error', [
    (BARE_CHAPTER, 'Missing JSON artifact envelope'),
    (BARE_CHAPTER[:-1] + ',}', None),
    ('{"artifact":{"sections":[],}}', None),
    ('{"artifact":[]}', 'Missing JSON artifact envelope'),
])
def test_wrong_envelope_and_malformed_json_stay_failed_raw_without_retry(tmp_path, monkeypatch, fenced, body, error):
    text = '```json\n'+body+'\n```' if fenced else body
    bad_response = {'output': {'message': {'content': [{'text': text}]}}, 'stopReason': 'end_turn'}
    original = Fixture.invoke

    def response(self, request, *, role, notes_pages):
        return original(self, request, role=role, notes_pages=notes_pages) if notes_pages is not None else bad_response

    monkeypatch.setattr(Fixture, 'invoke', response)
    run = runner(tmp_path, [57, 58, 59, 60, 61])
    result = run.role('draft_1', {})
    assert result['status'] == 'failed'
    if error:
        assert error in result['error']
    else:
        assert 'response_framing' not in result  # Invalid JSON fails before role parsing on every Python version.
    assert read(run.workspace/'responses/draft_1.json') == bad_response
    assert len(run.ledger['calls']) == 2
    assert run.exposure() == 0
    assert 'artifact' not in run.output('draft_1')
    run.export('draft_1', 'guideline.json')
    assert not (run.workspace/'artifacts/guideline.json').exists()
    before = {p: p.read_bytes() for folder in ('requests', 'responses', 'checkpoints')
              for p in (run.workspace/folder).glob('*.json')}
    ledger = run.ledger_path.read_bytes()
    monkeypatch.setattr(Fixture, 'invoke', lambda *args, **kwargs: pytest.fail('Failed request repeated'))
    resumed = Runner(run.workspace, factory, resume=True)
    assert resumed.role('draft_1', {}) == result
    assert resumed.ledger_path.read_bytes() == ledger
    assert all(p.read_bytes() == data for p, data in before.items())
