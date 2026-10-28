"""New trusted local projections with pinned source hash contracts."""
import json
from copy import deepcopy
from ..inputs import canonical, sha

STREAMS = ('teaching', 'checkin', 'practice', 'feedback', 'revise')
OPTION_FIELDS = {k: 'options' for k in ('pick_one', 'fill_blank', 'multi_select', 'predict_then_reveal', 'tap_to_eliminate')}
OPTION_FIELDS['odd_one_out'] = 'odd_items'
FORMATS = set(OPTION_FIELDS) | {'true_false', 'free_form'}
ANSWER_FIELDS = ('correct_index', 'correct_indices', 'correct_answer', 'correct_answer_bool', 'odd_index', 'expected_answer')


def clean(value):
    return ' '.join(value.split()).strip() if isinstance(value, str) else ''


def options(fmt, source):
    return source.get(OPTION_FIELDS.get(fmt), []) if fmt in OPTION_FIELDS else []


def correct_line(fmt, source):
    choices = options(fmt, source)
    if fmt in ('pick_one', 'fill_blank', 'tap_to_eliminate', 'predict_then_reveal', 'odd_one_out'):
        index = source.get('odd_index' if fmt == 'odd_one_out' else 'correct_index')
        return clean(choices[index]) if type(index) is int and 0 <= index < len(choices) else ''
    if fmt == 'multi_select':
        indices = sorted({i for i in source.get('correct_indices', []) if type(i) is int})
        return '; '.join(clean(choices[i]) for i in indices if 0 <= i < len(choices) and clean(choices[i]))
    if fmt == 'true_false':
        value = source.get('correct_answer_bool', source.get('correct_answer'))
        return '' if value is None else 'TRUE' if value else 'FALSE'
    return clean(source.get('expected_answer')) if fmt == 'free_form' else ''


def question_hash(fmt, source):
    payload = {k: clean(source.get(k)) for k in ('question_text', 'instruction', 'statement', 'hint',
               'success_message', 'reveal_text', 'explanation_why')}
    payload.update(format=clean(fmt), options=[' '.join(str(o).split()).strip() for o in options(fmt, source)],
                   correct_answer=correct_line(fmt, source))
    return sha(canonical(payload))[:20]


def teaching_hash(card):
    return sha(canonical({'card_type': card.get('card_type'), 'title': card.get('title') or '',
        'lines': [{k: line.get(k) or '' for k in ('display', 'audio')} for line in card.get('lines', [])]}))


def revise_hash(cards):
    identity = [[position, c.get('idx'), c.get('concept_key'), c.get('section_key'),
                 c['question'].get('display'), c['answer'].get('display')] for position, c in enumerate(cards)]
    return sha(json.dumps(identity, ensure_ascii=False, separators=(',', ':')).encode())


def rows(source, field, name):
    if not isinstance(source, dict) or not isinstance(source.get(field), list) or not all(isinstance(x, dict) for x in source[field]):
        raise ValueError(name+' requires a native '+field+' object array')
    return source[field]


def positive_unique(items, key, name):
    values = [item.get(key) for item in items]
    if any(type(x) is not int or x < 1 for x in values) or len(values) != len(set(values)):
        raise ValueError(name+' requires unique positive '+key)


def text_fields(value, fields, name):
    if not all(isinstance(value.get(k), str) for k in fields):
        raise ValueError(name+' requires text '+', '.join(fields))


def question_projection(source, fmt, slot):
    if fmt not in FORMATS:
        raise ValueError('Unsupported question format: '+str(fmt)+'; no subset export')
    choices = options(fmt, source)
    if not isinstance(choices, list) or not all(isinstance(x, str) for x in choices):
        raise ValueError('Question choices must be an ordered string array')
    for key in ('question_text', 'instruction', 'statement', 'hint', 'success_message', 'reveal_text', 'explanation_why'):
        if key in source and not isinstance(source[key], str):
            raise ValueError('Question text/feedback fields must be strings')
    return {'slot': slot, 'source_hash': question_hash(fmt, source), 'format': fmt,
            **{k: source[k] for k in ('question_text', 'instruction', 'statement') if k in source},
            'options': deepcopy(choices)}


