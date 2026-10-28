"""Genuine local Visuals graph with render evidence before one final revision."""
from typing import TypedDict
from langgraph.graph import StateGraph, START, END
from .. import media
from ..inputs import read, save
from . import media_common as c

NAME = 'visuals'
METADATA = {'grade', 'subject'}
REQUIRED_METADATA = ('grade', 'subject')
REQUIRES_PAGES = False
PRESERVE_FILE_BYTES = True
FILE_INPUTS = c.FILE_INPUTS
BINARY_INPUTS = c.BINARY_INPUTS
ROLES = ('visuals_decide',)
parse = c.parse
execution_identity = media.runtime_identity
report_media = c.report_media


def validate_inputs(bundle):
    c.validate(bundle, NAME)


def roles_for(bundle, routing=None):
    rows = ['visuals_decide']
    for target in c.targets(bundle, NAME):
        prefix = f'visuals_c{target["card"]["card_idx"]:03d}'
        choice = routing.get(str(target['card']['card_idx'])) if routing is not None else None
        if choice and choice['decision'] == 'no_visual': continue
        rows.extend(prefix+'_'+phase for phase in ('author', 'review', 'final'))
        if target['mode'] == 'interactive' and (choice is None or choice['interactive']):
            rows.extend(prefix+'_interactive_'+phase for phase in ('author', 'review', 'final'))
    return tuple(rows)


def report_roles(workspace):
    path = workspace/'views/visual-routing.json'
    return roles_for(read(workspace/'inputs.json'), read(path) if path.exists() else None)


def routing(bundle, artifact):
    expected = {t['card']['card_idx']: t for t in c.targets(bundle, NAME)}
    rows, candidates = artifact.get('decisions'), artifact.get('interactive_candidates', [])
    if not isinstance(rows, list) or not isinstance(candidates, list):
        raise ValueError('Decide requires explicit decisions and interactive_candidates arrays')
    nominated = set()
    for row in candidates:
        if not isinstance(row, dict) or type(row.get('card_idx')) is not int or row['card_idx'] not in expected:
            raise ValueError('Interaction nomination lacks a declared target identity')
        if expected[row['card_idx']]['mode'] != 'interactive' or row.get('kind') != 'slider':
            raise ValueError('Only explicit slider targets may be nominated')
        nominated.add(row['card_idx'])
    result = {}
    for row in rows:
        if not isinstance(row, dict) or type(row.get('card_idx')) is not int or row['card_idx'] not in expected or str(row['card_idx']) in result:
            raise ValueError('Decide identity join failed; no missing/duplicate/unknown targets')
        if row.get('decision') not in ('no_visual','static_visual','animated_visual','svg_illustration'):
            raise ValueError('Unsupported local Decide route')
        result[str(row['card_idx'])] = {'decision':row['decision'], 'interactive':row['card_idx'] in nominated,
            'spec':{k:row[k] for k in ('card_idx','decision','needs_accuracy','title','visual_summary','visual_spec','rationale') if k in row}}
    if set(result) != {str(k) for k in expected}:
        raise ValueError('Decide identity join failed; complete target set required')
    return result


def report_stages(workspace):
    return c.stages(workspace, [role+'_render' for role in report_roles(workspace)
                              if role.endswith(('_author', '_final'))])


def request(run, role, declared, batch, notes, final):
    return c.request(run, role, declared, batch, notes, final, prompt_for(role, declared['mode']))


def prompt_for(role, mode):
    if role == 'visuals_decide': return 'visual_decide'
    if '_interactive_' in role:
        return 'visual_interactive_verify' if role.endswith('_review') else 'visual_interactive_author'
    if role.endswith('_review'): return 'visual_verify'
    return 'visual_author_image' if mode == 'svg' else 'visual_author'


