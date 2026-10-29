"""Five isolated Translate streams, one final author each, trusted local joins."""
import json
from typing import TypedDict
from langgraph.graph import StateGraph, START, END
from ..inputs import ROOT, canonical, read, save, sha, strict_json
from .translate_inputs import STREAMS, project

NAME = 'translate'
METADATA = {'grade', 'subject', 'language', 'batch_size'}
REQUIRED_METADATA = ('grade', 'subject', 'language')
REQUIRES_PAGES = False
PRESERVE_FILE_BYTES = True
FILE_INPUTS = ('deck', 'checkins', 'practice', 'revise')
PHASES = ('author', 'review', 'final')
ROLES = tuple(f'translate_{stream}_b001_{phase}' for stream in STREAMS for phase in PHASES)
FAMILIES = {'teaching': 'translation', 'checkin': 'question', 'practice': 'question',
            'feedback': 'feedback', 'revise': 'revise'}
FIELDS = {'teaching': ('title_display', 'lines'),
          'checkin': ('question_display', 'question_audio', 'options_display', 'options_audio'),
          'practice': ('question_display', 'question_audio', 'options_display', 'options_audio'),
          'feedback': ('explanation_display', 'correct_answer_display', 'hint_display', 'hint_audio',
                       'success_display', 'success_audio', 'reveal_display', 'reveal_audio'),
          'revise': ('question', 'answer')}


def validate_inputs(bundle):
    if bundle['pages'] or any(s['type'] != 'json' for s in bundle['file_identity'].values()):
        raise ValueError('Translate accepts native JSON artifacts only, no pages')
    if bundle['metadata']['language'] != 'hi':
        raise ValueError('Translate reference supports explicit language hi only')
    size = bundle['metadata'].get('batch_size', 12)
    if type(size) is not int or not 1 <= size <= 50:
        raise ValueError('batch_size must be an integer from 1 to 50')
    project(bundle)


