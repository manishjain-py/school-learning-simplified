"""Reproduce synthetic native R3/R4/R5 artifacts through their actual graphs.

Writes only this explicit Translate example directory and a new private workspace.
No educational output is authored here; every role uses the declared fixture
provider. The saved inputs prove native artifact plumbing, not content quality.
"""
import argparse
import contextlib
import io
from pathlib import Path
import shutil
from offline import guard


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--workspace', type=Path, required=True)
    args = parser.parse_args()
    cli, empty = guard()
    try:
        from reference.inputs import ROOT, read, save, sha
        workspace = args.workspace.resolve()
        workspace.mkdir(parents=True, exist_ok=False)
        here = Path(__file__).resolve().parent
        lineage = {'synthetic': True, 'purpose': 'Native artifact plumbing only; no translation or curriculum quality proof', 'predecessors': {}}
        def run(factory, manifest):
            target = workspace/factory
            with contextlib.redirect_stdout(io.StringIO()):
                code = cli.main(['run', str(manifest), '--provider', 'fixture', '--workspace', str(target)])
            if code != 0:
                raise RuntimeError('Synthetic predecessor failed: '+factory)
            summary = read(target/'summary.json')
            lineage['predecessors'][factory] = {k: summary[k] for k in ('requests', 'synthetic', 'status', 'exposure_usd')}
            lineage['predecessors'][factory]['input_sha256'] = read(target/'identity.json')['input_sha256']
            return target
        explain = run('explain', ROOT/'examples/explain/manifest.json')
        for factory in ('practice', 'revise'):
            template = ROOT/'examples'/factory/'manifest.json'
            value = read(template)
            for slot, spec in value['files'].items():
                spec['path'] = str((template.parent/spec['path']).resolve())
            value['files']['deck']['path'] = str(explain/'artifacts/deck.json')
            manifest = workspace/(factory+'-manifest.json')
            save(manifest, value)
            result = run(factory, manifest)
            source = result/'artifacts'/('questions.json' if factory == 'practice' else 'revise_deck.json')
            shutil.copyfile(source, here/(factory+'.json'))
            if factory == 'revise':
                shutil.copyfile(result/'views/explain-index-map.json', here/'r5-slim-index-map.json')
        for original, destination in (('deck.json', 'deck.json'), ('check-ins.json', 'checkins.json')):
            shutil.copyfile(explain/'artifacts'/original, here/destination)
        lineage['artifact_sha256'] = {name: sha((here/name).read_bytes())
            for name in ('deck.json', 'checkins.json', 'practice.json', 'revise.json', 'r5-slim-index-map.json')}
        save(here/'lineage.json', lineage)
        print('Saved native synthetic R3/R4/R5 inputs; zero paid calls. See lineage.json.')
    finally:
        empty.cleanup()


if __name__ == '__main__':
    main()
