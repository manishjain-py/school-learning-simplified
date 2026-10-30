"""Strict complete teaching text transport, host wrappers and retained evidence."""
from copy import deepcopy
from decimal import Decimal
import json

import pytest

from test_translate import EXAMPLE, invoke, offline, runner
from reference.factories import translate
from reference.factories.translate_fixture import payload
from reference.inputs import canonical, load_manifest, read, sha
from reference.providers import Fixture
from reference.runtime import NativeContractError, Runner, report

ROLE = 'translate_teaching_b001_final'


@pytest.fixture
def task():
    bundle, _ = load_manifest(EXAMPLE, translate)
    return translate.batches(bundle, translate.project(bundle))[0]


def independent_wire_and_native(task):
    """Reconstruct without the production mapper, decoder or fixture encoder."""
    wire, items = {}, []
    for index, source in enumerate(task['items'], 1):
        title = f'  शीर्षक {index} "quoted" \\ path\n  '
        wire[f't{index}'] = title
        lines = []
        for number, _ in enumerate(source['lines'], 1):
            display = '' if number == 1 else f'**term** प्रदर्शन {index}/{number}'
            audio = f'  बोला गया {index}/{number}\nआवाज़  '
            wire[f'd{index}_{number}'], wire[f'a{index}_{number}'] = display, audio
            lines.append({'display': display, 'audio': audio})
        items.append({'slot': source['slot'], 'title_display': title, 'lines': lines})
    return wire, {'schema_version': 2, 'items': items}


def test_mapping_is_role_source_bound_complete_and_has_no_curriculum_values(task):
    mapping = translate.teaching_wire_mapping(ROLE, task)
    wire, _ = independent_wire_and_native(task)
    assert {field['key'] for field in mapping['fields']} == set(wire)
    assert len(mapping['fields']) == sum(1+2*len(item['lines']) for item in task['items'])
    assert mapping['source_binding_sha256'] == sha(canonical({'stream': 'teaching', 'items': task['items']}))
    assert mapping['mapping_sha256'] == sha(canonical({key: value for key, value in mapping.items()
                                                      if key != 'mapping_sha256'}))
    assert 'SYNTHETIC PLUMBING' not in json.dumps(mapping)
    assert translate.teaching_wire_mapping('translate_teaching_b002_final', task) != mapping
    changed = deepcopy(task)
    changed['items'][0]['lines'].append({'display': 'Explicit new source', 'audio': 'Explicit new source'})
    assert translate.teaching_wire_mapping(ROLE, changed) != mapping


def test_reordered_keys_losslessly_reconstruct_native_hindi_and_label_host_wrapper(task):
    wire, expected = independent_wire_and_native(task)
    reordered = dict(reversed(list(wire.items())))
    raw = json.dumps(reordered, ensure_ascii=False)
    original = deepcopy(task)
    value = translate.parse_declared(ROLE, raw, task)
    assert task == original
    assert value['artifact'] == expected
    assert value['wire'] == wire
    assert value['transport']['native_wrapper_origin'].startswith('host structural assembly')
    assert value['transport']['wire_sha256'] == sha(canonical(wire))
    assert value['transport']['native_artifact_sha256'] == sha(canonical(expected))


@pytest.mark.parametrize('defect', ('missing_title', 'missing_display', 'missing_audio', 'extra',
                                  'duplicate', 'escaped_duplicate', 'nested_object', 'nested_array',
                                  'number', 'boolean', 'null', 'blank_audio', 'native_envelope',
                                  'missing_root_closure', 'wrong_root_closure', 'trailing_text'))
def test_entire_wire_fails_strictly_without_subset_or_draft_substitution(task, defect):
    wire, native = independent_wire_and_native(task)
    if defect.startswith('missing_') and defect != 'missing_root_closure':
        key = {'missing_title': 't1', 'missing_display': 'd1_1', 'missing_audio': 'a1_1'}[defect]
        wire.pop(key)
    elif defect == 'extra': wire['invented'] = 'Not allowed'
    elif defect == 'nested_object': wire['t1'] = {'text': 'Not allowed'}
    elif defect == 'nested_array': wire['t1'] = ['Not allowed']
    elif defect == 'number': wire['t1'] = 2
    elif defect == 'boolean': wire['t1'] = True
    elif defect == 'null': wire['t1'] = None
    elif defect == 'blank_audio': wire['a1_1'] = ' \n\t '
    raw = json.dumps(wire, ensure_ascii=False)
    if defect in ('duplicate', 'escaped_duplicate'):
        key = '"t1"' if defect == 'duplicate' else '"\\u0074\\u0031"'
        raw = raw[:-1]+','+key+':"duplicate"}'
    elif defect == 'native_envelope': raw = json.dumps({'artifact': native})
    elif defect == 'missing_root_closure': raw = raw[:-1]
    elif defect == 'wrong_root_closure': raw = raw[:-1]+']'
    elif defect == 'trailing_text': raw += ' extra'
    task['draft'] = native  # A valid draft never supplies missing final output.
    with pytest.raises((NativeContractError, json.JSONDecodeError)):
        translate.parse_declared(ROLE, raw, task)


