"""T30 initial check-in string contract; synthetic data, inert Converse and strict failures."""
import ast
from copy import deepcopy
import json
from pathlib import Path
import pytest

from explain_checkin_string_support import FIXTURE, EXPLAIN, SUFFIX, base, strip_checkin_system, restore_explain_base
from test_explain import offline, runner, invoke, payload
from reference.factories import explain
from reference.inputs import ROOT, canonical, read, sha
from reference.providers import Bedrock, Fixture
from reference.runtime import Runner, report, model_response_json

AUTHOR = 'explain_checkins'
OLD_SYSTEMS = ('explain_research', 'explain_winner_revision', 'explain_split')


def files(paths):
    return {str(p.relative_to(ROOT)): sha(p.read_bytes()) for p in sorted(paths)}


def snapshot(path):
    return {str(p.relative_to(path)): p.read_bytes() for p in path.rglob('*') if p.is_file()}


@pytest.mark.parametrize('role', explain.ROLES)
def test_actual_base_full_requests_declarations_users_and_existing_systems(tmp_path, monkeypatch, role):
    monkeypatch.setenv('PRIVATE_OPERATOR_HISTORY', 'OPERATOR_SENTINEL')
    run = runner(tmp_path)
    old = base()
    declared = deepcopy(old['declared'][role])
    original = deepcopy(declared)
    request = explain.request(run, role, declared, [], [], True)
    assert declared == original == payload(request)
    assert request['messages'] == old['full_requests'][role]['messages']
    assert sha(canonical(request['messages'])) == old['user_blocks_sha256'][role]
    if role == AUTHOR:
        final = old['full_requests'][role]['messages'][0]['content'][-1]['text']
        assert request['system'] == [{'text': final+SUFFIX}]
        assert SUFFIX.count('\n') == 1 and '\\n' in SUFFIX
        assert request['system'][0]['text'].count(SUFFIX) == 1
        assert 'as \\n, never' in request['system'][0]['text']
        for forbidden in ('SYNTHETIC', 'OPERATOR_SENTINEL', 'AGENTS.md', 'SKILL.md', str(ROOT), str(tmp_path)):
            assert forbidden not in request['system'][0]['text']
        strip_checkin_system(request)
    assert request == old['full_requests'][role]
    assert sha(canonical(request)) == old['request_sha256'][role]


def test_actual_base_source_nonrequest_bytes_complete_trees_prompts_fixtures_lock():
    old=base(); source=Path(explain.__file__).read_text()
    assert old['synthetic'] is True and old['base_commit']=='7eccf87c636e2c10a452a0d3448e149814d243c5'
    old_ast,new_ast=ast.parse(old['explain_source']),ast.parse(source)
    old_req=next(n for n in old_ast.body if isinstance(n,ast.FunctionDef) and n.name=='request')
    new_req=next(n for n in new_ast.body if isinstance(n,ast.FunctionDef) and n.name=='request')
    assert old['explain_source'].splitlines(True)[:old_req.lineno-1]==source.splitlines(True)[:new_req.lineno-1]
    assert old['explain_source'].splitlines(True)[old_req.end_lineno:]==source.splitlines(True)[new_req.end_lineno:]
    new_ast.body.remove(new_req)
    assert sha(ast.dump(new_ast).encode())==old['outside_request_ast_sha256']
    current=files((ROOT/'reference').rglob('*.py'))
    assert current[EXPLAIN]!=old['reference_sha256'][EXPLAIN]
    restored=restore_explain_base(current)
    assert restored==old['reference_sha256']
    for excluded,expected in old['prior_tree_sha256'].items():
        assert sha(canonical({k:v for k,v in restored.items() if k!=f'reference/factories/{excluded}.py'}))==expected
    assert files(p for p in (ROOT/'prompts').rglob('*') if p.is_file())==old['prompt_sha256']
    assert files(p for p in (ROOT/'tests/fixtures').glob('*.json') if p.name!=FIXTURE)==old['all_historical_fixtures_sha256']
    assert sha((ROOT/'requirements.lock').read_bytes())==old['requirements_sha256']


