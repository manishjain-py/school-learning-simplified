"""Local seed/growth graph. Allocation/dedupe precede the authoritative final author."""
from collections import Counter
from fractions import Fraction
import json
import re
from typing import TypedDict
from langgraph.graph import StateGraph, START, END
from ..inputs import ROOT, canonical, read, save, sha, strict_json
from .explain import guideline_view

NAME = 'practice'
METADATA = {'grade', 'subject', 'mode', 'add', 'target', 'run_cap'}
REQUIRED_METADATA = ('grade', 'subject', 'run_cap')
REQUIRES_PAGES = False
FILE_INPUTS = ('guideline', 'deck', 'bank', 'blueprint')
ROLES = ('practice_blueprint', 'practice_review', 'practice_final')
FORMATS = ('pick_one', 'true_false', 'fill_blank', 'multi_select')
QUESTION_FIELDS = ('format', 'difficulty', 'concept_tag', 'question_text', 'explanation_why',
                   'audio_text', 'skill_key', 'signature', 'params', 'statement', 'options',
                   'correct_index', 'correct_answer_bool', 'correct_indices')
SKILL_FIELDS = ('skill_key', 'section_key', 'title', 'objective', 'what_to_test', 'formats',
                'difficulty_notes', 'misconceptions', 'parameter_space', 'weight', 'taught_method')
DIGEST_FIELDS = ('vocabulary', 'step_labels', 'methods_conventions', 'contexts_used', 'board_titles')


def norm(value):
    return ' '.join(value.split()).lower() if isinstance(value, str) else ''


def questions(value):
    if not isinstance(value, dict) or not isinstance(value.get('questions'), list) or not all(
            isinstance(q, dict) for q in value['questions']):
        raise ValueError('Question pack requires an object-valued questions array')
    return value['questions']


def bank_view(bundle):
    rows = questions(bundle['declared'].get('bank', {'questions': []}))
    for q in rows:
        if (not norm(q.get('skill_key')) or not norm(q.get('signature')) or not isinstance(q.get('params'), dict)
                or q.get('difficulty') not in ('easy', 'medium', 'hard') or not norm(q.get('question_text'))):
            raise ValueError('Bank requires already-labelled rows with difficulty/text; legacy backfill is unsupported')
    return [{k: q[k] for k in QUESTION_FIELDS if k in q} for q in rows]


def deck_view(bundle):
    deck = bundle['declared'].get('deck')
    if not isinstance(deck, dict) or not isinstance(deck.get('cards'), list) or not deck['cards']:
        raise ValueError('Practice requires a nonempty native Explain deck cards array')
    cards = []
    for card in deck['cards']:
        if not isinstance(card, dict) or not isinstance(card.get('lines'), list) or not all(
                isinstance(line, dict) and isinstance(line.get('display'), str) and
                isinstance(line.get('audio'), str) for line in card['lines']):
            raise ValueError('Deck cards require native display/audio lines')
        cards.append({**{k: card[k] for k in ('card_idx', 'card_type', 'title', 'section_key',
            'section_seq', 'concept_group', 'step_label') if k in card},
            'lines': [{k: line[k] for k in ('display', 'audio')} for line in card['lines']]})
    return {'cards': cards}  # visual code, media paths, IDs and unknown metadata are not task inputs


def source_hashes(bundle):
    return {k+'_sha256': bundle['file_identity'][k]['sha256'] for k in ('guideline', 'deck')}


