"""Visuals' genuine Boards child: real narration, pencil render, review, final author."""
from typing import TypedDict
from langgraph.graph import StateGraph, START, END
from .. import media
from ..inputs import read, save, sha
from . import media_common as c

NAME = 'boards'
METADATA = {'grade', 'subject'}
REQUIRED_METADATA = ('grade', 'subject')
REQUIRES_PAGES = False
PRESERVE_FILE_BYTES = True
FILE_INPUTS = c.FILE_INPUTS
BINARY_INPUTS = c.BINARY_INPUTS
ROLES = ()
parse = c.parse
execution_identity = media.runtime_identity
report_media = c.report_media


def validate_inputs(bundle): c.validate(bundle, NAME)


def parse_declared(role, text, declared, notes_pages=None):
    """Require an executable native plan before the same author checkpoints.

    Compilation only resolves supplied anchors, geometry and draw dependencies.
    Return the author's exact envelope; this is not a content-quality review or
    a host-authored timing/content replacement.
    """
    value = parse(role, text, notes_pages)
    if role.endswith('_review'):
        return value
    plan = c.board_view(value['artifact'])
    if plan.get('card_idx') != declared['card']['card_idx']:
        raise ValueError('Board plan has wrong original R3 card_idx')
    try:
        media.compile_board(plan, declared['narration'])
    except media.BoardTimingError as error:
        from ..runtime import NativeContractError
        raise NativeContractError('board_emphasis_after_draw', details=error.details) from error
    except media.MediaError as error:
        raise ValueError('Board native plan is not executable') from error
    return value


def report_roles(workspace):
    return tuple(f'boards_c{t["card"]["card_idx"]:03d}_{phase}'
                 for t in c.targets(read(workspace/'inputs.json'), NAME) for phase in ('author', 'review', 'final'))


def report_stages(workspace):
    roles = report_roles(workspace)
    names = [r+'_render' for r in roles if r.endswith(('_author', '_final'))]
    names += [r.removesuffix('_author')+'_narration' for r in roles if r.endswith('_author')]
    return c.stages(workspace, names)


def request(run, role, declared, batch, notes, final):
    request = c.request(run, role, declared, batch, notes, final,
                        'board_verify' if role.endswith('_review') else 'board_author')
    if role.startswith('boards_c') and role.endswith('_final'):
        request['system'] = [{'text': (
            'For this final board-author revision, return one complete strict JSON object with no text outside it. '
            'Return {"artifact":<complete native board plan>,"dispositions":[],"note":"..."}. '
            'The object-valued artifact contains the original card_idx and complete route ("board" or "hold"), '
            'rationale, nodes, beats and needs, using the native types and supplied identity and scripts already instructed. '
            'A justified hold with empty nodes and beats remains valid. '
            'Preserve the existing dispositions/note envelope; keep reasoning and explanations inside the allowed JSON fields. '
            'Do not include a preamble, postscript, heading, Markdown fence or file-write receipt. '
            'Review is advisory; this final author revision is authoritative content with no later content-quality review or veto.')}]
    return request


def narration(run, card):
    stem = f'boards_c{card["card_idx"]:03d}'
    directory = run.workspace/'media'/(stem+'_audio')
    manifest = directory/'narration.json'
    if manifest.exists():
        result = read(manifest)
        # Cached binary audio must still have exactly its recorded byte identity.
        for row in [*result.get('clips', []), *[r['source_file'] for r in result.get('clips', [])], result.get('audio', {})]:
            if 'file' in row and sha((directory/row['file']).read_bytes()) != row['sha256']:
                raise ValueError('Frozen narration clip changed')
        c.stage(run.workspace, stem+'_narration', {'status': 'complete'})
        return result
    supplied = {}
    slots = run.bundle['declared'].get('speech', {}).get('clips', {}).get(str(card['card_idx']), [])
    blocks = c.narration_blocks(run.bundle, card)
    if slots and len(slots) != len(blocks):
        raise ValueError('Supplied clips must bind every narration block')
    alignment = run.bundle['declared'].get('alignment', {}).get('cards', {}).get(str(card['card_idx']))
    if alignment is not None and (not slots or not isinstance(alignment, list) or len(alignment) != len(blocks)):
        raise ValueError('Supplied alignment must bind every explicitly supplied clip')
    for i, slot in enumerate(slots):
        supplied[i] = {'path': run.workspace/'inputs'/run.bundle['file_identity'][slot]['file'],
                       'sha256': run.bundle['file_identity'][slot]['sha256']}
        if alignment is not None:
            supplied[i]['alignment'] = alignment[i]
    try:
        result = media.synthesize(blocks, directory, c.speech_config(run.bundle), supplied or None,
                                  allowed_roots=[run.workspace])
        save(manifest, result)
        c.stage(run.workspace, stem+'_narration', {'status': 'complete'})
        return result
    except Exception:
        c.stage(run.workspace, stem+'_narration', {'status': 'failed'})
        raise


