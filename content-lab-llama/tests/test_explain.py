"""Synthetic Explain graph plumbing and final-author boundaries; no curricula or calls."""
import builtins
import difflib
import json
from pathlib import Path
import socket
import sys
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import run_factory as cli
from reference.factories import explain
from reference.inputs import ROOT, load_manifest, read, save, sha
from reference.providers import Fixture
from reference.runtime import Runner, report

EXAMPLE = ROOT/'examples/explain/manifest.json'
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
    monkeypatch.setattr(socket, 'create_connection', no_network)


def runner(workspace):
    bundle, blobs = load_manifest(EXAMPLE, explain)
    workspace.mkdir(exist_ok=True)
    return Runner(workspace, explain, bundle=bundle, blobs=blobs, config=CONFIG)


def invoke(run):
    return explain.graph(run).invoke({'last_role': 'start'})


def payload(request):
    return json.loads(request['messages'][0]['content'][0]['text'].split('Declared task data:\n')[1])['task_inputs']


def response(value):
    return {'output': {'message': {'content': [{'text': json.dumps(value)}]}}, 'stopReason': 'end_turn'}


def test_cli_offline_full_graph_final_exports_report_and_resume(tmp_path):
    workspace = tmp_path/'run'
    assert cli.main(['verify', str(EXAMPLE)]) == 0
    assert cli.main(['run', str(EXAMPLE), '--provider', 'fixture', '--workspace', str(workspace)]) == 0
    summary = read(workspace/'summary.json')
    assert summary['status'] == 'complete' and summary['requests'] == 16
    assert summary['exposure_usd'] == 0 and not (workspace/'ledger.json').exists()
    for role, filename in explain.EXPORTS.items():
        artifact = read(workspace/f'checkpoints/{role}.json')['output']['artifact']
        path = workspace/'artifacts'/filename
        assert (path.read_text() if path.suffix == '.md' else read(path)) == artifact
    assert (workspace/'artifacts/selected-draft.md').read_text() == read(workspace/'checkpoints/explain_writer_2.json')['output']['artifact']
    html = (workspace/'report.html').read_text()
    assert 'explanation.md' in html and 'deck.json' in html and 'check-ins.json' in html
    assert 'Host bookkeeping' in html and 'SYNTHETIC PLUMBING' in html and 'holistic_pass' in html
    before = read(workspace/'synthetic-ledger.json')
    for path in (workspace/'artifacts').iterdir():
        path.unlink()
    assert cli.main(['resume', '--workspace', str(workspace)]) == 0
    assert read(workspace/'synthetic-ledger.json') == before
    assert (workspace/'artifacts/explanation.md').exists()
    graph = explain.graph(Runner(workspace, explain, resume=True)).get_graph()
    assert set(graph.nodes) == {'__start__', '__end__', *explain.ROLES}
    expected = list(zip(('__start__', *explain.ROLES), (*explain.ROLES, '__end__')))
    assert {(e.source, e.target) for e in graph.edges} == set(expected)


