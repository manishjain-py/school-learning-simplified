"""Graph contracts; mocks isolate model plumbing, real media is tested separately."""
import builtins
from copy import deepcopy
import difflib
import json
import os
from pathlib import Path
import re
import socket
import sys
from PIL import Image
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import run_factory as cli
import run_audio
from reference.factories import boards, visuals, media_common as c, translate
from reference.factories.visuals_fixture import payload, MARKER
from reference.inputs import ROOT, canonical, load_manifest, read, save, sha, frozen_inputs, runtime_identity
from reference.providers import Fixture
from reference.runtime import Runner, report

EXAMPLES = ROOT/'examples/visuals'
CONFIG = {'provider': 'fixture', 'image_limit': 3}


@pytest.fixture(autouse=True)
def offline(monkeypatch):
    original = builtins.__import__
    def no_sdk(name, *args, **kwargs):
        if name.split('.')[0] in ('boto3', 'botocore'): raise AssertionError('SDK forbidden')
        return original(name, *args, **kwargs)
    def forbidden(*args, **kwargs): raise AssertionError('Network forbidden')
    monkeypatch.setattr(builtins, '__import__', no_sdk)
    monkeypatch.setattr(socket.socket, 'connect', forbidden)
    monkeypatch.setattr(socket, 'create_connection', forbidden)
    for key in list(os.environ):
        if key.startswith(('AWS_', 'BEDROCK_', 'OPENAI_', 'ANTHROPIC_')): monkeypatch.delenv(key)


@pytest.fixture
def local_stubs(monkeypatch):
    monkeypatch.setattr(visuals, 'execution_identity', lambda: {'synthetic_tools': True})
    monkeypatch.setattr(boards, 'execution_identity', lambda: {'synthetic_tools': True})
    def render(artifact, directory, **kwargs):
        directory.mkdir(parents=True, exist_ok=True)
        rows = []
        for i, view in enumerate(('wide', 'wide', 'phone')):
            path = directory/f'frame-{i}.png'
            Image.new('RGB', (10, 7), (i*60, 100, 150)).save(path)
            rows.append({'file': path.name, 'format': 'png', 'width': 10, 'height': 7,
                         'sha256': sha(path.read_bytes()), 't_ms': i*300, 'view': view})
        result = {'status': 'complete', 'reviewer_frames': rows, 'files': rows, 'diagnostics': []}
        save(directory/'manifest.json', result)
        return result
    monkeypatch.setattr(visuals.media, 'render_visual', render)
    monkeypatch.setattr(visuals.media, 'render_svg', render)
    monkeypatch.setattr(boards.media, 'render_board', lambda plan, audio, directory, **kw: render(plan, directory))
    def speech(blocks, directory, config, supplied, **kwargs):
        directory.mkdir(parents=True, exist_ok=True)
        path = directory/'clip.wav'; path.write_bytes(b'explicit synthetic binary')
        clip = {'file': path.name, 'sha256': sha(path.read_bytes()), 'source_file': {'file':path.name,'sha256':sha(path.read_bytes())}}
        timeline, words = [], []
        for index, block in enumerate(blocks):
            matches = list(re.finditer(r'\S+', block['script']))
            start = index*10000
            timeline.append({**block, 'index': index, 'start_ms': start,
                             'end_ms': start+len(matches)*100})
            words.extend({'block': index, 'text': match.group(), 'char_start': match.start(),
                          'char_end': match.end(), 'start_ms': start+j*100, 'end_ms': start+(j+1)*100,
                          'timing_basis': 'estimated uniform word interpolation', 'alignment_verified': False}
                         for j, match in enumerate(matches))
        return {'audio': {**clip, 'duration_ms': timeline[-1]['end_ms']},
                'clips': [clip], 'blocks': timeline,
                'words': words, 'word_timing': 'estimated', 'alignment_verified': False}
    monkeypatch.setattr(boards.media, 'synthesize', speech)


def make_run(tmp, factory):
    bundle, blobs = load_manifest(EXAMPLES/(factory.NAME+'-manifest.json'), factory)
    tmp.mkdir(exist_ok=True)
    return Runner(tmp, factory, bundle=bundle, blobs=blobs, config=CONFIG)


