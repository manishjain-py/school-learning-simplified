"""Local Revise: independent drafts/lenses followed by one authoritative refiner."""
import json
from typing import TypedDict
from langgraph.graph import StateGraph, START, END
from ..inputs import ROOT, canonical, read, save, sha, strict_json
from .explain import guideline_view as explain_guideline_view

NAME = 'revise'
METADATA = {'grade', 'subject'}
REQUIRED_METADATA = ('grade', 'subject')
REQUIRES_PAGES = False
FILE_INPUTS = ('guideline', 'deck')
LENSES = ('lightness', 'accuracy', 'easy_english')
AUTHORS = ('revise_author_a', 'revise_author_b')
ROLES = ('revise_select', *AUTHORS, 'revise_selection',
         *('revise_'+lens for lens in LENSES), 'revise_final')
PROMPTS = {'revise_select': 'select_concepts', **{r: 'author' for r in AUTHORS},
           'revise_selection': 'judge_ab', **{'revise_'+l: 'reviewer' for l in LENSES},
           'revise_final': 'refiner'}


def guideline_view(bundle):
    """Reuse R3's exact-text adapter; native coverage-only sections need no invented text."""
    source = bundle['declared'].get('guideline')
    if not isinstance(source, dict):
        raise ValueError('Revise requires a JSON guideline artifact')
    sections = source.get('sections', [])
    if not isinstance(sections, list) or not all(isinstance(s, dict) for s in sections):
        raise ValueError('Guideline sections must be an ordered object array')
    # Source-native exports may have top-level text and sections containing only
    # coverage keys/titles/page counts. R3 also supports portable G1 section text.
    coverage_only = any('guideline_text' not in s and 'guidelines' not in s for s in sections)
    projected = dict(source)
    if coverage_only:
        projected['sections'] = []
    view = explain_guideline_view({**bundle, 'declared': {'guideline': projected}})
    if coverage_only:
        view['sections'] = []
        for section in sections:
            key = section.get('section_key', section.get('topic_key'))
            title = section.get('title', section.get('topic_title'))
            if not all(isinstance(x, str) and x.strip() for x in (key, title)):
                raise ValueError('Sections require exact key/title; no keys invented')
            row = {'section_key': key, 'title': title}
            text = section.get('guideline_text', section.get('guidelines'))
            if text is not None:
                if not isinstance(text, str):
                    raise ValueError('Section guideline text must be text')
                row['guideline_text'] = text
            view['sections'].append(row)
        if len({s['section_key'] for s in view['sections']}) != len(sections):
            raise ValueError('Section keys must be unique')
    for row, section in zip(view['sections'], sections):
        count = section.get('page_count')
        start, end = section.get('source_page_start'), section.get('source_page_end')
        if type(count) is int and count > 0:
            row['page_count'] = count
        elif type(start) is int and type(end) is int and 0 < start <= end:
            row['page_count'] = end-start+1
    return view


def deck_view(bundle):
    """Source-facing teaching-only fields, plus host-only old/local provenance."""
    deck = bundle['declared'].get('deck')
    if not isinstance(deck, dict) or not isinstance(deck.get('cards'), list) or not deck['cards']:
        raise ValueError('Revise requires a nonempty Explain cards array')
    cards, mapping, seen = [], [], set()
    for card in deck['cards']:
        if not isinstance(card, dict):
            raise ValueError('Explain cards must be objects')
        old = card.get('card_idx')
        if type(old) is not int or old < 1 or old in seen:
            raise ValueError('Explain cards need unique positive original card_idx values')
        seen.add(old)
        if card.get('card_type') == 'check_in':
            mapping.append({'old_card_idx': old, 'local_card_idx': None, 'reason': 'check_in removed'})
            continue
        lines = card.get('lines')
        if not isinstance(lines, list) or not all(isinstance(line, dict) and
                all(isinstance(line.get(k), str) for k in ('display', 'audio')) for line in lines):
            raise ValueError('Teaching cards require native display/audio lines')
        slim = {k: card.get(k) for k in ('card_type', 'title', 'visual', 'concept_group')}
        slim.update(card_idx=len(cards)+1,
                    lines=[{k: line[k] for k in ('display', 'audio')} for line in lines])
        cards.append(slim)
        mapping.append({'old_card_idx': old, 'local_card_idx': len(cards)})
    if not cards:
        raise ValueError('Explain input has no teaching cards after removing check-ins')
    return {'cards': cards}, {'mapping': mapping,
        'reference_indices': 'source_card_idxs refer to local teaching card_idx, not original indices'}


