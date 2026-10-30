"""T28 exact practice-review system placement and unchanged native execution."""
import ast
from copy import deepcopy
import json
from pathlib import Path

import pytest

from guideline_refresher_object_support import restore_guideline_base

from test_translate import runner, invoke, offline, PACKS, intercept
from test_translate_teaching_final_system import request_cases
from translate_practice_review_support import (
    FIXTURE, scenario_bundle, strip_practice_review_ast, strip_practice_review_system)
from reference.factories import translate
from reference.factories.translate_fixture import payload
from reference.inputs import ROOT, canonical, read, sha
from reference.providers import Bedrock, Fixture
from reference.runtime import Runner, report, model_response_json

BASELINE = ROOT/'tests/fixtures'/FIXTURE


def snapshot(path):
    return {str(p.relative_to(path)):p.read_bytes() for p in path.rglob('*') if p.is_file()}


@pytest.mark.parametrize('case',list(request_cases()),ids=lambda c:c[0])
def test_exact_git_base_full_requests_declarations_and_user_blocks(case,monkeypatch):
    role,declared=case
    monkeypatch.setenv('PRIVATE_OPERATOR_HISTORY','OPERATOR_SENTINEL')
    before=deepcopy(declared)
    request=translate.request(None,role,declared,[],[],True)
    old=read(BASELINE)['full_cases'][role]
    assert declared==before==old['declared']==payload(request)
    assert request['messages']==old['request']['messages']
    stream,phase=declared['stream'],role.rsplit('_',1)[1]
    if stream=='practice' and phase=='review':
        assert 'system' not in old['request']
        text=request['system'][0]['text']
        assert request['system']==[{'text':request['messages'][0]['content'][1]['text']}]
        assert 'Role: '+role+'. Stream: practice. Phase: review.' in text
        for forbidden in ('SYNTHETIC','नमूना','OPERATOR_SENTINEL','AGENTS','SKILL',str(ROOT)):
            assert forbidden not in text
        for item in declared['items']:
            assert item['slot'] not in text and item['source_hash'] not in text
        assert set(request)=={'messages','system'}
    else:
        assert request==old['request']  # Includes the complete teaching-final T21–T27 system.
    strip_practice_review_system(request,stream,phase)
    assert request==old['request']
    assert sha(canonical(request))==read(BASELINE)['requests'][role]['request_sha256']


def test_exact_base_ast_outside_request_bytes_prompts_fixtures_lock_and_prior_trees():
    old=read(BASELINE)
    assert old['synthetic'] is True and old['base_commit']=='44eaf513283698dbfa2f3e54ada472b4aacf8121'
    source=Path(translate.__file__).read_text()
    before,after=ast.parse(old['translate_source']),ast.parse(source)
    assert ast.dump(strip_practice_review_ast(deepcopy(after)))==ast.dump(before)
    old_request=next(n for n in before.body if isinstance(n,ast.FunctionDef) and n.name=='request')
    new_request=next(n for n in after.body if isinstance(n,ast.FunctionDef) and n.name=='request')
    old_lines,new_lines=old['translate_source'].splitlines(True),source.splitlines(True)
    assert old_lines[:old_request.lineno-1]==new_lines[:new_request.lineno-1]
    assert old_lines[old_request.end_lineno:]==new_lines[new_request.end_lineno:]
    after.body.remove(new_request)
    assert sha(ast.dump(after).encode())==old['outside_request_ast_sha256']
    files=lambda paths:{str(p.relative_to(ROOT)):sha(p.read_bytes()) for p in sorted(paths)}
    current=restore_guideline_base(files((ROOT/'reference').rglob('*.py')))
    changed='reference/factories/translate.py'
    assert current[changed]!=old['reference_sha256'][changed]
    restored={**current,changed:sha(old['translate_source'].encode())}
    assert restored==old['reference_sha256']
    assert files(p for p in (ROOT/'prompts').rglob('*') if p.is_file())==old['prompt_sha256']
    assert files(p for p in (ROOT/'tests/fixtures').glob('*.json') if p.name != 'explain-checkin-string-system-baseline.json' if p!=BASELINE and p.name!='guideline-refresher-object-syntax-baseline.json')==old['all_historical_fixtures_sha256']
    assert sha((ROOT/'requirements.lock').read_bytes())==old['requirements_sha256']
    for excluded,expected in old['prior_tree_sha256'].items():
        assert sha(canonical({k:v for k,v in restored.items() if k!=f'reference/factories/{excluded}.py'}))==expected


