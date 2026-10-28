"""Trusted, deterministic R9 line binding and local-copy application. No inference."""
from copy import deepcopy
from ..inputs import canonical, sha

PACK = 'explain-deck'
LINE_MEDIA = ('audio_url', 'audio_sha256', 'alignment_url', 'audio_synth_at')
CARD_MEDIA = (*LINE_MEDIA, 'visual', 'image_url', 'video_url', 'avatar_url', 'narrated_scene')
AGGREGATES = {'content': ('display', '\n'), 'text': ('display', '\n'), 'audio_text': ('audio', ' ')}


def validate_deck(deck):
    if not isinstance(deck, dict) or not isinstance(deck.get('cards'), list) or not deck['cards']:
        raise ValueError('Feedback requires a native R3 deck with nonempty cards')
    seen = set()
    for card in deck['cards']:
        if not isinstance(card, dict) or type(card.get('card_idx')) is not int or card['card_idx'] < 1 or card['card_idx'] in seen:
            raise ValueError('Deck needs unique positive original card_idx identities')
        seen.add(card['card_idx'])
        if not isinstance(card.get('title'), str) or not isinstance(card.get('card_type'), str):
            raise ValueError('Native cards require title/card_type')
        if not isinstance(card.get('lines'), list) or not all(isinstance(x, dict) and
                all(isinstance(x.get(k), str) for k in ('display', 'audio')) for x in card['lines']):
            raise ValueError('Native lines require separate display/audio strings')
        for obj, key in ((card, 'card_id'), *((line, 'line_id') for line in card['lines'])):
            if key in obj and (not isinstance(obj[key], str) or not obj[key]):
                raise ValueError('Optional source identities must be nonempty strings')


def locator(bundle, card, index):
    line = card['lines'][index]
    result = {'pack': PACK, 'pack_sha256': bundle['file_identity']['deck']['sha256'],
              'card_idx': card['card_idx'], 'line_idx': index, 'line_sha256': sha(canonical(line))}
    if 'card_id' in card:
        result['card_id'] = card['card_id']
    if 'line_id' in line:
        result['line_id'] = line['line_id']
    return result


def snapshot_view(bundle):
    """Only teaching/task fields enter roles; hashes bind unprojected original objects."""
    deck = bundle['declared']['deck']
    validate_deck(deck)
    return {'source_pack': PACK, 'source_pack_sha256': bundle['file_identity']['deck']['sha256'],
        'cards': [{**{k: c[k] for k in ('card_idx', 'card_type', 'title')},
                   **({'card_id': c['card_id']} if 'card_id' in c else {}),
                   'lines': [{'coverage_locator': locator(bundle, c, i), 'display': l['display'], 'audio': l['audio']}
                             for i, l in enumerate(c['lines'])]}
                  for c in deck['cards'] if c['card_type'] != 'check_in']}


def resolve(bundle, loc):
    if not isinstance(loc, dict):
        raise ValueError('Unsupported locator; supply the exact local line locator object')
    if type(loc.get('card_idx')) is not int or type(loc.get('line_idx')) is not int:
        raise ValueError('Original card_idx and zero-based line_idx must be integers')
    cards = bundle['declared']['deck']['cards']
    matches = [(i, c) for i, c in enumerate(cards) if c['card_idx'] == loc['card_idx']]
    if len(matches) != 1:
        raise ValueError('Original card identity not found')
    pos, card = matches[0]
    n = loc['line_idx']
    if card['card_type'] == 'check_in' or not 0 <= n < len(card['lines']):
        raise ValueError('Unsupported check-in or missing original line')
    if loc != locator(bundle, card, n):
        raise ValueError('Locator pack/hash/original identity precondition mismatch')
    return pos, n, card['lines'][n]


def matched_object(bundle, loc):
    try:
        _, _, line = resolve(bundle, loc)
        return {k: line[k] for k in ('display', 'audio')}
    except ValueError:
        return None


