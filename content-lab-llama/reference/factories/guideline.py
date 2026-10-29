"""Generalized new LangGraph path using the attributed, frozen G1 prompts."""
import json
from types import SimpleNamespace
from typing import TypedDict
from langgraph.graph import StateGraph, START, END
from ..inputs import ROOT, canonical, frozen_inputs, read, sha, strict_json

NAME = 'guideline'
REQUIRED_METADATA = ('grade', 'subject', 'chapter_title')
FILE_INPUTS = ('context',)  # Optional explicitly supplied educational JSON or text.
ROLES = ('draft_1', 'draft_2', 'selection', 'coverage', 'accuracy', 'structure', 'revision', 'refresher')
COMPLETION_CONTRACT = 'guideline-final-outputs-v1'
FINAL_EXPORTS = {'revision': 'guideline.json', 'refresher': 'refresher-guideline.json'}
PROMPTS = {'draft_1': 'chapter_extractor', 'draft_2': 'chapter_extractor', 'selection': 'chapter_judge',
           'coverage': 'lens_coverage', 'accuracy': 'lens_accuracy', 'structure': 'lens_structure',
           'revision': 'chapter_refiner', 'refresher': 'refresher_extractor'}


def request(run, role, declared, batch, notes, final):
    prompt = (ROOT/'prompts'/f'{PROMPTS[role]}.md').read_text()
    # No audience invention or historical fixed chapter/page wrapper.
    prompt = prompt.replace('{grade}', str(run.bundle['metadata']['grade']))
    current_pages = [p['printed_page'] for p in batch]
    prompt += ('\nsource_printed_pages lists the whole source for provenance. '
        'current_batch_printed_pages lists only the originals attached to this request, in attachment order. '
        'Page labels retain their supplied JSON integer or string types.')
    if not final:
        prompt += ('\nThis is an inspection batch within this same role. Inspect only the attached original pages. '
            'Return ONLY {"page_notes":[{"printed_page": <supplied integer or string label>, "observations": "your bounded observations and uncertainties"}]} '
            'with exactly one entry per current_batch_printed_pages label in this exact order: '
            +json.dumps(current_pages, ensure_ascii=False)+'. Copy each label and its JSON type exactly. '
            'Do not include absent, not-yet-attached or previously noted pages in page_notes. '
            'Use at most 1200 words total. Do not produce final role output yet. '
            'Earlier role-local notes are your own observations, not original images. This turn contract overrides the usual output contract.')
    else:
        prompt += ('\nPrior role-local page notes, if present, are YOUR OWN direct observations from this same role. '
            'You now see the remaining originals; use the full sequential context. Do not claim simultaneous access. '
            'Metadata defines grade, language and audience; do not assume an audience absent from it. '
            'The final revision is authoritative; do not require a later quality gate.')
    payload = {'metadata': run.bundle['metadata'], 'source_printed_pages': [p['printed_page'] for p in run.bundle['pages']],
               'current_batch_printed_pages': current_pages, 'task_inputs': declared, 'role_local_page_notes': notes}
    content = [{'text': prompt+'\nDeclared task data:\n'+json.dumps(payload, ensure_ascii=False)}]
    for page in batch:
        content.extend([{'text': f'Original printed page {page["printed_page"]}:'},
                        {'image': {'format': page['format'], 'source': {'bytes': run.blobs[page['file']]}}}])
    if final:
        contract = ('Final output contract:\nReturn one complete strict JSON object, with no surrounding prose, '
                    'comments or trailing commas. ')
        if role in ('draft_1', 'draft_2', 'revision', 'refresher'):
            native = 'refresher' if role == 'refresher' else 'chapter'
            contract += (f'Return the complete requested native {native} JSON as the object-valued artifact field. '
                f'The earlier native {native} shape and examples describe the VALUE of artifact, not the response root. '
                'Syntax-only envelope illustration:\n{"artifact": {}}\n'
                'The empty object illustrates nesting only: replace it with the complete requested native artifact, '
                'including all its fields; do not return an empty or template response. '
                'Keep any separately requested author audit fields beside artifact.')
        elif role == 'selection':
            indices = [candidate['index'] for candidate in declared['candidates']]
            contract += ('Return winner_index as a JSON integer copied from the explicit index of the chosen '
                'task_inputs.candidates entry. Available candidate indices: '+json.dumps(indices)+'. '
                'Preserve the original index; do not renumber candidates. '
                'Return scores, concerns and note as requested by the source role alongside winner_index. '
                'Do not use an artifact envelope.')
        else:
            contract += ('Return the source lens feedback object directly, with ok, findings and note in the '
                'source role\'s shape and meaning. Do not use an artifact envelope. '
                'Feedback remains advisory for the final author; it does not veto the final revision.')
        content.append({'text': contract})
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


def export_evidence(workspace, role, result):
    artifact = result['output']['artifact']
    if result['status'] != 'ok' or not isinstance(artifact, dict):
        raise ValueError('Final author object unavailable')
    path = workspace/'artifacts'/FINAL_EXPORTS[role]
    if canonical(read(path)) != canonical(artifact):
        raise ValueError('Final author export differs from checkpoint')
    return {'status': 'intact', 'checkpoint': role, 'file': FINAL_EXPORTS[role],
            'artifact_sha256': sha(canonical(artifact)), 'file_sha256': sha(path.read_bytes())}