def render(run, role, target):
    directory = run.workspace/'media'/role
    manifest = directory/'manifest.json'
    # Derived outputs are frozen, never silently regenerated on resume.
    if manifest.exists():
        result = c.cached_render(directory)
        c.stage(run.workspace, role+'_render', result)
        return result
    try:
        artifact = c.required(run, role)['artifact']
        rows = c.visual_view(artifact)['visuals']
        if len(rows) != 1 or rows[0].get('card_idx') != target['card']['card_idx']:
            raise ValueError('Visual execution identity does not match explicit one-card target')
        row = rows[0]
        if row.get('expected_card_type') != target['card']['card_type'] or row.get('expected_title') != target['card']['title']:
            raise ValueError('Visual execution target title/type differs from frozen card')
        explanation = row['visual_explanation']
        function = media.render_svg if target['mode'] == 'svg' else media.render_visual
        result = function(explanation, directory, allowed_roots=[run.workspace])
    except Exception as error:
        result = {'status': 'failed', 'reviewer_frames': [], 'diagnostics': [
            {'kind': 'technical_failure', 'type': type(error).__name__, 'message': str(error)}]}
        save(manifest, result)
    c.stage(run.workspace, role+'_render', result)
    return result


def graph(run):
    validate_inputs(run.bundle)
    work = c.targets(run.bundle, NAME)
    base = {'grade': run.bundle['metadata']['grade'], 'subject': run.bundle['metadata']['subject'],
            'guideline': c.guideline(run.bundle)}
    save(run.workspace/'views/reference-identity.json', c.source_identity(run.bundle))
    save(run.workspace/'views/targets.json', work)
    class State(TypedDict): last_role: str
    flow = StateGraph(State)
    def decide(state):
        data = {**base, 'mode': 'decide', 'targets': work}
        run.role('visuals_decide', data)
        c.required(run, 'visuals_decide')
        run.export('visuals_decide', 'visual-decisions.json')
        save(run.workspace/'views/visual-routing.json', routing(run.bundle, c.required(run, 'visuals_decide')['artifact']))
        return {'last_role': 'visuals_decide'}
    flow.add_node('visuals_decide', decide)
    flow.add_edge(START, 'visuals_decide')
    previous = 'visuals_decide'
    for target in work:
        prefix = f'visuals_c{target["card"]["card_idx"]:03d}'
        for interactive in ([False, True] if target['mode'] == 'interactive' else [False]):
            stem = prefix+('_interactive' if interactive else '')
            for phase in ('author', 'render_draft', 'review', 'final', 'render_final'):
                key = stem+'_'+phase
                def node(state, target=target, stem=stem, phase=phase, interactive=interactive, prefix=prefix):
                    role = stem+'_'+phase
                    choice = read(run.workspace/'views/visual-routing.json')[str(target['card']['card_idx'])]
                    if choice['decision'] == 'no_visual' or (interactive and not choice['interactive']):
                        return {'last_role':role+'_explicitly_skipped'}
                    author = stem+'_author'
                    data = {**base, 'mode': target['mode'], 'card': target['card'],
                            'decision': choice['spec'],
                            'phase': phase, 'interactive_revision': interactive}
                    if interactive:
                        data['base_visual'] = c.visual_view(c.required(run, prefix+'_final')['artifact'])
                    if phase in ('render_draft', 'render_final'):
                        source = stem+('_author' if phase == 'render_draft' else '_final')
                        render(run, source, target)
                    elif phase == 'review':
                        result = render(run, author, target)
                        frames, evidence = c.review_evidence(run.workspace/'media'/author, result, run.config['image_limit'])
                        data.update(draft=c.visual_view(c.required(run, author)['artifact']), render_evidence=evidence)
                        run.invoke(role, role, c.request(run, role, data, [], [], True, prompt_for(role, target['mode']), frames),
                                   lambda text: parse(role, text))
                        c.required(run, role)
                    else:
                        if phase == 'final':
                            result = render(run, author, target)
                            _, evidence = c.review_evidence(run.workspace/'media'/author, result, run.config['image_limit'])
                            data.update(draft=c.visual_view(c.required(run, author)['artifact']),
                                        review=c.review_view(c.required(run, stem+'_review')),
                                        render_evidence=evidence)
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
    return ['Actual local render stages are execution evidence, never another content-quality review.',
            'Base and slider revisions remain separate unchanged native artifacts; negative feedback never reverts either.',
            'SVG is explicitly adapted illustration, not raster synthesis or source house-style parity.',
            'Only pre-final review roles receive sampled frame pixels; no original-page or listening claim.',
            'Unsupported: hosted raster/sticker/cutout/repaint, group/tall boards, source art/ASR/production import.']
