"""Teaching-only serialization bounds with real synthetic graph/native joins."""
from copy import deepcopy
from pathlib import Path

import pytest

from test_translate import EXAMPLE, intercept, invoke, offline, runner
from reference.factories import translate
from reference.factories.media_common import narration_blocks
from reference.factories.translate_fixture import payload
from reference.factories.translate_inputs import project
from reference.inputs import canonical, load_manifest, read, sha
from reference.runtime import Runner, report


def fourteen_cards():
    bundle, _ = load_manifest(EXAMPLE, translate)
    cards = bundle['declared']['deck']['cards']
    for index in (13, 14):
        card = deepcopy(cards[-1])
        card['card_idx'] = index
        cards.append(card)
    return bundle


@pytest.mark.parametrize('size', (None, 2, 4, 12, 50))
def test_teaching_cap_respects_smaller_global_size_without_changing_other_streams(size):
    bundle = fourteen_cards()
    if size is None:
        bundle['metadata'].pop('batch_size')
    else:
        bundle['metadata']['batch_size'] = size
    view = project(bundle)
    before = deepcopy(view)
    work = translate.batches(bundle, view)
    global_size = 12 if size is None else size
    assert view == before
    for stream in translate.STREAMS:
        chunks = [batch for batch in work if batch['stream'] == stream]
        limit = min(global_size, 4) if stream == 'teaching' else global_size
        original = view['streams'][stream]
        assert [batch['batch'] for batch in chunks] == list(range(1, len(chunks)+1))
        assert [batch['items'] for batch in chunks] == [
            original[index:index+limit] for index in range(0, len(original), limit)]
        assert [item for batch in chunks for item in batch['items']] == original
    if size is None:
        assert [len(batch['items']) for batch in work if batch['stream'] == 'teaching'] == [4, 4, 4, 2]
        # Four teaching batches replace two; the other five batches stay intact.
        assert len(work) == 9 and 3*len(work) == 27
        old_teaching_roles = 3*((14+global_size-1)//global_size)
        new_teaching_roles = 3*sum(batch['stream'] == 'teaching' for batch in work)
        assert new_teaching_roles-old_teaching_roles == 6


def test_default_graph_keeps_final_authority_host_provenance_narration_and_zero_call_resume(tmp_path, monkeypatch):
    bundle = fourteen_cards()
    bundle['metadata'].pop('batch_size')

    def authored_lines(role, data, value):
        if data['stream'] == 'teaching' and role.endswith('_final'):
            for item in value['artifact']['items']:
                item['title_display'] = 'Final author '+item['slot']
                item['source_hash'] = 'unsolicited-model-digest'
                for index, line in enumerate(item['lines']):
                    line.update(display='', audio=f"Final author {item['slot']} line {index+1}")

    intercept(monkeypatch, authored_lines)
    run = runner(tmp_path, bundle)
    invoke(run)
    view = project(run.bundle)
    work = read(tmp_path/'views/batches.json')
    sizes = {stream: [len(batch['items']) for batch in work if batch['stream'] == stream]
             for stream in translate.STREAMS}
    assert sizes == {'teaching': [4, 4, 4, 2], 'checkin': [6], 'practice': [8],
                     'feedback': [12, 2], 'revise': [1]}
    assert report(tmp_path, translate)['status'] == 'complete'
    assert len(run.ledger['calls']) == 27 and run.exposure() == 0
    assert read(tmp_path/'metrics/assembly.json')['quality_gate'] is False
    assert run.identity['runtime']['files']['reference/factories/translate.py'] == sha(
        Path(translate.__file__).read_bytes())
    translated = {}
    for batch in work:
        stream = batch['stream']
        for phase in translate.PHASES:
            role = translate.role_key(batch, phase)
            request = read(tmp_path/'requests'/f'{role}.json')
            data = payload(request)
            assert [item['slot'] for item in data['items']] == [item['slot'] for item in batch['items']]
            assert all('source_hash' not in item for item in data['items'])
            expected_contract = (translate.TEACHING_FINAL_CONTRACT
                                 if stream == 'teaching' and phase == 'final'
                                 else translate.HOST_IDENTITY_CONTRACT)
            assert request['system'][-1] == {'text': expected_contract}
        role = translate.role_key(batch, 'final')
        final = run.output(role)
        if stream == 'teaching':
            assert final['transport']['protocol'] == translate.TEACHING_WIRE_PROTOCOL
        else:
            assert all(disposition['action'] == 'declined' for disposition in final['dispositions'])
        assert read(tmp_path/'artifacts'/f'{role}.json') == final['artifact']
        if stream == 'teaching':
            translated.update({item['slot']: item for item in final['artifact']['items']})
    descriptors = {item['slot']: item for item in view['descriptors']['teaching']}
    pack = read(tmp_path/'artifacts/deck_hi.json')
    for ordering, item in zip(view['deck_order'], pack['items']):
        if ordering['stream'] != 'teaching':
            continue
        slot = ordering['slot']
        assert item['source'] == descriptors[slot]['source']
        assert item['title_display'] == translated[slot]['title_display']
        assert item['lines'] == translated[slot]['lines']
        assert 'source_hash' not in item
    native = deepcopy(run.bundle)
    native['declared'].update(speech={'language': 'hi', 'voice': 'Lekha'},
        translated_deck=pack, index_map=read(tmp_path/'views/interleaved-index-map.json'),
        translated_identity=read(tmp_path/'views/reference-identity.json'))
    for card in native['declared']['deck']['cards']:
        blocks = narration_blocks(native, card)
        assert len(blocks) == len(card['lines'])
        assert all(block['script'].startswith('Final author teaching:') for block in blocks)
    before = {path.relative_to(tmp_path): path.read_bytes() for path in tmp_path.rglob('*') if path.is_file()}
    ledger = canonical(read(run.ledger_path))
    resumed = Runner(tmp_path, translate, resume=True)
    invoke(resumed)
    assert len(resumed.ledger['calls']) == 27 and canonical(read(run.ledger_path)) == ledger
    assert {path.relative_to(tmp_path): path.read_bytes() for path in tmp_path.rglob('*') if path.is_file()} == before
