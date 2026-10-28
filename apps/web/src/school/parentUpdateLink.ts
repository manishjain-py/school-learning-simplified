import type { LinkedChild } from './types';

export type ParentUpdateTarget = { schoolId: string; classId: string; childId: string; updateId: string };
export type ParentUpdateLink = { kind: 'none' } | { kind: 'invalid' } | { kind: 'target'; target: ParentUpdateTarget };
const keys = ['view', 'school', 'class', 'child', 'update'] as const;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

/** Email links choose a view; only server-returned current family links grant access. */
export function parseParentUpdateLink(search: string): ParentUpdateLink {
  const query = new URLSearchParams(search);
  if (!keys.some(key => query.has(key))) return { kind: 'none' };
  if (keys.some(key => query.getAll(key).length !== 1) || query.get('view') !== 'parent') return { kind: 'invalid' };
  const target = { schoolId: query.get('school')!, classId: query.get('class')!, childId: query.get('child')!, updateId: query.get('update')! };
  if (!Object.values(target).every(value => uuid.test(value))) return { kind: 'invalid' };
  return { kind: 'target', target };
}

export function linkedUpdateChild(target: ParentUpdateTarget, children: LinkedChild[]): LinkedChild | undefined {
  return children.find(child => child.schoolId === target.schoolId && child.classId === target.classId && child.id === target.childId);
}

export const parentUpdateLinkKey = (link: ParentUpdateLink) => link.kind === 'target'
  ? [link.target.schoolId, link.target.classId, link.target.childId, link.target.updateId].join(':') : link.kind;
