"""Synthetic plumbing fixtures only, never replacement educational content."""
import importlib.util
import json
from pathlib import Path
import sys
import pytest

spec=importlib.util.spec_from_file_location('g1',Path(__file__).parents[1]/'guideline.py')
g1=importlib.util.module_from_spec(spec);sys.modules['g1']=g1;spec.loader.exec_module(g1)


def inputs(tmp_path):
    path=tmp_path/'inputs';path.mkdir()
    pages=[]
    for number in range(57,62):
        data=b'synthetic-image-'+str(number).encode();file=f'{number}.jpeg';(path/file).write_bytes(data)
        pages.append({'file':file,'printed_page':number,'sha256':g1.digest(data),'format':'jpeg'})
    m={'metadata':{'grade':4,'chapter_number':7,'printed_pages':list(range(57,62))},'pages':pages}
    m['sha256']=g1.digest(g1.canonical(m));g1.save(path/'manifest.json',m)
    return tmp_path


def response(obj,stop='end_turn'):
    return {'output':{'message':{'content':[{'text':json.dumps(obj)}]}},'stopReason':stop,'usage':{'inputTokens':100,'outputTokens':200}}


class Client:
    def __init__(self,answers):self.answers=iter(answers);self.requests=[]
    def converse(self,**request):
        self.requests.append(request);answer=next(self.answers)
        if isinstance(answer,Exception):raise answer
        return answer


def notes():return {'page_notes':[{'printed_page':n,'observations':'SYNTHETIC TEST ONLY'} for n in (57,58,59)]}

def paired(answers):return [item for answer in answers for item in (response(notes()),answer)]

def chapter():return {'artifact':{'chapter_display_name':'SYNTHETIC TEST ONLY','sections':[{'guidelines':'sentinel'}]}}
def review():return {'ok':False,'findings':[{'issue':'synthetic blocker','evidence':'sentinel','fix':'sentinel','severity':'blocking'}],'note':'sentinel'}


def test_final_author_survives_all_negative_reviews_and_resume(tmp_path):
    client=Client(paired([response(chapter()),response(chapter()),response({'winner_index':1,'concerns':['sentinel'],'note':'low quality'}),*[response(review())]*3,response(chapter()),response({'artifact':{'skip_refresher':True,'skip_reason':'sentinel'}})]))
    e=g1.Experiment(inputs(tmp_path),'pilot',client=client)
    e.graph().invoke({'last_stage':'start'})
    assert len(client.requests)==16
    assert g1.read_json(e.run/'summary.json')['status']=='complete'
    assert 'topic_summary' in g1.read_json(e.run/'summary.json')['serialization_observations'][0]
    assert g1.read_json(e.run/'guideline.json')==chapter()['artifact']
    assert all(e.result(s)['status']=='ok' for s in g1.STAGES)
    assert 'gate' not in e.graph().get_graph().nodes
    # Deleting a derived output models crash after stage checkpoint but before artifact write.
    (e.run/'guideline.json').unlink()
    resumed=g1.Experiment(tmp_path,'pilot',client=Client([]),resume=True)
    resumed.graph().invoke({'last_stage':'start'})
    assert (e.run/'guideline.json').exists()
    assert len(g1.Ledger(tmp_path).data['calls'])==16


def test_reservation_crash_and_cap_survive_restart(tmp_path):
    ledger=g1.Ledger(tmp_path)
    call=ledger.reserve('pilot','draft_1','hash',8192)
    assert g1.Ledger(tmp_path).exposure()==call['reserved_usd']
    for i in range(39):ledger.reserve('pilot',str(i),'hash',8192)
    with pytest.raises(RuntimeError,match='cap'):
        ledger.reserve('pilot','extra','hash',8192)
    assert len(g1.Ledger(tmp_path).data['calls'])==40


def test_interrupted_call_cannot_silently_repeat(tmp_path):
    client=Client([]);e=g1.Experiment(inputs(tmp_path),'pilot',client=client)
    e.ledger.reserve('pilot','draft_1','hash',8192)
    with pytest.raises(RuntimeError,match='interrupted'):
        e.invoke('draft_1',{})
    assert client.requests==[]


