"""Exact EOF framing compatibility; synthetic graphs only, SDK/network forbidden."""
import json
import re

import pytest

from test_response_framing import BODY, offline, runner
from test_guideline_completion import Attempt4Fixture
from reference import pipeline as p, runtime
from reference.factories import guideline, toc
from reference.inputs import ROOT, canonical, read, sha, strict_json
from reference.pipeline_fixture import PipelineFixture
from reference.runtime import Runner, model_response_json, report


@pytest.mark.parametrize('body', [
    '{}', BODY, ' \r\n'+BODY+'\n \t\r\n',
    '{"text":"\\u0928 \\r\\n \\t \\\" \\\\ ```json\\n{}\\n```", "extra":null}\t\n',
    '{"ok":false,"findings":[],"other":{"any_key":true}}',
    '{"artifact":"## Markdown\\n```json\\n{}\\n```\\nनमस्ते"}',
])
def test_exact_eof_body_and_native_values_preserved(body):
    observed, label = model_response_json('```json\n'+body)
    assert label == 'markdown_json_fence_eof'
    assert observed.encode() == body.encode()
    assert strict_json(observed) == strict_json(body)


@pytest.mark.parametrize('header', [
    ' ```json\n', '\t```json\n', '\n```json\n', '\ufeff```json\n',
    '```json\r\n', '```json\r', '```json \n', '```json\t\n',
    '```JSON\n', '```Json\n', '```python\n', '```\n',
    '~~~json\n', '````json\n', '```json ', '```json',
])
def test_eof_opener_is_exact_at_raw_start(header):
    with pytest.raises(ValueError):
        model_response_json(header+BODY)


@pytest.mark.parametrize('body', [
    '', '{', '{"artifact":{', '{"artifact":{},}', '{"artifact":{"x":1,}}',
    '{} trailing prose', '{}\n{}', '{}\n```json\n{}', '{}\n```\n```json\n{}\n```',
    '{}\n~~~', '{}\n````', '[]', 'null', 'true', '1', '"text"',
    '{"x":NaN}', '{"x":Infinity}', '{"x":-Infinity}', '{"x":1e999}', '{"x":-1e999}',
])
def test_eof_requires_entire_strict_finite_object(body):
    with pytest.raises(ValueError):
        model_response_json('```json\n'+body)


def t04_framing(text):
    """Prior explicit-closing-fence contract, to manufacture a historical failure."""
    match = re.fullmatch(r'```(json)?[ \t]*\r?\n(.*?)\r?\n```', text.strip(), re.DOTALL)
    body = match[2] if match else text
    if not isinstance(strict_json(body), dict):
        raise ValueError('Role response must be a JSON object')
    framing = ('markdown_json_fence' if match[1] else 'markdown_fence') if match else 'plain_json'
    return body, framing


@pytest.mark.parametrize('changed_identity', [False, True])
def test_preexisting_eof_failure_never_reclassified_or_repeated(tmp_path, monkeypatch, changed_identity):
    text = '```json\n{"artifact":{"synthetic":"HISTORICAL FAILURE"}}'
    response = {'output': {'message': {'content': [{'text': text}]}}, 'stopReason': 'end_turn'}
    current_framing, current_identity = runtime.model_response_json, runtime.runtime_identity
    monkeypatch.setattr(runtime, 'model_response_json', t04_framing)
    if changed_identity:
        monkeypatch.setattr(runtime, 'runtime_identity', lambda: {'synthetic': 'prior T04 runtime'})
    monkeypatch.setattr(runtime.Fixture, 'invoke', lambda *a, **kw: response)
    run = runner(tmp_path)
    result = run.invoke('toc_revision', 'toc_revision', {}, lambda t: toc.parse('toc_revision', t))
    assert result['status'] == 'failed' and 'response_framing' not in result
    before = p.file_hashes(tmp_path)
    monkeypatch.setattr(runtime, 'model_response_json', current_framing)
    monkeypatch.setattr(runtime, 'runtime_identity', current_identity)
    assert current_framing(text)[1] == 'markdown_json_fence_eof'
    monkeypatch.setattr(runtime.Fixture, 'invoke', lambda *a, **kw: pytest.fail('Historical call repeated'))
    if changed_identity:
        with pytest.raises(RuntimeError, match='Frozen runtime changed'):
            Runner(tmp_path, toc, resume=True)
    else:
        resumed = Runner(tmp_path, toc, resume=True)
        assert resumed.invoke('toc_revision', 'toc_revision', {}, strict_json) == result
        assert len(resumed.ledger['calls']) == 1 and resumed.exposure() == 0
    summary = report(tmp_path, toc)
    assert summary['status'] == 'partial_or_failed'
    assert summary['response_framing'] == {} and summary['roles']['toc_revision'] == 'failed'
    assert before == {k: v for k, v in p.file_hashes(tmp_path).items()
                      if k not in ('summary.json', 'report.html')}


