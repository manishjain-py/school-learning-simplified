#!/usr/bin/env python3
"""Portable reference CLI. Help/list/verify never create a provider client."""
import argparse
import json
import os
from pathlib import Path

# Disable environment-driven external tracing before importing LangGraph.
os.environ['LANGSMITH_TRACING'] = 'false'
os.environ['LANGCHAIN_TRACING_V2'] = 'false'
from reference.factories import avatar, boards, explain, feedback, guideline, practice, revise, toc, translate, visuals
from reference.inputs import load_manifest, read
from reference.providers import validate_config
from reference.runtime import Runner, exclusive, report

FACTORIES = {module.NAME: module for module in (guideline, toc, explain, practice, revise, translate, visuals, boards, avatar, feedback)}


def factory(name):
    if name not in FACTORIES:
        raise ValueError('Unsupported factory; use list')
    return FACTORIES[name]


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    commands.add_parser('list', help='List implemented factories without paid requests')
    verify = commands.add_parser('verify', help='Validate declared input files without running')
    verify.add_argument('manifest', type=Path)
    run = commands.add_parser('run', help='Start one new workspace; provider choice is required')
    run.add_argument('manifest', type=Path)
    run.add_argument('--workspace', type=Path, required=True)
    run.add_argument('--provider', choices=('fixture', 'bedrock'), required=True)
    run.add_argument('--config', type=Path, help='Explicit Bedrock config JSON')
    run.add_argument('--image-limit', type=int, choices=(1, 2, 3), default=3, help='Fixture batch size; Bedrock uses config')
    run.add_argument('--allow-paid', action='store_true', help='Explicitly permit reader-owned Bedrock spend')
    resume = commands.add_parser('resume', help='Resume frozen workspace; no completed call is resent')
    resume.add_argument('--workspace', type=Path, required=True)
    resume.add_argument('--allow-paid', action='store_true')
    for name in ('report', 'ledger'):
        view = commands.add_parser(name, help='Offline workspace evidence')
        view.add_argument('--workspace', type=Path, required=True)
    args = parser.parse_args(argv)
    if args.command == 'list':
        print(json.dumps({'implemented': list(FACTORIES), 'fixture': 'synthetic plumbing, zero provider calls'}))
        return 0
    if args.command in ('verify', 'run'):
        module = factory(read(args.manifest).get('factory'))
        bundle, blobs = load_manifest(args.manifest, module)
        if args.command == 'verify':
            print(json.dumps({'factory': module.NAME, 'pages': len(bundle['pages']),
                              'declared_file_slots': list(bundle['declared']), 'provider_calls': 0}))
            return 0
        if args.provider == 'fixture':
            if args.config or args.allow_paid:
                raise ValueError('Fixture mode does not accept live config or paid permission')
            config = {'provider': 'fixture', 'image_limit': args.image_limit}
        else:
            if not args.config or not args.allow_paid:
                raise ValueError('Bedrock requires --config and explicit --allow-paid')
            config = read(args.config)
            if config.get('provider') != 'bedrock':
                raise ValueError('Config must explicitly name bedrock')
        validate_config(config)
    else:
        identity = read(args.workspace/'identity.json')
        module = factory(identity['factory'])
        config = identity['config']
        if args.command == 'resume' and config['provider'] == 'bedrock' and not args.allow_paid:
            raise ValueError('Bedrock resume requires explicit --allow-paid')
    with exclusive(args.workspace) as workspace:
        if args.command == 'ledger':
            name = 'synthetic-ledger.json' if config['provider'] == 'fixture' else 'ledger.json'
            print(json.dumps(read(workspace/name), indent=2))
            return 0
        if args.command == 'report':
            summary = report(workspace, module)
        else:
            runner = Runner(workspace, module, resume=True) if args.command == 'resume' else Runner(
                workspace, module, bundle=bundle, blobs=blobs, config=config)
            try:
                module.graph(runner).invoke({'last_role': 'start'})
            finally:
                summary = report(workspace, module)
        print(json.dumps(summary, indent=2))
        print('Report:', workspace/'report.html')
        return 0 if summary['status'] == 'complete' else 1


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (ValueError, RuntimeError, OSError, KeyError) as error:
        raise SystemExit(f'Reference runner: {error}')
