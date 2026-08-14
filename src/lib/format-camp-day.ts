const CAMP_DAY_FORMATTER = new Intl.DateTimeFormat("en-IN", {
  weekday: "short",
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "Asia/Kolkata",
});

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

export function formatCampDaySms(isoDate: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return isoDate;
  const [, y, m, day] = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})$/) || [];
  if (!y || !m || !day) return isoDate;
  const month = SMS_MONTHS[Number(m) - 1];
  if (!month) return isoDate;
  return `${Number(day)} ${month} ${y}`;
}