def assemble(bundle, proposal):
    """Keep author proposal separately. Assemble only mechanically supported operations."""
    deck = bundle['declared']['deck']
    result = {'schema_version': 2, 'scope': 'local-copy-only', 'production_importable': False,
        'source_pack_sha256': bundle['file_identity']['deck']['sha256'],
        'snapshot_content_hash': sha(canonical(deck)), 'operations': [],
        'unapplied': [], 'compatibility_operations': [], 'unsupported_proposals': []}
    fixes = proposal.get('fixes')
    if not isinstance(fixes, list):
        result['unapplied'].append({'fix_id': None, 'reason': 'Final proposal lacks a fixes array', 'proposal': deepcopy(proposal)})
        return result
    ids = [x.get('fix_id') for x in fixes if isinstance(x, dict)]
    targets = [canonical(x.get('coverage_locator')) for x in fixes if isinstance(x, dict)]
    for fix in fixes:
        try:
            if not isinstance(fix, dict) or not isinstance(fix.get('fix_id'), str) or not fix['fix_id'] or ids.count(fix['fix_id']) != 1:
                raise ValueError('Fix needs a unique nonempty fix_id')
            if fix.get('object_kind') != 'explain_card' or fix.get('component') != 'explain_cards':
                raise ValueError('Unsupported surface; only existing Learn lines are implemented')
            if targets.count(canonical(fix.get('coverage_locator'))) != 1:
                raise ValueError('Conflicting fixes target the same line; no order guessed')
            pos, n, before = resolve(bundle, fix.get('coverage_locator'))
            after = fix.get('object_after')
            if not isinstance(after, dict) or set(after) != {'display', 'audio'} or not all(isinstance(v, str) for v in after.values()):
                raise ValueError('Line object_after must contain exactly display/audio strings; identity changes unsupported')
            card = deck['cards'][pos]
            for field, (key, sep) in AGGREGATES.items():
                if field in card and card[field] != sep.join(l[key] for l in card['lines']):
                    raise ValueError('Unsupported existing aggregate convention: '+field)
            full_after = {**deepcopy(before), **deepcopy(after)}
            if any(before[k] != after[k] for k in ('display', 'audio')):
                for key in LINE_MEDIA:
                    if key in full_after:
                        full_after[key] = None
            result['operations'].append({'fix_id': fix['fix_id'], 'coverage_locator': deepcopy(fix['coverage_locator']),
                'object_before': deepcopy(before), 'precondition_content_hash': sha(canonical(before)),
                'object_after': full_after})
        except ValueError as error:
            result['unapplied'].append({'fix_id': fix.get('fix_id') if isinstance(fix, dict) else None,
                'reason': str(error), 'proposal': deepcopy(fix)})
    for field in ('hindi_items', 'pictures', 'new_cards'):
        if proposal.get(field):
            result['unsupported_proposals'].append({'field': field, 'reason': 'Unsupported local surface; preserved without application',
                                                    'proposal': deepcopy(proposal[field])})
    # Compatibility operations are explicit, deterministic and content-free.
    for card in deck['cards']:
        ops = [o for o in result['operations'] if o['coverage_locator']['card_idx'] == card['card_idx'] and o['object_before'] != o['object_after']]
        if not ops:
            continue
        lines = deepcopy(card['lines'])
        for op in ops:
            lines[op['coverage_locator']['line_idx']] = deepcopy(op['object_after'])
        fields = {k: None for k in CARD_MEDIA if k in card and card[k] is not None}
        fields.update({k: sep.join(l[key] for l in lines) for k, (key, sep) in AGGREGATES.items() if k in card})
        for key, value in fields.items():
            if card[key] != value:
                result['compatibility_operations'].append({'card_idx': card['card_idx'], 'field': key,
                    'precondition_card_hash': sha(canonical(card)), 'object_before': deepcopy(card[key]),
                    'object_after': value, 'fix_ids': [o['fix_id'] for o in ops],
                    'reason': 'Rebuild existing text aggregate' if key in AGGREGATES else 'Invalidate media affected by changed text'})
    return result


