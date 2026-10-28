"""Reference wiring/accounting checks: no paid generation or curriculum fixtures."""
import json
from pathlib import Path
import socket
import sys
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import run_factory as cli
from reference.factories import guideline as factory
from reference.inputs import ROOT, canonical, load_manifest, read, save, sha
from reference.providers import Bedrock, Fixture
from reference.runtime import Runner, exclusive, report

EXAMPLE = ROOT/'examples/guideline/manifest.json'
FIXTURE = {'provider': 'fixture', 'image_limit': 3}
BEDROCK = {'provider': 'bedrock', 'image_limit': 3, 'model': 'meta.synthetic-not-live',
           'region': 'us-east-2', 'max_output_tokens': 8192, 'input_token_bound': 1000000,
           'input_per_million': .24, 'output_per_million': .97, 'cap_usd': 1}


def runner(tmp_path, *, config=None, page_count=None):
    bundle, blobs = load_manifest(EXAMPLE, factory)
    if page_count:
        bundle['pages'] = bundle['pages'][:page_count]
    tmp_path.mkdir(exist_ok=True)
    return Runner(tmp_path, factory, bundle=bundle, blobs=blobs, config=config or FIXTURE)


def invoke(run):
    factory.graph(run).invoke({'last_role': 'start'})


def test_real_graph_no_network_negative_feedback_and_resume(tmp_path, monkeypatch):
    def forbidden(*args, **kwargs):
        raise AssertionError('Live client/network is forbidden')
    import boto3
    monkeypatch.setattr(boto3, 'client', forbidden)
    monkeypatch.setattr(socket.socket, 'connect', forbidden)
    run = runner(tmp_path)
    invoke(run)
    assert len(run.ledger['calls']) == 16
    assert not (tmp_path/'ledger.json').exists()
    assert report(tmp_path, factory)['status'] == 'complete'
    assert run.output('accuracy')['ok'] is False
    assert read(tmp_path/'artifacts/guideline.json') == run.output('revision')['artifact']
    (tmp_path/'artifacts/guideline.json').unlink()
    resumed = Runner(tmp_path, factory, resume=True)
    invoke(resumed)
    assert len(resumed.ledger['calls']) == 16
    assert (tmp_path/'artifacts/guideline.json').exists()
    assert set(factory.graph(run).get_graph().nodes) == {'__start__', '__end__', *factory.ROLES}


def test_single_batch_eight_roles_no_extra_inspections(tmp_path):
    run = runner(tmp_path, page_count=2)
    invoke(run)
    assert len(run.ledger['calls']) == 8
    assert not any('__batch_' in c['key'] for c in run.ledger['calls'])


def test_independent_roles_all_original_images_and_allowlist(tmp_path, monkeypatch):
    monkeypatch.setenv('PRIVATE_OPERATOR_HISTORY', 'MUST_NOT_ENTER_REQUEST')
    run = runner(tmp_path)
    invoke(run)
    requests = {p.stem: read(p) for p in (tmp_path/'requests').glob('*.json')}
    assert requests['draft_1__batch_1'] == requests['draft_2__batch_1']
    assert requests['draft_1'] == requests['draft_2']
    all_text = json.dumps(requests)
    for prohibited in ('MUST_NOT_ENTER_REQUEST', 'AGENTS.md', 'SKILL.md', str(tmp_path), 'sentinel.png', 'context.txt'):
        assert prohibited not in all_text
    assert 'Grade 4, Indian student' not in all_text
    for role in factory.ROLES:
        batches = [requests[role+'__batch_1'], requests[role]]
        assert all(len(q['messages']) == 1 for q in batches)
        assert [sum('image' in c for c in q['messages'][0]['content']) for q in batches] == [3, 1]
        numbers = [int(c['text'].split()[-1][:-1]) for q in batches for c in q['messages'][0]['content'] if c.get('text', '').startswith('Original printed page')]
        assert numbers == [101, 102, 103, 104]
        assert read(tmp_path/'checkpoints'/f'{role}__batch_1.json')['output']['page_notes'][0]['printed_page'] == 101


def test_manifest_relative_json_text_and_unknown_metadata(tmp_path):
    value = read(EXAMPLE)
    value['pages'] = [{'printed_page': 'xix', 'path': str(EXAMPLE.parent/'sentinel.png')},
                      {'printed_page': 19, 'path': str(EXAMPLE.parent/'sentinel.png')}]
    value['files'] = {'context': {'path': 'context.json', 'type': 'json'}}
    save(tmp_path/'context.json', {'synthetic': 'SENTINEL'})
    save(tmp_path/'manifest.json', value)
    bundle, _ = load_manifest(tmp_path/'manifest.json', factory)
    assert bundle['declared'] == {'context': {'synthetic': 'SENTINEL'}}
    assert [p['printed_page'] for p in bundle['pages']] == ['xix', 19]
    assert bundle['file_identity']['context']['sha256'] == sha((tmp_path/'context.json').read_bytes())
    value['metadata']['private_account_id'] = 'MUST_NOT_ENTER_REQUEST'
    save(tmp_path/'manifest.json', value)
    with pytest.raises(ValueError, match='allowlist'):
        load_manifest(tmp_path/'manifest.json', factory)


def test_partial_batch_resume_no_duplicate_or_shared_notes(tmp_path):
    run = runner(tmp_path)
    batch = run.bundle['pages'][:3]
    request = factory.request(run, 'draft_1', {}, batch, [], False)
    run.invoke('draft_1__batch_1', 'draft_1', request, lambda t: factory.parse('draft_1', t, [101,102,103]), notes_pages=[101,102,103])
    resumed = Runner(tmp_path, factory, resume=True)
    invoke(resumed)
    assert len(resumed.ledger['calls']) == 16
    assert len([c for c in resumed.ledger['calls'] if c['key'] == 'draft_1__batch_1']) == 1


