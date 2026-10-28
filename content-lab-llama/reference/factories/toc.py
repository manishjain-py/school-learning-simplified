"""New TOC graph: original images, independent reread, feedback, final author."""
import json
from typing import TypedDict
from langgraph.graph import StateGraph, START, END
from ..inputs import ROOT, canonical, read, save, strict_json

NAME = 'toc'
METADATA = {'title', 'grade', 'subject'}
REQUIRED_METADATA = ('title', 'grade', 'subject')
FILE_INPUTS = ()  # No shared OCR, chapter-range context or undisclosed file inputs.
ROLES = ('toc_draft', 'toc_image_read', 'toc_review', 'toc_revision')


def request(run, role, declared, batch, notes, final):
    reviewer = role in ('toc_image_read', 'toc_review')
    prompt = (ROOT/'prompts'/('toc_verifier.md' if reviewer else 'toc_extractor.md')).read_text()
    if role == 'toc_image_read':
        if declared:
            raise ValueError('Image-first reviewer cannot receive a draft or shared notes')
        prompt += ('\nIMAGE-ONLY FIRST READING: No extractor map is available at this stage. '
            'Read the originals independently, recording printed entries, numbering, titles, ranges, '
            'dividers, supplementary notes and uncertainty. Do not infer contents from other roles.')
    if role == 'toc_image_read' or not final:
        prompt += ('\nReturn ONLY {"page_notes":[{"printed_page": <exact supplied integer or string label>, '
            '"observations": "your direct observations and uncertainties"}]} with one entry for each '
            'currently attached image in order, at most 1200 words total. Do not return a map or review yet. '
            'This stage-specific output contract overrides the usual output contract.')
    else:
        prompt += ('\nReturn one JSON object only. Extractor draft/revision: {"artifact": '
            '{"chapters": [...], "source_note": "images read and disclosed inferences"}, ...audit fields}. '
            'Review: {"ok": boolean, "findings": [{"chapter_number": integer or null, '
            '"issue": string, "evidence": string, "fix": string}], "note": string}. '
            'The host writes files and counts entries; do not claim files were written.')
    prompt += ('\nUse only selected contents images and title/grade/subject metadata. Printed image labels '
        'retain their types and order: Roman strings are not Arabic body-page integers. Earlier images '
        'are represented only by this role\'s own notes, never shared OCR or simultaneous visual access. '
        'Keep every real teaching chapter in reading order; skip dividers/front/back matter. '
        'For start-only entries use next start minus one for nonfinal ends; disclose any estimated final end. '
        'Source contiguity instructions and explicit printed noncontiguous ranges can conflict: preserve '
        'image evidence and explain uncertainty instead of silently fabricating coverage.')
    if role == 'toc_review':
        prompt += ('\nYour image-first notes were completed before seeing the draft. Compare using those '
            'notes and the originals now supplied. These notes are this same reviewer\'s observations.')
    if role == 'toc_revision':
        prompt += ('\nMake ONE final extractor revision using the original images, your draft and the '
            'review/structural observations. Feedback is advisory; explain unresolved uncertainty. '
            'Your returned artifact is authoritative. No later quality review or veto follows.')
    payload = {'metadata': run.bundle['metadata'],
        'source_printed_pages': [p['printed_page'] for p in run.bundle['pages']],
        'task_inputs': declared, 'role_local_page_notes': notes}
    content = [{'text': prompt+'\nDeclared task data:\n'+json.dumps(payload, ensure_ascii=False)}]
    for page in batch:
        content.extend([{'text': 'Original printed page '+json.dumps(page['printed_page'])+':'},
            {'image': {'format': page['format'], 'source': {'bytes': run.blobs[page['file']]}}}])
    return {'messages': [{'role': 'user', 'content': content}]}


def parse(role, text, notes_pages=None):
    value = strict_json(text)
    if not isinstance(value, dict):
        raise ValueError('Role response must be a JSON object')
    if notes_pages is not None:
        notes = value.get('page_notes')
        if not isinstance(notes, list) or not all(isinstance(n, dict) for n in notes):
            raise ValueError('Missing current-page notes')
        if canonical([n.get('printed_page') for n in notes]) != canonical(notes_pages):
            raise ValueError('Missing ordered, exactly typed current-page labels')
        if not all(isinstance(n.get('observations'), str) and n['observations'].strip() for n in notes):
            raise ValueError('Missing page observations')
    elif role in ('toc_draft', 'toc_revision') and not isinstance(value.get('artifact'), dict):
        raise ValueError('Missing JSON artifact envelope; no content invented or moved')
    # Chapter shape/quality and review disagreement are observations, never a final veto.
    return value


def required_output(run, role):
    output = run.output(role)
    if 'technical_failure' in output:
        raise ValueError(f'{role}: required stage unavailable; no substitute output')
    return output


