"""R7/R8 local-only speech and media. New ABI, independent of the source engine.

All file inputs and output directories require explicit allowlisted roots. Render
functions retain author.json before attempting tools and report technical failure;
no content reviewer result is interpreted here.
"""
from __future__ import annotations

import copy
import hashlib
import html
import io
import json
import math
import os
import platform
import signal
from pathlib import Path
import re
import shutil
import subprocess
import wave
from array import array

ROOT = Path(__file__).resolve().parents[1]
MEDIA = ROOT / 'media'
RATE = 24000
SPEECH_ATTEMPT_LIMIT = 2


class MediaError(RuntimeError):
    pass


class BoardTimingError(MediaError):
    """An unresolved emphasis dependency, with source indices and times only."""
    def __init__(self, details):
        self.details = copy.deepcopy(details)
        super().__init__('Emphasis requires an already completed node')


class BoardAnchorError(MediaError):
    """An unresolved exact phrase occurrence, with numeric source positions only."""
    def __init__(self, beat_index, block_index, match_count, occurrence):
        if any(type(value) is not int or not 0 <= value <= 10**12
               for value in (beat_index, block_index, match_count)):
            raise ValueError('Invalid board anchor diagnostic')
        # Never retain the authored phrase, IDs, paths or invalid scalar text.
        # None preserves the compiler's existing omitted/null default semantics.
        if occurrence is None:
            kind = 0
        elif type(occurrence) is int and abs(occurrence) <= 10**12:
            kind = 1
        else:
            kind = 2
        self.details = {'beat_index': beat_index, 'narration_block_index': block_index,
                        'exact_match_count': match_count, 'requested_occurrence_type': kind}
        if kind == 1:
            self.details['requested_occurrence'] = occurrence
        super().__init__('Exact phrase requires a valid narration occurrence')


class MediaTimeout(MediaError):
    """A local process timeout; the process group has already been stopped."""


def _json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)


def _save(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + '\n')


