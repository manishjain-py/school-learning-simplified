"""Fixed adapter identity tests; synthetic JSON/stub clips are not media proof."""
from pathlib import Path
import socket
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import run_audio
import run_factory as cli
from reference.factories import avatar, boards, explain, feedback, guideline, practice, revise, toc, translate, visuals
from reference.inputs import ROOT, load_manifest, read, save, sha
from reference.pipeline_adapters import STAGES, build


@pytest.fixture(autouse=True)
def offline(monkeypatch):
    def denied(*args, **kwargs):
        raise AssertionError('Adapter tests permit no network')
    monkeypatch.setattr(socket.socket, 'connect', denied)
    monkeypatch.setattr(socket.socket, 'sendto', denied)
    monkeypatch.setattr(socket, 'create_connection', denied)


@pytest.fixture
def predecessor_outputs(tmp_path):
    """Native-shaped saved artifacts with distinct upstream byte identities."""
    manifest = ROOT/'examples/pipeline/manifest.json'
    inputs = read(manifest)
    for field in ('toc_pages', 'chapter_pages'):
        for page in inputs[field]:
            page['path'] = str((manifest.parent/page['path']).resolve())
    for spec in inputs['files'].values():
        spec['path'] = str((manifest.parent/spec['path']).resolve())
    workspace = tmp_path/'pipeline'
    save(workspace/'stages/toc/artifacts/chapter-map.json', {'chapters': [
        {'chapter_number': 1, 'chapter_title': 'EXACT UPSTREAM TOC TITLE', 'start_page': 7, 'end_page': 10},
        {'chapter_number': 2, 'chapter_title': 'UNSELECTED', 'start_page': 11, 'end_page': 14}],
        'source_note': 'Unmodified synthetic upstream author observation'})
    sources = {
        'guideline/artifacts/guideline.json': ROOT/'examples/explain/guideline.json',
        'explain/artifacts/deck.json': ROOT/'examples/translate/deck.json',
        'explain/artifacts/check-ins.json': ROOT/'examples/translate/checkins.json',
        'practice/artifacts/questions.json': ROOT/'examples/translate/practice.json',
        'revise/artifacts/revise_deck.json': ROOT/'examples/translate/revise.json',
        'revise/views/explain-index-map.json': ROOT/'examples/translate/r5-slim-index-map.json',
    }
    for destination, source in sources.items():
        value = read(source)
        if isinstance(value, dict):
            value['adapter_test_upstream_marker'] = destination
        save(workspace/'stages'/destination, value)
    additions = read(workspace/'stages/practice/artifacts/questions.json')
    save(workspace/'stages/practice/artifacts/bank-snapshot.json', {
        'questions': [*read(inputs['files']['bank']['path'])['questions'], *additions['questions']]})
    return inputs, workspace


def native_load(manifest, workspace, module):
    path = workspace/'adapter-test-manifest.json'
    save(path, manifest)
    return load_manifest(path, module)[0]


def translation(inputs, workspace):
    manifest = build('translate', inputs, workspace)
    path = workspace/'translate-manifest.json'
    save(path, manifest)
    assert cli.main(['run', str(path), '--provider', 'fixture', '--workspace',
                     str(workspace/'stages/translate')]) == 0
    return manifest


def stub_hindi_audio(inputs, workspace):
    """Only file-binding fixtures; no claim these stub bytes contain speech."""
    manifest = build('audio_hi_deck', inputs, workspace)
    bundle = native_load(manifest, workspace, run_audio)
    scripts, origins = run_audio.blocks(bundle)
    root = workspace/'stages/audio_hi_deck/audio'
    root.mkdir(parents=True)
    clips, blocks = [], []
    for index, block in enumerate(scripts):
        path = root/f'clip-{index:03d}.wav'
        path.write_bytes(b'EXPLICIT SYNTHETIC BINDING STUB '+str(index).encode())
        digest = sha(path.read_bytes())
        clips.append({'file': path.name, 'sha256': digest, 'index': index,
                      'script': block['script'], 'script_sha256': sha(block['script'].encode())})
        blocks.append({'index': index, 'script': block['script'], 'clip_sha256': digest})
    save(root/'narration.json', {'schema': 'local-narration/v1', 'clips': clips, 'blocks': blocks})
    save(root.parent/'origins.json', {'kind': 'translate_deck',
         'input_sha256': bundle['file_identity']['pack']['sha256'], 'blocks': origins})
    return manifest


