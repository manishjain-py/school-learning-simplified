"""Practice engineering plumbing with SDK/network forbidden; never semantic-quality proof."""
import builtins
from copy import deepcopy
import difflib
from fractions import Fraction
import json
from pathlib import Path
import socket
import sys
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import run_factory as cli
from reference.factories import practice as p
from reference.factories.practice_fixture import MARKER, payload
from reference.inputs import ROOT, canonical, load_manifest, read, save, sha
from reference.providers import Fixture
from reference.runtime import Runner, report

EXAMPLE = ROOT/'examples/practice/manifest.json'
CONFIG = {'provider': 'fixture', 'image_limit': 3}


@pytest.fixture(autouse=True)
def offline(monkeypatch):
    original = builtins.__import__
    def no_sdk(name, *args, **kwargs):
        if name.split('.')[0] in ('boto3', 'botocore'):
            raise AssertionError('No SDK import/client permitted')
        return original(name, *args, **kwargs)
    def forbidden(*args, **kwargs):
        raise AssertionError('No network permitted')
    monkeypatch.setattr(builtins, '__import__', no_sdk)
    for name in ('connect', 'connect_ex', 'send', 'sendall', 'sendto'):
        monkeypatch.setattr(socket.socket, name, forbidden)
    monkeypatch.setattr(socket, 'create_connection', forbidden)


def runner(workspace, bundle=None, manifest=EXAMPLE):
    source, blobs = load_manifest(manifest, p)
    workspace.mkdir(exist_ok=True)
    return Runner(workspace, p, bundle=deepcopy(bundle or source), blobs=blobs, config=CONFIG)


def invoke(run):
    return p.graph(run).invoke({'last_role': 'start'})


def response(value, stop='end_turn'):
    return {'output': {'message': {'content': [{'text': json.dumps(value)}]}}, 'stopReason': stop}


def blueprint(run):
    invoke(run)
    return read(run.workspace/'views/blueprint.json')


def test_cli_graph_allocation_dedupe_final_author_resume_and_bank_immutable(tmp_path):
    before = (EXAMPLE.parent/'bank.json').read_bytes()
    assert cli.main(['verify', str(EXAMPLE)]) == 0
    assert cli.main(['run', str(EXAMPLE), '--provider', 'fixture', '--workspace', str(tmp_path)]) == 0
    assert (EXAMPLE.parent/'bank.json').read_bytes() == before
    summary = read(tmp_path/'summary.json')
    assert summary['status'] == 'complete' and summary['requests'] == 5
    assert summary['exposure_usd'] == 0 and not (tmp_path/'ledger.json').exists()
    assert set(summary['roles']) == {'practice_blueprint', 'practice_slot_1', 'practice_slot_2', 'practice_review', 'practice_final'}
    allocation = read(tmp_path/'diagnostics/allocation.json')['slots']
    assert sum(s['count'] for s in allocation) == 10
    assert sum(s['difficulty']['easy'] for s in allocation) == 3  # existing 1 easy -> future 4/7 deal
    dropped = read(tmp_path/'diagnostics/dedupe.json')
    assert dropped['dropped'] == 1 and dropped['drop_reasons'][0]['reason'] == 'signature'
    final = read(tmp_path/'checkpoints/practice_final.json')['output']
    assert read(tmp_path/'artifacts/questions.json') == final['artifact']
    metrics = read(tmp_path/'metrics/practice-run.json')
    assert metrics['final_count'] == 8 and metrics['shortfall'] == 2
    combined = read(tmp_path/'artifacts/bank-snapshot.json')['questions']
    assert combined == read(EXAMPLE.parent/'bank.json')['questions']+final['artifact']['questions']
    assert any(d['action'] == 'declined' for d in final['dispositions'])
    html = (tmp_path/'report.html').read_text()
    assert 'practice_slot_2' in html and 'holistic_pass' in html and 'shortfall' in html
    request_bytes = {f.name: f.read_bytes() for f in (tmp_path/'requests').glob('*.json')}
    (tmp_path/'artifacts/questions.json').unlink()
    assert cli.main(['resume', '--workspace', str(tmp_path)]) == 0
    assert read(tmp_path/'artifacts/questions.json') == final['artifact']
    assert read(tmp_path/'summary.json')['requests'] == 5
    assert request_bytes == {f.name: f.read_bytes() for f in (tmp_path/'requests').glob('*.json')}


