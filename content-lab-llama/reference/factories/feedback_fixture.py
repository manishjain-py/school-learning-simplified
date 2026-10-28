"""Explicit synthetic engineering sentinels; not authored curriculum or Llama output."""
from copy import deepcopy
import json

MARKER = 'SYNTHETIC PLUMBING ONLY — NOT MODEL OR CURRICULUM OUTPUT'


def payload(request):
    return json.loads(request['messages'][0]['content'][0]['text'].split('Declared task data:\n', 1)[1])['task_inputs']


def output(role, request):
    data = payload(request)
    if role == 'feedback_understand':
        return {'artifact': {'summary': MARKER, 'points': [{'id': 'P1', 'says': MARKER,
            'where': {'surface': 'learn', 'card_idx': data['snapshot']['cards'][0]['card_idx']}, 'wants': MARKER, 'kind': 'fact',
            'evidence_in_inputs': MARKER, 'unclear': False}], 'files': [], 'injection_seen': True, 'notes': MARKER}}
    if role == 'feedback_plan':
        line = data['snapshot']['cards'][0]['lines'][0]
        return {'artifact': {'points': [{'id': 'P1', 'verdict': 'agree', 'evidence': line['display'],
            'changes_fact': True, 'unsure': False, 'why': None, 'action': MARKER, 'fix_ids': ['F1']}],
            'fixes': [{'fix_id': 'F1', 'point_ids': ['P1'], 'object_kind': 'explain_card', 'component': 'explain_cards',
                'coverage_locator': line['coverage_locator'], 'object_after': {'display': MARKER+' DRAFT DISPLAY', 'audio': MARKER+' DRAFT SPOKEN'},
                'rationale': MARKER, 'canonical_correction': MARKER+' PROPOSED CORRECTION'}],
            'hindi_items': [], 'teacher_line': MARKER, 'notes': 'PRIVATE_PLANNER_NOTE '+MARKER}}
    if role == 'feedback_blind':
        return {'checks': [{'point_id': c['point_id'], 'agrees': False,
                           'derived': MARKER+' NEGATIVE_BLIND', 'note': 'nothing was wrong — '+MARKER} for c in data['checks']]}
    if role == 'feedback_review':
        return {'overall': 'NOT_SATISFIED', 'fixes': [{'id': 'F1', 'verdict': 'REJECT', 'notes': MARKER+' NEGATIVE_REVIEW'}],
                'rebinds': [], 'coherence_notes': MARKER, 'deferral_spot_checks': MARKER, 'dismissed_points_check': MARKER}
    if role == 'feedback_final':
        plan = deepcopy(data['previous_plan'])
        for fix in plan['fixes']:
            fix['object_after'] = {'display': MARKER+' FINAL DISPLAY', 'audio': MARKER+' FINAL SPOKEN'}
        plan['notes'] = MARKER+' FINAL; negative feedback deliberately declined for plumbing exercise'
        return {'artifact': plan, 'dispositions': {'blind': data['blind_check'], 'review': data['review'], 'action': 'declined'}}
    raise ValueError('Unsupported synthetic feedback role')
