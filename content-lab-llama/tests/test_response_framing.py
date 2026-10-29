"""Offline transport framing contracts; no real content, SDK or paid call."""
import json
from pathlib import Path
import socket
import sys

import pytest
import boto3

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import run_factory as cli
from reference import runtime
from reference.factories import guideline, toc
from reference.inputs import ROOT, canonical, load_manifest, read, save, strict_json
from reference.providers import Bedrock, Fixture
from reference.runtime import Runner, model_response_json, report


@pytest.fixture(autouse=True)
def offline(monkeypatch):
    def forbidden(*args, **kwargs):
        raise AssertionError('No live transport/network permitted')
    monkeypatch.setattr(Bedrock, 'invoke', forbidden)
    monkeypatch.setattr(boto3, 'client', forbidden)
    monkeypatch.setattr(socket.socket, 'connect', forbidden)
    monkeypatch.setattr(socket.socket, 'sendto', forbidden)


def runner(workspace, factory=toc):
    bundle, blobs = load_manifest(ROOT/f'examples/{factory.NAME}/manifest.json', factory)
    workspace.mkdir(exist_ok=True)
    return Runner(workspace, factory, bundle=bundle, blobs=blobs,
                  config={'provider': 'fixture', 'image_limit': 3})


BODY = '{"artifact":{"text":"  Hindi: नमस्ते\\n```literal```  ","extra":[null,false,2.5]},"audit":"kept"}'


@pytest.mark.parametrize('text,framing', [
    (BODY, 'plain_json'),
    (' \n'+BODY+'\t ', 'plain_json'),
    ('```json\n'+BODY+'\n```', 'markdown_json_fence'),
    (' \n```\n'+BODY+'\n```\t ', 'markdown_fence'),
    ('\t```json \t\r\n'+BODY+'\r\n```\r\n', 'markdown_json_fence'),
])
def test_complete_object_framing_preserves_exact_body_and_values(text, framing):
    body, observed = model_response_json(text)
    assert observed == framing
    assert body == (text if framing == 'plain_json' else BODY)
    assert canonical(strict_json(body)) == canonical(strict_json(BODY))


@pytest.mark.parametrize('text', [
    'Here is JSON:\n```json\n{}\n```', '```json\n{}\n```\nExplanation',
    '```json\n{}\n```\n```json\n{}\n```',
    '```python\n{}\n```', '```JSON\n{}\n```',
    '```json\n{', '```json {} ```',
    '```json\n{"artifact":}\n```', '```json\n{"artifact":{\n```',
    '```json\n{"artifact":{"x":NaN}}\n```',
    '```json\n{"artifact":{"x":Infinity}}\n```',
    '```json\n{"artifact":{"x":-Infinity}}\n```',
    '```json\n{"artifact":{"x":1e999}}\n```',
    '```json\n{"artifact":{"x":-1e999}}\n```',
    '```json\n[]\n```', '```\nnull\n```', '[]',
    '{} trailing', '{"artifact":', '',
])
def test_no_prose_extraction_repair_nonfinite_or_nonobject(text):
    with pytest.raises(ValueError):
        model_response_json(text)


