/**
 * Single camp-date formatting convention for desk UI, print, SMS, and status.
 *
 * Parse calendar days as midnight Asia/Kolkata (`YYYY-MM-DDT00:00:00+05:30`)
 * and render in Asia/Kolkata. Do not use local noon or UTC midnight anchors.
 */
const CAMP_DAY_FORMATTER = new Intl.DateTimeFormat("en-IN", {
  weekday: "short",
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "Asia/Kolkata",
});

/** @param isoDate Calendar day `YYYY-MM-DD` (camp_days.day_date / camps.camp_date). */
export function formatCampDay(isoDate: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return isoDate;
  const d = new Date(`${isoDate}T00:00:00+05:30`);
  if (Number.isNaN(d.getTime())) return isoDate;
  return CAMP_DAY_FORMATTER.format(d);
}

const SMS_MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/**
 * Compact GSM-7 camp date for SMS (`30 Sep 2026`).
 * Avoids weekday and locale-specific "Sept" so one segment stays under 160.
 */
export function formatCampDaySms(isoDate: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return isoDate;
  const [, y, m, day] = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})$/) || [];
  if (!y || !m || !day) return isoDate;
  const month = SMS_MONTHS[Number(m) - 1];
  if (!month) return isoDate;
  return `${Number(day)} ${month} ${y}`;
}
