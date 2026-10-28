"""Actual local synthetic speech/pixels/streams; no curriculum or hosted calls."""
import copy
import hashlib
import json
from pathlib import Path
import shutil
import sys
import tempfile
import wave

import pytest
from PIL import Image, ImageChops, ImageFilter

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from reference import media


@pytest.fixture
def local_dir():
    parent = media.ROOT/'.local/r7-media-tests'
    parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=parent) as directory:
        yield Path(directory)


@pytest.fixture(scope='module')
def installed():
    missing = [name for name in ('say','node','ffmpeg','ffprobe') if not shutil.which(name)]
    if missing or not (media.MEDIA/'node_modules/playwright').exists():
        pytest.skip('Real local integration prerequisites unavailable: ' + ','.join(missing))
    identity = media.runtime_identity()
    if not identity['browser']['available']:
        pytest.skip('Pinned Playwright Chromium must be installed explicitly')
    assert identity['browser']['pixi'] == '8.22.0'
    assert identity['browser']['playwright'] == '1.64.1'
    return identity


def narration(directory):
    return media.synthesize(['Synthetic red mark. Synthetic blue mark.', 'Synthetic mark again.'],
        directory, {'voice':'Samantha','language':'en','rate':260,'gap_ms':317,'leading_gap_ms':123}, allowed_roots=[directory.parent])


def board():
    return {'card_idx':0,'route':'board','rationale':'Synthetic vector marks only.',
        'nodes':[{'id':'red','type':'rect','x':70,'y':80,'width':250,'height':180,'stroke':'#aa0000'},
                 {'id':'blue','type':'ellipse','cx':680,'cy':310,'rx':180,'ry':120,'stroke':'#0000aa'},
                 {'id':'label','type':'text','x':70,'y':500,'text':'SYNTHETIC MARKS','font_size':50},
                 {'id':'line','type':'line','x1':70,'y1':530,'x2':500,'y2':530},
                 {'id':'arrow','type':'arrow','x1':550,'y1':500,'x2':800,'y2':580},
                 {'id':'path','type':'path','d':'M 80 600 Q 250 550 480 620'}],
        'beats':[{'id':'red','line':0,'phrase':'red mark.','action':'draw','targets':['red','label','line']},
                 {'id':'blue','line':0,'phrase':'blue mark.','action':'draw','targets':['blue','arrow','path']},
                 {'id':'highlight','line':1,'phrase':'mark again.','action':'emphasize','targets':['red'],'hold_ms':100}]}


def visual():
    return {'output_type':'animated_visual','title':'Synthetic mark','duration_ms':1000,
        'pixi_code':'const mark=new PIXI.Graphics().circle(0,0,25).fill(0xee2233); app.stage.addChild(mark); globalThis.renderAt=t=>{mark.x=50+t/10;mark.y=110;}; globalThis.setParam=(name,value)=>{mark.scale.set(1+value);};',
        'interactive':{'type':'slider','param':'mark','x':40,'y':290,'width':300,'min':0,'max':1,'steps':10,'label':'Synthetic mark'}}


def test_real_narration_pcm_gaps_supplied_hash_and_timing(local_dir, installed):
    out = local_dir/'speech'
    result = narration(out)
    assert result['word_timing'] == 'estimated' and result['alignment_verified'] is False
    assert all(w['alignment_verified'] is False for w in result['words'])
    assert result['clips'][0]['pcm_rms'] > 1
    assert result['blocks'][0]['start_ms'] == 123
    assert result['blocks'][1]['start_ms']-result['blocks'][0]['end_ms'] == pytest.approx(317)
    with wave.open(str(out/result['audio']['file'])) as audio:
        assert result['audio']['duration_ms'] == pytest.approx(audio.getnframes()/audio.getframerate()*1000)
        assert audio.readframes(round(.123*24000)) == b'\0'*(round(.123*24000)*2)
    provided = {0:{'path':out/result['clips'][0]['file'],'sha256':result['clips'][0]['sha256']}}
    copied = media.synthesize(['Synthetic red mark. Synthetic blue mark.'],local_dir/'supplied',supplied_clips=provided,allowed_roots=[local_dir])
    assert copied['clips'][0]['source']['kind'] == 'supplied'
    assert copied['audio']['duration_ms'] == result['clips'][0]['duration_ms']
    provided[0]['sha256'] = '0'*64
    with pytest.raises(media.MediaError,match='hash mismatch'):
        media.synthesize(['Synthetic'],local_dir/'wrong-hash',supplied_clips=provided,allowed_roots=[local_dir])


def test_board_exact_occurrence_and_immutable_semantics(local_dir, installed):
    speech = narration(local_dir/'audio')
    plan = board(); original = copy.deepcopy(plan)
    scene = media.compile_board(plan,speech)
    assert plan == original
    assert scene['schema'] == 'local-board/v1' and scene['width'] == 1000
    scene['nodes'][0]['x'] = 999
    assert plan == original
    bad = copy.deepcopy(plan);bad['beats'][0]['phrase']='Synthetic'
    with pytest.raises(media.MediaError,match='occurrence'):
        media.compile_board(bad,speech)
    bad['beats'][0]['occurrence']=2
    assert next(c for c in media.compile_board(bad,speech)['cues'] if c['id']=='red')['occurrence']==2
    bad = copy.deepcopy(plan);bad['beats'][0]['action']='emphasize'
    with pytest.raises(media.MediaError,match='already completed'):
        media.compile_board(bad,speech)
    bad = copy.deepcopy(plan);bad['nodes'][0]['width']=float('nan')
    with pytest.raises(media.MediaError,match='finite'):
        media.compile_board(bad,speech)


