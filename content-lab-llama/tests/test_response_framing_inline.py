"""Exact adjacent closer compatibility; synthetic data, SDK/network forbidden."""
import pytest

from test_response_framing import BODY, offline, runner
from reference import pipeline as p, runtime
from reference.factories import toc
from reference.inputs import read, strict_json
from reference.runtime import Runner, model_response_json, report


@pytest.mark.parametrize('body', [
    '{}', BODY, ' \r\n'+BODY,
    '{"text":"\\u0928 \\r\\n \\t \\\" \\\\ ```json\\n{}\\n```", "extra":null}',
    '{"ok":false,"findings":[],"other":{"any_key":true}}',
    '{"artifact":"## Markdown\\n```json\\n{}\\n```\\nनमस्ते"}',
])
def test_inline_close_preserves_entire_body_and_native_values(body):
    observed, label = model_response_json('```json\n'+body+'```')
    assert label == 'markdown_json_fence_inline_close'
    assert observed.encode() == body.encode()
    assert strict_json(observed) == strict_json(body)


@pytest.mark.parametrize('header', [
    ' ```json\n', '\t```json\n', '\n```json\n', '\ufeff```json\n',
    '```json\r\n', '```json\r', '```json \n', '```json\t\n',
    '```JSON\n', '```Json\n', '```python\n', '```\n',
    '~~~json\n', '````json\n', '```json ', '```json',
])
def test_inline_opener_is_exact_at_raw_start(header):
    with pytest.raises(ValueError):
        model_response_json(header+BODY+'```')


@pytest.mark.parametrize('suffix', [
    ' ```', '\t```', '\r```', '``', '````', '~~~',
    '``` ', '```\t', '```\n', '```\r\n', '```prose', '```\n{}',
])
def test_inline_closer_requires_exact_adjacency_and_raw_end(suffix):
    with pytest.raises(ValueError):
        model_response_json('```json\n'+BODY+suffix)


@pytest.mark.parametrize('body', [
    '', '{', '{"artifact":{', '{"artifact":{},}', '{"artifact":{"x":1,}}',
    'prose {}', '{} trailing prose', '{}\n{}', '{}\n```json\n{}',
    '{}\n```\n```json\n{}', '[]', 'null', 'true', '1', '"text"',
    '{"x":NaN}', '{"x":Infinity}', '{"x":-Infinity}', '{"x":1e999}', '{"x":-1e999}',
])
def test_inline_requires_one_entire_strict_finite_object(body):
    with pytest.raises(ValueError):
        model_response_json('```json\n'+body+'```')


def t11_framing(text):
    """Exact pre-T15 boundary, used only to manufacture a synthetic old failure."""
    import re
    match = re.fullmatch(r'```(json)?[ \t]*\r?\n(.*?)\r?\n```', text.strip(), re.DOTALL)
    if match:
        body, framing = match[2], 'markdown_json_fence' if match[1] else 'markdown_fence'
    elif text.startswith('```json\n'):
        body, framing = text[len('```json\n'):], 'markdown_json_fence_eof'
    else:
        body, framing = text, 'plain_json'
    if not isinstance(strict_json(body), dict):
        raise ValueError('Role response must be a JSON object')
    return body, framing


@pytest.mark.parametrize('changed_identity', [False, True])
def test_preexisting_inline_failure_never_reclassified_or_repeated(tmp_path, monkeypatch, changed_identity):
    text = '```json\n{"artifact":{"synthetic":"FROZEN FAILURE"}}```'
    response = {'output': {'message': {'content': [{'text': text}]}}, 'stopReason': 'end_turn'}
    current_framing, current_identity = runtime.model_response_json, runtime.runtime_identity
    monkeypatch.setattr(runtime, 'model_response_json', t11_framing)
    if changed_identity:
        monkeypatch.setattr(runtime, 'runtime_identity', lambda: {'synthetic': 'prior T11 runtime'})
    monkeypatch.setattr(runtime.Fixture, 'invoke', lambda *a, **kw: response)
    run = runner(tmp_path)
    result = run.invoke('toc_revision', 'toc_revision', {}, lambda t: toc.parse('toc_revision', t))
    assert result['status'] == 'failed' and 'response_framing' not in result
    before = p.file_hashes(tmp_path)
    monkeypatch.setattr(runtime, 'model_response_json', current_framing)
    monkeypatch.setattr(runtime, 'runtime_identity', current_identity)
    assert current_framing(text)[1] == 'markdown_json_fence_inline_close'
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
    assert read(tmp_path/'responses/toc_revision.json') == response
