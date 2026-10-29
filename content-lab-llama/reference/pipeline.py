"""Explicit local conductor over the existing factory APIs; no workflow DSL."""
from copy import deepcopy
import html
import math
from pathlib import Path

from . import media
from .inputs import canonical, load_manifest, read, runtime_identity, save, sha
from .providers import validate_config
from .runtime import Runner, exclusive, report
from .pipeline_fixture import PipelineFixture

STAGES = ('toc', 'guideline', 'explain', 'practice', 'revise', 'translate', 'visuals',
          'boards_en', 'boards_hi', 'audio_en_explain', 'audio_en_practice', 'audio_en_revise',
          'audio_hi_deck', 'audio_hi_practice', 'audio_hi_revise', 'avatar_en', 'avatar_hi', 'feedback')
MODEL_STAGES = tuple(s for s in STAGES if not s.startswith('audio_'))
REQUIRED_FILES = {'bank': 'json', 'feedback': 'json', 'visual_targets': 'json', 'board_targets': 'json',
    'avatar_targets': 'json', 'artwork': 'binary', 'avatar_config': 'json', 'speech_en': 'json',
    'speech_hi': 'json', 'audio_selection': 'json', 'audio_hi_selection': 'json'}
OPTIONAL_FILES = {'context': ('json', 'text'), 'research': ('json',)}


def load_pipeline(path):
    """Only explicitly named files are read. No book/source/private discovery."""
    path = Path(path).resolve()
    value = read(path)
    keys = {'version', 'metadata', 'chapter_number', 'toc_pages', 'chapter_pages', 'files', 'practice'}
    if not isinstance(value, dict) or set(value) != keys or value['version'] != 1:
        raise ValueError('Pipeline requires the documented version1 keys')
    if set(value['metadata']) != {'grade', 'subject'} or not all(
            type(v) in (str, int) for v in value['metadata'].values()):
        raise ValueError('Pipeline metadata requires grade and subject only')
    if type(value['chapter_number']) is not int or value['chapter_number'] < 1:
        raise ValueError('Pipeline chapter_number must be positive')
    practice = value['practice']
    if not isinstance(practice, dict) or set(practice) != {'mode', 'target', 'run_cap', 'scope'}:
        raise ValueError('Practice requires mode, target, run_cap and explicit scope')
    if practice['mode'] not in ('seed', 'growth', 'seed-growth') or practice['scope'] not in ('additions', 'bank_snapshot'):
        raise ValueError('Unsupported Practice mode/scope')
    if any(type(practice[k]) is not int or practice[k] < 1 for k in ('target', 'run_cap')):
        raise ValueError('Practice target and run_cap must be positive integers')
    files = value['files']
    if not isinstance(files, dict) or not REQUIRED_FILES.keys() <= files.keys() or files.keys()-REQUIRED_FILES.keys()-OPTIONAL_FILES.keys():
        raise ValueError('Pipeline requires its declared file slots')
    for key, spec in files.items():
        types = (REQUIRED_FILES[key],) if key in REQUIRED_FILES else OPTIONAL_FILES[key]
        if not isinstance(spec, dict) or set(spec) != {'path', 'type'} or spec['type'] not in types:
            raise ValueError('Pipeline input type mismatch: '+key)
        spec['path'] = str((path.parent/spec['path']).resolve())
        raw = Path(spec['path']).read_bytes()
        if spec['type'] == 'json':
            read(spec['path'])
        elif spec['type'] == 'text':
            raw.decode('utf-8')
    for slot in ('toc_pages', 'chapter_pages'):
        pages = value[slot]
        if not isinstance(pages, list) or not pages:
            raise ValueError('Explicit nonempty '+slot+' required')
        labels = []
        for page in pages:
            if not isinstance(page, dict) or set(page) != {'printed_page', 'path'}:
                raise ValueError('Page requires printed_page and path')
            label = page['printed_page']
            if type(label) not in (str, int) or (slot == 'chapter_pages' and type(label) is not int):
                raise ValueError('Chapter page labels must be integers; TOC labels integer or text')
            labels.append(canonical(label))
            page['path'] = str((path.parent/page['path']).resolve())
            Path(page['path']).read_bytes()
        if len(labels) != len(set(labels)):
            raise ValueError('Duplicate explicit page label')
    return value


