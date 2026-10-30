"""T29-only historical expectation adaptation; never rewrite old fixtures."""
from reference.inputs import ROOT, read, sha

FIXTURE = 'guideline-refresher-object-syntax-baseline.json'
GUIDELINE = 'reference/factories/guideline.py'
SUFFIX = ('\nJSON syntax clarification: Enclose every array item that is an object in its own opening { '
          'and closing }. Put field-name/colon pairs inside that object, never directly in an array.')
OLD_LINE = "        result['system'] = [{'text': content[-1]['text']}]\n"
NEW_LINES = ("        result['system'] = [{'text': content[-1]['text']+'\\nJSON syntax clarification: Enclose every array item '\n"
             "            'that is an object in its own opening { and closing }. Put field-name/colon pairs inside '\n"
             "            'that object, never directly in an array.'}]\n")


def base():
    return read(ROOT/'tests/fixtures'/FIXTURE)


def strip_object_suffix(request):
    text = request['system'][0]['text']
    assert request['system'] == [{'text': request['messages'][0]['content'][-1]['text']+SUFFIX}]
    request['system'][0]['text'] = text[:-len(SUFFIX)]
    return request


def restore_guideline_base(hashes):
    """Reconstruct actual pre-T29 Guideline bytes, keeping every other tree member."""
    source = (ROOT/GUIDELINE).read_text()
    prior = base()['guideline_source']
    assert prior.count(OLD_LINE) == 1 and source.count(NEW_LINES) == 1
    assert source.replace(NEW_LINES, OLD_LINE, 1) == prior
    assert hashes[GUIDELINE] == sha(source.encode())
    assert sha(prior.encode()) == base()['reference_sha256'][GUIDELINE]
    return {**hashes, GUIDELINE: sha(prior.encode())}