def test_toc_and_guideline_use_exact_selection_and_only_declared_pages(predecessor_outputs):
    inputs, workspace = predecessor_outputs
    inputs['chapter_pages'] = [inputs['chapter_pages'][2], {
        'printed_page': 11, 'path': inputs['chapter_pages'][0]['path']}]
    toc_manifest = build('toc', inputs, workspace)
    assert toc_manifest['pages'] == inputs['toc_pages']
    native_load(toc_manifest, workspace, toc)
    manifest = build('guideline', inputs, workspace)
    bundle = native_load(manifest, workspace, guideline)
    assert manifest['metadata']['chapter_title'] == 'EXACT UPSTREAM TOC TITLE'
    assert [p['printed_page'] for p in manifest['pages']] == [9]
    selection = read(workspace/'views/selected-chapter.json')
    assert selection['source_toc']['sha256'] == sha(
        (workspace/'stages/toc/artifacts/chapter-map.json').read_bytes())
    assert selection['selected_pages'] == [{'printed_page': 9,
        'path': inputs['chapter_pages'][0]['path'],
        'sha256': sha(Path(inputs['chapter_pages'][0]['path']).read_bytes())}]
    assert bundle['declared']['context']['selected_chapter']['chapter_title'] == 'EXACT UPSTREAM TOC TITLE'
    text = Path(manifest['files']['context']['path']).read_text()
    assert str(workspace) not in text and inputs['chapter_pages'][0]['path'] not in text
    assert 'selection_policy' not in text
    assert build('guideline', inputs, workspace) == manifest
    save(workspace/'stages/toc/artifacts/chapter-map.json', {'chapters': [
        {'chapter_number': 1, 'chapter_title': 'CHANGED', 'start_page': 7, 'end_page': 10}]})
    with pytest.raises(ValueError, match='Frozen adapter view differs'):
        build('guideline', inputs, workspace)


def test_missing_ambiguous_or_unusable_toc_has_no_fallback(predecessor_outputs):
    inputs, workspace = predecessor_outputs
    source = workspace/'stages/toc/artifacts/chapter-map.json'
    inputs['chapter_number'] = 42
    with pytest.raises(ValueError, match='one selected chapter'):
        build('guideline', inputs, workspace)
    inputs['chapter_number'] = 1
    save(source, {'chapters': [{'chapter_number': 1, 'chapter_title': 'a', 'start_page': 99, 'end_page': 100}]})
    with pytest.raises(ValueError, match='No explicitly supplied'):
        build('guideline', inputs, workspace)
    source.unlink()
    with pytest.raises(ValueError, match='unavailable'):
        build('guideline', inputs, workspace)


def test_native_manifests_consume_predecessor_bytes_and_preserve_authors(predecessor_outputs):
    inputs, workspace = predecessor_outputs
    before = {str(p): p.read_bytes() for p in (workspace/'stages').rglob('*.json')}
    modules = {'explain': explain, 'practice': practice, 'revise': revise,
               'visuals': visuals, 'boards_en': boards, 'avatar_en': avatar, 'feedback': feedback}
    for stage, module in modules.items():
        manifest = build(stage, inputs, workspace)
        bundle = native_load(manifest, workspace, module)
        assert all(Path(f['path']).is_absolute() for f in manifest['files'].values())
        if 'deck' in bundle['declared']:
            assert bundle['file_identity']['deck']['sha256'] == sha(
                (workspace/'stages/explain/artifacts/deck.json').read_bytes())
        if 'guideline' in bundle['declared']:
            assert bundle['declared']['guideline']['adapter_test_upstream_marker'] == 'guideline/artifacts/guideline.json'
    assert all(Path(path).read_bytes() == data for path, data in before.items())
    info = read(workspace/'views/feedback-adapter-info.json')
    assert info['files']['deck']['path'].endswith('/stages/explain/artifacts/deck.json')
    assert 'R3 original' in info['namespaces']['explain']
    inputs['practice']['mode'] = 'growth'
    assert build('practice', inputs, workspace)['metadata']['mode'] == 'seed-growth'