def budget_plan(provider, config=None):
    """Disjoint durable stage caps. Their declared total is not a resettable pool."""
    if provider == 'fixture':
        if config is not None:
            raise ValueError('Fixture pipeline does not accept a live config')
        return {'provider': 'fixture', 'stage_configs': {s: {'provider': 'fixture', 'image_limit': 3}
                for s in MODEL_STAGES}, 'stage_caps_usd': {s: 0 for s in MODEL_STAGES}, 'total_cap_usd': 0}
    if provider != 'bedrock' or not isinstance(config, dict) or set(config) != {'settings', 'stage_caps_usd', 'total_cap_usd'}:
        raise ValueError('Bedrock pipeline requires explicit settings, stage_caps_usd and total_cap_usd')
    caps, total = config['stage_caps_usd'], config['total_cap_usd']
    if not isinstance(caps, dict) or set(caps) != set(MODEL_STAGES):
        raise ValueError('Every model stage needs its own disjoint cap before execution')
    if any(type(v) not in (int, float) or not math.isfinite(v) or v <= 0 for v in [total, *caps.values()]):
        raise ValueError('All paid stage caps and total must be finite and positive')
    if not math.isclose(math.fsum(caps.values()), total, rel_tol=1e-12, abs_tol=1e-12):
        raise ValueError('Explicit total must equal the sum of disjoint stage caps')
    settings = config['settings']
    if not isinstance(settings, dict) or 'cap_usd' in settings or settings.get('provider') != 'bedrock':
        raise ValueError('Settings must name bedrock and leave cap_usd to disjoint stage caps')
    configs = {s: validate_config({**settings, 'cap_usd': caps[s]}) for s in MODEL_STAGES}
    return {'provider': 'bedrock', 'stage_configs': configs, 'stage_caps_usd': caps, 'total_cap_usd': total}


def freeze_inputs(inputs, workspace):
    frozen = deepcopy(inputs)
    hashes = {}
    def copy(spec, name):
        raw = Path(spec['path']).read_bytes()
        relative = 'inputs/'+name
        path = workspace/relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(raw)
        spec['path'] = relative
        hashes[relative] = sha(raw)
    for key, spec in frozen['files'].items():
        copy(spec, key+'.'+spec['type'])
    for slot in ('toc_pages', 'chapter_pages'):
        for i, page in enumerate(frozen[slot]):
            copy(page, slot+f'-{i}.image')
    save(workspace/'pipeline-inputs.json', frozen)
    save(workspace/'input-hashes.json', hashes)
    return frozen


def restored_inputs(workspace, identity):
    frozen, hashes = read(workspace/'pipeline-inputs.json'), read(workspace/'input-hashes.json')
    if sha(canonical({'inputs': frozen, 'hashes': hashes})) != identity['input_sha256']:
        raise RuntimeError('Frozen pipeline input identity changed')
    result = deepcopy(frozen)
    for spec in [*result['files'].values(), *result['toc_pages'], *result['chapter_pages']]:
        path = workspace/spec['path']
        if path.is_symlink() or not path.resolve().is_relative_to(workspace) or sha(path.read_bytes()) != hashes[spec['path']]:
            raise RuntimeError('Frozen pipeline input bytes changed')
        spec['path'] = str(path)
    return result


def validate_identity(workspace, identity):
    expected = {s: str(workspace/'stages'/s) for s in STAGES}
    if identity['stage_workspaces'] != expected:
        raise RuntimeError('Frozen stage workspace bindings changed; refusing relocation/replacement')
    if identity['runtime'] != runtime_identity() or identity['execution'] != media.runtime_identity():
        raise RuntimeError('Frozen pipeline runtime/tools changed; restore original identity')
    if budget_plan(identity['budget']['provider'], identity.get('paid_config')) != identity['budget']:
        raise RuntimeError('Frozen budget plan changed')
    return restored_inputs(workspace, identity)


def file_hashes(directory):
    """Stage evidence is immutable after successful completion; reports are views."""
    return {str(p.relative_to(directory)): sha(p.read_bytes()) for p in sorted(directory.rglob('*'))
            if p.is_file() and p.name not in ('operator.lock', 'summary.json', 'report.html')}


def evidence_binding(stage, manifest, workspace):
    edges = []
    for slot, spec in manifest.get('files', {}).items():
        path = Path(spec['path']).resolve()
        if not path.is_relative_to(workspace):
            raise RuntimeError('Stage inputs must originate from frozen pipeline inputs or predecessors')
        edges.append({'slot': slot, 'source': str(path.relative_to(workspace)), 'sha256': sha(path.read_bytes()),
                      'type': spec['type']})
    for page in manifest.get('pages', []):
        path = Path(page['path']).resolve()
        if not path.is_relative_to(workspace):
            raise RuntimeError('Stage page escapes explicitly frozen inputs')
        edges.append({'printed_page': page['printed_page'], 'source': str(path.relative_to(workspace)),
                      'sha256': sha(path.read_bytes()), 'type': 'image'})
    value = {'stage': stage, 'factory': manifest['factory'], 'metadata': manifest['metadata'], 'edges': edges}
    path = workspace/'bindings'/f'{stage}.json'
    if path.exists() and read(path) != value:
        raise RuntimeError('Frozen predecessor edge changed for '+stage)
    save(path, value)
    return value


