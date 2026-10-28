"""Optional engineering evidence inspection; no content-quality judgment or calls."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import wave

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from reference.inputs import read, sha
from reference import media
from reference.pipeline import STAGES, file_hashes, pipeline_report


def audit(workspace):
    workspace = Path(workspace).resolve()
    summary = pipeline_report(workspace)
    assert summary['status'] == 'complete', 'Required operational stage or evidence incomplete'
    for stage in STAGES:
        done = read(workspace/f'completed/{stage}.json')
        assert done['files'] == file_hashes(workspace/'stages'/stage)
    pairs = {'toc': {'toc_revision': 'chapter-map.json'},
        'guideline': {'revision': 'guideline.json', 'refresher': 'refresher-guideline.json'},
        'explain': {'explain_prose_final': 'explanation.md', 'explain_split_final': 'deck.json',
                    'explain_checkins_final': 'check-ins.json'},
        'practice': {'practice_final': 'questions.json'}, 'revise': {'revise_final': 'revise_deck.json'},
        'feedback': {'feedback_final': 'final-proposal.json'}}
    authors = []
    for stage in STAGES:
        directory = workspace/'stages'/stage
        for path in (directory/'artifacts').glob('*_final.json'):
            pairs.setdefault(stage, {})[path.stem] = path.name
        for role, filename in pairs.get(stage, {}).items():
            checkpoint = directory/'checkpoints'/f'{role}.json'
            if not checkpoint.exists():
                assert stage == 'practice' and read(directory/'artifacts/questions.json') == {'questions': []}
                continue  # explicitly reached-target no-op
            artifact = read(checkpoint)['output']['artifact']
            output = directory/'artifacts'/filename
            assert (output.read_bytes() == artifact.encode() if isinstance(artifact, str) else read(output) == artifact)
            authors.append({'stage': stage, 'role': role, 'artifact': filename, 'sha256': sha(output.read_bytes())})
    original = workspace/'stages/explain/artifacts/deck.json'
    feedback_input = read(workspace/'stages/feedback/inputs.json')
    assert feedback_input['file_identity']['deck']['sha256'] == sha(original.read_bytes())
    frozen = workspace/'stages/feedback/inputs'/feedback_input['file_identity']['deck']['file']
    assert frozen.read_bytes() == original.read_bytes()
    application = read(workspace/'stages/feedback/artifacts/application.json')
    assert application['original_snapshot_unchanged'] and application['status'] in ('applied', 'noop')
    videos = []
    for path in sorted((workspace/'stages').glob('*/media/*/playback.mp4')):
        info = media.probe_media(path, allowed_roots=[workspace])
        assert {'audio', 'video'} <= {s['codec_type'] for s in info['streams']}
        duration = float(info['format']['duration'])
        pixels = []
        for second in (0, duration*.25, duration*.5, duration*.75, max(0, duration-.2)):
            raw = subprocess.check_output(['ffmpeg', '-v', 'error', '-ss', str(second), '-i', str(path),
                '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'])
            assert raw, 'Decoded video sample is empty'
            pixels.append(hashlib.sha256(raw).hexdigest())
        assert len(set(pixels)) > 1, 'Encoded video frames did not change'
        pcm = subprocess.check_output(['ffmpeg', '-v', 'error', '-i', str(path), '-vn',
            '-f', 's16le', '-ac', '1', 'pipe:1'])
        assert any(pcm), 'Decoded audio is silent'
        videos.append({'file': str(path.relative_to(workspace)), 'sha256': sha(path.read_bytes()),
                       'duration_seconds': duration, 'decoded_frame_sha256': pixels,
                       'streams': sorted({s['codec_type'] for s in info['streams']}), 'nonzero_audio_pcm': True})
    assert videos, 'No actual video evidence'
    audio = []
    for stage in STAGES:
        if not stage.startswith('audio_'):
            continue
        directory = workspace/'stages'/stage
        if summary['stages'][stage].get('operation') == 'noop':
            audio.append({'stage': stage, 'operation': 'noop'})
            continue
        narration = read(directory/'audio/narration.json')
        path = directory/'audio'/narration['audio']['file']
        with wave.open(str(path)) as wav:
            assert wav.getnframes() > 0 and any(wav.readframes(wav.getnframes()))
        audio.append({'stage': stage, 'sha256': sha(path.read_bytes()), 'duration_ms': narration['audio']['duration_ms'],
                      'word_timing': narration['word_timing'], 'alignment_verified': narration['alignment_verified']})
    return {'status': 'engineering_evidence_verified', 'model_requests': summary['model_requests'],
        'paid_calls': summary['paid_calls'], 'exposure_usd': summary['exposure_usd'], 'author_exports': authors,
        'lineage': summary['lineage'], 'audio': audio, 'videos': videos, 'feedback_application': application,
        'limits': 'Exact authorship/lineage and nonzero PCM/changed frames; no semantic, listener, ASR or phoneme-quality claim'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--workspace', type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(audit(args.workspace), ensure_ascii=False, indent=2))