def test_seed_and_target_already_reached_noop_and_offline_report(tmp_path):
    seed = runner(tmp_path/'seed', manifest=EXAMPLE.parent/'seed-manifest.json')
    invoke(seed)
    assert len(seed.ledger['calls']) == 5
    have = read(seed.workspace/'diagnostics/census.json')
    assert have['active_total'] == 0
    no_op = runner(tmp_path/'noop', manifest=EXAMPLE.parent/'noop-manifest.json')
    invoke(no_op)
    assert no_op.ledger['calls'] == []
    assert report(no_op.workspace, p)['status'] == 'complete'
    assert report(no_op.workspace, p)['roles'] == {}
    assert read(no_op.workspace/'metrics/practice-run.json')['status'] == 'no_op'
    assert read(no_op.workspace/'artifacts/questions.json') == {'questions': []}
    assert read(no_op.workspace/'artifacts/bank-snapshot.json') == read(EXAMPLE.parent/'bank.json')
    invoke(Runner(no_op.workspace, p, resume=True))
    assert read(no_op.ledger_path)['calls'] == []


def test_target_growth_cap_and_explicit_modes_rejected_before_provider(tmp_path):
    base, _ = load_manifest(EXAMPLE, p)
    base['metadata'].pop('add')
    base['metadata']['target'] = 11
    run = runner(tmp_path, base)
    invoke(run)
    assert read(tmp_path/'diagnostics/allocation.json')['requested_addition'] == 10
    for changes in ({'target': 12}, {'add': 1}, {'run_cap': 0}, {'mode': 'exact-add'}, {'mode': 'adoptBatch'}, {'target': True}):
        bad = deepcopy(base)
        bad['metadata'].update(changes)
        with pytest.raises(ValueError):
            p.validate_inputs(bad)


def test_weighted_future_deficits_focus_small_runs_tiers_and_slot_bound(tmp_path):
    run = runner(tmp_path)
    bp = blueprint(run)
    a, b = bp['skills']
    # A is saturated while B is deficient; a tiny run concentrates on B.
    have = {'active_total': 10, 'by_skill': {a['skill_key']: {'easy': 10, 'medium': 0, 'hard': 0}},
            'active_by_difficulty': {'easy': 10, 'medium': 0, 'hard': 0}}
    slots = p.allocate(bp, 2, have)
    assert len(slots) == 1 and slots[0]['skill_key'] == b['skill_key']
    assert slots[0]['difficulty'] == {'easy': 0, 'medium': 2}
    # With no bank and 30 additions, 2:1 weights allocate 20/10 and split at eight.
    slots = p.allocate(bp, 30, p.census([]))
    assert sum(s['count'] for s in slots if s['skill_key'] == a['skill_key']) == 20
    assert sum(s['count'] for s in slots if s['skill_key'] == b['skill_key']) == 10
    assert all(0 < s['count'] <= 8 and sum(s['difficulty'].values()) == s['count'] for s in slots)
    assert sum(s['difficulty']['easy'] for s in slots) == 12
    assert sum(s['difficulty']['medium'] for s in slots) == 18
    assert len({tuple(s['formats']) for s in slots}) > 1
    assert all('multi_select' in s['formats'] for s in slots)
    assert p.largest_remainder([Fraction(1,3), Fraction(2,3)], 5) == [2,3]
    assert p.largest_remainder([1,1,1], 2) == [1,1,0]


def test_200_additions_actual_graph_recursion_and_cap(tmp_path):
    bundle, _ = load_manifest(EXAMPLE.parent/'seed-manifest.json', p)
    bundle['metadata'].update(add=200, run_cap=200)
    run = runner(tmp_path, bundle)
    invoke(run)
    slots = read(tmp_path/'diagnostics/allocation.json')['slots']
    assert sum(s['count'] for s in slots) == 200
    assert len(run.ledger['calls']) == len(slots)+3
    assert report(tmp_path, p)['status'] == 'complete'


def test_dedupe_identity_signature_params_and_empty_params():
    def row(text, sig, params=None, **extra):
        return {'format': 'pick_one', 'question_text': text, 'signature': sig, 'skill_key': ' a--x ', 'params': params or {}, **extra}
    bank = [row(' BANK   TEXT ', ' A | b | c | d '), row('Other', 'other', {'numbers': [2,3], 'nested': {'b':2,'a':1}})]
    drafts = [row('bank text', 'new-1'), row('new', 'a | b | c | d'),
              row('params collision', 'new-2', {'nested': {'a':1,'b':2}, 'numbers': [2,3]}, skill_key='A--X'),
              row('shared', 'tf-one', format='true_false', statement='Claim A'),
              row('shared', 'tf-two', format='true_false', statement='Claim B'),
              row('shared', 'tf-three', format='true_false', statement=' CLAIM   a '),
              row('unique-1', 'unique-1'), row('unique-2', 'unique-2'),
              row('batch sig clash', ' UNIQUE-1 '),
              row('fallback', 'fallback', format='true_false', statement=''), row(' FALLBACK ', 'fallback2')]
    original = deepcopy(drafts)
    pack, diag = p.dedupe(drafts, bank)
    assert drafts == original
    assert [d['reason'] for d in diag['drop_reasons']] == ['question_identity','signature','skill_params','question_identity','signature','question_identity']
    assert len(pack['questions']) == 5  # two shared captions survive with different claims; {} never collides
    assert p.identity({'format':'true_false','statement':'','question_text':' Fallback '}) == 'fallback'


