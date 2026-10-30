"""T17 placement only: synthetic originals, exact base requests and fake Converse."""
from copy import deepcopy
import json

import pytest

from guideline_refresher_object_support import SUFFIX

from test_guideline_batches import runner, task_data
from test_guideline_completion import offline
from reference.factories import guideline as factory
from reference.inputs import ROOT, canonical, read, sha
from reference.providers import Bedrock, Fixture
from reference.runtime import Runner, report

LABELS = ['xix', '57', 57, 'xx', 58, '५', 0, 'tail']
CASES = ('first_three', 'later_three', 'single', 'pair', 'final_two', 'final_empty')


def case_inputs(run, role, case):
    declared = {'synthetic_task': role, 'context': 'DECLARED_TASK_SENTINEL'}
    if role == 'selection':
        declared['candidates'] = [{'index': 2, 'draft': {'synthetic': True}}]
    notes = [{'printed_page': label, 'observations': f'{role}-OWN-NOTES-{label!r}'}
             for label in LABELS[:3]] if case != 'first_three' else []
    batch = {'first_three': run.bundle['pages'][:3], 'later_three': run.bundle['pages'][3:6],
             'single': run.bundle['pages'][3:4], 'pair': run.bundle['pages'][3:5],
             'final_two': run.bundle['pages'][6:], 'final_empty': []}[case]
    return declared, batch, notes, case.startswith('final_')


def evidence(request):
    return json.loads(json.dumps(request, default=lambda data: {'sha256': sha(data), 'bytes': len(data)}))


def inspection_text(labels):
    # Exact pre-T17 inspection string, including leading newline and typed labels.
    return ('\nThis is an inspection batch within this same role. Inspect only the attached original pages. '
        'Return ONLY {"page_notes":[{"printed_page": <supplied integer or string label>, "observations": "your bounded observations and uncertainties"}]} '
        'with exactly one entry per current_batch_printed_pages label in this exact order: '
        +json.dumps(labels, ensure_ascii=False)+'. Copy each label and its JSON type exactly. '
        'Do not include absent, not-yet-attached or previously noted pages in page_notes. '
        'Use at most 1200 words total. Do not produce final role output yet. '
        'Earlier role-local notes are your own observations, not original images. This turn contract overrides the usual output contract.')


@pytest.mark.parametrize('role', factory.ROLES)
@pytest.mark.parametrize('case', CASES)
def test_exact_git_base_request_after_removing_only_inspection_system(tmp_path, monkeypatch, role, case):
    monkeypatch.setenv('PRIVATE_OPERATOR_HISTORY', 'OPERATOR_SENTINEL_MUST_NOT_ENTER')
    run = runner(tmp_path, LABELS)
    declared, batch, notes, final = case_inputs(run, role, case)
    request = factory.request(run, role, declared, batch, notes, final)
    before = deepcopy(request)
    assert task_data(request)['task_inputs'] == declared
    assert task_data(request)['role_local_page_notes'] == notes
    content = request['messages'][0]['content']
    originals = content[1:-1] if final else content[1:]
    assert originals == [item for page in batch for item in (
        {'text': f'Original printed page {page["printed_page"]}:'},
        {'image': {'format': page['format'], 'source': {'bytes': run.blobs[page['file']]}}})]
    assert len(content) == 1 + 2*len(batch) + int(final)
    if final:
        # T22 contract plus exact T29 suffix; original user contract stays unchanged.
        if role == 'refresher':
            assert request.pop('system') == [{'text': content[-1]['text']+SUFFIX}]
        assert set(request) == {'messages'}
    else:
        assert set(request) == {'messages', 'system'}
        text = inspection_text([p['printed_page'] for p in batch])
        assert request.pop('system') == [{'text': text}]
        assert text in content[0]['text']
        assert 'DECLARED_TASK_SENTINEL' not in text
    baseline = read(ROOT/'tests/fixtures/guideline-inspection-system-baseline.json')
    assert sha(canonical(evidence(request))) == baseline['requests'][role][case]
    for prohibited in ('OPERATOR_SENTINEL_MUST_NOT_ENTER', 'AGENTS.md', 'SKILL.md', str(tmp_path)):
        assert prohibited not in json.dumps(evidence(before))


