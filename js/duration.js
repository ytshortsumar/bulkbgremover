/* duration.js — pure key-duration helpers (no Firebase/DOM), unit-tested in
   tests.html. Turns a chosen duration into a concrete expiry Date. */

/* Duration → label. Expiry is computed by computeExpiry() below. */
export const DURATIONS = {
  '1w': { label: '1 week',   days: 7 },
  '1m': { label: '1 month',  months: 1 },
  '6m': { label: '6 months', months: 6 },
  '1y': { label: '1 year',   years: 1 },
  'lifetime': { label: 'Lifetime' },
};

/* Expiry date for a duration object (null = lifetime). Clamps month/year math so
   an end-of-month issue date can't roll forward (Jan 31 + 1 month → Feb 28/29).
   `from` defaults to now; injectable so the clamp path can be tested. */
export function computeExpiry(dur, from = new Date()) {
  if (!dur || (dur.days == null && dur.months == null && dur.years == null)) return null;
  const d = from instanceof Date ? new Date(from.getTime()) : new Date();
  if (dur.days) { d.setDate(d.getDate() + dur.days); return d; }
  const day = d.getDate();
  if (dur.months) d.setMonth(d.getMonth() + dur.months);
  if (dur.years) d.setFullYear(d.getFullYear() + dur.years);
  if (d.getDate() < day) d.setDate(0); // snap overflow back to intended month-end
  return d;
}

/* Resolve the chosen duration into a { label, days?/months?/years? } object.
   'custom' reads the days number input. Returns null if custom days are invalid. */
export function resolveDuration(durKey, daysValue) {
  if (durKey !== 'custom') return DURATIONS[durKey] || DURATIONS['1m'];
  const days = parseInt(daysValue, 10);
  if (!Number.isFinite(days) || days < 1) return null;
  return { label: days === 1 ? '1 day' : `${days} days`, days };
}
