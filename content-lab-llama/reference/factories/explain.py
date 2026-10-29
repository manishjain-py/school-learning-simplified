"""New bounded text-first Explain graph; three distinct final author artifacts."""
import json
from typing import TypedDict
from langgraph.graph import StateGraph, START, END
from ..inputs import ROOT, save, strict_json

NAME = 'explain'
METADATA = {'grade', 'subject', 'mode'}
REQUIRED_METADATA = ('grade', 'subject')
REQUIRES_PAGES = False
FILE_INPUTS = ('guideline', 'research')
LENSES = ('clarity_flow', 'accuracy', 'language_economy')
ROLES = ('explain_research', 'explain_arc', 'explain_writer_1', 'explain_writer_2',
         'explain_selection', 'explain_winner_revision',
         *('explain_'+lens for lens in LENSES), 'explain_prose_final',
         'explain_split', 'explain_split_review', 'explain_split_final',
         'explain_checkins', 'explain_checkin_review', 'explain_checkins_final')
TEXT_ROLES = {'explain_writer_1', 'explain_writer_2', 'explain_winner_revision', 'explain_prose_final'}
ARTIFACT_ROLES = {'explain_research', 'explain_arc', 'explain_split', 'explain_split_final',
                  'explain_checkins', 'explain_checkins_final'}
PROMPTS = {'explain_research': ('misconception_researcher',), 'explain_arc': ('plan_arc',),
    'explain_writer_1': ('writer_continuous',), 'explain_writer_2': ('writer_continuous',),
    'explain_selection': ('judge_continuous',),
    'explain_winner_revision': ('writer_continuous', 'writer_revision'),
    **{'explain_'+lens: ('reviewer_prose',) for lens in LENSES},
    'explain_prose_final': ('refiner_prose',), 'explain_split': ('splitter',),
    'explain_split_review': ('split_reviewer',), 'explain_split_final': ('splitter',),
    'explain_checkins': ('checkin_author',), 'explain_checkin_review': ('checkin_verify',),
    'explain_checkins_final': ('checkin_author',)}
EXPORTS = {'explain_research': 'research.json', 'explain_arc': 'arc.json',
           'explain_prose_final': 'explanation.md', 'explain_split_final': 'deck.json',
           'explain_checkins_final': 'check-ins.json'}


def guideline_view(bundle):
    """Mechanical view of explicit native input or portable Guideline artifact.

    Preserve section order/text exactly; no educational rewriting or source lookup.
    Raw input plus byte identity stays frozen; only these declared fields reach roles.
    """
    source = bundle['declared'].get('guideline')
    if not isinstance(source, dict):
        raise ValueError('Explain requires a JSON guideline artifact, not a receipt/envelope')
    topic = source.get('topic', source.get('chapter_display_name'))
    if not isinstance(topic, str) or not topic.strip():
        raise ValueError('Guideline needs topic or chapter_display_name')
    sections = source.get('sections', [])
    if not isinstance(sections, list):
        raise ValueError('Guideline sections must be an ordered array')
    view_sections, texts = [], []
    for section in sections:
        if not isinstance(section, dict):
            raise ValueError('Guideline section must be an object')
        key = section.get('section_key', section.get('topic_key'))
        title = section.get('title', section.get('topic_title'))
        text = section.get('guideline_text', section.get('guidelines', ''))
        if not all(isinstance(x, str) and x.strip() for x in (key, title, text)):
            raise ValueError('Section needs exact key/title and guideline_text or guidelines')
        prior = section.get('prior_topics_context')
        if prior is not None and not isinstance(prior, str):
            raise ValueError('prior_topics_context must be text or null')
        view_sections.append({'section_key': key, 'title': title, 'guideline_text': text,
                              'prior_topics_context': prior})
        texts.append(text)
    if len({s['section_key'] for s in view_sections}) != len(view_sections):
        raise ValueError('Section keys must be unique for card references')
    text = source.get('guideline_text', '\n\n'.join(texts))
    if not isinstance(text, str) or not text.strip():
        raise ValueError('Guideline needs nonempty guideline_text or section guidelines')
    misconceptions = source.get('misconceptions', [])
    if not isinstance(misconceptions, list) or not all(isinstance(x, str) for x in misconceptions):
        raise ValueError('Guideline misconceptions must be a string array; embedded blocks remain available')
    prior = source.get('prior_topics_context')
    if prior is not None and not isinstance(prior, str):
        raise ValueError('prior_topics_context must be text or null')
    return {'topic': topic, 'grade': bundle['metadata']['grade'], 'subject': bundle['metadata']['subject'],
            'guideline_text': text, 'sections': view_sections, 'misconceptions': misconceptions,
            'prior_topics_context': prior}


