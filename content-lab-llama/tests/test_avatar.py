"""R8 graph checks use explicit stubs; real rendering lives in test_avatar_media."""
import builtins
from copy import deepcopy
import difflib
import json
import os
from pathlib import Path
import socket
import sys

import pytest
from PIL import Image
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from reference import media
from reference.factories import avatar, translate
from reference.inputs import ROOT, canonical, frozen_inputs, load_manifest, read, save, sha
from reference.providers import Fixture
from reference.runtime import Runner, report

EXAMPLE = ROOT/'examples/avatar/manifest.json'
CONFIG = {'provider': 'fixture', 'image_limit': 3}


@pytest.fixture(autouse=True)
def no_external(monkeypatch):
    original = builtins.__import__
    def no_sdk(name, *args, **kwargs):
        if name.split('.')[0] in ('boto3', 'botocore'): raise AssertionError('SDK forbidden')
        return original(name, *args, **kwargs)
    def no_network(*args, **kwargs): raise AssertionError('Network forbidden')
    monkeypatch.setattr(builtins, '__import__', no_sdk)
    monkeypatch.setattr(socket.socket, 'connect', no_network)
    monkeypatch.setattr(socket, 'create_connection', no_network)
    for key in list(os.environ):
        if key.startswith(('AWS_', 'BEDROCK_', 'OPENAI_', 'ANTHROPIC_')): monkeypatch.delenv(key)


@pytest.fixture
def local_stubs(monkeypatch):
    monkeypatch.setattr(avatar, 'execution_identity', lambda: {'explicit_stub': True})
    def synthesize(blocks, directory, config, supplied, **kwargs):
        directory.mkdir(parents=True, exist_ok=True)
        path = directory/'narration.wav'; path.write_bytes(b'explicit graph stub; not media execution')
        row = {'file': path.name, 'sha256': sha(path.read_bytes())}
        begin = config.get('leading_gap_ms', 0)
        timed = [{**b, 'index': i, 'start_ms': begin+i*800, 'end_ms':begin+i*800+500} for i,b in enumerate(blocks)]
        return {'schema':'local-narration/v1','audio':{**row,'duration_ms':timed[-1]['end_ms']},
                'clips':[{**row,'source_file':row}], 'blocks':timed,'words':[],
                'word_timing':'estimated','alignment_verified':False,'assembly':config,'config':config}
    monkeypatch.setattr(avatar.media, 'synthesize', synthesize)
    def render(card, audio, artwork, directory, **kwargs):
        directory.mkdir(parents=True, exist_ok=True)
        frames=[]
        for i,view in enumerate(('wide','wide','wide','app_crop','face_crop')):
            path=directory/f'frame-{i}.png'
            Image.new('RGB',(10,15),(40*i,100,50)).save(path)
            frames.append({'file':path.name,'sha256':sha(path.read_bytes()),'format':'png','width':10,'height':15,
                           'view':view,'frame_index':i,'t_ms':i*100})
        video=directory/'playback.mp4'; video.write_bytes(b'explicit graph stub, not a real video')
        result={'status':'complete','reviewer_frames':frames,'files':frames+[{'file':video.name,'sha256':sha(video.read_bytes())}],
                'motion':{'peak_frame_index':1},'diagnostics':[]}
        save(directory/'manifest.json', result)
        return result
    monkeypatch.setattr(avatar.avatar_media,'render_avatar',render)


def make_run(directory, limit=3, manifest=EXAMPLE):
    bundle,blobs=load_manifest(manifest,avatar)
    directory.mkdir(exist_ok=True)
    return Runner(directory,avatar,bundle=bundle,blobs=blobs,config={**CONFIG,'image_limit':limit})


