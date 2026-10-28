"""Generalized new LangGraph path using the attributed, frozen G1 prompts."""
import json
from typing import TypedDict
from langgraph.graph import StateGraph, START, END
from ..inputs import ROOT, strict_json

NAME = 'guideline'
REQUIRED_METADATA = ('grade', 'subject', 'chapter_title')
FILE_INPUTS = ('context',)  # Optional explicitly supplied educational JSON or text.
ROLES = ('draft_1', 'draft_2', 'selection', 'coverage', 'accuracy', 'structure', 'revision', 'refresher')
PROMPTS = {'draft_1': 'chapter_extractor', 'draft_2': 'chapter_extractor', 'selection': 'chapter_judge',
           'coverage': 'lens_coverage', 'accuracy': 'lens_accuracy', 'structure': 'lens_structure',
           'revision': 'chapter_refiner', 'refresher': 'refresher_extractor'}


def request(run, role, declared, batch, notes, final):
    prompt = (ROOT/'prompts'/f'{PROMPTS[role]}.md').read_text()
    # No audience invention or historical fixed chapter/page wrapper.
    prompt = prompt.replace('{grade}', str(run.bundle['metadata']['grade']))
    if not final:
        prompt += ('\nThis is an inspection batch within this same role. Inspect only the attached original pages. '
            'Return ONLY {"page_notes":[{"printed_page": <supplied integer or string label>, "observations": "your bounded observations and uncertainties"}]} '
            'with one entry per currently attached page, at most 1200 words total. Do not produce final role output yet. '
            'Earlier role-local notes are your own observations, not original images. This turn contract overrides the usual output contract.')
    else:
        prompt += ('\nReturn only one JSON object. Authors return {"artifact": <complete requested JSON>, ...audit fields}. '
            'Selection returns winner_index using the explicit candidate index. Reviews return their feedback object. '
            'Prior role-local page notes, if present, are YOUR OWN direct observations from this same role. '
            'You now see the remaining originals; use the full sequential context. Do not claim simultaneous access. '
            'Metadata defines grade, language and audience; do not assume an audience absent from it. '
            'The final revision is authoritative; do not require a later quality gate.')
    payload = {'metadata': run.bundle['metadata'], 'source_printed_pages': [p['printed_page'] for p in run.bundle['pages']],
               'task_inputs': declared, 'role_local_page_notes': notes}
    content = [{'text': prompt+'\nDeclared task data:\n'+json.dumps(payload, ensure_ascii=False)}]
    for page in batch:
        content.extend([{'text': f'Original printed page {page["printed_page"]}:'},
                        {'image': {'format': page['format'], 'source': {'bytes': run.blobs[page['file']]}}}])
    return {'messages': [{'role': 'user', 'content': content}]}


def parse(role, text, notes_pages=None):
    value = strict_json(text)
    if not isinstance(value, dict):
        raise ValueError('Role response must be a JSON object')
    if notes_pages is not None:
        notes = value.get('page_notes')
        if not isinstance(notes, list) or [n.get('printed_page') for n in notes if isinstance(n, dict)] != notes_pages:
            raise ValueError('Missing ordered current-page notes')
        if not all(isinstance(n.get('observations'), str) and n['observations'].strip() for n in notes):
            raise ValueError('Missing page observations')
    elif role in ('draft_1', 'draft_2', 'revision', 'refresher'):
        if not isinstance(value.get('artifact'), dict):
            raise ValueError('Missing JSON artifact envelope; no content invented or moved')
    elif role == 'selection':
        if type(value.get('winner_index')) is not int or value['winner_index'] not in (1, 2):
            raise ValueError('Selection needs candidate index 1 or 2')
    # Structural observations are advisory, including missing review fields.
    return value


def selected(run):
    selection = run.output('selection')
    index = selection.get('winner_index')
    if index not in (1, 2) or 'artifact' not in run.output(f'draft_{index}'):
        raise ValueError('No usable selected draft')
    return run.output(f'draft_{index}')['artifact']


def declared(run, role):
    context = run.bundle['declared']
    if role.startswith('draft'):
        return context.copy()  # independent calls: neither sees another draft or notes
    if role == 'selection':
        candidates = [{'index': index, 'draft': run.output(f'draft_{index}')['artifact']}
                      for index in (1, 2) if 'artifact' in run.output(f'draft_{index}')]
        if not candidates:
            raise ValueError('No usable draft for selection')
        return {**context, 'candidates': candidates}
    if role in ('coverage', 'accuracy', 'structure'):
        return {**context, 'selected_draft': selected(run)}
    if role == 'revision':
        return {**context, 'selected_draft': selected(run), 'selection_feedback': run.output('selection'),
                'reviews': {name: run.output(name) for name in ('coverage', 'accuracy', 'structure')}}
    final = run.output('revision')
    if 'artifact' not in final:
        raise ValueError('Final author artifact unavailable')
    return {**context, 'final_chapter': final['artifact']}


def graph(run):
    class State(TypedDict):
        last_role: str
    flow = StateGraph(State)
    previous = START
    for role in ROLES:
        def node(state, role=role):
            # Dependency failures do not masquerade as content output.
            run.role(role, declared(run, role))
            if role == 'revision':
                run.export(role, 'guideline.json')
            elif role == 'refresher':
                run.export(role, 'refresher-guideline.json')
            return {'last_role': role}
        flow.add_node(role, node)
        flow.add_edge(previous, role)
        previous = role
    flow.add_edge(previous, END)
    return flow.compile()


def observations(results):
    notes = ['No post-author content-quality gate ran. Returned envelopes and artifact fields are preserved.',
             'JSON/transport failures stop or leave partial evidence; automatic format/truncation recovery is not implemented.']
    for role in ('coverage', 'accuracy', 'structure'):
        output = results.get(role, {}).get('output', {})
        if output.get('ok') is False:
            notes.append(f'{role} returned ok:false; this remains advisory feedback, not a later veto.')
    for role, field in (('revision', 'sections'), ('refresher', 'topic_summary')):
        output = results.get(role, {}).get('output', {})
        if output and field not in output.get('artifact', {}):
            notes.append(f'{role}: artifact lacks {field}; preserved without repair. Envelope may contain additional fields.')
    return notes