def research_view(bundle):
    value = bundle['declared'].get('research')
    if value is None:
        return {'supplied': False, 'fresh_web_research': False,
                'context': 'No external research supplied. Use only the guideline conservatively.', 'citations': []}
    if not isinstance(value, dict) or set(value)-{'context', 'citations'}:
        raise ValueError('Research JSON accepts only context and citations')
    if not isinstance(value.get('context', ''), str) or not isinstance(value.get('citations', []), list):
        raise ValueError('Research needs text context and a citations array')
    for citation in value.get('citations', []):
        if not isinstance(citation, dict) or set(citation)-{'label', 'url', 'excerpt'} or not all(
                isinstance(x, str) for x in citation.values()):
            raise ValueError('Supplied citations accept only text label/url/excerpt')
    return {'supplied': True, 'fresh_web_research': False,
            'context': value.get('context', ''), 'citations': value.get('citations', [])}


def validate_inputs(bundle):
    if bundle['metadata'].get('mode', 'generate') != 'generate':
        raise ValueError('Explain supports only generate; amplify/insert/checkins/enrich are unsupported')
    if bundle['pages']:
        raise ValueError('Explain generate is text-first; supply guideline/research files, no pages')
    if any(spec['type'] != 'json' for spec in bundle['file_identity'].values()):
        raise ValueError('Explain file inputs must be JSON')
    guideline_view(bundle)
    research_view(bundle)


