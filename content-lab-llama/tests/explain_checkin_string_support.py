"""T30-only reconstruction of actual base requests/source; historical fixtures stay frozen."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from reference.inputs import ROOT, read, sha

FIXTURE = 'explain-checkin-string-system-baseline.json'
EXPLAIN = 'reference/factories/explain.py'
SUFFIX = ('\nJSON syntax clarification: Close each JSON string with its double quote before the '
          'following structural comma or delimiter. Encode a newline inside a string as \\n, '
          'never as a literal line-feed character.')
ADDITION = "    elif role == 'explain_checkins':\n        request['system'] = [{'text': content[-1]['text']+'\\nJSON syntax clarification: Close each JSON string '\n            'with its double quote before the following structural comma or delimiter. Encode a newline '\n            'inside a string as \\\\n, never as a literal line-feed character.'}]\n"


def base():
    return read(ROOT/'tests/fixtures'/FIXTURE)


def strip_checkin_system(request):
    """Assert/remove only T30 system; keep the complete two original user blocks."""
    final = request['messages'][0]['content'][-1]['text']
    if final.startswith('Final response contract for explain_checkins:\n'):
        assert request.pop('system') == [{'text': final+SUFFIX}]
    return request


def restore_explain_base(hashes):
    """Restore actual pre-T30 Explain bytes and retain every tree member/comparison."""
    source = (ROOT/EXPLAIN).read_text()
    prior = base()['explain_source']
    assert source.count(ADDITION) == 1 and source.replace(ADDITION, '', 1) == prior
    assert hashes[EXPLAIN] == sha(source.encode())
    assert sha(prior.encode()) == base()['reference_sha256'][EXPLAIN]
    return {**hashes, EXPLAIN: sha(prior.encode())}
