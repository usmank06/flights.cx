import { AIRPORT_LIST, AIRPORTS } from "@/lib/airports";
import { isOpenDestination, placeLabel, resolveAirport } from "@/lib/search/intake";
import { dayLabel, nightsBetween } from "@/components/search/dates";
import { type Draft, whoLabel } from "@/components/search/draft";

/**
 * Notes under each answer saying what the search will do with it ("ORD and Midway", "18 nights · nearby days too"). Built in code
 * from the airport table and the answer, without a model, so they only state what the engine does.
 */

const NUMBER = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
const count = (n: number) => NUMBER[n] ?? String(n);

/** Splits a list like "Lisbon or Porto", "Paris, Rome" or "LHR/LGW" into its places. */
export function placesIn(text: string): string[] {
  return text
    .split(/\s*(?:,|\/|&|\bor\b|\band\b)\s*/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** All known airports in the code's city, busiest first. */
function cityAirports(code: string) {
  const city = AIRPORTS[code]?.city;
  return city ? AIRPORT_LIST.filter((a) => a.city === city).sort((a, b) => a.tier - b.tier) : [];
}

/** The note for one place: its airports when there are a few, a count when there are many. */
function aboutOne(text: string, side: "to" | "from"): string | undefined {
  const code = resolveAirport(text);
  if (!code) return undefined;
  const all = cityAirports(code);
  if (all.length > 3) return `All ${count(all.length)} ${AIRPORTS[code].city} airports`;
  if (all.length > 1) return all.map((a) => a.code).join(" and ");
  return side === "to" ? `${code}, and airports nearby` : code;
}

export function noteForDestination(to: string): string | undefined {
  const t = to.trim();
  if (isOpenDestination(t)) {
    return /^(?:anywhere|anywhere at all|somewhere|wherever|surprise me)$/i.test(t)
      ? "Wherever it’s cheap to fly from you"
      : `Places that fit “${placeLabel(t)}” and are cheap to reach`;
  }
  const places = placesIn(t);
  const known = [...new Set(places.map((p) => resolveAirport(p)).filter((c): c is string => Boolean(c)).map((c) => AIRPORTS[c].city))];
  if (places.length > 1 && known.length > 1) return known.length === 2 ? "Both will be searched" : `All ${count(known.length)} will be searched`;
  return aboutOne(t, "to");
}

export function noteForOrigin(from: string): string | undefined {
  return aboutOne(from.trim(), "from");
}

export function noteForDates(d: Draft): string | undefined {
  if (!d.depart) return undefined;
  const around = d.flexible ? " · nearby days too" : "";
  if (d.oneWay || !d.ret) return d.flexible ? "Nearby days too" : undefined;
  const n = nightsBetween(d.depart, d.ret);
  return `${n} night${n === 1 ? "" : "s"}${around}`;
}

/** The bubble already shows the party, so the note only says the prices cover everyone. */
export function noteForWho(d: Draft): string | undefined {
  const total = d.adults + d.children + d.infantsInSeat + d.infantsOnLap;
  return total <= 1 ? undefined : total === 2 ? "Prices are for both of you" : "Prices are for all of you";
}

/** The dates answer's bubble text. The no-break space keeps the "·" from starting a new line. */
export const datesAnswer = (d: Draft, locale: string) =>
  !d.depart
    ? "No dates yet"
    : `${d.oneWay || !d.ret ? `${dayLabel(d.depart, locale)}, one way` : `${dayLabel(d.depart, locale)} → ${dayLabel(d.ret, locale)}`}${d.flexible ? `\u00a0· ${d.flexNote.trim() || "flexible"}` : ""}`;

/** The party's bubble text: "Just me", "Two of us" or "Two adults, two children", else whoLabel's. */
export function whoAnswer(d: Draft): string {
  const plain = !d.infantsInSeat && !d.infantsOnLap;
  if (plain && d.adults === 1 && !d.children) return "Just me";
  if (plain && d.adults === 2 && !d.children) return "Two of us";
  if (plain && d.adults === 2 && d.children === 2) return "Two adults, two children";
  return whoLabel(d);
}

/** Short label for a place: "Lisbon or Porto", "Chicago", "Somewhere warm". */
export function placeShort(text: string): string {
  const places = placesIn(text);
  if (places.length > 1 && !isOpenDestination(text)) {
    const cities = places.map((p) => {
      const c = resolveAirport(p);
      return c ? AIRPORTS[c].city : placeLabel(p);
    });
    return [...new Set(cities)].join(" or ");
  }
  return placeLabel(text);
}