def request(run, role, declared, batch, notes, final):
    if batch or notes or not final:
        raise ValueError('Explain roles use one text-only turn')
    names = (*PROMPTS[role], 'explanation_principles')
    prompt = '\n\n'.join((ROOT/'prompts/explain'/f'{name}.md').read_text() for name in names)
    prompt = prompt.replace('{grade}', str(run.bundle['metadata']['grade']))
    if role in TEXT_ROLES:
        contract = ('Return ONLY one JSON object {"artifact": "complete continuous Markdown prose", '
            '"note": "...", "dispositions": [...]}. Prose is a JSON string, never a file-write receipt. '
            'The host decodes and writes exactly that string, without trimming or appending a newline.')
    elif role in ARTIFACT_ROLES:
        contract = 'Return ONLY one JSON object {"artifact": <complete native JSON object>, ...audit fields}.'
    elif role == 'explain_selection':
        contract = ('Return ONLY a JSON verdict with winner_index (1 or 2), scores, reasons and '
            'concerns [{id,quote,issue,severity,fix?}]. Host copies the chosen prose unchanged. '
            'Do not merge candidates, return replacement prose, or claim a filesystem write.')
    else:
        contract = 'Return ONLY your native review JSON object. No file-write receipts.'
    instructions = [contract, 'No tools or filesystem access are available. All inputs are inline below. '
        'No web search was performed by this runtime; supplied citations are unverified supplied evidence, '
        'never fresh research. Do not invent citations or prevalence statistics. '
        'Read both the top-level misconceptions and every embedded Common Misconceptions block. '
        'The researcher shortlists at most six; zero is valid. '
        'Reviews are advisory, not approvals. There are no quality gates, repeated loops, score cutoffs, '
        'harm reversions or incumbent substitution. Record unresolved findings honestly. '
        'Audio fields are authored spoken scripts only; no speech/media is synthesized here.']
    if role == 'explain_winner_revision':
        instructions.append('Revise YOUR selected draft only; keep its through-line. Account for every concern '
            'by id with applied/declined, reason and verbatim revised evidence. No other draft is supplied.')
    if role.startswith('explain_') and role[8:] in LENSES:
        instructions.append('YOUR ONLY LENS: '+role[8:]+'. Other reviewers and their feedback are hidden.')
    if role == 'explain_prose_final':
        instructions.append('Make ONE final prose revision. Account for every indexed finding and selection '
            'concern, including declined/unanswered ones. This artifact owns final prose. No later prose '
            'review or veto follows; later authors create different artifacts without changing it.')
    if role == 'explain_split_final':
        instructions.append('SPLIT-REVIEW FEEDBACK: make ONE final splitter revision of your previous deck '
            'using all review feedback. Preserve unflagged cards where possible. This artifact owns the deck. '
            'No later split review or quality veto follows. Do not edit final prose.')
    if role == 'explain_checkins_final':
        instructions.append('REVISION FEEDBACK: make ONE final check-in revision using all answer/holistic '
            'feedback. Keep unflagged activities unchanged where possible. This artifact owns check-ins. '
            'Do not change deck cards. No second verifier, validator gate or later quality veto follows.')
    if role in ('explain_split', 'explain_split_final'):
        instructions.append('Native deck: {cards,summary}; cards use contiguous one-based card_idx, '
            'card_type welcome/concept/example/visual/analogy/summary, title, lines [{display,audio}], '
            'visual:null. Welcome first, summary last. For sections copy exact section_key and one-based '
            'section_seq in supplied order. Optional concept_group belongs only to a real worked run. '
            'summary carries key_analogies, key_examples, teaching_notes. Use arc for core/secondary '
            'objectives and coverage_map only; ignore arc moves when shaping cards.')
    payload = {'task_inputs': declared}
    content = [{'text': prompt+'\n\nLOCAL TRANSPORT CONTRACT:\n'+
        '\n'.join(instructions)+'\nDeclared task data:\n'+json.dumps(payload, ensure_ascii=False)}]
    if role == 'explain_research':
        content.append({'text': 'Final research response contract:\n'
            'Return one complete strict JSON object. Its first non-whitespace character must be { '
            'and its last must be }. Put the complete native research JSON object in the '
            'object-valued artifact field, not at the response root or in a string. '
            'Follow the research schema above, including topic, no_real_misconceptions, candidates '
            'and notes. Each candidate uses name, description, evidence_note, evidence_strength, '
            'concrete_disproof, conceptual and prevalence_note as specified above. '
            'The procedure describes work to perform, not headings to narrate in the response. '
            'Keep all narrative, procedure explanations and commentary inside appropriate JSON '
            'string fields, such as artifact.notes or envelope note. No preamble, postscript, '
            'Markdown fences, multiple objects, JSON comments, trailing commas or file-write receipts. '
            'Preserve the existing at-most-six shortlist and honest zero/negative findings and '
            'limitations under the research prompt; do not pad or invent misconceptions, citations, '
            'prevalence statistics or fresh web research.\n'
            'Syntax-only envelope illustration:\n'
            '{"artifact":{}}\n'
            'This illustrates nesting only, not substitute curriculum or permission to omit required '
            'native fields. Replace the empty object with your complete requested research artifact; '
            'do not return an empty or template response.'})
    else:
        if role in TEXT_ROLES:
            shape = ('Put the complete authoritative continuous Markdown prose in artifact as a JSON '
                'STRING, never an object or array. Markdown headings inside that string remain valid. '
                'Escape newlines, double quotes and backslashes correctly for JSON. Keep note and '
                'dispositions as instructed above.\nSyntax-only escaping illustration:\n'
                +json.dumps({'artifact': '## Heading\nHe says "hello".\nC:\\example'})+'\n'
                'This illustrates string escaping only, not replacement prose; supply the complete '
                'requested explanation and existing author fields.')
        elif role == 'explain_arc':
            shape = ('Put the complete native arc JSON object in the object-valued artifact field, '
                'not at the response root or in a string. Preserve the arc schema above and the '
                'existing envelope book_treatment_present boolean and note. Keep design observations '
                'in artifact.design_note or the existing note field.')
        elif role in ('explain_split', 'explain_split_final'):
            shape = ('Put the complete native deck object, including cards and summary, in the '
                'object-valued artifact field, not at the response root or in a string. Follow all '
                'existing card/summary instructions. Keep dispositions and note as instructed above; '
                'put observations only in those existing fields or native summary fields.')
        elif role in ('explain_checkins', 'explain_checkins_final'):
            shape = ('Put the complete native check-in object with its check_ins array in the '
                'object-valued artifact field, not at the response root or in a string. Preserve '
                'all existing activity fields and per-type instructions. Keep dispositions and note '
                'as instructed above; put author observations only in those existing fields.')
        elif role == 'explain_selection':
            shape = ('Return the native verdict at the JSON root: integer winner_index (1 or 2), '
                'per-candidate scores, reasons and concerns as instructed above. Do not wrap the '
                'verdict in artifact or return replacement prose. Keep explanations in the existing '
                'reasons and concern fields; an empty concerns array remains valid.')
        elif role == 'explain_split_review':
            shape = ('Return the native review object at the JSON root with the existing boolean '
                'ok, findings array and note. Do not wrap the review in artifact. Keep explanations '
                'in existing finding fields or note. Preserve negative findings; empty findings '
                'remain valid. The verdict remains advisory.')
        elif role == 'explain_checkin_review':
            shape = ('Return the native review object at the JSON root with the existing wrong '
                'array, boolean holistic_pass, holistic_issues array and comment. Do not wrap the '
                'review in artifact. Keep explanations in existing problem/fix, issue or comment '
                'fields. Preserve negative findings; empty arrays remain valid. The opinion '
                'remains advisory.')
        else:  # the three independent prose-review lenses
            shape = ('Return the native review object at the JSON root with its findings array, '
                'not an artifact envelope. Follow your existing lens and finding schema. Keep '
                'explanations only in existing finding string fields. Preserve negative findings; '
                'an empty findings array remains valid. Do not invent findings to fill it.')
        content.append({'text': 'Final response contract for '+role+':\n'
            'Return one complete strict JSON object. Its first non-whitespace character must be { '
            'and its last must be }. '+shape+'\n'
            'Perform the requested work without procedure narration outside JSON. No preamble, '
            'postscript, response headings, Markdown fences, surrounding prose, multiple objects, '
            'JSON comments, trailing commas or file-write receipts. Put notes only in fields '
            'allowed by this role\'s existing instructions; preserve all native schema and content '
            'instructions above.'})
    request = {'messages': [{'role': 'user', 'content': content}]}
    if role in ('explain_research', 'explain_winner_revision'):
        request['system'] = [{'text': content[-1]['text']}]
    return request


