"""Revise engineering plumbing: synthetic sentinels, SDK/network forbidden."""
import builtins
from copy import deepcopy
import difflib
import json
from pathlib import Path
import socket
import sys
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import run_factory as cli
from reference.factories import revise as r
from reference.factories.revise_fixture import MARKER, payload
from reference.inputs import ROOT, canonical, load_manifest, read, save, sha
from reference.providers import Fixture
from reference.runtime import Runner, report

EXAMPLE = ROOT/'examples/revise/manifest.json'
CONFIG = {'provider': 'fixture', 'image_limit': 3}


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
    for key in list(__import__('os').environ):
        if key.startswith(('AWS_', 'BEDROCK_', 'OPENAI_', 'ANTHROPIC_', 'LANGSMITH_', 'LANGCHAIN_')):
            monkeypatch.delenv(key)


def runner(workspace, bundle=None):
    source, blobs = load_manifest(EXAMPLE, r)
    workspace.mkdir(exist_ok=True)
    return Runner(workspace, r, bundle=deepcopy(source if bundle is None else bundle), blobs=blobs, config=CONFIG)


def invoke(run):
    return r.graph(run).invoke({'last_role': 'start'})


def response(value):
    return {'output': {'message': {'content': [{'text': json.dumps(value)}]}}, 'stopReason': 'end_turn'}


def test_cli_graph_mapping_final_owner_and_zero_repeat_resume(tmp_path):
    assert cli.main(['verify', str(EXAMPLE)]) == 0
    assert cli.main(['run', str(EXAMPLE), '--provider', 'fixture', '--workspace', str(tmp_path)]) == 0
    summary = read(tmp_path/'summary.json')
    assert summary['status'] == 'complete' and summary['requests'] == 8
    assert summary['exposure_usd'] == 0 and not (tmp_path/'ledger.json').exists()
    assert tuple(summary['roles']) == r.ROLES
    mapping = read(tmp_path/'views/explain-index-map.json')['mapping']
    assert [(v['old_card_idx'], v['local_card_idx']) for v in mapping] == [(5,1),(6,None),(7,2),(11,3)]
    deck = read(tmp_path/'views/explain-deck.json')
    assert [c['card_idx'] for c in deck['cards']] == [1,2,3]
    refs = read(tmp_path/'views/reference-identity.json')
    assert refs['projection_sha256']['explain-deck'] == sha(canonical(deck))
    assert refs['source_file_sha256']['deck'] == sha((EXAMPLE.parent/'deck.json').read_bytes())
    selected = read(tmp_path/'artifacts/selected-draft.json')
    assert selected == read(tmp_path/'checkpoints/revise_author_a.json')['output']['artifact']
    final = read(tmp_path/'checkpoints/revise_final.json')['output']
    assert read(tmp_path/'artifacts/revise_deck.json') == final['artifact'] != selected
    assert len(final['artifact']['cards']) == 1 and final['dispositions'][0]['action'] == 'declined'
    assert read(tmp_path/'diagnostics/selection.json')['winner'] == 'A'
    html = (tmp_path/'report.html').read_text()
    assert all(s in html for s in ('revise_final','revise_deck.json','declined','advisory'))
    requests = {p.name:p.read_bytes() for p in (tmp_path/'requests').glob('*.json')}
    (tmp_path/'artifacts/revise_deck.json').unlink()
    assert cli.main(['resume','--workspace',str(tmp_path)]) == 0
    assert read(tmp_path/'artifacts/revise_deck.json') == final['artifact']
    assert read(tmp_path/'summary.json')['requests'] == 8
    assert requests == {p.name:p.read_bytes() for p in (tmp_path/'requests').glob('*.json')}


