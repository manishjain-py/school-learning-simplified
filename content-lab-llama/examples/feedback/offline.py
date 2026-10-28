"""Fresh-process fixture CLI with SDK, client, network and credential guards.

Usage: python examples/translate/offline.py <ordinary run_factory.py arguments>
Package installation is separate; this guard surrounds actual graph/CLI execution.
"""
import builtins
import os
from pathlib import Path
import socket
import sys
import tempfile


def guard():
    original = builtins.__import__
    def no_sdk(name, *args, **kwargs):
        if name.split('.')[0] in ('boto3', 'botocore'):
            raise AssertionError('Offline rehearsal forbids SDK import/client creation')
        return original(name, *args, **kwargs)
    def no_network(*args, **kwargs):
        raise AssertionError('Offline rehearsal forbids network')
    builtins.__import__ = no_sdk
    for name in ('connect', 'connect_ex', 'send', 'sendall', 'sendto'):
        setattr(socket.socket, name, no_network)
    socket.create_connection = no_network
    for key in list(os.environ):
        if key.startswith(('AWS_', 'BEDROCK_', 'OPENAI_', 'ANTHROPIC_', 'LANGSMITH_', 'LANGCHAIN_')):
            del os.environ[key]
    empty = tempfile.TemporaryDirectory(prefix='feedback-no-credentials-')
    for key, name in (('AWS_SHARED_CREDENTIALS_FILE', 'credentials'), ('AWS_CONFIG_FILE', 'config')):
        path = Path(empty.name)/name
        path.write_text('')
        os.environ[key] = str(path)
    os.environ['AWS_EC2_METADATA_DISABLED'] = 'true'
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
    import run_factory
    from reference.providers import Bedrock
    Bedrock.__init__ = no_network
    return run_factory, empty


if __name__ == '__main__':
    cli, empty = guard()
    try:
        raise SystemExit(cli.main())
    finally:
        empty.cleanup()
