"""Synthetic attached-image contracts; no paid inference or curriculum content."""
import json
from pathlib import Path
import socket
import sys

from PIL import Image
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from reference.factories import guideline as factory
from reference.inputs import load_manifest, read, save
from reference.providers import Fixture
from reference.runtime import Runner, model_response_json, report


def runner(tmp_path, labels):
    pages = []
    for index, label in enumerate(labels):
        path = tmp_path/f'synthetic-{index}.png'
        Image.new('RGB', (1, 1), (index * 30, 0, 0)).save(path)
        pages.append({'printed_page': label, 'path': path.name})
    manifest = tmp_path/'manifest.json'
    save(manifest, {'factory': 'guideline', 'metadata': {
        'grade': 5, 'subject': 'Synthetic', 'chapter_title': 'Synthetic batch contract'},
        'pages': pages})
    bundle, blobs = load_manifest(manifest, factory)
    workspace = tmp_path/'run'
    workspace.mkdir()
    return Runner(workspace, factory, bundle=bundle, blobs=blobs,
                  config={'provider': 'fixture', 'image_limit': 3})


def task_data(request):
    return json.loads(request['messages'][0]['content'][0]['text'].split('Declared task data:\n', 1)[1])


@pytest.mark.parametrize('labels', [[57, 58, 59, 60, 61], ['xix', '57', 57, 'xx', 58]])
def test_eight_roles_independently_attach_exact_typed_three_plus_two(tmp_path, monkeypatch, labels):
    def forbidden(*args, **kwargs):
        raise AssertionError('SDK/network forbidden in synthetic batch traversal')
    import boto3
    monkeypatch.setattr(boto3, 'client', forbidden)
    monkeypatch.setattr(socket.socket, 'connect', forbidden)
    monkeypatch.setenv('PRIVATE_OPERATOR_HISTORY', 'NEVER-IN-CONTENT')
    original = Fixture.invoke
    seen = []

    def capture(self, request, *, role, notes_pages):
        seen.append((role, request))
        response = original(self, request, role=role, notes_pages=notes_pages)
        if notes_pages is not None:
            notes = [{'printed_page': label, 'observations': f'{role}-OWN-NOTES-{label!r}'}
                     for label in notes_pages]
            response['output']['message']['content'] = [{'text': json.dumps({'page_notes': notes})}]
        return response

    monkeypatch.setattr(Fixture, 'invoke', capture)
    run = runner(tmp_path, labels)
    factory.graph(run).invoke({'last_role': 'start'})
    assert len(seen) == len(run.ledger['calls']) == 16
    assert [role for role, _ in seen] == [role for role in factory.ROLES for _ in range(2)]
    for index, role in enumerate(factory.ROLES):
        own_notes = read(run.workspace/'checkpoints'/f'{role}__batch_1.json')['output']['page_notes']
        for turn, batch in enumerate((run.bundle['pages'][:3], run.bundle['pages'][3:])):
            request = seen[index * 2 + turn][1]
            payload = task_data(request)
            expected = [page['printed_page'] for page in batch]
            assert payload == {'metadata': run.bundle['metadata'], 'source_printed_pages': labels,
                'current_batch_printed_pages': expected, 'task_inputs': factory.declared(run, role),
                'role_local_page_notes': own_notes if turn else []}
            assert [type(x) for x in payload['current_batch_printed_pages']] == [type(x) for x in expected]
            assert len(request['messages']) == 1
            assert set(request) == ({'messages', 'system'} if turn == 0 else {'messages'})
            content = request['messages'][0]['content']
            image_content = content[1:-1] if turn else content[1:]
            assert [item['text'] for item in image_content[::2]] == [f'Original printed page {p["printed_page"]}:' for p in batch]
            assert [item['image'] for item in image_content[1::2]] == [
                {'format': p['format'], 'source': {'bytes': run.blobs[p['file']]}} for p in batch]
            prompt = content[0]['text'].split('Declared task data:\n', 1)[0]
            assert 'whole source for provenance' in prompt
            if turn == 0:
                assert 'in this exact order: '+json.dumps(expected, ensure_ascii=False)+'.' in prompt
                assert 'Copy each label and its JSON type exactly.' in prompt
                assert 'Do not include absent, not-yet-attached or previously noted pages in page_notes.' in prompt
                assert 'Do not produce final role output yet.' in prompt
            else:
                assert content[-1]['text'].startswith('Final output contract:\n')
                assert '<complete requested JSON>' not in prompt
                assert 'use the full sequential context' in prompt
                assert 'The final revision is authoritative' in prompt
                assert 'Do not produce final role output yet.' not in prompt
            for other in set(factory.ROLES) - {role}:
                assert f'{other}-OWN-NOTES-' not in content[0]['text']
            for prohibited in ('NEVER-IN-CONTENT', 'AGENTS.md', 'SKILL.md', str(tmp_path)):
                assert prohibited not in content[0]['text']
    # Both drafts start independently; each final turn contains only its own notes.
    assert seen[0][1] == seen[2][1]
    assert task_data(seen[1][1])['task_inputs'] == task_data(seen[3][1])['task_inputs'] == {}
    assert read(run.workspace/'artifacts/guideline.json') == run.output('revision')['artifact']
    assert read(run.workspace/'artifacts/refresher-guideline.json') == run.output('refresher')['artifact']
    assert report(run.workspace, factory)['status'] == 'complete'
    assert run.exposure() == 0
    resumed = Runner(run.workspace, factory, resume=True)
    factory.graph(resumed).invoke({'last_role': 'start'})
    assert len(seen) == len(resumed.ledger['calls']) == 16


