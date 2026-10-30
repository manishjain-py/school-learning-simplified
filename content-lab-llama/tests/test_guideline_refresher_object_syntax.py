"""T29 instruction-only experiment; explicit synthetic requests and native graphs."""
import ast
from copy import deepcopy
import json
from pathlib import Path
import pytest

from guideline_refresher_object_support import FIXTURE, GUIDELINE, SUFFIX, base, restore_guideline_base, strip_object_suffix
from test_guideline_batches import runner, task_data
from test_guideline_inspection_system import LABELS, CASES, case_inputs, evidence, inspection_text
from reference.factories import guideline as factory
from reference.inputs import ROOT, canonical, read, sha
from reference.providers import Bedrock, Fixture
from reference.runtime import Runner, report


def snapshot(path):
    return {str(p.relative_to(path)): p.read_bytes() for p in path.rglob('*') if p.is_file()}


@pytest.mark.parametrize('role', factory.ROLES)
@pytest.mark.parametrize('case', CASES)
def test_complete_base_requests_preserve_all_user_blocks_and_only_extend_final_refresher(tmp_path, monkeypatch, role, case):
    monkeypatch.setenv('PRIVATE_OPERATOR_HISTORY', 'OPERATOR_SENTINEL')
    run = runner(tmp_path, LABELS)
    declared, batch, notes, final = case_inputs(run, role, case)
    before = deepcopy((declared, batch, notes, run.bundle, run.blobs))
    request = factory.request(run, role, declared, batch, notes, final)
    old = base()['full_cases'][role+':'+case]
    assert (declared, batch, notes, run.bundle, run.blobs) == before
    assert declared == old['declared'] and notes == old['notes'] and final == old['final']
    assert evidence(request['messages']) == old['request']['messages']
    if final and role == 'refresher':
        assert request['system'] == [{'text': old['request']['system'][0]['text']+SUFFIX}]
        assert request['system'][0]['text'].count(SUFFIX) == 1
        for forbidden in ('SYNTHETIC', 'OWN-NOTES', 'OPERATOR_SENTINEL', 'AGENTS.md', 'SKILL.md', str(ROOT), str(tmp_path)):
            assert forbidden not in request['system'][0]['text']
        strip_object_suffix(request)
    assert evidence(request) == old['request']
    assert sha(canonical(evidence(request))) == old['request_sha256']


def test_actual_base_source_and_every_reference_prompt_historical_fixture_and_lock():
    old = base()
    assert old['synthetic'] is True and old['base_commit'] == 'bc359416924107faf92fc3e8396c9bc848701f58'
    source = Path(factory.__file__).read_text()
    old_ast, new_ast = ast.parse(old['guideline_source']), ast.parse(source)
    old_req = next(n for n in old_ast.body if isinstance(n, ast.FunctionDef) and n.name == 'request')
    new_req = next(n for n in new_ast.body if isinstance(n, ast.FunctionDef) and n.name == 'request')
    assert old['guideline_source'].splitlines(True)[:old_req.lineno-1] == source.splitlines(True)[:new_req.lineno-1]
    assert old['guideline_source'].splitlines(True)[old_req.end_lineno:] == source.splitlines(True)[new_req.end_lineno:]
    new_ast.body.remove(new_req)
    assert sha(ast.dump(new_ast).encode()) == old['outside_request_ast_sha256']
    files = lambda paths: {str(p.relative_to(ROOT)): sha(p.read_bytes()) for p in sorted(paths)}
    current = files((ROOT/'reference').rglob('*.py'))
    assert current[GUIDELINE] != old['reference_sha256'][GUIDELINE]
    restored = restore_guideline_base(current)
    assert restored == old['reference_sha256']
    for excluded, expected in old['prior_tree_sha256'].items():
        assert sha(canonical({k:v for k,v in restored.items() if k != f'reference/factories/{excluded}.py'})) == expected
    assert files(p for p in (ROOT/'prompts').rglob('*') if p.is_file()) == old['prompt_sha256']
    assert files(p for p in (ROOT/'tests/fixtures').glob('*.json') if p.name != FIXTURE) == old['all_historical_fixtures_sha256']
    assert sha((ROOT/'requirements.lock').read_bytes()) == old['requirements_sha256']