@pytest.mark.parametrize('limit,count', [(3,2),(2,4),(1,6)])
def test_real_graph_no_author_advisory_negative_pixel_isolation_resume(tmp_path,local_stubs,limit,count):
    run=make_run(tmp_path,limit)
    graph=avatar.graph(run)
    assert all('author' not in n for n in graph.get_graph().nodes)
    graph.invoke({'last_role':'start'})
    summary=report(tmp_path,avatar)
    assert summary['status']=='complete' and summary['requests']==count and summary['exposure_usd']==0
    for path in (tmp_path/'requests').glob('*.json'):
        request=read(path)
        blocks=request['messages'][0]['content']
        images=[b for b in blocks if 'image' in b]
        assert 1<=len(images)<=limit
        payload=json.loads(blocks[0]['text'].split('Declared task data:\n',1)[1])['task_inputs']
        assert len(payload['frames'])==len(images)
        assert payload['quality_gate'] is False
        assert payload['card']['blocks'][0]['kind']=='title'
        for forbidden in ('AGENTS.md','SKILL.md',str(ROOT),str(tmp_path),'operator_history','production_path'):
            assert forbidden not in json.dumps(request)
    for path in (tmp_path/'artifacts').glob('*_observations.json'):
        value=read(path)
        assert value['quality_gate'] is False and value['artifacts_withheld'] is False
        assert all(v['verdict']=='fail' for v in value['inspections'])
    before={str(p.relative_to(tmp_path)):sha(p.read_bytes()) for directory in ('requests','responses','checkpoints')
            for p in (tmp_path/directory).glob('*.json')}
    ledger=(tmp_path/'synthetic-ledger.json').read_bytes()
    avatar.graph(Runner(tmp_path,avatar,resume=True)).invoke({'last_role':'start'})
    assert ledger==(tmp_path/'synthetic-ledger.json').read_bytes()
    assert before=={str(p.relative_to(tmp_path)):sha(p.read_bytes()) for directory in ('requests','responses','checkpoints')
                   for p in (tmp_path/directory).glob('*.json')}


def test_native_title_lines_and_local_card_identity_keep_exact_words_only(tmp_path,local_stubs):
    bundle,_=load_manifest(EXAMPLE,avatar)
    raw=bundle['declared']['deck']['cards'][0]
    raw.update(card_id='synthetic-local-welcome', production_path='PRIVATE_OPERATIONAL_MARK')
    raw['lines'][0].update(display='Exact display',audio='Different exact speech',audio_url='PRIVATE_OPERATIONAL_MARK')
    card=avatar.targets(bundle)[0]
    desc=avatar.descriptor(bundle,card)
    assert desc['card_idx']==1 and desc['card_id']=='synthetic-local-welcome' and desc['card_type']=='welcome'
    assert desc['blocks']==[{'index':0,'kind':'title','display':raw['title'],'audio':raw['title']},
                            {'index':1,'kind':'line','display':'Exact display','audio':'Different exact speech'}]
    assert 'PRIVATE_OPERATIONAL_MARK' not in json.dumps(desc)
    bundle['declared']['targets']['targets'][0]['card_idx']=2
    with pytest.raises(ValueError,match='welcome/summary'):avatar.targets(bundle)


def test_render_failure_reports_operational_failure_no_model_or_quality_gate(tmp_path,local_stubs,monkeypatch):
    monkeypatch.setattr(avatar.avatar_media,'render_avatar',lambda *a,**k:{'status':'failed','diagnostics':['injected encoding error']})
    run=make_run(tmp_path)
    with pytest.raises(RuntimeError,match='local render failed'):avatar.graph(run).invoke({'last_role':'start'})
    summary=report(tmp_path,avatar)
    assert summary['status']=='partial_or_failed' and summary['requests']==0
    assert summary['operational_stages']['avatar_c001_render']['status']=='failed'
    assert all(v['quality_gate'] is False for v in summary['operational_stages'].values())


def test_frozen_artwork_and_actual_derived_frame_mutation_refused(tmp_path,local_stubs):
    run=make_run(tmp_path)
    avatar.graph(run).invoke({'last_role':'start'})
    (tmp_path/'media/avatar_c001/frame-0.png').write_bytes(b'corrupt')
    with pytest.raises(ValueError,match='Frozen rendered asset changed'):
        avatar.graph(Runner(tmp_path,avatar,resume=True)).invoke({'last_role':'start'})
    frozen=tmp_path/'inputs'/run.bundle['file_identity']['artwork']['file']
    frozen.write_bytes(b'changed')
    with pytest.raises(ValueError,match='Frozen declared file changed'):frozen_inputs(tmp_path)


def test_look_schema_native_fields_bad_card_and_malformed_payload(tmp_path,local_stubs,monkeypatch):
    assert avatar.parse('look',json.dumps({'card_idx':1,'verdict':'fail','reason':'negative advisory','checked':['mouth']}))['verdict']=='fail'
    for payload in ({'card_idx':1,'ok':True},{'card_idx':1,'verdict':'unknown','reason':'bad'},{'card_idx':1,'verdict':'pass','reason':'x','artifact':{}}):
        with pytest.raises(Exception):avatar.parse('look',json.dumps(payload))
    original=Fixture.invoke
    def wrong(self,request,**kwargs):
        result=original(self,request,**kwargs)
        value=json.loads(result['output']['message']['content'][0]['text']);value['card_idx']=999
        result['output']['message']['content'][0]['text']=json.dumps(value)
        return result
    monkeypatch.setattr(Fixture,'invoke',wrong)
    run=make_run(tmp_path)
    with pytest.raises(ValueError,match='required model stage unavailable'):avatar.graph(run).invoke({'last_role':'start'})
    assert report(tmp_path,avatar)['status']=='partial_or_failed'
    assert (tmp_path/'media/avatar_c001/playback.mp4').exists()