def stage_run(stage, inputs, workspace, identity):
    # Imports stay here to keep input/budget validation independent of graph work.
    import run_factory
    from .pipeline_adapters import build
    from .pipeline_audio import ensure_audio
    manifest = build(stage, inputs, workspace)
    evidence_binding(stage, manifest, workspace)
    manifest_path = workspace/'manifests'/f'{stage}.json'
    if manifest_path.exists() and read(manifest_path) != manifest:
        raise RuntimeError('Frozen stage manifest changed')
    save(manifest_path, manifest)
    target = Path(identity['stage_workspaces'][stage])
    done_path = workspace/'completed'/f'{stage}.json'
    if done_path.exists():
        done = read(done_path)
        if done['files'] != file_hashes(target):
            raise RuntimeError('Frozen completed stage evidence changed: '+stage)
        if stage.startswith('audio_') and done['summary'].get('operation') != 'noop':
            ensure_audio(manifest_path, target)
        return done['summary']
    if stage.startswith('audio_'):
        pack = read(manifest['files']['pack']['path'])
        empty_additions = (inputs['practice']['scope'] == 'additions' and
            (stage == 'audio_en_practice' and pack.get('questions') == [] or
             stage == 'audio_hi_practice' and pack.get('items') == []))
        if empty_additions:
            # A native empty additions pack is a valid no-op, not fake audio.
            summary = {'status': 'complete', 'operation': 'noop', 'paid_calls': 0, 'blocks': 0,
                'reason': 'Actual Practice additions are empty; no speech or replacement questions',
                'pack_sha256': sha(Path(manifest['files']['pack']['path']).read_bytes())}
            with exclusive(target):
                path = target/'audio-noop.json'
                if path.exists() and read(path) != summary:
                    raise RuntimeError('Frozen audio no-op changed')
                save(path, summary)
                save(target/'summary.json', summary)
        else:
            summary = ensure_audio(manifest_path, target)
            summary.pop('reused', None)
    else:
        module = run_factory.factory(manifest['factory'])
        bundle, blobs = load_manifest(manifest_path, module)
        with exclusive(target):
            config = identity['budget']['stage_configs'][stage]
            if (target/'identity.json').exists():
                previous = read(target/'identity.json')
                if previous['input_sha256'] != sha(canonical(bundle)) or previous['config'] != config:
                    raise RuntimeError('Stage input/config binding changed')
                runner = Runner(target, module, resume=True)
            else:
                runner = Runner(target, module, bundle=bundle, blobs=blobs, config=config)
            if config['provider'] == 'fixture':
                runner.provider = PipelineFixture()
            try:
                module.graph(runner).invoke({'last_role': 'start'})
            finally:
                summary = report(target, module)
    if summary['status'] != 'complete':
        raise RuntimeError(stage+': required graph/operational stage incomplete; artifacts retained')
    save(done_path, {'summary': summary, 'files': file_hashes(target)})
    return summary


