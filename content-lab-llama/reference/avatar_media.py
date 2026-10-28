"""New local stylized Avatar media ABI; no source engine or hosted generation.

An explicit 512x768 PNG is animated by a declared mouth overlay. Decoded PCM RMS
controls mouth height; this does not estimate phonemes or establish lip-sync.
"""
from __future__ import annotations

from array import array
import copy
import hashlib
import json
import math
from pathlib import Path
import shutil
import wave

from PIL import Image, ImageChops, ImageStat

from . import media

WIDTH, HEIGHT = 512, 768
LABEL = 'Stylized audio-energy-driven mouth animation; not photorealistic or phoneme-accurate lip-sync.'


def runtime_identity():
    identity = media.runtime_identity()
    identity['avatar'] = {
        'schema': 'local-avatar-identity/v1', 'label': LABEL,
        'files': {str(path.relative_to(media.ROOT)): media._hash(path) for path in
                  [Path(__file__), media.MEDIA/'avatar-renderer.mjs', media.MEDIA/'avatar-viewer.js']},
        'dimensions': [WIDTH, HEIGHT], 'energy_window': 'entire video-frame interval, clipped to decoded PCM',
        'app_crop': {'x': 0, 'y': 56, 'width': 512, 'height': 512, 'output_width': 290, 'output_height': 290},
    }
    return identity


def _source(root, descriptor, allowed_roots, name):
    if not isinstance(descriptor, dict) or not isinstance(descriptor.get('file'), str):
        raise media.MediaError(f'Missing {name} file descriptor')
    filename = Path(descriptor['file'])
    if filename.is_absolute() or '..' in filename.parts:
        raise media.MediaError(f'{name} filename must be relative to its explicit root')
    path = media._allowed(root/filename, allowed_roots)
    if not path.is_relative_to(root) or not path.is_file():
        raise media.MediaError(f'Missing {name} file')
    if media._hash(path) != descriptor.get('sha256'):
        raise media.MediaError(f'{name} hash mismatch')
    return path


def _geometry(artwork):
    face = copy.deepcopy(artwork.get('face'))
    mouth = copy.deepcopy(artwork.get('mouth'))
    if not isinstance(face, dict) or set(face) != {'x', 'y', 'width', 'height'}:
        raise media.MediaError('Artwork needs explicit face x/y/width/height in portrait pixels')
    if not isinstance(mouth, dict) or set(mouth) - {'cx', 'cy', 'width', 'max_height', 'closed_height'} or not {'cx', 'cy', 'width', 'max_height'} <= set(mouth):
        raise media.MediaError('Artwork needs explicit mouth cx/cy/width/max_height')
    for key, value in face.items():
        media._number(value, 'face '+key, 0, HEIGHT)
    if face['width'] <= 0 or face['height'] <= 0 or face['x']+face['width'] > WIDTH or face['y']+face['height'] > HEIGHT:
        raise media.MediaError('Face bounds exceed portrait dimensions')
    mouth.setdefault('closed_height', 3)
    for key, value in mouth.items():
        media._number(value, 'mouth '+key, 0, HEIGHT)
    if not 0 < mouth['closed_height'] < mouth['max_height'] <= face['height'] or mouth['width'] <= 0:
        raise media.MediaError('Mouth heights must be positive, closed < max, inside face')
    if not (face['x'] <= mouth['cx']-mouth['width']/2 and mouth['cx']+mouth['width']/2 <= face['x']+face['width'] and
            face['y'] <= mouth['cy']-mouth['max_height']/2 and mouth['cy']+mouth['max_height']/2 <= face['y']+face['height']):
        raise media.MediaError('Mouth bounds must lie inside explicit face bounds')
    return face, mouth


def _pcm(path):
    with wave.open(str(path), 'rb') as source:
        if (source.getnchannels(), source.getsampwidth(), source.getframerate()) != (1, 2, media.RATE):
            raise media.MediaError('Decoded narration must be 24kHz mono 16-bit PCM')
        pcm = array('h', source.readframes(source.getnframes()))
    return pcm


def _rms(pcm, start, end):
    values = pcm[max(0, start):min(len(pcm), end)]
    return math.sqrt(sum(value*value for value in values)/len(values)) if values else 0.0


