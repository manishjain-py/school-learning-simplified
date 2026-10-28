"""Real synthetic tone/artwork media plumbing, without content or hosted calls."""
from array import array
import copy
import hashlib
import json
import math
from pathlib import Path
import shutil
import sys
import tempfile
import wave

import pytest
from PIL import Image, ImageChops, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from reference import avatar_media, media


@pytest.fixture
def local_dir():
    parent = media.ROOT/'.local/r8-avatar-media-tests'
    parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=parent) as directory:
        yield Path(directory)


@pytest.fixture(scope='module')
def installed():
    missing = [name for name in ('node', 'ffmpeg', 'ffprobe') if not shutil.which(name)]
    if missing or not (media.MEDIA/'node_modules/playwright').exists():
        pytest.skip('Real local media prerequisites unavailable: ' + ','.join(missing))
    identity = avatar_media.runtime_identity()
    if not identity['browser']['available']:
        pytest.skip('Pinned Playwright Chromium must be installed explicitly')
    assert identity['browser']['pixi'] == '8.22.0'
    assert identity['browser']['playwright'] == '1.64.1'
    assert set(identity['avatar']['files']) == {'reference/avatar_media.py', 'media/avatar-renderer.mjs', 'media/avatar-viewer.js'}
    return identity


def portrait(directory):
    image = Image.new('RGB', (512, 768), '#d9ebf1')
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((110, 400, 402, 760), 60, fill='#447e99')
    draw.ellipse((130, 80, 382, 420), fill='#efb892')
    draw.ellipse((190, 200, 210, 220), fill='#233342')
    draw.ellipse((302, 200, 322, 220), fill='#233342')
    path = directory/'portrait.png'
    image.save(path)
    return {'path': path, 'sha256': media._hash(path), 'face': {'x': 130, 'y': 80, 'width': 252, 'height': 340},
            'mouth': {'cx': 256, 'cy': 315, 'width': 70, 'max_height': 56}}


def tone_narration(directory):
    source = directory/'tone.wav'
    values = array('h', (round(9000*math.sin(2*math.pi*380*i/media.RATE)) if .2 <= i/media.RATE < 1 else 0 for i in range(30000)))
    with wave.open(str(source), 'wb') as audio:
        audio.setnchannels(1); audio.setsampwidth(2); audio.setframerate(media.RATE); audio.writeframes(values.tobytes())
    supplied = {i: {'path': source, 'sha256': media._hash(source)} for i in range(2)}
    blocks = [{'script': 'Synthetic title.', 'display': 'Synthetic title.', 'kind': 'title'},
              {'script': 'Synthetic tone.', 'display': 'Synthetic tone.', 'kind': 'line'}]
    narration = media.synthesize(blocks, directory/'audio', {'leading_gap_ms': 100, 'gap_ms': 300},
                                supplied_clips=supplied, allowed_roots=[directory])
    card = {'card_idx': 3, 'card_id': 'synthetic-3', 'card_type': 'welcome', 'title': 'Synthetic title.', 'expected_blocks': 2,
            'blocks': [{'index': i, 'kind': row['kind'], 'display': row['display'], 'audio': row['script']} for i, row in enumerate(blocks)]}
    return card, narration