def validate_inputs(bundle):
    if bundle['pages'] or any(s['type'] != 'json' for s in bundle['file_identity'].values()):
        raise ValueError('Revise accepts text-only JSON guideline/deck inputs, no pages')
    guideline_view(bundle)
    deck_view(bundle)


def request(run, role, declared, batch, notes, final):
    if batch or notes or not final:
        raise ValueError('Revise roles use one text-only turn')
    prompt = (ROOT/'prompts/revise'/f'{PROMPTS[role]}.md').read_text().replace(
        '{grade}', str(run.bundle['metadata']['grade']))
    if role == 'revise_selection':
        contract = 'Return ONLY a JSON verdict with winner A/B/tie, margin and reasons. Tie selects A. No replacement deck.'
    elif role[7:] in LENSES:
        contract = 'Return ONLY a JSON object with findings array; empty is valid. YOUR ONLY LENS: '+role[7:]+'.'
    else:
        contract = 'Return ONLY {"artifact": <complete native JSON object>, ...audit fields}; no file-write receipt.'
    contract += (' All task inputs are inline. No tools, filesystem, services or fresh research. '
        'Source_card_idxs always use the supplied local teaching card_idx after check-in removal. '
        'Copy exact section_key and one-based section_seq from supplied guideline section order. '
        'Audio fields are spoken text only. Count/length/lightness targets are advisory; no quality gate follows. '
        'Never claim a production validator or import passed.')
    if role == 'revise_final':
        contract += (' Make ONE final revision even when accepted_findings is empty. Full reviews and indexed '
            'findings are retained; accepted_findings is the source critical/major deduplicated subset. '
            'Apply or decline findings with reasons outside the artifact. You own the exported artifact. '
            'No later reviewer, repair, reversion or veto follows.')
    return {'messages': [{'role': 'user', 'content': [{'text': prompt+
        '\n\nLOCAL TRANSPORT CONTRACT:\n'+contract+'\nDeclared task data:\n'+
        json.dumps({'task_inputs': declared}, ensure_ascii=False)}]}]}


def parse(role, text, notes_pages=None):
    value = strict_json(text)
    if not isinstance(value, dict):
        raise ValueError('Role response must be a JSON object')
    if role == 'revise_selection':
        if value.get('winner') not in ('A', 'B', 'tie'):
            raise ValueError('Selection requires winner A/B/tie')
    elif role[7:] in LENSES:
        if not isinstance(value.get('findings'), list):
            raise ValueError('Review needs a findings array; empty is valid')
    else:
        artifact = value.get('artifact')
        if not isinstance(artifact, dict):
            raise ValueError('Missing object-valued artifact')
        field = 'concepts' if role == 'revise_select' else 'cards'
        if role != 'revise_final' and (not isinstance(artifact.get(field), list) or
                not all(isinstance(row, dict) for row in artifact[field])):
            raise ValueError('Upstream artifact needs usable '+field+' object array')
    # No native-shape or pedagogical gate on the final refiner's JSON artifact.
    return value


def required(run, role):
    value = run.output(role)
    if 'technical_failure' in value:
        raise ValueError(role+': required stage unavailable; no substitute content')
    return value


def selection(run):
    available = [r for r in AUTHORS if 'technical_failure' not in run.output(r)]
    if not available:
        raise ValueError('Both Revise authors failed; no substitute deck')
    if len(available) == 1:
        winner = available[0]
        verdict = {'winner': 'A' if winner == AUTHORS[0] else 'B',
                   'reason': 'Only one usable author; blind selection skipped'}
    else:
        verdict = required(run, 'revise_selection')
        winner = AUTHORS[1] if verdict['winner'] == 'B' else AUTHORS[0]
    return winner, {'winner': 'A' if winner == AUTHORS[0] else 'B', 'verdict': verdict,
        'author_status': {r: 'usable' if r in available else 'technical_failure' for r in AUTHORS}}


