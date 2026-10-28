#!/usr/bin/env python3
"""One local Guideline experiment. Built with Llama. No importer or quality gate."""
from __future__ import annotations
import argparse
import fcntl
import hashlib
import html
import importlib.metadata
import io
import json
import os
from pathlib import Path
import re
import shutil
import sys
import time
from contextlib import contextmanager
from typing import TypedDict

# Factory requests do not use agent chat history or environment-driven tracing.
os.environ['LANGSMITH_TRACING'] = 'false'
os.environ['LANGCHAIN_TRACING_V2'] = 'false'
import boto3
from botocore.config import Config
from PIL import Image
from jsonschema import validate
from langgraph.graph import StateGraph, START, END

ROOT = Path(__file__).resolve().parent
MODEL = 'us.meta.llama4-maverick-17b-instruct-v1:0'
REGION = 'us-east-2'
CAP = 10.0
INPUT_RATE, OUTPUT_RATE = .24 / 1_000_000, .97 / 1_000_000
MAX_INPUT, MAX_OUTPUT = 1_000_000, 8192
MAX_CALLS_PER_STAGE = 3  # original + at most two format/serialization continuations
STAGES = ('draft_1', 'draft_2', 'selection', 'coverage', 'accuracy', 'structure', 'revision', 'refresher')
PROMPT = {'draft_1':'chapter_extractor', 'draft_2':'chapter_extractor', 'selection':'chapter_judge',
          'coverage':'lens_coverage', 'accuracy':'lens_accuracy', 'structure':'lens_structure',
          'revision':'chapter_refiner', 'refresher':'refresher_extractor'}


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()


def digest(value):
    return hashlib.sha256(value).hexdigest()


def read_json(path):
    return json.loads(Path(path).read_text())


def save(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + '.tmp')
    with tmp.open('w') as f:
        json.dump(value, f, ensure_ascii=False, indent=2)
        f.write('\n')
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


@contextmanager
def exclusive(workspace):
    workspace = Path(workspace).resolve()
    workspace.mkdir(parents=True, exist_ok=True)
    os.chmod(workspace, 0o700)
    with (workspace/'operator.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError('Another operator owns this experiment workspace')
        try:
            yield workspace
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)


def runtime_identity():
    paths = [ROOT/'guideline.py', ROOT/'requirements.lock']
    paths += sorted((ROOT/'prompts').glob('*.md')) + sorted((ROOT/'schemas').glob('*.json'))
    files = {str(p.relative_to(ROOT)): digest(p.read_bytes()) for p in paths}
    packages = {p: importlib.metadata.version(p) for p in ('langgraph','boto3','botocore','jsonschema','pillow')}
    return {'files': files, 'packages': packages, 'python': sys.version, 'sha256': digest(canonical([files, packages, sys.version]))}


def prepare(workspace, book_path):
    """Freeze only the explicitly approved chapter, copying original image bytes."""
    if (workspace/'inputs/manifest.json').exists():
        raise RuntimeError('Inputs already frozen; refusing to replace them')
    book_path = Path(book_path).resolve()
    book = read_json(book_path)
    chapter = book['chapters']['7']
    if (book['grade'], book['subject'], chapter['start'], chapter['end']) != (4, 'EVS', 57, 61):
        raise ValueError('This experiment authorizes only Grade 4 EVS chapter 7 pages 57–61')
    if chapter['title'].replace('–', '-').strip() != 'Map Reading - Locating Places':
        raise ValueError('Unexpected pilot chapter title')
    pages = []
    target = workspace/'inputs'
    target.mkdir()
    for number in range(57, 62):
        matches = [p for p in (book_path.parent/'pages').iterdir() if p.stem == str(number) and p.suffix.lower() in ('.jpg','.jpeg','.png')]
        if len(matches) != 1:
            raise ValueError(f'Expected exactly one image for printed page {number}')
        data = matches[0].read_bytes()
        with Image.open(io.BytesIO(data)) as im:
            im.load()
            width, height = im.size
            fmt = {'JPEG':'jpeg','PNG':'png'}[im.format]
        if len(data) > 3_932_160 or max(width, height) > 8000:
            raise ValueError(f'Page {number} exceeds generic Bedrock image limits')
        filename = f'page-{number}.{fmt}'
        (target/filename).write_bytes(data)
        pages.append({'printed_page':number,'file':filename,'format':fmt,'sha256':digest(data),'bytes':len(data),'width':width,'height':height})
    metadata = {k:book[k] for k in ('grade','subject','board','country','title')}
    metadata.update(chapter_number=7, chapter_title=chapter['title'], printed_pages=list(range(57,62)),
                    other_chapter_titles=[x['title'] for k,x in book['chapters'].items() if k != '7'])
    manifest = {'metadata':metadata,'pages':pages,'source_book_sha256':digest(book_path.read_bytes())}
    manifest['sha256'] = digest(canonical(manifest))
    save(target/'manifest.json', manifest)
    # Original identifiers/paths are private operational evidence, never model inputs.
    save(target/'private-source.json', {'book_path':str(book_path),'book_id':book.get('book_id'),'chapter_id':chapter.get('chapter_id')})
    return manifest