@pytest.mark.parametrize('factory,count', [(visuals,13), (boards,3)])
def test_genuine_graph_final_owner_negative_review_resume_and_pixel_routing(tmp_path, local_stubs, factory, count):
    run = make_run(tmp_path, factory)
    factory.graph(run).invoke({'last_role':'start'})
    summary = report(tmp_path, factory)
    assert summary['status'] == 'complete' and summary['requests'] == count and summary['exposure_usd'] == 0
    requests = {p.stem:read(p) for p in (tmp_path/'requests').glob('*.json')}
    for role, request in requests.items():
        images = [b for b in request['messages'][0]['content'] if 'image' in b]
        assert bool(images) == role.endswith('_review')
        assert len(images) <= 3
        data = payload(request)
        assert MARKER in json.dumps(data, ensure_ascii=False)
        for prohibited in ('AGENTS.md', 'SKILL.md', str(ROOT), str(tmp_path)):
            assert prohibited not in json.dumps(request, ensure_ascii=False)
        if role.endswith('_final'):
            final = read(tmp_path/'artifacts'/(role+'.json'))
            assert final == run.output(role)['artifact']
            assert run.output(role)['dispositions'][0]['action'] == 'declined'
            assert data['review']['ok'] is False
    if factory is visuals:
        assert (tmp_path/'artifacts/visuals_c003_final.json').exists()
        assert (tmp_path/'artifacts/visuals_c003_interactive_final.json').exists()
    before = (tmp_path/'synthetic-ledger.json').read_bytes()
    factory.graph(Runner(tmp_path, factory, resume=True)).invoke({'last_role':'start'})
    assert before == (tmp_path/'synthetic-ledger.json').read_bytes()


@pytest.mark.parametrize('factory', [visuals,boards])
def test_final_render_failure_preserves_final_authorship_without_repair(tmp_path, local_stubs, monkeypatch, factory):
    original = factory.render
    def fail(run, role, *args):
        if role.endswith('_final'):
            result = {'status':'failed','reviewer_frames':[],'diagnostics':['explicit injected technical failure']}
            c.stage(run.workspace, role+'_render', result)
            return result
        return original(run, role, *args)
    monkeypatch.setattr(factory, 'render', fail)
    run = make_run(tmp_path, factory)
    factory.graph(run).invoke({'last_role':'start'})
    summary = report(tmp_path, factory)
    assert summary['status'] == 'partial_or_failed'
    assert all(s == 'ok' for s in summary['roles'].values())
    assert any(s['status'] == 'failed' for s in summary['operational_stages'].values())
    for role in factory.report_roles(tmp_path):
        if role.endswith('_final'):
            assert read(tmp_path/'artifacts'/(role+'.json')) == run.output(role)['artifact']
    assert len(run.ledger['calls']) == (13 if factory is visuals else 3)


def test_binary_asset_byte_freeze_and_frozen_frame_hash(tmp_path, local_stubs):
    manifest = read(EXAMPLES/'boards-manifest.json')
    for spec in manifest['files'].values(): spec['path'] = str(EXAMPLES/spec['path'])
    binary = tmp_path/'input.wav'; binary.write_bytes(b'not-decoded-by-this-input-freeze-test')
    manifest['files']['clip_001'] = {'path':str(binary),'type':'binary'}
    save(tmp_path/'manifest.json', manifest)
    bundle, blobs = load_manifest(tmp_path/'manifest.json', boards)
    workspace = tmp_path/'run'; workspace.mkdir()
    run = Runner(workspace, boards, bundle=bundle, blobs=blobs, config=CONFIG)
    boards.graph(run).invoke({'last_role':'start'})
    frame = next((workspace/'media/boards_c002_author').glob('frame-*.png'))
    frame.write_bytes(b'corrupt')
    with pytest.raises(ValueError, match='Frozen rendered asset changed'):
        boards.graph(Runner(workspace, boards, resume=True)).invoke({'last_role':'start'})
    frozen = workspace/'inputs'/bundle['file_identity']['clip_001']['file']
    frozen.write_bytes(b'changed')
    with pytest.raises(ValueError, match='Frozen declared file changed'): frozen_inputs(workspace)


def test_source_words_immutable_and_opaque_operator_fields_removed(tmp_path, local_stubs):
    run = make_run(tmp_path, visuals)
    # New explicit input identity, with unknown operational fields, gets projected.
    bundle = deepcopy(run.bundle)
    bundle['declared']['deck']['operator_history'] = 'PRIVATE_OPERATOR_MARK'
    for card in bundle['declared']['deck']['cards']:
        card['production_path'] = 'PRIVATE_OPERATOR_MARK'
        for line in card['lines']: line['audio_url'] = 'PRIVATE_OPERATOR_MARK'
    projected = c.cards(bundle)
    assert 'PRIVATE_OPERATOR_MARK' not in json.dumps(projected)
    for original, projection in zip(bundle['declared']['deck']['cards'], projected):
        assert projection['title'] == original['title']
        assert projection['lines'] == [{k:l[k] for k in ('display','audio')} for l in original['lines']]
    bundle['declared']['targets']['targets'][0]['card_idx'] = 1
    with pytest.raises(ValueError, match='excludes'): c.targets(bundle, 'visuals')


@pytest.mark.parametrize('all_none', [True,False])
def test_decide_no_visual_and_empty_interaction_nomination_are_honored(tmp_path,local_stubs,monkeypatch,all_none):
    original = Fixture.invoke
    def change(self, request, **kwargs):
        response = original(self,request,**kwargs)
        if kwargs['role'] == 'visuals_decide':
            value = json.loads(response['output']['message']['content'][0]['text'])
            value['artifact']['interactive_candidates'] = []
            if all_none:
                for row in value['artifact']['decisions']: row['decision'] = 'no_visual'
            response['output']['message']['content'][0]['text'] = json.dumps(value)
        return response
    monkeypatch.setattr(Fixture,'invoke',change)
    run = make_run(tmp_path,visuals)
    visuals.graph(run).invoke({'last_role':'start'})
    summary = report(tmp_path,visuals)
    assert summary['status']=='complete' and summary['requests']==(1 if all_none else 10)
    assert not any('_interactive_' in r for r in summary['roles'])
    if all_none:
        assert summary['roles']=={'visuals_decide':'ok'}
        assert not list((tmp_path/'media').glob('*'))


