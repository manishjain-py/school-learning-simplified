"""Translate engineering contracts: real graph, synthetic text, no SDK/network."""
import builtins
from copy import deepcopy
import difflib
import json
import os
from pathlib import Path
import socket
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import run_factory as cli
from reference.factories import translate as r
from reference.factories.translate_fixture import MARKER, payload, teaching_wire
from reference.factories.translate_inputs import project, question_hash
from reference.inputs import ROOT, canonical, load_manifest, read, save, sha
from reference.providers import Fixture
from reference.runtime import Runner, report

EXAMPLE = ROOT/'examples/translate/manifest.json'
CONFIG = {'provider': 'fixture', 'image_limit': 3}
PACKS = ('deck_hi.json', 'practice_hi.json', 'revise_hi.json')
ANSWER_MARKER = 'PRIVATE_ANSWER_FEEDBACK_SENTINEL'
PRIVATE_MARKER = 'PRIVATE_OPERATOR_CODE_PATH_SENTINEL'


@pytest.fixture(autouse=True)
def offline(monkeypatch):
    original = builtins.__import__

    def no_sdk(name, *args, **kwargs):
        if name.split('.')[0] in ('boto3', 'botocore'):
            raise AssertionError('SDK import/client forbidden')
        return original(name, *args, **kwargs)

    def forbidden(*args, **kwargs):
        raise AssertionError('Network forbidden')

    monkeypatch.setattr(builtins, '__import__', no_sdk)
    for name in ('connect', 'connect_ex', 'send', 'sendall', 'sendto'):
        monkeypatch.setattr(socket.socket, name, forbidden)
    monkeypatch.setattr(socket, 'create_connection', forbidden)
    for key in list(os.environ):
        if key.startswith(('AWS_', 'BEDROCK_', 'OPENAI_', 'ANTHROPIC_', 'LANGSMITH_', 'LANGCHAIN_')):
            monkeypatch.delenv(key)


def runner(workspace, bundle=None):
    base, blobs = load_manifest(EXAMPLE, r)
    source = deepcopy(base if bundle is None else bundle)
    # Mutated test sources are new explicit frozen inputs, never inconsistent
    # parsed objects beside the original English bytes.
    if bundle is not None:
        for key, value in source['declared'].items():
            spec = source['file_identity'][key]
            data = canonical(value)
            spec['sha256'] = sha(data)
            blobs[spec['file']] = data
    workspace.mkdir(exist_ok=True)
    return Runner(workspace, r, bundle=source, blobs=blobs, config=CONFIG)


def invoke(run):
    return r.graph(run).invoke({'last_role': 'start'})


def response(value):
    return {'output': {'message': {'content': [{'text': json.dumps(value)}]}}, 'stopReason': 'end_turn'}


def intercept(monkeypatch, change):
    original = Fixture.invoke

    def altered(self, request, *, role, notes_pages):
        result = original(self, request, role=role, notes_pages=notes_pages)
        data = payload(request)
        value = json.loads(result['output']['message']['content'][0]['text'])
        wire = data['stream'] == 'teaching' and role.endswith('_final')
        if wire:
            value = r.decode_teaching_wire(role, json.dumps(value), data)
        change(role, data, value)
        if wire:
            value = teaching_wire(value['artifact'], data['wire_fields'])
        return response(value)

    monkeypatch.setattr(Fixture, 'invoke', altered)


def request_files(workspace):
    return {p.stem: read(p) for p in (workspace/'requests').glob('*.json')}


def final_items(run, stream):
    batches = read(run.workspace/'views/batches.json')
    return [item for batch in batches if batch['stream'] == stream
            for item in run.output(r.role_key(batch, 'final'))['artifact']['items']]