def load_inputs(workspace):
    manifest = read_json(workspace/'inputs/manifest.json')
    if manifest['sha256'] != digest(canonical({k:v for k,v in manifest.items() if k != 'sha256'})):
        raise ValueError('Manifest changed after freeze')
    if manifest['metadata']['grade'] != 4 or manifest['metadata']['chapter_number'] != 7 or manifest['metadata']['printed_pages'] != list(range(57,62)):
        raise ValueError('Unexpected pilot identity')
    images = []
    for p in manifest['pages']:
        if Path(p['file']).name != p['file']:
            raise ValueError('Image filename must be local to inputs')
        data = (workspace/'inputs'/p['file']).read_bytes()
        if digest(data) != p['sha256']:
            raise ValueError('Frozen page hash mismatch')
        images.append((p, data))
    if [p['printed_page'] for p,_ in images] != list(range(57,62)):
        raise ValueError('All five original pages are required in printed order')
    return manifest, images


class Ledger:
    """Crash-safe reservations. Uncertain calls retain their full exposure forever."""
    def __init__(self, workspace):
        self.path = workspace/'ledger.json'
        if not self.path.exists():
            if (workspace/'runs').exists() and any((workspace/'runs').iterdir()):
                raise RuntimeError('Run history exists without its ledger; refusing a reset')
            save(self.path, {'experiment':'G1','cap_usd':CAP,'pricing':{'input_per_million':.24,'output_per_million':.97,'region':REGION},'calls':[]})
        self.data = read_json(self.path)
        if self.data['cap_usd'] != CAP or self.data['experiment'] != 'G1':
            raise ValueError('Wrong experiment ledger')

    def exposure(self):
        return sum(c.get('actual_usd') if c.get('actual_usd') is not None else c['reserved_usd'] for c in self.data['calls'])

    def reserve(self, run, stage, request_hash, max_output, *, logical_role=None, phase=None, page_hashes=None):
        amount = MAX_INPUT*INPUT_RATE + max_output*OUTPUT_RATE
        if self.exposure() + amount > CAP:
            raise RuntimeError('USD 10 cumulative cap would be exceeded; no request sent')
        call = {'id':len(self.data['calls'])+1,'run':run,'stage':stage,'request_sha256':request_hash,
                'logical_role':logical_role or stage,'phase':phase,'page_hashes':page_hashes or {},
                'reserved_usd':amount,'status':'reserved','created_at':time.time(),'max_input_tokens':MAX_INPUT,'max_output_tokens':max_output}
        self.data['calls'].append(call)
        save(self.path,self.data)
        return call

    def settle(self, call, response=None, error=None):
        if response is not None:
            usage=response.get('usage',{})
            call.update(status='response',usage=usage,stop_reason=response.get('stopReason'),request_id=response.get('ResponseMetadata',{}).get('RequestId'))
            if all(isinstance(usage.get(k),int) for k in ('inputTokens','outputTokens')):
                call['actual_usd']=usage['inputTokens']*INPUT_RATE+usage['outputTokens']*OUTPUT_RATE
        else:
            # Even explicit service denials retain exposure; billing was not reconciled externally.
            call.update(status='ambiguous_or_rejected',error=str(error))
        save(self.path,self.data)