def feedback(run):
    reviews = {l: required(run, 'revise_'+l) for l in LENSES}
    findings, accepted, seen = [], [], set()
    for lens, review in reviews.items():
        for raw in review['findings']:
            item = {**(raw if isinstance(raw, dict) else {'observation': raw}),
                    'index': len(findings), 'review_lens': lens}
            findings.append(item)
            key = (str(item.get('card_idx')), str(item.get('issue', ''))[:60])
            if item.get('severity') in ('critical', 'major') and key not in seen:
                accepted.append(item)
                seen.add(key)
    return {'reviews': reviews, 'indexed_findings': findings, 'accepted_findings': accepted}


def report_roles(workspace):
    path = workspace/'diagnostics/selection.json'
    if not path.exists():
        return ROLES
    result = read(path)
    usable = [r for r in AUTHORS if result['author_status'][r] == 'usable']
    # A surviving author's completion is legitimate. The failed peer remains in
    # its private checkpoint and the sanitized selection diagnostics/report.
    return ('revise_select', *usable, *(('revise_selection',) if len(usable) == 2 else ()),
            *('revise_'+l for l in LENSES), 'revise_final')


def graph(run):
    validate_inputs(run.bundle)
    guideline = guideline_view(run.bundle)
    deck, mapping = deck_view(run.bundle)
    for name, value in (('guideline', guideline), ('explain-deck', deck), ('explain-index-map', mapping)):
        save(run.workspace/'views'/f'{name}.json', value)
    save(run.workspace/'views/reference-identity.json', {
        'source_file_sha256': {k: run.bundle['file_identity'][k]['sha256'] for k in FILE_INPUTS},
        'projection_sha256': {k: sha(canonical(v)) for k, v in
            (('guideline', guideline), ('explain-deck', deck), ('explain-index-map', mapping))}})
    base = {'guideline': guideline, 'explain_deck': deck}
    class State(TypedDict):
        last_role: str
    flow = StateGraph(State)
    def node(state, role):
        data = dict(base)
        if role in AUTHORS or role == 'revise_selection':
            data['concepts'] = required(run, 'revise_select')['artifact']
        if role == 'revise_selection':
            available = [r for r in AUTHORS if 'technical_failure' not in run.output(r)]
            if len(available) == 2:
                data['candidates'] = {label: required(run, r)['artifact'] for label, r in zip(('A', 'B'), AUTHORS)}
                run.role(role, data)  # No author notes, identity or paths.
            winner, decision = selection(run)
            save(run.workspace/'diagnostics/selection.json', decision)
            run.export(winner, 'selected-draft.json')
        else:
            if role[7:] in LENSES or role == 'revise_final':
                winner, _ = selection(run)
                data['deck'] = required(run, winner)['artifact']
            if role == 'revise_final':
                data.update(feedback(run))
            run.role(role, data)
            if role not in AUTHORS and role[7:] not in LENSES:
                required(run, role)
            if role == 'revise_select':
                run.export(role, 'concepts.json')
            if role == 'revise_final':
                run.export(role, 'revise_deck.json')
        return {'last_role': role}
    previous = START
    for role in ROLES:
        flow.add_node(role, lambda state, role=role: node(state, role))
        flow.add_edge(previous, role)
        previous = role
    flow.add_edge(previous, END)
    return flow.compile()


def observations(results):
    notes = ['Text-only local references; no DB/exporter, fresh research, importer or synthesized audio.',
        'Source count/length/lightness targets are advisory, never a production-validator pass.',
        'One final refiner owns the unchanged export; no later quality gate, repair or reversion.',
        'Independent drafts/lenses run in sequence with isolated requests, not concurrent provider calls.']
    for role in AUTHORS:
        if results.get(role, {}).get('status') == 'failed':
            notes.append(role+' failed technically; only a surviving usable draft can continue. See selection diagnostics.')
    for lens in LENSES:
        if results.get('revise_'+lens, {}).get('output', {}).get('findings'):
            notes.append(lens+' returned findings; preserved with final author dispositions, not a veto.')
    return notes