@pytest.mark.parametrize('fps', [1, 6])
def test_actual_avatar_streams_changing_mouth_encoded_frames_and_crop(local_dir, installed, fps):
    artwork = portrait(local_dir)
    card, narration = tone_narration(local_dir)
    original_card, original_narration = copy.deepcopy(card), copy.deepcopy(narration)
    out = local_dir/'render'
    result = avatar_media.render_avatar(card, narration, artwork, out, narration_root=local_dir/'audio', allowed_roots=[local_dir], fps=fps)
    assert result['status'] == 'complete', result['diagnostics']
    assert card == original_card and narration == original_narration
    assert json.loads((out/'card.json').read_text()) == card
    assert (out/'artwork.png').read_bytes() == artwork['path'].read_bytes()
    assert result['execution']['deterministic_replay'] is True
    assert result['motion']['max_mouth_height'] > result['motion']['min_mouth_height'] + 40
    assert result['motion']['actual_encoded_last_frame_mean_pixel_error'] < 12
    assert result['config']['end_hold_ms'] >= 1000/fps
    frames = result['reviewer_frames']
    wide = [row for row in frames if row['view'] == 'wide']
    assert wide[0]['frame_index'] == 0
    assert wide[-1]['frame_index'] == result['config']['video_frame_count']-1
    assert len({row['sha256'] for row in wide}) >= 2
    peak = max(wide, key=lambda row: row['pcm_rms'])
    assert peak['frame_index'] == result['motion']['peak_frame_index']
    assert peak['mouth_height'] > wide[-1]['mouth_height'] + 40
    actual_peak = Image.open(out/peak['file']).convert('RGB')
    actual_last = Image.open(out/wide[-1]['file']).convert('RGB')
    # Compare encoded mouth pixels, not timestamps, frame names, or other motion.
    mouth_box = (220, 285, 292, 345)
    assert ImageChops.difference(actual_peak.crop(mouth_box), actual_last.crop(mouth_box)).getbbox()
    dark = lambda image: sum(1 for r, g, b in image.crop(mouth_box).get_flattened_data() if r < 100 and g < 70 and b < 100)
    assert dark(actual_peak) > dark(actual_last) + 1000
    crop = next(row for row in frames if row['view'] == 'app_crop')
    assert (crop['width'], crop['height']) == (290, 290) and crop['crop'] == [0, 56, 512, 568]
    expected = actual_peak.crop((0, 56, 512, 568)).resize((290, 290), Image.Resampling.LANCZOS)
    assert not ImageChops.difference(expected, Image.open(out/crop['file']).convert('RGB')).getbbox()
    assert any(row['view'] == 'face_crop' and row['width'] == 252 and row['height'] == 340 for row in frames)
    cues = json.loads((out/result['cues']['file']).read_text())
    assert cues['card_idx'] == 3 and cues['card_id'] == 'synthetic-3'
    assert [row['kind'] for row in cues['blocks']] == ['title', 'line']
    assert all(row['start_ms'] < row['end_ms'] for row in cues['blocks'])
    assert cues['blocks'][1]['start_ms']-cues['blocks'][0]['end_ms'] == pytest.approx(300)
    assert cues['alignment_verified'] is False
    streams = media.probe_media(out/'playback.mp4', allowed_roots=[local_dir])
    assert {'audio', 'video'} <= {row['codec_type'] for row in streams['streams']}
    assert float(streams['format']['duration'])*1000 == pytest.approx(result['config']['duration_ms'], abs=100)
    assert result['audio']['pcm_rms'] > 1
    with wave.open(str(out/'narration.wav')) as audio:
        assert audio.getnframes()/audio.getframerate()*1000 == pytest.approx(narration['audio']['duration_ms'])
    assert result['poster']['sha256'] == wide[-1]['sha256']
    for row in frames:
        assert row['source'] == 'decoded encoded playback.mp4'
        assert row['sha256'] == hashlib.sha256((out/row['file']).read_bytes()).hexdigest()
    assert 'not photorealistic or phoneme-accurate' in result['label']
    if fps == 6:
        _viewer_controls(out)


def _viewer_controls(out):
    """Exercise real native audio events, custom restart/replay and phone layout."""
    script = '''
import fs from 'node:fs';import path from 'node:path';import http from 'node:http';
const {chromium}=await import(PLAYWRIGHT_IMPORT);
const out=process.argv[1];
const files=new Set(['/viewer.html','/avatar-viewer.js','/artwork.png','/narration.wav']);
const types={'.html':'text/html','.js':'text/javascript','.wav':'audio/wav','.png':'image/png'};
const server=http.createServer((req,res)=>{if(!files.has(req.url)){res.writeHead(403);res.end();return;}const file=path.join(out,req.url),total=fs.statSync(file).size,range=req.headers.range?.match(/^bytes=(\\d+)-(\\d*)$/),start=range?Number(range[1]):0,end=range&&range[2]?Number(range[2]):total-1;res.writeHead(range?206:200,{'Content-Type':types[path.extname(req.url)],'Accept-Ranges':'bytes','Content-Length':end-start+1,...(range?{'Content-Range':`bytes ${start}-${end}/${total}`}:{})});fs.createReadStream(file,{start,end}).pipe(res);});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
let browser;
try{
 browser=await chromium.launch({headless:true,args:['--autoplay-policy=no-user-gesture-required']});
 const context=await browser.newContext({viewport:{width:390,height:950},serviceWorkers:'block'});
 await context.route('**/*',route=>files.has(new URL(route.request().url()).pathname)&&route.request().url().startsWith(origin+'/')?route.continue():route.abort());
 const page=await context.newPage();await page.goto(origin+'/viewer.html');await page.waitForFunction(()=>window.mediaReady);
 if(await page.evaluate(()=>document.documentElement.scrollWidth)>390)throw new Error('Phone viewer overflows');
 await page.evaluate(()=>document.getElementById('audio').play());
 await page.waitForFunction(()=>window.currentTime>200,{},{timeout:3000});
 await page.evaluate(()=>document.getElementById('audio').pause());
 const paused=await page.evaluate(()=>window.currentTime);await page.waitForTimeout(100);
 if(Math.abs(await page.evaluate(()=>window.currentTime)-paused)>30)throw new Error('Native pause did not stop mouth clock');
 await page.evaluate(()=>{document.getElementById('audio').currentTime=1.85;});
 await page.waitForFunction(()=>Math.abs(window.currentTime-1850)<25,{},{timeout:2000});
 await page.locator('#restart').click();await page.waitForFunction(()=>window.currentTime<1);
 await page.evaluate(async()=>{const audio=document.getElementById('audio');audio.currentTime=audio.duration-.1;await audio.play();});
 await page.waitForFunction(()=>window.currentTime>=window.LOCAL_CONFIG.duration_ms,{},{timeout:3000});
 await page.locator('#play').click();
 await page.waitForFunction(()=>!document.getElementById('audio').paused&&window.currentTime<1000,{},{timeout:2000});
 await page.evaluate(()=>document.getElementById('audio').pause());
 await context.close();console.log('native audio controls, seek, completion hold, replay and phone layout passed');
}finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
'''.replace('PLAYWRIGHT_IMPORT', json.dumps((media.MEDIA/'node_modules/playwright/index.mjs').as_uri()))
    assert 'passed' in media._run([media._tool('node'), '--input-type=module', '-e', script, out], timeout=30)