def test_pixi_real_pixels_deterministic_clock_and_viewer_control(local_dir, installed):
    result=media.render_visual(visual(),local_dir/'visual',allowed_roots=[local_dir])
    assert result['status']=='complete',result['diagnostics']
    frames=result['reviewer_frames']
    assert len({f['sha256'] for f in frames if f['view']=='wide'})==3
    assert len({f['sha256'] for f in frames if f['view']=='interaction'})==3
    assert all((f['width'],f['height'])==(500,350) for f in frames)
    # Compare the drawing region alone so changed slider thumb pixels cannot
    # masquerade as an interaction changing the authored visual.
    controls=[Image.open(local_dir/'visual'/f['file']).crop((0,0,500,250)).convert('RGB') for f in frames if f['view']=='interaction']
    assert ImageChops.difference(controls[0],controls[-1]).getbbox()
    broken=visual();broken['pixi_code']='const dot=new PIXI.Graphics().circle(40,40,15).fill(0xff0000); app.stage.addChild(dot); globalThis.renderAt=t=>{dot.x+=10;}; globalThis.setParam=()=>{};'
    failed=media.render_visual(broken,local_dir/'nondeterministic',allowed_roots=[local_dir])
    assert failed['status']=='failed' and 'not deterministic' in failed['diagnostics'][-1]['message']


@pytest.mark.parametrize('fps', [1, 6])
def test_board_actual_audiovisual_streams_accumulated_ink_and_phone(local_dir, installed, fps):
    speech=narration(local_dir/'audio');plan=board()
    result=media.render_board(plan,speech,local_dir/'board',narration_root=local_dir/'audio',allowed_roots=[local_dir],fps=fps)
    assert result['status']=='complete',result['diagnostics']
    frames=result['reviewer_frames'];wide=[f for f in frames if f['view']=='wide']
    assert len({f['sha256'] for f in wide})>=4
    assert any(f['width']==390 for f in frames if f['view']=='phone')
    completed=Image.open(local_dir/'board'/wide[-1]['file']).convert('RGB')
    # Red ink remains after later blue-node drawing and emphasis.
    red=completed.getpixel((70,100));blue=completed.getpixel((860,310))
    assert red[0]>red[1] and blue[2]>blue[0]
    streams=media.probe_media(local_dir/'board/playback.mp4',allowed_roots=[local_dir])
    assert {'audio','video'}<={stream['codec_type'] for stream in streams['streams']}
    assert float(streams['format']['duration'])*1000==pytest.approx(result['config']['duration_ms'],abs=100)
    assert result['config']['end_hold_ms'] >= 1000/fps
    # Decode the actual final encoded frame: a scheduled endpoint screenshot alone
    # did not previously guarantee that the MP4 contained the completed ellipse.
    decoded=local_dir/'board/decoded-last.png'
    media._run([media._tool('ffmpeg'),'-v','error','-y','-i',local_dir/'board/playback.mp4','-vf','reverse','-frames:v','1',decoded])
    last=Image.open(decoded).convert('RGB')
    masks=[]
    for frame in (completed,last):
        mask=Image.new('L',frame.size)
        mask.putdata([255*int(b>r+60 and b>g+60) for r,g,b in frame.get_flattened_data()])
        masks.append(mask)
    overlap=ImageChops.multiply(masks[0],masks[1].filter(ImageFilter.MaxFilter(3)))
    assert sum(x>0 for x in overlap.get_flattened_data())/sum(x>0 for x in masks[0].get_flattened_data()) > .99
    for frame in frames:
        assert frame['sha256']==hashlib.sha256((local_dir/'board'/frame['file']).read_bytes()).hexdigest()
    assert json.loads((local_dir/'board/author.json').read_text())==plan


def test_svg_pixels_and_unsupported_remote_content_retained(local_dir, installed):
    svg={'medium':'svg_illustration','source_medium':'illustration','adaptation':'Synthetic SVG shape composition',
         'svg_source':'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 500 350"><rect x="10" y="10" width="200" height="120" fill="#2255aa"/></svg>'}
    good=media.render_svg(svg,local_dir/'svg',allowed_roots=[local_dir])
    assert good['status']=='complete',good['diagnostics']
    image=Image.open(local_dir/'svg'/good['reviewer_frames'][0]['file']).convert('RGB')
    assert image.getpixel((20,20))==(34,85,170)
    svg['svg_source']='<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.invalid/private.png"/></svg>'
    bad=media.render_svg(svg,local_dir/'unsupported',allowed_roots=[local_dir])
    assert bad['status']=='failed' and bad['reviewer_frames']==[]
    assert json.loads((local_dir/'unsupported/author.json').read_text())==svg