def test_graph_freezes_map_before_first_request_and_retains_exact_wire_native_and_receipts(tmp_path, monkeypatch):
    original = Fixture.invoke
    calls = []
    def provider(self, request, *, role, notes_pages):
        calls.append(role)
        assert (tmp_path/'views'/(ROLE+'.wire-mapping.json')).exists()
        return original(self, request, role=role, notes_pages=notes_pages)
    monkeypatch.setattr(Fixture, 'invoke', provider)
    run = runner(tmp_path)
    invoke(run)
    assert len(calls) == 21 and run.exposure() == 0
    work = read(tmp_path/'views/batches.json')
    for batch in work:
        if batch['stream'] != 'teaching': continue
        role = translate.role_key(batch, 'final')
        mapping = read(tmp_path/'views'/(role+'.wire-mapping.json'))
        wire = read(tmp_path/'artifacts'/(role+'.wire.json'))
        native = read(tmp_path/'artifacts'/(role+'.json'))
        # Rebuild every string independently from the declared map, preserving
        # model text exactly while obtaining all structural slots from source.
        expected = {'schema_version': 2, 'items': [
            {'slot': source['slot'], 'title_display': wire[f't{index}'], 'lines': [
                {'display': wire[f'd{index}_{line}'], 'audio': wire[f'a{index}_{line}']}
                for line in range(1, len(source['lines'])+1)]}
            for index, source in enumerate(batch['items'], 1)]}
        assert native == expected == run.output(role)['artifact']
        response = read(tmp_path/'attempts'/role/'001/response.json')
        raw = ''.join(block.get('text', '') for block in response['output']['message']['content'])
        assert (tmp_path/'artifacts'/(role+'.wire.txt')).read_bytes() == raw.encode()
        assert wire == json.loads(raw)
        provenance = read(tmp_path/'views'/(role+'.wire-provenance.json'))
        assert provenance['mapping_sha256'] == mapping['mapping_sha256']
        assert provenance['raw_provider_text_sha256'] == sha(raw.encode())
        assert provenance['provider_response_sha256'] == sha(canonical(response))
        receipt = read(tmp_path/'views'/(role+'.wire-export-receipt.json'))
        assert all(sha((tmp_path/path).read_bytes()) == digest for path, digest in receipt['files'].items())
    before = {str(path.relative_to(tmp_path)): path.read_bytes() for path in tmp_path.rglob('*') if path.is_file()}
    invoke(Runner(tmp_path, translate, resume=True))
    assert len(calls) == 21
    assert before == {str(path.relative_to(tmp_path)): path.read_bytes() for path in tmp_path.rglob('*') if path.is_file()}


@pytest.mark.parametrize('kind', ('mapping', 'native', 'wire', 'raw_text', 'provenance', 'receipt'))
@pytest.mark.parametrize('mutation', ('modify', 'delete'))
def test_completed_evidence_tamper_refuses_before_any_further_call(tmp_path, monkeypatch, kind, mutation):
    original = Fixture.invoke
    calls = []
    def provider(self, request, **kwargs):
        calls.append(kwargs['role'])
        return original(self, request, **kwargs)
    monkeypatch.setattr(Fixture, 'invoke', provider)
    run = runner(tmp_path); invoke(run)
    paths = {'mapping': f'views/{ROLE}.wire-mapping.json', 'native': f'artifacts/{ROLE}.json',
             'wire': f'artifacts/{ROLE}.wire.json', 'raw_text': f'artifacts/{ROLE}.wire.txt',
             'provenance': f'views/{ROLE}.wire-provenance.json',
             'receipt': f'views/{ROLE}.wire-export-receipt.json'}
    path = tmp_path/paths[kind]
    if mutation == 'modify': path.write_bytes(path.read_bytes()+b'\n ')
    else: path.unlink()
    before = {str(path.relative_to(tmp_path)): path.read_bytes() for path in tmp_path.rglob('*') if path.is_file()}
    with pytest.raises(RuntimeError, match='Frozen teaching wire evidence'):
        invoke(Runner(tmp_path, translate, resume=True))
    assert len(calls) == 21
    assert before == {str(path.relative_to(tmp_path)): path.read_bytes() for path in tmp_path.rglob('*') if path.is_file()}