@pytest.mark.parametrize('factory', [toc, guideline])
@pytest.mark.parametrize('framing', ['markdown_json_fence', 'markdown_json_fence_eof'])
def test_whole_graph_fences_raw_responses_author_exports_and_resume(tmp_path, monkeypatch, factory, framing):
    original = Fixture.invoke
    responses = {}
    def fenced(self, request, *, role, notes_pages):
        response = original(self, request, role=role, notes_pages=notes_pages)
        # Include a literal code fence INSIDE author data; never strip content fences.
        value = strict_json(response['output']['message']['content'][0]['text'])
        if isinstance(value.get('artifact'), dict):
            value['artifact']['synthetic_exact_text'] = '  Keep ```json\n{}\n``` and नमस्ते.  '
        body = json.dumps(value, ensure_ascii=False)
        text = (' \n```json\n'+body+'\n```\t ' if framing == 'markdown_json_fence'
                else '```json\n'+body+'\n \t\r\n')
        # Match the shared boundary's existing text-block joining behavior.
        response['output']['message']['content'] = [{'text': text[:9]}, {'text': text[9:]}]
        responses[role] = response
        return response
    monkeypatch.setattr(Fixture, 'invoke', fenced)
    run = runner(tmp_path, factory)
    factory.graph(run).invoke({'last_role': 'start'})
    summary = report(tmp_path, factory)
    assert summary['status'] == 'complete'
    assert summary['exposure_usd'] == 0
    assert set(summary['response_framing'].values()) == {framing}
    final_role, filename = ('toc_revision', 'chapter-map.json') if factory is toc else ('revision', 'guideline.json')
    expected = strict_json(model_response_json(''.join(
        p['text'] for p in responses[final_role]['output']['message']['content']))[0])
    assert run.output(final_role) == expected
    assert canonical(read(tmp_path/'artifacts'/filename)) == canonical(expected['artifact'])
    assert read(tmp_path/'responses'/f'{final_role}.json') == responses[final_role]
    assert run.result(final_role)['response_framing'] == framing
    before = {p: p.read_bytes() for folder in ('responses', 'checkpoints', 'artifacts')
              for p in (tmp_path/folder).glob('*')}
    ledger = run.ledger_path.read_bytes()
    def repeat_forbidden(*args, **kwargs):
        raise AssertionError('Resume must not repeat any request')
    monkeypatch.setattr(Fixture, 'invoke', repeat_forbidden)
    factory.graph(Runner(tmp_path, factory, resume=True)).invoke({'last_role': 'start'})
    assert run.ledger_path.read_bytes() == ledger
    assert all(p.read_bytes() == data for p, data in before.items())
    assert framing in (tmp_path/'report.html').read_text()


@pytest.mark.parametrize('text,stop,expected_framing', [
    ('```json\n{"artifact":"wrong type"}\n```', 'end_turn', 'markdown_json_fence'),
    ('```json\n{"wrong_envelope":{}}\n```', 'end_turn', 'markdown_json_fence'),
    ('prefix {"artifact":{}}', 'end_turn', None),
    ('```json\n{"artifact":{', 'end_turn', None),
    ('```json\n{"artifact":{"x":NaN}}\n```', 'end_turn', None),
    ('```json\n{"artifact":{}}\n```', 'max_tokens', None),
    ('```json\n{"artifact":"wrong type"}', 'end_turn', 'markdown_json_fence_eof'),
    ('```json\n{"wrong_envelope":{}}', 'end_turn', 'markdown_json_fence_eof'),
    ('```json\n{"artifact":{', 'end_turn', None),
    ('```json\n{"artifact":{"x":NaN}}', 'end_turn', None),
    ('```json\n{"artifact":{}}', 'max_tokens', None),
    ('```json\n{"artifact":{}}', 'stop_sequence', None),
    ('```json\n{"artifact":{}}', None, None),
])
def test_failure_preserves_raw_no_repeat_and_stop_precedes_parsing(tmp_path, monkeypatch, text, stop, expected_framing):
    response = {'output': {'message': {'content': [{'text': text}]}}, 'stopReason': stop}
    monkeypatch.setattr(Fixture, 'invoke', lambda *args, **kwargs: response)
    run = runner(tmp_path)
    parse_calls = []
    framing_calls = []
    original_framing = runtime.model_response_json
    def frame(text):
        framing_calls.append(text)
        return original_framing(text)
    monkeypatch.setattr(runtime, 'model_response_json', frame)
    def parse(body):
        parse_calls.append(body)
        return toc.parse('toc_revision', body)
    result = run.invoke('toc_revision', 'toc_revision', {}, parse)
    assert result['status'] == 'failed'
    assert result.get('response_framing') == expected_framing
    assert bool(parse_calls) == (expected_framing is not None)
    assert bool(framing_calls) == (stop == 'end_turn')
    assert read(tmp_path/'responses/toc_revision.json') == response
    before = run.ledger_path.read_bytes()
    monkeypatch.setattr(Fixture, 'invoke', lambda *args, **kwargs: pytest.fail('Failed request repeated'))
    resumed = Runner(tmp_path, toc, resume=True)
    assert resumed.invoke('toc_revision', 'toc_revision', {}, parse) == result
    assert run.ledger_path.read_bytes() == before
    assert len(resumed.ledger['calls']) == 1
    assert resumed.exposure() == 0