def test_cli_five_streams_three_packs_final_owner_and_completed_resume(tmp_path):
    assert cli.main(['verify', str(EXAMPLE)]) == 0
    assert cli.main(['run', str(EXAMPLE), '--provider', 'fixture', '--workspace', str(tmp_path)]) == 0
    summary = read(tmp_path/'summary.json')
    work = read(tmp_path/'views/batches.json')
    assert summary['status'] == 'complete' and summary['requests'] == 21
    assert summary['operational_stages']['translate_assembly']['status'] == 'complete'
    assert summary['exposure_usd'] == 0 and not (tmp_path/'ledger.json').exists()
    assert list(summary['roles']) == [r.role_key(batch, phase) for batch in work for phase in r.PHASES]
    assert set(read(tmp_path/'views/projections.json')) == set(r.STREAMS)
    assert read(tmp_path/'metrics/assembly.json')['quality_gate'] is False
    source, blobs = load_manifest(EXAMPLE, r)
    for name, data in blobs.items():
        assert (tmp_path/'inputs'/name).read_bytes() == data
    for batch in work:
        prefix = r.role_key(batch, '')
        author = read(tmp_path/'checkpoints'/f'{prefix}author.json')['output']
        review = read(tmp_path/'checkpoints'/f'{prefix}review.json')['output']
        final = read(tmp_path/'checkpoints'/f'{prefix}final.json')['output']
        assert all(v['pass'] is False for v in review['verdicts'])
        if batch['stream'] == 'teaching':
            assert final['transport']['protocol'] == r.TEACHING_WIRE_PROTOCOL
        else:
            assert all(d['action'] == 'declined' for d in final['dispositions'])
        assert final['artifact'] != author['artifact']
        assert read(tmp_path/'artifacts'/f'{prefix}final.json') == final['artifact']
    packs = {name: read(tmp_path/'artifacts'/name) for name in PACKS}
    assert all(p['schema_version'] == 2 and p['language'] == 'hi' for p in packs.values())
    assert len(packs['deck_hi.json']['items']) == len(source['declared']['deck']['cards']) + len(source['declared']['checkins']['check_ins'])
    assert len(packs['practice_hi.json']['items']) == len(source['declared']['practice']['questions'])
    assert len(packs['revise_hi.json']['items']) == len(source['declared']['revise']['cards'])
    translated = {stream: {item['slot']: item for batch in work if batch['stream'] == stream
                  for item in read(tmp_path/'artifacts'/f'{r.role_key(batch, "final")}.json')['items']}
                  for stream in r.STREAMS}
    view = project(source)
    pack_rows = [(d['stream'], d['slot'], item) for d, item in
                 zip(view['deck_order'], packs['deck_hi.json']['items'])]
    for stream, filename in (('practice', 'practice_hi.json'), ('revise', 'revise_hi.json')):
        pack_rows += [(stream, d['slot'], item) for d, item in
                      zip(view['descriptors'][stream], packs[filename]['items'])]
    for stream, slot, item in pack_rows:
        final = {k: v for k, v in translated[stream][slot].items() if k not in ('slot', 'source_hash')}
        if stream in ('checkin', 'practice') and slot in translated['feedback']:
            final.update({k: v for k, v in translated['feedback'][slot].items() if k not in ('slot', 'source_hash')})
        assert all(item[field] == value for field, value in final.items())
    html = (tmp_path/'report.html').read_text()
    assert all(text in html for text in (*PACKS, 'declined', 'advisory', MARKER))
    requests = {p.name: p.read_bytes() for p in (tmp_path/'requests').glob('*.json')}
    ledger = (tmp_path/'synthetic-ledger.json').read_bytes()
    for name in PACKS:
        (tmp_path/'artifacts'/name).unlink()
    assert cli.main(['resume', '--workspace', str(tmp_path)]) == 0
    assert packs == {name: read(tmp_path/'artifacts'/name) for name in PACKS}
    assert ledger == (tmp_path/'synthetic-ledger.json').read_bytes()
    assert requests == {p.name: p.read_bytes() for p in (tmp_path/'requests').glob('*.json')}