def _hash(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as source:
        for chunk in iter(lambda: source.read(1024*1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def _allowed(path, roots):
    resolved = Path(path).resolve()
    if not roots or not any(resolved.is_relative_to(Path(root).resolve()) for root in roots):
        raise MediaError('File is outside explicit allowed_roots')
    return resolved


def _output(path, roots):
    if Path(path).is_symlink():
        raise MediaError('Output directories may not be symlinks')
    path = _allowed(path, roots)
    if any(p.is_symlink() for p in path.rglob('*')):
        raise MediaError('Output directories may not contain symlinks')
    path.mkdir(parents=True, exist_ok=True)
    return path


def _tool(name):
    path = shutil.which(name)
    if not path:
        raise MediaError(f'Required local tool unavailable: {name}; no fallback media created')
    return path


def _run(args, timeout=120):
    process = None
    try:
        process = subprocess.Popen([str(x) for x in args], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   text=True, start_new_session=True)
        stdout, stderr = process.communicate(timeout=timeout)
    except subprocess.TimeoutExpired as error:
        # A renderer timeout must also terminate its disposable browser children.
        os.killpg(process.pid, signal.SIGKILL)
        stdout, stderr = process.communicate()
        failure = MediaTimeout('Local tool failed: TimeoutExpired; process group terminated')
        failure.stdout, failure.stderr = stdout, stderr
        raise failure from error
    except OSError as error:
        raise MediaError(f'Local tool failed: {type(error).__name__}') from error
    except BaseException:
        if process is not None and process.poll() is None:
            os.killpg(process.pid, signal.SIGKILL)
            process.communicate()
        raise
    if process.returncode:
        raise MediaError(f'Local tool {Path(str(args[0])).name} failed: {stderr[-1800:]}')
    return stdout


def visual_body_syntax(code):
    """Parse the exact Pixi viewer body without invoking any authored JavaScript.

    The fixed Node program receives source on stdin, constructs the viewer's
    function with its exact parameter/wrapper ABI, and never calls that function.
    False means an actual SyntaxError; local tool failures remain nonrecoverable.
    """
    if not isinstance(code, str) or not code.strip():
        raise ValueError('Visual pixi_code must be a nonblank string')
    checker = r'''
let source = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { source += chunk; });
process.stdin.on('end', () => {
  try {
    new Function('app', 'PIXI', '"use strict"; return (async()=>{' + source + '\n})();');
    process.stdout.write('valid');
  } catch (error) {
    if (error instanceof SyntaxError) process.stdout.write('syntax_error');
    else process.exitCode = 1;
  }
});
'''
    try:
        result = subprocess.run([_tool('node'), '-e', checker], input=code, text=True,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10)
    except subprocess.TimeoutExpired as error:
        raise MediaTimeout('Visual syntax checker timed out') from error
    except OSError as error:
        raise MediaError('Visual syntax checker unavailable') from error
    if result.returncode or result.stdout not in ('valid', 'syntax_error'):
        raise MediaError('Visual syntax checker failed')
    return result.stdout == 'valid'


def _descriptor(path, root, **metadata):
    return {'file': str(Path(path).relative_to(root)), 'sha256': _hash(path),
            'bytes': Path(path).stat().st_size, **metadata}


def probe_media(path, *, allowed_roots):
    """Actual ffprobe streams; never infer an audio stream from a file suffix."""
    path = _allowed(path, allowed_roots)
    return json.loads(_run([_tool('ffprobe'), '-v', 'error', '-show_streams',
                           '-show_format', '-of', 'json', path]))


def runtime_identity():
    """Versions, binary hashes and frozen renderer sources for run/resume identity."""
    tools = {}
    for name in ('ffmpeg', 'ffprobe', 'say', 'node'):
        path = shutil.which(name)
        if not path:
            tools[name] = {'available': False}
            continue
        args = [path, '-version'] if name.startswith('ff') else [path, '--version']
        version = 'macOS system say; voices enumerated separately' if name == 'say' else _run(args).splitlines()[0]
        tools[name] = {'available': True, 'binary_sha256': _hash(Path(path).resolve()), 'version': version}
    files = {str(p.relative_to(ROOT)): _hash(p) for p in
             [Path(__file__), MEDIA/'renderer.mjs', MEDIA/'viewer.js', MEDIA/'package.json', MEDIA/'package-lock.json'] if p.exists()}
    browser = {'available': False}
    if (MEDIA/'node_modules/playwright').exists() and shutil.which('node'):
        try:
            browser = json.loads(_run([_tool('node'), MEDIA/'renderer.mjs', '--identity']))
        except MediaError as error:
            browser = {'available': False, 'error': str(error)}
    return {'schema': 'local-media-identity/v1', 'files': files, 'tools': tools,
            'browser': browser, 'voice_inventory': installed_voices() if shutil.which('say') else [], 'audio': {'sample_rate': RATE, 'channels': 1, 'format': 'pcm_s16le'},
            'platform': platform.platform(), 'board_font': 'Arial, sans-serif',
            'network': 'browser requests restricted to exact loopback file allowlist'}


def installed_voices():
    """Query installed voices. Executable presence does not establish language support."""
    inventory = _run([_tool('say'), '-v', '?'])
    voices = []
    for row in inventory.splitlines():
        match = re.match(r'^(.*?)\s+([a-z]{2,3}_[A-Z0-9]+)\s+#', row)
        if match:
            voices.append({'voice': match[1].strip(), 'locale': match[2]})
    return voices


def _decode(source, target):
    _run([_tool('ffmpeg'), '-v', 'error', '-y', '-i', source, '-map', '0:a:0',
          '-ac', '1', '-ar', str(RATE), '-c:a', 'pcm_s16le', target])
    with wave.open(str(target), 'rb') as audio:
        frames = audio.readframes(audio.getnframes())
        duration_ms = audio.getnframes() / RATE * 1000
    pcm = array('h', frames)
    rms = math.sqrt(sum(x*x for x in pcm) / max(1, len(pcm)))
    if not frames or rms < 1:
        raise MediaError('Supplied/generated speech has no audible PCM energy; no silent fallback')
    return frames, duration_ms, round(rms, 3)


def _retain_bytes(path, value):
    """Never replace evidence during local recovery."""
    if path.exists():
        if path.read_bytes() != value:
            raise MediaError('Frozen narration evidence changed: ' + path.name)
        return
    temporary = path.with_name(path.name + '.pending')
    temporary.write_bytes(value)
    os.replace(temporary, path)


def _retain_json(path, value):
    _retain_bytes(path, (json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + '\n').encode())


def _speech_files(root, excluded=()):
    if root.is_symlink() or any(p.is_symlink() for p in root.rglob('*')):
        raise MediaError('Narration evidence may not contain symlinks')
    return {str(p.relative_to(root)): {'sha256': _hash(p), 'bytes': p.stat().st_size}
            for p in sorted(root.rglob('*')) if p.is_file() and str(p.relative_to(root)) not in excluded}


def _saved_clip(out, clip):
    for descriptor in (clip, clip['source_file']):
        relative = Path(descriptor['file'])
        path = out/relative
        if relative.is_absolute() or '..' in relative.parts or path.is_symlink() or not path.is_file():
            raise MediaError('Invalid completed speech clip path')
        if _hash(path) != descriptor['sha256'] or path.stat().st_size != descriptor['bytes']:
            raise MediaError('Completed speech clip bytes changed')
    with wave.open(str(out/clip['file']), 'rb') as audio:
        if (audio.getframerate(), audio.getnchannels(), audio.getsampwidth()) != (RATE, 1, 2):
            raise MediaError('Completed speech PCM format changed')
        pcm = audio.readframes(audio.getnframes())
        duration = audio.getnframes()/RATE*1000
    if duration != clip['duration_ms']:
        raise MediaError('Completed speech clip duration changed')
    return pcm, clip


def _speech_clip(out, index, script, script_file, config, origin, provided, intent_sha256):
    """Two durable attempts maximum; only timeouts/interruption may continue."""
    attempts = out/'attempts'/f'clip-{index:03d}'
    attempts.mkdir(parents=True, exist_ok=True)
    directories = sorted(attempts.iterdir())
    if [p.name for p in directories] != [f'{n:02d}' for n in range(1, len(directories)+1)] or len(directories) > SPEECH_ATTEMPT_LIMIT:
        raise MediaError('Invalid speech attempt evidence')
    expected = {'schema': 'local-speech-attempt/v1', 'intent_sha256': intent_sha256,
                'index': index, 'script_sha256': hashlib.sha256(script.encode()).hexdigest(),
                'source': origin, 'attempt_limit': SPEECH_ATTEMPT_LIMIT}
    for directory in directories:
        if json.loads((directory/'attempt.json').read_text()) != expected:
            raise MediaError('Frozen speech attempt identity changed')
        result_path = directory/'result.json'
        if not result_path.exists():
            # The process ended before recording a result. Retain its partial
            # files and consume the attempt; never overwrite or adopt them.
            _retain_json(result_path, {'status': 'interrupted', 'retryable': True,
                                      'files': _speech_files(directory)})
        result = json.loads(result_path.read_text())
        if result['files'] != _speech_files(directory, ('result.json',)):
            raise MediaError('Retained speech attempt files changed')
        if result['status'] == 'complete':
            clip = result['clip']
            if clip['index'] != index or clip['script'] != script or clip['source'] != origin:
                raise MediaError('Completed speech clip identity changed')
            return _saved_clip(out, clip)
        if not result.get('retryable'):
            raise MediaError('Previous local speech attempt failed; manual reconciliation required')
    for number in range(len(directories)+1, SPEECH_ATTEMPT_LIMIT+1):
        directory = attempts/f'{number:02d}'
        directory.mkdir()
        _retain_json(directory/'attempt.json', expected)
        phase = 'speech'
        try:
            if provided is not None:
                source = Path(provided['path'])
                frozen = directory/('source'+source.suffix)
                shutil.copyfile(source, frozen)
            else:
                frozen = directory/'source.aiff'
                _run([_tool('say'), '-v', config['voice'], '-r', str(config['rate']),
                      '-f', script_file, '-o', frozen])
            phase = 'decode'
            decoded = directory/'decoded.wav'
            pcm, duration, rms = _decode(frozen, decoded)
            clip = {**_descriptor(decoded, out), 'index': index, 'script': script,
                    'script_sha256': hashlib.sha256(script.encode()).hexdigest(),
                    'source': origin, 'source_file': _descriptor(frozen, out),
                    'duration_ms': duration, 'duration_basis': 'decoded PCM samples', 'pcm_rms': rms}
            _retain_json(directory/'result.json', {'status': 'complete', 'clip': clip,
                                                  'files': _speech_files(directory)})
            return pcm, clip
        except Exception as error:
            retryable = isinstance(error, MediaTimeout) and phase == 'speech' and provided is None
            _retain_json(directory/'result.json', {'status': 'failed', 'retryable': retryable,
                         'phase': phase, 'error_type': type(error).__name__, 'error': str(error),
                         'stdout': getattr(error, 'stdout', None), 'stderr': getattr(error, 'stderr', None),
                         'files': _speech_files(directory)})
            if not retryable:
                raise
    raise MediaError(f'Local speech exhausted its {SPEECH_ATTEMPT_LIMIT} retained attempts')


def synthesize(lines, output_dir, config=None, supplied_clips=None, *, allowed_roots):
    """Ordered scripts -> frozen clips + measured WAV + estimated word positions.

    lines: strings or {script, display?, kind?}. supplied_clips maps integer/string
    block indices to {path,sha256}. config: voice, language, rate, gap_ms,
    leading_gap_ms. Returned filenames are relative to output_dir. Failures raise
    MediaError after scripts are retained; no synthesized content is substituted.
    Versioned per-clip receipts permit bounded local recovery without repeating
    completed speech. Legacy output directories cannot enter this protocol.
    """
    config = dict(config or {})
    unknown = set(config) - {'voice', 'language', 'rate', 'gap_ms', 'leading_gap_ms'}
    if unknown:
        raise MediaError('Unknown speech config fields: ' + ', '.join(sorted(unknown)))
    out = _output(output_dir, allowed_roots)
    if not isinstance(lines, list) or not lines:
        raise MediaError('Speech requires a nonempty ordered script list')
    blocks = [dict(script=line, display=line, kind='line') if isinstance(line, str) else copy.deepcopy(line) for line in lines]
    fresh_output = not any(out.iterdir())
    intent_path = out/'narration-intent.json'
    if fresh_output:
        # Keep exact author scripts even when local voice/config preflight
        # rejects execution. Such unstarted, unmarked evidence is not retried.
        _retain_json(out/'scripts.json', blocks)
    elif not intent_path.is_file():
        raise MediaError('Existing narration lacks the local recovery contract; manual reconciliation required')
    supplied_clips = supplied_clips or {}
    if set(str(key) for key in supplied_clips) - set(str(i) for i in range(len(blocks))):
        raise MediaError('Supplied clips contain unknown block indices')
    gap = config.get('gap_ms', 300)
    lead = config.get('leading_gap_ms', 0)
    rate = config.get('rate', 180)
    for value, name in ((gap, 'gap_ms'), (lead, 'leading_gap_ms')):
        if type(value) not in (int, float) or not math.isfinite(value) or not 0 <= value <= 60000:
            raise MediaError(f'Invalid {name}')
    if type(rate) is not int or not 60 <= rate <= 500:
        raise MediaError('Speech rate must be 60..500 words/minute')
    voice, language = config.get('voice', 'Samantha'), config.get('language', 'en')
    inventory = []
    if len(supplied_clips) != len(blocks):
        inventory = installed_voices()
        matching = [row for row in inventory if row['voice'] == voice and row['locale'].split('_')[0] == language.split('-')[0].split('_')[0]]
        if not matching:
            raise MediaError('Requested voice/language is not in installed say inventory')
    sources = {}
    for index, block in enumerate(blocks):
        if not isinstance(block, dict) or not isinstance(block.get('script'), str) or not block['script'].strip():
            raise MediaError('Every speech block requires a nonempty script')
        provided = supplied_clips.get(index, supplied_clips.get(str(index)))
        if provided is not None:
            if not isinstance(provided, dict) or not {'path', 'sha256'} <= set(provided) or set(provided) - {'path', 'sha256', 'alignment'}:
                raise MediaError('Supplied clip requires path and sha256, optional alignment')
            source = _allowed(provided['path'], allowed_roots)
            if _hash(source) != provided['sha256']:
                raise MediaError('Supplied clip hash mismatch')
            sources[str(index)] = {'path': str(source), 'sha256': provided['sha256'],
                                   'alignment': provided.get('alignment')}
    tools = {name: {'binary_sha256': _hash(Path(_tool(name)).resolve())}
             for name in ('ffmpeg',) + (('say',) if inventory else ())}
    effective = {'voice': voice, 'language': language, 'rate': rate, 'gap_ms': gap, 'leading_gap_ms': lead}
    intent = {'schema': 'local-narration-recovery/v1', 'scripts': blocks, 'config': config,
              'effective_config': effective, 'supplied_sources': sources, 'tools': tools,
              'voice_inventory': inventory, 'implementation_sha256': _hash(Path(__file__)),
              'attempt_limit': SPEECH_ATTEMPT_LIMIT}
    if not intent_path.exists() and not fresh_output:
        raise MediaError('Existing narration lacks the local recovery contract; manual reconciliation required')
    _retain_json(intent_path, intent)
    intent_hash = _hash(intent_path)
    complete_path = out/'narration-complete.json'
    if complete_path.exists():
        complete = json.loads(complete_path.read_text())
        if complete != {'schema': 'local-narration-files/v1', 'intent_sha256': intent_hash,
                        'files': _speech_files(out, ('narration-complete.json',))}:
            raise MediaError('Completed narration file set or bytes changed')
        return json.loads((out/'narration.json').read_text())
    _retain_json(out/'scripts.json', blocks)
    all_pcm = bytearray(b'\0' * (round(lead*RATE/1000)*2))
    clips, words, timeline = [], [], []
    for index, block in enumerate(blocks):
        script = block.get('script')
        if not isinstance(script, str) or not script.strip():
            raise MediaError('Every speech block requires a nonempty script')
        script_file = out/f'script-{index:03d}.txt'
        _retain_bytes(script_file, script.encode())
        provided = supplied_clips.get(index, supplied_clips.get(str(index)))
        if provided is not None:
            origin = {'kind': 'supplied', 'input_sha256': provided['sha256']}
        else:
            origin = {'kind': 'macos-say', 'voice': voice, 'locale': matching[0]['locale'],
                      'rate_words_per_minute': rate, 'inventory_sha256': hashlib.sha256(_json(inventory).encode()).hexdigest()}
            origin['voice_config_sha256'] = hashlib.sha256(_json(origin).encode()).hexdigest()
        pcm, clip = _speech_clip(out, index, script, script_file, effective, origin, provided, intent_hash)
        duration = clip['duration_ms']
        start = len(all_pcm)/2/RATE*1000
        all_pcm.extend(pcm)
        end = len(all_pcm)/2/RATE*1000
        clips.append(clip)
        timeline.append({'index': index, 'kind': block.get('kind', 'line'), 'display': block.get('display', script),
                         'script': script, 'start_ms': start, 'end_ms': end, 'clip_sha256': clip['sha256']})
        matches = list(re.finditer(r'\S+', script))
        alignment = provided.get('alignment') if provided else None
        if alignment is not None:
            if not isinstance(alignment, dict) or set(alignment) - {'words','provenance','alignment_verified'} or not isinstance(alignment.get('provenance'), dict) or not alignment['provenance']:
                raise MediaError('Supplied alignment requires words and explicit provenance')
            aligned = alignment.get('words')
            verified = alignment.get('alignment_verified', False)
            if type(verified) is not bool or not isinstance(aligned, list) or len(aligned) != len(matches):
                raise MediaError('Supplied alignment must cover every script word')
            previous_end = 0
            for match, timed in zip(matches, aligned):
                if not isinstance(timed, dict) or set(timed) != {'text','start_ms','end_ms'} or timed['text'] != match.group():
                    raise MediaError('Supplied alignment word text/order mismatch')
                first = _number(timed['start_ms'], 'alignment start', previous_end, duration)
                last = _number(timed['end_ms'], 'alignment end', first, duration)
                if last <= first:
                    raise MediaError('Supplied word intervals must be positive and nonoverlapping')
                previous_end = last
            clip['supplied_alignment'] = copy.deepcopy(alignment)
        for j, match in enumerate(matches):
            timed = aligned[j] if alignment is not None else None
            words.append({'block': index, 'text': match.group(), 'char_start': match.start(), 'char_end': match.end(),
                          'start_ms': start + (timed['start_ms'] if timed else duration*j/len(matches)),
                          'end_ms': start + (timed['end_ms'] if timed else duration*(j+1)/len(matches)),
                          'timing_basis': 'supplied alignment' if timed else 'estimated uniform word interpolation',
                          'alignment_verified': verified if timed else False,
                          **({'alignment_provenance': copy.deepcopy(alignment['provenance']), 'verification_source': 'supplied claim; no local ASR'} if timed else {})})
        if index < len(blocks)-1:
            all_pcm.extend(b'\0' * (round(gap*RATE/1000)*2))
    audio_file = out/'narration.wav'
    combined = io.BytesIO()
    with wave.open(combined, 'wb') as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(RATE)
        audio.writeframes(all_pcm)
    _retain_bytes(audio_file, combined.getvalue())
    result = {'schema': 'local-narration/v1', 'audio': _descriptor(audio_file, out, format='wav',
              duration_ms=len(all_pcm)/2/RATE*1000), 'clips': clips, 'blocks': timeline, 'words': words,
              'segment_timing': 'measured decoded PCM', 'word_timing': ('supplied' if all(w['timing_basis']=='supplied alignment' for w in words) else 'mixed' if any(w['timing_basis']=='supplied alignment' for w in words) else 'estimated'),
              'alignment_verified': all(w['alignment_verified'] for w in words),
              'assembly': {'sample_rate': RATE, 'channels': 1, 'gap_ms': gap, 'leading_gap_ms': lead,
                           'gaps_are_real_pcm': True}, 'config': config,
              'scripts_sha256': _hash(out/'scripts.json'),
              'tools': tools}
    _retain_json(out/'narration.json', result)
    _retain_json(complete_path, {'schema': 'local-narration-files/v1', 'intent_sha256': intent_hash,
                               'files': _speech_files(out)})
    return result


prepare_narration = synthesize


def _number(value, name, minimum=-20000, maximum=20000):
    if type(value) not in (int, float) or not math.isfinite(value) or not minimum <= value <= maximum:
        raise MediaError(f'Invalid finite {name}')
    return value


def compile_board(plan, narration):
    """Compile exact case-sensitive phrase/occurrence anchors. No content judgment."""
    if plan.get('route') != 'board':
        if plan.get('route') == 'hold':
            return {'schema': 'local-board/v1', 'route': 'hold', 'rationale': plan.get('rationale', ''), 'nodes': [], 'cues': []}
        raise MediaError('Board route must be board or hold')
    nodes = copy.deepcopy(plan.get('nodes', []))
    if not isinstance(nodes, list) or not nodes or len(nodes) > 300:
        raise MediaError('Board requires 1..300 immutable nodes')
    ids = set()
    geometry = {'path': {'d'}, 'text': {'x','y','text','font_size'}, 'rect': {'x','y','width','height'},
                'ellipse': {'cx','cy','rx','ry'}, 'line': {'x1','y1','x2','y2'}, 'arrow': {'x1','y1','x2','y2'}}
    for node in nodes:
        if not isinstance(node, dict) or node.get('type') not in geometry or not isinstance(node.get('id'), str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,80}', node['id']) or node['id'] in ids:
            raise MediaError('Invalid/duplicate board node id/type')
        ids.add(node['id'])
        required = geometry[node['type']]
        if not required <= set(node) or set(node) - required - {'id','type','stroke','fill','stroke_width'}:
            raise MediaError('Board node fields do not match documented type')
        for color in ('stroke','fill'):
            if color in node and not re.fullmatch(r'#[0-9a-fA-F]{6}|none', str(node[color])):
                raise MediaError('Only hex colors and none are supported')
        _number(node.get('stroke_width', 3), 'stroke_width', .1, 30)
        for field in required - {'d','text'}:
            _number(node[field], field, .1 if field in {'width','height','rx','ry','font_size'} else -2000, 4000)
        if node['type'] == 'path' and (not isinstance(node['d'], str) or len(node['d']) > 20000 or not re.fullmatch(r'[MmLlHhVvCcSsQqTtAaZz0-9eE+.,\s-]+', node['d'])):
            raise MediaError('Path requires self-contained SVG path commands')
        if node['type'] == 'text' and (not isinstance(node['text'], str) or len(node['text']) > 2000):
            raise MediaError('Text node requires a bounded string')
    cues, draw_end, beat_ids, original_beat_indices = [], {}, set(), {}
    node_indices = {node['id']: index for index, node in enumerate(nodes)}
    for beat_index, beat in enumerate(plan.get('beats', [])):
        if not isinstance(beat, dict) or not {'id','line','phrase','action','targets'} <= set(beat) or set(beat) - {'id','line','phrase','occurrence','action','targets','hold_ms'}:
            raise MediaError('Invalid beat fields')
        if not isinstance(beat['id'], str) or beat['id'] in beat_ids:
            raise MediaError('Beat ids must be unique strings')
        beat_ids.add(beat['id'])
        original_beat_indices[beat['id']] = beat_index
        index = beat['line']
        if type(index) is not int or not 0 <= index < len(narration['blocks']):
            raise MediaError('Beat line must be zero-based narration block index')
        script = narration['blocks'][index]['script']
        phrase = beat['phrase']
        if not isinstance(phrase, str) or not phrase:
            raise MediaError('Beat requires an exact nonempty phrase')
        positions = [m.start() for m in re.finditer(re.escape(phrase), script)]
        occurrence = beat.get('occurrence')
        if occurrence is None and len(positions) != 1:
            raise BoardAnchorError(beat_index, index, len(positions), occurrence)
        occurrence = 1 if occurrence is None else occurrence
        if type(occurrence) is not int or not 1 <= occurrence <= len(positions):
            raise BoardAnchorError(beat_index, index, len(positions), occurrence)
        start_char = positions[occurrence-1]
        anchored = [w for w in narration['words'] if w['block'] == index and w['char_end'] > start_char and w['char_start'] < start_char+len(phrase)]
        if not anchored:
            raise MediaError('Phrase has no word timing')
        targets = beat['targets']
        if not isinstance(targets, list) or not targets or len(set(targets)) != len(targets) or any(t not in ids for t in targets):
            raise MediaError('Beat targets must be unique known nodes')
        start, end = anchored[0]['start_ms'], anchored[-1]['end_ms']
        hold = _number(beat.get('hold_ms', 0), 'hold_ms', 0, 60000)
        if beat['action'] not in {'draw','emphasize'}:
            raise MediaError('Beat action must be draw or emphasize')
        cues.append({'id': beat['id'], 'action': beat['action'], 'targets': targets, 'start_ms': start,
                     'end_ms': end, 'hold_ms': hold, 'line': index, 'phrase': phrase, 'occurrence': occurrence,
                     'timing_basis': 'supplied alignment' if all(w['timing_basis']=='supplied alignment' for w in anchored) else 'estimated word positions from measured clip',
                     'alignment_verified': all(w['alignment_verified'] for w in anchored)})
    target_draws = {}
    for cue in cues:
        if cue['action'] == 'draw':
            for target in cue['targets']:
                target_draws.setdefault(target, []).append(cue)
    def timing_details(cue):
        details = {'beat_index': original_beat_indices[cue['id']],
            'target_node_indices': [node_indices[target] for target in cue['targets']],
            'emphasis_start_ms': cue['start_ms'],
            'target_draws': [{'node_index': node_indices[target],
                             'beat_index': original_beat_indices[draw['id']], 'end_ms': draw['end_ms']}
                            for target in cue['targets'] for draw in target_draws.get(target, [])],
            'missing_draw_target_node_indices': [node_indices[target] for target in cue['targets']
                                                  if not target_draws.get(target)],
            'eligible_word_indices': []}
        if all(len(target_draws.get(target, [])) == 1 for target in cue['targets']):
            latest = max(target_draws[target][0]['end_ms'] for target in cue['targets'])
            details['latest_target_draw_end_ms'] = latest
            details['eligible_word_indices'] = [index for index, word in enumerate(narration['words'])
                                                if word['start_ms'] >= latest][:8]
        return details
    cues.sort(key=lambda cue: (cue['start_ms'], cue['id']))
    for cue in cues:
        for target in cue['targets']:
            if cue['action'] == 'draw':
                if target in draw_end:
                    raise MediaError('Immutable nodes may be drawn once; use emphasis thereafter')
                draw_end[target] = cue['end_ms']
            elif target not in draw_end or draw_end[target] > cue['start_ms']:
                raise BoardTimingError(timing_details(cue))
    if not cues:
        raise MediaError('Board requires draw/emphasis beats')
    duration = max(narration['audio']['duration_ms'], max(c['end_ms']+c['hold_ms'] for c in cues))
    return {'schema': 'local-board/v1', 'route': 'board', 'width': 1000, 'height': 700,
            'nodes': nodes, 'nodes_sha256': hashlib.sha256(_json(nodes).encode()).hexdigest(), 'cues': cues,
            'duration_ms': duration, 'clip_timeline': copy.deepcopy(narration['blocks']),
            'timing': {'segments': 'measured decoded PCM', 'words': narration['word_timing'], 'alignment_verified': narration['alignment_verified']},
            'diagnostics': [{'kind': 'undrawn_nodes', 'targets': sorted(ids-set(draw_end))}] if ids-set(draw_end) else []}


def _render(kind, artifact, output_dir, allowed_roots, config, narration=None):
    out = _output(output_dir, allowed_roots)
    _save(out/'author.json', artifact)
    result = {'schema': 'local-media-manifest/v1', 'kind': kind, 'status': 'failed', 'manifest_file': 'manifest.json',
              'author': _descriptor(out/'author.json', out), 'config': config, 'reviewer_frames': [], 'files': [], 'diagnostics': []}
    try:
        if kind == 'board':
            scene = compile_board(artifact, narration)
            _save(out/'scene.json', scene)
            if scene['route'] == 'hold':
                result.update(status='hold', scene=scene, diagnostics=[{'kind': 'author_hold', 'rationale': scene['rationale']}])
                _save(out/'manifest.json', result)
                return result
            result['diagnostics'].extend(scene.get('diagnostics', []))
            source_root = _allowed(config.pop('narration_root'), allowed_roots)
            source = _allowed(source_root/narration['audio']['file'], allowed_roots)
            if _hash(source) != narration['audio']['sha256']:
                raise MediaError('Narration audio hash mismatch')
            shutil.copyfile(source, out/'narration.wav') if source != out/'narration.wav' else None
            config['audio_file'] = 'narration.wav'
            duration = scene['duration_ms']
            config['frame_times_ms'] = sorted({0, duration, *[c[x] for c in scene['cues'] for x in ('start_ms','end_ms')]})
            config['scene_duration_ms'] = duration
            config['video_frame_count'] = math.ceil(duration*config['fps']/1000) + max(1, math.ceil(config['requested_end_hold_ms']*config['fps']/1000))
            config['duration_ms'] = config['video_frame_count']/config['fps']*1000
            config['end_hold_ms'] = config['duration_ms'] - duration
            result['scene_file'] = 'scene.json'
        else:
            scene = artifact
            if kind == 'pixi':
                duration = _number(artifact.get('duration_ms', 10000), 'visual duration_ms', 1, 600000)
                times = config['frame_times_ms']
                if times is None:
                    times = [0, duration/2, duration]
                if not isinstance(times, list) or not times:
                    raise MediaError('Visual frame times require a nonempty list')
                for value in times:
                    _number(value, 'visual frame time', 0, 600000)
                config['frame_times_ms'] = times
                config['duration_ms'] = max(duration, max(times))
            _save(out/'scene.json', scene)
        result['provenance'] = runtime_identity()
        _save(out/'render-config.json', {'kind': kind, **config})
        rendered = json.loads(_run([_tool('node'), MEDIA/'renderer.mjs', out/'scene.json', out/'render-config.json', out], timeout=240))
        result['diagnostics'].extend(rendered.get('diagnostics', []))
        result['execution'] = {key: rendered[key] for key in ('browser_version', 'dimensions') if key in rendered}
        result['reviewer_frames'] = [_descriptor(out/row['file'], out, **{k:v for k,v in row.items() if k != 'file'}) for row in rendered['frames']]
        if kind == 'board':
            completed = next(row for row in reversed(result['reviewer_frames']) if row['view']=='wide')
            shutil.copyfile(out/completed['file'], out/'poster.png')
            result['poster'] = _descriptor(out/'poster.png', out, format='png', width=1000, height=700, t_ms=config['scene_duration_ms'])
            _run([_tool('ffmpeg'), '-v', 'error', '-y', '-framerate', str(config['fps']),
                  '-i', out/'video-frames/%06d.png', '-i', out/'narration.wav', '-c:v', 'libx264',
                  '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-af', 'apad', '-t', str(config['duration_ms']/1000),
                  '-movflags', '+faststart', out/'playback.mp4'], timeout=240)
            streams = probe_media(out/'playback.mp4', allowed_roots=allowed_roots)
            if not {'audio','video'} <= {s['codec_type'] for s in streams['streams']}:
                raise MediaError('Encoded playback is missing required audio/video stream')
            _save(out/'playback-probe.json', streams)
        result['status'] = 'complete'
        result['files'] = [_descriptor(path, out) for path in sorted(out.rglob('*')) if path.is_file()
                           and path.name != 'manifest.json' and 'video-frames' not in path.parts]
    except Exception as error:
        result['diagnostics'].append({'kind': 'technical_failure', 'type': type(error).__name__, 'message': str(error)})
    _save(out/'manifest.json', result)
    return result


def render_visual(visual_explanation, output_dir, *, allowed_roots, frame_times_ms=None, interaction_values=None):
    return _render('pixi', visual_explanation, output_dir, allowed_roots,
                   {'frame_times_ms': None if frame_times_ms is None else list(frame_times_ms), 'interaction_values': interaction_values})


def render_svg(illustration, output_dir, *, allowed_roots):
    return _render('svg', illustration, output_dir, allowed_roots, {'frame_times_ms': [0]})


def render_board(plan, narration, output_dir, *, allowed_roots, narration_root=None, fps=12, end_hold_ms=250):
    if type(fps) is not int or not 1 <= fps <= 30:
        raise MediaError('fps must be an integer 1..30')
    _number(end_hold_ms, 'end_hold_ms', 0, 10000)
    if narration_root is None:
        raise MediaError('Explicit narration_root required for relative audio descriptor')
    return _render('board', plan, output_dir, allowed_roots,
                   {'fps': fps, 'requested_end_hold_ms': end_hold_ms, 'narration_root': str(narration_root)}, narration=narration)