@pytest.mark.parametrize('scope,filename', [('additions', 'questions.json'), ('bank_snapshot', 'bank-snapshot.json')])
def test_practice_scope_is_explicit_through_translation_and_audio(predecessor_outputs, scope, filename):
    inputs, workspace = predecessor_outputs
    inputs['practice']['scope'] = scope
    translated = build('translate', inputs, workspace)
    assert translated['files']['practice']['path'].endswith('/'+filename)
    native_load(translated, workspace, translate)
    audio = build('audio_en_practice', inputs, workspace)
    assert audio['files']['pack'] == translated['files']['practice']
    native_load(audio, workspace, run_audio)
    info = read(workspace/'views/translate-adapter-info.json')
    assert info['practice_scope'] == scope
    assert info['r5_slim_mapping']['path'].endswith('/revise/views/explain-index-map.json')


def test_hindi_media_uses_actual_native_pack_map_identity_and_clips(predecessor_outputs):
    inputs, workspace = predecessor_outputs
    translation(inputs, workspace)
    translated_bytes = (workspace/'stages/translate/artifacts/deck_hi.json').read_bytes()
    for stage in ('boards_hi',):
        manifest = build(stage, inputs, workspace)
        bundle = native_load(manifest, workspace, boards)
        assert bundle['file_identity']['translated_deck']['sha256'] == sha(translated_bytes)
        assert manifest['files']['translated_identity']['path'].endswith('/views/reference-identity.json')
    audio = stub_hindi_audio(inputs, workspace)
    pack = read(audio['files']['pack']['path'])
    selected = read(audio['files']['selection']['path'])['indices']
    targets = {r['card_idx'] for r in read(inputs['files']['avatar_targets']['path'])['targets']}
    expected = {i for i, item in enumerate(pack['items'], 1)
                if item.get('source', {}).get('original_card_idx') in targets}
    assert set(selected) == expected | {4}
    assert any(pack['items'][i-1]['source']['card_type'] == 'check_in' for i in selected)
    manifest = build('avatar_hi', inputs, workspace)
    bundle = native_load(manifest, workspace, avatar)
    assert bundle['declared']['speech']['language'] == 'hi'
    assert bundle['declared']['speech']['leading_gap_ms'] == 600
    bindings = read(workspace/'views/avatar-hi-clip-bindings.json')['bindings']
    assert {b['original_card_idx'] for b in bindings} == targets
    for binding in bindings:
        assert bundle['file_identity'][binding['slot']]['sha256'] == binding['source_clip']['sha256']
    assert (workspace/'stages/translate/artifacts/deck_hi.json').read_bytes() == translated_bytes
    Path(manifest['files'][bindings[0]['slot']]['path']).write_bytes(b'changed')
    with pytest.raises(ValueError, match='source clip missing, escaped or changed'):
        build('avatar_hi', inputs, workspace)


def test_every_audio_kind_uses_its_actual_native_pack(predecessor_outputs):
    inputs, workspace = predecessor_outputs
    translation(inputs, workspace)
    kinds = {'audio_en_explain': 'explain', 'audio_en_practice': 'practice', 'audio_en_revise': 'revise',
             'audio_hi_deck': 'translate_deck', 'audio_hi_practice': 'translate_practice', 'audio_hi_revise': 'translate_revise'}
    for stage, kind in kinds.items():
        manifest = build(stage, inputs, workspace)
        assert manifest['metadata'] == {'kind': kind}
        bundle = native_load(manifest, workspace, run_audio)
        assert run_audio.blocks(bundle)[0]
    assert set(STAGES) == {'toc', 'guideline', 'explain', 'practice', 'revise', 'translate', 'visuals',
        'boards_en', 'boards_hi', *kinds, 'avatar_en', 'avatar_hi', 'feedback'}


def test_missing_predecessor_relative_input_and_implicit_scope_are_rejected(predecessor_outputs):
    inputs, workspace = predecessor_outputs
    inputs['files']['bank']['path'] = 'bank.json'
    with pytest.raises(ValueError, match='absolute frozen paths'):
        build('practice', inputs, workspace)
    inputs['practice']['scope'] = 'implicit'
    with pytest.raises(ValueError, match='explicitly choose'):
        build('translate', inputs, workspace)
    inputs['practice']['scope'] = 'additions'
    (workspace/'stages/explain/artifacts/deck.json').unlink()
    with pytest.raises(ValueError, match='unavailable'):
        build('feedback', inputs, workspace)
    with pytest.raises(ValueError, match='Unknown fixed'):
        build('discover-more-content', inputs, workspace)
