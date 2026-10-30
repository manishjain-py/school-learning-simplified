"""Explicitly synthetic responses; plumbing only, never Hindi quality evidence."""
import json
MARKER = 'SYNTHETIC PLUMBING ONLY — NOT MODEL OR CURRICULUM OUTPUT'


def payload(request):
    return json.loads(request['messages'][0]['content'][0]['text'].split('Declared task data:\n', 1)[1])['task_inputs']


def output(role, request):
    data = payload(request)
    stream = data['stream']
    phase = role.rsplit('_', 1)[1]
    if phase == 'review':
        return {'verdicts': [{'slot': s['slot'], 'pass': False, 'reason': MARKER+' negative review'} for s in data['items']],
                'batch_issues': [MARKER+' deliberate disagreement']}
    if phase == 'final':
        # Change final text, decline every negative verdict, keep full fixed slots.
        artifact = json.loads(json.dumps(data['draft']))
        for item in artifact['items']:
            if stream == 'teaching': item['title_display'] = 'अंतिम '+MARKER
            elif stream in ('checkin', 'practice'): item['question_display'] = 'अंतिम '+MARKER
            elif stream == 'feedback':
                for f in ('explanation_display', 'hint_display', 'success_display', 'reveal_display'):
                    if f in item: item[f] = 'अंतिम '+MARKER
            else: item['answer']['display'] = 'अंतिम '+MARKER
        if stream == 'teaching':
            return teaching_wire(artifact, data['wire_fields'])
        return {'artifact': artifact, 'dispositions': [{'slot': v['slot'], 'action': 'declined', 'reason': MARKER}
                                                      for v in data['review']['verdicts']], 'note': MARKER}
    items = []
    for source in data['items']:
        row = {'slot': source['slot']}
        if stream == 'teaching':
            row.update(title_display='नमूना '+MARKER, lines=[{'display': 'नमूना '+MARKER, 'audio': 'नमूना '+MARKER} for _ in source['lines']])
        elif stream in ('checkin', 'practice'):
            row.update(question_display='नमूना '+MARKER, question_audio='नमूना '+MARKER,
                options_display=['नमूना '+str(i) for i, _ in enumerate(source['options'])],
                options_audio=['नमूना '+str(i) for i, _ in enumerate(source['options'])])
        elif stream == 'feedback':
            if source['kind'] == 'practice':
                row.update(explanation_display='नमूना '+MARKER, correct_answer_display='नमूना '+MARKER)
            else:
                for src, dst in (('hint', 'hint'), ('success_message', 'success'), ('reveal_text', 'reveal')):
                    if src in source:
                        row[dst+'_display'] = row[dst+'_audio'] = 'नमूना '+MARKER
        else:
            row.update(question={'display': 'नमूना '+MARKER, 'audio': 'नमूना '+MARKER},
                       answer={'display': 'नमूना '+MARKER, 'audio': 'नमूना '+MARKER})
        items.append(row)
    return {'artifact': {'schema_version': 2, 'items': items}, 'note': MARKER}


def teaching_wire(artifact, fields):
    """Synthetic provider encoder; the real parser still requires the flat wire."""
    values = {}
    by_slot = {item['slot']: item for item in artifact['items'] if isinstance(item.get('slot'), str)}
    for field in fields:
        item = by_slot.get(field['slot'])
        if item is None:
            continue
        if 'line_index' in field:
            lines = item.get('lines', [])
            if not isinstance(lines, list) or field['line_index'] >= len(lines):
                continue
            item = lines[field['line_index']]
        if field['field'] in item:
            values[field['key']] = item[field['field']]
    # Preserve synthetic native identity/line defects as invalid wire evidence,
    # rather than silently manufacturing a valid subset for test interceptors.
    if len(by_slot) != len(artifact['items']) or set(by_slot) != {field['slot'] for field in fields}:
        values['unexpected_slot'] = 'SYNTHETIC INVALID IDENTITY'
    if any(isinstance(item.get('lines'), list) and len(item['lines']) !=
           sum(field['slot'] == item.get('slot') and field['field'] == 'audio' for field in fields)
           for item in artifact['items']):
        values['unexpected_line_count'] = 'SYNTHETIC INVALID LINE COUNT'
    return values