def build_request(stage, manifest, images, declared, previous=None, prefix='', phase='final'):
    """Allowlisted construction: no filesystem discovery, external tools or chat context."""
    if stage == 'access_check':
        instruction = 'ACCESS CHECK ONLY, NOT A CHAPTER RUN. Read the single attached original page image. Return only JSON with page_numbers (the printed numbers you can actually read) and images_read (count). Do not summarize, author or reproduce curriculum content.'
    elif stage == 'probe':
        instruction = 'Read all five attached page images. Return only JSON with page_numbers (the printed numbers you can actually read) and images_read (count). Do not summarize or reproduce the book text.'
    else:
        instruction = (ROOT/'prompts'/(PROMPT[stage]+'.md')).read_text()
        if stage in ('draft_1','draft_2','revision','refresher'):
            instruction += '\nReturn only a JSON object containing artifact (the complete requested JSON content), note, and any requested audit fields. No Markdown fences.'
        else:
            schema = read_json(ROOT/'schemas'/('judge_schema.json' if stage=='selection' else 'lens_schema.json'))
            instruction += '\nReturn only JSON following this schema:\n'+json.dumps(schema)
    if stage in STAGES:
        if phase=='notes':
            instruction += '\n\nTURN 1 OF THIS SAME ROLE: inspect only original pages 57–59 attached now. Do not produce the role’s final artifact, scores or findings yet. Record your own bounded, page-numbered observations for turn 2: taught concepts, names, methods, definitions in your own words, diagrams/maps/tables/labels and their relationships, and which blocks are exercises rather than teaching. Preserve evidence and uncertainties; do not invent missing pages. At most 1200 words total. Return ONLY JSON {\"page_notes\":[{\"printed_page\":57,\"observations\":\"...\"},{\"printed_page\":58,\"observations\":\"...\"},{\"printed_page\":59,\"observations\":\"...\"}]}. This turn-specific output contract replaces the role’s usual output contract for this turn only.'
        else:
            instruction += '\n\nTURN 2 OF THIS SAME ROLE: originals 60–61 are attached now; sequential_page_notes are YOUR OWN observations after directly inspecting originals 57–59 in turn 1. Use those notes plus the two current original images and the same role inputs to produce your normal complete role output for all five pages. This is sequential visual context, not simultaneous access to all five originals. Do not claim the notes are original images. Record any uncertainty honestly. No additional review follows the final author revision.'
    if len(images)>3 and stage in STAGES:raise ValueError('T01 requests may contain at most three original images')
    content=[{'text': instruction+'\n\nAUDIENCE: Grade 4, Indian student, English may not be their first language.\nDeclared metadata:\n'+json.dumps(manifest['metadata'],ensure_ascii=False)+'\nDeclared task inputs:\n'+json.dumps(declared,ensure_ascii=False)}]
    for p,data in images:
        content += [{'text':f'Original printed page {p["printed_page"]}:'}, {'image':{'format':p['format'],'source':{'bytes':data}}}]
    messages=[{'role':'user','content':content}]
    if previous is not None:
        messages += [{'role':'assistant','content':[{'text':previous}]}, {'role':'user','content':[{'text':
            'Continue the exact JSON from the next character, without repeating any prefix or adding commentary. This is serialization of the same response, not a new revision.' if prefix else
            'The previous response was not usable JSON in the required structural shape. Return the complete same requested artifact as valid JSON. This is format recovery only; do not perform a new quality review.'}]}]
    return {'modelId':MODEL,'messages':messages,'inferenceConfig':{'maxTokens':MAX_OUTPUT,'temperature':.25 if stage.startswith('draft') else .1}}


def request_evidence(request):
    """JSON-safe exact message text and image hashes; raw bytes stay in private inputs."""
    q=json.loads(json.dumps(request,default=lambda b:{'sha256':digest(b),'bytes':len(b)}))
    return q