def parse(role, text, notes_pages=None):
    value = strict_json(text)
    if not isinstance(value, dict):
        raise ValueError('Role response must be a JSON object')
    if role in TEXT_ROLES and (not isinstance(value.get('artifact'), str) or not value['artifact'].strip()):
        raise ValueError('Missing nonempty Markdown artifact string; no prose invented')
    if role in ARTIFACT_ROLES and not isinstance(value.get('artifact'), dict):
        raise ValueError('Missing JSON artifact object; no content invented or moved')
    if role == 'explain_selection' and (type(value.get('winner_index')) is not int or value['winner_index'] not in (1, 2)):
        raise ValueError('Selection needs candidate index 1 or 2')
    if role[8:] in LENSES or role == 'explain_split_review':
        if not isinstance(value.get('findings'), list):
            raise ValueError('Review needs a findings array; empty is valid')
    if role == 'explain_checkin_review':
        if (not isinstance(value.get('wrong'), list) or not isinstance(value.get('holistic_issues'), list)
                or type(value.get('holistic_pass')) is not bool):
            raise ValueError('Check-in review needs wrong/holistic_issues arrays and holistic_pass opinion')
    # No native-shape/quality veto on a final author's parseable artifact.
    return value


def required(run, role):
    output = run.output(role)
    if 'technical_failure' in output:
        raise ValueError(f'{role}: required stage unavailable; no substitute output')
    return output


def selected(run):
    index = required(run, 'explain_selection')['winner_index']
    return required(run, f'explain_writer_{index}')['artifact']