def test_failure_is_truthful_and_not_replaced(tmp_path):
    client=Client([RuntimeError('synthetic transport failure'),RuntimeError('synthetic transport failure')])
    e=g1.Experiment(inputs(tmp_path),'pilot',client=client)
    e.graph().invoke({'last_stage':'start'})
    summary=g1.read_json(e.run/'summary.json')
    assert summary['status']=='partial_or_failed'
    assert len(client.requests)==2
    assert not (e.run/'guideline.json').exists()
    assert summary['actual_usd']==0
    assert summary['unreconciled_reserved_usd']>0
    assert e.result('revision')['status']=='failed'


def test_emitted_input_is_allowlisted_and_drafts_independent(tmp_path,monkeypatch):
    monkeypatch.setenv('AGENTS','NEVER_SEND_THIS_SENTINEL')
    workspace=inputs(tmp_path);m,images=g1.load_inputs(workspace)
    a=g1.build_request('draft_1',m,images[:3],{},phase='notes')
    b=g1.build_request('draft_2',m,images[:3],{},phase='notes')
    assert a==b # independent requests; neither sees the other's draft
    evidence=g1.request_evidence(a)
    text=json.dumps(evidence)
    assert 'NEVER_SEND_THIS_SENTINEL' not in text
    assert 'AGENTS.md' not in text and 'SKILL.md' not in text
    assert len([v for v in a['messages'][0]['content'] if 'image' in v])==3
    final=g1.build_request('draft_1',m,images[3:],{'sequential_page_notes':notes()['page_notes']})
    assert len([v for v in final['messages'][0]['content'] if 'image' in v])==2
    assert len(final['messages'])==1
    assert 'system' not in a and 'tools' not in a
    assert all('sha256' in v['image']['source']['bytes'] for v in evidence['messages'][0]['content'] if 'image' in v)


def test_frozen_identity_refuses_changed_input(tmp_path):
    e=g1.Experiment(inputs(tmp_path),'pilot',client=Client([]))
    (tmp_path/'inputs/57.jpeg').write_bytes(b'changed')
    with pytest.raises(ValueError,match='hash mismatch'):
        g1.Experiment(tmp_path,'pilot',client=Client([]),resume=True)


def test_bounded_format_recovery_keeps_usage(tmp_path):
    client=Client([response({'bad':'shape'}),response(chapter())])
    e=g1.Experiment(inputs(tmp_path),'pilot',client=client)
    assert e.invoke('draft_1',{})['status']=='ok'
    assert len(client.requests)==2
    assert len(e.ledger.data['calls'])==2
    assert all(c['actual_usd']>0 for c in e.ledger.data['calls'])


def test_private_failure_details_never_enter_content_or_html(tmp_path):
    e=g1.Experiment(inputs(tmp_path),'pilot',client=Client([]))
    g1.save(e.run/'draft_1.json',{'status':'ok','output':chapter()})
    g1.save(e.run/'selection.json',{'status':'ok','output':{'winner_index':1,'note':'sentinel','concerns':[]}})
    error='arn:aws:iam::123456789012:user/private-operator /Users/private-person/file'
    for name in ('coverage','accuracy','structure'):
        g1.save(e.run/(name+'.json'),{'status':'failed','error':error,'call_ids':[]})
    declared=e.declared('revision')
    assert '123456789012' not in json.dumps(declared)
    assert 'private-operator' not in json.dumps(declared)
    e.report()
    doc=(e.run/'report.html').read_text()
    assert '123456789012' not in doc and 'private-person' not in doc
    assert 'private-operator' not in doc
    assert error in (e.run/'summary.json').read_text() # exact private evidence preserved


def test_available_second_draft_preserves_original_index(tmp_path):
    e=g1.Experiment(inputs(tmp_path),'pilot',client=Client(paired([response({'winner_index':2,'concerns':[],'note':'sentinel'})])))
    g1.save(e.run/'draft_1.json',{'status':'failed','error':'sentinel'})
    g1.save(e.run/'draft_2.json',{'status':'ok','output':chapter()})
    declared=e.declared('selection')
    assert declared['candidates'][0]['index']==2
    e.stage('selection')
    assert e.selected()==chapter()['artifact']
    assert 'explicit `index` value' in (g1.ROOT/'prompts/chapter_judge.md').read_text()