def test_unusual_declared_strings_stay_inline_and_do_not_enter_system(tmp_path):
    run=runner(tmp_path); declared=deepcopy(base()['declared'][AUTHOR])
    declared['deck']['synthetic_escape']='DECLARED_SENTINEL "quote" \\ नमूना\r\nline'
    before=deepcopy(declared)
    request=explain.request(run,AUTHOR,declared,[],[],True)
    assert payload(request)==before==declared
    assert 'DECLARED_SENTINEL' not in request['system'][0]['text']
    assert request['messages'][0]['content'][-1]==base()['full_requests'][AUTHOR]['messages'][0]['content'][-1]


VALID = [
    {'artifact': {'check_ins': [{'instruction': 'SYNTHETIC "quote" \\ नमूना\nline', 'unknown': None}]}, 'note': 'SYNTHETIC'},
    {'artifact': {'check_ins': []}, 'note': 'SYNTHETIC empty'},
    {'artifact': {'check_ins': [{'activity_type': 'imperfect', 'insert_after_card_idx': -99}]}, 'unresolved': ['SYNTHETIC']},
    {'artifact': {'check_ins': 'SYNTHETIC imperfect', 'unknown': True}},
]


@pytest.mark.parametrize('value', VALID, ids=('escaped-strings', 'empty', 'native-imperfection', 'native-field-imperfection'))
def test_8192_forwarding_native_graph_advisory_feedback_author_exports_hashes_and_zero_call_resume(tmp_path,value):
    run=runner(tmp_path); calls=[]
    class Client:
        def converse(self,**kwargs):
            role=explain.ROLES[len(calls)]; calls.append(deepcopy(kwargs))
            expected=([{'text':kwargs['messages'][0]['content'][-1]['text']+SUFFIX}] if role==AUTHOR else
                      [{'text':kwargs['messages'][0]['content'][-1]['text']}] if role in OLD_SYSTEMS else None)
            assert set(kwargs)=={'modelId','messages','inferenceConfig',*({'system'} if expected else set())}
            assert kwargs['modelId']=='synthetic-no-service'
            assert kwargs['inferenceConfig']=={'maxTokens':8192,'temperature':.1}
            if expected: assert kwargs['system']==expected
            response=Fixture().invoke({'messages':kwargs['messages']},role=role,notes_pages=None)
            if role in (AUTHOR,'explain_checkins_final'):
                response['output']['message']['content'][0]['text']=json.dumps(value,ensure_ascii=False)
            return response
    provider=Bedrock({'model':'synthetic-no-service','max_output_tokens':8192}); provider.client=Client(); run.provider=provider
    invoke(run)
    assert len(calls)==len(run.ledger['calls'])==16 and run.exposure()==0
    assert run.output(AUTHOR)==run.output('explain_checkins_final')==value
    assert report(run.workspace,explain)['status']=='complete'
    final=payload(read(run.workspace/'requests/explain_checkins_final.json'))
    assert final['draft_check_ins']==value['artifact']
    assert final['checkin_review']['holistic_pass'] is False and final['checkin_review']['wrong']
    assert final['checkin_review']['holistic_issues']
    for role,filename in explain.EXPORTS.items():
        path=run.workspace/'artifacts'/filename; artifact=run.output(role)['artifact']
        assert (path.read_bytes() if path.suffix=='.md' else read(path))==(artifact.encode() if path.suffix=='.md' else artifact)
    for call in run.ledger['calls']:
        request=read(run.workspace/'requests'/f'{call["key"]}.json')
        assert call['request_sha256']==sha(canonical(request))
        assert call['checkpoint_sha256']==sha(canonical(read(run.workspace/'checkpoints'/f'{call["key"]}.json')))
        assert call['actual_usd']==call['reserved_usd']==0
        assert run.identity['runtime']['files']['reference/factories/explain.py']==sha(Path(explain.__file__).read_bytes())
        if call['role']==AUTHOR:
            strip_checkin_system(request)
            assert call['request_sha256']!=sha(canonical(request))
    saved=snapshot(run.workspace); resumed=Runner(run.workspace,explain,resume=True); resumed.provider=provider; invoke(resumed)
    assert len(calls)==16 and snapshot(run.workspace)==saved