def test_later_inspection_excludes_prior_notes_but_preserves_role_context(tmp_path):
    run = runner(tmp_path, [57, 58, 59, 60, 61])
    notes = [{'printed_page': 57, 'observations': 'SYNTHETIC own earlier observation'}]
    request = factory.request(run, 'draft_1', {}, run.bundle['pages'][1:2], notes, False)
    payload = task_data(request)
    assert payload['source_printed_pages'] == [57, 58, 59, 60, 61]
    assert payload['current_batch_printed_pages'] == [58]
    assert payload['role_local_page_notes'] == notes
    assert 'in this exact order: [58].' in request['messages'][0]['content'][0]['text']
    assert len(request['messages'][0]['content']) == 3


@pytest.mark.parametrize('returned', [[57, 58, 59, 60, 61], [57, 58], [59, 58, 57],
                                    ['57', 58, 59], [57, 58, 58]])
def test_unchanged_parser_rejects_noncurrent_missing_reordered_or_stringified_labels(returned):
    value = {'page_notes': [{'printed_page': label, 'observations': 'SYNTHETIC'} for label in returned]}
    body, _ = model_response_json('```json\n'+json.dumps(value)+'\n```')
    with pytest.raises(ValueError, match='Missing ordered current-page notes'):
        factory.parse('draft_1', body, [57, 58, 59])


def test_unchanged_parser_preserves_mixed_labels_and_rejects_roman_substitution():
    labels = ['xix', '57', 57]
    value = {'page_notes': [{'printed_page': label, 'observations': 'SYNTHETIC'} for label in labels]}
    assert factory.parse('draft_1', json.dumps(value), labels) == value
    value['page_notes'][0]['printed_page'] = 19
    with pytest.raises(ValueError, match='Missing ordered current-page notes'):
        factory.parse('draft_1', json.dumps(value), labels)


def test_observed_extra_labels_remain_failed_checkpoint_without_retry(tmp_path, monkeypatch):
    def extra_labels(*args, **kwargs):
        value = {'page_notes': [{'printed_page': label, 'observations': 'SYNTHETIC'}
                                for label in [57, 58, 59, 60, 61]]}
        return {'output': {'message': {'content': [{'text': '```json\n'+json.dumps(value)+'\n```'}]}},
                'stopReason': 'end_turn'}
    monkeypatch.setattr(Fixture, 'invoke', extra_labels)
    run = runner(tmp_path, [57, 58, 59, 60, 61])
    result = run.role('draft_1', {})
    assert result['status'] == 'failed'
    assert result['error'] == 'Missing ordered current-page notes'
    assert result['response_framing'] == 'markdown_json_fence'
    assert len(run.ledger['calls']) == 1
    assert not (run.workspace/'requests/draft_1.json').exists()
    resumed = Runner(run.workspace, factory, resume=True)
    assert resumed.role('draft_1', {}) == result
    assert len(resumed.ledger['calls']) == 1
