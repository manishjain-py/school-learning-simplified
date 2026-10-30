"""Fixed R10 local artifact edges; no curriculum authoring or source discovery.

``inputs`` is the conductor's frozen, absolute-path pipeline manifest. ``build``
returns an ordinary native factory manifest and saves only deterministic views.
The native factories still own input validation, authorship and media execution.
"""
from pathlib import Path

from .inputs import read, save, sha


STAGES = (
    'toc', 'guideline', 'explain', 'practice', 'revise', 'translate', 'visuals',
    'boards_en', 'boards_hi', 'audio_en_explain', 'audio_en_practice',
    'audio_en_revise', 'audio_hi_deck', 'audio_hi_practice', 'audio_hi_revise',
    'avatar_en', 'avatar_hi', 'feedback',
)
NAMESPACES = {
    'explain': 'R3 original Explain card_idx',
    'revise': 'R5 input-local teaching indices; views/explain-index-map.json binds R3 originals',
    'translate': 'R6 interleaved card_idx; views/interleaved-index-map.json binds R3 originals/check-ins',
    'audio_selection': 'one-based native pack array ordinal, not card_idx or R5 teaching index',
}


def _path(value):
    path = Path(value)
    if not path.is_absolute():
        raise ValueError('Pipeline adapter inputs must already have absolute frozen paths')
    path = path.resolve()
    if not path.is_file():
        raise ValueError('Required declared input/artifact is unavailable: '+str(path))
    return path


def _descriptor(path):
    path = _path(path)
    return {'path': str(path), 'sha256': sha(path.read_bytes())}


def _file(inputs, key, kind='json', optional=False):
    spec = inputs.get('files', {}).get(key)
    if spec is None and optional:
        return None
    if not isinstance(spec, dict) or set(spec) != {'path', 'type'} or spec['type'] != kind:
        raise ValueError(f'Pipeline file {key} requires an explicit {kind} file')
    return {'path': str(_path(spec['path'])), 'type': kind}


def _artifact(workspace, stage, name):
    return {'path': str(_path(workspace/'stages'/stage/name)), 'type': 'json'}


def _view(workspace, name, value):
    path = workspace/'views'/name
    if path.exists():
        if read(path) != value:
            raise ValueError('Frozen adapter view differs: '+str(path))
    else:
        save(path, value)
    return {'path': str(path), 'type': 'json'}


def _selected_chapter(inputs, workspace):
    source = _artifact(workspace, 'toc', 'artifacts/chapter-map.json')
    toc = read(source['path'])
    number = inputs['chapter_number']
    if type(number) is not int or not isinstance(toc.get('chapters'), list):
        raise ValueError('Select an explicit integer chapter_number from the actual TOC chapters')
    matches = [c for c in toc['chapters'] if isinstance(c, dict) and
               type(c.get('chapter_number')) is int and c['chapter_number'] == number]
    if len(matches) != 1:
        raise ValueError('TOC does not identify one selected chapter; no substitute chapter')
    chapter = matches[0]
    start, end = chapter.get('start_page'), chapter.get('end_page')
    title = chapter.get('chapter_title')
    if (type(start) is not int or type(end) is not int or not 0 < start <= end or
            not isinstance(title, str) or not title.strip()):
        raise ValueError('Selected TOC entry needs a usable title and inclusive integer range')
    pages, identities, seen = [], [], set()
    for page in inputs['chapter_pages']:
        printed = page['printed_page']
        if type(printed) is not int or printed in seen:
            raise ValueError('Declared chapter pages need unique integer printed_page labels')
        seen.add(printed)
        if start <= printed <= end:
            path = _path(page['path'])
            pages.append({'printed_page': printed, 'path': str(path)})
            identities.append({'printed_page': printed, **_descriptor(path)})
    if not pages:
        raise ValueError('No explicitly supplied chapter pages fall inside the selected TOC range')
    metadata = {**inputs['metadata'], 'chapter_number': number, 'chapter_title': title}
    selection = {'schema': 'local-pipeline-selected-chapter/v1', 'metadata': metadata,
                 'source_toc': _descriptor(source['path']), 'selected_chapter': chapter,
                 'selected_pages': identities,
                 'selection_policy': 'Only explicitly supplied chapter_pages within the inclusive TOC range; no discovery or missing-page fill'}
    _view(workspace, 'selected-chapter.json', selection)
    # Paths and adapter/operator policy stay in the local evidence view, never
    # in the educational context passed to content roles.
    context = {'metadata': metadata, 'selected_chapter': chapter,
               'source_toc_sha256': selection['source_toc']['sha256'],
               'selected_pages': [{key: row[key] for key in ('printed_page', 'sha256')}
                                  for row in identities]}
    if 'context' in inputs.get('files', {}):
        spec = inputs['files']['context']
        if spec.get('type') not in ('text', 'json'):
            raise ValueError('Optional pipeline context must be text or JSON')
        supplied = _file(inputs, 'context', spec['type'])
        context['supplied_context'] = (read(supplied['path']) if spec['type'] == 'json'
                                       else Path(supplied['path']).read_text())
        context['supplied_context_identity'] = {
            'type': spec['type'], 'sha256': _descriptor(supplied['path'])['sha256']}
    return metadata, pages, _view(workspace, 'guideline-context.json', context)


