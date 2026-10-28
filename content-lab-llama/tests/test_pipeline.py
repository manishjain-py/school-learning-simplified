"""Connected graph edges and durable paid accounting; no real provider calls."""
from copy import deepcopy
import json
from pathlib import Path
import sys
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from reference import pipeline as p
from reference.inputs import ROOT, canonical, read, save, sha
from reference.providers import Bedrock
from reference.pipeline_fixture import PipelineFixture
from reference.runtime import Runner

EXAMPLE = ROOT/'examples/pipeline/manifest.json'
SETTINGS = {'provider': 'bedrock', 'image_limit': 3, 'model': 'meta.synthetic-not-live',
    'region': 'us-east-2', 'max_output_tokens': 100, 'input_token_bound': 1000000,
    'input_per_million': .1, 'output_per_million': .1}


def paid_config(cap=2):
    return {'settings': deepcopy(SETTINGS), 'stage_caps_usd': {s: cap for s in p.MODEL_STAGES},
            'total_cap_usd': cap*len(p.MODEL_STAGES)}


@pytest.fixture(autouse=True)
def tools(monkeypatch):
    monkeypatch.setattr(p.media, 'runtime_identity', lambda: {'synthetic_tool_identity': True})


def test_paid_config_defaults_and_all_caps_before_calls(tmp_path, monkeypatch):
    def forbidden(*args, **kwargs):
        raise AssertionError('Provider must not be initialized')
    monkeypatch.setattr(Bedrock, '__init__', forbidden)
    invalid = [None, {}, {'settings': SETTINGS}, paid_config(float('nan'))]
    missing = paid_config(); missing['stage_caps_usd'].pop('feedback'); invalid.append(missing)
    total = paid_config(); total['total_cap_usd'] = 1; invalid.append(total)
    for config in invalid:
        with pytest.raises(ValueError):
            p.start(EXAMPLE, tmp_path/'not-created', 'bedrock', config, allow_paid=True)
    assert not (tmp_path/'not-created').exists()
    with pytest.raises(ValueError, match='allow-paid'):
        p.start(EXAMPLE, tmp_path/'not-created', 'bedrock', paid_config())
    with pytest.raises(ValueError):
        p.budget_plan('fixture', paid_config())
    assert not (tmp_path/'not-created').exists()


def test_connected_native_predecessors_and_partial_resume(tmp_path, monkeypatch):
    def forbidden(*args, **kwargs):
        raise AssertionError('SDK/network/paid provider forbidden')
    monkeypatch.setattr(Bedrock, '__init__', forbidden)
    first = p.start(EXAMPLE, tmp_path/'pipeline', 'fixture', stop_after='translate')
    workspace = tmp_path/'pipeline'
    assert first['status'] == 'partial_or_failed'  # media/application still required
    before = p.file_hashes(workspace/'stages')
    count = first['model_requests']
    identity = read(workspace/'pipeline-identity.json')
    assert set(identity['stage_workspaces']) == set(p.STAGES)
    assert identity['budget']['total_cap_usd'] == 0
    guideline = read(workspace/'stages/guideline/artifacts/guideline.json')
    assert 'R10-INPUT-EDGE-SENTINEL' in json.dumps(guideline)
    explain = read(workspace/'stages/explain/inputs.json')
    assert explain['declared']['guideline'] == guideline
    assert 'R10-INPUT-EDGE-SENTINEL' in (workspace/'stages/explain/requests/explain_arc.json').read_text()
    deck = read(workspace/'stages/explain/artifacts/deck.json')
    for stage in ('practice', 'revise', 'translate'):
        assert read(workspace/f'stages/{stage}/inputs.json')['declared']['deck'] == deck
    translation = read(workspace/'stages/translate/inputs.json')
    assert translation['declared']['practice'] == read(workspace/'stages/practice/artifacts/questions.json')
    assert translation['declared']['revise'] == read(workspace/'stages/revise/artifacts/revise_deck.json')
    assert read(workspace/'stages/revise/artifacts/revise_deck.json') == read(
        workspace/'stages/revise/checkpoints/revise_final.json')['output']['artifact']
    assert len(read(workspace/'stages/revise/artifacts/revise_deck.json')['cards']) == 1
    assert len(read(workspace/'stages/practice/artifacts/questions.json')['questions']) < 4
    assert first['stages']['translate']['operational_stages']['translate_assembly']['status'] == 'complete'
    bindings = first['lineage']
    edge = next(e for e in bindings['explain']['edges'] if e.get('slot') == 'guideline')
    assert edge['source'] == 'stages/guideline/artifacts/guideline.json'
    assert edge['sha256'] == sha((workspace/edge['source']).read_bytes())
    second = p.resume(workspace, stop_after='translate')
    assert second['model_requests'] == count and second['paid_calls'] == 0
    assert before == p.file_hashes(workspace/'stages')
    # Source/final artifacts remain exact, and changed completed evidence refuses.
    (workspace/'stages/explain/artifacts/deck.json').write_text('{"cards":[]}')
    with pytest.raises(RuntimeError, match='evidence changed'):
        p.resume(workspace, stop_after='translate')
    assert p.pipeline_report(workspace)['status'] == 'partial_or_failed'