def _cues(card, narration, pcm):
    if not isinstance(card, dict) or card.get('card_type') not in {'welcome', 'summary'} or type(card.get('card_idx')) is not int or card['card_idx'] < 0:
        raise media.MediaError('Avatar requires an eligible welcome/summary card and native card_idx')
    blocks = card.get('blocks')
    if not isinstance(blocks, list) or not blocks or type(card.get('expected_blocks')) is not int or card['expected_blocks'] != len(blocks):
        raise media.MediaError('Card expected_blocks must match its explicit ordered blocks')
    timed = narration.get('blocks')
    if narration.get('schema') != 'local-narration/v1' or not isinstance(timed, list) or len(timed) != len(blocks):
        raise media.MediaError('Narration must contain every declared card block')
    cues, previous = [], 0
    duration = len(pcm)/media.RATE*1000
    for index, (block, timeline) in enumerate(zip(blocks, timed)):
        if not isinstance(block, dict) or set(block) != {'index', 'kind', 'display', 'audio'} or block.get('index') != index or type(block['index']) is not int:
            raise media.MediaError('Card blocks require ordered zero-based indices/kind/display/audio')
        if block['kind'] != ('title' if index == 0 else 'line') or not isinstance(block['display'], str) or not block['display'].strip() or not isinstance(block['audio'], str):
            raise media.MediaError('Title block must precede nonempty display line blocks')
        if index == 0 and block['display'] != card.get('title'):
            raise media.MediaError('Card title does not match title block display')
        if not isinstance(timeline, dict) or timeline.get('index') != index or any(timeline.get(key) != block[value] for key, value in [('kind', 'kind'), ('script', 'audio'), ('display', 'display')]):
            raise media.MediaError('Narration block identity/text/order mismatch')
        start = media._number(timeline.get('start_ms'), 'block start_ms', previous, duration)
        end = media._number(timeline.get('end_ms'), 'block end_ms', start, duration)
        if end <= start:
            raise media.MediaError('Block cue intervals must be positive and nonoverlapping')
        if not block['audio'].strip():
            if index != 0 or start != 0 or abs(end-600) > 1/media.RATE*1000 or _rms(pcm, 0, round(end*media.RATE/1000)) >= 1:
                raise media.MediaError('Display-only title requires explicit 600ms leading PCM silence')
        elif _rms(pcm, round(start*media.RATE/1000), round(end*media.RATE/1000)) < 1:
            raise media.MediaError('Spoken block has no audible decoded PCM energy')
        cues.append({**copy.deepcopy(block), 'start_ms': start, 'end_ms': end,
                     'timing_basis': 'measured decoded PCM; block identity supplied by caller'})
        previous = end
    return {'schema': 'local-avatar-cues/v1', **{key: copy.deepcopy(card[key]) for key in ('card_idx', 'card_id', 'card_type', 'title', 'expected_blocks') if key in card},
            'blocks': cues, 'duration_ms': duration, 'word_timing': narration.get('word_timing'),
            'alignment_verified': narration.get('alignment_verified', False),
            'alignment_limit': 'No local ASR or phoneme alignment is performed.'}


def _extract(out, frame_index, fps, view, box=None, size=None):
    target = out/'frames'/f'{frame_index:06d}-{view}.png'
    media._run([media._tool('ffmpeg'), '-v', 'error', '-y', '-i', out/'playback.mp4', '-vf',
                f'select=eq(n\\,{frame_index})', '-vsync', '0', '-frames:v', '1', target])
    with Image.open(target) as image:
        image.load()
        if box is not None:
            image = image.crop(box)
        if size is not None:
            image = image.resize(size, Image.Resampling.LANCZOS)
        image.save(target)
        width, height = image.size
    return media._descriptor(target, out, format='png', width=width, height=height,
                             t_ms=frame_index/fps*1000, frame_index=frame_index, view=view,
                             source='decoded encoded playback.mp4', **({'crop': list(box)} if box else {}))