def parse_output(stage, text):
    clean=text.strip()
    if clean.startswith('```'):
        clean=re.sub(r'^```(?:json)?\s*|\s*```$','',clean)
    value=json.loads(clean)
    if not isinstance(value,dict):
        raise ValueError('Response must be an object')
    if stage.endswith('__pages_57_59'):
        notes=value.get('page_notes')
        if not isinstance(notes,list) or [n.get('printed_page') for n in notes if isinstance(n,dict)] != [57,58,59] or not all(isinstance(n.get('observations'),str) and n['observations'].strip() for n in notes):
            raise ValueError('Missing page-numbered notes serialization for pages 57–59')
        return value
    if stage in ('draft_1','draft_2','revision'):
        artifact=value.get('artifact')
        if not isinstance(artifact,dict) or not isinstance(artifact.get('sections'),list) or not artifact['sections']:
            raise ValueError('Missing nonempty chapter sections array')
        if not isinstance(artifact.get('chapter_display_name'),str):
            raise ValueError('Missing chapter display name')
        # Serialization checks only. Counts, coverage, correctness and prose are never gates.
        for section in artifact['sections']:
            if not isinstance(section,dict) or not isinstance(section.get('guidelines'),str):
                raise ValueError('Unusable section serialization')
    elif stage=='refresher':
        artifact=value.get('artifact')
        if not isinstance(artifact,dict) or not isinstance(artifact.get('skip_refresher'),bool):
            raise ValueError('Missing refresher serialization')
        if not artifact['skip_refresher'] and not isinstance(artifact.get('refresher_guideline'),str):
            raise ValueError('Missing refresher guideline string')
    elif stage in ('coverage','accuracy','structure','selection'):
        if stage=='selection' and value.get('winner_index') not in (1,2):
            raise ValueError('Invalid selected draft index')
        validate(value,read_json(ROOT/'schemas'/('judge_schema.json' if stage=='selection' else 'lens_schema.json')))
    elif stage=='access_check':
        if value.get('page_numbers') != [57] or value.get('images_read') != 1:
            raise ValueError('Single-page check did not return its expected structural response')
    elif stage=='probe':
        if value.get('page_numbers') != list(range(57,62)) or value.get('images_read') != 5:
            raise ValueError('Probe did not confirm reading all five printed page numbers')
    return value