def test_native_and_portable_guideline_projection_exact_text_and_page_counts(tmp_path):
    base, _ = load_manifest(EXAMPLE, r)
    g1 = r.guideline_view(base)
    raw = base['declared']['guideline']
    assert g1['guideline_text'] == '\n\n'.join(s['guidelines'] for s in raw['sections'])
    assert g1['sections'][0]['section_key'] == raw['sections'][0]['topic_key']
    assert [s['page_count'] for s in g1['sections']] == [3,2]
    native = deepcopy(base)
    native['declared']['guideline'] = {'topic':'SYNTHETIC NATIVE', 'grade':999, 'guideline_text':'  EXACT\nTEXT  ',
        'sections':[{'section_key':'exact-key','title':'EXACT TITLE','page_count':7}]}
    view = r.guideline_view(native)
    assert view['grade'] == 4 and view['guideline_text'] == '  EXACT\nTEXT  '
    assert view['sections'] == [{'section_key':'exact-key','title':'EXACT TITLE','page_count':7}]
    run = runner(tmp_path, native)
    invoke(run)
    assert report(tmp_path,r)['status'] == 'complete'
    for count in (None, 0, -1, True, '7'):
        bad = deepcopy(native)
        bad['declared']['guideline']['sections'][0]['page_count'] = count
        assert 'page_count' not in r.guideline_view(bad)['sections'][0]


def test_mixed_native_sections_preserve_only_supplied_text_and_unique_keys():
    base, _ = load_manifest(EXAMPLE,r)
    base['declared']['guideline'] = {'topic':'SYNTHETIC', 'guideline_text':'TOP EXACT', 'sections':[
        {'section_key':'one','title':'ONE'}, {'section_key':'two','title':'TWO','guideline_text':'EXACT SECTION'}]}
    view = r.guideline_view(base)
    assert 'guideline_text' not in view['sections'][0]
    assert view['sections'][1]['guideline_text'] == 'EXACT SECTION'
    base['declared']['guideline']['sections'][1]['section_key'] = 'one'
    with pytest.raises(ValueError, match='unique'): r.validate_inputs(base)


@pytest.mark.parametrize('change', ('missing','null','empty','checkins_only','duplicate','bad_lines'))
def test_unusable_explain_fails_before_provider_and_workspace(tmp_path, monkeypatch, change):
    value = read(EXAMPLE)
    value['files']['guideline']['path'] = str(EXAMPLE.parent/'guideline.json')
    deck = read(EXAMPLE.parent/'deck.json')
    if change == 'missing': value['files'].pop('deck')
    else:
        if change == 'null': deck = None
        elif change == 'empty': deck['cards'] = []
        elif change == 'checkins_only': deck['cards'] = [deck['cards'][1]]
        elif change == 'duplicate': deck['cards'][2]['card_idx'] = 5
        elif change == 'bad_lines': deck['cards'][0]['lines'] = [{'display':'missing audio'}]
        save(tmp_path/'deck.json', deck)
        value['files']['deck']['path'] = 'deck.json'
    save(tmp_path/'manifest.json', value)
    monkeypatch.setattr(cli, 'Runner', lambda *a,**k: pytest.fail('Provider/Runner before validation'))
    with pytest.raises(ValueError):
        cli.main(['run',str(tmp_path/'manifest.json'),'--provider','fixture','--workspace',str(tmp_path/'run')])
    assert not (tmp_path/'run').exists()


def test_declared_only_isolation_blind_selection_and_independent_lenses(tmp_path, monkeypatch):
    base, _ = load_manifest(EXAMPLE,r)
    monkeypatch.setenv('PRIVATE_OPERATOR_HISTORY','PRIVATE_ENV_SENTINEL')
    base['declared']['guideline']['operator'] = 'PRIVATE_OPERATOR_SENTINEL'
    base['declared']['deck']['production_id'] = 'PRIVATE_ID_SENTINEL'
    for card in base['declared']['deck']['cards']:
        card['visual_explanation'] = 'PRIVATE_CODE_SENTINEL'
        card['lines'][0]['audio_url'] = 'PRIVATE_PATH_SENTINEL'
        card['check_in'] = {'hint':'PRIVATE_CHECKIN_SENTINEL','correct_index':0}
    run = runner(tmp_path,base)
    invoke(run)
    requests = {p.stem:read(p) for p in (tmp_path/'requests').glob('*.json')}
    for forbidden in ('PRIVATE_ENV_SENTINEL','PRIVATE_OPERATOR_SENTINEL','PRIVATE_ID_SENTINEL',
                      'PRIVATE_CODE_SENTINEL','PRIVATE_PATH_SENTINEL','PRIVATE_CHECKIN_SENTINEL',
                      'AGENTS.md','SKILL.md',str(tmp_path),'PRIVATE_AUTHOR_NOTE'):
        assert forbidden not in json.dumps(requests,ensure_ascii=False)
    assert requests['revise_author_a'] == requests['revise_author_b']
    judge = payload(requests['revise_selection'])
    assert set(judge['candidates']) == {'A','B'}
    assert all(set(v)=={'cards'} for v in judge['candidates'].values())
    for lens in r.LENSES:
        data = payload(requests['revise_'+lens])
        assert set(data) == {'guideline','explain_deck','deck'}
        assert data['deck'] == judge['candidates']['A']
        assert len(requests['revise_'+lens]['messages']) == 1
        assert set(requests['revise_'+lens]['messages'][0]['content'][0]) == {'text'}
    final = payload(requests['revise_final'])
    assert len(final['accepted_findings']) == 2
    assert final['reviews']['lightness']['ok'] is False
    assert final['reviews']['easy_english']['findings'] == []
    assert all('section_key' not in c for c in final['explain_deck']['cards'])  # source-facing slim fields


