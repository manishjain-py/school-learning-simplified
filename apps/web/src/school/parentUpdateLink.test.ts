import assert from 'node:assert/strict';
import { test } from 'node:test';
import { linkedUpdateChild, parseParentUpdateLink } from './parentUpdateLink';
import type { LinkedChild } from './types';

const schoolId = '11111111-1111-4111-8111-111111111111';
const classId = '22222222-2222-4222-8222-222222222222';
const childId = '33333333-3333-4333-8333-333333333333';
const updateId = '44444444-4444-4444-8444-444444444444';
const params = new URLSearchParams({ view: 'parent', school: schoolId, class: classId, child: childId, update: updateId });

test('parent email destination survives query encoding and matches the full current family link', () => {
  const parsed = parseParentUpdateLink('?' + params.toString());
  assert.equal(parsed.kind, 'target'); if (parsed.kind !== 'target') return;
  assert.deepEqual(parsed.target, { schoolId, classId, childId, updateId });
  const child: LinkedChild = { id: childId, schoolId, classId, name: 'Anika', className: '4B', schoolName: 'School', timeZone: 'Asia/Kolkata' };
  assert.equal(linkedUpdateChild(parsed.target, []), undefined);
  assert.equal(linkedUpdateChild(parsed.target, [{ ...child, schoolId: classId }]), undefined);
  assert.equal(linkedUpdateChild(parsed.target, [{ ...child, classId: schoolId }]), undefined);
  assert.equal(linkedUpdateChild(parsed.target, [{ ...child, id: updateId }]), undefined);
  assert.equal(linkedUpdateChild(parsed.target, [child]), child);
});

test('partial, ambiguous and malformed email links cannot silently choose a child or student role', () => {
  assert.deepEqual(parseParentUpdateLink(''), { kind: 'none' });
  assert.deepEqual(parseParentUpdateLink('?unrelated=value'), { kind: 'none' });
  for (const key of ['view', 'school', 'class', 'child', 'update']) {
    const missing = new URLSearchParams(params); missing.delete(key);
    assert.deepEqual(parseParentUpdateLink(missing.toString()), { kind: 'invalid' });
    const duplicate = new URLSearchParams(params); duplicate.append(key, params.get(key)!);
    assert.deepEqual(parseParentUpdateLink(duplicate.toString()), { kind: 'invalid' });
  }
  for (const [key, value] of [['view', 'student'], ['child', '../other'], ['update', 'https://example.test'], ['school', '']]) {
    const invalid = new URLSearchParams(params); invalid.set(key, value);
    assert.deepEqual(parseParentUpdateLink(invalid.toString()), { kind: 'invalid' });
  }
});
