"""TOC graph/role boundaries with synthetic plumbing only; no paid inference."""
import builtins
import json
from pathlib import Path
import socket
import sys
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import run_factory as cli
from reference.factories import toc
from reference.inputs import ROOT, canonical, load_manifest, read, save, sha
from reference.providers import Fixture
from reference.runtime import Runner, report

EXAMPLE = ROOT/'examples/toc/manifest.json'
CONFIG = {'provider': 'fixture', 'image_limit': 3}


@pytest.fixture(autouse=True)
def offline(monkeypatch):
    original = builtins.__import__
    def no_sdk(name, *args, **kwargs):
        if name.split('.')[0] in ('boto3', 'botocore'):
            raise AssertionError('No SDK import/client permitted')
        return original(name, *args, **kwargs)
    def no_network(*args, **kwargs):
        raise AssertionError('No network permitted')
    monkeypatch.setattr(builtins, '__import__', no_sdk)
    monkeypatch.setattr(socket.socket, 'connect', no_network)
    monkeypatch.setattr(socket.socket, 'sendto', no_network)
    monkeypatch.setattr(socket, 'create_connection', no_network)


def runner(workspace, count=None, limit=3):
    bundle, blobs = load_manifest(EXAMPLE, toc)
    if count:
        bundle['pages'] = bundle['pages'][:count]
    workspace.mkdir(exist_ok=True)
    return Runner(workspace, toc, bundle=bundle, blobs=blobs,
                  config={**CONFIG, 'image_limit': limit})


def invoke(run):
    return toc.graph(run).invoke({'last_role': 'start'})


def payload(request):
    return json.loads(request['messages'][0]['content'][0]['text'].split('Declared task data:\n')[1])


def response(value):
    return {'output': {'message': {'content': [{'text': json.dumps(value)}]}}, 'stopReason': 'end_turn'}


def test_real_cli_graph_offline_resume_and_saved_map(tmp_path):
    workspace = tmp_path/'run'
    assert cli.main(['verify', str(EXAMPLE)]) == 0
    assert cli.main(['run', str(EXAMPLE), '--provider', 'fixture', '--workspace', str(workspace)]) == 0
    summary = read(workspace/'summary.json')
    assert summary['status'] == 'complete'
    assert summary['requests'] == 8
    assert summary['exposure_usd'] == 0
    assert not (workspace/'ledger.json').exists()
    final = read(workspace/'checkpoints/toc_revision.json')['output']['artifact']
    assert read(workspace/'artifacts/chapter-map.json') == final
    assert read(workspace/'checkpoints/toc_review.json')['output']['ok'] is False
    assert read(workspace/'diagnostics/draft.json')['stage'] == 'draft before final revision'
    html = (workspace/'report.html').read_text()
    assert 'Advisory pre-revision diagnostics' in html
    assert 'SYNTHETIC PLUMBING' in html and 'chapter-map.json' in html
    assert 'gate_pass' not in html
    (workspace/'artifacts/chapter-map.json').unlink()
    assert cli.main(['resume', '--workspace', str(workspace)]) == 0
    assert read(workspace/'summary.json')['requests'] == 8
    assert read(workspace/'artifacts/chapter-map.json') == final
    graph = toc.graph(Runner(workspace, toc, resume=True)).get_graph()
    assert set(graph.nodes) == {'__start__', '__end__', *toc.ROLES, 'draft_diagnostics'}
    assert {(e.source, e.target) for e in graph.edges} == {
        ('__start__', 'toc_draft'), ('toc_draft', 'toc_image_read'),
        ('toc_image_read', 'toc_review'), ('toc_review', 'draft_diagnostics'),
        ('draft_diagnostics', 'toc_revision'), ('toc_revision', '__end__')}


@pytest.mark.parametrize('count,limit,expected', [(1,3,4), (4,1,16)])
def test_single_batch_still_rereads_before_comparing_and_lower_limit(tmp_path, count, limit, expected):
    run = runner(tmp_path, count=count, limit=limit)
    invoke(run)
    assert len(run.ledger['calls']) == expected
    keys = [c['key'] for c in run.ledger['calls']]
    assert keys.index('toc_image_read') < keys.index('toc_review') < keys.index('toc_revision')