def batches(bundle, view):
    size = bundle['metadata'].get('batch_size', 12)
    return [{'stream': stream, 'batch': i//size+1, 'items': items[i:i+size]}
            for stream in STREAMS for items in (view['streams'][stream],) for i in range(0, len(items), size)]


def role_key(batch, phase):
    return f'translate_{batch["stream"]}_b{batch["batch"]:03d}_{phase}'


def candidate_view(artifact, stream):
    """Only translation slots/fields enter downstream roles, never routing/keys.

    Raw envelopes stay in checkpoints. This is a pre-revision role-input allowlist,
    not a filter of final items or a post-author repair.
    """
    return {'schema_version': artifact['schema_version'], 'items': [
        {k: item[k] for k in ('slot', 'source_hash', *FIELDS[stream]) if k in item}
        for item in artifact['items']]}


def request(run, role, declared, batch, notes, final):
    if batch or notes or not final:
        raise ValueError('Translate uses text-only independent requests')
    stream, phase = declared['stream'], role.rsplit('_', 1)[1]
    suffix = {'author': 'author', 'review': 'verify', 'final': 'fixer'}[phase]
    prompt = (ROOT/'prompts/translate'/f'{FAMILIES[stream]}_{suffix}.md').read_text()
    fields = {
        'teaching': 'title_display and lines:[{display,audio}], one line per source line in source order',
        'checkin': 'question_display, question_audio, options_display:[text], options_audio:[text]',
        'practice': 'question_display, question_audio, options_display:[text], options_audio:[text]',
        'feedback': 'For kind practice: explanation_display and correct_answer_display. For kind checkin: '
                    'hint_display/hint_audio for hint, success_display/success_audio for success_message, '
                    'reveal_display/reveal_audio for reveal_text; translate only supplied fields',
        'revise': 'question:{display,audio}, answer:{display,audio}',
    }[stream]
    contract = ('Translate ONLY the supplied task data to Hindi. No tools, files, services or fresh research. '
        'Audio fields are text, not synthesized clips. Every item copies its fixed slot and opaque source_hash. '
        'The host owns source identities, routing and answer keys. Never return or infer host routing authority. '
        'Preserve source meaning without repairing English or adding lessons. Translation fields: '+fields+'. ')
    if stream in ('checkin', 'practice'):
        contract += ('Only the pre-answer question projection is supplied. Keep options in exactly the supplied '
            'positions/count. For true_false use empty options_display/options_audio arrays and include the '
            'statement in the question text. Do not add answer-telling text. ')
    if phase == 'review':
        contract += ('Return ONLY {"verdicts":[{"slot":"source slot","pass":true,"reason":"text"}],'
                     '"batch_issues":[]}. Assess the complete draft. Findings are advisory and cannot veto the final author. ')
    else:
        contract += ('Return ONLY {"artifact":{"schema_version":2,"items":[{"slot":"source slot",'
            '"source_hash":"copy opaque hash",<translation fields>}]},...audit fields}. '
            'Return the whole batch, including unflagged items. ')
        if phase == 'final':
            contract += ('Make ONE final revision using all supplied verdicts and batch issues. '
                'Apply or decline feedback with reasons outside artifact. Your fields are final; no later '
                'quality review, repair, subset salvage or content veto follows. ')
    if phase == 'review':
        result_type = ('Return the native unenveloped JSON root with verdicts array of objects containing '
            'slot (string), pass (boolean) and reason (text), and batch_issues as a text array. '
            'Do not wrap the review in artifact. Copy the actual supplied string slots verbatim; never replace '
            'them with numeric placeholders. Assess the complete draft. Empty arrays and negative advisory '
            'feedback remain valid; do not invent findings. Feedback cannot veto the final author. ')
    else:
        result_type = ('Return an object-valued artifact with schema_version 2 and the complete native items batch. '
            'Every item must copy its supplied slot and opaque source_hash exactly. Return every supplied item in '
            'source order, including unflagged items; no partial or flagged-only subset. Keep existing audit fields '
            'outside artifact but inside this same JSON object. ')
        if phase == 'final':
            result_type += ('Make one final revision using all supplied verdicts and batch issues. Apply or decline '
                'feedback with reasons in the existing dispositions outside artifact. Your translated fields are '
                'authoritative; no later quality review, repair, subset salvage or content veto follows. ')
    stream_type = {
        'teaching': 'Translation item fields: title_display and lines:[{display,audio}], one line per source line '
                    'in source order. Audio fields contain spoken text only.',
        'checkin': 'Translation item fields: ONLY answer-free question_display and question_audio text, plus options_display '
                   'and options_audio text arrays. Keep options in exactly the supplied positions/count. For '
                   'true_false use empty options_display/options_audio arrays and include the statement in the '
                   'question text. Do not add answer-telling text.',
        'practice': 'Translation item fields: ONLY answer-free question_display and question_audio text, plus options_display '
                    'and options_audio text arrays. Keep options in exactly the supplied positions/count. For '
                    'true_false use empty options_display/options_audio arrays and include the statement in the '
                    'question text. Do not add answer-telling text.',
        'feedback': 'Translation item fields: Translate only actually supplied fields. For kind practice, '
                    'explanation_why becomes explanation_display and correct_answer_line becomes '
                    'correct_answer_display. Practice entries remain text only. For kind checkin, hint becomes '
                    'hint_display/hint_audio, success_message becomes success_display/success_audio and '
                    'reveal_text becomes reveal_display/reveal_audio, each pair only when its source is supplied.',
        'revise': 'Translation item fields: question:{display,audio}, answer:{display,audio}. '
                  'Both native faces are supplied; audio fields contain spoken text only.',
    }[stream]
    final_contract = ('Final response contract:\nRole: '+role+'. Stream: '+stream+'. Phase: '+phase+'. '+result_type+stream_type+
        '\nReturn one complete strict JSON object. The first non-whitespace character must be { and the last must be }. '
        'No response-level preamble or postscript, procedure narration, headings, Markdown fences, extra objects, '
        'comments, trailing commas or file receipts. Text, Markdown and Unicode inside JSON strings remain valid; '
        'escape newlines, quotes and backslashes as JSON requires. Put notes only in fields allowed by this '
        'role\'s existing instructions. Preserve the existing native schema and advisory targets. Return the '
        'content itself, not a description of producing it.')
    request = {'messages': [{'role': 'user', 'content': [{'text': prompt+'\n\nLOCAL TRANSPORT CONTRACT:\n'+contract+
        '\nDeclared task data:\n'+json.dumps({'task_inputs': declared}, ensure_ascii=False)}, {'text': final_contract}]}]}
    if stream == 'teaching' and phase == 'final':
        request['system'] = [{'text': final_contract+
            '\nOutput scope: task_inputs, source/input objects, draft, review and pre_revision_diagnostics '
            'are input-only; do not reproduce them in the response. This does not exclude the required '
            'slot and source_hash values or translated title_display and lines:[{display,audio}] fields: '
            'preserve those exactly as instructed above. Return the complete final translated content once '
            'in artifact; do not copy another complete item batch into audit or disposition fields. '
            'Keep only the existing allowed audit/disposition fields outside artifact.'
            '\nEnvelope nesting: after returning schema_version 2 and every translated item in artifact.items, '
            'close the items array and then the artifact object. Put existing permitted audit/disposition fields '
            'alongside artifact in the outer response object, never inside artifact or items. Do not copy the '
            'review-only verdicts or batch_issues fields or the input-only pre_revision_diagnostics field. '
            'After the permitted outer audit/disposition fields, close the outer response object. Include every '
            'required translated item and field, exact slot and source_hash, and source order; do not return a '
            'partial batch or template.'
            '\nScalar member syntax: title_display has exactly one JSON string value in each teaching item. '
            'Write its property name once, one colon, and one quoted string value. Keep Markdown and Unicode '
            'within that string; escape any embedded quotes, backslashes and line breaks as JSON requires. '
            'Syntax-only illustration: {"title_display":"Example title"}. This demonstrates one member\'s '
            'syntax, not a replacement title, item or response. Supply each item\'s actual translated title '
            'and preserve all required items, fields, identities and envelope.'}]
    return request


def parse(role, text, notes_pages=None):
    value = strict_json(text)
    if not isinstance(value, dict):
        raise ValueError('Translate response must be a JSON object')
    if role.endswith('_review'):
        if not isinstance(value.get('verdicts'), list) or not isinstance(value.get('batch_issues'), list):
            raise ValueError('Translate review requires verdicts and batch_issues arrays')
        if not all(isinstance(v, dict) and isinstance(v.get('slot'), str) and type(v.get('pass')) is bool
                   and isinstance(v.get('reason'), str) for v in value['verdicts']):
            raise ValueError('Translate review verdict needs slot/pass/reason')
        if not all(isinstance(x, str) for x in value['batch_issues']):
            raise ValueError('Translate batch issues must be text')
    else:
        artifact = value.get('artifact')
        if not isinstance(artifact, dict) or artifact.get('schema_version') != 2 or not isinstance(artifact.get('items'), list):
            raise ValueError('Translate artifact requires schema_version 2 and items array')
        if not all(isinstance(x, dict) for x in artifact['items']):
            raise ValueError('Translate items must be objects')
    return value


def required(run, role):
    value = run.output(role)
    if 'technical_failure' in value:
        raise ValueError(role+': required stage unavailable; no substitute translation')
    return value


def diagnostics(source, artifact, stream):
    """Pre-revision observations only; never a surviving-valid-subset selector."""
    expected = {x['slot']: x for x in source}
    findings = []
    slots = [x.get('slot') for x in artifact['items']]
    if slots != [x['slot'] for x in source]:
        findings.append('Draft slots/order differ from source; final author decides content, host joins fixed identities.')
    for item in artifact['items']:
        src = expected.get(item.get('slot')) if isinstance(item.get('slot'), str) else None
        if not src:
            findings.append('Draft has unbound source slot.')
            continue
        if item.get('source_hash') != src['source_hash']:
            findings.append('Draft opaque hash differs from source.')
        if stream in ('checkin', 'practice'):
            for f in ('options_display', 'options_audio'):
                if not isinstance(item.get(f), list) or len(item[f]) != len(src['options']):
                    findings.append('Draft option count differs for '+src['slot']+' '+f)
        if stream == 'teaching' and (not isinstance(item.get('lines'), list) or len(item['lines']) != len(src['lines'])):
            findings.append('Draft line count differs for '+src['slot'])
    return {'observations': findings, 'advisory_only': True}


def join_items(items, descriptors, stream):
    """All-or-fail identity join. Content fields are never quality-filtered."""
    expected = {d['slot']: d for d in descriptors}
    joined = {}
    for item in items:
        slot = item.get('slot')
        if not isinstance(slot, str) or slot not in expected or slot in joined:
            raise ValueError('Assembly identity join failed for '+stream+': unknown/duplicate slot')
        desc = expected[slot]
        if item.get('source_hash') != desc['source_hash']:
            raise ValueError('Assembly identity join failed for '+stream+': source hash mismatch')
        joined[slot] = {k: item[k] for k in FIELDS[stream] if k in item}
    if set(joined) != set(expected):
        raise ValueError('Assembly identity join failed for '+stream+': missing source slot; no subset export')
    return joined


def assemble(run, view, work):
    # Persist every final stream/batch before ANY join can fail.
    finals = {s: [] for s in STREAMS}
    for b in work:
        role = role_key(b, 'final')
        run.export(role, role+'.json')
        finals[b['stream']].extend(required(run, role)['artifact']['items'])
    joined = {s: join_items(finals[s], view['descriptors'][s], s) for s in STREAMS}
    bound = {s: {d['slot']: d for d in view['descriptors'][s]} for s in STREAMS}
    def item(stream, slot):
        d = bound[stream][slot]
        row = {k: d[k] for k in ('source', 'english_answer_key', 'english_options') if k in d}
        row.update(joined[stream][slot])
        if slot in joined['feedback'] and stream in ('checkin', 'practice'):
            fd = bound['feedback'][slot]
            if fd['target'] != stream or fd['source_hash'] != d['source_hash']:
                raise ValueError('Assembly feedback identity join failed')
            row.update(joined['feedback'][slot])
        return row
    packs = {
        'deck_hi.json': [item(d['stream'], d['slot']) for d in view['deck_order']],
        'practice_hi.json': [item('practice', d['slot']) for d in view['descriptors']['practice']],
        'revise_hi.json': [item('revise', d['slot']) for d in view['descriptors']['revise']],
    }
    # All joins and all three pack constructions succeed before first pack write.
    for filename, items in packs.items():
        save(run.workspace/'artifacts'/filename, {'schema_version': 2, 'language': 'hi', 'items': items})
    return {name: {'items': len(items), 'sha256': sha(canonical(read(run.workspace/'artifacts'/name)))}
            for name, items in packs.items()}


def graph(run):
    validate_inputs(run.bundle)
    view = project(run.bundle)
    work = batches(run.bundle, view)
    save(run.workspace/'views/projections.json', view['streams'])
    save(run.workspace/'views/source-descriptors.json', view['descriptors'])
    save(run.workspace/'views/interleaved-index-map.json', view['index_map'])
    save(run.workspace/'views/batches.json', work)
    save(run.workspace/'views/reference-identity.json', {
        'source_file_sha256': {k: v['sha256'] for k, v in run.bundle['file_identity'].items()},
        'projection_sha256': sha(canonical(view['streams'])), 'descriptor_sha256': sha(canonical(view['descriptors'])),
        'whole_input_sha256': run.identity['input_sha256'], 'revise_fingerprint': view['revise_fingerprint']})
    class State(TypedDict):
        last_role: str
    flow = StateGraph(State)
    def node(state, b, phase):
        stream = b['stream']
        role = role_key(b, phase)
        data = {'stream': stream, 'items': b['items'], 'grade': run.bundle['metadata']['grade'],
                'subject': run.bundle['metadata']['subject'], 'language': 'hi'}
        if phase in ('review', 'final'):
            draft = required(run, role_key(b, 'author'))['artifact']
            data['draft'] = candidate_view(draft, stream)
            diag = diagnostics(b['items'], draft, stream)
            save(run.workspace/'diagnostics'/f'{role_key(b, "author")}.json', diag)
            data['pre_revision_diagnostics'] = diag
        if phase == 'final':
            review = required(run, role_key(b, 'review'))
            data['review'] = {'verdicts': [{k: v[k] for k in ('slot', 'pass', 'reason')} for v in review['verdicts']],
                              'batch_issues': review['batch_issues']}
        run.role(role, data)
        required(run, role)
        if phase == 'final':
            run.export(role, role+'.json')
        return {'last_role': role}
    previous = START
    for b in work:
        for phase in PHASES:
            key = role_key(b, phase)
            flow.add_node(key, lambda state, b=b, phase=phase: node(state, b, phase))
            flow.add_edge(previous, key)
            previous = key
    def assembly(state):
        save(run.workspace/'metrics/assembly.json', {'status': 'assembling', 'quality_gate': False})
        try:
            packs = assemble(run, view, work)
        except (ValueError, KeyError, TypeError) as error:
            save(run.workspace/'metrics/assembly.json', {'status': 'failed', 'kind': 'operational_identity_join',
                'quality_gate': False, 'final_artifacts_preserved': True})
            raise ValueError('Translate operational assembly failed; all final artifacts preserved: '+str(error)) from error
        save(run.workspace/'metrics/assembly.json', {'status': 'complete', 'quality_gate': False, 'packs': packs})
        return {'last_role': 'translate_assembly'}
    flow.add_node('translate_assembly', assembly)
    flow.add_edge(previous, 'translate_assembly')
    flow.add_edge('translate_assembly', END)
    return flow.compile().with_config({"recursion_limit": max(25, 3*len(work)+2)})


def report_roles(workspace):
    path = workspace/'views/batches.json'
    return tuple(role_key(b, p) for b in read(path) for p in PHASES) if path.exists() else ROLES


def report_stages(workspace):
    status = workspace/'metrics/assembly.json'
    return {'translate_assembly': read(status) if status.exists() else {'status': 'unavailable', 'quality_gate': False}}


def observations(results):
    return ['Five isolated text-only streams; T03 check-in feedback is supplied only to feedback roles.',
        'One final author per nonempty batch; review findings are advisory, with no later quality veto or subset salvage.',
        'Trusted joins preserve final translation fields and original keys/options. Semantic option swaps are not repaired.',
        'Assembly status is operational bookkeeping, not a content-quality verdict.',
        'No production import/export, live services, synthesized speech, cue stamping, salvage or coverage gate.']