def timing_view(value):
    # Only task scripts/times/provenance, never raw paths, tool diagnostics or source operational data.
    def safe(row):
        if isinstance(row, list): return [safe(r) for r in row]
        if isinstance(row, dict):
            return {k: safe(v) for k, v in row.items() if k not in
                    ('file', 'path', 'source_path', 'output_dir', 'voice_inventory', 'tools', 'command', 'source')}
        return row
    return safe(value)


def render(run, role, card, audio):
    directory = run.workspace/'media'/role
    manifest = directory/'manifest.json'
    if manifest.exists():
        result = c.cached_render(directory)
        c.stage(run.workspace, role+'_render', result)
        return result
    try:
        plan = c.board_view(c.required(run, role)['artifact'])
        if plan.get('card_idx') != card['card_idx']:
            raise ValueError('Board plan has wrong original R3 card_idx')
        if plan.get('route') == 'hold':
            result = {'status': 'complete', 'route': 'hold', 'reviewer_frames': [],
                      'diagnostics': ['Final author explicitly held this board; no drawn-board claim.']}
            save(manifest, result)
        else:
            result = media.render_board(plan, audio, directory, allowed_roots=[run.workspace],
                                        narration_root=run.workspace/'media'/f'boards_c{card["card_idx"]:03d}_audio')
    except Exception as error:
        result = {'status': 'failed', 'reviewer_frames': [], 'diagnostics': [
            {'kind': 'technical_failure', 'type': type(error).__name__, 'message': str(error)}]}
        save(manifest, result)
    c.stage(run.workspace, role+'_render', result)
    return result


def graph(run):
    validate_inputs(run.bundle)
    work = c.targets(run.bundle, NAME)
    save(run.workspace/'views/reference-identity.json', c.source_identity(run.bundle))
    save(run.workspace/'views/targets.json', work)
    class State(TypedDict): last_role: str
    flow = StateGraph(State)
    previous = START
    for target in work:
        card = target['card']
        stem = f'boards_c{card["card_idx"]:03d}'
        for phase in ('narration', 'author', 'render_draft', 'review', 'final', 'render_final'):
            key = stem+'_'+phase
            def node(state, card=card, stem=stem, phase=phase):
                role = stem+'_'+phase
                audio = narration(run, card)
                data = {'grade': run.bundle['metadata']['grade'], 'subject': run.bundle['metadata']['subject'],
                        'card': card, 'guideline': c.guideline(run.bundle), 'mode': 'board', 'phase': phase,
                        'narration': timing_view(audio)}
                if phase in ('render_draft', 'render_final'):
                    render(run, stem+('_author' if phase == 'render_draft' else '_final'), card, audio)
                elif phase == 'review':
                    result = render(run, stem+'_author', card, audio)
                    frames, evidence = c.review_evidence(run.workspace/'media'/(stem+'_author'), result, run.config['image_limit'])
                    evidence['schedule'] = c.board_schedule(run.workspace/'media'/(stem+'_author'))
                    data.update(draft=c.board_view(c.required(run, stem+'_author')['artifact']), render_evidence=evidence)
                    run.invoke(role, role, c.request(run, role, data, [], [], True, 'board_verify', frames),
                               lambda text: parse(role, text))
                    c.required(run, role)
                elif phase in ('author', 'final'):
                    if phase == 'final':
                        result = render(run, stem+'_author', card, audio)
                        _, evidence = c.review_evidence(run.workspace/'media'/(stem+'_author'), result, run.config['image_limit'])
                        evidence['schedule'] = c.board_schedule(run.workspace/'media'/(stem+'_author'))
                        data.update(draft=c.board_view(c.required(run, stem+'_author')['artifact']),
                                    review=c.review_view(c.required(run, stem+'_review')), render_evidence=evidence)
                    run.role(role, data)
                    c.required(run, role)
                    run.export(role, role+'.json')
                return {'last_role': role}
            flow.add_node(key, node)
            flow.add_edge(previous, key)
            previous = key
    flow.add_edge(previous, END)
    return flow.compile()


def observations(results):
    return ['New local-board/v1 schema; no source engine, artwork catalogue or production cue ABI.',
            'Audio segment duration is decoded/measured; interpolated words remain estimated, alignment_verified=false.',
            'Draft frame/schedule review is advisory; the one final author plan is exported unchanged before execution.',
            'Final render success/failure is separate operational evidence; no listener/ASR or final quality veto.',
            'Wide and phone frames/MP4 prove local execution only, not Llama content quality or source media parity.']