def blueprint_view(value, sections):
    """Require usable allocation data, not full-chapter pedagogical/count floors."""
    if not isinstance(value, dict) or not isinstance(value.get('skills'), list) or not value['skills']:
        raise ValueError('Blueprint needs nonempty usable skills for allocation')
    keys, skills = set(), []
    for skill in value['skills']:
        if not isinstance(skill, dict):
            raise ValueError('Blueprint skill must be an object')
        key, section = skill.get('skill_key'), skill.get('section_key')
        if (section not in sections or not isinstance(key, str) or key in keys or
                not key.startswith(section+'--') or not re.fullmatch(r'[a-z0-9]+(?:-[a-z0-9]+)*', key[len(section)+2:])):
            raise ValueError('Blueprint needs unique section-linked skill keys')
        if type(skill.get('weight')) is not int or skill['weight'] not in (1, 2, 3):
            raise ValueError('Skill weight must be integer 1–3')
        if (not isinstance(skill.get('formats'), list) or not skill['formats'] or
                any(f not in FORMATS for f in skill['formats'])):
            raise ValueError('Skill formats must use the four supported native formats')
        for field in ('title', 'objective', 'what_to_test', 'parameter_space'):
            if not isinstance(skill.get(field), str) or not skill[field].strip():
                raise ValueError('Skill requires usable '+field)
        if (not isinstance(skill.get('difficulty_notes'), dict) or not all(
                isinstance(skill['difficulty_notes'].get(t), str) for t in ('easy', 'medium')) or
                not isinstance(skill.get('misconceptions'), list) or not all(isinstance(x, str) for x in skill['misconceptions'])):
            raise ValueError('Skill requires easy/medium notes and misconceptions array')
        keys.add(key)
        skills.append({k: skill[k] for k in SKILL_FIELDS if k in skill})
    digest = value.get('digest')
    if not isinstance(digest, dict) or any(k not in digest for k in DIGEST_FIELDS):
        raise ValueError('Blueprint needs the documented deck digest fields')
    if not isinstance(digest['step_labels'], dict) or not all(isinstance(v, list) and all(
            isinstance(x, str) for x in v) for v in digest['step_labels'].values()) or not all(
            isinstance(digest[k], list) and all(isinstance(x, str) for x in digest[k]) for k in DIGEST_FIELDS if k != 'step_labels'):
        raise ValueError('Digest needs text arrays and a step-label map')
    themes = value.get('theme_wheel')
    if not isinstance(themes, list) or not themes or not all(isinstance(x, str) and x.strip() for x in themes):
        raise ValueError('Blueprint needs nonempty theme hints; no 8–12 count floor')
    return {'skills': skills, 'digest': {k: digest[k] for k in DIGEST_FIELDS}, 'theme_wheel': themes}


def cached_blueprint(bundle):
    if 'blueprint' not in bundle['declared']:
        return None
    cache = bundle['declared']['blueprint']
    if not isinstance(cache, dict) or cache.get('source_hashes') != source_hashes(bundle):
        raise ValueError('Cached blueprint guideline/deck hashes must match exact input file bytes')
    blueprint_view(cache.get('blueprint'), {s['section_key'] for s in guideline_view(bundle)['sections']})
    return cache['blueprint']


def wanted(bundle, count):
    metadata = bundle['metadata']
    return metadata['add'] if 'add' in metadata else max(0, metadata['target']-count)


def validate_inputs(bundle):
    meta = bundle['metadata']
    if meta.get('mode', 'seed-growth') != 'seed-growth':
        raise ValueError('Only seed-growth is supported; exact-add/backfill/adoptBatch are unsupported')
    if bundle['pages'] or any(s['type'] != 'json' for s in bundle['file_identity'].values()):
        raise ValueError('Practice accepts text-only JSON file inputs, no pages')
    if type(meta.get('run_cap')) is not int or not 1 <= meta['run_cap'] <= 200:
        raise ValueError('Explicit run_cap must be an integer 1–200')
    if ('add' in meta) == ('target' in meta) or any(type(meta[k]) is not int or meta[k] < 0 for k in ('add', 'target') if k in meta):
        raise ValueError('Choose exactly one nonnegative integer add or target')
    if not guideline_view(bundle)['sections']:
        raise ValueError('Practice requires explicit guideline sections; no keys invented')
    deck_view(bundle)
    bank = bank_view(bundle)
    if wanted(bundle, len(bank)) > meta['run_cap']:
        raise ValueError('Requested addition exceeds explicit run_cap; no silent truncation')
    cached_blueprint(bundle)


def census(rows):
    by_skill = {}
    tiers = Counter({'easy': 0, 'medium': 0, 'hard': 0})
    for q in rows:
        key, tier = norm(q['skill_key']), q['difficulty']
        by_skill.setdefault(key, {'easy': 0, 'medium': 0, 'hard': 0})[tier] += 1
        tiers[tier] += 1
    return {'active_total': len(rows), 'by_skill': by_skill, 'active_by_difficulty': dict(tiers)}


