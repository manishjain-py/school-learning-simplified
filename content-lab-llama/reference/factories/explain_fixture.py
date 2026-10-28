"""Explicit non-curricular synthetic responses, never a substitute lesson."""
MARKER = 'SYNTHETIC PLUMBING ONLY — NOT MODEL OR CURRICULUM OUTPUT'


def output(role):
    if role in ('explain_writer_1', 'explain_writer_2', 'explain_winner_revision', 'explain_prose_final'):
        return {'artifact': f'## {MARKER}\n\n{role}: sentinel text.\n',
                'dispositions': [{'id': 'c1', 'index': 0, 'action': 'declined', 'reason': MARKER}], 'note': MARKER}
    if role == 'explain_selection':
        return {'winner_index': 2, 'concerns': [{'id': 'c1', 'quote': 'sentinel text.',
                'severity': 'critical', 'issue': MARKER}], 'note': MARKER}
    if role == 'explain_research':
        return {'artifact': {'topic': MARKER, 'no_real_misconceptions': True, 'candidates': [],
                'notes': MARKER+'; no fresh web research; sentinel input has no genuine misconceptions.'}}
    if role == 'explain_arc':
        return {'artifact': {'topic': MARKER, 'arc': [{'move': 1, 'goal': MARKER, 'particulars': MARKER}],
                'misconceptions': [], 'core_objectives': [MARKER], 'secondary_objectives': [],
                'coverage_map': {MARKER: [1]}, 'analogy_thread': None, 'design_note': MARKER}}
    if role in ('explain_clarity_flow', 'explain_accuracy', 'explain_language_economy'):
        return {'ok': False, 'findings': [{'quote': 'sentinel text.', 'lens': role[8:],
                'severity': 'critical', 'issue': MARKER, 'suggested_fix': MARKER}], 'note': MARKER}
    if role in ('explain_split', 'explain_split_final'):
        cards = [{'card_idx': i, 'card_type': 'welcome' if i == 1 else 'summary' if i == 12 else 'concept',
                  'title': MARKER+f' {i}', 'lines': [{'display': MARKER, 'audio': MARKER}],
                  'visual': None, 'section_key': 'sentinel-a' if i <= 6 else 'sentinel-b',
                  'section_seq': 1 if i <= 6 else 2} for i in range(1, 13)]
        return {'artifact': {'cards': cards, 'summary': {'key_analogies': [], 'key_examples': [],
                'teaching_notes': MARKER+' '+role}}, 'dispositions': [], 'note': MARKER}
    if role == 'explain_split_review':
        return {'ok': False, 'findings': [{'card_idx': 3, 'issue': MARKER,
                'evidence': MARKER, 'fix': MARKER}], 'note': MARKER}
    if role in ('explain_checkins', 'explain_checkins_final'):
        activities = []
        for position, light in ((3, 'pick_one'), (7, 'fill_blank'), (11, 'true_false')):
            for activity_type in (light, 'multi_select'):
                item = {'insert_after_card_idx': position, 'activity_type': activity_type, 'title': MARKER,
                        'instruction': MARKER, 'hint': MARKER, 'success_message': MARKER, 'audio_text': MARKER}
                if activity_type == 'true_false':
                    item.update(statement=MARKER, correct_answer=False)
                else:
                    item['options'] = [MARKER+' A', MARKER+' B', MARKER+' C']
                    item.update({'correct_indices': [0, 2]} if activity_type == 'multi_select' else {'correct_index': 1})
                activities.append(item)
        return {'artifact': {'check_ins': activities}, 'dispositions': [], 'note': MARKER+' '+role}
    if role == 'explain_checkin_review':
        return {'wrong': [{'insert_after_card_idx': 3, 'activity_type': 'pick_one', 'problem': MARKER,
                         'fix': MARKER}], 'holistic_pass': False,
                'holistic_issues': [{'insert_after_card_idx': 7, 'dimension': 'coverage', 'issue': MARKER}],
                'comment': MARKER}
    raise ValueError('Unknown Explain fixture role')