LITERAL_LF = '{"artifact":{"check_ins":[{"instruction":"SYNTHETIC first\nsecond"}]}}'
UNCLOSED = '{"artifact":{"check_ins":[{"instruction":"SYNTHETIC first,\n"hint":"SYNTHETIC"}]}}'
INVALID = [LITERAL_LF,UNCLOSED,'{"artifact":{"check_ins":[{"instruction":"SYNTHETIC}]}}']


@pytest.mark.parametrize('body',INVALID)
@pytest.mark.parametrize('fenced',(False,True))
def test_synthetic_string_failures_raw_no_final_export_downstream_repair_or_retry(tmp_path,monkeypatch,body,fenced):
    rawtext='```json\n'+body+'\n```' if fenced else body
    verify_failure(tmp_path,monkeypatch,rawtext,'end_turn')


def test_max_tokens_fails_before_framing_even_for_parseable_body(tmp_path,monkeypatch):
    verify_failure(tmp_path,monkeypatch,json.dumps(VALID[0]),'max_tokens')


def verify_failure(tmp_path,monkeypatch,text,stop):
    from reference import runtime
    original,framer,parser=Fixture.invoke,runtime.model_response_json,explain.parse
    calls,framed,parsed=[],[],[]
    raw={'output':{'message':{'content':[{'text':text}]}},'stopReason':stop}
    def response(self,request,*,role,notes_pages):
        calls.append(role)
        if role==AUTHOR:
            framed.clear(); parsed.clear(); return deepcopy(raw)
        return original(self,request,role=role,notes_pages=notes_pages)
    def frame(text):
        framed.append(text); return framer(text)
    def parse(role,text,notes_pages=None):
        parsed.append(role); return parser(role,text,notes_pages)
    monkeypatch.setattr(Fixture,'invoke',response); monkeypatch.setattr(runtime,'model_response_json',frame); monkeypatch.setattr(explain,'parse',parse)
    run=runner(tmp_path)
    with pytest.raises(ValueError,match='required stage unavailable'): invoke(run)
    assert len(calls)==len(run.ledger['calls'])==14 and calls[-1]==AUTHOR
    assert run.result(AUTHOR)['status']=='failed' and 'output' not in run.result(AUTHOR)
    assert read(run.workspace/'responses'/f'{AUTHOR}.json')==raw
    assert parsed==[]
    if stop=='max_tokens':
        assert framed==[] and 'response_framing' not in run.result(AUTHOR)
        assert run.result(AUTHOR)['error'].startswith('Non-final provider stop')
    else:
        assert framed==[text]
        assert 'control character' in run.result(AUTHOR)['error'] or 'Unterminated string' in run.result(AUTHOR)['error']
    assert (run.workspace/'artifacts/deck.json').exists()
    assert not (run.workspace/'artifacts/check-ins.json').exists()
    assert not (run.workspace/'requests/explain_checkin_review.json').exists()
    assert not (run.workspace/'requests/explain_checkins_final.json').exists()
    assert report(run.workspace,explain)['status']=='partial_or_failed'
    saved=snapshot(run.workspace)
    monkeypatch.setattr(Fixture,'invoke',lambda *a,**k:pytest.fail('Failed call repeated'))
    with pytest.raises(ValueError,match='required stage unavailable'): invoke(Runner(run.workspace,explain,resume=True))
    assert snapshot(run.workspace)==saved


@pytest.mark.parametrize('frame',('plain','whole','eof','adjacent'))
def test_correctly_escaped_strings_and_parseable_native_imperfections_keep_existing_framing(frame):
    body=json.dumps(VALID[0],ensure_ascii=False)
    text={'plain':body,'whole':'```json\n'+body+'\n```','eof':'```json\n'+body,'adjacent':'```json\n'+body+'```'}[frame]
    native,_=model_response_json(text)
    assert explain.parse(AUTHOR,native)==VALID[0]