def test_independent_writers_blind_choice_lenses_feedback_and_artifact_ownership(tmp_path, monkeypatch):
    monkeypatch.setenv('PRIVATE_OPERATOR_HISTORY', 'MUST_NOT_ENTER')
    run = runner(tmp_path)
    invoke(run)
    requests = {p.stem: read(p) for p in (tmp_path/'requests').glob('*.json')}
    text = json.dumps(requests)
    for prohibited in ('MUST_NOT_ENTER', 'AGENTS.md', 'SKILL.md', str(tmp_path), 'AWS_PROFILE', 'manifest.json'):
        assert prohibited not in text
    assert all(len(q['messages']) == 1 and len(q['messages'][0]['content']) == 2
               for q in requests.values())
    w1, w2 = (payload(requests['explain_writer_'+str(i)]) for i in (1, 2))
    assert w1 == w2
    assert set(w1) == {'guideline', 'supplied_research', 'misconception_research', 'arc'}
    choice = payload(requests['explain_selection'])['candidates']
    assert choice == [{'index': i, 'prose': run.output(f'explain_writer_{i}')['artifact']} for i in (1, 2)]
    winner = payload(requests['explain_winner_revision'])
    assert winner['your_draft'] == run.output('explain_writer_2')['artifact']
    assert winner['selection_concerns'] == run.output('explain_selection')['concerns']
    lens_inputs = [payload(requests['explain_'+lens]) for lens in explain.LENSES]
    assert lens_inputs[0] == lens_inputs[1] == lens_inputs[2]
    assert 'reviews' not in lens_inputs[0]
    refined = payload(requests['explain_prose_final'])
    assert list(refined['reviews']) == list(explain.LENSES)
    assert len(refined['indexed_findings']) == 3
    assert refined['winner_dispositions'] == run.output('explain_winner_revision')['dispositions']
    split_final = payload(requests['explain_split_final'])
    assert split_final['split_review']['ok'] is False
    assert split_final['draft_deck'] == run.output('explain_split')['artifact']
    assert split_final['final_prose'] == run.output('explain_prose_final')['artifact']
    checkin_final = payload(requests['explain_checkins_final'])
    assert checkin_final['checkin_review']['holistic_pass'] is False
    assert checkin_final['checkin_review']['wrong']
    assert checkin_final['checkin_review']['holistic_issues'][0]['dimension'] == 'coverage'
    assert checkin_final['deck'] == run.output('explain_split_final')['artifact']
    assert set(checkin_final) == {'guideline', 'deck', 'draft_check_ins', 'checkin_review'}
    assert len(run.ledger['calls']) == 16


def test_native_fixture_deck_sections_indices_and_four_activity_types(tmp_path):
    run = runner(tmp_path)
    invoke(run)
    cards = read(tmp_path/'artifacts/deck.json')['cards']
    sections = explain.guideline_view(run.bundle)['sections']
    assert [c['card_idx'] for c in cards] == list(range(1, 13))
    assert cards[0]['card_type'] == 'welcome' and cards[-1]['card_type'] == 'summary'
    for card in cards:
        assert card['section_key'] == sections[card['section_seq']-1]['section_key']
        assert card['visual'] is None and set(card['lines'][0]) == {'display', 'audio'}
    items = read(tmp_path/'artifacts/check-ins.json')['check_ins']
    assert {item['activity_type'] for item in items} == {'pick_one', 'fill_blank', 'multi_select', 'true_false'}
    assert [item['insert_after_card_idx'] for item in items] == [3, 3, 7, 7, 11, 11]
    for item in items:
        assert 3 <= item['insert_after_card_idx'] < len(cards)
        assert {'title','instruction','hint','success_message','audio_text'} <= item.keys()
        if item['activity_type'] in ('pick_one', 'fill_blank'):
            assert 0 <= item['correct_index'] < len(item['options'])
        elif item['activity_type'] == 'multi_select':
            assert set(item['correct_indices']) < set(range(len(item['options'])))
        else:
            assert type(item['correct_answer']) is bool


