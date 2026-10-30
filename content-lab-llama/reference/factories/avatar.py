"""R8: actual local stylized media and advisory looks; no curriculum author."""
from copy import deepcopy
import io
import json
import math
from typing import TypedDict
from PIL import Image
from jsonschema import validate as validate_schema
from langgraph.graph import StateGraph, START, END
from .. import media, avatar_media
from ..inputs import ROOT, canonical, read, save, sha, strict_json
from . import media_common as c

NAME = 'avatar'
METADATA = {'grade', 'subject'}
REQUIRED_METADATA = ('grade', 'subject')
REQUIRES_PAGES = False
PRESERVE_FILE_BYTES = True
BINARY_INPUTS = ('artwork', *c.BINARY_INPUTS)
FILE_INPUTS = ('deck', 'targets', 'avatar_config', 'speech', 'alignment',
               'translated_deck', 'translated_identity', 'index_map', *BINARY_INPUTS)
ROLES = ()
execution_identity = avatar_media.runtime_identity
report_media = c.report_media


def speech_config(bundle):
    value = bundle['declared'].get('speech', {})
    allowed = {'voice', 'language', 'rate', 'gap_ms', 'leading_gap_ms', 'clips'}
    if not isinstance(value, dict) or set(value) - allowed:
        raise ValueError('Avatar speech requires documented config and explicit clip slots')
    language = value.get('language', 'en')
    if language not in ('en', 'hi'):
        raise ValueError('Avatar supports English or explicitly bound Hindi')
    slots = value.get('clips', {})
    if not isinstance(slots, dict):
        raise ValueError('Avatar clips map original card_idx to ordered frozen slots')
    for idx, names in slots.items():
        if not isinstance(idx, str) or not idx.isdecimal() or not isinstance(names, list) or not all(
                slot in c.BINARY_INPUTS and slot in bundle['declared'] for slot in names):
            raise ValueError('Avatar clips require explicit frozen binary slots')
    config = {k: value[k] for k in allowed - {'clips'} if k in value}
    if language == 'hi':
        if any(config.get(k, v) != v for k, v in (('leading_gap_ms', 600), ('gap_ms', 300))):
            raise ValueError('Hindi Avatar requires 600ms title lead and 300ms line gaps')
        config.update(leading_gap_ms=600, gap_ms=300)
    return config


def targets(bundle):
    value = bundle['declared'].get('targets')
    if not isinstance(value, dict) or set(value) != {'targets'} or not isinstance(value['targets'], list) or not value['targets']:
        raise ValueError('Avatar requires explicit nonempty targets array')
    lookup = {card['card_idx']: card for card in c.cards(bundle)}
    raw = {card['card_idx']: card for card in bundle['declared']['deck']['cards']}
    rows, seen = [], set()
    for row in value['targets']:
        if not isinstance(row, dict) or set(row) != {'card_idx'} or type(row['card_idx']) is not int:
            raise ValueError('Avatar target requires only original integer card_idx')
        idx = row['card_idx']
        if idx not in lookup or idx in seen:
            raise ValueError('Avatar requires unique known original R3 targets')
        seen.add(idx)
        card = deepcopy(lookup[idx])
        if card['card_type'] not in ('welcome', 'summary') or not card['lines'] or raw[idx].get('visual') not in (None, False):
            raise ValueError('Avatar accepts welcome/summary cards without an existing visual')
        if 'card_id' in raw[idx]:
            if not isinstance(raw[idx]['card_id'], str) or not raw[idx]['card_id'].strip():
                raise ValueError('Optional local card_id must be a nonempty string')
            card['card_id'] = raw[idx]['card_id']
        rows.append(card)
    return rows