def test_every_question_role_is_answer_free_and_allowlisted(tmp_path, monkeypatch):
    base, _ = load_manifest(EXAMPLE, r)
    monkeypatch.setenv('PRIVATE_OPERATOR_HISTORY', PRIVATE_MARKER)
    for artifact in base['declared'].values():
        artifact['operator_history'] = PRIVATE_MARKER
    for card in base['declared']['deck']['cards']:
        card.update(visual_explanation=PRIVATE_MARKER, production_id=PRIVATE_MARKER)
        for line in card['lines']:
            line['audio_url'] = PRIVATE_MARKER
    for q in base['declared']['checkins']['check_ins']:
        q.update(hint=ANSWER_MARKER, success_message=ANSWER_MARKER, reveal_text=ANSWER_MARKER,
                 audio_text=PRIVATE_MARKER, pixi_code=PRIVATE_MARKER)
    for q in base['declared']['practice']['questions']:
        q.update(explanation_why=ANSWER_MARKER, audio_text=PRIVATE_MARKER, database_id=PRIVATE_MARKER)
    for card in base['declared']['revise']['cards']:
        card['question']['audio_url'] = PRIVATE_MARKER
        card['operator'] = PRIVATE_MARKER

    def add_private_output(role, data, value):
        value['private_audit'] = PRIVATE_MARKER
        if role.endswith('_author'):
            for item in value['artifact']['items']:
                item['english_answer_key'] = ANSWER_MARKER
                item['coding_history'] = PRIVATE_MARKER
        if role.endswith('_review'):
            for verdict in value['verdicts']:
                verdict['private_routing'] = PRIVATE_MARKER

    intercept(monkeypatch, add_private_output)
    run = runner(tmp_path, base)
    invoke(run)
    requests = request_files(tmp_path)
    whole_requests = json.dumps(requests, ensure_ascii=False)
    for forbidden in (PRIVATE_MARKER, 'AGENTS.md', 'SKILL.md', str(tmp_path), str(ROOT)):
        assert forbidden not in whole_requests
    projected = read(tmp_path/'views/projections.json')
    assert ANSWER_MARKER in json.dumps(projected['feedback'])
    for stream in ('checkin', 'practice'):
        for phase in r.PHASES:
            role = f'translate_{stream}_b001_{phase}'
            request = requests[role]
            data = payload(request)
            assert ANSWER_MARKER not in json.dumps(request, ensure_ascii=False)
            allowed = {'stream', 'items', 'grade', 'subject', 'language'}
            if phase != 'author':
                allowed |= {'draft', 'pre_revision_diagnostics'}
                assert data['draft'] == r.candidate_view(run.output(f'translate_{stream}_b001_author')['artifact'], stream)
            if phase == 'final':
                allowed.add('review')
                assert set(data['review']) == {'verdicts', 'batch_issues'}
                assert all(set(v) == {'slot', 'pass', 'reason'} for v in data['review']['verdicts'])
            assert set(data) == allowed
            assert data['items'] == [{k: v for k, v in item.items() if k != 'source_hash'}
                                     for item in projected[stream]]
            native = base['declared']['checkins']['check_ins'] if stream == 'checkin' else base['declared']['practice']['questions']
            for english, item in zip(native, data['items']):
                assert set(item) <= {'slot', 'format', 'question_text', 'instruction', 'statement', 'options'}
                assert 'source_hash' not in item
                assert set(item) >= {'slot', 'format', 'options'}
                for field in ('question_text', 'instruction', 'statement'):
                    if field in english:
                        assert item[field] == english[field]
                assert item['options'] == english.get('options', [])
                if item['format'] == 'true_false':
                    assert item['statement'] == english['statement'] and item['options'] == []
            assert len(request['messages']) == 1
            assert set(request['messages'][0]['content'][0]) == {'text'}