def pipeline_report(workspace):
    """Offline report with honest aggregate known and unreconciled exposure."""
    workspace = Path(workspace).resolve()
    identity = read(workspace/'pipeline-identity.json')
    if identity['stage_workspaces'] != {s: str(workspace/'stages'/s) for s in STAGES}:
        raise RuntimeError('Frozen stage workspace bindings changed')
    summaries, known, unknown, calls = {}, 0, 0, 0
    integrity = []
    try:
        restored_inputs(workspace, identity)
    except (ValueError, RuntimeError, OSError, KeyError):
        integrity.append('pipeline_inputs')
    for stage in STAGES:
        directory = Path(identity['stage_workspaces'][stage])
        path = directory/'summary.json'
        row = read(path) if path.exists() else {'status': 'unavailable'}
        ledger = directory/('synthetic-ledger.json' if identity['budget']['provider'] == 'fixture' else 'ledger.json')
        if ledger.exists():
            entries = read(ledger)['calls']
            calls += len(entries)
            known += sum(c.get('actual_usd', 0) for c in entries)
            unknown += sum(c['reserved_usd'] for c in entries if 'actual_usd' not in c)
        done = workspace/'completed'/f'{stage}.json'
        if done.exists():
            record = read(done)
            row = record['summary']
            try:
                valid = record['files'] == file_hashes(directory)
            except OSError:
                valid = False
            if not valid:
                row = {**row, 'status': 'evidence_changed'}
                integrity.append(stage)
        else:
            row = {**row, 'status': 'partial_or_failed' if path.exists() else 'unavailable'}
        summaries[stage] = row
    lineage = {p.stem: read(p) for p in sorted((workspace/'bindings').glob('*.json'))}
    for stage, binding in lineage.items():
        for edge in binding['edges']:
            path = (workspace/edge['source']).resolve()
            if not path.is_relative_to(workspace) or not path.is_file() or sha(path.read_bytes()) != edge['sha256']:
                integrity.append(stage+':edge_changed')
    result = {'status': 'complete' if not integrity and all(r['status'] == 'complete' for r in summaries.values()) else 'partial_or_failed',
        'synthetic_model_responses': identity['budget']['provider'] == 'fixture',
        'model_requests': calls, 'paid_calls': 0 if identity['budget']['provider'] == 'fixture' else calls,
        'actual_estimate_usd': known, 'unreconciled_reserved_usd': unknown, 'exposure_usd': known+unknown,
        'budget': identity['budget'], 'stages': summaries, 'changed_evidence': integrity,
        'lineage': lineage,
        'limits': ['Synthetic responses are engineering sentinels, never Llama/curriculum quality evidence.',
            'This report records its own workspace/provider evidence; historical G1 ledger and allowance remain separate.',
            'Actual local speech/rendering; measured durations, estimated word timing; no ASR or phoneme claim.',
            'Final author artifacts retained; technical assembly/render/apply failure cannot claim complete.',
            'Fixed disjoint stage caps; their sum is the declared total, not a shared refillable allowance.',
            'Local copies only; no production import/publication or event submission.']}
    save(workspace/'pipeline-summary.json', result)
    esc = lambda obj: html.escape(__import__('json').dumps(obj, ensure_ascii=False, indent=2))
    (workspace/'pipeline-report.html').write_text('<!doctype html><html lang="en"><meta charset="utf-8">'
        '<title>Connected local reference pipeline</title><style>body{font:16px system-ui;max-width:1100px;margin:40px auto;padding:0 20px}'
        'pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f4f5f6;padding:16px}a{color:#175b60}</style>'
        '<h1>Connected local reference pipeline</h1><p>Built with Llama. Synthetic graph evidence and actual local media are distinct.</p>'
        + ''.join('<p>'+html.escape(line)+'</p>' for line in result['limits'])
        + '<h2>Stages</h2>' + ''.join('<p><a href="stages/'+s+'/report.html">'+s+'</a>: '+html.escape(r['status'])+
            (' (operational); role execution: '+html.escape(r['role_execution_status']) if 'completion_contract' in r else '')+'</p>'
            for s, r in summaries.items() if not s.startswith('audio_'))
        + '<h2>Summary, budgets and hashed predecessor edges</h2><pre>'+esc(result)+'</pre></html>')
    return result


def execute(workspace, identity, inputs, stop_after=None):
    if stop_after is not None and stop_after not in STAGES:
        raise ValueError('Unknown stop-after stage')
    try:
        for stage in STAGES:
            validate_identity(workspace, identity)
            stage_run(stage, inputs, workspace, identity)
            if stage == stop_after:
                break
    finally:
        result = pipeline_report(workspace)
    return result


def start(manifest, workspace, provider, config=None, *, allow_paid=False, stop_after=None):
    if provider == 'bedrock' and not allow_paid:
        raise ValueError('Reader-paid pipeline requires explicit --allow-paid')
    if provider == 'fixture' and allow_paid:
        raise ValueError('Fixture mode does not accept paid permission')
    plan = budget_plan(provider, config)
    inputs = load_pipeline(manifest)
    with exclusive(workspace) as workspace:
        if any(p.name != 'operator.lock' for p in workspace.iterdir()):
            raise RuntimeError('Pipeline workspace occupied; use explicit resume')
        frozen = freeze_inputs(inputs, workspace)
        identity = {'version': 1, 'runtime': runtime_identity(), 'execution': media.runtime_identity(),
            'input_sha256': sha(canonical({'inputs': frozen, 'hashes': read(workspace/'input-hashes.json')})),
            'budget': plan, 'paid_config': config,
            'stage_workspaces': {s: str(workspace/'stages'/s) for s in STAGES}}
        # All bindings/caps are durable BEFORE the first graph/provider call.
        save(workspace/'pipeline-identity.json', identity)
        print('Frozen budget plan:', __import__('json').dumps(plan))
        return execute(workspace, identity, restored_inputs(workspace, identity), stop_after)


def resume(workspace, *, allow_paid=False, stop_after=None):
    with exclusive(workspace) as workspace:
        identity = read(workspace/'pipeline-identity.json')
        if identity['budget']['provider'] == 'bedrock' and not allow_paid:
            raise ValueError('Reader-paid resume requires explicit --allow-paid')
        inputs = validate_identity(workspace, identity)
        return execute(workspace, identity, inputs, stop_after)