def test_changed_runtime_inputs_and_stage_bindings_refuse(tmp_path, monkeypatch):
    workspace = tmp_path/'run'
    p.start(EXAMPLE, workspace, 'fixture', stop_after='toc')
    identity = read(workspace/'pipeline-identity.json')
    changed = deepcopy(identity); changed['stage_workspaces']['feedback'] += '-replacement'
    save(workspace/'pipeline-identity.json', changed)
    with pytest.raises(RuntimeError, match='bindings changed'):
        p.resume(workspace, stop_after='toc')
    save(workspace/'pipeline-identity.json', identity)
    monkeypatch.setattr(p.media, 'runtime_identity', lambda: {'changed_tools': True})
    with pytest.raises(RuntimeError, match='runtime/tools changed'):
        p.resume(workspace, stop_after='toc')
    monkeypatch.setattr(p.media, 'runtime_identity', lambda: identity['execution'])
    path = workspace/'inputs/context.text'
    path.write_text('CHANGED INPUT')
    with pytest.raises(RuntimeError, match='input bytes changed'):
        p.resume(workspace, stop_after='toc')


def test_ambiguous_paid_reservation_retained_and_no_later_stage(tmp_path, monkeypatch):
    sent = []
    def init(self, config):
        self.config = config
    def invoke(self, request, *, role, notes_pages):
        sent.append(role)
        raise OSError('Synthetic ambiguous transport; no actual provider')
    monkeypatch.setattr(Bedrock, '__init__', init)
    monkeypatch.setattr(Bedrock, 'invoke', invoke)
    workspace = tmp_path/'paid-mock'
    with pytest.raises(ValueError):
        p.start(EXAMPLE, workspace, 'bedrock', paid_config(), allow_paid=True)
    first = p.pipeline_report(workspace)
    assert first['unreconciled_reserved_usd'] > 0 and first['actual_estimate_usd'] == 0
    assert not (workspace/'stages/guideline').exists()
    calls = len(sent)
    with pytest.raises(ValueError, match='allow-paid'):
        p.resume(workspace)
    with pytest.raises(ValueError):
        p.resume(workspace, allow_paid=True)
    second = p.pipeline_report(workspace)
    assert len(sent) == calls == 2  # independent draft and image-only reread both failed
    assert first['exposure_usd'] == second['exposure_usd']
    # A crash reservation with NO checkpoint also refuses rather than repeating.
    ledger = workspace/'stages/toc/ledger.json'
    value = read(ledger)
    value['calls'][0].pop('checkpoint_sha256')
    save(ledger, value)
    (workspace/'stages/toc/checkpoints/toc_draft.json').unlink()
    with pytest.raises(RuntimeError, match='manual reconciliation'):
        p.resume(workspace, allow_paid=True)
    assert len(sent) == calls