def test_fingerprints_include_hidden_feedback_and_key_but_projection_is_opaque():
    base, _ = load_manifest(EXAMPLE, r)
    original = project(base)['streams']
    cases = [('checkins', 'check_ins', 'success_message', ANSWER_MARKER),
             ('checkins', 'check_ins', 'hint', ANSWER_MARKER),
             ('practice', 'questions', 'explanation_why', ANSWER_MARKER)]
    for artifact, field, key, value in cases:
        changed = deepcopy(base)
        changed['declared'][artifact][field][0][key] = value
        stream = 'checkin' if artifact == 'checkins' else 'practice'
        before, after = original[stream][0], project(changed)['streams'][stream][0]
        assert before['source_hash'] != after['source_hash']
        assert {k: v for k, v in before.items() if k != 'source_hash'} == {k: v for k, v in after.items() if k != 'source_hash'}
        assert ANSWER_MARKER not in json.dumps(after)
    for stream, artifact, field, fmt_field in (('checkin', 'checkins', 'check_ins', 'activity_type'),
                                             ('practice', 'practice', 'questions', 'format')):
        rows = base['declared'][artifact][field]
        source = next(q for q in rows if 'correct_index' in q)
        changed = deepcopy(source)
        changed['correct_index'] = (source['correct_index'] + 1) % len(source['options'])
        assert question_hash(source[fmt_field], source) != question_hash(changed[fmt_field], changed)


def test_interleaved_indices_keys_option_positions_and_distinct_revise_index_space(tmp_path):
    base, _ = load_manifest(EXAMPLE, r)
    # R5 references its own slim teaching view. Index 4 is a check-in in the
    # interleaved R6 deck and must never be treated as the same card identity.
    base['declared']['revise']['cards'][0]['source_card_idxs'] = [4, 8]
    run = runner(tmp_path, base)
    invoke(run)
    mapping = read(tmp_path/'views/interleaved-index-map.json')
    assert [m['card_idx'] for m in mapping] == list(range(1, 19))
    assert [m['card_idx'] for m in mapping if m['kind'] == 'checkin'] == [4, 5, 10, 11, 16, 17]
    assert [m['original_card_idx'] for m in mapping if m['kind'] == 'teaching'] == list(range(1, 13))
    packs = {name: read(tmp_path/'artifacts'/name)['items'] for name in PACKS}
    checkins = [item for item in packs['deck_hi.json'] if item['source']['card_type'] == 'check_in']
    assert [item['source']['original_checkin_ordinal'] for item in checkins] == list(range(1, 7))
    for english, translated in zip(base['declared']['checkins']['check_ins'], checkins):
        for key in ('correct_index', 'correct_indices', 'correct_answer'):
            if key in english:
                assert translated['english_answer_key'][key] == english[key]
        if english['activity_type'] == 'true_false':
            assert translated['english_options'] == translated['options_display'] == translated['options_audio'] == []
        else:
            assert translated['english_options'] == english['options']
            assert translated['options_display'] == ['नमूना '+str(i) for i in range(len(english['options']))]
        assert translated['hint_display'].startswith('अंतिम ')
        assert translated['success_display'].startswith('अंतिम ')
    for ordinal, (english, translated) in enumerate(zip(base['declared']['practice']['questions'], packs['practice_hi.json']), 1):
        assert translated['source']['question_id'] == f'p{ordinal:06d}'
        for key in ('correct_index', 'correct_indices', 'correct_answer_bool'):
            if key in english:
                assert translated['english_answer_key'][key] == english[key]
        assert translated['explanation_display'].startswith('अंतिम ')
        assert translated['correct_answer_display'].startswith('नमूना ')
        expected_options = english.get('options', [])
        assert translated['english_options'] == expected_options
        assert translated['options_display'] == ['नमूना '+str(i) for i in range(len(expected_options))]
    rev = packs['revise_hi.json'][0]
    assert rev['source']['source_card_idxs'] == [4, 8]
    assert 'R5' in rev['source']['source_card_idxs_space']
    assert rev['source']['source_input_sha256'] == run.bundle['file_identity']['revise']['sha256']
    assert len(rev['source']['source_deck_fingerprint']) == 64
    assert rev['answer']['display'].startswith('अंतिम ')