@pytest.mark.parametrize('size',(None,2,50))
def test_native_converse_graph_hashes_exports_and_zero_call_byte_stable_resume(tmp_path,size):
    run=runner(tmp_path,scenario_bundle(size))
    roles=[translate.role_key(b,p) for b in translate.batches(run.bundle,translate.project(run.bundle))
           for p in translate.PHASES]
    calls=[]
    class Client:
        def converse(self,**kwargs):
            role=roles[len(calls)]
            calls.append(deepcopy(kwargs))
            request={'messages':kwargs['messages']}
            if 'system' in kwargs:
                request['system']=kwargs['system']
            data=payload(request)
            phase=role.rsplit('_',1)[1]
            assert kwargs['modelId']=='synthetic-no-service'
            assert kwargs['inferenceConfig']=={'maxTokens':8192,'temperature':.1}
            system=(data['stream']=='teaching' and phase=='final') or (data['stream']=='practice' and phase=='review')
            assert set(kwargs)=={'modelId','messages','inferenceConfig',*({'system'} if system else set())}
            if data['stream']=='practice' and phase=='review':
                assert kwargs['system']==[{'text':kwargs['messages'][0]['content'][1]['text']}]
            return Fixture().invoke(request,role=role,notes_pages=None)
    provider=Bedrock({'model':'synthetic-no-service','max_output_tokens':8192})
    provider.client=Client()
    run.provider=provider
    invoke(run)
    old=read(BASELINE)['scenarios'][str(size)]
    assert len(calls)==len(roles)==len(run.ledger['calls'])
    assert run.exposure()==0 and report(tmp_path,translate)['status']=='complete'
    size_value=12 if size is None else size
    assert run.bundle['metadata'].get('batch_size',12)==size_value
    if size in (None,50):
        assert [len(b['items']) for b in read(tmp_path/'views/batches.json') if b['stream']=='practice']==[size_value,1]
    for call in run.ledger['calls']:
        role=call['role']
        request=read(tmp_path/'requests'/f'{role}.json')
        assert call['request_sha256']==sha(canonical(request))
        assert call['checkpoint_sha256']==sha(canonical(read(tmp_path/'checkpoints'/f'{role}.json')))
        assert call['actual_usd']==call['reserved_usd']==0
        data,phase=payload(request),role.rsplit('_',1)[1]
        if phase=='final':
            assert data['review']['verdicts'] and all(v['pass'] is False for v in data['review']['verdicts'])
            assert all(d['action']=='declined' for d in run.output(role)['dispositions'])
            assert read(tmp_path/'artifacts'/f'{role}.json')==run.output(role)['artifact']
        strip_practice_review_system(request,data['stream'],phase)
        assert sha(canonical(request))==old['requests'][role]
        assert sha(canonical(run.output(role)))==old['outputs'][role]
    for folder,files in old['files'].items():
        assert {p.name:sha(p.read_bytes()) for p in (tmp_path/folder).glob('*.json')}==files
    before=snapshot(tmp_path)
    resumed=Runner(tmp_path,translate,resume=True)
    resumed.provider=provider
    invoke(resumed)
    assert len(calls)==len(roles) and snapshot(tmp_path)==before