def test_actual_transport_graph_hashes_include_system_and_completed_resume_no_calls(tmp_path):
    run = runner(tmp_path, LABELS)
    calls = []

    class Client:
        def converse(self, **kwargs):
            index = len(calls)
            role = factory.ROLES[index//3]
            turn = index % 3
            calls.append(deepcopy(kwargs))
            request = {'messages': kwargs['messages']}
            labels = LABELS[turn*3:turn*3+3] if turn < 2 else None
            if labels is not None:
                assert kwargs['system'] == [{'text': inspection_text(labels)}]
                request['system'] = kwargs['system']
            elif role == 'refresher':
                assert kwargs['system'] == [{'text': kwargs['messages'][0]['content'][-1]['text']+SUFFIX}]
                request['system'] = kwargs['system']
            else:
                assert 'system' not in kwargs
            assert set(kwargs) == {'modelId', 'messages', 'inferenceConfig',
                                  *({'system'} if labels is not None or role == 'refresher' else set())}
            assert kwargs['modelId'] == 'synthetic-no-service'
            assert kwargs['inferenceConfig'] == {'maxTokens': 100, 'temperature': .1}
            return Fixture().invoke(request, role=role, notes_pages=labels)

    provider = Bedrock({'model': 'synthetic-no-service', 'max_output_tokens': 100})
    provider.client = Client()
    run.provider = provider  # Actual optional transport, fixture accounting, no SDK/client.
    factory.graph(run).invoke({'last_role': 'start'})
    assert len(calls) == len(run.ledger['calls']) == 24
    assert report(run.workspace, factory)['status'] == 'complete'
    assert run.exposure() == 0 and not (run.workspace/'ledger.json').exists()
    for call in run.ledger['calls']:
        request = read(run.workspace/'requests'/f'{call["key"]}.json')
        assert call['request_sha256'] == sha(canonical(request))
        assert call['checkpoint_sha256'] == sha(canonical(read(run.workspace/'checkpoints'/f'{call["key"]}.json')))
        if '__batch_' in call['key']:
            assert request['system'] == [{'text': inspection_text(task_data(request)['current_batch_printed_pages'])}]
            legacy = deepcopy(request); legacy.pop('system')
            assert sha(canonical(legacy)) != call['request_sha256']
        elif call['key'] == 'refresher':
            assert request['system'] == [{'text': request['messages'][0]['content'][-1]['text']+SUFFIX}]
        else:
            assert 'system' not in request
        assert call['actual_usd'] == call['reserved_usd'] == 0
    before = {str(p.relative_to(run.workspace)): p.read_bytes() for p in run.workspace.rglob('*') if p.is_file()}
    resumed = Runner(run.workspace, factory, resume=True)
    resumed.provider = provider
    factory.graph(resumed).invoke({'last_role': 'start'})
    assert len(calls) == 24
    assert {str(p.relative_to(run.workspace)): p.read_bytes() for p in run.workspace.rglob('*') if p.is_file()} == before


@pytest.mark.parametrize('observations', ['', '   ', None, [], 7])
def test_inspection_observations_remain_required_and_nonempty(observations):
    body = json.dumps({'page_notes': [{'printed_page': 'xix', 'observations': observations}]})
    with pytest.raises(ValueError):
        factory.parse('refresher', body, ['xix'])


def test_refresher_narration_stays_failed_required_output_missing_no_retry(tmp_path, monkeypatch):
    original = Fixture.invoke

    def response(self, request, *, role, notes_pages):
        if role == 'refresher' and notes_pages is not None:
            return {'output': {'message': {'content': [{'text': 'Step 1: Analyze SYNTHETIC prerequisites'}]}},
                    'stopReason': 'end_turn'}
        return original(self, request, role=role, notes_pages=notes_pages)

    monkeypatch.setattr(Fixture, 'invoke', response)
    run = runner(tmp_path, LABELS[:5])
    factory.graph(run).invoke({'last_role': 'start'})
    summary = report(run.workspace, factory)
    assert summary['status'] == 'partial_or_failed'
    assert run.result('refresher__batch_1')['status'] == 'failed'
    assert run.result('refresher') is None
    assert (run.workspace/'artifacts/guideline.json').exists()
    assert not (run.workspace/'artifacts/refresher-guideline.json').exists()
    assert len(run.ledger['calls']) == 15
    before = read(run.ledger_path)
    monkeypatch.setattr(Fixture, 'invoke', lambda *a, **k: pytest.fail('Failed request repeated'))
    factory.graph(Runner(run.workspace, factory, resume=True)).invoke({'last_role': 'start'})
    assert read(run.ledger_path) == before
