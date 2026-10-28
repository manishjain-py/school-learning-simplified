"""Deliberately synthetic moving marks. Never curriculum or live Llama evidence."""
import json
MARKER = 'SYNTHETIC PLUMBING ONLY — NOT MODEL OR CURRICULUM OUTPUT'


def payload(request):
    return json.loads(request['messages'][0]['content'][0]['text'].split('Declared task data:\n', 1)[1])['task_inputs']


def output(role, request):
    data = payload(request)
    if role.endswith('_review'):
        return {'ok': False, 'findings': [MARKER+' deliberate negative fixture review; retained without veto'], 'note': MARKER}
    if role == 'visuals_decide':
        return {'artifact': {'decisions': [{'card_idx': t['card']['card_idx'],
                    'decision': 'svg_illustration' if t['mode'] == 'svg' else 'animated_visual',
                    'reason': MARKER} for t in data['targets']], 'interactive_candidates': [
                        {'card_idx':t['card']['card_idx'],'kind':'slider','param':'mark','why':MARKER}
                        for t in data['targets'] if t['mode']=='interactive']}, 'note': MARKER}
    card, final = data['card'], role.endswith('_final')
    if role.startswith('boards_'):
        plan = {'card_idx': card['card_idx'], 'route': 'board', 'rationale': MARKER,
                'nodes': [{'id': 'box', 'type': 'rect', 'x': 150, 'y': 220, 'width': 680, 'height': 260,
                           'stroke': '#17494d', 'stroke_width': 5, 'fill': 'none'},
                          {'id': 'label', 'type': 'text', 'x': 230, 'y': 330, 'text': 'SYNTHETIC FINAL' if final else 'SYNTHETIC',
                           'font_size': 46, 'stroke': '#17494d', 'fill': '#17494d'}],
                'beats': [{'id': 'draw-box', 'line': 0, 'phrase': 'SYNTHETIC', 'action': 'draw', 'targets': ['box']},
                          {'id': 'draw-label', 'line': 0, 'phrase': 'PLUMBING', 'action': 'draw', 'targets': ['label']},
                          {'id': 'focus-box', 'line': 0, 'phrase': 'OUTPUT', 'action': 'emphasize', 'targets': ['box'], 'hold_ms': 300}],
                'needs': []}
        artifact = plan
    else:
        explanation = {'title': MARKER, 'visual_summary': MARKER, 'visual_spec': 'Moving synthetic square; no lesson.',
                       'layout_warning': False}
        if data['mode'] == 'svg':
            explanation.update(medium='svg_illustration', source_medium='illustration', adaptation='locally_authored_svg',
                svg_source='<svg xmlns="http://www.w3.org/2000/svg" width="500" height="350" viewBox="0 0 500 350">'
                           '<rect x="70" y="80" width="360" height="190" rx="12" fill="'+('#d5f5e3' if final else '#e8f0fe')+'"/>'
                           '<text x="110" y="180" font-family="sans-serif" font-size="26">SYNTHETIC '+('FINAL' if final else 'DRAFT')+'</text></svg>')
        else:
            explanation.update(output_type='animated_visual', duration_ms=1000, pixi_code='''
const square = new PIXI.Graphics().rect(0,0,70,70).fill(%s);
app.stage.addChild(square);
let value=0;
globalThis.renderAt=(t_ms)=>{square.x=40+(t_ms%%1500)/8+value*100;square.y=110;};
globalThis.setParam=(name,next,grabbed)=>{if(name==='mark')value=Number(next);};
globalThis.renderAt(0);
''' % ('0x17494d' if final else '0x4375bb'))
            if data.get('interactive_revision'):
                explanation['interactive'] = {'type': 'slider', 'param': 'mark', 'x': 40, 'y': 310, 'width': 300,
                                               'min': 0, 'max': 1, 'step': .1, 'label': 'Synthetic mark'}
        artifact = {'visuals': [{'card_idx': card['card_idx'], 'expected_card_type': card['card_type'],
                                 'expected_title': card['title'], 'visual_explanation': explanation}]}
    return {'artifact': artifact, 'note': MARKER,
            'dispositions': [{'action': 'declined', 'reason': MARKER+' fixture disagreement retained'}] if final else []}
