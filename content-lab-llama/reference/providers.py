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
        kwargs = {'modelId': self.config['model'], 'messages': request['messages'],
                  'inferenceConfig': {'maxTokens': self.config['max_output_tokens'], 'temperature': .1}}
        if 'system' in request:
            kwargs['system'] = request['system']
        return self.client.converse(**kwargs)


class Fixture:
    """No SDK import/client/network; these are deliberately non-curricular sentinels."""
    def invoke(self, request, *, role, notes_pages):
        marker = 'SYNTHETIC PLUMBING ONLY — NOT MODEL OR CURRICULUM OUTPUT'
        if notes_pages:
            value = {'page_notes': [{'printed_page': p, 'observations': marker} for p in notes_pages]}
        elif role.startswith('feedback_'):
            from .factories.feedback_fixture import output
            value = output(role, request)
        elif role.startswith('avatar_'):
            data = json.loads(request['messages'][0]['content'][0]['text'].split('Declared task data:\n', 1)[1])['task_inputs']
            value = {'card_idx': data['card']['card_idx'], 'verdict': 'fail',
                     'reason': marker+' — advisory negative fixture, no actual defect asserted.',
                     'checked': ['Synthetic plumbing response only; no model appearance or lip-sync judgment.'],
                     'head_in_frame': False}
        elif role.startswith(('visuals_', 'boards_')):
            from .factories.visuals_fixture import output
            value = output(role, request)
        elif role.startswith('translate_'):
            from .factories.translate_fixture import output
            value = output(role, request)
        elif role.startswith('revise_'):
            from .factories.revise_fixture import output
            value = output(role, request)
        elif role.startswith('practice_'):
            from .factories.practice_fixture import output
            value = output(role, request)
        elif role.startswith('explain_'):
            from .factories.explain_fixture import output
            value = output(role)
        elif role == 'toc_review':
            value = {'ok': False, 'findings': [{'chapter_number': None, 'issue': marker,
                'evidence': 'One-pixel synthetic images contain no printed chapter map.',
                'fix': 'Synthetic exercise only; no factual content correction claimed.'}], 'note': marker}
        elif role in ('toc_draft', 'toc_revision'):
            value = {'artifact': {'chapters': [
                {'chapter_number': 1, 'chapter_title': marker+' A', 'start_page': 7,
                 'end_page': 10, 'notes': None},
                {'chapter_number': 2, 'chapter_title': marker+' B', 'start_page': 11,
                 'end_page': 14, 'notes': marker}],
                'source_note': marker+'; start-only sentinel: first end = next start minus one; final end is a disclosed synthetic estimate.'},
                'note': marker}
        elif role == 'selection':
            value = {'winner_index': 1, 'concerns': [marker], 'note': marker}
        elif role in ('coverage', 'accuracy', 'structure'):
            value = {'ok': False, 'findings': [{'issue': marker, 'severity': 'blocking'}], 'note': marker}
        else:
            value = {'artifact': {'synthetic': True, 'sentinel': marker, 'role': role}, 'note': marker}
        return {'output': {'message': {'content': [{'text': json.dumps(value)}]}},
                'stopReason': 'end_turn', 'synthetic': True}
