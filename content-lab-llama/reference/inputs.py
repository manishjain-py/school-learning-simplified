"""Explicit reader inputs and byte identities; no source checkout discovery."""
import hashlib
import importlib.metadata
import io
import json
import math
import os
from pathlib import Path
import sys
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
METADATA = {'grade', 'subject', 'board', 'country', 'title', 'chapter_number',
            'chapter_title', 'audience', 'language', 'other_chapter_titles'}


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()


def sha(data):
    return hashlib.sha256(data).hexdigest()


def strict_json(text):
    def reject(value):
        raise ValueError(f'Non-finite JSON constant: {value}')
    def finite_float(value):
        number = float(value)
        if not math.isfinite(number):
            reject(value)
        return number
    return json.loads(text, parse_constant=reject, parse_float=finite_float)


def read(path):
    return strict_json(Path(path).read_text())


def save(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + '.tmp')
    with tmp.open('w') as out:
        json.dump(value, out, ensure_ascii=False, indent=2, allow_nan=False)
        out.write('\n')
        out.flush()
        os.fsync(out.fileno())
    os.replace(tmp, path)


def runtime_identity():
    paths = [ROOT/'run_factory.py', ROOT/'requirements.lock']
    paths += sorted((ROOT/'reference').rglob('*.py'))
    paths += sorted((ROOT/'prompts').glob('*.md'))
    paths += sorted((ROOT/'schemas').glob('*.json'))
    packages = [line.split('==')[0] for line in (ROOT/'requirements.lock').read_text().splitlines() if '==' in line]
    return {'files': {str(p.relative_to(ROOT)): sha(p.read_bytes()) for p in paths},
            'python': sys.version, 'packages': {p: importlib.metadata.version(p)
            for p in packages}}


def load_manifest(path, factory):
    """factory declares metadata requirements and allowed JSON/text slots."""
    path = Path(path).resolve()
    value = read(path)
    if set(value) - {'factory', 'metadata', 'pages', 'files'}:
        raise ValueError('Unknown manifest keys')
    if value.get('factory') != factory.NAME:
        raise ValueError('Manifest factory mismatch')
    metadata = value.get('metadata', {})
    if not isinstance(metadata, dict) or set(metadata) - getattr(factory, 'METADATA', METADATA):
        raise ValueError('Metadata must use the documented allowlist')
    for key, item in metadata.items():
        if key == 'other_chapter_titles':
            if not isinstance(item, list) or not all(isinstance(x, str) for x in item):
                raise ValueError('other_chapter_titles must be strings')
        elif not isinstance(item, (str, int)) or isinstance(item, bool):
            raise ValueError('Metadata values must be strings or integers')
    if any(key not in metadata for key in factory.REQUIRED_METADATA):
        raise ValueError('Missing required factory metadata')
    pages, blobs = [], {}
    for index, page in enumerate(value.get('pages', [])):
        if set(page) != {'printed_page', 'path'} or type(page['printed_page']) not in (int, str):
            raise ValueError('Each page needs integer/string printed_page and local path')
        if isinstance(page['printed_page'], str) and not page['printed_page'].strip():
            raise ValueError('Printed page labels cannot be empty')
        source = (path.parent/page['path']).resolve()
        data = source.read_bytes()
        with Image.open(io.BytesIO(data)) as image:
            image.load()
            fmt = {'JPEG': 'jpeg', 'PNG': 'png'}[image.format]
            width, height = image.size
        if len(data) > 3_932_160 or max(width, height) > 8000:
            raise ValueError('Image exceeds supported byte/dimension bounds')
        name = f'page-{index}.{fmt}'
        pages.append({'printed_page': page['printed_page'], 'file': name,
                      'format': fmt, 'sha256': sha(data)})
        blobs[name] = data
    numbers = [p['printed_page'] for p in pages]
    if not numbers or len({canonical(n) for n in numbers}) != len(numbers):
        raise ValueError('Provide unique printed page labels in intended reading order')
    declared, file_identity = {}, {}
    for key, spec in value.get('files', {}).items():
        if key not in factory.FILE_INPUTS or set(spec) != {'path', 'type'}:
            raise ValueError('Undeclared file input or unsupported file fields')
        data = (path.parent/spec['path']).resolve().read_bytes()
        file_identity[key] = {'type': spec['type'], 'sha256': sha(data)}
        if spec['type'] == 'json':
            declared[key] = strict_json(data)
        elif spec['type'] == 'text':
            declared[key] = data.decode('utf-8')
        else:
            raise ValueError('File type must be json or text')
    bundle = {'factory': factory.NAME, 'metadata': metadata, 'pages': pages,
              'declared': declared, 'file_identity': file_identity}
    return bundle, blobs


def frozen_inputs(workspace):
    bundle = read(workspace/'inputs.json')
    blobs = {}
    for page in bundle['pages']:
        name = page['file']
        if Path(name).name != name:
            raise ValueError('Invalid frozen image name')
        data = (workspace/'inputs'/name).read_bytes()
        if sha(data) != page['sha256']:
            raise ValueError('Frozen image changed')
        blobs[name] = data
    return bundle, blobs