class Experiment:
    def __init__(self, workspace, run_id, client=None, resume=False, report_only=False, access_only=False):
        if not re.fullmatch(r'[a-zA-Z0-9_-]{1,64}',run_id):
            raise ValueError('Unsafe run name')
        self.workspace=workspace; self.run_id=run_id; self.run=workspace/'runs'/run_id
        self.ledger=Ledger(workspace)
        self.manifest,self.images=load_inputs(workspace)
        full_manifest_sha=self.manifest['sha256']
        if access_only:
            self.images=[item for item in self.images if item[0]['printed_page']==57]
            self.manifest={**self.manifest,'metadata':{**self.manifest['metadata'],'printed_pages':[57],'scope':'single_page_access_check_only'}}
            self.manifest['sha256']=digest(canonical({'scope':'single_page_access_check_only','full_manifest_sha256':full_manifest_sha,'page_sha256':self.images[0][0]['sha256']}))
        self.identity={'runtime':runtime_identity(),'input_sha256':self.manifest['sha256'],'model':MODEL,'region':REGION,
                       'policy':'final-author-v1','max_output_tokens':MAX_OUTPUT,
                       'scope':'single_page_access_check_only' if access_only else 'full_chapter',
                       'full_manifest_sha256':full_manifest_sha,
                       'image_delivery':'single_page_access' if access_only else 'T01_role_local_two_turn_3plus2',
                       'page_batches':[[57]] if access_only else [[57,58,59],[60,61]]}
        if self.run.exists():
            if not resume: raise RuntimeError('Run already exists; use explicit resume')
            frozen=read_json(self.run/'identity.json')
            if not report_only and frozen != self.identity: raise RuntimeError('Frozen runtime/input/model identity changed; resume refused')
            self.identity=frozen
        else:
            if resume: raise RuntimeError('Cannot resume a missing run')
            self.run.mkdir(parents=True);save(self.run/'identity.json',self.identity)
        self.client=None if report_only else client or boto3.client('bedrock-runtime',region_name=REGION,config=Config(retries={'total_max_attempts':1},connect_timeout=20,read_timeout=360))

    def result(self,stage):
        p=self.run/(stage+'.json')
        return read_json(p) if p.exists() else None

    def invoke(self,stage,declared,phase='final'):
        if self.client is None:raise RuntimeError('Report-only mode cannot invoke models')
        checkpoint=stage+'__pages_57_59' if phase=='notes' else stage
        existing=self.result(checkpoint)
        if existing:return existing
        prior=[c for c in self.ledger.data['calls'] if c['run']==self.run_id and c['stage']==checkpoint]
        if prior:
            raise RuntimeError(f'{checkpoint}: interrupted call history requires manual reconciliation, no duplicate sent')
        images=self.images
        if stage in STAGES:
            numbers=[57,58,59] if phase=='notes' else [60,61]
            images=[item for item in self.images if item[0]['printed_page'] in numbers]
        previous=None;prefix='';last_error=None
        for attempt in range(1 if stage=='access_check' else MAX_CALLS_PER_STAGE):
            if runtime_identity()!=self.identity['runtime']:raise RuntimeError('Runtime changed during frozen run')
            load_inputs(self.workspace)
            request=build_request(stage,self.manifest,images,declared,previous,prefix,phase)
            evidence=request_evidence(request)
            request_hash=digest(canonical(evidence))
            save(self.run/f'{checkpoint}-request-{attempt+1}.json',evidence)
            call=self.ledger.reserve(self.run_id,checkpoint,request_hash,MAX_OUTPUT,logical_role=stage,phase=phase,
                                     page_hashes={str(p['printed_page']):p['sha256'] for p,_ in images})
            print(json.dumps({'stage':checkpoint,'attempt':attempt+1,'call_id':call['id'],'exposure_usd':round(self.ledger.exposure(),6)}),flush=True)
            try:
                response=self.client.converse(**request)
            except Exception as e:
                self.ledger.settle(call,error=e)
                save(self.run/f'{checkpoint}-error-{attempt+1}.json',{'error':str(e),'call_id':call['id']})
                last_error=str(e);break
            save(self.run/f'{checkpoint}-response-{attempt+1}.json',response)
            self.ledger.settle(call,response=response)
            text=''.join(x.get('text','') for x in response.get('output',{}).get('message',{}).get('content',[]))
            stop=response.get('stopReason');combined=prefix+text
            (self.run/f'{checkpoint}-raw-{attempt+1}.txt').write_text(combined)
            if stop=='max_tokens':
                prefix=combined;previous=combined;last_error='Output truncated at model token limit';continue
            if stop!='end_turn':
                last_error=f'Unexpected model stop reason: {stop}';break
            try:
                value=parse_output(checkpoint,combined)
                if stage=='selection' and phase=='final' and value['winner_index'] not in [c['index'] for c in declared['candidates']]:
                    raise ValueError('Judge selected an unavailable draft')
                result={'status':'ok','output':value,'call_ids':[c['id'] for c in self.ledger.data['calls'] if c['run']==self.run_id and c['stage']==checkpoint]}
                save(self.run/(checkpoint+'.json'),result);return result
            except Exception as e:
                last_error=f'{type(e).__name__}: {e}';previous=combined;prefix=''
        result={'status':'failed','error':last_error,'call_ids':[c['id'] for c in self.ledger.data['calls'] if c['run']==self.run_id and c['stage']==checkpoint]}
        save(self.run/(checkpoint+'.json'),result);return result

    def declared(self,stage):
        def output(s):
            r=self.result(s)
            return r['output'] if r and r['status']=='ok' else {'technical_failure':{'stage':s,'status':'unavailable','note':'The role produced no usable response; raw transport details are private.'}}
        if stage.startswith('draft') or stage in ('probe','access_check'): return {}
        if stage=='selection':
            candidates=[{'index':i,'draft':output(s)['artifact']} for i,s in enumerate(('draft_1','draft_2'),1) if self.result(s) and self.result(s)['status']=='ok']
            if not candidates: raise ValueError('No usable drafts; selection cannot run')
            return {'candidates':candidates}
        if stage in ('coverage','accuracy','structure'):
            return {'selected_draft':self.selected()}
        if stage=='revision':
            return {'selected_draft':self.selected(),'selection_feedback':output('selection'),
                    'reviews':{s:output(s) for s in ('coverage','accuracy','structure')},
                    'open_findings':[dict(f,id=f'{s}-{i+1}') for s in ('coverage','accuracy','structure') for i,f in enumerate(output(s).get('findings',[]))]}
        return {'final_chapter':output('revision')['artifact']}

    def selected(self):
        selection=self.result('selection')
        if not selection or selection['status']!='ok': raise ValueError('No usable selection response')
        index=selection['output']['winner_index']
        if index not in (1,2): raise ValueError('Invalid selected draft index')
        r=self.result(f'draft_{index}')
        if not r or r['status']!='ok': raise ValueError('Judge selected an unavailable draft')
        return r['output']['artifact']

    def stage(self,name):
        existing=self.result(name)
        if not existing:
            try:
                declared=self.declared(name)
                notes=self.invoke(name,declared,phase='notes')
                if notes['status']=='ok':
                    self.invoke(name,{**declared,'sequential_page_notes':notes['output']['page_notes']})
                else:
                    save(self.run/(name+'.json'),{'status':'failed','error':'Role page-inspection turn failed; no final output attempted','call_ids':notes.get('call_ids',[])})
            except Exception as e:
                save(self.run/(name+'.json'),{'status':'failed','error':str(e),'call_ids':[]})
        if name=='revision' and self.result(name)['status']=='ok':
            save(self.run/'guideline.json',self.result(name)['output']['artifact'])
        if name=='refresher' and self.result(name)['status']=='ok':
            save(self.run/'refresher-guideline.json',self.result(name)['output']['artifact'])

    def graph(self):
        if self.identity.get('scope')=='single_page_access_check_only':
            raise RuntimeError('Single-page access check is not a chapter factory run')
        class State(TypedDict):
            last_stage: str
        graph=StateGraph(State)
        graph.add_node('load',lambda state:{'last_stage':'load'})
        graph.add_edge(START,'load')
        previous='load'
        for name in STAGES:
            def node(state,name=name):
                self.stage(name)
                return {'last_stage':name}
            graph.add_node(name,node);graph.add_edge(previous,name);previous=name
        graph.add_node('report',lambda state:(self.report() or {'last_stage':'report'}))
        graph.add_edge(previous,'report');graph.add_edge('report',END)
        return graph.compile()

    def report(self):
        ordered=('probe','access_check')+tuple(key for stage in STAGES for key in (stage+'__pages_57_59',stage))
        results={s:self.result(s) for s in ordered if self.result(s)}
        calls=[c for c in self.ledger.data['calls'] if c['run']==self.run_id]
        complete=all(results.get(s,{}).get('status')=='ok' for s in STAGES)
        access_only=self.identity.get('scope')=='single_page_access_check_only'
        status=('single_page_access_complete' if results.get('access_check',{}).get('status')=='ok' else 'single_page_access_failed') if access_only else 'complete' if complete else ('probe_complete' if results.get('probe',{}).get('status')=='ok' and len(results)==1 else 'partial_or_failed')
        observations=[]
        refresher_output=results.get('refresher',{}).get('output',{})
        refresher=refresher_output.get('artifact')
        if isinstance(refresher,dict) and 'topic_summary' not in refresher:
            placement='The returned response places topic_summary beside artifact at the envelope level, although the contract requests it inside artifact.' if 'topic_summary' in refresher_output else 'No topic_summary field is recorded in the returned response.'
            observations.append('The exported refresher artifact lacks requested topic_summary. '+placement+' The export preserves artifact unchanged; no field relocation, source-contract completeness or import readiness is claimed.')
        measured_outputs=[c['usage']['outputTokens'] for c in calls if isinstance(c.get('usage',{}).get('outputTokens'),int)]
        if measured_outputs and max(measured_outputs)<=2048:
            observations.append(f'The largest measured response was {max(measured_outputs):,} output tokens. Accepting maxTokens=8192 does not prove useful output beyond 2,048 tokens; that remains unproven.')
        summary={'serialization_observations':observations,'run_id':self.run_id,'status':status,'identity':self.identity,'report_renderer':runtime_identity()['sha256'],'results':results,'calls':calls,
                 'actual_usd':sum(c.get('actual_usd',0) for c in calls),'unreconciled_reserved_usd':sum(c['reserved_usd'] for c in calls if 'actual_usd' not in c),
                 'experiment_exposure_usd':self.ledger.exposure(),'experiment_unreconciled_reserved_usd':sum(c['reserved_usd'] for c in self.ledger.data['calls'] if 'actual_usd' not in c),'cap_usd':CAP,
                 'image_delivery':'Each existing logical role independently reads originals57–59 into its own checkpointed notes, then originals60–61 plus those notes. Sequential visual context; at most3 original images per request. Eight roles normally require16 requests.',
                 'quality_policy':'Final author revision is authoritative. No terminal quality gate exists or passed.',
                 'limits':['Standalone experiment; no app publication or learning-outcome measurement.',
                           'US inference profile can route to Virginia, Ohio or Oregon.',
                           'Cost is API-token estimate at recorded standard rates, before tax; billing invoice not reconciled.',
                           'Missing usage retains a reservation; it is not evidence of zero billed cost.']}
        save(self.run/'summary.json',summary)
        def esc(v):return html.escape(str(v))
        def safe(v):
            if isinstance(v,dict):return {k:('[private technical detail]' if k == 'request_id' else safe(x)) for k,x in v.items()}
            if isinstance(v,list):return [safe(x) for x in v]
            if isinstance(v,str):
                return re.sub(r'arn:aws[^\s\"<>]*|\b\d{12}\b|/(?:Users|home|tmp)/[^\s\"<>]*','[private identifier]',v)
            return v
        def pretty(v):return '<pre>'+esc(json.dumps(safe(v),ensure_ascii=False,indent=2))+'</pre>'
        results=safe(results)
        title='Single-page access check only' if access_only else 'Guideline experiment'
        scope='Original printed page 57 only · no chapter run or Guideline generation' if access_only else 'Grade 4 EVS · Map Reading – Locating Places · printed pages 57–61'
        workflow='One original image → transport / image access response → report. The five-page chapter pilot remains separate and blocked.' if access_only else 'Load → two independent drafts → selection → coverage / accuracy / structure → final author revision → prerequisite refresher → artifacts and report. Each role uses two turns: originals57–59 to its own notes, then originals60–61 plus those notes; sequential visual context.'
        rows=''.join('<tr><td>'+esc(s)+'</td><td>'+esc(results.get(s,{}).get('status','not run'))+'</td><td>'+esc(results.get(s,{}).get('error',''))+'</td></tr>' for s in results)
        sections=''.join('<section><h2>'+esc(s.replace('_',' ').title())+'</h2>'+pretty(r.get('output',r))+'</section>' for s,r in results.items())
        doc='''<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Guideline experiment</title><style>
body{margin:0;background:#f4f5f1;color:#172e2a;font:17px/1.6 system-ui}main{max-width:1080px;margin:auto;padding:40px 24px}h1{font-size:42px;line-height:1.1}h2{font-size:26px}section,.panel{background:white;border:1px solid #d9e2db;border-radius:16px;padding:24px;margin:24px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:14px/1.6 ui-monospace,monospace}table{width:100%;border-collapse:collapse;table-layout:fixed}td,th{overflow-wrap:anywhere;vertical-align:top;text-align:left;border-bottom:1px solid #ddd;padding:10px}.tag{color:#2e6454;font-weight:700}nav a{margin-right:18px}a{color:#216a62}</style><main>
<p class="tag">SCHOOL LEARNING SIMPLIFIED · BUILT WITH LLAMA</p><h1>Guideline experiment</h1>'''
        doc=doc.replace('<title>Guideline experiment</title>','<title>'+esc(title)+'</title>').replace('<h1>Guideline experiment</h1>','<h1>'+esc(title)+'</h1>')
        doc+='<p>'+esc(scope)+'</p><div class="panel"><h2>'+esc(status.replace('_',' ').title())+'</h2><p>'+esc(summary['quality_policy'])+'</p><p>This run’s known-usage token estimate: $'+f'{summary["actual_usd"]:.6f}'+' · experiment unreconciled reservations: $'+f'{summary["experiment_unreconciled_reserved_usd"]:.6f}'+' · experiment exposure: $'+f'{summary["experiment_exposure_usd"]:.6f}'+' / $10</p><nav><a href="#workflow">Workflow</a><a href="#output">Final output</a><a href="#identity">Identity and usage</a></nav></div>'
        if observations:doc+='<section><h2>Recorded output limitation</h2><p>'+esc(' '.join(observations))+'</p></section>'
        doc+='<section id="workflow"> <h2>Workflow</h2><p>'+esc(workflow)+'</p><table><tr><th>Role</th><th>Status</th><th>Technical issue</th></tr>'+rows+'</table></section>'
        final=results.get('revision',{}).get('output',{}).get('artifact')
        doc+='<section id="output"><h2>Final author’s teaching plan</h2>'
        if final:
            doc+='<h3>'+esc(final.get('chapter_display_name',''))+'</h3><p>'+esc(final.get('chapter_summary',''))+'</p>'
            for s in final.get('sections',[]):
                doc+='<h3>'+esc(s.get('topic_title',''))+'</h3><p>'+esc(s.get('summary',''))+'</p><pre>'+esc(s.get('guidelines',''))+'</pre>'
        else:doc+='<p>No usable final author output exists. Any available prior drafts remain partial evidence.</p>'
        doc+='</section>'+sections+'<section id="identity"><h2>Identity and usage</h2>'+pretty({k:v for k,v in summary.items() if k!='results'})+'</section><p>This report contains no raw page images or account identifiers.</p></main></html>'
        # Request IDs belong in private summary, not the shareable HTML.
        for c in calls:
            if c.get('request_id'):doc=doc.replace(esc(c['request_id']),'[private request id]')
        (self.run/'report.html').write_text(doc)
        print(json.dumps({k:summary[k] for k in ('run_id','status','actual_usd','unreconciled_reserved_usd','experiment_exposure_usd')}),flush=True)