@pytest.mark.parametrize('kind',('prose_fence','prose','malformed','wrong_envelope','max_tokens'))
@pytest.mark.parametrize('number',(1,2))
def test_review_failure_stays_raw_no_extraction_final_export_assembly_retry(tmp_path,monkeypatch,kind,number):
    from reference import runtime
    target=f'translate_practice_b{number:03d}_review'
    original,original_frame,original_parse=Fixture.invoke,runtime.model_response_json,translate.parse
    framed,parsed,responses=[],[],[]
    def frame(raw):
        framed.append(raw)
        return original_frame(raw)
    def parse(role,text,notes_pages=None):
        parsed.append(role)
        return original_parse(role,text,notes_pages)
    def altered(self,request,*,role,notes_pages):
        response=original(self,request,role=role,notes_pages=notes_pages)
        if role==target:
            raw=response['output']['message']['content'][0]['text']
            value=json.loads(raw)
            text={'prose_fence':'To review the synthetic draft, follow this process.\n```json\n'+raw+'\n```',
                  'prose':'To review the synthetic draft, follow this process.\n'+raw,
                  'malformed':raw[:-1]+',}', 'wrong_envelope':json.dumps({'artifact':value}),
                  'max_tokens':raw}[kind]
            response['output']['message']['content'][0]['text']=text
            response['stopReason']='max_tokens' if kind=='max_tokens' else 'end_turn'
            responses.append(deepcopy(response))
            framed.clear();parsed.clear()
        return response
    monkeypatch.setattr(runtime,'model_response_json',frame)
    monkeypatch.setattr(translate,'parse',parse)
    monkeypatch.setattr(Fixture,'invoke',altered)
    run=runner(tmp_path,scenario_bundle(2) if number==2 else None)
    with pytest.raises(ValueError,match='required stage unavailable'):
        invoke(run)
    result=run.result(target)
    assert result['status']=='failed' and 'output' not in result
    assert read(tmp_path/'responses'/f'{target}.json')==responses[0]
    raw=responses[0]['output']['message']['content'][0]['text']
    if kind=='max_tokens':
        assert result['error'].startswith('Non-final provider stop') and framed==parsed==[]
        assert 'response_framing' not in result
    else:
        assert framed==[raw]
        assert parsed==([target] if kind=='wrong_envelope' else [])
        if kind!='wrong_envelope':
            with pytest.raises(json.JSONDecodeError) as error:
                json.loads(raw)
            assert result['error']==str(error.value)
    assert run.ledger['calls'][-1]['role']==target
    assert not (tmp_path/'checkpoints'/f'{target.replace("_review","_final")}.json').exists()
    assert not (tmp_path/'artifacts'/f'{target.replace("_review","_final")}.json').exists()
    assert not any((tmp_path/'artifacts'/name).exists() for name in PACKS)
    assert not (tmp_path/'metrics/assembly.json').exists()
    before=snapshot(tmp_path)
    with pytest.raises(ValueError,match='required stage unavailable'):
        invoke(Runner(tmp_path,translate,resume=True))
    assert len(responses)==1 and snapshot(tmp_path)==before


@pytest.mark.parametrize('review',({'verdicts':[],'batch_issues':[]},
    {'verdicts':[],'batch_issues':['SYNTHETIC negative advisory issue']}))
def test_empty_or_negative_review_still_calls_final_author(tmp_path,monkeypatch,review):
    def change(role,data,value):
        if role=='translate_practice_b001_review':
            value.clear();value.update(deepcopy(review))
    intercept(monkeypatch,change)
    run=runner(tmp_path)
    invoke(run)
    role='translate_practice_b001_final'
    assert payload(read(tmp_path/'requests'/f'{role}.json'))['review']==review
    assert read(tmp_path/'artifacts'/f'{role}.json')==run.output(role)['artifact']
    assert len(run.ledger['calls'])==15 and report(tmp_path,translate)['status']=='complete'


@pytest.mark.parametrize('frame',('plain','whole','eof','adjacent'))
def test_existing_review_framing_accepts_escaped_text(frame):
    value={'verdicts':[{'slot':'practice:p000001','pass':False,'reason':'नमूना "quoted" \\ line\nnext'}],
           'batch_issues':['**SYNTHETIC** advisory']}
    body=json.dumps(value,ensure_ascii=False)
    raw={'plain':body,'whole':'```json\n'+body+'\n```','eof':'```json\n'+body,
         'adjacent':'```json\n'+body+'```'}[frame]
    text,_=model_response_json(raw)
    assert translate.parse('translate_practice_b1007_review',text)==value
