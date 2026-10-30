"""Generalized new LangGraph path using the attributed, frozen G1 prompts."""
import json
import math
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
        inspection_contract = ('\nThis is an inspection batch within this same role. Inspect only the attached original pages. '
            'Return ONLY {"page_notes":[{"printed_page": <supplied integer or string label>, "observations": "your bounded observations and uncertainties"}]} '
            'with exactly one entry per current_batch_printed_pages label in this exact order: '
            +json.dumps(current_pages, ensure_ascii=False)+'. Copy each label and its JSON type exactly. '
            'Do not include absent, not-yet-attached or previously noted pages in page_notes. '
            'Use at most 1200 words total. Do not produce final role output yet. '
            'Earlier role-local notes are your own observations, not original images. This turn contract overrides the usual output contract.')
        prompt += inspection_contract
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
    result = {'messages': [{'role': 'user', 'content': content}]}
    if not final:
        result['system'] = [{'text': inspection_contract}]
    elif role == 'refresher':
        result['system'] = [{'text': content[-1]['text']+'\nJSON syntax clarification: Enclose every array item '
            'that is an object in its own opening { and closing }. Put field-name/colon pairs inside '
            'that object, never directly in an array.'}]
    return result


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


def recovery_budget(identity, ledger):
    """Validate the new frozen recovery/accounting contract without any call."""
    from ..providers import validate_config
    from ..runtime import recovery_policy
    config = validate_config(identity['config'])
    current = recovery_policy(config)
    policy = identity.get('technical_recovery')
    if (not isinstance(policy, dict) or type(policy.get('version')) is not int or
            policy not in (current, {**current, 'version': 1}) or
            ledger.get('technical_recovery') != policy):
        raise ValueError('Recovery policy identity')
    paid = config['provider'] == 'bedrock'
    reservation = ((config['input_token_bound']*config['input_per_million'] +
                    config['max_output_tokens']*config['output_per_million'])/1_000_000) if paid else 0
    exposure = 0
    for call in ledger['calls']:
        amount = call['reserved_usd']
        if type(amount) not in (int, float) or not math.isfinite(amount) or amount < 0:
            raise ValueError('Invalid reservation')
        if call.get('synthetic') is not (not paid):
            raise ValueError('Provider accounting identity')
        if paid and (amount != reservation or exposure+reservation > config['cap_usd']):
            raise ValueError('Frozen paid reservation or cumulative cap')
        usage = call.get('usage')
        settled = isinstance(usage, dict) and all(type(usage.get(k)) is int and usage[k] >= 0
                                                for k in ('inputTokens', 'outputTokens'))
        if 'actual_usd' in call:
            actual = ((usage['inputTokens']*config['input_per_million'] +
                       usage['outputTokens']*config['output_per_million'])/1_000_000) if paid and settled else 0
            if (paid and not settled or call['status'] != 'response' or
                    type(call['actual_usd']) not in (int, float) or call['actual_usd'] != actual):
                raise ValueError('Settled usage accounting identity')
            exposure += actual
        else:
            if paid and settled:
                raise ValueError('Settled paid usage missing charge')
            exposure += amount
    return policy