def test_blind_b_verdict_selects_exact_b(tmp_path,monkeypatch):
    original = Fixture.invoke
    def b(self,request,*,role,notes_pages):
        return response({'winner':'B','margin':'clear','reasons':[MARKER]}) if role=='revise_selection' else original(self,request,role=role,notes_pages=notes_pages)
    monkeypatch.setattr(Fixture,'invoke',b)
    run=runner(tmp_path); invoke(run)
    assert read(tmp_path/'artifacts/selected-draft.json') == run.output('revise_author_b')['artifact']
    assert payload(read(tmp_path/'requests/revise_final.json'))['deck'] == run.output('revise_author_b')['artifact']


@pytest.mark.parametrize('failed',r.AUTHORS)
def test_single_author_survives_and_skips_selector_without_retry(tmp_path,monkeypatch,failed):
    original=Fixture.invoke
    def fail(self,request,*,role,notes_pages):
        if role==failed: raise RuntimeError('PRIVATE PROVIDER FAILURE')
        return original(self,request,role=role,notes_pages=notes_pages)
    monkeypatch.setattr(Fixture,'invoke',fail)
    run=runner(tmp_path); invoke(run)
    surviving = next(x for x in r.AUTHORS if x!=failed)
    assert read(tmp_path/'artifacts/selected-draft.json') == run.output(surviving)['artifact']
    assert not (tmp_path/'requests/revise_selection.json').exists()
    summary=report(tmp_path,r)
    assert summary['status']=='complete' and summary['requests']==7
    assert failed not in summary['roles'] and any(failed in x for x in summary['observations'])
    assert read(tmp_path/'diagnostics/selection.json')['author_status'][failed]=='technical_failure'
    assert 'PRIVATE PROVIDER FAILURE' not in (tmp_path/'report.html').read_text()
    invoke(Runner(tmp_path,r,resume=True))
    assert len(read(tmp_path/'synthetic-ledger.json')['calls'])==7


def test_unusable_author_cards_survive_but_both_failed_stops(tmp_path,monkeypatch):
    original=Fixture.invoke
    def fail(self,request,*,role,notes_pages):
        return response({'artifact':{'receipt':True}}) if role in r.AUTHORS else original(self,request,role=role,notes_pages=notes_pages)
    monkeypatch.setattr(Fixture,'invoke',fail)
    run=runner(tmp_path)
    with pytest.raises(ValueError,match='Both Revise authors failed'): invoke(run)
    assert len(run.ledger['calls'])==3 and not (tmp_path/'artifacts/revise_deck.json').exists()
    assert report(tmp_path,r)['status']=='partial_or_failed'
    with pytest.raises(ValueError): invoke(Runner(tmp_path,r,resume=True))
    assert len(read(tmp_path/'synthetic-ledger.json')['calls'])==3


def test_empty_findings_still_run_final_once(tmp_path,monkeypatch):
    original=Fixture.invoke
    def empty(self,request,*,role,notes_pages):
        if role[7:] in r.LENSES: return response({'findings':[]})
        if role=='revise_final':
            data=payload(request)
            assert data['accepted_findings']==data['indexed_findings']==[]
            return response({'artifact':data['deck'],'notes':MARKER})
        return original(self,request,role=role,notes_pages=notes_pages)
    monkeypatch.setattr(Fixture,'invoke',empty)
    run=runner(tmp_path); invoke(run)
    assert read(tmp_path/'artifacts/revise_deck.json') == read(tmp_path/'artifacts/selected-draft.json')
    assert sum(c['role']=='revise_final' for c in run.ledger['calls'])==1