def main():
    os.umask(0o077)
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command',choices=('prepare','probe','access-check','run','resume','report','ledger'))
    parser.add_argument('--workspace',type=Path,required=True,help='One durable private directory for this entire USD 10 experiment; never reset or duplicate')
    parser.add_argument('--book',type=Path)
    parser.add_argument('--run-id',default='g1-pilot')
    args=parser.parse_args()
    if args.command=='probe' and args.run_id=='g1-pilot':args.run_id='g1-access'
    if args.command=='access-check' and args.run_id=='g1-pilot':args.run_id='g1-access-single-page'
    with exclusive(args.workspace) as workspace:
        if args.command=='prepare':
            if not args.book:parser.error('prepare requires --book')
            print(json.dumps({'input_sha256':prepare(workspace,args.book)['sha256']}));return
        if args.command=='ledger':
            ledger=Ledger(workspace);print(json.dumps({'exposure_usd':ledger.exposure(),'calls':len(ledger.data['calls']),'cap_usd':CAP}));return
        if args.command=='report':
            # Reporting frozen evidence is read-only with respect to model calls.
            exp=Experiment(workspace,args.run_id,resume=True,report_only=True);exp.report();return
        # One probe and one full run only, with a shared ledger across explicit resumes.
        marker=workspace/('single-page-access-owner.json' if args.command=='access-check' else 'probe-owner.json' if args.command=='probe' else 'pilot-owner.json')
        if marker.exists() and read_json(marker)['run_id']!=args.run_id:
            raise RuntimeError('This experiment already has an owner run; no second run is authorized')
        save(marker,{'run_id':args.run_id})
        exp=Experiment(workspace,args.run_id,resume=args.command=='resume',access_only=args.command=='access-check')
        if args.command=='access-check':
            exp.invoke('access_check',{});exp.report()
        elif args.command=='probe':
            exp.invoke('probe',{});exp.report()
        else:
            probe_marker=workspace/'single-page-access-owner.json'
            if not probe_marker.exists():raise RuntimeError('T01 requires the successful single-page access check first')
            probe_result=read_json(workspace/'runs'/read_json(probe_marker)['run_id']/'access_check.json')
            if probe_result['status']!='ok':raise RuntimeError('Single-page access check did not succeed; full pilot blocked')
            exp.graph().invoke({'last_stage':'start'})
        if any(exp.result(s) and exp.result(s)['status']=='failed' for s in STAGES+('probe','access_check')):
            raise SystemExit(2)


if __name__=='__main__':
    main()