def test_safe_board_schedule_and_compile_diagnostics_remain_actionable(tmp_path):
    directory = tmp_path/'board'; directory.mkdir()
    save(directory/'scene.json',{'schema':'local-board/v1','cues':[{'line':0,'phrase':'Synthetic','start_ms':100,'end_ms':200}],
                               'timing':{'words':'estimated'},'source_path':'PRIVATE_PATH'})
    projected = c.board_schedule(directory)
    assert projected['cues'][0]['start_ms']==100 and 'PRIVATE_PATH' not in json.dumps(projected)
    diagnostics = c.safe_diagnostics([{'kind':'undrawn_nodes','targets':['mark']},
                  {'kind':'technical_failure','message':'Exact phrase occurrence not found'},
                  {'kind':'technical_failure','message':'private /Users/private-path'}])
    assert diagnostics[:2]==[{'kind':'undrawn_nodes','targets':['mark']},{'kind':'compile_failure','message':'Exact phrase occurrence not found'}]
    assert '/Users/' not in json.dumps(diagnostics)


def test_shared_practice_keeps_native_spoken_ask_and_explicit_feedback():
    assert 'run_audio.py' in runtime_identity()['files']
    pack={'questions':[{'format':'true_false','question_text':'DISPLAY CAPTION','statement':'DISPLAY CLAIM',
                        'audio_text':'EXACT SPOKEN CLAIM','options':['DO NOT SPEAK'],'explanation_why':'EXACT FEEDBACK'}]}
    rows,origins=run_audio.blocks({'metadata':{'kind':'practice'},'declared':{'pack':pack}})
    assert [r['script'] for r in rows]==['EXACT SPOKEN CLAIM','EXACT FEEDBACK']
    assert [r['kind'] for r in rows]==['question','feedback']
    assert origins[0]['speech_basis']=='authored audio_text'


def test_r6_binding_uses_exact_map_native_hash_and_pack_identity(tmp_path, local_stubs):
    # Run the existing R6 synthetic graph to create a real native translated pack.
    b, blobs = load_manifest(ROOT/'examples/translate/manifest.json', translate)
    translated = tmp_path/'translate'; translated.mkdir()
    rr = Runner(translated, translate, bundle=b, blobs=blobs, config=CONFIG)
    translate.graph(rr).invoke({'last_role':'start'})
    bundle, _ = load_manifest(EXAMPLES/'boards-manifest.json', boards)
    bundle['declared']['speech'].update(language='hi',voice='Lekha')
    bundle['declared']['translated_deck'] = read(translated/'artifacts/deck_hi.json')
    bundle['declared']['index_map'] = read(translated/'views/interleaved-index-map.json')
    bundle['declared']['translated_identity'] = read(translated/'views/reference-identity.json')
    card = next(c for c in c.cards(bundle) if c['card_idx'] == 6)
    assert 'नमूना' in c.narration_blocks(bundle, card)[0]['script']
    mapping = bundle['declared']['index_map']
    assert next(m['card_idx'] for m in mapping if m.get('original_card_idx') == 6) != 6
    bundle['declared']['translated_identity']['source_file_sha256']['deck'] = 'wrong'
    with pytest.raises(ValueError,match='byte identity'): c.narration_blocks(bundle, card)


@pytest.mark.parametrize('kind,path', [('explain','translate/deck.json'),('practice','translate/practice.json'),('revise','translate/revise.json')])
def test_shared_audio_projects_existing_native_pack_text(kind,path):
    rows, origins = run_audio.blocks({'metadata':{'kind':kind},'declared':{'pack':read(ROOT/'examples'/path)}})
    assert rows and len(origins) == len(rows)
    assert any(MARKER in row['script'] for row in rows)


def test_prompt_provenance_exact_hashes_and_diffs():
    value = read(ROOT/'prompts/visuals-manifest.json')
    assert value['source_commit'] == '0000000000000000000000000000000000000000'
    entries = value['files']
    assert len(entries) == 8
    for e in entries:
        original, active, diff = (ROOT/e[k] for k in ('snapshot_path','adapted_path','diff_path'))
        assert sha(original.read_bytes()) == e['source_sha256']
        assert sha(active.read_bytes()) == e['adapted_sha256']
        assert sha(diff.read_bytes()) == e['diff_sha256']
        assert diff.read_text() == ''.join(difflib.unified_diff(original.read_text().splitlines(True),active.read_text().splitlines(True),
                                    fromfile=e['snapshot_path'],tofile=e['adapted_path']))
