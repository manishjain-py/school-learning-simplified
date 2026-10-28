"""R7 explicit teaching projections and review-only derived image delivery."""
import io
import json
from pathlib import Path
from PIL import Image
from ..inputs import ROOT, canonical, read, save, sha, strict_json

BINARY_INPUTS = tuple(f'clip_{i:03d}' for i in range(1, 33))
FILE_INPUTS = ('guideline', 'deck', 'targets', 'speech', 'alignment', 'translated_deck', 'translated_identity', 'index_map', *BINARY_INPUTS)
EXCLUDED = ('welcome', 'summary', 'check_in', 'checkin')
CARD_FIELDS = ('card_idx', 'card_type', 'title', 'visual', 'section_key', 'section_seq')
VISUAL_FIELDS = ('output_type', 'medium', 'source_medium', 'adaptation', 'title', 'visual_summary',
                 'visual_spec', 'pixi_code', 'svg_source', 'layout_warning', 'interactive', 'duration_ms')


def cards(bundle):
    deck = bundle['declared'].get('deck')
    if not isinstance(deck, dict) or not isinstance(deck.get('cards'), list):
        raise ValueError('R7 requires a native R3 Explain deck')
    result, seen = [], set()
    for raw in deck['cards']:
        idx = raw.get('card_idx')
        if type(idx) is not int or idx < 1 or idx in seen:
            raise ValueError('R3 cards require unique positive original card_idx')
        seen.add(idx)
        if not isinstance(raw.get('title'), str) or not isinstance(raw.get('card_type'), str):
            raise ValueError('R3 cards require exact title/type')
        lines = raw.get('lines')
        if not isinstance(lines, list) or not all(isinstance(l, dict) and
                all(isinstance(l.get(k), str) for k in ('display', 'audio')) for l in lines):
            raise ValueError('R3 cards require native display/audio lines')
        result.append({**{k: raw[k] for k in CARD_FIELDS if k in raw},
                       'lines': [{k: l[k] for k in ('display', 'audio')} for l in lines]})
    return result


def targets(bundle, factory):
    value = bundle['declared'].get('targets')
    if not isinstance(value, dict) or not isinstance(value.get('targets'), list) or not value['targets']:
        raise ValueError('Provide explicit nonempty targets array')
    lookup = {c['card_idx']: c for c in cards(bundle)}
    rows, seen = [], set()
    for row in value['targets']:
        if not isinstance(row, dict) or set(row) != {'card_idx', 'mode'}:
            raise ValueError('Each target requires only original card_idx and mode')
        idx, mode = row['card_idx'], row['mode']
        if type(idx) is not int or idx not in lookup or idx in seen:
            raise ValueError('Target must identify one unique original R3 card')
        if lookup[idx]['card_type'] in EXCLUDED:
            raise ValueError('Ordinary R7 selection excludes welcome/summary/check-ins')
        if mode not in (('board',) if factory == 'boards' else ('pixi', 'interactive', 'svg')):
            raise ValueError('Unsupported local target mode')
        seen.add(idx)
        rows.append({'card': lookup[idx], 'mode': mode})
    return rows


def validate(bundle, factory):
    if bundle['pages']:
        raise ValueError('R7 accepts explicit predecessor packs, no original-page inputs')
    for key, spec in bundle['file_identity'].items():
        expected = 'binary' if key in BINARY_INPUTS else 'json'
        if spec['type'] != expected:
            raise ValueError('R7 input type mismatch')
    targets(bundle, factory)
    guideline(bundle)
    if factory == 'boards':
        speech_config(bundle)
        for target in targets(bundle, factory):
            narration_blocks(bundle, target['card'])


def guideline(bundle):
    from .revise import guideline_view
    return guideline_view(bundle)


def speech_config(bundle):
    config = bundle['declared'].get('speech', {})
    if not isinstance(config, dict) or set(config) - {'voice', 'language', 'gap_ms', 'leading_gap_ms', 'clips'}:
        raise ValueError('Speech uses voice/language/gap_ms/leading_gap_ms/clips only')
    if config.get('language', 'en') not in ('en', 'hi'):
        raise ValueError('Local reference speech language is en or hi')
    clips = config.get('clips', {})
    if not isinstance(clips, dict):
        raise ValueError('Speech clips map R3 card_idx to ordered explicit clip slots')
    for idx, slots in clips.items():
        if not isinstance(idx, str) or not idx.isdecimal() or not isinstance(slots, list) or not all(
                s in BINARY_INPUTS and s in bundle['declared'] for s in slots):
            raise ValueError('Speech clip bindings must name frozen binary slots')
    return {k: config[k] for k in ('voice', 'language', 'gap_ms', 'leading_gap_ms') if k in config}