def report_completion(workspace, identity, ledger, results):
    """Guideline-only operational rule, opted into by NEW frozen identities.

    Reconstruct requests offline to check image/selection/review dependencies. Never
    create a provider, reinterpret failed replies, repair exports or mutate evidence.
    Legacy identities keep the report's original all-final-roles rule.
    """
    if 'completion_contract' not in identity:
        return {}
    blocked, checkpoints, outputs = [], {}, {}
    def block(reason):
        blocked.append(reason)
    if identity['completion_contract'] != COMPLETION_CONTRACT:
        block('unsupported_completion_contract')
    try:
        bundle, blobs = frozen_inputs(workspace)
        if identity['factory'] != NAME or bundle['factory'] != NAME:
            block('factory_identity')
        if sha(canonical(bundle)) != identity['input_sha256']:
            block('frozen_input_identity')
        if ledger['config'] != identity['config']:
            block('ledger_config_identity')
        limit = identity['config']['image_limit']
        batches = [bundle['pages'][i:i+limit] for i in range(0, len(bundle['pages']), limit)] or [[]]
        def output(role):
            result = results.get(role, {})
            return (result['output'] if result.get('status') == 'ok' else
                    {'technical_failure': {'role': role, 'status': 'unavailable'}})
        view = SimpleNamespace(bundle=bundle, blobs=blobs, output=output)
        calls = ledger['calls']
        expected = set()
        for role in ROLES:
            notes, stopped = [], False
            for index, batch in enumerate(batches):
                final = index == len(batches)-1
                key = role if final else f'{role}__batch_{index+1}'
                expected.add(key)
                matches = [c for c in calls if c['key'] == key]
                result = results.get(key)
                if not matches and result is None:
                    checkpoints[key] = 'not_executed_after_failure' if stopped else 'unavailable'
                    if not stopped:
                        block('unexplained_missing_request:'+key)
                    continue
                checkpoints[key] = result.get('status', 'invalid') if result else 'interrupted_without_checkpoint'
                try:
                    if stopped or len(matches) != 1 or result is None:
                        raise ValueError('Unexpected or interrupted request')
                    call = matches[0]
                    if (call['role'] != role or call.get('checkpoint_sha256') != sha(canonical(result)) or
                            result['status'] not in ('ok', 'failed') or
                            call['status'] not in ('response', 'ambiguous_or_rejected') or
                            result['status'] == 'ok' and call['status'] != 'response'):
                        raise ValueError('Checkpoint/ledger identity')
                    saved_request = read(workspace/'requests'/f'{key}.json')
                    if call['request_sha256'] != sha(canonical(saved_request)):
                        raise ValueError('Saved request identity')
                    request_value = request(view, role, declared(view, role), batch, notes, final)
                    evidence = json.loads(json.dumps(request_value, default=lambda data: {'sha256': sha(data), 'bytes': len(data)}))
                    if canonical(evidence) != canonical(saved_request):
                        raise ValueError('Request/dependency identity')
                    if result['status'] == 'ok':
                        parsed = parse(role, json.dumps(result['output'], ensure_ascii=False, allow_nan=False),
                                       None if final else [p['printed_page'] for p in batch])
                        if not final:
                            notes.extend(parsed['page_notes'])
                    else:
                        stopped = True
                except (ValueError, RuntimeError, OSError, KeyError, TypeError):
                    if result is not None:
                        checkpoints[key] = 'evidence_mismatch'
                    block('request_checkpoint_identity:'+key)
        unexpected = (set(results) | {c['key'] for c in calls}) - expected
        if unexpected:
            for key in unexpected:
                checkpoints[key] = results.get(key, {}).get('status', 'interrupted_without_checkpoint')
            block('unexpected_request_or_checkpoint')
        selection = output('selection').get('winner_index')
        if type(selection) is not int or selection not in (1, 2):
            block('usable_selection_required')
        else:
            required = (f'draft_{selection}', 'selection', 'revision', 'refresher')
            for role in required:
                for index in range(len(batches)):
                    key = role if index == len(batches)-1 else f'{role}__batch_{index+1}'
                    if checkpoints.get(key) != 'ok':
                        block('required_author_dependency:'+key)
            if not isinstance(output(f'draft_{selection}').get('artifact'), dict):
                block('usable_selected_draft_required')
    except (ValueError, RuntimeError, OSError, KeyError, TypeError):
        block('frozen_evidence_unavailable')
    execution_complete = not blocked and checkpoints and all(s == 'ok' for s in checkpoints.values())
    for role in FINAL_EXPORTS:
        try:
            outputs[role] = export_evidence(workspace, role, results[role])
        except (ValueError, OSError, KeyError, TypeError):
            outputs[role] = {'status': 'unavailable_or_changed', 'checkpoint': role, 'file': FINAL_EXPORTS[role]}
            block('final_export_required:'+role)
    return {'completion_contract': identity['completion_contract'],
            'status': 'partial_or_failed' if blocked else 'complete',
            'role_execution_status': 'complete' if execution_complete else 'partial_or_failed',
            'checkpoint_statuses': checkpoints, 'final_outputs': outputs,
            'completion_basis': 'Intact selected draft, selection, required image inspections and final author exports; other durable technical failures disclosed. No content-quality or downstream-compatibility guarantee.',
            'completion_blockers': sorted(set(blocked))}


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