def test_avatar_missing_corrupt_hash_and_identity_inputs_fail_honestly(local_dir):
    artwork = portrait(local_dir)
    card, narration = tone_narration(local_dir)
    def render(name, art=artwork, speech=narration, descriptor=card):
        return avatar_media.render_avatar(descriptor, speech, art, local_dir/name, narration_root=local_dir/'audio', allowed_roots=[local_dir], fps=1)
    wrong = copy.deepcopy(artwork); wrong['sha256'] = '0'*64
    result = render('wrong-artwork', wrong)
    assert result['status'] == 'failed' and 'Artwork hash mismatch' in result['diagnostics'][-1]['message']
    absent = copy.deepcopy(artwork); absent['path'] = local_dir/'absent.png'
    assert render('missing-artwork', absent)['status'] == 'failed'
    corrupt = local_dir/'corrupt.png'; corrupt.write_bytes(b'not a PNG')
    bad_art = {**artwork, 'path': corrupt, 'sha256': media._hash(corrupt)}
    assert render('corrupt-artwork', bad_art)['status'] == 'failed'
    speech = copy.deepcopy(narration); speech['clips'][0]['source_file']['sha256'] = '0'*64
    result = render('wrong-source-clip', speech=speech)
    assert result['status'] == 'failed' and 'Narration source clip hash mismatch' in result['diagnostics'][-1]['message']
    speech = copy.deepcopy(narration); speech['audio']['file'] = 'missing.wav'
    assert render('missing-audio', speech=speech)['status'] == 'failed'
    corrupt_audio = local_dir/'audio/corrupt.wav'; corrupt_audio.write_bytes(b'not audio')
    speech['audio'] = {'file': 'corrupt.wav', 'sha256': media._hash(corrupt_audio), 'duration_ms': 1200}
    result = render('corrupt-audio', speech=speech)
    assert result['status'] == 'failed' and 'ffmpeg failed' in result['diagnostics'][-1]['message']
    descriptor = copy.deepcopy(card); descriptor['blocks'][1]['audio'] = 'Different synthetic text.'
    result = render('wrong-block', descriptor=descriptor)
    assert result['status'] == 'failed' and 'block identity/text/order' in result['diagnostics'][-1]['message']
    descriptor = copy.deepcopy(card); descriptor['card_type'] = 'teaching'
    assert render('ineligible-card', descriptor=descriptor)['status'] == 'failed'
    assert json.loads((local_dir/'ineligible-card/card.json').read_text()) == descriptor
    with pytest.raises(media.MediaError, match='allowed_roots'):
        avatar_media.render_avatar(card, narration, artwork, local_dir/'outside', narration_root=local_dir/'audio', allowed_roots=[])