def _translated(workspace):
    return {
        'translated_deck': _artifact(workspace, 'translate', 'artifacts/deck_hi.json'),
        'index_map': _artifact(workspace, 'translate', 'views/interleaved-index-map.json'),
        'translated_identity': _artifact(workspace, 'translate', 'views/reference-identity.json'),
    }


def _avatar_ordinals(inputs, workspace):
    """Bind explicit original R3 targets to actual R6 native array ordinals."""
    translated = _translated(workspace)
    pack = read(translated['translated_deck']['path'])
    mapping = read(translated['index_map']['path'])
    targets = read(_file(inputs, 'avatar_targets')['path'])['targets']
    result = []
    for target in targets:
        original = target['card_idx']
        matches = [m for m in mapping if m.get('kind') == 'teaching' and
                   m.get('original_card_idx') == original]
        if len(matches) != 1:
            raise ValueError('R6 map lacks a unique explicit Avatar target')
        items = [(ordinal, item) for ordinal, item in enumerate(pack['items'], 1)
                 if item.get('source', {}).get('card_idx') == matches[0]['card_idx'] and
                 item.get('source', {}).get('original_card_idx') == original]
        if len(items) != 1:
            raise ValueError('R6 pack lacks a unique mapped Avatar target')
        result.append((original, *items[0]))
    return result


def _hindi_audio_selection(inputs, workspace):
    spec = _file(inputs, 'audio_hi_selection')
    value = read(spec['path'])
    indices = value.get('indices')
    if (set(value) != {'indices'} or not isinstance(indices, list) or not indices or
            any(type(i) is not int or i < 1 for i in indices) or len(set(indices)) != len(indices)):
        raise ValueError('audio_hi_selection requires explicit unique positive native ordinals')
    selected = set(indices) | {ordinal for _, ordinal, _ in _avatar_ordinals(inputs, workspace)}
    return _view(workspace, 'audio-hi-selection.json', {'indices': sorted(selected)})