@pytest.mark.parametrize('provider', [PipelineFixture, Attempt4Fixture])
def test_guarded_eof_connected_graph_native_reviews_exports_and_completion(tmp_path, monkeypatch, provider):
    responses = []
    class EofFixture(provider):
        def invoke(self, request, *, role, notes_pages):
            response = super().invoke(request, role=role, notes_pages=notes_pages)
            text = ''.join(block['text'] for block in response['output']['message']['content'])
            framed = '```json\n'+text+'\r\n \t'
            response['output']['message']['content'] = [{'text': framed[:5]}, {'text': framed[5:]}]
            responses.append((role, response))
            return response
    monkeypatch.setattr(p, 'PipelineFixture', EofFixture)
    monkeypatch.setattr(p.media, 'runtime_identity', lambda: {'synthetic_tool_identity': True})
    workspace = tmp_path/'pipeline'
    result = p.start(ROOT/'examples/pipeline/manifest.json', workspace, 'fixture', stop_after='practice')
    assert result['paid_calls'] == 0 and result['exposure_usd'] == 0
    assert result['model_requests'] == len(responses)
    for stage in ('toc', 'guideline', 'explain', 'practice'):
        root = workspace/'stages'/stage
        summary = read(root/'summary.json')
        assert summary['status'] == 'complete'
        assert set(summary['response_framing'].values()) == {'markdown_json_fence_eof'}
        ledger = read(root/'synthetic-ledger.json')
        for call in ledger['calls']:
            checkpoint = read(root/'checkpoints'/f'{call["key"]}.json')
            assert call['checkpoint_sha256'] == sha(canonical(checkpoint))
            response = read(root/'responses'/f'{call["key"]}.json')
            assert any(response == sent for _, sent in responses)
            raw = ''.join(block['text'] for block in response['output']['message']['content'])
            assert raw.startswith('```json\n') and raw.endswith('\r\n \t')
            if checkpoint['status'] == 'ok':
                assert checkpoint['output'] == strict_json(raw[len('```json\n'):])
    g = workspace/'stages/guideline'
    assert read(g/'checkpoints/accuracy.json')['output']['ok'] is False
    for role, name in guideline.FINAL_EXPORTS.items():
        assert read(g/'artifacts'/name) == read(g/'checkpoints'/f'{role}.json')['output']['artifact']
    assert result['stages']['guideline']['role_execution_status'] == (
        'partial_or_failed' if provider is Attempt4Fixture else 'complete')
    e = workspace/'stages/explain'
    assert read(e/'inputs.json')['declared']['guideline'] == read(g/'artifacts/guideline.json')
    assert read(e/'checkpoints/explain_split_review.json')['output']['ok'] is False
    assert 'artifact' not in read(e/'checkpoints/explain_split_review.json')['output']
    from reference.factories import explain
    for role, name in explain.EXPORTS.items():
        artifact = read(e/'checkpoints'/f'{role}.json')['output']['artifact']
        path = e/'artifacts'/name
        assert (path.read_text() if path.suffix == '.md' else read(path)) == artifact
    assert read(workspace/'stages/practice/inputs.json')['declared']['deck'] == read(e/'artifacts/deck.json')
    before = p.file_hashes(workspace/'stages')
    monkeypatch.setattr(EofFixture, 'invoke', lambda *a, **kw: pytest.fail('Completed call repeated'))
    resumed = p.resume(workspace, stop_after='practice')
    assert resumed['model_requests'] == result['model_requests']
    assert resumed['exposure_usd'] == 0 and p.file_hashes(workspace/'stages') == before