@pytest.mark.parametrize('partial', (False, True))
def test_checkpoint_to_first_export_crash_gap_finishes_without_repeat(tmp_path, monkeypatch, partial):
    original_export = translate.export_teaching_wire
    original_retain = translate._retain_bytes
    def interrupted_export(run, role, declared, **kwargs):
        if role == ROLE and kwargs.get('create', True):
            if partial:
                def stop_wire(path, data, **options):
                    if path.name == ROLE+'.wire.json': raise KeyboardInterrupt
                    return original_retain(path, data, **options)
                with monkeypatch.context() as context:
                    context.setattr(translate, '_retain_bytes', stop_wire)
                    return original_export(run, role, declared, **kwargs)
            raise KeyboardInterrupt
        return original_export(run, role, declared, **kwargs)
    run = runner(tmp_path)
    with monkeypatch.context() as context:
        context.setattr(translate, 'export_teaching_wire', interrupted_export)
        with pytest.raises(KeyboardInterrupt): invoke(run)
    assert len(run.ledger['calls']) == 3 and run.result(ROLE)['status'] == 'ok'
    assert not (tmp_path/'views'/(ROLE+'.wire-export-receipt.json')).exists()
    assert (tmp_path/'artifacts'/(ROLE+'.json')).exists() is partial
    frozen_response = (tmp_path/'attempts'/ROLE/'001/response.json').read_bytes()
    resumed = Runner(tmp_path, translate, resume=True)
    invoke(resumed)
    assert len(resumed.ledger['calls']) == 21
    assert sum(call['key'] == ROLE for call in resumed.ledger['calls']) == 1
    assert (tmp_path/'attempts'/ROLE/'001/response.json').read_bytes() == frozen_response
    assert report(tmp_path, translate)['status'] == 'complete'


@pytest.mark.parametrize('failures', (1, 2, 3))
def test_strict_wire_corrections_keep_raw_attempts_costs_and_exhausted_resume(tmp_path, failures):
    bundle, blobs = load_manifest(EXAMPLE, translate)
    config = {'provider': 'bedrock', 'image_limit': 3, 'model': 'inert-no-service', 'region': 'us-east-2',
              'max_output_tokens': 8192, 'input_token_bound': 1000000,
              'input_per_million': .24, 'output_per_million': .97, 'cap_usd': 1}
    class Provider:
        def __init__(self): self.calls = []
        def invoke(self, request, *, role, notes_pages):
            self.calls.append((role, deepcopy(request)))
            response = Fixture().invoke(request, role=role, notes_pages=notes_pages)
            response['usage'] = {'inputTokens': 100, 'outputTokens': 20}
            if role == ROLE and sum(key == ROLE for key, _ in self.calls) <= failures:
                raw = response['output']['message']['content'][0]['text']
                response['output']['message']['content'][0]['text'] = raw[:-1]  # Never repaired by host.
            return response
    run = Runner(tmp_path, translate, bundle=bundle, blobs=blobs, config=config)
    provider = Provider(); run.provider = provider
    if failures < 3: invoke(run)
    else:
        with pytest.raises(ValueError, match='required stage unavailable'): invoke(run)
    count = 21+failures if failures < 3 else 5
    assert len(provider.calls) == len(run.ledger['calls']) == count
    assert run.exposure() == pytest.approx(float(Decimal(count)*Decimal('0.0000434')))
    for number in range(1, min(failures+1, 3)+1):
        path = tmp_path/'attempts'/ROLE/f'{number:03d}'
        assert read(path/'checkpoint.json')['status'] == ('failed' if number <= failures else 'ok')
        raw = read(path/'response.json')['output']['message']['content'][0]['text']
        assert raw.endswith('}') is (number > failures)
    before = {str(path.relative_to(tmp_path)): path.read_bytes() for path in tmp_path.rglob('*') if path.is_file()}
    resumed = Runner(tmp_path, translate, resume=True); resumed.provider = provider
    if failures < 3: invoke(resumed)
    else:
        with pytest.raises(ValueError, match='required stage unavailable'): invoke(resumed)
    assert len(provider.calls) == count
    assert before == {str(path.relative_to(tmp_path)): path.read_bytes() for path in tmp_path.rglob('*') if path.is_file()}