def test_ambiguous_failure_retains_reservation_and_no_retry(tmp_path, monkeypatch):
    def fail(*args, **kwargs):
        raise RuntimeError('PRIVATE-ACCOUNT /private/path')
    monkeypatch.setattr(Bedrock, 'invoke', fail)
    run = runner(tmp_path, config=BEDROCK, page_count=1)
    result = run.role('draft_1', {})
    assert result['status'] == 'failed'
    before = run.exposure()
    assert before > 0
    resumed = Runner(tmp_path, factory, resume=True)
    assert resumed.role('draft_1', {}) == result
    assert resumed.exposure() == before
    assert len(resumed.ledger['calls']) == 1
    assert 'PRIVATE-ACCOUNT' not in json.dumps(resumed.output('draft_1'))
    report(tmp_path, factory)
    assert 'PRIVATE-ACCOUNT' not in (tmp_path/'report.html').read_text()


def test_missing_checkpoint_blocks_duplicate_and_missing_ledger_blocks_reset(tmp_path):
    run = runner(tmp_path)
    run.role('draft_1', {})
    (tmp_path/'checkpoints/draft_1.json').unlink()
    with pytest.raises(RuntimeError, match='manual reconciliation'):
        Runner(tmp_path, factory, resume=True).role('draft_1', {})
    run.ledger_path.unlink()
    with pytest.raises(RuntimeError, match='Missing ledger'):
        Runner(tmp_path, factory, resume=True)


def test_budget_blocks_before_transport_and_config_not_reset(tmp_path, monkeypatch):
    def forbidden(*args, **kwargs):
        raise AssertionError('Budget must stop before transport')
    monkeypatch.setattr(Bedrock, 'invoke', forbidden)
    config = {**BEDROCK, 'cap_usd': .01}
    run = runner(tmp_path, config=config)
    with pytest.raises(RuntimeError, match='cap'):
        run.role('draft_1', {})
    assert not run.ledger['calls']
    with pytest.raises(RuntimeError, match='contains evidence'):
        runner(tmp_path, config=BEDROCK)


def test_returned_fields_preserved_missing_structure_advisory(tmp_path, monkeypatch):
    original = Fixture.invoke
    def extra(self, request, *, role, notes_pages):
        if role == 'refresher' and not notes_pages:
            return {'output': {'message': {'content': [{'text': json.dumps({'artifact': {'extra': [1,2]}, 'topic_summary': 'SYNTHETIC ENVELOPE'})}]}}, 'stopReason': 'end_turn'}
        return original(self, request, role=role, notes_pages=notes_pages)
    monkeypatch.setattr(Fixture, 'invoke', extra)
    run = runner(tmp_path)
    invoke(run)
    assert read(tmp_path/'artifacts/refresher-guideline.json') == {'extra': [1,2]}
    assert run.output('refresher')['topic_summary'] == 'SYNTHETIC ENVELOPE'
    assert report(tmp_path, factory)['status'] == 'complete'


def test_changed_frozen_images_or_checkpoint_refused(tmp_path):
    run = runner(tmp_path)
    run.role('draft_1', {})
    checkpoint = tmp_path/'checkpoints/draft_1.json'
    save(checkpoint, {'status': 'ok', 'output': {'artifact': {'tampered': True}}})
    with pytest.raises(RuntimeError, match='Checkpoint'):
        Runner(tmp_path, factory, resume=True).role('draft_1', {})
    (tmp_path/'inputs/page-0.png').write_bytes(b'changed')
    with pytest.raises(ValueError, match='Frozen image'):
        Runner(tmp_path, factory, resume=True)


def test_duplicate_operator_lock(tmp_path):
    with exclusive(tmp_path):
        with pytest.raises(RuntimeError, match='Another operator'):
            with exclusive(tmp_path):
                pass


def test_cli_help_list_verify_and_paid_guard(tmp_path, monkeypatch, capsys):
    import boto3
    def forbidden(*args, **kwargs):
        raise AssertionError('No client for help/list/verify/default config')
    monkeypatch.setattr(boto3, 'client', forbidden)
    assert cli.main(['list']) == 0
    assert cli.main(['verify', str(EXAMPLE)]) == 0
    with pytest.raises(SystemExit) as error:
        cli.main(['--help'])
    assert error.value.code == 0
    with pytest.raises(ValueError, match='--allow-paid'):
        cli.main(['run', str(EXAMPLE), '--workspace', str(tmp_path/'uncreated'), '--provider', 'bedrock'])
    assert not (tmp_path/'uncreated').exists()
    with pytest.raises(ValueError, match='finite and positive'):
        cli.main(['run', str(EXAMPLE), '--workspace', str(tmp_path/'uncreated'), '--provider', 'bedrock', '--config', str(ROOT/'examples/bedrock-config.json'), '--allow-paid'])
    assert not (tmp_path/'uncreated').exists()


@pytest.mark.parametrize('constant', ['NaN', 'Infinity', '-Infinity', '1e999', '-1e999'])
def test_nonfinite_response_is_failed_checkpoint_not_interruption(tmp_path, monkeypatch, constant):
    def malformed(*args, **kwargs):
        return {'output': {'message': {'content': [{'text': '{"artifact":{"unknown":'+constant+'}}'}]}}, 'stopReason': 'end_turn'}
    monkeypatch.setattr(Fixture, 'invoke', malformed)
    run = runner(tmp_path, page_count=1)
    result = run.role('draft_1', {})
    assert result['status'] == 'failed'
    assert 'Non-finite JSON' in result['error']
    resumed = Runner(tmp_path, factory, resume=True)
    assert resumed.role('draft_1', {}) == result
    assert len(resumed.ledger['calls']) == 1
