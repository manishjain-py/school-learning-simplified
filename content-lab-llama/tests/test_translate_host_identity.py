"""Host provenance joins and same-author technical correction for new runs."""
from copy import deepcopy
import json

import pytest

from test_translate import EXAMPLE, PACKS, invoke, offline, runner
from reference.factories import translate
from reference.factories.media_common import narration_blocks
from reference.factories.translate_fixture import payload
from reference.factories.translate_inputs import project
from reference.inputs import canonical, load_manifest, read
from reference.providers import Fixture
from reference.runtime import Runner, report


def test_all_stream_requests_use_slots_without_host_digests(tmp_path):
    run = runner(tmp_path)
    invoke(run)
    view = project(run.bundle)
    hashes = {item['source_hash'] for descriptors in view['descriptors'].values() for item in descriptors}
    for path in (tmp_path/'requests').glob('*.json'):
        request = read(path)
        data = payload(request)
        assert all('source_hash' not in item for item in data['items'])
        if 'draft' in data:
            assert all('source_hash' not in item for item in data['draft']['items'])
        assert request['system'][-1] == {'text': translate.HOST_IDENTITY_CONTRACT}
        encoded = json.dumps(request, ensure_ascii=False)
        assert not any(digest in encoded for digest in hashes)
    assert read(tmp_path/'views/reference-identity.json')['identity_protocol'] == translate.IDENTITY_PROTOCOL


@pytest.mark.parametrize('model_hash', ['shortened-digest', None, ['untrusted', 'model', 'metadata']])
def test_unsolicited_model_hash_stays_raw_and_never_overwrites_host_provenance(tmp_path, monkeypatch, model_hash):
    original = Fixture.invoke

    def altered(self, request, *, role, notes_pages):
        response = original(self, request, role=role, notes_pages=notes_pages)
        if not role.endswith('_final'):
            return response
        value = json.loads(response['output']['message']['content'][0]['text'])
        for item in value['artifact']['items']:
            item['source_hash'] = deepcopy(model_hash)
            item['author_note'] = 'Retain this exact extra author metadata.'
        response['output']['message']['content'][0]['text'] = json.dumps(value, ensure_ascii=False)
        return response

    monkeypatch.setattr(Fixture, 'invoke', altered)
    run = runner(tmp_path)
    invoke(run)
    assert report(tmp_path, translate)['status'] == 'complete'
    view = project(run.bundle)
    for stream in translate.STREAMS:
        role = f'translate_{stream}_b001_final'
        exported = read(tmp_path/'artifacts'/f'{role}.json')
        raw = read(tmp_path/'responses'/f'{role}.json')
        assert exported == json.loads(raw['output']['message']['content'][0]['text'])['artifact']
        assert all(item['source_hash'] == model_hash and 'author_note' in item for item in exported['items'])
    deck = read(tmp_path/'artifacts/deck_hi.json')['items']
    descriptors = {d['slot']: d for stream in ('teaching', 'checkin') for d in view['descriptors'][stream]}
    for ordering, item in zip(view['deck_order'], deck):
        assert item['source'] == descriptors[ordering['slot']]['source']
        assert 'source_hash' not in item
    for stream, filename in [('practice', 'practice_hi.json'), ('revise', 'revise_hi.json')]:
        for item, desc in zip(read(tmp_path/'artifacts'/filename)['items'], view['descriptors'][stream]):
            assert item['source'] == desc['source']


@pytest.mark.parametrize('defect', ['missing', 'duplicate', 'unknown', 'invalid_type'])
def test_complete_slot_join_is_required_at_role_parse(defect):
    source, _ = load_manifest(EXAMPLE, translate)
    batch = translate.batches(source, project(source))[0]
    items = [{'slot': item['slot'], 'title_display': 'Author text', 'lines': []} for item in batch['items']]
    if defect == 'missing':
        items.pop()
    elif defect == 'duplicate':
        items.append(deepcopy(items[0]))
    elif defect == 'unknown':
        items[0]['slot'] = 'teaching:unknown'
    else:
        items[0]['slot'] = []
    value = {'artifact': {'schema_version': 2, 'items': items}}
    with pytest.raises(ValueError, match='identity join failed'):
        translate.parse_declared(translate.role_key(batch, 'final'), json.dumps(value), batch)