def test_findings_use_original_signature_never_caption():
    batch = {'questions': [{'question_text':'shared','signature':'old-a'}, {'question_text':'shared','signature':'old-b'}]}
    review = {'wrong': [{'signature':'old-b', 'question_text':'shared', 'fix':'new-b'}, {'signature':'new-b'}, {'question_text':'shared'}]}
    locators = p.locate_findings(batch, review)
    assert locators[0]['question_indices'] == [1]
    assert locators[1]['resolution'] == locators[2]['resolution'] == 'unmatched'
    batch['questions'].append({'signature':'old-b'})
    assert p.locate_findings(batch, review)[0]['resolution'] == 'ambiguous'


def test_isolation_slot_slice_digest_no_deck_operational_data_or_peer_drafts(tmp_path, monkeypatch):
    monkeypatch.setenv('PRIVATE_OPERATOR_HISTORY', 'PRIVATE_ENV_SENTINEL')
    bundle, _ = load_manifest(EXAMPLE, p)
    bundle['declared']['guideline']['operator'] = 'PRIVATE_OPERATOR_SENTINEL'
    bundle['declared']['deck']['private_path'] = 'PRIVATE_PATH_SENTINEL'
    bundle['declared']['deck']['cards'][0]['visual'] = 'PRIVATE_CODE_SENTINEL'
    bundle['declared']['bank']['questions'][0]['database_id'] = 'PRIVATE_DATABASE_SENTINEL'
    run = runner(tmp_path, bundle)
    invoke(run)
    requests = {f.stem: read(f) for f in (tmp_path/'requests').glob('*.json')}
    for prohibited in ('PRIVATE_ENV_SENTINEL','PRIVATE_OPERATOR_SENTINEL','PRIVATE_PATH_SENTINEL','PRIVATE_CODE_SENTINEL',
                       'PRIVATE_DATABASE_SENTINEL','AGENTS.md','SKILL.md',str(tmp_path),'bank.json'):
        assert prohibited not in json.dumps(requests)
    for role in ('practice_slot_1', 'practice_slot_2'):
        data = payload(requests[role])
        assert set(data) == {'grade','subject','topic','skill','guideline_section','digest','quota','existing_signatures'}
        assert data['skill']['section_key'] == data['guideline_section']['section_key']
        assert not {'deck','guideline','batch','other_authors'}.intersection(data)
        assert len(requests[role]['messages']) == 1 and set(requests[role]['messages'][0]['content'][0]) == {'text'}
    review = payload(requests['practice_review'])
    final = payload(requests['practice_final'])
    assert review['batch'] == final['batch']
    assert final['review'] == run.output('practice_review')
    assert final['original_signature_locators'][0]['resolution'] == 'unique'
    changed = run.output('practice_final')['artifact']['questions'][0]['signature']
    assert changed != final['review']['wrong'][0]['signature']
    assert final['original_signature_locators'][0]['original_signature'] == final['review']['wrong'][0]['signature']


def test_cached_blueprint_exact_file_hashes_no_model_blueprint_and_small_counts(tmp_path):
    original = runner(tmp_path/'original')
    invoke(original)
    bundle, _ = load_manifest(EXAMPLE, p)
    cache = read(original.workspace/'artifacts/blueprint-cache.json')
    assert len(cache['blueprint']['skills']) == 2 and len(cache['blueprint']['theme_wheel']) == 2
    bundle['declared']['blueprint'] = cache
    bundle['file_identity']['blueprint'] = {'type':'json', 'sha256':sha(canonical(cache))}
    run = runner(tmp_path/'cached', bundle)
    invoke(run)
    assert len(run.ledger['calls']) == 4
    assert 'practice_blueprint' not in report(run.workspace,p)['roles']
    for slot in ('guideline_sha256','deck_sha256'):
        bad = deepcopy(bundle)
        bad['declared']['blueprint']['source_hashes'][slot] = 'changed'
        with pytest.raises(ValueError, match='hashes'):
            p.validate_inputs(bad)