VALID = [
    {'artifact': {'prerequisite_concepts': [{'concept': 'SYNTHETIC "quoted" \\ नमूना\nline', 'why_needed': 'SYNTHETIC {brace}: [array]'}], 'topic_summary': 'SYNTHETIC summary'}, 'note': 'SYNTHETIC audit'},
    {'artifact': {'skip_refresher': True, 'skip_reason': 'SYNTHETIC no prerequisite', 'prerequisite_concepts': [], 'topic_summary': 'SYNTHETIC skip'}},
    {'artifact': {'prerequisite_concepts': [], 'topic_summary': 'SYNTHETIC empty'}},
    {'artifact': {'prerequisite_concepts': [{'concept': 'SYNTHETIC imperfect; retained', 'why_needed': ''}], 'unexpected_native_field': None}},
]


@pytest.mark.parametrize('value', VALID, ids=('escapes', 'skip', 'empty', 'native-imperfection'))
def test_native_8192_converse_negative_reviews_final_author_hashes_exports_and_unchanged_resume(tmp_path, value):
    run = runner(tmp_path, LABELS)
    calls = []
    class Client:
        def converse(self, **kwargs):
            role, turn = factory.ROLES[len(calls)//3], len(calls) % 3
            calls.append(deepcopy(kwargs))
            labels = LABELS[turn*3:turn*3+3] if turn < 2 else None
            request = {'messages': kwargs['messages']}
            expected = ([{'text': inspection_text(labels)}] if labels is not None else
                        [{'text': kwargs['messages'][0]['content'][-1]['text']+SUFFIX}] if role == 'refresher' else None)
            assert set(kwargs) == {'modelId', 'messages', 'inferenceConfig', *({'system'} if expected else set())}
            assert kwargs['modelId'] == 'synthetic-no-service'
            assert kwargs['inferenceConfig'] == {'maxTokens': 8192, 'temperature': .1}
            if expected:
                assert kwargs['system'] == expected
                request['system'] = kwargs['system']
            response = Fixture().invoke(request, role=role, notes_pages=labels)
            if role == 'refresher' and labels is None:
                response['output']['message']['content'][0]['text'] = json.dumps(value, ensure_ascii=False)
            return response
    provider = Bedrock({'model': 'synthetic-no-service', 'max_output_tokens': 8192})
    provider.client = Client()
    run.provider = provider
    factory.graph(run).invoke({'last_role': 'start'})
    assert len(calls) == len(run.ledger['calls']) == 24
    assert run.exposure() == 0 and report(run.workspace, factory)['status'] == 'complete'
    assert run.output('refresher') == value
    for role in ('coverage', 'accuracy', 'structure'):
        assert run.output(role)['ok'] is False
        assert task_data(read(run.workspace/'requests/revision.json'))['task_inputs']['reviews'][role] == run.output(role)
    for role, filename in factory.FINAL_EXPORTS.items():
        assert read(run.workspace/'artifacts'/filename) == run.output(role)['artifact']
    for call in run.ledger['calls']:
        assert call['request_sha256'] == sha(canonical(read(run.workspace/'requests'/f'{call["key"]}.json')))
        assert call['checkpoint_sha256'] == sha(canonical(read(run.workspace/'checkpoints'/f'{call["key"]}.json')))
        assert call['reserved_usd'] == call['actual_usd'] == 0
    saved = snapshot(run.workspace)
    resumed = Runner(run.workspace, factory, resume=True)
    resumed.provider = provider
    factory.graph(resumed).invoke({'last_role': 'start'})
    assert len(calls) == 24 and snapshot(run.workspace) == saved


MISSING_OBJECT = '{"artifact":{"prerequisite_concepts":[{"concept":"SYNTHETIC A","why_needed":"SYNTHETIC"},"concept":"SYNTHETIC B","why_needed":"SYNTHETIC"}]}}'


@pytest.mark.parametrize('kind', ('missing-object', 'max-tokens'))
def test_required_refresher_strict_failure_retained_before_role_parse_no_export_or_retry(tmp_path, monkeypatch, kind):
    from reference import runtime
    original, frame, parse = Fixture.invoke, runtime.model_response_json, factory.parse
    calls, framed, parsed = [], [], []
    body = MISSING_OBJECT if kind == 'missing-object' else json.dumps(VALID[0])
    raw = {'output': {'message': {'content': [{'text': body}]}}, 'stopReason': 'max_tokens' if kind == 'max-tokens' else 'end_turn'}
    def response(self, request, *, role, notes_pages):
        calls.append(role)
        if role == 'refresher' and notes_pages is None:
            framed.clear(); parsed.clear()
            return raw
        return original(self, request, role=role, notes_pages=notes_pages)
    def framing(text):
        framed.append(text)
        return frame(text)
    def parsing(role, text, notes_pages=None):
        parsed.append(role)
        return parse(role, text, notes_pages)
    monkeypatch.setattr(Fixture, 'invoke', response)
    monkeypatch.setattr(runtime, 'model_response_json', framing)
    monkeypatch.setattr(factory, 'parse', parsing)
    run = runner(tmp_path, LABELS[:5])
    factory.graph(run).invoke({'last_role': 'start'})
    assert len(calls) == len(run.ledger['calls']) == 16
    assert run.result('refresher')['status'] == 'failed' and 'output' not in run.result('refresher')
    assert read(run.workspace/'responses/refresher.json') == raw
    if kind == 'missing-object':
        assert framed == [body] and parsed == []
        with pytest.raises(json.JSONDecodeError) as failure:
            json.loads(body)
        assert run.result('refresher')['error'] == str(failure.value)
    else:
        assert framed == parsed == [] and 'response_framing' not in run.result('refresher')
        assert run.result('refresher')['error'].startswith('Non-final provider stop')
    # Offline reporting revalidates successful checkpoints; inspect execution first.
    summary = report(run.workspace, factory)
    assert (run.workspace/'artifacts/guideline.json').exists()
    assert not (run.workspace/'artifacts/refresher-guideline.json').exists()
    assert {'required_author_dependency:refresher', 'final_export_required:refresher'} <= set(summary['completion_blockers'])
    saved = snapshot(run.workspace)
    monkeypatch.setattr(Fixture, 'invoke', lambda *a, **k: pytest.fail('Failed request repeated'))
    factory.graph(Runner(run.workspace, factory, resume=True)).invoke({'last_role': 'start'})
    assert snapshot(run.workspace) == saved


def test_missing_refresher_blocks_connected_pipeline_before_explain_or_assembly(tmp_path, monkeypatch):
    from reference import pipeline
    from reference.pipeline_fixture import PipelineFixture
    original = PipelineFixture.invoke
    calls = []
    def altered(self, request, *, role, notes_pages):
        calls.append(role)
        if role == 'refresher' and notes_pages is None:
            return {'output': {'message': {'content': [{'text': MISSING_OBJECT}]}}, 'stopReason': 'end_turn'}
        return original(self, request, role=role, notes_pages=notes_pages)
    monkeypatch.setattr(pipeline.media, 'runtime_identity', lambda: {'synthetic': True})
    monkeypatch.setattr(PipelineFixture, 'invoke', altered)
    workspace = tmp_path/'pipeline'
    with pytest.raises(RuntimeError, match='guideline: required graph/operational stage incomplete'):
        pipeline.start(ROOT/'examples/pipeline/manifest.json', workspace, 'fixture', stop_after='translate')
    assert calls[-1] == 'refresher' and not any(role.startswith('explain') for role in calls)
    assert not (workspace/'stages/explain').exists() and not (workspace/'stages/translate').exists()
    saved, count = snapshot(workspace/'stages'), len(calls)
    with pytest.raises(RuntimeError, match='guideline: required graph/operational stage incomplete'):
        pipeline.resume(workspace, stop_after='translate')
    assert len(calls) == count and snapshot(workspace/'stages') == saved
