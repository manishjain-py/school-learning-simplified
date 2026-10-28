import assert from 'node:assert/strict';
import test from 'node:test';
import { currentSchoolGuidance, friendlySchoolDate, friendlySchoolTimestamp, schoolCalendarDate } from '../apps/web/src/school/dates.js';

test('school midnight changes today and tomorrow independently of UTC', () => {
  const before = new Date('2026-10-28T18:29:59Z');
  const after = new Date('2026-10-28T18:30:00Z');
  assert.equal(schoolCalendarDate(before, 'Asia/Kolkata'), '2026-10-28');
  assert.equal(schoolCalendarDate(after, 'Asia/Kolkata'), '2026-10-29');
  assert.equal(friendlySchoolDate('2026-10-29', 'Asia/Kolkata', { now: before }), 'Tomorrow · Thu 29 Oct');
  assert.equal(friendlySchoolDate('2026-10-29', 'Asia/Kolkata', { now: after }), 'Today');
  assert.equal(friendlySchoolDate('2026-10-30', 'Asia/Kolkata', { now: before }), 'Fri 30 Oct');
});

test('date-only labels preserve their calendar day even across the date line', () => {
  const options = { localToday: '2026-10-28' };
  assert.equal(friendlySchoolDate('2026-10-30', 'Pacific/Kiritimati', options), 'Fri 30 Oct');
  assert.equal(friendlySchoolDate('2026-10-30', 'America/Los_Angeles', options), 'Fri 30 Oct');
  assert.equal(friendlySchoolDate('2026-02-30', 'Asia/Kolkata', options), 'Date unavailable');
});

test('timestamps use school time and day rather than the browser locale', () => {
  const value = '2026-10-28T18:45:00Z';
  const now = new Date(value);
  assert.equal(friendlySchoolTimestamp(value, 'Asia/Kolkata', { now }), 'Today · 00:15');
  assert.equal(friendlySchoolTimestamp(value, 'America/Los_Angeles', { now }), 'Today · 11:45');
  assert.equal(friendlySchoolTimestamp('2026-10-28', 'Asia/Kolkata', { now }), 'Date unavailable');
  assert.equal(friendlySchoolTimestamp('2026-10-28T18:45:00', 'Asia/Kolkata', { now }), 'Date unavailable');
});

test('DST transitions retain the school calendar day and real wall-clock time', () => {
  const zone = 'America/New_York';
  assert.equal(friendlySchoolDate('2026-03-09', zone, { now: new Date('2026-03-08T05:30:00Z') }), 'Tomorrow · Mon 9 Mar');
  assert.equal(friendlySchoolTimestamp('2026-03-08T06:30:00Z', zone, { localToday: '2026-03-08' }), 'Today · 01:30');
  assert.equal(friendlySchoolTimestamp('2026-03-08T07:30:00Z', zone, { localToday: '2026-03-08' }), 'Today · 03:30');
  assert.equal(friendlySchoolDate('2026-11-02', zone, { now: new Date('2026-11-01T04:30:00Z') }), 'Tomorrow · Mon 2 Nov');
});

test('cross-year labels remain unambiguous and Hindi relative labels are available', () => {
  assert.equal(friendlySchoolDate('2027-01-01', 'Asia/Kolkata', { localToday: '2026-12-31' }), 'Tomorrow · Fri 1 Jan 2027');
  assert.equal(friendlySchoolDate('2025-10-30', 'Asia/Kolkata', { localToday: '2026-10-28' }), 'Thu 30 Oct 2025');
  assert.equal(friendlySchoolDate('2026-10-28', 'Asia/Kolkata', { localToday: '2026-10-28', locale: 'hi' }), 'आज');
  assert.match(friendlySchoolDate('2026-10-29', 'Asia/Kolkata', { localToday: '2026-10-28', locale: 'hi' }), /^कल · /);
});

test('an already-open family page hides yesterday after school midnight but preserves undated guidance', () => {
  const cards = [{ id: 'old', date: '2026-10-27' }, { id: 'expires', date: '2026-10-28' }, { id: 'today', date: '2026-10-29' }, { id: 'future', date: '2026-10-30' }, { id: 'undated', date: null }];
  assert.deepEqual(currentSchoolGuidance(cards, 'Asia/Kolkata', '2026-10-28', new Date('2026-10-28T18:29:59Z')).map(card => card.id), ['expires', 'today', 'future', 'undated']);
  assert.deepEqual(currentSchoolGuidance(cards, 'Asia/Kolkata', '2026-10-28', new Date('2026-10-28T18:30:00Z')).map(card => card.id), ['today', 'future', 'undated']);
  // A slow client clock cannot revive a date already expired at the server.
  assert.deepEqual(currentSchoolGuidance(cards, 'Asia/Kolkata', '2026-10-29', new Date('2026-10-27T00:00:00Z')).map(card => card.id), ['today', 'future', 'undated']);
});