def test_missing_labels_and_input_shapes_not_fabricated(tmp_path):
    bundle, _ = load_manifest(EXAMPLE, p)
    for mutate in (lambda b: b['declared']['bank']['questions'][0].pop('signature'),
                   lambda b: b['declared']['guideline'].update(sections=[]),
                   lambda b: b['declared']['deck'].update(cards=[])):
        bad = deepcopy(bundle)
        mutate(bad)
        with pytest.raises(ValueError): p.validate_inputs(bad)
    with pytest.raises(ValueError): p.parse('practice_final', '{"artifact":"receipt"}')
    with pytest.raises(ValueError): p.parse('practice_review', '{"wrong":[],"holistic_pass":true}')
    with pytest.raises(ValueError): p.parse('practice_final', '{"artifact":')
    assert p.parse('practice_final', '{"artifact":{"unexpected":"preserved"}}')['artifact'] == {'unexpected':'preserved'}


def test_final_author_duplicate_invalid_native_fields_and_overcount_preserved(tmp_path, monkeypatch):
    original = Fixture.invoke
    authoritative = {'questions':[{'signature':'duplicate','format':'imperfect','correct_answer':True}]*12, 'unknown':MARKER}
    def final(self, request, *, role, notes_pages):
        return response({'artifact':authoritative,'dispositions':[{'action':'declined','reason':MARKER}]}) if role == 'practice_final' else original(self,request,role=role,notes_pages=notes_pages)
    monkeypatch.setattr(Fixture, 'invoke', final)
    run = runner(tmp_path)
    invoke(run)
    assert read(tmp_path/'artifacts/questions.json') == authoritative
    assert report(tmp_path,p)['status'] == 'complete'
    assert len(run.ledger['calls']) == 5
    assert read(tmp_path/'metrics/practice-run.json')['final_count'] == 12
    assert read(tmp_path/'metrics/practice-run.json')['shortfall'] == 0


def test_final_author_missing_native_questions_is_preserved_without_hidden_repair(tmp_path, monkeypatch):
    original = Fixture.invoke
    def final(self,request,*,role,notes_pages):
        return response({'artifact':{'unexpected':MARKER}}) if role == 'practice_final' else original(self,request,role=role,notes_pages=notes_pages)
    monkeypatch.setattr(Fixture,'invoke',final)
    run = runner(tmp_path)
    invoke(run)
    assert read(tmp_path/'artifacts/questions.json') == {'unexpected':MARKER}
    assert report(tmp_path,p)['status'] == 'complete'
    assert read(tmp_path/'metrics/practice-run.json')['final_count'] is None
    assert not (tmp_path/'artifacts/bank-snapshot.json').exists()


def test_failed_slot_stops_dependents_partial_report_and_no_retry_on_resume(tmp_path,monkeypatch):
    original = Fixture.invoke
    def fail(self,request,*,role,notes_pages):
        if role == 'practice_slot_1': raise RuntimeError('PRIVATE PROVIDER ERROR')
        return original(self,request,role=role,notes_pages=notes_pages)
    monkeypatch.setattr(Fixture,'invoke',fail)
    run=runner(tmp_path)
    with pytest.raises(ValueError,match='unavailable'): invoke(run)
    assert len(run.ledger['calls']) == 2
    assert report(tmp_path,p)['status'] == 'partial_or_failed'
    assert 'PRIVATE PROVIDER ERROR' not in (tmp_path/'report.html').read_text()
    resumed=Runner(tmp_path,p,resume=True)
    with pytest.raises(ValueError,match='unavailable'): invoke(resumed)
    assert len(resumed.ledger['calls']) == 2


def test_partial_resume_exact_request_sequence_and_no_repeat(tmp_path,monkeypatch):
    # Interrupt before a second slot is invoked, rather than after reserving it.
    run=runner(tmp_path)
    original_role=run.role
    def stop(role,data):
        if role == 'practice_slot_2': raise KeyboardInterrupt
        return original_role(role,data)
    monkeypatch.setattr(run,'role',stop)
    with pytest.raises(KeyboardInterrupt): invoke(run)
    assert len(run.ledger['calls']) == 2
    resumed=Runner(tmp_path,p,resume=True)
    invoke(resumed)
    assert len(resumed.ledger['calls']) == 5
    assert len({c['key'] for c in resumed.ledger['calls']}) == 5


def test_explicit_null_blueprint_rejected_before_transport_or_workspace(tmp_path):
    manifest = read(EXAMPLE)
    for spec in manifest['files'].values():
        spec['path'] = str(EXAMPLE.parent/spec['path'])
    save(tmp_path/'blueprint.json', None)
    manifest['files']['blueprint'] = {'path':'blueprint.json','type':'json'}
    save(tmp_path/'manifest.json', manifest)
    with pytest.raises(ValueError, match='Cached blueprint'):
        cli.main(['run',str(tmp_path/'manifest.json'),'--provider','fixture','--workspace',str(tmp_path/'run')])
    assert not (tmp_path/'run').exists()