def recovery_evidence(workspace, key, role, original, matches, result, notes_pages, policy):
    """Reconstruct each physical request; preserve the final logical lookup."""
    from ..runtime import model_response_json, recovery_request, request_evidence, technical_feedback
    if not 1 <= len(matches) <= policy['max_additional_attempts']+1:
        raise ValueError('Unexpected recovery attempt count')
    expected_request = original
    previous_response, previous_result = None, None
    root = workspace/'attempts'/key
    if {p.name for p in root.iterdir()} != {f'{n:03d}' for n in range(1, len(matches)+1)}:
        raise ValueError('Unexpected or interrupted physical attempt evidence')
    for number, call in enumerate(matches, 1):
        if type(call.get('attempt')) is not int or call['attempt'] != number or call['role'] != role:
            raise ValueError('Physical attempt order or role identity')
        if number > 1:
            if (previous_result.get('status') != 'failed' or not previous_result.get('retry_eligible') or
                    previous_response is None or previous_response.get('stopReason') != 'end_turn'):
                raise ValueError('Physical retry did not follow a settled technical failure')
            usage = previous_response.get('usage')
            if not isinstance(usage, dict) or not all(type(usage.get(k)) is int and usage[k] >= 0
                                                    for k in ('inputTokens', 'outputTokens')):
                raise ValueError('Physical retry followed unsettled usage')
            raw = ''.join(item.get('text', '') for item in previous_response['output']['message']['content'])
            phase = 'json'
            try:
                text, _ = model_response_json(raw)
                phase = 'native'
                parse(role, text, notes_pages)
            except (ValueError, KeyError, TypeError) as error:
                feedback = technical_feedback(error, phase)
                if previous_result.get('technical_feedback') != feedback:
                    raise ValueError('Technical recovery feedback identity')
            else:
                raise ValueError('Physical retry followed an already usable response')
            expected_request = recovery_request(original, raw, feedback, version=policy['version'])
        directory = root/f'{number:03d}'
        saved_request = read(directory/'request.json')
        checkpoint = read(directory/'checkpoint.json')
        if (call['request_sha256'] != sha(canonical(saved_request)) or
                canonical(saved_request) != canonical(request_evidence(expected_request)) or
                call.get('checkpoint_sha256') != sha(canonical(checkpoint)) or
                checkpoint['status'] not in ('ok', 'failed')):
            raise ValueError('Physical attempt request or checkpoint identity')
        if number == 1 and canonical(read(workspace/'requests'/f'{key}.json')) != canonical(saved_request):
            raise ValueError('Original request compatibility view changed')
        raw_response = None
        if call['status'] == 'response':
            raw_response = read(directory/'response.json')
            if (call.get('response_sha256') != sha(canonical(raw_response)) or
                    call.get('usage') != raw_response.get('usage') or
                    call.get('stop_reason') != raw_response.get('stopReason')):
                raise ValueError('Physical response or usage identity')
            if number == 1 and canonical(read(workspace/'responses'/f'{key}.json')) != canonical(raw_response):
                raise ValueError('Original response compatibility view changed')
            if checkpoint['status'] == 'ok':
                if raw_response.get('stopReason') != 'end_turn':
                    raise ValueError('Successful checkpoint from nonfinal response')
                raw = ''.join(item.get('text', '') for item in raw_response['output']['message']['content'])
                text, framing = model_response_json(raw)
                if (canonical(parse(role, text, notes_pages)) != canonical(checkpoint['output']) or
                        checkpoint.get('response_framing') != framing):
                    raise ValueError('Successful checkpoint differs from author response')
        elif (call['status'] != 'ambiguous_or_rejected' or checkpoint['status'] != 'failed' or
                'response_sha256' in call or (directory/'response.json').exists()):
            raise ValueError('Unsettled physical attempt identity')
        previous_response, previous_result = raw_response, checkpoint
    if canonical(previous_result) != canonical(result):
        raise ValueError('Latest logical checkpoint differs from final physical attempt')


def report_completion(workspace, identity, ledger, results):
    """Guideline-only operational rule, opted into by NEW frozen identities.

    Reconstruct requests offline to check image/selection/review dependencies. Never
    create a provider, repair exports or mutate evidence. New recovery identities
    also verify every physical attempt and the bounded correction request chain.
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
        policy = None
        if 'technical_recovery' in identity:
            from ..runtime import recovery_policy
            policy = recovery_policy(identity['config'])
            try:
                policy = recovery_budget(identity, ledger)
            except (ValueError, RuntimeError, OSError, KeyError, TypeError):
                # Continue enumerating evidence so an interrupted reservation is
                # visible in checkpoint statuses as well as aggregate exposure.
                block('recovery_accounting_identity')
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
                    if stopped or not matches or result is None:
                        raise ValueError('Unexpected or interrupted request')
                    request_value = request(view, role, declared(view, role), batch, notes, final)
                    if policy is not None:
                        recovery_evidence(workspace, key, role, request_value, matches, result,
                                          None if final else [p['printed_page'] for p in batch], policy)
                    elif len(matches) != 1:
                        raise ValueError('Legacy request has multiple physical calls')
                    call = matches[-1]
                    if (call['role'] != role or call.get('checkpoint_sha256') != sha(canonical(result)) or
                            result['status'] not in ('ok', 'failed') or
                            call['status'] not in ('response', 'ambiguous_or_rejected') or
                            result['status'] == 'ok' and call['status'] != 'response'):
                        raise ValueError('Checkpoint/ledger identity')
                    saved_request = read(workspace/'requests'/f'{key}.json')
                    if matches[0]['request_sha256'] != sha(canonical(saved_request)):
                        raise ValueError('Saved request identity')
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
             'New runs permit bounded same-role technical response correction with settled usage; '
             'ambiguous transport, missing usage and nonfinal provider stops are never automatically retried.']
    for role in ('coverage', 'accuracy', 'structure'):
        output = results.get(role, {}).get('output', {})
        if output.get('ok') is False:
            notes.append(f'{role} returned ok:false; this remains advisory feedback, not a later veto.')
    for role, field in (('revision', 'sections'), ('refresher', 'topic_summary')):
        output = results.get(role, {}).get('output', {})
        if output and field not in output.get('artifact', {}):
            notes.append(f'{role}: artifact lacks {field}; preserved without repair. Envelope may contain additional fields.')
    return notes