def descriptor(bundle, card):
    config = speech_config(bundle)
    title = card['title']
    if config.get('language', 'en') == 'hi':
        if bundle['declared'].get('translated_deck', {}).get('schema_version') != 2:
            raise ValueError('Hindi Avatar requires a native R6 version2 translated deck')
        # Reuse R7's explicit R6 map + teaching hash + original pack-byte binding.
        compatible = deepcopy(bundle)
        compatible['declared']['speech'].pop('rate', None)
        lines = c.narration_blocks(compatible, card)
        mapping = bundle['declared']['index_map']
        mapped = next(m for m in mapping if m.get('kind') == 'teaching' and m.get('original_card_idx') == card['card_idx'])
        item = next(i for i in bundle['declared']['translated_deck']['items'] if i.get('source', {}).get('card_idx') == mapped['card_idx'])
        title = item.get('title_display')
        if not isinstance(title, str) or not title.strip():
            raise ValueError('Hindi Avatar requires native translated title_display')
        blocks = [{'kind': 'title', 'display': title, 'audio': ''}]
    else:
        lines = [{'display': line['display'], 'script': line['audio']} for line in card['lines']]
        blocks = [{'kind': 'title', 'display': title, 'audio': title}]
    blocks += [{'kind': 'line', 'display': line['display'], 'audio': line['script']} for line in lines]
    for i, block in enumerate(blocks):
        if not block['display'].strip() or (not block['audio'].strip() and i != 0):
            raise ValueError('Avatar blocks require nonempty exact display and spoken text')
        block['index'] = i
    return {**{k: card[k] for k in ('card_idx', 'card_id', 'card_type') if k in card},
            'title': title, 'expected_blocks': len(blocks), 'blocks': blocks}


def validate_inputs(bundle):
    if bundle['pages']:
        raise ValueError('Avatar receives explicit local artwork and predecessor packs, no book pages')
    for key, spec in bundle['file_identity'].items():
        if spec['type'] != ('binary' if key in BINARY_INPUTS else 'json'):
            raise ValueError('Avatar requires JSON inputs and explicit binary artwork/clips')
    if 'artwork' not in bundle['declared']:
        raise ValueError('Avatar requires explicit frozen PNG artwork')
    config = bundle['declared'].get('avatar_config')
    if not isinstance(config, dict) or not {'face', 'mouth'} <= set(config) or set(config) - {'face', 'mouth', 'fps', 'end_hold_ms'}:
        raise ValueError('Avatar config requires explicit face and mouth anchors')
    for card in targets(bundle):
        desc = descriptor(bundle, card)
        slots = bundle['declared'].get('speech', {}).get('clips', {}).get(str(card['card_idx']), [])
        expected = desc['expected_blocks'] - (1 if speech_config(bundle).get('language', 'en') == 'hi' else 0)
        if slots and len(slots) != expected:
            raise ValueError('Supplied Avatar clips must cover every spoken block in order')
        if speech_config(bundle).get('language', 'en') == 'hi' and not slots:
            raise ValueError('Hindi Avatar uses supplied R7/reader line clips; no implicit Hindi synthesis')


def stem(card): return f'avatar_c{card["card_idx"]:03d}'


def look_roles(card, limit):
    count = math.ceil(3 / limit)
    return [stem(card)+'_look'+(f'_b{i+1:03d}' if count > 1 else '') for i in range(count)]


def report_roles(workspace):
    limit = read(workspace/'identity.json')['config']['image_limit']
    return tuple(role for card in targets(read(workspace/'inputs.json')) for role in look_roles(card, limit))


def report_stages(workspace):
    return c.stages(workspace, [stem(card)+'_'+phase for card in targets(read(workspace/'inputs.json'))
                                for phase in ('narration', 'render')])


def parse(role, text, notes_pages=None):
    value = strict_json(text)
    validate_schema(value, read(ROOT/'schemas/avatar-look.json'))
    return value


def request(run, role, declared, batch, notes, final):
    raise ValueError('Avatar looks receive only explicitly verified derived pixels through look_request')


def look_request(declared, pixels):
    prompt = (ROOT/'prompts/avatar/look.md').read_text()
    schema = read(ROOT/'schemas/avatar-look.json')
    content = [{'text': prompt+'\nReturn ONLY a JSON object matching this schema:\n'+json.dumps(schema)+
                '\nDeclared task data:\n'+json.dumps({'task_inputs': declared}, ensure_ascii=False)}]
    content += [{'image': {'format': 'png', 'source': {'bytes': data}}} for data in pixels]
    return {'messages': [{'role': 'user', 'content': content}]}


