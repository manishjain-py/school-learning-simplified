#!/usr/bin/env python3
"""Shared local narration for native Explain, Practice, Revise and R6 packs; no model."""
import argparse
from pathlib import Path
from reference import media
from reference.inputs import canonical, load_manifest, read, runtime_identity, save, sha
from reference.runtime import exclusive
from reference.factories.media_common import BINARY_INPUTS

NAME = 'audio'
METADATA = {'kind'}
REQUIRED_METADATA = ('kind',)
REQUIRES_PAGES = False
PRESERVE_FILE_BYTES = True
FILE_INPUTS = ('pack', 'selection', 'speech', 'alignment', *BINARY_INPUTS)


def blocks(bundle):
    kind = bundle['metadata']['kind']
    pack = bundle['declared'].get('pack', {})
    selection = bundle['declared'].get('selection', {})
    indices = selection.get('indices')
    if set(selection) - {'indices'} or (indices is not None and (not isinstance(indices, list) or
            not indices or any(type(i) is not int or i < 1 for i in indices) or len(set(indices)) != len(indices))):
        raise ValueError('Selection indices are unique positive native array ordinals')
    translated = kind.startswith('translate_')
    field = 'items' if translated else 'questions' if kind == 'practice' else 'cards'
    if kind not in ('explain', 'practice', 'revise', 'translate_deck', 'translate_practice', 'translate_revise'):
        raise ValueError('Unsupported native audio pack kind')
    if not isinstance(pack, dict) or not isinstance(pack.get(field), list):
        raise ValueError('Audio pack must use its native object array')
    if translated and (pack.get('schema_version') != 2 or pack.get('language') != 'hi'):
        raise ValueError('Translated audio requires native R6 version2 Hindi pack')
    result, origins = [], []
    for ordinal, item in enumerate(pack[field], 1):
        if indices and ordinal not in indices: continue
        texts = []
        if kind == 'explain':
            texts = [l['audio'] for l in item.get('lines', [])]
        elif kind == 'practice':
            # Native audio_text is independently authored; display text/options
            # can intentionally differ. Never silently replace the spoken ask.
            if not isinstance(item.get('audio_text'), str) or not item['audio_text'].strip():
                raise ValueError('Native Practice narration requires authored audio_text')
            texts = [item['audio_text'], item.get('explanation_why', '')]
        elif kind == 'revise' or kind == 'translate_revise':
            texts = [item.get(face, {}).get('audio', '') for face in ('question', 'answer')]
        elif kind == 'translate_deck' and item.get('source', {}).get('card_type') != 'check_in':
            texts = [l['audio'] for l in item.get('lines', [])]
        else:
            texts = [item.get('question_audio', ''), *item.get('options_audio', []),
                     item.get('explanation_display', ''), item.get('hint_audio', ''), item.get('success_audio', '')]
        for position, text in enumerate(texts):
            if text:
                if not isinstance(text, str): raise ValueError('Native spoken fields must be text')
                block_kind = ('question' if position == 0 else 'feedback') if kind in ('practice','translate_practice') else 'line'
                result.append({'script': text, 'display': text, 'kind': block_kind})
                origins.append({'ordinal': ordinal, 'native_card_idx': item.get('card_idx', item.get('source', {}).get('card_idx')),
                                'native_idx': item.get('idx', item.get('source', {}).get('idx')),
                                'speech_basis': ('authored audio_text' if position == 0 else 'exact explanation_why read as feedback')
                                                if kind == 'practice' else 'native spoken text; display feedback explicitly read when present'})
    if indices and not set(indices) <= set(range(1, len(pack[field])+1)):
        raise ValueError('Selected ordinal absent from pack')
    if not result: raise ValueError('Selected native pack has no spoken text')
    return result, origins


def validate_inputs(bundle):
    if bundle['pages']: raise ValueError('Audio has no page inputs')
    blocks(bundle)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('manifest', type=Path)
    parser.add_argument('--workspace', required=True, type=Path)
    args = parser.parse_args(argv)
    import sys
    bundle, blobs = load_manifest(args.manifest, sys.modules[__name__])
    scripts, origins = blocks(bundle)
    with exclusive(args.workspace) as workspace:
        if any(p.name != 'operator.lock' for p in workspace.iterdir()):
            raise ValueError('Audio workspace contains evidence; use a fresh workspace')
        save(workspace/'identity.json', {'factory': NAME, 'input_sha256': sha(canonical(bundle)),
             'runtime': runtime_identity(), 'execution': media.runtime_identity(), 'paid_calls': 0})
        save(workspace/'inputs.json', bundle)
        for name, data in blobs.items():
            (workspace/'inputs').mkdir(exist_ok=True)
            (workspace/'inputs'/name).write_bytes(data)
        save(workspace/'origins.json', {'kind': bundle['metadata']['kind'], 'input_sha256': bundle['file_identity']['pack']['sha256'],
                                      'selection_namespace': 'one-based native pack array ordinal', 'blocks': origins})
        speech = dict(bundle['declared'].get('speech', {}))
        slots = speech.pop('clips', [])
        if slots and (len(slots) != len(scripts) or any(s not in BINARY_INPUTS or s not in bundle['declared'] for s in slots)):
            raise ValueError('Supplied clips must bind each script to one explicit binary slot')
        supplied = {i: {'path': workspace/'inputs'/bundle['file_identity'][s]['file'],
                         'sha256': bundle['file_identity'][s]['sha256']} for i, s in enumerate(slots)}
        alignment = bundle['declared'].get('alignment', {}).get('blocks')
        if alignment is not None:
            if not slots or not isinstance(alignment, list) or len(alignment) != len(scripts):
                raise ValueError('Alignment must bind each explicitly supplied clip')
            for i, value in enumerate(alignment): supplied[i]['alignment'] = value
        try:
            result = media.synthesize(scripts, workspace/'audio', speech, supplied or None, allowed_roots=[workspace])
            save(workspace/'summary.json', {'status': 'complete', 'blocks': len(scripts), 'paid_calls': 0,
                 'audio': result['audio'], 'word_timing': result['word_timing'], 'alignment_verified': result['alignment_verified']})
        except Exception:
            save(workspace/'summary.json', {'status': 'failed', 'paid_calls': 0, 'kind': 'local_audio_execution'})
            raise
    print('Shared audio:', args.workspace/'summary.json')
    return 0


if __name__ == '__main__':
    try: raise SystemExit(main())
    except (ValueError, RuntimeError, OSError, KeyError) as error: raise SystemExit(str(error))
