"""Synthetic sentinels only: exercise quotas, collisions, review locators and final authority."""
from copy import deepcopy
import json

MARKER = 'SYNTHETIC PLUMBING ONLY — NOT MODEL OR CURRICULUM OUTPUT'


def payload(request):
    return json.loads(request['messages'][0]['content'][0]['text'].split('Declared task data:\n')[1])['task_inputs']


def output(role, request):
    data = payload(request)
    if role == 'practice_blueprint':
        sections = data['guideline']['sections']
        skills = [{'skill_key': s['section_key']+'--sentinel', 'section_key': s['section_key'],
            'title': MARKER, 'objective': MARKER, 'what_to_test': MARKER,
            'formats': ['true_false', 'pick_one', 'fill_blank', 'multi_select'],
            'difficulty_notes': {'easy': MARKER, 'medium': MARKER}, 'misconceptions': [],
            'parameter_space': MARKER, 'weight': 2 if i == 0 else 1} for i, s in enumerate(sections)]
        return {'artifact': {'skills': skills, 'digest': {'vocabulary': [MARKER],
            'step_labels': {}, 'methods_conventions': [MARKER], 'contexts_used': [], 'board_titles': [MARKER]},
            'theme_wheel': [MARKER+' A', MARKER+' B']}, 'note': MARKER}
    if role.startswith('practice_slot_'):
        slot = data['quota']
        rows = []
        tiers = ['easy']*slot['difficulty']['easy']+['medium']*slot['difficulty']['medium']
        for i, tier in enumerate(tiers):
            fmt = slot['formats'][i % len(slot['formats'])]
            token = f'{role}-{i}'
            q = {'format': fmt, 'difficulty': tier, 'concept_tag': 'synthetic_sentinel',
                 'question_text': 'SYNTHETIC CAPTION' if fmt == 'true_false' else MARKER+' '+token,
                 'explanation_why': MARKER, 'audio_text': MARKER,
                 'skill_key': slot['skill_key'], 'signature': slot['skill_key']+' | sentinel | '+token+' | fixture', 'params': {}}
            if fmt == 'true_false':
                q.update(statement=MARKER+' statement '+token, correct_answer_bool=False)
            elif fmt == 'multi_select':
                q.update(options=['SYNTHETIC A', 'SYNTHETIC B', 'SYNTHETIC C'], correct_indices=[0, 2])
            else:
                q.update(options=['SYNTHETIC A', 'SYNTHETIC B'], correct_index=0)
            if i == 0 and data['existing_signatures']:
                q['signature'] = data['existing_signatures'][0]  # deliberate pre-final collision
            rows.append(q)
        return {'artifact': {'questions': rows}, 'note': MARKER}
    if role == 'practice_review':
        rows = data['batch']['questions']
        findings = [{'signature': q['signature'], 'question_text': q['question_text'], 'format': q['format'],
            'problem': 'LABEL: '+MARKER, 'fix': q['signature'].replace(' | sentinel | ', ' | revised | ')} for q in rows[:2]]
        return {'wrong': findings, 'holistic_pass': False,
                'holistic_issues': [{'dimension': 'freshness', 'issue': MARKER}], 'comment': MARKER}
    if role == 'practice_final':
        pack = deepcopy(data['batch'])
        if pack['questions']:
            pack['questions'].pop()  # deliberate visible shortfall, no host completion round
        dispositions = []
        for i, finding in enumerate(data['review']['wrong']):
            disposition = {'original_signature': finding['signature'],
                           'action': 'declined' if i else 'fixed', 'reason': MARKER}
            if i == 0:
                matches = [q for q in pack['questions'] if q['signature'] == finding['signature']]
                if len(matches) == 1:
                    matches[0]['signature'] = finding['fix']
            dispositions.append(disposition)
        return {'artifact': pack, 'dispositions': dispositions, 'note': MARKER+'; deliberate shortfall and disagreement.'}
    raise ValueError('Unsupported synthetic Practice role')
