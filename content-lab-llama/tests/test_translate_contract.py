"""Translate final response instructions, frozen projections and native failures."""
import ast
import json
from pathlib import Path

import pytest

from test_translate import offline, runner, invoke, EXAMPLE, PACKS, intercept
from reference.factories import translate
from reference.factories.translate_fixture import payload
from reference.inputs import ROOT, canonical, load_manifest, read, sha
from reference.providers import Bedrock, Fixture
from reference.runtime import Runner, model_response_json, report


def tree_hash(paths):
    return sha(canonical({str(p.relative_to(ROOT)): sha(p.read_bytes()) for p in sorted(paths)}))


def capture(workspace, *, appended):
    scenarios = {}
    for size in (12, 2):
        bundle, _ = load_manifest(EXAMPLE, translate)
        bundle['metadata']['batch_size'] = size
        target = workspace/str(size)
        run = runner(target, bundle)
        invoke(run)
        roles = translate.report_roles(target)
        requests = {}
        for role in roles:
            request = read(target/'requests'/f'{role}.json')
            # T21 adds only teaching-final system; the original T14 user-block
            # baseline and every other request/projection/export remain exact.
            if role.startswith('translate_teaching_') and role.endswith('_final'):
                from test_translate_teaching_final_system import SCOPE
                assert request.pop('system') == [{'text': request['messages'][0]['content'][1]['text']+SCOPE}]
            content = request['messages'][0]['content']
            assert len(request['messages']) == 1
            assert len(content) == (2 if appended else 1)
            request['messages'][0]['content'] = content[:1]
            requests[role] = {'request_sha256': sha(canonical(request)),
                             'first_block_sha256': sha(content[0]['text'].encode()),
                             'declared_sha256': sha(canonical(payload(request)))}
        assert report(target, translate)['status'] == 'complete'
        assert [c['role'] for c in run.ledger['calls']] == list(roles)
        ledger = read(run.ledger_path)
        saved = {p.name: p.read_bytes() for p in (target/'requests').glob('*.json')}
        invoke(Runner(target, translate, resume=True))
        assert read(run.ledger_path) == ledger
        assert {p.name: p.read_bytes() for p in (target/'requests').glob('*.json')} == saved
        scenarios[str(size)] = {
            'requests': requests,
            'outputs': {role: sha(canonical(run.output(role))) for role in roles},
            'files': {folder: {p.name: sha(p.read_bytes()) for p in sorted((target/folder).glob('*.json'))}
                      for folder in ('views', 'artifacts', 'diagnostics')}}
    module = ast.parse(Path(translate.__file__).read_text())
    module.body = [n for n in module.body if not (isinstance(n, ast.FunctionDef) and n.name == 'request')]
    return {'scenarios': scenarios,
            'outside_request_ast_sha256': sha(ast.dump(module).encode()),
            'prompt_tree_sha256': tree_hash(p for p in (ROOT/'prompts').rglob('*') if p.is_file()),
            'other_reference_tree_sha256': tree_hash(p for p in (ROOT/'reference').rglob('*.py')
                                                   if p != Path(translate.__file__)),
            'requirements_sha256': sha((ROOT/'requirements.lock').read_bytes())}


def test_exact_pre_edit_requests_dynamic_batches_projections_and_exports(tmp_path):
    baseline = read(ROOT/'tests/fixtures/translate-request-baseline.json')
    # T15–T20 version the other-reference tree; retain the immutable T14 fixture and full check.
    expected = {**baseline['snapshot'], 'other_reference_tree_sha256':
                '7efd51e58498311a5242194295eb4ae3733a76b5d142aadbba3e41ff3b0faa2b'}
    assert capture(tmp_path, appended=True) == expected


def test_stream_phase_contracts_reach_transport_after_unchanged_task_data(tmp_path):
    bundle, _ = load_manifest(EXAMPLE, translate)
    bundle['metadata']['batch_size'] = 2
    run = runner(tmp_path, bundle)
    invoke(run)
    calls = []
    class Client:
        def converse(self, **kwargs):
            calls.append(kwargs)
            return {'synthetic_transport_only': True}
    provider = Bedrock({'model': 'synthetic-no-service', 'max_output_tokens': 100})
    provider.client = Client()
    for role in translate.report_roles(tmp_path):
        request = read(tmp_path/'requests'/f'{role}.json')
        first, last = request['messages'][0]['content']
        data = payload(request)
        stream, phase = data['stream'], role.rsplit('_', 1)[1]
        contract = last['text']
        assert 'Final response contract:' not in first['text']
        assert 'Declared task data:\n' in first['text']
        assert contract.startswith('Final response contract:\n')
        assert 'Role: '+role+'. Stream: '+stream+'. Phase: '+phase+'.' in contract
        for phrase in ('one complete strict JSON object', 'first non-whitespace character must be {',
                       'last must be }', 'preamble', 'postscript', 'procedure narration', 'headings',
                       'Markdown fences', 'extra objects', 'comments', 'trailing commas', 'file receipts',
                       'Markdown and Unicode inside JSON strings', "role's existing instructions"):
            assert phrase in contract
        if phase == 'review':
            for phrase in ('unenveloped', 'verdicts', 'slot', 'pass', 'reason', 'batch_issues',
                           'string slots verbatim', 'numeric placeholders', 'Empty arrays', 'negative advisory'):
                assert phrase in contract
            assert 'Do not wrap the review in artifact' in contract
        else:
            for phrase in ('object-valued artifact', 'schema_version', '2', 'complete native items batch',
                           'slot and opaque source_hash exactly', 'unflagged', 'outside artifact'):
                assert phrase in contract
            if phase == 'final':
                for phrase in ('dispositions', 'Apply or decline', 'authoritative', 'no later quality'):
                    assert phrase in contract
        if stream in ('checkin', 'practice'):
            assert 'question_display and question_audio text' in contract
            for phrase in ('question_display', 'question_audio', 'options_display', 'options_audio',
                           'positions/count', 'true_false', 'empty', 'answer-free'):
                assert phrase in contract
            for forbidden in ('correct_answer_display', 'explanation_display', 'hint_display',
                              'success_display', 'reveal_display', 'question:{display,audio}'):
                assert forbidden not in contract
        elif stream == 'teaching':
            assert 'title_display and lines:[{display,audio}]' in contract
            assert 'one line per source line in source order' in contract
        elif stream == 'feedback':
            assert all(k in contract for k in translate.FIELDS['feedback'])
            assert 'only actually supplied fields' in contract
            assert 'Practice entries remain text only' in contract
        else:
            assert 'question:{display,audio}, answer:{display,audio}' in contract
        provider.invoke(request, role=role, notes_pages=None)
        assert calls[-1]['messages'] is request['messages']
    assert len(calls) > 25


