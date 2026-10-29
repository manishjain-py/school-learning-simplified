"""Bounded T18 synthetic ABI verification using the unchanged local renderer."""
import builtins
from copy import deepcopy
import json
import os
from pathlib import Path
import socket
import sys

import pytest
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from reference import media


@pytest.fixture(autouse=True)
def no_services(monkeypatch):
    original_import = builtins.__import__
    original_connect = socket.socket.connect

    def no_sdk(name, *args, **kwargs):
        if name.split('.')[0] in ('boto3', 'botocore', 'openai', 'anthropic'):
            raise AssertionError('Real SDK forbidden')
        return original_import(name, *args, **kwargs)

    def loopback_only(sock, address):
        if sock.family not in (socket.AF_INET, socket.AF_INET6) or address[0] not in ('127.0.0.1', '::1'):
            raise AssertionError('External network forbidden')
        return original_connect(sock, address)

    monkeypatch.setattr(builtins, '__import__', no_sdk)
    monkeypatch.setattr(socket.socket, 'connect', loopback_only)
    for key in list(os.environ):
        if key.startswith(('AWS_', 'BEDROCK_', 'OPENAI_', 'ANTHROPIC_', 'LANGSMITH_', 'LANGCHAIN_')):
            monkeypatch.delenv(key)
    monkeypatch.setenv('LANGSMITH_TRACING', 'false')


SETUP = ('const mark = new PIXI.Graphics().rect(0, 0, 60, 40).fill(0x2255aa); '
         'app.stage.addChild(mark); globalThis.renderAt = t_ms => {mark.x = 20 + t_ms/10; mark.y = 30;};')


@pytest.mark.parametrize('code,expected', [
    (SETUP, None),
    ('async function setupSynthetic() {'+SETUP+'} await setupSynthetic();', None),
    ('async function setupSynthetic() {'+SETUP+' visual_explanation.duration_ms = 1000;}',
     'pixi_code must expose globalThis.renderAt(t_ms)'),
    (SETUP+' visual_explanation.duration_ms = 1000;', 'visual_explanation is not defined'),
], ids=('executable-body', 'explicit-helper-call', 'uninvoked-helper-rejected', 'metadata-is-not-injected'))
def test_actual_unchanged_viewer_body_execution_and_metadata(tmp_path, code, expected):
    identity = media.runtime_identity()
    assert identity['browser']['available'], 'Install this checkout\'s locked npm and matching Chromium explicitly'
    assert identity['browser']['pixi'] == '8.22.0'
    assert identity['browser']['playwright'] == '1.64.1'
    artifact = {'output_type': 'animated_visual', 'title': 'SYNTHETIC ABI MARK',
                'pixi_code': code, 'duration_ms': 1000}
    original = deepcopy(artifact)
    directory = tmp_path/'render'
    result = media.render_visual(artifact, directory, allowed_roots=[tmp_path])
    assert artifact == original
    assert json.loads((directory/'author.json').read_text()) == original
    assert json.loads((directory/'scene.json').read_text()) == original
    assert result['config']['duration_ms'] == 1000
    if expected:
        assert result['status'] == 'failed'
        assert result['reviewer_frames'] == []
        assert expected in json.dumps(result['diagnostics'])
    else:
        assert result['status'] == 'complete', result['diagnostics']
        frames = [f for f in result['reviewer_frames'] if f['view'] == 'wide']
        assert [f['t_ms'] for f in frames] == [0, 500, 1000]
        assert len({f['sha256'] for f in frames}) == 3
        for frame in frames:
            image = Image.open(directory/frame['file']).convert('RGB')
            assert image.getpixel((30+int(frame['t_ms']/10), 40)) == (34, 85, 170)