def declared(run, role):
    guideline = guideline_view(run.bundle)
    base = {'guideline': guideline, 'supplied_research': research_view(run.bundle)}
    if role == 'explain_research':
        return base
    base['misconception_research'] = required(run, 'explain_research')['artifact']
    if role == 'explain_arc':
        return base
    base['arc'] = required(run, 'explain_arc')['artifact']
    if role in ('explain_writer_1', 'explain_writer_2'):
        return base  # independent requests; neither sees the other writer's response
    if role == 'explain_selection':
        return {**base, 'candidates': [{'index': i, 'prose': required(run, f'explain_writer_{i}')['artifact']}
                                      for i in (1, 2)]}  # no writer notes, identity or paths
    if role == 'explain_winner_revision':
        index = required(run, 'explain_selection')['winner_index']
        return {**base, 'your_draft': selected(run),
                'your_note': required(run, f'explain_writer_{index}').get('note'),
                'selection_concerns': required(run, 'explain_selection').get('concerns', [])}
    if role[8:] in LENSES:
        return {**base, 'prose': required(run, 'explain_winner_revision')['artifact'],
                'selection_concerns': required(run, 'explain_selection').get('concerns', []),
                'winner_dispositions': required(run, 'explain_winner_revision').get('dispositions', [])}
    if role == 'explain_prose_final':
        reviews = {lens: required(run, 'explain_'+lens) for lens in LENSES}
        findings = []
        for lens, review in reviews.items():
            for finding in review.get('findings', []) if isinstance(review.get('findings'), list) else []:
                findings.append({**(finding if isinstance(finding, dict) else {'observation': finding}),
                                 'index': len(findings), 'review_lens': lens})
        return {**base, 'prose': required(run, 'explain_winner_revision')['artifact'],
                'selection_concerns': required(run, 'explain_selection').get('concerns', []),
                'winner_dispositions': required(run, 'explain_winner_revision').get('dispositions', []),
                'reviews': reviews, 'indexed_findings': findings}
    # Final prose is never replaced by a splitter or check-in author.
    base['final_prose'] = required(run, 'explain_prose_final')['artifact']
    if role == 'explain_split':
        return base
    if role in ('explain_split_review', 'explain_split_final'):
        return {**base, 'draft_deck': required(run, 'explain_split')['artifact'],
                'prose_dispositions': required(run, 'explain_prose_final').get('dispositions', []),
                'prior_prose_feedback': {lens: required(run, 'explain_'+lens) for lens in LENSES},
                **({'split_review': required(run, 'explain_split_review')} if role == 'explain_split_final' else {})}
    # Check-in roles get the settled deck and guideline, not prose drafts/arc/reviews.
    checkin_base = {'guideline': guideline, 'deck': required(run, 'explain_split_final')['artifact']}
    if role == 'explain_checkins':
        return checkin_base
    return {**checkin_base, 'draft_check_ins': required(run, 'explain_checkins')['artifact'],
            **({'checkin_review': required(run, 'explain_checkin_review')} if role == 'explain_checkins_final' else {})}


def graph(run):
    validate_inputs(run.bundle)
    save(run.workspace/'views/guideline.json', guideline_view(run.bundle))
    save(run.workspace/'views/research.json', research_view(run.bundle))

    class State(TypedDict):
        last_role: str
    flow = StateGraph(State)
    previous = START
    for role in ROLES:
        def node(state, role=role):
            run.role(role, declared(run, role))
            output = required(run, role)
            if role in TEXT_ROLES:
                save(run.workspace/'metrics'/f'{role}.json', {'role': role,
                    'word_count': len(output['artifact'].split()),
                    'method': 'Host Unicode whitespace split; bookkeeping only, no quality threshold.'})
            if role == 'explain_selection':
                # Export the actual chosen author's string, ignoring any selector rewrite.
                index = required(run, role)['winner_index']
                run.export(f'explain_writer_{index}', 'selected-draft.md')
            if role in EXPORTS:
                run.export(role, EXPORTS[role])
            return {'last_role': role}
        flow.add_node(role, node)
        flow.add_edge(previous, role)
        previous = role
    flow.add_edge(previous, END)
    return flow.compile()


def observations(results):
    notes = ['Text-first generate only; no original images or fresh web research. Supplied research is unverified input.',
        'Prose refiner, final splitter and final check-in author own separate unchanged artifacts. No later quality veto.',
        'Audio fields are spoken scripts only; speech/visual synthesis is not implemented here.',
        'Native artifact shape, section references, cadence and answer correctness remain author/review responsibilities; '
        'parseable imperfections are preserved. Technical output failures are not repaired or replaced.']
    for role in ('explain_clarity_flow', 'explain_accuracy', 'explain_language_economy',
                 'explain_split_review', 'explain_checkin_review'):
        output = results.get(role, {}).get('output', {})
        if output.get('ok') is False or output.get('holistic_pass') is False or output.get('findings') or output.get('wrong'):
            notes.append(f'{role} returned negative feedback; see its full evidence and final author dispositions.')
    return notes