def test_runtime_change_refused_before_any_new_or_resumed_request(tmp_path, monkeypatch):
    run = runner(tmp_path)
    monkeypatch.setattr(runtime, 'runtime_identity', lambda: {'changed': True})
    monkeypatch.setattr(Fixture, 'invoke', lambda *args, **kwargs: pytest.fail('Changed runtime sent a request'))
    with pytest.raises(RuntimeError, match='Runtime changed'):
        run.invoke('toc_revision', 'toc_revision', {}, strict_json)
    with pytest.raises(RuntimeError, match='Frozen runtime changed'):
        Runner(tmp_path, toc, resume=True)
    assert not run.ledger['calls']


@pytest.mark.parametrize('framing', ['plain_json', 'markdown_fence', 'markdown_json_fence_eof'])
def test_mocked_bedrock_usage_settlement_unchanged(tmp_path, monkeypatch, framing):
    body = '{"artifact":{"synthetic":"SENTINEL"}}'
    text = {'plain_json': body, 'markdown_fence': '```\n'+body+'\n```',
            'markdown_json_fence_eof': '```json\n'+body}[framing]
    response = {'output': {'message': {'content': [{'text': text}]}},
                'stopReason': 'end_turn', 'usage': {'inputTokens': 1000, 'outputTokens': 100}}
    calls = []
    def transport(*args, **kwargs):
        calls.append(1)
        return response
    monkeypatch.setattr(Bedrock, 'invoke', transport)
    bundle, blobs = load_manifest(ROOT/'examples/toc/manifest.json', toc)
    config = {'provider': 'bedrock', 'image_limit': 3, 'model': 'synthetic-not-live',
              'region': 'us-east-2', 'max_output_tokens': 8192, 'input_token_bound': 1000000,
              'input_per_million': .24, 'output_per_million': .97, 'cap_usd': 1}
    run = Runner(tmp_path, toc, bundle=bundle, blobs=blobs, config=config)
    result = run.invoke('toc_revision', 'toc_revision', {}, lambda t: toc.parse('toc_revision', t))
    assert result['status'] == 'ok'
    assert result['response_framing'] == framing
    call = run.ledger['calls'][0]
    assert call['reserved_usd'] == pytest.approx(.24794624)
    assert call['actual_usd'] == pytest.approx(.000337)
    assert call['usage'] == response['usage']
    assert run.exposure() == pytest.approx(.000337)
    summary = report(tmp_path, toc)
    assert summary['actual_estimate_usd'] == pytest.approx(.000337)
    assert summary['unreconciled_reserved_usd'] == 0
    assert summary['response_framing'] == {'toc_revision': result['response_framing']}
    resumed = Runner(tmp_path, toc, resume=True)
    assert resumed.invoke('toc_revision', 'toc_revision', {}, strict_json) == result
    assert len(calls) == 1


@pytest.mark.parametrize('ending', ['\n```', ''])
def test_file_manifest_declared_json_and_config_stay_strict(tmp_path, ending):
    text = '```json\n{"provider":"fixture","image_limit":3}'+ending
    path = tmp_path/'config.json'
    path.write_text(text)
    with pytest.raises(ValueError):
        strict_json(text)
    with pytest.raises(ValueError):
        read(path)
    manifest = tmp_path/'manifest.json'
    manifest.write_text('```json\n'+(ROOT/'examples/toc/manifest.json').read_text()+ending)
    with pytest.raises(ValueError):
        load_manifest(manifest, toc)
    value = read(ROOT/'examples/guideline/manifest.json')
    value['pages'] = [{'printed_page': 1, 'path': str(ROOT/'examples/guideline/sentinel.png')}]
    value['files'] = {'context': {'path': path.name, 'type': 'json'}}
    save(manifest, value)
    with pytest.raises(ValueError):
        load_manifest(manifest, guideline)
    with pytest.raises(ValueError):
        cli.main(['run', str(ROOT/'examples/toc/manifest.json'), '--provider', 'bedrock',
                  '--config', str(path), '--allow-paid', '--workspace', str(tmp_path/'never-created')])
    assert not (tmp_path/'never-created').exists()