def test_all_images_exact_labels_isolated_image_first_notes_and_feedback(tmp_path, monkeypatch):
    monkeypatch.setenv('PRIVATE_OPERATOR_HISTORY', 'MUST_NOT_ENTER_REQUEST')
    run = runner(tmp_path)
    invoke(run)
    requests = {p.stem: read(p) for p in (tmp_path/'requests').glob('*.json')}
    text = json.dumps(requests)
    for prohibited in ('MUST_NOT_ENTER_REQUEST', 'AGENTS.md', 'SKILL.md', str(tmp_path),
                       'sentinel.png', 'AWS_PROFILE', 'book.json'):
        assert prohibited not in text
    labels = ['xix', 19, 'xx', 20]
    for role in toc.ROLES:
        batches = [requests[role+'__batch_1'], requests[role]]
        assert [sum('image' in b for b in q['messages'][0]['content']) for q in batches] == [3,1]
        observed = [json.loads(b['text'][22:-1]) for q in batches for b in q['messages'][0]['content']
                    if b.get('text', '').startswith('Original printed page ')]
        assert canonical(observed) == canonical(labels)
        assert all(len(q['messages']) == 1 for q in batches)
    for key in ('toc_image_read__batch_1', 'toc_image_read'):
        assert payload(requests[key])['task_inputs'] == {}
        assert 'draft_map' not in json.dumps(requests[key])
    reread_notes = payload(requests['toc_image_read'])['role_local_page_notes']
    assert canonical([n['printed_page'] for n in reread_notes]) == canonical(labels[:3])
    compare = payload(requests['toc_review'])['task_inputs']
    assert canonical([n['printed_page'] for n in compare['image_first_notes']]) == canonical(labels)
    assert compare['draft_map'] == run.output('toc_draft')['artifact']
    revision = payload(requests['toc_revision'])['task_inputs']
    assert revision['review'] == run.output('toc_review')
    assert revision['draft_structural_observations'] == read(tmp_path/'diagnostics/draft.json')
    assert 'next start minus one' in requests['toc_revision']['messages'][0]['content'][0]['text']
    assert 'estimated final end' in requests['toc_revision']['messages'][0]['content'][0]['text']
    assert 'synthetic estimate' in read(tmp_path/'artifacts/chapter-map.json')['source_note']


def test_pruned_book_context_missing_images_and_no_shared_ocr(tmp_path):
    value = read(EXAMPLE)
    value['pages'] = [{'printed_page': 'xix', 'path': str(EXAMPLE.parent/'../guideline/sentinel.png')}]
    path = tmp_path/'manifest.json'
    value['metadata']['chapter_title'] = 'OUTSIDE_TOC_CONTEXT'
    save(path, value)
    with pytest.raises(ValueError, match='allowlist'):
        load_manifest(path, toc)
    del value['metadata']['chapter_title']
    value['files'] = {'context': {'type': 'text', 'path': 'ocr.txt'}}
    save(path, value)
    with pytest.raises(ValueError, match='Undeclared file'):
        load_manifest(path, toc)
    del value['files']
    value['pages'][0]['path'] = 'missing-original.png'
    save(path, value)
    with pytest.raises(FileNotFoundError):
        cli.main(['run', str(path), '--provider', 'fixture', '--workspace', str(tmp_path/'uncreated')])
    assert not (tmp_path/'uncreated').exists()


