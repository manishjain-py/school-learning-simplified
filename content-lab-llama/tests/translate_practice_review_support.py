"""T28 exact placement normalization for immutable historical test baselines."""
import ast
from copy import deepcopy

FIXTURE = 'translate-practice-review-system-baseline.json'
PLACEMENT = "if stream == 'practice' and phase == 'review':\n    request['system'] = [{'text': final_contract}]"


def strip_practice_review_system(request, stream, phase):
    """Remove exactly the T28 field; never change either original user block."""
    if stream == 'practice' and phase == 'review':
        assert request.pop('system') == [{'text':request['messages'][0]['content'][1]['text']}]
    return request


def strip_practice_review_ast(module):
    """Reconstruct only the exact base request AST, leaving every other node."""
    expected = ast.parse(PLACEMENT).body[0]
    request = next(n for n in module.body if isinstance(n, ast.FunctionDef) and n.name == 'request')
    matches = [n for n in request.body if ast.dump(n) == ast.dump(expected)]
    assert len(matches) == 1 and request.body[-2] is matches[0]
    request.body.remove(matches[0])
    return module


def scenario_bundle(size):
    from test_translate_teaching_final_system import scenario_bundle as original
    bundle = original(size)
    if size in (None, 50):
        template = bundle['declared']['practice']['questions'][0]
        count = 13 if size is None else 51
        bundle['declared']['practice']['questions'] = [dict(deepcopy(template),
            question_text=f'SYNTHETIC practice boundary question {i}',
            signature=f'SYNTHETIC practice boundary signature {i}') for i in range(1,count+1)]
    return bundle