def test_native_line_binding_does_not_judge_translated_wording():
    source, _ = load_manifest(EXAMPLE, translate)
    batch = translate.batches(source, project(source))[0]
    value = {'artifact': {'schema_version': 2, 'items': [
        {'slot': item['slot'], 'lines': [{'display': '', 'audio': '  Author text unchanged.  '}
                                      for _ in item['lines']], 'title_display': ''}
        for item in batch['items']]}}
    assert translate.parse_declared(translate.role_key(batch, 'final'), json.dumps(value), batch) == value
    invalid = deepcopy(value)
    invalid['artifact']['items'][0]['lines'] = [{'display': 'Text', 'audio': {'invalid': 'type'}}]
    with pytest.raises(ValueError, match='teaching lines'):
        translate.parse_declared(translate.role_key(batch, 'final'), json.dumps(invalid), batch)


@pytest.mark.parametrize('defect', ['missing_slot', 'missing_lines', 'empty_lines', 'extra_line',
                                  'missing_audio', 'blank_audio', 'missing_display'])
def test_native_failure_corrected_by_same_final_author_then_binds_actual_narration(tmp_path, monkeypatch, defect):
    original = Fixture.invoke
    roles = []
    failed_role = 'translate_teaching_b001_final'

    def settled(self, request, *, role, notes_pages):
        roles.append(role)
        response = original(self, request, role=role, notes_pages=notes_pages)
        response['usage'] = {'inputTokens': 100, 'outputTokens': 20}
        if role == failed_role and roles.count(role) == 1:
            value = json.loads(response['output']['message']['content'][0]['text'])
            items = value['artifact']['items']
            if defect == 'missing_slot':
                items.pop()
            elif defect == 'missing_lines':
                items[0].pop('lines')
            elif defect == 'empty_lines':
                items[0]['lines'] = []
            elif defect == 'extra_line':
                items[0]['lines'].append(deepcopy(items[0]['lines'][0]))
            elif defect == 'missing_audio':
                items[0]['lines'][0].pop('audio')
            elif defect == 'missing_display':
                items[0]['lines'][0].pop('display')
            else:
                items[0]['lines'][0]['audio'] = ' \n '
            response['output']['message']['content'][0]['text'] = json.dumps(value, ensure_ascii=False)
        return response

    monkeypatch.setattr(Fixture, 'invoke', settled)
    run = runner(tmp_path)
    invoke(run)
    assert report(tmp_path, translate)['status'] == 'complete'
    expected = translate.report_roles(tmp_path)
    assert len(roles) == len(expected)+1 == 22 and roles.count(failed_role) == 2
    assert all(roles.count(role) == 1 for role in expected if role != failed_role)
    assert len(run.output(failed_role)['artifact']['items']) == 4
    # Exercise the real downstream identity/narration adapter, not a duplicate
    # line-count assertion or mocked media helper.
    bundle = deepcopy(run.bundle)
    bundle['declared'].update(speech={'language': 'hi', 'voice': 'Lekha'},
        translated_deck=read(tmp_path/'artifacts/deck_hi.json'),
        index_map=read(tmp_path/'views/interleaved-index-map.json'),
        translated_identity=read(tmp_path/'views/reference-identity.json'))
    for card in bundle['declared']['deck']['cards']:
        blocks = narration_blocks(bundle, card)
        assert len(blocks) == len(card['lines'])
        assert all(isinstance(block['script'], str) and block['script'].strip() for block in blocks)
    saved = {path.relative_to(tmp_path): path.read_bytes() for folder in ('requests', 'responses', 'artifacts')
             for path in (tmp_path/folder).rglob('*.json')}
    ledger = canonical(read(run.ledger_path))
    invoke(Runner(tmp_path, translate, resume=True))
    assert len(roles) == 22 and canonical(read(run.ledger_path)) == ledger
    assert all((tmp_path/path).read_bytes() == data for path, data in saved.items())
    assert all((tmp_path/'artifacts'/name).exists() for name in PACKS)