def _hindi_avatar_audio(inputs, workspace):
    """Reuse actual R7 clips; Hindi Avatar's native API forbids implicit speech."""
    translated = _translated(workspace)
    directory = workspace/'stages/audio_hi_deck'
    origins = read(_path(directory/'origins.json'))
    root = directory/'audio'
    narration = read(_path(root/'narration.json'))
    if (origins.get('kind') != 'translate_deck' or
            origins.get('input_sha256') != sha(Path(translated['translated_deck']['path']).read_bytes()) or
            narration.get('schema') != 'local-narration/v1'):
        raise ValueError('Hindi Avatar audio must originate from the exact actual R6 deck')
    clips, blocks, source_rows = narration['clips'], narration['blocks'], origins['blocks']
    if len(clips) != len(blocks) or len(clips) != len(source_rows):
        raise ValueError('Hindi audio clip/block/origin counts differ')
    for index, (clip, block) in enumerate(zip(clips, blocks)):
        if (clip.get('index') != index or block.get('index') != index or
                clip.get('script') != block.get('script') or
                sha(clip['script'].encode()) != clip.get('script_sha256') or
                block.get('clip_sha256') != clip.get('sha256')):
            raise ValueError('Hindi audio narration identity/order differs')
    speech = read(_file(inputs, 'speech_hi')['path'])
    speech = {**speech, 'language': 'hi', 'leading_gap_ms': 600, 'gap_ms': 300, 'clips': {}}
    files, bindings = {}, []
    for original, ordinal, item in _avatar_ordinals(inputs, workspace):
        selected = [clip for clip, origin in zip(clips, source_rows) if
                    origin.get('ordinal') == ordinal and
                    origin.get('native_card_idx') == item['source']['card_idx']]
        if [clip['script'] for clip in selected] != [line['audio'] for line in item['lines']]:
            raise ValueError('Hindi Avatar needs every exact translated line clip in native order')
        slots = []
        for clip in selected:
            slot = f'clip_{len(files)+1:03d}'
            if len(files) >= 32:
                raise ValueError('Hindi Avatar exceeds the native 32 explicit clip slots')
            path = _path(root/clip['file'])
            if not path.is_relative_to(root.resolve()) or sha(path.read_bytes()) != clip['sha256']:
                raise ValueError('Hindi Avatar source clip missing, escaped or changed')
            files[slot] = {'path': str(path), 'type': 'binary'}
            slots.append(slot)
            bindings.append({'original_card_idx': original, 'translated_ordinal': ordinal,
                             'slot': slot, 'source_clip': _descriptor(path),
                             'script_sha256': clip['script_sha256']})
        speech['clips'][str(original)] = slots
    _view(workspace, 'avatar-hi-clip-bindings.json', {
        'source_narration': _descriptor(root/'narration.json'),
        'source_origins': _descriptor(directory/'origins.json'), 'bindings': bindings})
    return {**files, 'speech': _view(workspace, 'speech-hi-avatar.json', speech)}