def test_native_r6_hindi_map_hash_byte_binding_and_silent_title(tmp_path,local_stubs):
    bundle,blobs=load_manifest(ROOT/'examples/translate/manifest.json',translate)
    translated=tmp_path/'r6';translated.mkdir()
    rr=Runner(translated,translate,bundle=bundle,blobs=blobs,config=CONFIG)
    translate.graph(rr).invoke({'last_role':'start'})
    bundle,blobs=load_manifest(EXAMPLE,avatar)
    bundle['declared']['speech']={'language':'hi','clips':{'1':['clip_001'],'12':['clip_001']}}
    bundle['declared']['translated_deck']=read(translated/'artifacts/deck_hi.json')
    bundle['declared']['index_map']=read(translated/'views/interleaved-index-map.json')
    bundle['declared']['translated_identity']=read(translated/'views/reference-identity.json')
    clip=b'explicit stub clip';blobs['declared-clip_001.binary']=clip
    bundle['declared']['clip_001']={'sha256':sha(clip),'bytes':len(clip)}
    bundle['file_identity']['clip_001']={'sha256':sha(clip),'type':'binary','file':'declared-clip_001.binary'}
    avatar.validate_inputs(bundle)
    card=avatar.targets(bundle)[1]; desc=avatar.descriptor(bundle,card)
    assert desc['card_idx']==12 and desc['blocks'][0]['audio']=='' and desc['blocks'][0]['kind']=='title'
    assert 'नमूना' in desc['blocks'][1]['audio']
    assert next(m['card_idx'] for m in bundle['declared']['index_map'] if m.get('original_card_idx')==12)!=12
    # Construct a fresh frozen input map, including the explicit R6 JSON files.
    for key in ('speech','translated_deck','index_map','translated_identity'):
        data=canonical(bundle['declared'][key]);name=f'declared-{key}.json';blobs[name]=data
        bundle['file_identity'][key]={'type':'json','sha256':sha(data),'file':name}
    directory=tmp_path/'avatar';directory.mkdir()
    run=Runner(directory,avatar,bundle=bundle,blobs=blobs,config=CONFIG)
    avatar.graph(run).invoke({'last_role':'start'})
    audio=read(directory/'media/avatar_c012_audio/narration.json')
    assert audio['blocks'][0]['start_ms']==0 and audio['blocks'][0]['end_ms']==600 and audio['blocks'][1]['start_ms']==600
    assert audio['assembly']['gap_ms']==300 and audio['blocks'][1]['index']==1
    bundle['declared']['translated_deck']['schema_version']=1
    with pytest.raises(ValueError,match='version2'):avatar.descriptor(bundle,card)
    bundle['declared']['translated_deck']['schema_version']=2
    bundle['declared']['translated_identity']['source_file_sha256']['deck']='wrong'
    with pytest.raises(ValueError,match='byte identity'):avatar.descriptor(bundle,card)


def test_exact_source_snapshots_schema_and_adapted_provenance():
    value=read(ROOT/'prompts/avatar/manifest.json')
    assert value['source_commit']=='0000000000000000000000000000000000000000'
    assert value['source_file_sha256']=='7010bca039b232f30cd8cbdb4c37b6f4ac7c5c9bd7cd789ad2c04e503c34dc9b'
    for entry in value['files']:
        orig,active,diff=(ROOT/entry[k] for k in ('snapshot_path','adapted_path','diff_path'))
        assert sha(orig.read_bytes())==entry['source_sha256']
        assert sha(active.read_bytes())==entry['adapted_sha256']
        assert sha(diff.read_bytes())==entry['diff_sha256']
        assert diff.read_text()==''.join(difflib.unified_diff(orig.read_text().splitlines(True),active.read_text().splitlines(True),fromfile=entry['snapshot_path'],tofile=entry['adapted_path']))
    schema=read(ROOT/'schemas/avatar-look.json')
    assert set(schema['properties'])=={'card_idx','verdict','reason','checked','head_in_frame'}
