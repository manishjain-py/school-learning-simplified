#!/usr/bin/env python3
"""Connected local reference pipeline; default examples spend zero provider money."""
import argparse
import json
import os
from pathlib import Path

os.environ['LANGSMITH_TRACING'] = 'false'
os.environ['LANGCHAIN_TRACING_V2'] = 'false'
from reference.inputs import read
from reference.pipeline import STAGES, budget_plan, load_pipeline, pipeline_report, resume, start
from reference.runtime import exclusive


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    verify = commands.add_parser('verify', help='Read only explicitly declared files; no generation')
    verify.add_argument('manifest', type=Path)
    run = commands.add_parser('run', help='Freeze all inputs, stage bindings and budgets, then run')
    run.add_argument('manifest', type=Path)
    run.add_argument('--provider', choices=('fixture', 'bedrock'), required=True)
    run.add_argument('--config', type=Path)
    run.add_argument('--allow-paid', action='store_true')
    run.add_argument('--workspace', type=Path, required=True)
    run.add_argument('--stop-after', choices=STAGES, help='Deliberate partial checkpoint; never reports full completion')
    retry = commands.add_parser('resume', help='Reuse SAME workspaces/ledgers; no completed call repeats')
    retry.add_argument('--workspace', type=Path, required=True)
    retry.add_argument('--allow-paid', action='store_true')
    retry.add_argument('--stop-after', choices=STAGES)
    view = commands.add_parser('report', help='Offline evidence and aggregate usage/reservations')
    view.add_argument('--workspace', type=Path, required=True)
    args = parser.parse_args(argv)
    if args.command == 'verify':
        value = load_pipeline(args.manifest)
        print(json.dumps({'stages': STAGES, 'explicit_files': list(value['files']), 'provider_calls': 0}))
        return 0
    if args.command == 'run':
        result = start(args.manifest, args.workspace, args.provider, read(args.config) if args.config else None,
                       allow_paid=args.allow_paid, stop_after=args.stop_after)
    elif args.command == 'resume':
        result = resume(args.workspace, allow_paid=args.allow_paid, stop_after=args.stop_after)
    else:
        with exclusive(args.workspace) as workspace:
            result = pipeline_report(workspace)
    print(json.dumps({k: v for k, v in result.items() if k not in ('lineage', 'budget', 'stages')}, indent=2))
    print('Report:', args.workspace/'pipeline-report.html')
    return 0 if result['status'] == 'complete' else 1


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (ValueError, RuntimeError, OSError, KeyError) as error:
        raise SystemExit('Reference pipeline: '+str(error))