def build(stage, inputs, workspace):
    """Adapt one fixed stage using frozen declared inputs and actual predecessors."""
    if stage not in STAGES:
        raise ValueError('Unknown fixed pipeline stage: '+str(stage))
    workspace = Path(workspace).resolve()
    if inputs.get('version') != 1 or set(inputs['metadata']) != {'grade', 'subject'}:
        raise ValueError('Pipeline adapter needs version 1 and explicit grade/subject metadata')
    metadata = dict(inputs['metadata'])
    factory, pages, files = stage, [], {}
    original = lambda: _artifact(workspace, 'explain', 'artifacts/deck.json')
    guideline = lambda: _artifact(workspace, 'guideline', 'artifacts/guideline.json')
    scope = inputs['practice']['scope']
    if scope not in ('additions', 'bank_snapshot'):
        raise ValueError('Practice scope must explicitly choose additions or bank_snapshot')
    practice = lambda: _artifact(workspace, 'practice', 'artifacts/'+
                                ('questions.json' if scope == 'additions' else 'bank-snapshot.json'))
    revise = lambda: _artifact(workspace, 'revise', 'artifacts/revise_deck.json')
    if stage == 'toc':
        metadata['title'] = f"{metadata['subject']} — grade {metadata['grade']}"
        pages = [{'printed_page': page['printed_page'], 'path': str(_path(page['path']))}
                 for page in inputs['toc_pages']]
    elif stage == 'guideline':
        metadata, pages, context = _selected_chapter(inputs, workspace)
        files = {'context': context}
    elif stage == 'explain':
        metadata['mode'] = 'generate'
        files = {'guideline': guideline()}
        research = _file(inputs, 'research', optional=True)
        if research:
            files['research'] = research
    elif stage == 'practice':
        if inputs['practice']['mode'] not in ('seed', 'growth', 'seed-growth'):
            raise ValueError('Practice mode must select the native seed/growth path')
        metadata.update(mode='seed-growth', **{key: inputs['practice'][key]
                                               for key in ('target', 'run_cap')})
        files = {'guideline': guideline(), 'deck': original(), 'bank': _file(inputs, 'bank')}
    elif stage == 'revise':
        files = {'guideline': guideline(), 'deck': original()}
    elif stage == 'translate':
        # Match the native translator's bounded default rather than combining up
        # to fifty teaching cards into one final-author serialization request.
        metadata.update(language='hi', batch_size=12)
        files = {'deck': original(), 'checkins': _artifact(workspace, 'explain', 'artifacts/check-ins.json'),
                 'practice': practice(), 'revise': revise()}
    elif stage == 'visuals' or stage.startswith('boards_'):
        factory = 'visuals' if stage == 'visuals' else 'boards'
        files = {'guideline': guideline(), 'deck': original(),
                 'targets': _file(inputs, 'visual_targets' if stage == 'visuals' else 'board_targets')}
        if factory == 'boards':
            files['speech'] = _file(inputs, 'speech_hi' if stage.endswith('_hi') else 'speech_en')
        if stage == 'boards_hi':
            files.update(_translated(workspace))
    elif stage.startswith('audio_'):
        factory = 'audio'
        kinds = {'audio_en_explain': ('explain', original), 'audio_en_practice': ('practice', practice),
                 'audio_en_revise': ('revise', revise),
                 'audio_hi_deck': ('translate_deck', lambda: _artifact(workspace, 'translate', 'artifacts/deck_hi.json')),
                 'audio_hi_practice': ('translate_practice', lambda: _artifact(workspace, 'translate', 'artifacts/practice_hi.json')),
                 'audio_hi_revise': ('translate_revise', lambda: _artifact(workspace, 'translate', 'artifacts/revise_hi.json'))}
        kind, pack = kinds[stage]
        metadata = {'kind': kind}
        files = {'pack': pack(), 'speech': _file(inputs, 'speech_hi' if '_hi_' in stage else 'speech_en'),
                 'selection': (_hindi_audio_selection(inputs, workspace) if stage == 'audio_hi_deck'
                               else _file(inputs, 'audio_selection'))}
    elif stage.startswith('avatar_'):
        factory = 'avatar'
        files = {'deck': original(), 'targets': _file(inputs, 'avatar_targets'),
                 'artwork': _file(inputs, 'artwork', 'binary'),
                 'avatar_config': _file(inputs, 'avatar_config')}
        if stage == 'avatar_hi':
            files.update(_translated(workspace))
            files.update(_hindi_avatar_audio(inputs, workspace))
        else:
            files['speech'] = _file(inputs, 'speech_en')
    elif stage == 'feedback':
        files = {'feedback': _file(inputs, 'feedback'), 'guideline': guideline(), 'deck': original()}
    manifest = {'factory': factory, 'metadata': metadata, 'pages': pages, 'files': files}
    provenance = {'stage': stage, 'practice_scope': scope, 'namespaces': NAMESPACES,
                  'files': {key: {**_descriptor(spec['path']), 'type': spec['type']}
                            for key, spec in files.items()}}
    if stage == 'translate':
        provenance['r5_slim_mapping'] = _descriptor(
            _artifact(workspace, 'revise', 'views/explain-index-map.json')['path'])
    _view(workspace, stage+'-adapter-info.json', provenance)
    return manifest