def test_guideline_adapter_exact_order_text_both_misconception_sources_and_research_absence(tmp_path):
    bundle, blobs = load_manifest(EXAMPLE, explain)
    source = bundle['declared']['guideline']
    source['sections'][0]['guidelines'] += '\n- EMBEDDED MISCONCEPTION SENTINEL'
    source['misconceptions'] = ['TOP LEVEL MISCONCEPTION SENTINEL']
    source['unrelated_operational_field'] = 'MUST_NOT_ENTER'
    del bundle['declared']['research']
    view = explain.guideline_view(bundle)
    assert view['guideline_text'] == '\n\n'.join(s['guidelines'] for s in source['sections'])
    assert [s['section_key'] for s in view['sections']] == [s['topic_key'] for s in source['sections']]
    assert [s['title'] for s in view['sections']] == [s['topic_title'] for s in source['sections']]
    run = Runner(tmp_path, explain, bundle=bundle, blobs=blobs, config=CONFIG)
    invoke(run)
    inputs = payload(read(tmp_path/'requests/explain_research.json'))
    assert inputs['guideline']['misconceptions'] == source['misconceptions']
    assert 'EMBEDDED MISCONCEPTION SENTINEL' in inputs['guideline']['guideline_text']
    assert 'MUST_NOT_ENTER' not in json.dumps(inputs)
    assert inputs['supplied_research']['supplied'] is False
    assert inputs['supplied_research']['fresh_web_research'] is False
    assert 'No external research supplied' in inputs['supplied_research']['context']
    assert read(tmp_path/'artifacts/research.json')['candidates'] == []
    # Native single-topic input is also accepted without inventing sections.
    bundle['declared']['guideline'] = {'topic': 'SYNTHETIC', 'guideline_text': 'EXACT TEXT', 'misconceptions': []}
    assert explain.guideline_view(bundle)['sections'] == []


def test_supplied_research_citations_labelled_and_preserved(tmp_path):
    bundle, blobs = load_manifest(EXAMPLE, explain)
    research = {'context': 'SUPPLIED SENTINEL', 'citations': [{'label': 'SYNTHETIC ONLY',
                'url': 'urn:synthetic:unverified', 'excerpt': 'EXACT SUPPLIED EXCERPT'}]}
    bundle['declared']['research'] = research
    run = Runner(tmp_path, explain, bundle=bundle, blobs=blobs, config=CONFIG)
    invoke(run)
    value = payload(read(tmp_path/'requests/explain_research.json'))['supplied_research']
    assert value == {**research, 'supplied': True, 'fresh_web_research': False}


@pytest.mark.parametrize('mode', ['amplify', 'insert', 'checkins', 'enrich', 'production', 'GENERATE'])
def test_unsupported_modes_rejected_before_runner_or_provider(tmp_path, monkeypatch, mode):
    value = read(EXAMPLE)
    value['metadata']['mode'] = mode
    value['files'] = {'guideline': {'type': 'json', 'path': str(EXAMPLE.parent/'guideline.json')}}
    path = tmp_path/'manifest.json'
    save(path, value)
    def forbidden(*args, **kwargs):
        raise AssertionError('Runner/provider must not be created')
    monkeypatch.setattr(cli, 'Runner', forbidden)
    with pytest.raises(ValueError, match='only generate'):
        cli.main(['run', str(path), '--provider', 'fixture', '--workspace', str(tmp_path/'uncreated')])
    assert not (tmp_path/'uncreated').exists()


@pytest.mark.parametrize('role', ['explain_research','explain_writer_2','explain_accuracy',
                                  'explain_prose_final','explain_split_final','explain_checkins_final'])
def test_technical_failure_stops_without_substitution_or_repeat(tmp_path, monkeypatch, role):
    original = Fixture.invoke
    def fail(self, request, *, role: str, notes_pages):
        if role == failing_role:
            raise RuntimeError('PRIVATE_ACCOUNT /private/input')
        return original(self, request, role=role, notes_pages=notes_pages)
    failing_role = role
    monkeypatch.setattr(Fixture, 'invoke', fail)
    run = runner(tmp_path)
    with pytest.raises(ValueError, match='required stage unavailable'):
        invoke(run)
    assert report(tmp_path, explain)['status'] == 'partial_or_failed'
    before = len(run.ledger['calls'])
    resumed = Runner(tmp_path, explain, resume=True)
    with pytest.raises(ValueError):
        invoke(resumed)
    assert len(resumed.ledger['calls']) == before
    for stage, filename in explain.EXPORTS.items():
        if explain.ROLES.index(stage) >= explain.ROLES.index(role):
            assert not (tmp_path/'artifacts'/filename).exists()
    assert 'PRIVATE_ACCOUNT' not in (tmp_path/'report.html').read_text()


