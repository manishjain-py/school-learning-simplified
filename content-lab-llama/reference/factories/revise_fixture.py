"""Deliberately non-curricular sentinels for the actual Revise graph."""
import json

MARKER = 'SYNTHETIC PLUMBING ONLY — NOT MODEL OR CURRICULUM OUTPUT'


def payload(request):
    text = request['messages'][0]['content'][0]['text']
    return json.loads(text.split('Declared task data:\n', 1)[1])['task_inputs']


def output(role, request):
    data = payload(request)
    if role == 'revise_select':
        sections = data['guideline']['sections']
        return {'artifact': {'concepts': [
            {'concept_key': f'sentinel-{i}', 'section_key': sections[min(i-1, len(sections)-1)]['section_key'],
             'section_seq': min(i, len(sections)), 'gist': MARKER,
             'source_card_idxs': [i]} for i in range(1, len(data['explain_deck']['cards'])+1)]}, 'note': MARKER}
    if role in ('revise_author_a', 'revise_author_b'):
        label = 'A' if role.endswith('_a') else 'B'
        return {'artifact': {'cards': [
            {'idx': i, 'question': {'display': f'{MARKER} {label} {i}?', 'audio': f'{MARKER} {label} {i}?'},
             'answer': {'display': MARKER, 'audio': MARKER},
             **{k: c[k] for k in ('source_card_idxs', 'concept_key', 'section_key', 'section_seq')}}
            for i, c in enumerate(data['concepts']['concepts'], 1)]},
            'note': 'PRIVATE_AUTHOR_NOTE_'+label+' '+MARKER}
    if role == 'revise_selection':
        return {'winner': 'tie', 'margin': 'slight', 'reasons': [MARKER]}
    if role in ('revise_lightness', 'revise_accuracy'):
        lens = role[7:]
        return {'findings': [{'card_idx': 1, 'lens': lens, 'severity': 'major',
            'issue': MARKER+' '+lens, 'evidence': MARKER, 'suggested_fix': MARKER}], 'ok': False}
    if role == 'revise_easy_english':
        return {'findings': []}
    if role == 'revise_final':
        # Deliberate short imperfect final artifact and declined feedback exercise
        # final-author ownership; never a claim that a production validator passed.
        card = {**data['deck']['cards'][0], 'answer': {'display': MARKER+' FINAL', 'audio': MARKER+' FINAL'}}
        return {'artifact': {'cards': [card]}, 'cards_changed': [1], 'notes': MARKER,
            'dispositions': [{'index': f['index'], 'action': 'declined', 'reason': MARKER}
                             for f in data['indexed_findings']]}
    raise ValueError('Unsupported synthetic Revise role')