def narration_blocks(bundle, card):
    config = speech_config(bundle)
    if config.get('language', 'en') == 'en':
        lines = card['lines']
    else:
        # A Hindi interleaved card index is never treated as an R3 card index.
        pack, mapping = (bundle['declared'].get(k) for k in ('translated_deck', 'index_map'))
        if not isinstance(pack, dict) or pack.get('language') != 'hi' or not isinstance(mapping, list):
            raise ValueError('Hindi boards require R6 deck_hi and exact interleaved-index-map')
        match = [m for m in mapping if m.get('kind') == 'teaching' and m.get('original_card_idx') == card['card_idx']]
        if len(match) != 1:
            raise ValueError('R6 map lacks unique original R3 teaching identity')
        rows = [item for item in pack.get('items', []) if item.get('source', {}).get('card_idx') == match[0]['card_idx']]
        if len(rows) != 1:
            raise ValueError('R6 pack lacks unique mapped item')
        source = rows[0].get('source', {})
        from .translate_inputs import teaching_hash
        identity = bundle['declared'].get('translated_identity', {})
        if identity.get('source_file_sha256', {}).get('deck') != bundle['file_identity']['deck']['sha256']:
            raise ValueError('R6 Hindi pack originates from another R3 pack byte identity')
        if source.get('source_card_hash') != teaching_hash(card):
            raise ValueError('R6 teaching source hash does not match R3')
        if source.get('original_card_idx') != card['card_idx'] or source.get('card_type') != card['card_type']:
            raise ValueError('R6 mapped teaching descriptor does not match R3')
        lines = rows[0].get('lines')
        if not isinstance(lines, list) or len(lines) != len(card['lines']) or not all(
                isinstance(l, dict) and all(isinstance(l.get(k), str) for k in ('display', 'audio')) for l in lines):
            raise ValueError('R6 teaching lines must bind exactly for local narration')
    return [{'script': l['audio'], 'display': l['display'], 'kind': 'line'} for l in lines]


def source_identity(bundle):
    return {'card_index_namespace': 'R3 original Explain card_idx; never R5 slim or R6 interleaved',
            'input_sha256': {k: v['sha256'] for k, v in bundle['file_identity'].items()}}


def required(run, role):
    result = run.output(role)
    if 'technical_failure' in result:
        raise ValueError(role+': required model stage unavailable; no substitute content')
    return result


def visual_view(artifact):
    rows = artifact.get('visuals', [])
    if not isinstance(rows, list):
        raise ValueError('Visual artifact needs visuals array for execution')
    return {'visuals': [{**{k: r[k] for k in ('card_idx', 'expected_card_type', 'expected_title') if k in r},
                         'visual_explanation': {k: r.get('visual_explanation', {})[k] for k in VISUAL_FIELDS
                                                if k in r.get('visual_explanation', {})}} for r in rows]}


def board_view(artifact):
    return {k: artifact[k] for k in ('card_idx', 'route', 'rationale', 'nodes', 'beats', 'needs') if k in artifact}


def review_view(review):
    return {k: review[k] for k in ('ok', 'findings', 'note') if k in review}


def parse(role, text, notes_pages=None):
    value = strict_json(text)
    if not isinstance(value, dict):
        raise ValueError('Media role response must be object')
    if role.endswith('_review'):
        if not isinstance(value.get('findings'), list):
            raise ValueError('Media review requires findings array; negative findings never veto')
    elif not isinstance(value.get('artifact'), dict):
        raise ValueError('Media author requires object-valued artifact')
    return value  # Final shape defects remain saved; renderer reports technical execution separately.


def request(run, role, declared, batch, notes, final, prompt_name, frames=()):
    if batch or notes or not final:
        raise ValueError('Media roles use one explicit task turn; frames are derived review evidence')
    prompt = (ROOT/'prompts/visuals'/f'{prompt_name}.md').read_text()
    contract = ('Return ONLY a JSON object. Authors return {"artifact":<complete native object>,"dispositions":[],"note":""}; '
                'reviewers return {"findings":[],"ok":false,"note":""}. Inputs are inline. '
                'Do not use tools, source services or filesystem paths. English card words are immutable. '
                'Final revision is one authoritative artifact; no later content-quality review or veto. '
                'Pre-revision review images are rendered evidence, never original textbook pages. '
                'Images go only to review roles; final authors receive the review text and diagnostics.')
    content = [{'text': prompt+'\n\nLOCAL TRANSPORT CONTRACT:\n'+contract+
                '\nDeclared task data:\n'+json.dumps({'task_inputs': declared}, ensure_ascii=False)}]
    if frames and not role.endswith('_review'):
        raise ValueError('Derived frame pixels are restricted to review roles')
    for frame in frames:
        content.append({'image': {'format': frame['format'], 'source': {'bytes': frame['data']}}})
    return {'messages': [{'role': 'user', 'content': content}]}