def test_partial_resume_and_exact_final_content_despite_critical_reviews(tmp_path, monkeypatch):
    original = Fixture.invoke
    prose = '  ## SYNTHETIC\r\n\r\nExact final prose: ए <script> & sentinel.  \n\n'
    final_deck = {'cards': [], 'summary': {}, 'unknown_field': 'PRESERVED WITHOUT INCUMBENT'}
    final_checkins = {'check_ins': [{'insert_after_card_idx': -99, 'activity_type': 'imperfect'}]}
    def outputs(self, request, *, role, notes_pages):
        artifact = {'explain_prose_final': prose, 'explain_split_final': final_deck,
                    'explain_checkins_final': final_checkins}.get(role)
        if artifact is not None:
            return response({'artifact': artifact, 'unanswered': ['SYNTHETIC CRITICAL ISSUE']})
        return original(self, request, role=role, notes_pages=notes_pages)
    monkeypatch.setattr(Fixture, 'invoke', outputs)
    run = runner(tmp_path)
    for role in explain.ROLES[:4]:
        run.role(role, explain.declared(run, role))
    resumed = Runner(tmp_path, explain, resume=True)
    invoke(resumed)
    assert len(resumed.ledger['calls']) == 16
    assert (tmp_path/'artifacts/explanation.md').read_bytes() == prose.encode()
    assert read(tmp_path/'artifacts/deck.json') == final_deck
    assert read(tmp_path/'artifacts/check-ins.json') == final_checkins
    assert read(tmp_path/'metrics/explain_prose_final.json')['word_count'] == len(prose.split())
    assert report(tmp_path, explain)['status'] == 'complete'
    assert '&lt;script&gt;' in (tmp_path/'report.html').read_text()


def test_parse_failures_are_honest_not_native_semantic_veto(tmp_path, monkeypatch):
    with pytest.raises(ValueError):
        explain.parse('explain_selection', '{"winner_index":true}')
    with pytest.raises(ValueError):
        explain.parse('explain_accuracy', '{"written":true}')
    with pytest.raises(ValueError):
        explain.parse('explain_prose_final', '{"artifact":{"receipt":true}}')
    original = Fixture.invoke
    def malformed(self, request, *, role, notes_pages):
        if role == 'explain_split_final':
            return response({'artifact': 'a receipt cannot replace a JSON artifact'})
        return original(self, request, role=role, notes_pages=notes_pages)
    monkeypatch.setattr(Fixture, 'invoke', malformed)
    run = runner(tmp_path)
    with pytest.raises(ValueError):
        invoke(run)
    assert run.result('explain_split_final')['status'] == 'failed'
    assert report(tmp_path, explain)['status'] == 'partial_or_failed'
    assert not (tmp_path/'artifacts/deck.json').exists()
    assert explain.parse('explain_split_final', '{"artifact":{"cards":"imperfect"}}')['artifact']['cards'] == 'imperfect'


def test_frozen_nested_prompts_hashes_and_exact_attribution_diffs(tmp_path):
    run = runner(tmp_path)
    manifest = read(ROOT/'prompts/explain-manifest.json')
    for item in manifest['files']:
        name = item['name']+'.md'
        source = ROOT/'prompts/source/explain'/name
        active = ROOT/'prompts/explain'/name
        assert sha(source.read_bytes()) == item['source_sha256']
        assert sha(active.read_bytes()) == item['adapted_sha256']
        assert run.identity['runtime']['files']['prompts/explain/'+name] == item['adapted_sha256']
        diff = ''.join(difflib.unified_diff(source.read_text().splitlines(keepends=True),
            active.read_text().splitlines(keepends=True), fromfile='source/'+name, tofile='explain/'+name))
        assert (ROOT/'prompts/explain'/(name+'.diff')).read_text() == diff
