"""Native-shaped synthetic Guideline responses for connected plumbing only.

The usual standalone Guideline fixture deliberately has no native chapter shape.
This explicit pipeline provider supplies that shape as a synthetic author response,
before export. It never replaces an existing author's output or invokes a model.
"""
import json
from .providers import Fixture

MARKER = 'SYNTHETIC PLUMBING ONLY — NOT MODEL OR CURRICULUM OUTPUT'


class PipelineFixture(Fixture):
    def invoke(self, request, *, role, notes_pages):
        if notes_pages or role not in ('draft_1', 'draft_2', 'revision', 'refresher'):
            return super().invoke(request, role=role, notes_pages=notes_pages)
        text = request['messages'][0]['content'][0]['text']
        data = json.loads(text.split('Declared task data:\n', 1)[1])
        metadata = data['metadata']
        context = json.dumps(data['task_inputs'].get('context', {}), ensure_ascii=False, sort_keys=True)
        if role == 'refresher':
            artifact = {'topic_summary': MARKER, 'source_topic': metadata['chapter_title']}
        else:
            artifact = {'topic': metadata['chapter_title'], 'guideline_text': MARKER+' '+context,
                'sections': [{'section_key': 'sentinel-'+key, 'title': MARKER+' '+key,
                    'guideline_text': MARKER+' '+context, 'page_count': 2} for key in ('a', 'b')],
                'misconceptions': [], 'synthetic': True, 'source_printed_pages': data['source_printed_pages']}
        value = {'artifact': artifact, 'note': MARKER+'; exact synthetic author response, no curriculum claim'}
        return {'output': {'message': {'content': [{'text': json.dumps(value)}]}},
                'stopReason': 'end_turn', 'synthetic': True}