@pytest.mark.parametrize('stream', translate.STREAMS)
@pytest.mark.parametrize('phase', translate.PHASES)
def test_native_envelopes_empty_negative_reviews_and_escaped_text(stream, phase):
    audit = '## SYNTHETIC\nनमूना **text** "quoted" C:\\example'
    value = ({'verdicts': [], 'batch_issues': []} if phase == 'review' else
             {'artifact': {'schema_version': 2, 'items': []}, 'note': audit})
    if phase == 'review':
        value['verdicts'] = [{'slot': 'practice:p000097', 'pass': False, 'reason': audit}]
        assert translate.parse(f'translate_{stream}_b097_{phase}', json.dumps(
            {'verdicts': [], 'batch_issues': []})) == {'verdicts': [], 'batch_issues': []}
    raw = json.dumps(value, ensure_ascii=False)
    for response in (raw, '```json\n'+raw+'\n```', '```\n'+raw+'\n```', '```json\n'+raw):
        text, _ = model_response_json(response)
        assert translate.parse(f'translate_{stream}_b097_{phase}', text) == value


@pytest.mark.parametrize('stream', translate.STREAMS)
def test_empty_review_still_reaches_complete_final_author(tmp_path, monkeypatch, stream):
    def empty(role, data, value):
        if role == f'translate_{stream}_b001_review':
            value.update(verdicts=[], batch_issues=[])
    intercept(monkeypatch, empty)
    run = runner(tmp_path)
    invoke(run)
    role = f'translate_{stream}_b001_final'
    data = payload(read(tmp_path/'requests'/f'{role}.json'))
    final = run.output(role)
    assert data['review'] == {'verdicts': [], 'batch_issues': []}
    assert final['dispositions'] == []
    assert [x['slot'] for x in final['artifact']['items']] == [x['slot'] for x in data['items']]
    assert final['artifact']['items'] != data['draft']['items']
    assert read(tmp_path/'artifacts'/f'{role}.json') == final['artifact']
    assert report(tmp_path, translate)['status'] == 'complete'


@pytest.mark.parametrize('phase', translate.PHASES)
@pytest.mark.parametrize('kind', ['narrated', 'malformed', 'wrong_envelope'])
def test_invalid_response_stays_raw_failed_and_unrepeated(tmp_path, monkeypatch, phase, kind):
    original = Fixture.invoke
    target = 'translate_practice_b001_'+phase
    invalid = []
    def altered(self, request, *, role, notes_pages):
        response = original(self, request, role=role, notes_pages=notes_pages)
        if role != target:
            return response
        raw = response['output']['message']['content'][0]['text']
        value = json.loads(raw)
        if kind == 'narrated':
            text = 'To fulfill the task, we need to revise...\n```json\n'+raw+'\n```'
        elif kind == 'malformed':
            text = raw[:-1]+',}'
        else:
            text = json.dumps(value['artifact'] if 'artifact' in value else {'artifact': value})
        invalid.append(text)
        response['output']['message']['content'][0]['text'] = text
        return response
    monkeypatch.setattr(Fixture, 'invoke', altered)
    run = runner(tmp_path)
    with pytest.raises(ValueError, match='required stage unavailable'):
        invoke(run)
    assert run.result(target)['status'] == 'failed'
    assert read(tmp_path/'responses'/f'{target}.json')['output']['message']['content'][0]['text'] == invalid[0]
    assert not any((tmp_path/'artifacts'/name).exists() for name in PACKS)
    assert report(tmp_path, translate)['status'] == 'partial_or_failed'
    ledger = read(run.ledger_path)
    assert [c['role'] for c in ledger['calls']] == list(translate.ROLES[:translate.ROLES.index(target)+1])
    with pytest.raises(ValueError, match='required stage unavailable'):
        invoke(Runner(tmp_path, translate, resume=True))
    assert read(run.ledger_path) == ledger and len(invalid) == 1
