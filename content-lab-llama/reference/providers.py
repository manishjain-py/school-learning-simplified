"""Lazy Bedrock transport and an explicit synthetic sentinel provider."""
import json
import math


def validate_config(config):
    if config['provider'] == 'fixture':
        if set(config) != {'provider', 'image_limit'}:
            raise ValueError('Fixture config cannot include live settings')
    elif config['provider'] == 'bedrock':
        required = {'provider', 'image_limit', 'model', 'region', 'max_output_tokens',
                    'input_token_bound', 'input_per_million', 'output_per_million', 'cap_usd'}
        if set(config) != required:
            raise ValueError('Bedrock requires explicit model, region, token bounds, prices and cap')
        for key in ('input_per_million', 'output_per_million', 'cap_usd'):
            if type(config[key]) not in (int, float) or not math.isfinite(config[key]) or config[key] <= 0:
                raise ValueError(f'{key} must be finite and positive')
        for key in ('max_output_tokens', 'input_token_bound'):
            if type(config[key]) is not int or config[key] <= 0:
                raise ValueError(f'{key} must be a positive integer')
        # Conservative reference reservation, not a prompt-token estimate.
        if config['input_token_bound'] < 1_000_000:
            raise ValueError('input_token_bound must be at least 1000000')
        if not all(isinstance(config[k], str) and config[k].strip() for k in ('model', 'region')):
            raise ValueError('Model and region are required')
    else:
        raise ValueError('Unsupported provider')
    if type(config['image_limit']) is not int or not 1 <= config['image_limit'] <= 3:
        raise ValueError('image_limit must be 1, 2 or 3 for the reference path')
    return config


class Bedrock:
    def __init__(self, config):
        self.config = config
        self.client = None

    def invoke(self, request, *, role, notes_pages):
        if self.client is None:
            import boto3
            from botocore.config import Config
            self.client = boto3.client('bedrock-runtime', region_name=self.config['region'],
                config=Config(retries={'total_max_attempts': 1}, connect_timeout=20, read_timeout=360))
        return self.client.converse(modelId=self.config['model'], messages=request['messages'],
            inferenceConfig={'maxTokens': self.config['max_output_tokens'], 'temperature': .1})


class Fixture:
    """No SDK import/client/network; these are deliberately non-curricular sentinels."""
    def invoke(self, request, *, role, notes_pages):
        marker = 'SYNTHETIC PLUMBING ONLY — NOT MODEL OR CURRICULUM OUTPUT'
        if notes_pages:
            value = {'page_notes': [{'printed_page': p, 'observations': marker} for p in notes_pages]}
        elif role == 'selection':
            value = {'winner_index': 1, 'concerns': [marker], 'note': marker}
        elif role in ('coverage', 'accuracy', 'structure'):
            value = {'ok': False, 'findings': [{'issue': marker, 'severity': 'blocking'}], 'note': marker}
        else:
            value = {'artifact': {'synthetic': True, 'sentinel': marker, 'role': role}, 'note': marker}
        return {'output': {'message': {'content': [{'text': json.dumps(value)}]}},
                'stopReason': 'end_turn', 'synthetic': True}