def render_avatar(card, narration, artwork, output_dir, *, narration_root, allowed_roots, fps=12, end_hold_ms=250):
    """Render explicit artwork + local-narration/v1 to real stylized MP4 evidence.

    Artwork is {path,sha256,face:{x,y,width,height},mouth:{cx,cy,width,max_height,
    closed_height?}}. All anchors are in the required 512x768 PNG's pixels. Output
    descriptors are relative to output_dir. Technical failure retains card.json.
    """
    out = media._output(output_dir, allowed_roots)
    media._save(out/'card.json', card)
    result = {'schema': 'local-media-manifest/v1', 'kind': 'avatar', 'status': 'failed',
              'manifest_file': 'manifest.json', 'label': LABEL, 'card': media._descriptor(out/'card.json', out),
              'reviewer_frames': [], 'files': [], 'diagnostics': []}
    try:
        if type(fps) is not int or not 1 <= fps <= 30:
            raise media.MediaError('Avatar fps must be an integer 1..30')
        media._number(end_hold_ms, 'end_hold_ms', 0, 10000)
        if not isinstance(artwork, dict) or set(artwork) != {'path', 'sha256', 'face', 'mouth'}:
            raise media.MediaError('Artwork needs path, sha256 and explicit face/mouth anchors')
        source_art = media._allowed(artwork['path'], allowed_roots)
        if media._hash(source_art) != artwork['sha256']:
            raise media.MediaError('Artwork hash mismatch')
        with Image.open(source_art) as image:
            image.load()
            if image.format != 'PNG' or image.size != (WIDTH, HEIGHT) or getattr(image, 'n_frames', 1) != 1:
                raise media.MediaError('Artwork must be one explicit 512x768 PNG portrait')
        face, mouth = _geometry(artwork)
        if source_art != out/'artwork.png':
            shutil.copyfile(source_art, out/'artwork.png')
        source_root = media._allowed(narration_root, allowed_roots)
        source_audio = _source(source_root, narration.get('audio'), allowed_roots, 'Narration audio')
        clip_identity = []
        for clip in narration.get('clips', []):
            clip_path = _source(source_root, clip, allowed_roots, 'Narration clip')
            source_clip = _source(source_root, clip['source_file'], allowed_roots, 'Narration source clip') if 'source_file' in clip else None
            clip_identity.append({'index': clip.get('index'), 'sha256': media._hash(clip_path),
                                  'source_sha256': media._hash(source_clip) if source_clip else None})
        if source_audio.resolve() == (out/'narration.wav').resolve():
            raise media.MediaError('Narration source must be outside the renderer output WAV path')
        _, duration, rms = media._decode(source_audio, out/'narration.wav')
        if abs(duration - narration['audio'].get('duration_ms', -1)) > 1/media.RATE*1000 + 1e-6:
            raise media.MediaError('Narration duration does not match actual decoded PCM')
        pcm = _pcm(out/'narration.wav')
        cues = _cues(card, narration, pcm)
        count = math.ceil(duration*fps/1000) + max(1, math.ceil(end_hold_ms*fps/1000))
        if count > 18000:
            raise media.MediaError('Avatar video frame limit exceeded')
        # Cover every decoded sample even at fps=1. A fixed short window at each
        # frame start could miss an audible clip entirely between sample points.
        frame_rms = [_rms(pcm, round(i*media.RATE/fps), round((i+1)*media.RATE/fps)) if i*1000/fps < duration else 0 for i in range(count)]
        peak = max(frame_rms)
        if peak < 1:
            raise media.MediaError('Avatar audio energy curve has no audible sample')
        curve = [{'frame_index': i, 't_ms': i*1000/fps, 'pcm_rms': round(value, 6),
                  'mouth_height': round(mouth['closed_height']+(mouth['max_height']-mouth['closed_height'])*(min(1, value/peak)**.6 if value > peak*.04 else 0), 6)} for i, value in enumerate(frame_rms)]
        config = {'schema': 'local-avatar-render/v1', 'kind': 'avatar', 'width': WIDTH, 'height': HEIGHT,
                  'fps': fps, 'video_frame_count': count, 'scene_duration_ms': duration,
                  'duration_ms': count/fps*1000, 'requested_end_hold_ms': end_hold_ms,
                  'end_hold_ms': count/fps*1000-duration, 'audio_file': 'narration.wav', 'artwork_file': 'artwork.png'}
        identity = runtime_identity()
        cache = {'card': card, 'artwork_sha256': artwork['sha256'], 'face': face, 'mouth': mouth,
                 'audio_sha256': narration['audio']['sha256'], 'decoded_audio_sha256': media._hash(out/'narration.wav'),
                 'ordered_clips': clip_identity, 'assembly': narration.get('assembly'), 'speech_config': narration.get('config'),
                 'narration_blocks': narration['blocks'], 'word_timing': narration.get('word_timing'),
                 'narration_words': narration.get('words'), 'alignment_verified': narration.get('alignment_verified'),
                 'renderer_config': config, 'runtime': identity}
        scene = {'schema': 'local-avatar/v1', 'label': LABEL, 'face': face, 'mouth': mouth, 'energy_curve': curve}
        media._save(out/'scene.json', scene)
        media._save(out/'cues.json', cues)
        media._save(out/'render-config.json', config)
        result.update(config=config, provenance=identity, cache_identity_sha256=hashlib.sha256(media._json(cache).encode()).hexdigest(),
                      artwork=media._descriptor(out/'artwork.png', out, format='png', width=WIDTH, height=HEIGHT),
                      audio=media._descriptor(out/'narration.wav', out, format='wav', duration_ms=duration, pcm_rms=rms),
                      cues=media._descriptor(out/'cues.json', out), scene_file='scene.json')
        result['execution'] = json.loads(media._run([media._tool('node'), media.MEDIA/'avatar-renderer.mjs',
                                                   out/'scene.json', out/'render-config.json', out], timeout=240))
        media._run([media._tool('ffmpeg'), '-v', 'error', '-y', '-framerate', str(fps), '-i', out/'video-frames/%06d.png',
                    '-i', out/'narration.wav', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-af', 'apad',
                    '-t', str(config['duration_ms']/1000), '-movflags', '+faststart', out/'playback.mp4'], timeout=240)
        probe = media.probe_media(out/'playback.mp4', allowed_roots=allowed_roots)
        streams = {stream['codec_type']: stream for stream in probe['streams']}
        if not {'audio', 'video'} <= set(streams) or int(streams['video'].get('nb_frames', 0)) != count:
            raise media.MediaError('Encoded Avatar is missing required audio/video frames/streams')
        if (streams['video']['width'], streams['video']['height']) != (WIDTH, HEIGHT) or float(streams['audio'].get('duration', 0)) <= 0:
            raise media.MediaError('Encoded Avatar has invalid dimensions/audio duration')
        media._save(out/'playback-probe.json', probe)
        result['video'] = media._descriptor(out/'playback.mp4', out, format='mp4', width=WIDTH, height=HEIGHT,
                                           duration_ms=float(probe['format']['duration'])*1000)
        (out/'frames').mkdir(exist_ok=True)
        peak_index = max(range(count), key=frame_rms.__getitem__)
        for index in sorted({0, peak_index, count-1}):
            result['reviewer_frames'].append({**_extract(out, index, fps, 'wide'),
                                             'pcm_rms': curve[index]['pcm_rms'], 'mouth_height': curve[index]['mouth_height']})
        result['reviewer_frames'].append(_extract(out, peak_index, fps, 'app_crop', (0, 56, 512, 568), (290, 290)))
        box = (math.floor(face['x']), math.floor(face['y']), math.ceil(face['x']+face['width']), math.ceil(face['y']+face['height']))
        result['reviewer_frames'].append(_extract(out, peak_index, fps, 'face_crop', box))
        last = next(row for row in result['reviewer_frames'] if row['view'] == 'wide' and row['frame_index'] == count-1)
        shutil.copyfile(out/last['file'], out/'poster.png')
        result['poster'] = media._descriptor(out/'poster.png', out, format='png', width=WIDTH, height=HEIGHT, t_ms=last['t_ms'])
        with Image.open(out/last['file']) as encoded, Image.open(out/'video-frames'/f'{count-1:06d}.png') as rendered:
            mean_error = sum(ImageStat.Stat(ImageChops.difference(encoded.convert('RGB'), rendered.convert('RGB'))).mean)/3
        if mean_error > 12:
            raise media.MediaError('Actual encoded final frame differs excessively from completed rendered frame')
        result['motion'] = {'method': 'decoded PCM RMS over each full video-frame interval; normalized power0.6 mouth height',
                            'peak_frame_index': peak_index, 'peak_pcm_rms': peak,
                            'min_mouth_height': min(row['mouth_height'] for row in curve),
                            'max_mouth_height': max(row['mouth_height'] for row in curve),
                            'actual_encoded_last_frame_mean_pixel_error': mean_error,
                            'completion_hold': 'At least one fully rendered closed-mouth frame after narration; padded encoded audio silence.'}
        result['status'] = 'complete'
        result['files'] = [media._descriptor(path, out) for path in sorted(out.rglob('*')) if path.is_file()
                           and path.name != 'manifest.json' and 'video-frames' not in path.parts]
    except Exception as error:
        result['diagnostics'].append({'kind': 'technical_failure', 'type': type(error).__name__, 'message': str(error)})
    media._save(out/'manifest.json', result)
    return result