def narration(run, card):
    name = stem(card)+'_audio'
    directory = run.workspace/'media'/name
    try:
        desc, config = descriptor(run.bundle, card), speech_config(run.bundle)
        hindi = config.get('language', 'en') == 'hi'
        spoken = desc['blocks'][1:] if hindi else desc['blocks']
        blocks = [{'kind': block['kind'], 'display': block['display'], 'script': block['audio']} for block in spoken]
        slots = run.bundle['declared'].get('speech', {}).get('clips', {}).get(str(card['card_idx']), [])
        alignment = run.bundle['declared'].get('alignment', {}).get('cards', {}).get(str(card['card_idx']))
        if alignment is not None and (not slots or not isinstance(alignment, list) or len(alignment) != len(slots)):
            raise ValueError('Avatar supplied alignment must bind every supplied clip')
        supplied = {}
        for i, slot in enumerate(slots):
            identity = run.bundle['file_identity'][slot]
            supplied[i] = {'path': run.workspace/'inputs'/identity['file'], 'sha256': identity['sha256']}
            if alignment is not None: supplied[i]['alignment'] = alignment[i]
        # The narrator owns its certified files and verifies them on every reuse.
        # Avatar's title/index projection is a derived view outside that file set.
        result = deepcopy(media.synthesize(blocks, directory, config, supplied or None, allowed_roots=[run.workspace]))
        if hindi:
            for row in result['blocks']: row['index'] += 1
            for row in result['words']: row['block'] += 1
            result['blocks'].insert(0, {'index': 0, 'kind': 'title', 'display': desc['title'], 'script': '',
                                      'start_ms': 0, 'end_ms': 600, 'timing_basis': 'explicit PCM silence'})
            result['assembly']['title_policy'] = 'display-only title, 600ms PCM silence; supplied line clips and 300ms gaps'
        else:
            result['assembly']['title_policy'] = 'spoken title block followed by exact native line audio'
        result['assembly_identity_sha256'] = sha(canonical({'config': config, 'blocks': result['blocks'],
                    'ordered_source_clip_hashes': [row['source_file']['sha256'] for row in result['clips']]}))
        save(run.workspace/'views'/(stem(card)+'-narration.json'), result)
        c.stage(run.workspace, stem(card)+'_narration', {'status': 'complete'})
        return result
    except Exception:
        c.stage(run.workspace, stem(card)+'_narration', {'status': 'failed'})
        raise


def render(run, card):
    directory = run.workspace/'media'/stem(card)
    try:
        audio = narration(run, card)
        if (directory/'manifest.json').exists():
            result = c.cached_render(directory)
        else:
            config = deepcopy(run.bundle['declared']['avatar_config'])
            identity = run.bundle['file_identity']['artwork']
            artwork = {'path': run.workspace/'inputs'/identity['file'], 'sha256': identity['sha256'],
                       **{k: config[k] for k in ('face', 'mouth') if k in config}}
            result = avatar_media.render_avatar(descriptor(run.bundle, card), audio, artwork, directory,
                        narration_root=run.workspace/'media'/(stem(card)+'_audio'), allowed_roots=[run.workspace],
                        fps=config.get('fps', 12), end_hold_ms=config.get('end_hold_ms', 250))
        c.stage(run.workspace, stem(card)+'_render', result)
        if result['status'] != 'complete':
            raise RuntimeError('Avatar local render failed; saved diagnostics and partial artifacts retained')
        return result
    except Exception:
        c.stage(run.workspace, stem(card)+'_render', {'status': 'failed'})
        raise