def largest_remainder(weights, total):
    if total <= 0 or not sum(weights):
        return [0]*len(weights)
    raw = [Fraction(w)*total/sum(weights) for w in weights]
    out = [v.numerator//v.denominator for v in raw]
    order = sorted(range(len(weights)), key=lambda i: (-(raw[i]-out[i]), i))
    for i in order[:total-sum(out)]:
        out[i] += 1
    return out


def allocate(blueprint, count, have):
    """New local behavior implementation: weighted future-bank deficits; global tier deal."""
    skills = blueprint['skills']
    future = have['active_total']+count
    weight_sum = sum(s['weight'] for s in skills)
    ranked = []
    for skill in skills:
        total = sum(have['by_skill'].get(norm(skill['skill_key']), {}).values())
        deficit = max(Fraction(0), Fraction(skill['weight']*future, weight_sum)-total)
        ranked.append((skill, deficit))
    ranked.sort(key=lambda pair: (-pair[1], -pair[0]['weight'], pair[0]['skill_key']))
    any_deficit = any(d > 0 for _, d in ranked)
    pool = [p for p in ranked if p[1] > 0] if any_deficit else ranked
    pool = pool[:max(1, min(len(skills), count//3 or 1))]
    per_skill = largest_remainder([d if any_deficit else s['weight'] for s, d in pool], count)
    tier_deficits = [max(Fraction(0), ratio*future-have['active_by_difficulty'][tier])
                     for tier, ratio in (('easy', Fraction(2, 5)), ('medium', Fraction(3, 5)))]
    tier_counts = largest_remainder(tier_deficits if any(tier_deficits) else [2, 3], count)
    remaining = dict(zip(('easy', 'medium'), tier_counts))
    slots = []
    for (skill, deficit), quota in zip(pool, per_skill):
        while quota:
            n = min(8, quota)
            quota -= n
            difficulty = {'easy': 0, 'medium': 0}
            for _ in range(n):
                tier = max(('medium', 'easy'), key=lambda t: remaining[t])
                remaining[tier] -= 1
                difficulty[tier] += 1
            i = len(slots)
            menu = list(dict.fromkeys([*skill['formats'], 'multi_select']))
            rotation = i % len(menu)
            wheel = blueprint['theme_wheel']
            themes = list(dict.fromkeys(wheel[(i*2+o) % len(wheel)] for o in (0, 3, 6)))
            slots.append({'slot_id': f'practice_slot_{i+1}', 'skill_key': skill['skill_key'],
                'section_key': skill['section_key'], 'count': n, 'difficulty': difficulty,
                'formats': menu[rotation:]+menu[:rotation], 'themes': themes})
    return slots


def identity(q):
    return norm(q.get('statement')) if q.get('format') == 'true_false' and norm(q.get('statement')) else norm(q.get('question_text'))


def params_key(q):
    return (norm(q.get('skill_key')), canonical(q['params'])) if q.get('params') else None


def dedupe(drafts, bank):
    seen = [set(), set(), set()]
    def keys(q):
        return identity(q), norm(q.get('signature')), params_key(q)
    for q in bank:
        for store, key in zip(seen, keys(q)):
            if key:
                store.add(key)
    kept, drops = [], []
    for i, q in enumerate(drafts):
        values = keys(q)
        reason = next((label for store, key, label in zip(seen, values,
            ('question_identity', 'signature', 'skill_params')) if key and key in store), None)
        if reason:
            drops.append({'draft_index': i, 'original_signature': q.get('signature'), 'reason': reason})
            continue
        kept.append(q)
        for store, key in zip(seen, values):
            if key:
                store.add(key)
    return {'questions': kept}, {'input_count': len(drafts), 'kept': len(kept), 'dropped': len(drops), 'drop_reasons': drops}


def locate_findings(batch, review):
    """Exact ORIGINAL signatures only; caption fallback would be ambiguous."""
    rows = questions(batch)
    return [{'finding_index': i, 'original_signature': f.get('signature') if isinstance(f, dict) else None,
             'question_indices': matches, 'resolution': 'unique' if len(matches) == 1 else 'unmatched' if not matches else 'ambiguous'}
        for i, f in enumerate(review['wrong'])
        for matches in [[j for j, q in enumerate(rows) if isinstance(f, dict) and isinstance(f.get('signature'), str)
                          and q.get('signature') == f['signature']]]]


def request(run, role, declared, batch, notes, final):
    if batch or notes or not final:
        raise ValueError('Practice roles use exactly one text-only turn')
    name = 'slot_author' if role.startswith('practice_slot_') else {
        'practice_blueprint': 'blueprint_author', 'practice_review': 'batch_verify', 'practice_final': 'batch_fixer'}[role]
    prompt = (ROOT/'prompts/practice'/f'{name}.md').read_text().replace('{grade}', str(run.bundle['metadata']['grade']))
    contract = ('Return ONLY one JSON feedback object with wrong array (original signature locators), '
        'holistic_pass boolean, holistic_issues array and optional comment.' if role == 'practice_review' else
        'Return ONLY one JSON object {"artifact": <complete native JSON object>, "note":"...", "dispositions":[...]}.')
    contract += (' No tools, file paths, services or external research. Native Practice uses correct_answer_bool '
        'for true_false, never Explain correct_answer; zero-based correct_index/correct_indices; exact-set multi_select. '
        'Questions include format, difficulty easy/medium, concept_tag, question_text, explanation_why, answer-free '
        'audio_text, skill_key, signature, params. Signature: four nonempty lowercase pipe-separated parts, <=120 '
        'characters; numeric params {numbers:[...]}, otherwise {}. Spoken scripts are not synthesized audio.')
    return {'messages': [{'role': 'user', 'content': [{'text': prompt+'\n\nLOCAL TRANSPORT CONTRACT:\n'+contract+
        '\nDeclared task data:\n'+json.dumps({'task_inputs': declared}, ensure_ascii=False)}]}]}


def parse(role, text, notes_pages=None):
    value = strict_json(text)
    if not isinstance(value, dict):
        raise ValueError('Role response must be a JSON object')
    if role == 'practice_review':
        if not isinstance(value.get('wrong'), list) or not isinstance(value.get('holistic_issues'), list) or type(value.get('holistic_pass')) is not bool:
            raise ValueError('Review requires wrong/holistic_issues arrays and holistic_pass boolean opinion')
    elif not isinstance(value.get('artifact'), dict):
        raise ValueError('Missing object-valued artifact; no content invented')
    # Final native content is deliberately not validated, filtered, repaired or count-gated.
    return value


def required(run, role):
    value = run.output(role)
    if 'technical_failure' in value:
        raise ValueError(role+': required stage unavailable; no substitute content')
    return value


def report_roles(workspace):
    metrics = workspace/'metrics/practice-run.json'
    if metrics.exists() and read(metrics).get('status') == 'no_op':
        return ()
    bundle = read(workspace/'inputs.json')
    allocation = workspace/'diagnostics/allocation.json'
    slots = read(allocation)['slots'] if allocation.exists() else []
    return (*(() if 'blueprint' in bundle['declared'] else ('practice_blueprint',)),
            *(s['slot_id'] for s in slots), 'practice_review', 'practice_final')


def graph(run):
    validate_inputs(run.bundle)
    guideline, deck, bank = guideline_view(run.bundle), deck_view(run.bundle), bank_view(run.bundle)
    class State(TypedDict):
        last_role: str
        slot_index: int
        no_op: bool
    flow = StateGraph(State)
    def census_node(state):
        have = census(bank)
        count = wanted(run.bundle, len(bank))
        save(run.workspace/'diagnostics/census.json', have)
        for name, value in (('guideline', guideline), ('deck', deck), ('bank', {'questions': bank})):
            save(run.workspace/'views'/f'{name}.json', value)
        if not count:
            save(run.workspace/'artifacts/questions.json', {'questions': []})
            save(run.workspace/'artifacts/bank-snapshot.json', run.bundle['declared'].get('bank', {'questions': []}))
            save(run.workspace/'metrics/practice-run.json', {'status': 'no_op', 'existing_count': len(bank),
                'requested_addition': 0, 'reason': 'Target already reached or explicit add zero; no content roles invoked.'})
        return {'no_op': count == 0, 'slot_index': 0, 'last_role': 'census'}
    def blueprint_node(state):
        artifact = cached_blueprint(run.bundle)
        if artifact is None:
            run.role('practice_blueprint', {'guideline': guideline, 'deck': deck})
            artifact = required(run, 'practice_blueprint')['artifact']
        save(run.workspace/'artifacts/blueprint.json', artifact)
        save(run.workspace/'artifacts/blueprint-cache.json', {'source_hashes': source_hashes(run.bundle), 'blueprint': artifact})
        return {'last_role': 'blueprint'}
    def allocation_node(state):
        artifact = read(run.workspace/'artifacts/blueprint.json')
        blueprint = blueprint_view(artifact, {s['section_key'] for s in guideline['sections']})
        slots = allocate(blueprint, wanted(run.bundle, len(bank)), census(bank))
        save(run.workspace/'views/blueprint.json', blueprint)
        save(run.workspace/'diagnostics/allocation.json', {'slots': slots,
            'requested_addition': wanted(run.bundle, len(bank)), 'method': 'Future-bank weighted deficits, largest remainder, global 40/60 tier deal; slots <=8; focus >=3 where possible.'})
        return {'last_role': 'allocation'}
    def author_node(state):
        slot = read(run.workspace/'diagnostics/allocation.json')['slots'][state['slot_index']]
        blueprint = read(run.workspace/'views/blueprint.json')
        skill = next(s for s in blueprint['skills'] if s['skill_key'] == slot['skill_key'])
        section = next(s for s in guideline['sections'] if s['section_key'] == slot['section_key'])
        run.role(slot['slot_id'], {'grade': guideline['grade'], 'subject': guideline['subject'], 'topic': guideline['topic'],
            'skill': skill, 'guideline_section': section, 'digest': blueprint['digest'], 'quota': slot,
            'existing_signatures': [q['signature'] for q in bank if norm(q['skill_key']) == norm(skill['skill_key'])]})
        questions(required(run, slot['slot_id'])['artifact'])  # unusable draft structure is a technical failure before merge
        return {'slot_index': state['slot_index']+1, 'last_role': slot['slot_id']}
    def merge_node(state):
        slots = read(run.workspace/'diagnostics/allocation.json')['slots']
        drafts = [q for s in slots for q in questions(required(run, s['slot_id'])['artifact'])]
        batch, diagnostics = dedupe(drafts, bank)
        save(run.workspace/'views/merged-draft.json', batch)
        save(run.workspace/'diagnostics/dedupe.json', diagnostics)
        return {'last_role': 'merge_dedupe'}
    def review_node(state):
        run.role('practice_review', {'guideline': guideline, 'blueprint': read(run.workspace/'views/blueprint.json'),
            'batch': read(run.workspace/'views/merged-draft.json')})
        required(run, 'practice_review')
        return {'last_role': 'practice_review'}
    def final_node(state):
        batch, review = read(run.workspace/'views/merged-draft.json'), required(run, 'practice_review')
        locators = locate_findings(batch, review)
        save(run.workspace/'diagnostics/review-locators.json', {'locators': locators})
        run.role('practice_final', {'guideline': guideline, 'blueprint': read(run.workspace/'views/blueprint.json'),
            'batch': batch, 'review': review, 'original_signature_locators': locators})
        required(run, 'practice_final')
        return {'last_role': 'practice_final'}
    def export_node(state):
        artifact = required(run, 'practice_final')['artifact']
        run.export('practice_final', 'questions.json')
        rows = artifact.get('questions')
        count = len(rows) if isinstance(rows, list) else None
        requested = wanted(run.bundle, len(bank))
        save(run.workspace/'metrics/practice-run.json', {'status': 'final_author_exported', 'requested_addition': requested,
            'existing_count': len(bank), 'final_count': count, 'shortfall': max(0, requested-count) if count is not None else None,
            'count_note': 'Bookkeeping only; no post-final review/filter/reversion/repair/exact-count hold. Native malformed content remains author output.'})
        if isinstance(rows, list):
            original = run.bundle['declared'].get('bank', {'questions': []})
            save(run.workspace/'artifacts/bank-snapshot.json', {**original, 'questions': [*original['questions'], *rows]})
        return {'last_role': 'export'}
    for name, node in [('census', census_node), ('blueprint', blueprint_node), ('allocation', allocation_node),
                       ('slot_author', author_node), ('merge_dedupe', merge_node), ('review', review_node),
                       ('final_author', final_node), ('export', export_node)]:
        flow.add_node(name, node)
    flow.add_edge(START, 'census')
    flow.add_conditional_edges('census', lambda s: 'done' if s['no_op'] else 'grow', {'done': END, 'grow': 'blueprint'})
    flow.add_edge('blueprint', 'allocation')
    flow.add_edge('allocation', 'slot_author')
    flow.add_conditional_edges('slot_author', lambda s: 'more' if s['slot_index'] < len(
        read(run.workspace/'diagnostics/allocation.json')['slots']) else 'merge', {'more': 'slot_author', 'merge': 'merge_dedupe'})
    flow.add_edge('merge_dedupe', 'review')
    flow.add_edge('review', 'final_author')
    flow.add_edge('final_author', 'export')
    flow.add_edge('export', END)
    # Explicit cap bounds repeated slot nodes; LangGraph's default recursion limit is too small for 200 additions.
    return flow.compile().with_config({'recursion_limit': 100})


def observations(results):
    notes = ['Seed/growth local reference only. Exact-add completion loops, legacy backfill and adoptBatch are unsupported.',
        'Allocation and deterministic identity/signature/nonempty-params dedupe run before review/final revision.',
        'Tiny-MVP skill/theme count floors are relaxed; no canonical production validator pass is claimed.',
        'Final returned pack is unchanged and authoritative. Shortfalls, duplicates or disagreements after final revision are not filtered or repaired.',
        'English answer-bearing pack is retained for later trusted Translate projections; audio_text is a script, not speech.']
    review = results.get('practice_review', {}).get('output', {})
    if review.get('wrong') or review.get('holistic_pass') is False:
        notes.append('Independent batch review returned negative feedback; see original-signature locators and final dispositions.')
    return notes