def test_report_only_cannot_invoke_and_preserves_frozen_identity(tmp_path,monkeypatch):
    e=g1.Experiment(inputs(tmp_path),'pilot',client=Client([]))
    frozen=e.identity
    monkeypatch.setattr(g1,'runtime_identity',lambda:{'sha256':'new-renderer'})
    r=g1.Experiment(tmp_path,'pilot',resume=True,report_only=True)
    assert r.identity==frozen
    with pytest.raises(RuntimeError,match='cannot invoke'):
        r.invoke('probe',{})
    r.report()
    assert g1.read_json(r.run/'summary.json')['report_renderer']=='new-renderer'


def test_single_page_access_is_separate_and_cannot_run_factory(tmp_path):
    workspace=inputs(tmp_path)
    before=(workspace/'inputs/manifest.json').read_bytes()
    client=Client([response({'page_numbers':[57],'images_read':1})])
    e=g1.Experiment(workspace,'access-only',client=client,access_only=True)
    assert e.identity['input_sha256']!=e.identity['full_manifest_sha256']
    assert e.invoke('access_check',{})['status']=='ok'
    assert len(client.requests)==1
    assert sum('image' in c for c in client.requests[0]['messages'][0]['content'])==1
    assert 'ACCESS CHECK ONLY, NOT A CHAPTER RUN' in client.requests[0]['messages'][0]['content'][0]['text']
    assert (workspace/'inputs/manifest.json').read_bytes()==before
    with pytest.raises(RuntimeError,match='not a chapter factory'):
        e.graph()
    e.report()
    assert g1.read_json(e.run/'summary.json')['status']=='single_page_access_complete'
    assert '<h1>Single-page access check only</h1>' in (e.run/'report.html').read_text()


def test_batch_checkpoint_resume_covers_all_originals_without_old_image_history(tmp_path):
    client=Client([response(notes()),response(chapter())])
    e=g1.Experiment(inputs(tmp_path),'pilot',client=client)
    e.invoke('draft_1',{},phase='notes')
    assert len(client.requests)==1
    resumed_client=Client([response(chapter())])
    resumed=g1.Experiment(tmp_path,'pilot',client=resumed_client,resume=True)
    resumed.stage('draft_1')
    assert len(resumed_client.requests)==1
    ledger=g1.Ledger(tmp_path).data['calls']
    assert [set(c['page_hashes']) for c in ledger]==[{'57','58','59'},{'60','61'}]
    assert all(c['logical_role']=='draft_1' for c in ledger)
    assert all(len(q['messages'])==1 for q in client.requests+resumed_client.requests)
    assert 'sequential_page_notes' in resumed_client.requests[0]['messages'][0]['content'][0]['text']
    assert e.result('draft_1__pages_57_59')['output']==notes()


def test_missing_batch_prevents_role_output_without_replacement(tmp_path):
    e=g1.Experiment(inputs(tmp_path),'pilot',client=Client([RuntimeError('synthetic notes transport failure')]))
    e.stage('draft_1')
    assert e.result('draft_1__pages_57_59')['status']=='failed'
    assert e.result('draft_1')['status']=='failed'
    assert len(e.ledger.data['calls'])==1


def test_report_distinguishes_misplaced_envelope_summary_without_export_repair(tmp_path):
    e=g1.Experiment(inputs(tmp_path),'pilot',client=Client([]))
    artifact={'skip_refresher':False,'refresher_guideline':'SYNTHETIC TEST ONLY'}
    g1.save(e.run/'refresher.json',{'status':'ok','output':{'artifact':artifact,'topic_summary':'SYNTHETIC ENVELOPE SUMMARY'},'call_ids':[1]})
    g1.save(e.run/'refresher-guideline.json',artifact)
    before={n:(e.run/n).read_bytes() for n in ('identity.json','refresher.json','refresher-guideline.json')}
    call=e.ledger.reserve('pilot','refresher','sentinel',8192)
    e.ledger.settle(call,response=response({'artifact':artifact}))
    ledger_before=e.ledger.path.read_bytes()
    e.report()
    summary=g1.read_json(e.run/'summary.json')
    observation=summary['serialization_observations'][0]
    assert 'beside artifact at the envelope level' in observation
    assert 'contract requests it inside artifact' in observation
    assert 'author omitted' not in observation
    assert any('beyond 2,048 tokens' in x and '200 output tokens' in x for x in summary['serialization_observations'])
    assert all((e.run/n).read_bytes()==v for n,v in before.items())
    assert e.ledger.path.read_bytes()==ledger_before
    assert g1.read_json(e.run/'refresher-guideline.json')==artifact