def test_diagnostics_only_draft_final_unchanged_despite_negative_feedback(tmp_path, monkeypatch):
    original = Fixture.invoke
    bad_draft = {'chapters': [
        {'chapter_number': 4, 'chapter_title': ' ', 'start_page': 9, 'end_page': 8},
        {'chapter_number': 2, 'chapter_title': 'SENTINEL', 'start_page': 10, 'end_page': 12},
        {'chapter_number': 3, 'chapter_title': 'sentinel', 'start_page': 15, 'end_page': 18},
        {'chapter_number': 4, 'chapter_title': 'OTHER', 'start_page': 18, 'end_page': 20}]}
    final = {'chapters': [], 'source_note': 'SYNTHETIC unresolved author output', 'extra': {'kept': True}}
    def synthetic(self, request, *, role, notes_pages):
        if not notes_pages and role in ('toc_draft', 'toc_revision'):
            return response({'artifact': bad_draft if role == 'toc_draft' else final, 'audit': 'KEPT'})
        return original(self, request, role=role, notes_pages=notes_pages)
    monkeypatch.setattr(Fixture, 'invoke', synthetic)
    inspected = []
    actual_diagnostics = toc.diagnostics
    def track(artifact):
        inspected.append(artifact)
        return actual_diagnostics(artifact)
    monkeypatch.setattr(toc, 'diagnostics', track)
    run = runner(tmp_path, count=1)
    invoke(run)
    assert inspected == [bad_draft]
    issues = ' '.join(read(tmp_path/'diagnostics/draft.json')['issues'])
    for category in ('sequential', 'empty', 'inclusive', 'duplicate', 'gap', 'overlaps'):
        assert category in issues
    assert read(tmp_path/'artifacts/chapter-map.json') == final
    assert run.output('toc_revision')['audit'] == 'KEPT'
    assert report(tmp_path, toc)['status'] == 'complete'
    assert len(run.ledger['calls']) == 4


@pytest.mark.parametrize('role', ['toc_draft', 'toc_image_read', 'toc_review', 'toc_revision'])
def test_transport_failure_remains_failure_no_retry(tmp_path, monkeypatch, role):
    original = Fixture.invoke
    def fail(self, request, *, role: str, notes_pages):
        if role == failing_role:
            raise RuntimeError('PRIVATE_ACCOUNT /private/input')
        return original(self, request, role=role, notes_pages=notes_pages)
    failing_role = role
    monkeypatch.setattr(Fixture, 'invoke', fail)
    run = runner(tmp_path, count=1)
    try:
        invoke(run)
    except ValueError:
        pass
    assert report(tmp_path, toc)['status'] == 'partial_or_failed'
    assert not (tmp_path/'artifacts/chapter-map.json').exists()
    before = len(run.ledger['calls'])
    resumed = Runner(tmp_path, toc, resume=True)
    try:
        invoke(resumed)
    except ValueError:
        pass
    assert len(resumed.ledger['calls']) == before
    assert 'PRIVATE_ACCOUNT' not in (tmp_path/'report.html').read_text()


def test_partial_image_read_resume_uses_own_checkpoint_no_repeat(tmp_path):
    run = runner(tmp_path)
    run.role('toc_draft', {})
    batch = run.bundle['pages'][:3]
    labels = [p['printed_page'] for p in batch]
    run.invoke('toc_image_read__batch_1', 'toc_image_read',
        toc.request(run, 'toc_image_read', {}, batch, [], False),
        lambda text: toc.parse('toc_image_read', text, labels), notes_pages=labels)
    resumed = Runner(tmp_path, toc, resume=True)
    invoke(resumed)
    assert len(resumed.ledger['calls']) == 8
    assert [c['key'] for c in resumed.ledger['calls']].count('toc_image_read__batch_1') == 1


def test_parse_failure_not_semantic_veto_and_prompt_identity(tmp_path, monkeypatch):
    run = runner(tmp_path, count=1)
    for name in ('toc_extractor', 'toc_verifier'):
        path = f'prompts/{name}.md'
        assert run.identity['runtime']['files'][path] == sha((ROOT/path).read_bytes())
    original = Fixture.invoke
    def malformed(self, request, *, role, notes_pages):
        if role == 'toc_revision':
            return response({'artifact': 'not a JSON artifact object'})
        return original(self, request, role=role, notes_pages=notes_pages)
    monkeypatch.setattr(Fixture, 'invoke', malformed)
    invoke(run)
    assert run.result('toc_revision')['status'] == 'failed'
    assert report(tmp_path, toc)['status'] == 'partial_or_failed'
    assert not (tmp_path/'artifacts/chapter-map.json').exists()
    # Source-shaped details remain content observations, not a technical schema gate.
    assert toc.parse('toc_revision', '{"artifact":{"chapters":"imperfect"}}')['artifact']['chapters'] == 'imperfect'
    with pytest.raises(ValueError, match='exactly typed'):
        toc.parse('toc_image_read', '{"page_notes":[{"printed_page":19.0,"observations":"sentinel"}]}', [19])