def test_reordered_final_slots_join_by_identity_and_revise_packs_use_source_idx_order(tmp_path, monkeypatch):
    base, _ = load_manifest(EXAMPLE, r)
    first = base['declared']['revise']['cards'][0]
    first['idx'] = 9
    second = deepcopy(first)
    second.update(idx=2, concept_key='separate-synthetic-concept')
    base['declared']['revise']['cards'].append(second)

    def reorder(role, data, value):
        if not role.endswith('_final'):
            return
        for item in value['artifact']['items']:
            text = 'अंतिम '+item['slot']
            if data['stream'] == 'teaching':
                item['title_display'] = text
            elif data['stream'] in ('checkin', 'practice'):
                item['question_display'] = text
            elif data['stream'] == 'revise':
                item['question']['display'] = text
        value['artifact']['items'].reverse()

    intercept(monkeypatch, reorder)
    run = runner(tmp_path, base)
    invoke(run)
    assert report(tmp_path, r)['status'] == 'complete'
    assert [i['slot'] for i in final_items(run, 'revise')] == ['revise:9', 'revise:2']
    deck = read(tmp_path/'artifacts/deck_hi.json')['items']
    for idx, item in enumerate(deck, 1):
        stream = 'checkin' if item['source']['card_type'] == 'check_in' else 'teaching'
        field = 'question_display' if stream == 'checkin' else 'title_display'
        assert item['source']['card_idx'] == idx
        assert item[field] == f'अंतिम {stream}:{idx}'
    practice = read(tmp_path/'artifacts/practice_hi.json')['items']
    assert [i['question_display'] for i in practice] == [f'अंतिम practice:p{i:06d}' for i in range(1, 9)]
    revision = read(tmp_path/'artifacts/revise_hi.json')['items']
    assert [i['source']['idx'] for i in revision] == [2, 9]
    assert [i['question']['display'] for i in revision] == ['अंतिम revise:2', 'अंतिम revise:9']


@pytest.mark.parametrize('defect', ('missing', 'extra', 'duplicate', 'invalid_slot'))
def test_unjoinable_final_stops_at_parse_with_raw_author_retained_and_no_subset(tmp_path, monkeypatch, defect):
    def break_identity(role, data, value):
        if role != 'translate_teaching_b001_final':
            return
        items = value['artifact']['items']
        if defect == 'missing':
            items.pop()
        elif defect == 'extra':
            items.append({**items[0], 'slot': 'teaching:unknown'})
        elif defect == 'duplicate':
            items.append(deepcopy(items[0]))
        else:
            items[0]['slot'] = []

    intercept(monkeypatch, break_identity)
    run = runner(tmp_path)
    with pytest.raises(ValueError, match='required stage unavailable'):
        invoke(run)
    # This fixture has no provider token receipt, so recovery cannot repeat it.
    assert len(run.ledger['calls']) == 3
    role = 'translate_teaching_b001_final'
    assert read(tmp_path/'checkpoints'/f'{role}.json')['status'] == 'failed'
    raw = read(tmp_path/'responses'/f'{role}.json')
    assert json.loads(raw['output']['message']['content'][0]['text'])
    assert not list((tmp_path/'artifacts').glob('translate_*_final.json'))
    assert not any((tmp_path/'artifacts'/name).exists() for name in PACKS)
    summary = report(tmp_path, r)
    assert summary['status'] == 'partial_or_failed'
    assert summary['roles'][role] == 'failed'
    assert summary['operational_stages']['translate_assembly']['status'] == 'unavailable'
    with pytest.raises(ValueError, match='required stage unavailable'):
        invoke(Runner(tmp_path, r, resume=True))
    assert len(read(tmp_path/'synthetic-ledger.json')['calls']) == 3