def test_low_fps_energy_covers_audible_samples_between_frame_starts(local_dir, installed):
    artwork = portrait(local_dir)
    source = local_dir/'short-tone.wav'
    values = array('h', (round(9000*math.sin(2*math.pi*380*i/media.RATE)) if .1 <= i/media.RATE < .2 else 0 for i in range(7200)))
    with wave.open(str(source), 'wb') as audio:
        audio.setnchannels(1); audio.setsampwidth(2); audio.setframerate(media.RATE); audio.writeframes(values.tobytes())
    blocks = [{'script': 'Synthetic title.', 'kind': 'title'}, {'script': 'Synthetic tone.', 'kind': 'line'}]
    narration = media.synthesize(blocks, local_dir/'audio', {'gap_ms': 0},
                                supplied_clips={i: {'path': source, 'sha256': media._hash(source)} for i in range(2)}, allowed_roots=[local_dir])
    card = {'card_idx': 0, 'card_type': 'welcome', 'title': 'Synthetic title.', 'expected_blocks': 2,
            'blocks': [{'index': i, 'kind': row['kind'], 'display': row['script'], 'audio': row['script']} for i, row in enumerate(blocks)]}
    result = avatar_media.render_avatar(card, narration, artwork, local_dir/'render', narration_root=local_dir/'audio', allowed_roots=[local_dir], fps=1)
    assert result['status'] == 'complete', result['diagnostics']
    assert result['audio']['duration_ms'] == 600
    assert result['motion']['peak_frame_index'] == 0
    assert result['motion']['max_mouth_height'] > result['motion']['min_mouth_height'] + 40
    assert result['config']['end_hold_ms'] >= 1000


def test_avatar_finite_anchors_and_cue_intervals(local_dir):
    artwork = portrait(local_dir)
    card, narration = tone_narration(local_dir)
    artwork['mouth']['cx'] = float('nan')
    result = avatar_media.render_avatar(card, narration, artwork, local_dir/'invalid-anchor', narration_root=local_dir/'audio', allowed_roots=[local_dir])
    assert result['status'] == 'failed' and 'finite mouth cx' in result['diagnostics'][-1]['message']
    artwork = portrait(local_dir)
    speech = copy.deepcopy(narration); speech['blocks'][1]['start_ms'] = speech['blocks'][0]['end_ms']-10
    result = avatar_media.render_avatar(card, speech, artwork, local_dir/'overlap', narration_root=local_dir/'audio', allowed_roots=[local_dir])
    assert result['status'] == 'failed' and 'finite block start_ms' in result['diagnostics'][-1]['message']


def test_avatar_missing_node_retains_card_and_does_not_create_video(local_dir, monkeypatch):
    artwork = portrait(local_dir)
    card, narration = tone_narration(local_dir)
    original = shutil.which
    monkeypatch.setattr(shutil, 'which', lambda name: None if name == 'node' else original(name))
    result = avatar_media.render_avatar(card, narration, artwork, local_dir/'missing-node', narration_root=local_dir/'audio', allowed_roots=[local_dir])
    assert result['status'] == 'failed' and 'unavailable: node' in result['diagnostics'][-1]['message']
    assert not (local_dir/'missing-node/playback.mp4').exists()
    assert json.loads((local_dir/'missing-node/card.json').read_text()) == card


def test_display_only_hindi_title_requires_real_600ms_pcm_silence(local_dir):
    _, narration = tone_narration(local_dir)
    clip = narration['clips'][0]
    speech = media.synthesize([{'kind': 'line', 'script': 'Synthetic supplied Hindi path.', 'display': 'कृत्रिम चिह्न।'}], local_dir/'hi-audio',
                              {'leading_gap_ms': 600, 'gap_ms': 300, 'language': 'hi'},
                              supplied_clips={0: {'path': local_dir/'audio'/clip['file'], 'sha256': clip['sha256']}}, allowed_roots=[local_dir])
    speech['blocks'][0]['index'] = 1
    speech['blocks'].insert(0, {'index': 0, 'kind': 'title', 'script': '', 'display': 'कृत्रिम शीर्षक', 'start_ms': 0, 'end_ms': 600})
    card = {'card_idx': 0, 'card_type': 'summary', 'title': 'कृत्रिम शीर्षक', 'expected_blocks': 2,
            'blocks': [{'index': 0, 'kind': 'title', 'display': 'कृत्रिम शीर्षक', 'audio': ''},
                       {'index': 1, 'kind': 'line', 'display': 'कृत्रिम चिह्न।', 'audio': 'Synthetic supplied Hindi path.'}]}
    pcm = avatar_media._pcm(local_dir/'hi-audio'/speech['audio']['file'])
    cues = avatar_media._cues(card, speech, pcm)
    assert cues['blocks'][0]['end_ms'] == 600 and cues['blocks'][0]['audio'] == ''
    assert cues['blocks'][1]['start_ms'] == 600
    speech['blocks'][0]['end_ms'] = 599
    with pytest.raises(media.MediaError, match='600ms leading PCM silence'):
        avatar_media._cues(card, speech, pcm)