def review_evidence(out_dir, result, limit):
    """Deliver a small explicit sample; freeze and verify exact pixels before each use."""
    all_frames = result.get('reviewer_frames', [])
    # Include temporal and phone evidence when present. No file path enters messages.
    selected = []
    if all_frames:
        wide = [f for f in all_frames if f.get('view') == 'wide']
        phone = [f for f in all_frames if f.get('view') == 'phone']
        sample = (wide[len(wide)//2], wide[-1], phone[-1]) if wide and phone else (
            all_frames[0], all_frames[len(all_frames)//2], all_frames[-1])
        for row in sample:
            if row not in selected:
                selected.append(row)
    selected = selected[:limit]
    pixels, descriptors = [], []
    for row in selected:
        path = (Path(out_dir)/row['file']).resolve()
        if not path.is_relative_to(Path(out_dir).resolve()):
            raise ValueError('Derived frame escapes local render workspace')
        data = path.read_bytes()
        if sha(data) != row['sha256']:
            raise ValueError('Frozen reviewer frame changed')
        with Image.open(io.BytesIO(data)) as image:
            image.load()
            if image.size != (row['width'], row['height']):
                raise ValueError('Derived frame dimensions changed')
        if len(data) > 3_932_160:
            raise ValueError('Derived frame too large for provider transport')
        pixels.append({'data': data, 'format': row['format']})
        descriptors.append({k: row[k] for k in ('sha256', 'format', 'width', 'height', 't_ms', 'view', 'param', 'value') if k in row})
    return pixels, {'status': result.get('status'), 'frames': descriptors,
                    'sampling': 'board: middle-wide/completed-wide/completed-phone; otherwise first/middle/last; bounded by provider image limit',
                    'diagnostics': safe_diagnostics(result.get('diagnostics', []))}


def safe_diagnostics(value):
    # Raw subprocess errors may contain paths. Compile diagnostics have explicit
    # task-local IDs and fixed public error strings; expose those useful facts.
    messages = {'Repeated or missing exact phrase requires a valid occurrence', 'Exact phrase occurrence not found',
                'Phrase has no word timing', 'Beat line must be zero-based narration block index',
                'Beat targets must be unique known nodes', 'Emphasis requires an already completed node',
                'Immutable nodes may be drawn once; use emphasis thereafter', 'Board requires draw/emphasis beats',
                'Invalid beat fields', 'Board node fields do not match documented type',
                'Invalid/duplicate board node id/type'}
    result = []
    for row in value if isinstance(value, list) else []:
        if isinstance(row, dict) and row.get('kind') == 'undrawn_nodes':
            result.append({'kind': 'undrawn_nodes', 'targets': row.get('targets', [])})
        elif isinstance(row, dict) and row.get('message') in messages:
            result.append({'kind': 'compile_failure', 'message': row['message']})
        else:
            result.append({'kind': 'local_execution_diagnostic', 'details': 'Raw diagnostic retained privately.'})
    return result


def board_schedule(directory):
    path = directory/'scene.json'
    if not path.exists(): return {'available': False}
    scene = read(path)
    return {k: scene[k] for k in ('schema', 'route', 'width', 'height', 'nodes_sha256',
            'cues', 'clip_timeline', 'duration_ms', 'timing') if k in scene}


def stage(workspace, name, result):
    save(workspace/'metrics'/f'{name}.json', {'status': result.get('status', 'failed'),
         'kind': 'local_media_execution', 'quality_gate': False, 'final_artifacts_preserved': True})


def cached_render(directory):
    result = read(directory/'manifest.json')
    for row in result.get('files', []):
        path = (directory/row['file']).resolve()
        if not path.is_relative_to(directory.resolve()) or sha(path.read_bytes()) != row['sha256']:
            raise ValueError('Frozen rendered asset changed')
    return result


def report_media(workspace):
    rows = []
    for path in sorted((workspace/'media').glob('*/manifest.json')):
        value = read(path)
        directory = path.parent
        row = {'name': directory.name, 'status': value.get('status', 'unavailable')}
        for field, name in (('viewer','viewer.html'),('video','playback.mp4'),('poster','poster.png')):
            if (directory/name).is_file(): row[field] = str((directory/name).relative_to(workspace))
        frames = value.get('reviewer_frames', [])
        if frames:
            row['frame'] = str((directory/frames[-1]['file']).relative_to(workspace))
        rows.append(row)
    return rows


def stages(workspace, names):
    return {name: read(workspace/'metrics'/f'{name}.json') if (workspace/'metrics'/f'{name}.json').exists()
            else {'status': 'unavailable', 'kind': 'local_media_execution', 'quality_gate': False}
            for name in names}
