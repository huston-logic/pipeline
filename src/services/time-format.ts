// How time and money read to the owner (decision 0049): "1 h 30 min", "$95.00", and the one line a time entry is shown
// as in summaries and in a proposal's Time group: "1 h 30 min, Design, billable at $95.00/h ($142.50), for Pat
// Example". Deal values have no currency (src/board/parts.ts formats them as plain numbers); time is billed, so its
// money has a dollar sign and cents. Import-free.

const dollars = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** "$1,234.50". */
export const formatMoney = (amount: number): string => `$${dollars.format(amount)}`;

/** "45 min", "2 h", "1 h 30 min". */
export function formatDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest} min`;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

/** Rounded to cents; toFixed first so 1.005 rounds up as a person would expect. */
export const toCents = (amount: number): number => Math.round(Number((amount * 100).toFixed(6))) / 100;

/** What `minutes` at `rate` an hour come to, in cents; 0 with no rate. Worked out on read, never stored. */
export const amountOf = (rate: number | null, minutes: number): number => (rate === null ? 0 : toCents((rate * minutes) / 60));

/** "billable at $95.00/h ($142.50)", "billable, no rate" or "not billable". */
export function billingText(billable: boolean, rate: number | null, minutes: number): string {
  if (!billable) return "not billable";
  if (rate === null) return "billable, no rate";
  return `billable at ${formatMoney(rate)}/h (${formatMoney(amountOf(rate, minutes))})`;
}

export interface TimeLineParts {
  minutes: number;
  /** The work type's name, or null for none. */
  workType: string | null;
  billable: boolean;
  rate: number | null;
  /** Who it was for, as labels.ts names them, or null for no one. */
  who: string | null;
}

/** "1 h 30 min, Design, billable at $95.00/h ($142.50), for Pat Example". */
export function timeLine(parts: TimeLineParts): string {
  return [
    formatDuration(parts.minutes),
    parts.workType,
    billingText(parts.billable, parts.rate, parts.minutes),
    parts.who === null ? null : `for ${parts.who}`,
  ]
    .filter((part) => part !== null)
    .join(", ");
}

/** A running timer: "Design, for Pat Example", or "" for a timer of no one's with no work type. */
export function timerLine(workType: string | null, who: string | null): string {
  return [workType, who === null ? null : `for ${who}`].filter((part) => part !== null).join(", ");
}