def image_first_read(run):
    """The reviewer sees every original before any draft leakage, even one batch."""
    pages, notes = run.bundle['pages'], []
    limit = run.config['image_limit']
    for index, offset in enumerate(range(0, len(pages), limit)):
        batch = pages[offset:offset+limit]
        final = offset+limit >= len(pages)
        key = 'toc_image_read' if final else f'toc_image_read__batch_{index+1}'
        labels = [p['printed_page'] for p in batch]
        result = run.invoke(key, 'toc_image_read',
            request(run, 'toc_image_read', {}, batch, notes, final),
            lambda text: parse('toc_image_read', text, labels), notes_pages=labels)
        if result['status'] != 'ok':
            raise ValueError('Independent original-image reading failed; no draft comparison')
        notes.extend(result['output']['page_notes'])
    return notes


def diagnostics(artifact):
    """New local draft observations; no sorting, coercion, source validator or gate."""
    chapters = artifact.get('chapters')
    issues, seen, previous_end = [], set(), None
    if not isinstance(chapters, list) or not chapters:
        issues.append('Draft chapters are absent, non-list or empty.')
        chapters = chapters if isinstance(chapters, list) else []
    for index, chapter in enumerate(chapters, 1):
        if not isinstance(chapter, dict):
            issues.append(f'Entry {index} is not an object.')
            previous_end = None
            continue
        number = chapter.get('chapter_number')
        if type(number) is not int or number != index:
            issues.append(f'Entry {index}: numbering is not sequential in reading order.')
        title = chapter.get('chapter_title')
        if not isinstance(title, str) or not title.strip():
            issues.append(f'Entry {index}: empty or non-string title.')
        elif title.strip().casefold() in seen:
            issues.append(f'Entry {index}: duplicate title.')
        else:
            seen.add(title.strip().casefold())
        start, end = chapter.get('start_page'), chapter.get('end_page')
        if type(start) is not int or type(end) is not int or start <= 0 or end < start:
            issues.append(f'Entry {index}: expected positive inclusive integer range.')
            previous_end = None
            continue
        if previous_end is not None:
            if start <= previous_end:
                issues.append(f'Entry {index}: overlaps previous range.')
            elif start > previous_end+1:
                issues.append(f'Entry {index}: gap after previous range; explicit source gaps may be legitimate.')
        previous_end = end
    return {'stage': 'draft before final revision', 'advisory': True,
            'chapter_entry_count': len(chapters), 'issues': issues,
            'note': 'No final-map diagnostics or structural-quality veto. Printed gap ambiguity remains for the author.'}


def graph(run):
    class State(TypedDict):
        last_role: str
    flow = StateGraph(State)

    def draft(state):
        run.role('toc_draft', {})
        return {'last_role': 'toc_draft'}

    def reread(state):
        image_first_read(run)
        return {'last_role': 'toc_image_read'}

    def compare(state):
        image_notes = image_first_read(run)  # completed checkpoints; no second request
        artifact = required_output(run, 'toc_draft')['artifact']
        run.role('toc_review', {'draft_map': artifact, 'image_first_notes': image_notes})
        return {'last_role': 'toc_review'}

    def diagnose(state):
        artifact = required_output(run, 'toc_draft')['artifact']
        save(run.workspace/'diagnostics/draft.json', diagnostics(artifact))
        return {'last_role': 'draft_diagnostics'}

    def revise(state):
        run.role('toc_revision', {'draft_map': required_output(run, 'toc_draft')['artifact'],
            'review': required_output(run, 'toc_review'),
            'draft_structural_observations': read(run.workspace/'diagnostics/draft.json')})
        run.export('toc_revision', 'chapter-map.json')
        return {'last_role': 'toc_revision'}

    previous = START
    for name, node in [('toc_draft', draft), ('toc_image_read', reread), ('toc_review', compare),
                       ('draft_diagnostics', diagnose), ('toc_revision', revise)]:
        flow.add_node(name, node)
        flow.add_edge(previous, name)
        previous = name
    flow.add_edge(previous, END)
    return flow.compile()


def observations(results):
    notes = ['One final extractor revision; no post-author review, structural diagnostics or quality veto.',
        'Image-only reviewer notes precede draft comparison. Every model stage directly receives all selected originals in bounded batches.',
        'Start-only range inference and explicit printed gap ambiguity remain author disclosures, not host repairs.',
        'Technical input/provider/JSON failures remain failures; no automatic retry or substitute curriculum.']
    review = results.get('toc_review', {}).get('output', {})
    if review.get('ok') is False:
        notes.append('Reviewer returned ok:false; preserved as advisory feedback to the final author.')
    final = results.get('toc_revision', {}).get('output', {}).get('artifact', {})
    if isinstance(final.get('chapters'), list):
        notes.append(f'Host counted {len(final["chapters"])} returned chapter entries; this is not a quality assertion.')
    return notes