def test_source_accepted_subset_keeps_raw_minor_duplicates_and_lens_evidence():
    item={'card_idx':1,'issue':'x'*70,'severity':'major'}
    outputs={'revise_lightness':{'findings':[item,{**item,'severity':'minor'}]},
             'revise_accuracy':{'findings':[{**item,'issue':'x'*60+'different'}, {'card_idx':2,'issue':'y','severity':'critical'}]},
             'revise_easy_english':{'findings':[]}}
    class Fake:
        def output(self,role): return outputs[role]
    data=r.feedback(Fake())
    assert len(data['indexed_findings'])==4 and len(data['accepted_findings'])==2
    assert data['reviews']=={'lightness':outputs['revise_lightness'],'accuracy':outputs['revise_accuracy'],'easy_english':outputs['revise_easy_english']}
    assert [f['index'] for f in data['accepted_findings']]==[0,3]


@pytest.mark.parametrize('artifact', ({'cards':[]}, {'cards':[{'idx':91,'answer':{'display':'imperfect'}}]*26}, {'unexpected':MARKER}))
def test_imperfect_final_author_artifact_is_unchanged(tmp_path,monkeypatch,artifact):
    original=Fixture.invoke
    def final(self,request,*,role,notes_pages):
        return response({'artifact':artifact,'notes':MARKER}) if role=='revise_final' else original(self,request,role=role,notes_pages=notes_pages)
    monkeypatch.setattr(Fixture,'invoke',final)
    run=runner(tmp_path); invoke(run)
    assert read(tmp_path/'artifacts/revise_deck.json') == artifact
    assert report(tmp_path,r)['status']=='complete'
    assert len(run.ledger['calls'])==8


@pytest.mark.parametrize('failed',('revise_select','revise_selection','revise_accuracy','revise_final'))
def test_required_technical_failure_no_retry_or_substitution(tmp_path,monkeypatch,failed):
    original=Fixture.invoke
    def fail(self,request,*,role,notes_pages):
        return response({'artifact':'unusable receipt'}) if role==failed else original(self,request,role=role,notes_pages=notes_pages)
    monkeypatch.setattr(Fixture,'invoke',fail)
    run=runner(tmp_path)
    with pytest.raises(ValueError,match='unavailable'): invoke(run)
    assert report(tmp_path,r)['status']=='partial_or_failed'
    assert not (tmp_path/'artifacts/revise_deck.json').exists()
    before=len(run.ledger['calls'])
    with pytest.raises(ValueError): invoke(Runner(tmp_path,r,resume=True))
    assert len(read(tmp_path/'synthetic-ledger.json')['calls'])==before


def test_partial_resume_preserves_sequence_and_frozen_inputs(tmp_path,monkeypatch):
    run=runner(tmp_path); original=run.role
    def stop(role,data):
        if role=='revise_accuracy': raise KeyboardInterrupt
        return original(role,data)
    monkeypatch.setattr(run,'role',stop)
    with pytest.raises(KeyboardInterrupt): invoke(run)
    assert len(run.ledger['calls'])==5
    resumed=Runner(tmp_path,r,resume=True); invoke(resumed)
    assert len(resumed.ledger['calls'])==8 and len({c['key'] for c in resumed.ledger['calls']})==8
    frozen=read(tmp_path/'inputs.json'); frozen['declared']['deck']['cards'][0]['title']='CHANGED'
    save(tmp_path/'inputs.json',frozen)
    with pytest.raises(RuntimeError,match='Frozen inputs changed'): Runner(tmp_path,r,resume=True)


def test_prompts_render_grade_and_exclude_gate():
    for name in ('select_concepts','author','judge_ab','reviewer','refiner'):
        assert '{grade}' not in r.request(type('Run',(),{'bundle':{'metadata':{'grade':4}}})(),next(k for k,v in r.PROMPTS.items() if v==name),{},[],[],True)['messages'][0]['content'][0]['text']
    assert not (ROOT/'prompts/revise/judge_gate.md').exists()