def project(bundle):
    """Never return raw source objects as model data; identities computed first."""
    declared = bundle['declared']
    teaching = rows(declared.get('deck'), 'cards', 'Translate deck')
    checkins = rows(declared.get('checkins', {'check_ins': []}), 'check_ins', 'Translate checkins')
    practice = rows(declared.get('practice', {'questions': []}), 'questions', 'Translate practice')
    revision = rows(declared.get('revise', {'cards': []}), 'cards', 'Translate revise')
    positive_unique(teaching, 'card_idx', 'Teaching')
    positive_unique(revision, 'idx', 'Revise')
    by_after = {}
    original_indices = {c['card_idx'] for c in teaching}
    for ordinal, item in enumerate(checkins, 1):
        after = item.get('insert_after_card_idx')
        if type(after) is not int or after not in original_indices:
            raise ValueError('Check-in insertion has no teaching source identity')
        by_after.setdefault(after, []).append((ordinal, item))
    streams = {s: [] for s in STREAMS}
    descriptors, deck, mapping = {s: [] for s in STREAMS}, [], []
    for card in teaching:
        if card.get('card_type') == 'check_in':
            raise ValueError('Supply separate R3 teaching and check-in artifacts')
        text_fields(card, ('card_type', 'title'), 'Teaching card')
        lines = rows(card, 'lines', 'Teaching card')
        for line in lines:
            text_fields(line, ('display', 'audio'), 'Teaching line')
        idx = len(deck)+1
        slot = f'teaching:{idx}'
        digest = teaching_hash(card)
        source = {'card_idx': idx, 'original_card_idx': card['card_idx'], 'card_type': card['card_type'],
                  'title': card['title'], 'source_card_hash': digest}
        streams['teaching'].append({'slot': slot, 'source_hash': digest, 'card_idx': idx,
            'card_type': card['card_type'], 'title': card['title'],
            'lines': [{k: line[k] for k in ('display', 'audio')} for line in lines]})
        descriptors['teaching'].append({'slot': slot, 'source_hash': digest, 'source': source})
        deck.append({'stream': 'teaching', 'slot': slot})
        mapping.append({'card_idx': idx, 'original_card_idx': card['card_idx'], 'teaching_array_position': len(descriptors['teaching']), 'kind': 'teaching'})
        for ordinal, ci in by_after.get(card['card_idx'], []):
            idx = len(deck)+1
            slot = f'checkin:{idx}'
            fmt = ci.get('activity_type')
            projection = question_projection(ci, fmt, slot)
            digest = projection['source_hash']
            source = {'card_idx': idx, 'card_type': 'check_in', 'title': ci.get('title', ''),
                      'original_checkin_ordinal': ordinal, 'insert_after_card_idx': card['card_idx'],
                      'activity_type': fmt, 'source_card_hash': teaching_hash({'card_type': 'check_in', 'title': ci.get('title', '')}),
                      'source_question_hash': digest}
            streams['checkin'].append(projection)
            desc = {'slot': slot, 'source_hash': digest, 'source': source,
                    'english_answer_key': {k: deepcopy(ci[k]) for k in ANSWER_FIELDS if k in ci},
                    'english_options': deepcopy(projection['options'])}
            descriptors['checkin'].append(desc)
            # T03: even hints and congratulatory text can disclose an answer.
            feedback = {k: ci[k] for k in ('hint', 'success_message', 'reveal_text') if k in ci}
            if feedback:
                streams['feedback'].append({'slot': slot, 'source_hash': digest, 'kind': 'checkin', **feedback})
                descriptors['feedback'].append({'slot': slot, 'source_hash': digest, 'target': 'checkin'})
            deck.append({'stream': 'checkin', 'slot': slot})
            mapping.append({'card_idx': idx, 'original_checkin_ordinal': ordinal,
                            'insert_after_card_idx': card['card_idx'], 'kind': 'checkin'})
    for ordinal, q in enumerate(practice, 1):
        local_id = f'p{ordinal:06d}'
        slot = 'practice:'+local_id
        fmt = q.get('format')
        projection = question_projection(q, fmt, slot)
        digest = projection['source_hash']
        streams['practice'].append(projection)
        descriptors['practice'].append({'slot': slot, 'source_hash': digest,
            'source': {'question_id': local_id, 'format': fmt, 'source_question_hash': digest},
            'english_answer_key': {k: deepcopy(q[k]) for k in ANSWER_FIELDS if k in q},
            'english_options': deepcopy(projection['options'])})
        streams['feedback'].append({'slot': slot, 'source_hash': digest, 'kind': 'practice',
            'explanation_why': q.get('explanation_why', ''), 'correct_answer_line': correct_line(fmt, q)})
        descriptors['feedback'].append({'slot': slot, 'source_hash': digest, 'target': 'practice'})
    # Source fingerprint follows array order; pack ordering is source idx order.
    for c in revision:
        for face in ('question', 'answer'):
            if not isinstance(c.get(face), dict):
                raise ValueError('Revise faces must be objects')
            text_fields(c[face], ('display', 'audio'), 'Revise face')
    fingerprint = revise_hash(revision)
    for c in sorted(revision, key=lambda x: x['idx']):
        slot = f'revise:{c["idx"]}'
        streams['revise'].append({'slot': slot, 'source_hash': fingerprint, 'idx': c['idx'],
            **{f: {k: c[f][k] for k in ('display', 'audio')} for f in ('question', 'answer')}})
        descriptors['revise'].append({'slot': slot, 'source_hash': fingerprint, 'source': {
            'idx': c['idx'], 'source_deck_fingerprint': fingerprint,
            'source_input_sha256': bundle['file_identity']['revise']['sha256'],
            'source_card_idxs_space': 'R5 input-local teaching indices; no inferred R6 card identity',
            **{k: deepcopy(c[k]) for k in ('concept_key', 'section_key', 'section_seq', 'source_card_idxs') if k in c}}})
    return {'streams': streams, 'descriptors': descriptors, 'deck_order': deck, 'index_map': mapping,
            'revise_fingerprint': fingerprint}
