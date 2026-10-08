/**
 * Formats money, dates and times in the traveller's currency and locale. Pure, with no server imports, so the cards and the model
 * prompts format identically.
 */

/** Latin digits in every locale, to match the English interface's times, durations and counts. */
const DIGITS = { numberingSystem: "latn" } as const;

/** The languages written right to left. */
const RIGHT_TO_LEFT = /^(ar|fa|he|iw|ps|ur|yi|dv|ckb|sd|ug)\b/i;

/**
 * Wraps right-to-left text in Unicode isolates so the surrounding English keeps its order. Without them an Arabic range "10 – 17"
 * reads backwards and the digits attach to the neighbouring words.
 */
const isolated = (text: string, locale: string): string => (RIGHT_TO_LEFT.test(locale) ? `⁨${text}⁩` : text);

/** A fare in whole units. Fares arrive rounded, so decimals would show precision the data lacks (and the yen has no minor unit). */
export function money(amount: number, currency = "USD", locale = "en-US"): string {
  const code = currency.toUpperCase();
  try {
    const text = new Intl.NumberFormat(locale, {
      style: "currency",
      currency: code,
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
      ...DIGITS,
    }).format(amount);
    return isolated(text, locale);
  } catch {
    // An unknown currency or malformed locale falls back to the code and a number instead of throwing.
    return `${code} ${Math.round(amount).toLocaleString("en-US")}`;
  }
}

/**
 * Options for every displayed day: UTC, so a date reads the same in any timezone, and Gregorian, the calendar airlines sell in
 * (ar-SA defaults to Hijri).
 */
export const DAY_FORMAT = { timeZone: "UTC", calendar: "gregory", ...DIGITS } as const;

/** A real `YYYY-MM-DD` day. Checked by formatting it back, since `Date.parse` rolls Feb 30 over to Mar 2. */
export const isDay = (v: unknown): v is string =>
  typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;

/** "Mar 10": a date on a card, in the traveller's locale. */
export function shortDate(isoDate: string, locale = "en-US"): string {
  const day = isoDate.slice(0, 10);
  try {
    // Noon UTC, so a negative-offset timezone can't roll the date back a day.
    return isolated(new Date(`${day}T12:00:00Z`).toLocaleDateString(locale, { month: "short", day: "numeric", ...DAY_FORMAT }), locale);
  } catch {
    return day;
  }
}

/**
 * "Sat, Nov 14": a day with its weekday, in the locale's own pattern ("Sa., 14. Nov.", "11月14日(土)"). English gets its comma here
 * because Node's ICU writes en-GB as "Sat 14 Nov" and Chrome as "Sat, 14 Nov", and the mismatch breaks hydration.
 */
export function weekdayDate(isoDate: string, locale = "en-US"): string {
  const day = isoDate.slice(0, 10);
  try {
    const parts = new Intl.DateTimeFormat(locale, { weekday: "short", month: "short", day: "numeric", ...DAY_FORMAT }).formatToParts(new Date(`${day}T12:00:00Z`));
    if (/^en\b/i.test(locale) && parts[0]?.type === "weekday" && parts[1]?.type === "literal") parts[1] = { ...parts[1], value: ", " };
    return isolated(parts.map((p) => p.value).join(""), locale);
  } catch {
    return day;
  }
}

/**
 * Two days as a range with no year: "Nov 14 – 24", "12 – 19 May", "Nov 28 – Dec 3". Built from single days because Node's
 * ICU and Chrome format en-GB ranges differently with Intl's formatRange, which breaks hydration.
 */
export function dayRange(a: string, b: string | null | undefined, locale = "en-US"): string {
  if (!b || a === b) return shortDate(a, locale);
  // In English, a range inside one month says the month once.
  if (a.slice(0, 7) === b.slice(0, 7) && /^en\b/i.test(locale)) {
    try {
      const parts = new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", ...DAY_FORMAT }).formatToParts(new Date(`${a}T12:00:00Z`));
      const month = parts.find((p) => p.type === "month")?.value;
      const first = Number(a.slice(8, 10));
      const last = Number(b.slice(8, 10));
      if (month) return parts.findIndex((p) => p.type === "month") < parts.findIndex((p) => p.type === "day") ? `${month} ${first} – ${last}` : `${first} – ${last} ${month}`;
    } catch {
      /* use the full form below */
    }
  }
  return `${shortDate(a, locale)} – ${shortDate(b, locale)}`;
}

/** "Mar 10, 3:04 PM": a capture stamp, in the viewer's own timezone. */
export function stamp(iso: string, locale = "en-US"): string {
  try {
    const text = new Date(iso).toLocaleString(locale, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      calendar: "gregory",
      ...DIGITS,
    });
    return isolated(text, locale);
  } catch {
    return iso;
  }
}

/**
 * A 24-hour time ("19:20") on the locale's clock, in parts: the time, the day period if any ("PM" in the US, none in Germany), and
 * which comes first ("오후 7:20"). Callers add the space between them, since Node's ICU and older browsers use different spaces and
 * the mismatch breaks hydration. A 24-hour locale keeps two-digit hours ("09:40").
 */
export function clockParts(hhmm: string, locale = "en-US"): { time: string; period: string; periodFirst: boolean } {
  const m = hhmm.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return { time: hhmm, period: "", periodFirst: false };
  try {
    const parts = new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit", timeZone: "UTC", ...DIGITS }).formatToParts(new Date(Date.UTC(2000, 0, 1, Number(m[1]), Number(m[2]))));
    const at = parts.findIndex((p) => p.type === "dayPeriod");
    const time = parts
      .filter((p) => p.type !== "dayPeriod")
      .map((p) => p.value)
      .join("")
      .trim();
    return at < 0 ? { time: `${m[1].padStart(2, "0")}:${m[2]}`, period: "", periodFirst: false } : { time, period: parts[at].value, periodFirst: at < parts.findIndex((p) => p.type === "hour") };
  } catch {
    return { time: `${m[1]}:${m[2]}`, period: "", periodFirst: false };
  }
}

/** "7:20 PM" or "19:20": a time of day as one string. */
export function clock(hhmm: string, locale = "en-US"): string {
  const { time, period, periodFirst } = clockParts(hhmm, locale);
  return !period ? time : periodFirst ? `${period} ${time}` : `${time} ${period}`;
}

/** Whether the locale uses a 12-hour clock ("7:20 PM"). */
export const twelveHour = (locale = "en-US"): boolean => clockParts("19:20", locale).period !== "";

/** A flight time with its day mark ("20:05+1", "22:45−1") on the locale's clock: "8:05 PM+1". */
export function flightClock(t: string, locale = "en-US"): string {
  const m = t.match(/^(\d{1,2}:\d{2})(.*)$/);
  return m ? `${clock(m[1], locale)}${m[2]}` : t;
}

/** "4h 45m" / "45m". Durations are not localised; the units are part of the data. */
export const duration = (minutes: number): string =>
  minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;

/** The currencies the header offers (lib/currencies.ts). */
export { CURRENCIES } from "./currencies";

/** Whether this looks like a currency code: any three letters. */
export const isCurrencyCode = (v: unknown): v is string =>
  typeof v === "string" && /^[A-Za-z]{3}$/.test(v);

/** A BCP-47 tag Intl will accept, or the fallback. Never throws. */
export function coerceLocale(v: unknown, fallback = "en-US"): string {
  if (typeof v !== "string" || !v.trim()) return fallback;
  try {
    return new Intl.Locale(v.trim()).toString();
  } catch {
    return fallback;
  }
}
