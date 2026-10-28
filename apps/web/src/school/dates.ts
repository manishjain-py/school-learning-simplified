type DateOptions = { now?: Date; locale?: 'en' | 'hi'; localToday?: string };
const DAY = 86_400_000;
const localeName = (locale: 'en' | 'hi' = 'en') => locale === 'hi' ? 'hi-IN' : 'en-GB';
const unavailable = (locale: 'en' | 'hi' = 'en') => locale === 'hi' ? 'तारीख उपलब्ध नहीं' : 'Date unavailable';

function calendarInstant(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? date : null;
}

export function schoolCalendarDate(instant: Date, timeZone: string): string {
  if (!timeZone || !Number.isFinite(instant.getTime())) return '';
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(instant);
    return ['year', 'month', 'day'].map(type => parts.find(part => part.type === type)!.value).join('-');
  } catch { return ''; }
}

/** A calendar date is never shifted through the viewer's time zone. */
export function friendlySchoolDate(value: string, timeZone: string, options: DateOptions = {}): string {
  const date = calendarInstant(value);
  const today = options.localToday || schoolCalendarDate(options.now || new Date(), timeZone);
  const todayDate = calendarInstant(today);
  if (!date || !todayDate) return unavailable(options.locale);
  if (value === today) return options.locale === 'hi' ? 'आज' : 'Today';
  const parts = new Intl.DateTimeFormat(localeName(options.locale), {
    timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short',
    ...(value.slice(0, 4) !== today.slice(0, 4) ? { year: 'numeric' as const } : {}),
  }).formatToParts(date);
  const namedDate = ['weekday', 'day', 'month', 'year'].map(type => parts.find(part => part.type === type)?.value).filter(Boolean).join(' ');
  const tomorrow = new Date(todayDate.getTime() + DAY).toISOString().slice(0, 10);
  return value === tomorrow ? `${options.locale === 'hi' ? 'कल' : 'Tomorrow'} · ${namedDate}` : namedDate;
}

export function friendlySchoolTimestamp(value: string, timeZone: string, options: DateOptions = {}): string {
  // Timestamps must identify an instant; a date-only or browser-local value does not.
  if (!/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return unavailable(options.locale);
  const instant = new Date(value);
  const calendarDate = schoolCalendarDate(instant, timeZone);
  if (!calendarDate) return unavailable(options.locale);
  const day = friendlySchoolDate(calendarDate, timeZone, options);
  const time = new Intl.DateTimeFormat(localeName(options.locale), { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(instant);
  return `${day} · ${time}`;
}

/** Continue hiding expired cards when an open tab crosses school midnight. */
export function currentSchoolGuidance<T extends { date: string | null }>(items: T[], timeZone: string, localToday: string, now = new Date()): T[] {
  const clientToday = schoolCalendarDate(now, timeZone);
  const today = clientToday > localToday ? clientToday : localToday;
  return items.filter(item => item.date === null || (Boolean(calendarInstant(item.date)) && item.date >= today));
}