def test_imperfect_final_fields_are_retained_without_quality_veto_or_rewrite(tmp_path, monkeypatch):
    def imperfect(role, data, value):
        if role == 'translate_practice_b001_final':
            item = next(i for i in value['artifact']['items'] if i['options_display'])
            item['options_display'] = ['अपूर्ण अंतिम विकल्प']
            item.pop('question_audio')
        elif role == 'translate_teaching_b001_final':
            # Preserve native narration correspondence without judging wording.
            value['artifact']['items'][0]['lines'][0]['display'] = ''
            value['artifact']['items'][0]['title_display'] = ''

    intercept(monkeypatch, imperfect)
    run = runner(tmp_path)
    invoke(run)
    assert report(tmp_path, r)['status'] == 'complete'
    assert len(run.ledger['calls']) == 21
    first = read(tmp_path/'artifacts/deck_hi.json')['items'][0]
    assert first['lines'][0]['display'] == '' and first['title_display'] == ''
    final = next(i for i in final_items(run, 'practice') if i.get('options_display') == ['अपूर्ण अंतिम विकल्प'])
    item = next(i for i in read(tmp_path/'artifacts/practice_hi.json')['items']
                if i['source']['question_id'] == final['slot'].split(':', 1)[1])
    assert item['options_display'] == final['options_display'] and 'question_audio' not in item
    assert len(item['english_options']) > len(item['options_display'])


def test_dynamic_small_batches_run_through_cli(tmp_path):
    manifest = read(EXAMPLE)
    manifest['metadata']['batch_size'] = 2
    for spec in manifest['files'].values():
        spec['path'] = str((EXAMPLE.parent/spec['path']).resolve())
    save(tmp_path/'small-batches.json', manifest)
    workspace = tmp_path/'run'
    assert cli.main(['run', str(tmp_path/'small-batches.json'), '--provider', 'fixture', '--workspace', str(workspace)]) == 0
    work = read(workspace/'views/batches.json')
    assert len(work) > 8 and all(1 <= len(batch['items']) <= 2 for batch in work)
    summary = read(workspace/'summary.json')
    assert summary['status'] == 'complete' and summary['requests'] == 3*len(work) > 25
    assert list(summary['roles']) == [r.role_key(batch, phase) for batch in work for phase in r.PHASES]
    assert len(list((workspace/'artifacts').glob('translate_*_final.json'))) == len(work)


@pytest.mark.parametrize('mode', ('empty', 'absent'))
def test_optional_empty_streams_make_valid_empty_packs(tmp_path, mode):
    base, _ = load_manifest(EXAMPLE, r)
    for key, field in (('checkins', 'check_ins'), ('practice', 'questions'), ('revise', 'cards')):
        if mode == 'empty':
            base['declared'][key][field] = []
        else:
            base['declared'].pop(key)
            base['file_identity'].pop(key)
    run = runner(tmp_path, base)
    invoke(run)
    assert report(tmp_path, r)['status'] == 'complete'
    assert len(run.ledger['calls']) == 9
    assert [batch['stream'] for batch in read(tmp_path/'views/batches.json')] == ['teaching']*3
    assert read(tmp_path/'artifacts/practice_hi.json')['items'] == []
    assert read(tmp_path/'artifacts/revise_hi.json')['items'] == []
    assert len(read(tmp_path/'artifacts/deck_hi.json')['items']) == 12