def apply_changeset(deck, changeset):
    """Apply an assembled set transactionally to a new object, with all preconditions rechecked."""
    copy = deepcopy(deck)
    rejected = deepcopy(changeset.get('unapplied', []))
    unsupported = deepcopy(changeset.get('unsupported_proposals', []))
    applied, compatibility = [], []
    try:
        if changeset.get('schema_version') != 2 or changeset.get('scope') != 'local-copy-only':
            raise ValueError('Not a schema-version2 local-copy-only changeset')
        if sha(canonical(deck)) != changeset.get('snapshot_content_hash'):
            raise ValueError('Snapshot content precondition mismatch')
        seen = set()
        for op in changeset['operations']:
            loc = op['coverage_locator']
            if type(loc.get('card_idx')) is not int or loc.get('pack') != PACK or loc.get('pack_sha256') != changeset['source_pack_sha256']:
                raise ValueError('Operation source pack mismatch')
            cards = [c for c in deck['cards'] if c['card_idx'] == loc['card_idx']]
            if len(cards) != 1 or type(loc.get('line_idx')) is not int or not 0 <= loc['line_idx'] < len(cards[0]['lines']):
                raise ValueError('Operation original identity missing')
            card, n = cards[0], loc['line_idx']
            line = card['lines'][n]
            # Recheck every identity field and full precondition, including optional source ids.
            expected = {'pack': PACK, 'pack_sha256': changeset['source_pack_sha256'], 'card_idx': card['card_idx'],
                        'line_idx': n, 'line_sha256': sha(canonical(line))}
            for key, obj in (('card_id', card), ('line_id', line)):
                if key in obj:
                    expected[key] = obj[key]
            if loc != expected or op['object_before'] != line or op['precondition_content_hash'] != sha(canonical(line)):
                raise ValueError('Operation line precondition mismatch')
            target = (card['card_idx'], n)
            if target in seen:
                raise ValueError('Conflicting local operations')
            seen.add(target)
            after = op['object_after']
            if (set(after) != set(line) or not all(isinstance(after.get(k), str) for k in ('display', 'audio')) or
                    any(after[k] != v for k, v in line.items() if k not in ('display', 'audio', *LINE_MEDIA)) or
                    any(after[k] is not None and after[k] != line[k] for k in LINE_MEDIA if k in after)):
                raise ValueError('Operation changes identity or unsupported fields')
        for op in changeset['compatibility_operations']:
            card = next(c for c in deck['cards'] if c['card_idx'] == op['card_idx'])
            if op['field'] not in (*CARD_MEDIA, *AGGREGATES) or op['precondition_card_hash'] != sha(canonical(card)) or card[op['field']] != op['object_before']:
                raise ValueError('Compatibility precondition mismatch')
        for op in changeset['operations']:
            if op['object_before'] == op['object_after']:
                continue
            card = next(c for c in copy['cards'] if c['card_idx'] == op['coverage_locator']['card_idx'])
            card['lines'][op['coverage_locator']['line_idx']] = deepcopy(op['object_after'])
            applied.append(op['fix_id'])
        for op in changeset['compatibility_operations']:
            card = next(c for c in copy['cards'] if c['card_idx'] == op['card_idx'])
            key = op['field']
            expected = AGGREGATES[key][1].join(l[AGGREGATES[key][0]] for l in card['lines']) if key in AGGREGATES else None
            if op['object_after'] != expected or not set(op['fix_ids']).issubset(applied):
                raise ValueError('Compatibility operation is not a deterministic consequence')
            card[key] = deepcopy(op['object_after'])
            compatibility.append(deepcopy(op))
    except (ValueError, KeyError, TypeError, IndexError, StopIteration) as error:
        copy, applied, compatibility = deepcopy(deck), [], []
        rejected.append({'fix_id': None, 'reason': 'Local transaction unapplied: '+str(error)})
    failed = bool(rejected or unsupported)
    status = ('partial' if applied else 'unapplied') if failed else ('applied' if applied else 'noop')
    return copy, {'scope': 'local-copy-only', 'status': status, 'applied_fix_ids': applied,
                  'unapplied': rejected, 'unsupported_proposals': unsupported, 'compatibility_operations': compatibility,
                  'input_content_hash': sha(canonical(deck)), 'output_content_hash': sha(canonical(copy))}