def test_disjoint_mock_caps_cumulative_across_stages_and_resume(tmp_path, monkeypatch):
    seen = []
    def init(self, config):
        self.config = config
    def invoke(self, request, *, role, notes_pages):
        seen.append(role)
        value = PipelineFixture().invoke(request, role=role, notes_pages=notes_pages)
        value['usage'] = {'inputTokens': 5, 'outputTokens': 7}
        return value
    monkeypatch.setattr(Bedrock, '__init__', init)
    monkeypatch.setattr(Bedrock, 'invoke', invoke)
    config = paid_config()
    workspace = tmp_path/'paid-mock'
    first = p.start(EXAMPLE, workspace, 'bedrock', config, allow_paid=True, stop_after='guideline')
    assert first['actual_estimate_usd'] > 0 and first['unreconciled_reserved_usd'] == 0
    assert first['budget']['total_cap_usd'] == sum(config['stage_caps_usd'].values())
    before = len(seen)
    second = p.resume(workspace, allow_paid=True, stop_after='guideline')
    assert len(seen) == before and first['exposure_usd'] == second['exposure_usd']
    for stage in ('toc', 'guideline'):
        assert read(workspace/f'stages/{stage}/ledger.json')['config']['cap_usd'] == 2
    # Used/uncertain exposure in an existing ledger cannot allocate a new workspace.
    stage = 'explain'
    def reserve_without_sending(self, key, role, request, parse, *, notes_pages=None):
        if not self.ledger['calls']:
            self.ledger['calls'].append({'key': 'existing-ambiguous', 'reserved_usd': 2, 'status': 'reserved'})
            save(self.ledger_path, self.ledger)
        return original(self, key, role, request, parse, notes_pages=notes_pages)
    original = Runner.invoke
    monkeypatch.setattr(Runner, 'invoke', reserve_without_sending)
    with pytest.raises(RuntimeError, match='Cumulative cap'):
        p.resume(workspace, allow_paid=True, stop_after=stage)
    final = p.pipeline_report(workspace)
    assert final['unreconciled_reserved_usd'] == 2
    assert final['exposure_usd'] == pytest.approx(first['exposure_usd']+2)
    with pytest.raises(RuntimeError, match='Cumulative cap'):
        p.resume(workspace, allow_paid=True, stop_after=stage)
    assert len(seen) == before


def test_empty_additions_audio_is_honest_noop(tmp_path):
    source = p.load_pipeline(EXAMPLE)
    source['practice']['target'] = 1  # existing bank already reaches target
    save(tmp_path/'manifest.json', source)
    workspace = tmp_path/'run'
    p.start(tmp_path/'manifest.json', workspace, 'fixture', stop_after='translate')
    identity = read(workspace/'pipeline-identity.json')
    inputs = p.restored_inputs(workspace, identity)
    for stage in ('audio_en_practice', 'audio_hi_practice'):
        result = p.stage_run(stage, inputs, workspace, identity)
        assert result['status'] == 'complete' and result['operation'] == 'noop' and result['blocks'] == 0
        assert not (workspace/f'stages/{stage}/audio').exists()
        assert p.stage_run(stage, inputs, workspace, identity) == result


def test_model_success_cannot_hide_required_assembly_failure(tmp_path, monkeypatch):
    from reference.factories import translate
    def fail(*args):
        raise ValueError('Synthetic assembly technical failure')
    monkeypatch.setattr(translate, 'assemble', fail)
    workspace = tmp_path/'failed-assembly'
    with pytest.raises(ValueError, match='assembly technical failure'):
        p.start(EXAMPLE, workspace, 'fixture', stop_after='translate')
    first = p.pipeline_report(workspace)
    assert first['status'] == 'partial_or_failed'
    assert set(first['stages']['translate']['roles'].values()) == {'ok'}
    assert first['stages']['translate']['operational_stages']['translate_assembly']['status'] != 'complete'
    assert not (workspace/'stages/visuals').exists()
    final = workspace/'stages/translate/checkpoints/translate_teaching_b001_final.json'
    original = final.read_bytes()
    with pytest.raises(ValueError, match='assembly technical failure'):
        p.resume(workspace, stop_after='translate')
    assert final.read_bytes() == original
    assert p.pipeline_report(workspace)['model_requests'] == first['model_requests']