def test_interrupted_between_roles_resume_and_raw_byte_freeze(tmp_path, monkeypatch):
    run = runner(tmp_path)
    original = run.role

    def stop(role, data):
        if role == 'translate_feedback_b001_review':
            raise KeyboardInterrupt
        return original(role, data)

    monkeypatch.setattr(run, 'role', stop)
    with pytest.raises(KeyboardInterrupt):
        invoke(run)
    assert len(run.ledger['calls']) == 16
    prior = {p.name: p.read_bytes() for p in (tmp_path/'requests').glob('*.json')}
    resumed = Runner(tmp_path, r, resume=True)
    invoke(resumed)
    assert report(tmp_path, r)['status'] == 'complete'
    assert len(resumed.ledger['calls']) == len({c['key'] for c in resumed.ledger['calls']}) == 21
    assert all((tmp_path/'requests'/name).read_bytes() == data for name, data in prior.items())
    frozen = tmp_path/'inputs'/resumed.bundle['file_identity']['deck']['file']
    before = read(frozen)
    frozen.write_bytes(frozen.read_bytes()+b'\n ')
    assert read(frozen) == before  # parsed equality must not hide a changed source byte identity
    with pytest.raises(ValueError, match='Frozen declared file changed'):
        Runner(tmp_path, r, resume=True)


def test_interrupted_inflight_call_cannot_resend(tmp_path, monkeypatch):
    original = Fixture.invoke

    def stop(self, request, *, role, notes_pages):
        if role == 'translate_checkin_b001_author':
            raise KeyboardInterrupt
        return original(self, request, role=role, notes_pages=notes_pages)

    monkeypatch.setattr(Fixture, 'invoke', stop)
    run = runner(tmp_path)
    with pytest.raises(KeyboardInterrupt):
        invoke(run)
    assert len(run.ledger['calls']) == 10
    assert report(tmp_path, r)['status'] == 'partial_or_failed'
    with pytest.raises(RuntimeError, match='manual reconciliation required; no repeat'):
        invoke(Runner(tmp_path, r, resume=True))
    assert len(read(tmp_path/'synthetic-ledger.json')['calls']) == 10


def test_native_example_lineage_has_exact_predecessor_artifact_bytes():
    lineage = read(EXAMPLE.parent/'lineage.json')
    assert lineage['synthetic'] is True
    assert {name: p['requests'] for name, p in lineage['predecessors'].items()} == {
        'explain': 16, 'practice': 5, 'revise': 8}
    for predecessor in lineage['predecessors'].values():
        assert predecessor['status'] == 'complete' and predecessor['synthetic'] is True
        assert predecessor['exposure_usd'] == 0
        assert len(predecessor['input_sha256']) == 64
    for name, digest in lineage['artifact_sha256'].items():
        assert sha((EXAMPLE.parent/name).read_bytes()) == digest
    source, _ = load_manifest(EXAMPLE, r)
    assert [len(source['declared'][name][field]) for name, field in
            (('deck', 'cards'), ('checkins', 'check_ins'), ('practice', 'questions'), ('revise', 'cards'))] == [12, 6, 8, 1]
    assert read(EXAMPLE.parent/'r5-slim-index-map.json')['mapping'] == [
        {'old_card_idx': i, 'local_card_idx': i} for i in range(1, 13)]


def test_prompt_manifest_exact_snapshots_adaptations_and_unified_diffs():
    manifest = read(ROOT/'prompts/translate/manifest.json')
    assert manifest['source_commit'] == '0000000000000000000000000000000000000000'
    assert {(e['family'], e['role']) for e in manifest['prompts']} == {
        (family, role) for family in ('translation', 'question', 'feedback', 'revise')
        for role in ('author', 'verify', 'fixer')}
    assert len(manifest['prompts']) == 12
    for entry in manifest['prompts']:
        source = ROOT/entry['source_snapshot_path']
        adapted = ROOT/entry['adapted_path']
        diff = ROOT/entry['diff_path']
        assert sha(source.read_bytes()) == entry['source_sha256']
        assert sha(adapted.read_bytes()) == entry['adapted_sha256']
        assert sha(diff.read_bytes()) == entry['diff_sha256']
        exact = ''.join(difflib.unified_diff(
            source.read_text().splitlines(True), adapted.read_text().splitlines(True),
            fromfile='a/'+entry['source_path'], tofile='b/'+entry['adapted_path']))
        assert diff.read_text() == exact