def evidence(directory, result):
    frames = result.get('reviewer_frames', [])
    wide = [row for row in frames if row['view'] == 'wide']
    crops = [row for row in frames if row['view'] == 'app_crop']
    if len(wide) < 2 or not crops:
        raise ValueError('Avatar needs actual temporal encoded frames and app crop')
    # Renderer produces first/peak/last; the app crop is from that same peak frame.
    peak = next((row for row in wide if row.get('frame_index') == result.get('motion', {}).get('peak_frame_index')),
                wide[len(wide)//2])
    if peak == wide[0]: peak = wide[len(wide)//2]
    selected = [wide[0], peak, crops[0]]
    pixels, descriptors = [], []
    for row in selected:
        path = (directory/row['file']).resolve()
        if not path.is_relative_to(directory.resolve()):
            raise ValueError('Avatar reviewer frame escapes render directory')
        data = path.read_bytes()
        if sha(data) != row['sha256']:
            raise ValueError('Frozen Avatar reviewer frame changed')
        with Image.open(io.BytesIO(data)) as image:
            image.load()
            if image.format != 'PNG' or image.size != (row['width'], row['height']):
                raise ValueError('Avatar reviewer frame format/dimensions changed')
        if len(data) > 3_932_160:
            raise ValueError('Avatar reviewer frame exceeds provider limit')
        pixels.append(data)
        descriptors.append({k: row[k] for k in ('sha256', 'format', 'width', 'height', 't_ms', 'view') if k in row})
    return pixels, descriptors


def graph(run):
    validate_inputs(run.bundle)
    work = targets(run.bundle)
    save(run.workspace/'views/reference-identity.json', c.source_identity(run.bundle))
    save(run.workspace/'views/targets.json', [descriptor(run.bundle, card) for card in work])
    class State(TypedDict): last_role: str
    flow = StateGraph(State)
    previous = START
    for card in work:
        phases = [(stem(card)+'_narration', 'narration', 0), (stem(card)+'_render', 'render', 0)]
        phases += [(role, 'look', index) for index, role in enumerate(look_roles(card, run.config['image_limit']))]
        phases += [(stem(card)+'_save_observations', 'save', 0)]
        for key, phase, batch_index in phases:
            def node(state, card=card, phase=phase, batch_index=batch_index, key=key):
                if phase == 'narration': narration(run, card)
                elif phase == 'render': render(run, card)
                elif phase == 'look':
                    result = render(run, card)
                    pixels, frames = evidence(run.workspace/'media'/stem(card), result)
                    limit = run.config['image_limit']
                    start, end = batch_index*limit, (batch_index+1)*limit
                    data = {'grade': run.bundle['metadata']['grade'], 'subject': run.bundle['metadata']['subject'],
                            'card': descriptor(run.bundle, card), 'language': speech_config(run.bundle).get('language', 'en'),
                            'adaptation': 'stylized character with decoded-audio-energy mouth motion; no phoneme alignment',
                            'frames': frames[start:end], 'sample_batch': batch_index+1,
                            'sample_batches': len(look_roles(card, limit)), 'quality_gate': False,
                            'timing': {'segments': 'decoded measured PCM', 'words': narration(run, card)['word_timing'],
                                       'alignment_verified': narration(run, card)['alignment_verified']}}
                    def parse_card(text):
                        value = parse(key, text)
                        if value['card_idx'] != card['card_idx']:
                            raise ValueError('Avatar inspection returned another card_idx')
                        return value
                    run.invoke(key, key, look_request(data, pixels[start:end]), parse_card)
                    c.required(run, key)
                else:
                    observations = [c.required(run, role) for role in look_roles(card, run.config['image_limit'])]
                    save(run.workspace/'artifacts'/(stem(card)+'_observations.json'),
                         {'card': descriptor(run.bundle, card), 'inspections': observations,
                          'quality_gate': False, 'artifacts_withheld': False,
                          'limitation': 'Stills cannot establish lip-sync or speech/text alignment.'})
                return {'last_role': key}
            flow.add_node(key, node)
            flow.add_edge(previous, key)
            previous = key
    flow.add_edge(previous, END)
    return flow.compile()


def observations(results):
    return ['Source Avatar has no curriculum author; local graph adds none.',
            'Stylized decoded-audio-energy mouth animation is not photorealistic or phoneme-exact lip-sync.',
            'LOOK_SCHEMA pass/fail observations are advisory and never withhold audiovisual artifacts.',
            'Actual encoded temporal frames and app crop support appearance inspection only; no listening/ASR claim.',
            'English speaks title then lines. Hindi binds native R6 identities and supplied line clips, with a silent 600ms title.',
            'No source render engine, paid TTS/video, cloud import/freshness/publication or event submission.']