def test_missing_tool_voice_language_and_allowlist_failure_retains_scripts(local_dir, monkeypatch):
    with pytest.raises(media.MediaError,match='allowed_roots'):
        media.synthesize(['Synthetic'],local_dir/'outside',allowed_roots=[])
    monkeypatch.setattr(media,'installed_voices',lambda:[{'voice':'Samantha','locale':'en_US'}])
    with pytest.raises(media.MediaError,match='voice/language'):
        media.synthesize(['Synthetic'],local_dir/'voice',{'voice':'Samantha','language':'hi'},allowed_roots=[local_dir])
    assert (local_dir/'voice/scripts.json').exists()
    original=shutil.which
    monkeypatch.setattr(shutil,'which',lambda name:None if name=='node' else original(name))
    failed=media.render_visual(visual(),local_dir/'missing-node',allowed_roots=[local_dir])
    assert failed['status']=='failed'
    assert json.loads((local_dir/'missing-node/author.json').read_text())==visual()
    assert any('unavailable: node' in item['message'] for item in failed['diagnostics'])


def test_corrupt_silent_supplied_audio_never_becomes_narration(local_dir):
    corrupt=local_dir/'broken.wav';corrupt.write_bytes(b'not audio')
    supplied={0:{'path':corrupt,'sha256':hashlib.sha256(corrupt.read_bytes()).hexdigest()}}
    if shutil.which('ffmpeg'):
        with pytest.raises(media.MediaError,match='ffmpeg failed'):
            media.synthesize(['Synthetic'],local_dir/'broken',supplied_clips=supplied,allowed_roots=[local_dir])
        silent=local_dir/'silent.wav'
        with wave.open(str(silent),'wb') as audio:
            audio.setnchannels(1);audio.setsampwidth(2);audio.setframerate(24000);audio.writeframes(b'\0'*4800)
        supplied={0:{'path':silent,'sha256':hashlib.sha256(silent.read_bytes()).hexdigest()}}
        with pytest.raises(media.MediaError,match='audible PCM'):
            media.synthesize(['Synthetic'],local_dir/'silent',supplied_clips=supplied,allowed_roots=[local_dir])


def test_supplied_alignment_retains_caller_provenance_not_local_asr(local_dir, installed):
    speech=media.synthesize(['Synthetic mark.'],local_dir/'source',allowed_roots=[local_dir])
    duration=speech['clips'][0]['duration_ms']
    provenance={'method':'synthetic fixture word intervals; no real ASR','fixture':True}
    supplied={0:{'path':local_dir/'source'/speech['clips'][0]['file'],'sha256':speech['clips'][0]['sha256'],
        'alignment':{'words':[{'text':'Synthetic','start_ms':0,'end_ms':duration/3},
                              {'text':'mark.','start_ms':duration/2,'end_ms':duration}],
                     'provenance':provenance,'alignment_verified':False}}}
    result=media.synthesize(['Synthetic mark.'],local_dir/'aligned',supplied_clips=supplied,allowed_roots=[local_dir])
    assert result['word_timing']=='supplied' and result['alignment_verified'] is False
    assert result['words'][0]['alignment_provenance']==provenance
    assert result['words'][1]['start_ms']==duration/2
    assert 'no local ASR' in result['words'][0]['verification_source']
    supplied[0]['alignment']['words'][1]['start_ms']=0
    with pytest.raises(media.MediaError,match='finite alignment start'):
        media.synthesize(['Synthetic mark.'],local_dir/'bad-alignment',supplied_clips=supplied,allowed_roots=[local_dir])


def test_visual_declared_duration_captures_late_completion_and_full_viewer(local_dir, installed):
    authored=visual();authored['duration_ms']=3000
    authored['pixi_code']='const mark=new PIXI.Graphics().circle(0,0,20).fill(0xee2233); app.stage.addChild(mark); globalThis.renderAt=t=>{mark.x=40+Math.min(t,3000)/3000*400;mark.y=110;}; globalThis.setParam=()=>{};'
    result=media.render_visual(authored,local_dir/'late',allowed_roots=[local_dir])
    assert result['status']=='complete',result['diagnostics']
    wide=[row for row in result['reviewer_frames'] if row['view']=='wide']
    assert [row['t_ms'] for row in wide]==[0,1500,3000]
    assert result['config']['duration_ms']==3000
    completed=Image.open(local_dir/'late'/wide[-1]['file']).convert('RGB')
    early=Image.open(local_dir/'late'/wide[0]['file']).convert('RGB')
    assert completed.getpixel((440,110))==(238,34,51)
    assert early.getpixel((440,110))==(255,255,255)
    config=json.loads((local_dir/'late/render-config.json').read_text())
    assert config['duration_ms']==3000
    # Explicit later capture times extend, rather than truncate, viewer playback.
    explicit=media.render_visual(authored,local_dir/'explicit',allowed_roots=[local_dir],frame_times_ms=[0,4000])
    assert explicit['status']=='complete' and explicit['config']['duration_ms']==4000
