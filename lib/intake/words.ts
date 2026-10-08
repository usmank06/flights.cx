import { metroCodes, resolveAirport } from "@/lib/search/intake";

/** Checks on the traveller's words that add or skip intake questions (next.ts). Nothing here sets a search field. */

/** A count of travellers: "two of us", "4 adults", "our three kids", "a baby", "family of four". */
const NUM = String.raw`(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|a couple of|a pair of|both)`;
const PEOPLE = String.raw`(?:of us|us|adults?|kids?|children|child|people|persons?|passengers?|travell?ers?|pax|friends?|sons?|daughters?|boys?|girls?|babies|baby|infants?|toddlers?|teens?|teenagers?|grandkids|grandchildren|seniors?|students?|colleagues|guys|cousins|siblings)`;
const COUNTED = new RegExp(
  String.raw`\b${NUM}\s+(?:(?:little|young|small|teenage|grown-up|grown|adult|older|younger|of my|of our|my|our)\s+)*${PEOPLE}\b` +
    String.raw`|\b(?:family|party|group|team) of (?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b` +
    String.raw`|\b(?:a|an|one)\s+(?:(?:little|young|small)\s+)?(?:kid|child|baby|infant|toddler|son|daughter|friend|teen|teenager)\b`,
  "i"
);
/** Travelling alone: one adult. */
const ALONE = /\b(?:just me|only me|me alone|by myself|on my own|solo|alone|just myself)\b/i;
/** One other person, so two adults: the planner reads "with my partner" as two. */
const PARTNER = /\b(?:partner|wife|husband|girlfriend|boyfriend|fianc[ée]e?|spouse|hubby|other half|honeymoon|as a couple)\b/i;
/** Groups whose size isn't stated. */
const GROUP = /\b(?:family|families|kids|children|sons|daughters|grandkids|grandchildren|babies|friends|group|gang|crew|team|colleagues|co-?workers|relatives|cousins|siblings|in-laws|parents|grandparents|everyone|the boys|the girls)\b/i;
/** "We", "our": more than one, but how many? */
const WE = /\b(?:we|we're|we’re|we'll|we’ll|we'd|ourselves|our|ours)\b/i;
/** People who are visited rather than flown with: "to see family", "visiting friends". */
const VISITED = /\b(?:visit|visiting|see|seeing|meet|meeting|stay with|staying with)\s+(?:(?:my|our|the|some|old|her|his|their)\s+)*(?:family|friends|parents|grandparents|kids|children|grandkids|grandchildren|relatives|cousins|in-laws|siblings)\b/gi;

/** "us" as people ("surprise us"), not the country: "US" in capitals and "the us" are the country. */
const saysUs = (words: string) => [...words.matchAll(/(\bthe\s+)?\b(us|Us)\b/g)].some((m) => !m[1]);

/** A group with no count ("Rome with the family", "we want somewhere warm"). The search would price one adult, so "who" is asked. */
export function partyOpen(words: string): boolean {
  if (COUNTED.test(words) || ALONE.test(words)) return false;
  const going = words.replace(VISITED, " ");
  if (GROUP.test(going)) return true;
  return (WE.test(going) || saysUs(going)) && !PARTNER.test(going);
}

/** Who is going is said: a count, "just me", or a partner (two). */
export function partySaid(words: string): boolean {
  return COUNTED.test(words) || ALONE.test(words) || (PARTNER.test(words) && !GROUP.test(words.replace(VISITED, " ")));
}

/** A place said as where the trip starts: "from Chicago", "flying out of JFK", "I live in Denver". */
const FROM_CUE = /\b(?:from|out of|leaving|departing|based in|live in|living in|home is|starting in)\s+([^,.;!?\n]+)/gi;
/** "Chicago to Lisbon", "ORD → HND": a place before a "to" with a place after it. */
const TO_CUE = /\s(?:to|→|->)\s/g;
/** An open destination: "somewhere warm", "anywhere", "a beach", "Europe". */
const OPEN_PLACE =
  /\b(?:anywhere|somewhere|wherever|surprise (?:me|us)|abroad|overseas|beach(?:es)?|islands?|tropical|ski(?:ing)?|mountains|europe|asia|africa|oceania|caribbean|scandinavia|balkans|mediterranean|middle east|south america|latin america|central america|south ?east asia)\b/i;
/** Common words that are also city names. They count as places only when capitalised. */
const COMMON = new Set(["nice", "phoenix", "ontario", "buffalo"]);

const tokensOf = (words: string) => words.split(/[^\p{L}\p{N}'’-]+/u).filter(Boolean);

/** The airport some words name, if any. A lone short word must be in capitals ("MAD"), a lone common word capitalised ("Nice"). */
function codeOf(words: string[]): string | undefined {
  if (!words.length) return undefined;
  if (words.length === 1) {
    const w = words[0];
    if (COMMON.has(w) || (w.length <= 3 && w !== w.toUpperCase() && w.toLowerCase() !== "nyc")) return undefined;
  }
  return resolveAirport(words.join(" "));
}

/** Every airport the words name: a city, a few words of one ("New York"), or a code. */
function placesIn(words: string): Set<string> {
  const t = tokensOf(words);
  const out = new Set<string>();
  for (let i = 0; i < t.length; i++)
    for (let n = 1; n <= 4 && i + n <= t.length; n++) {
      const code = codeOf(t.slice(i, i + n));
      if (code) out.add(code);
    }
  return out;
}

/** The airports the words say the trip starts from. */
function originsIn(words: string): Set<string> {
  const out = new Set<string>();
  for (const m of words.matchAll(FROM_CUE)) {
    const code = codeOf(tokensOf(m[1]).slice(0, 4));
    if (code) out.add(code);
  }
  for (const m of words.matchAll(TO_CUE)) {
    const before = tokensOf(words.slice(0, m.index));
    const after = tokensOf(words.slice(m.index + m[0].length)).slice(0, 4);
    if (!codeOf(after)) continue;
    for (let n = 1; n <= 3 && n <= before.length; n++) {
      const code = codeOf(before.slice(-n));
      if (code) {
        out.add(code);
        break;
      }
    }
  }
  return out;
}

export const originSaid = (words: string) => originsIn(words).size > 0;

/** A destination is said: an open idea, or a place other than the origin. */
export function destinationSaid(words: string): boolean {
  if (OPEN_PLACE.test(words)) return true;
  const from = originsIn(words);
  return [...placesIn(words)].some((c) => !from.has(c));
}

const MONTHS = /\b(?:january|february|march|april|june|july|august|september|october|november|december|jan|feb|apr|jun|jul|aug|sept?|oct|nov|dec)\b|\bin may\b/i;
/** "May" the month has its capital; "may" is a maybe. */
const MAY = /\bMay\b/;
const WHEN =
  /\b(?:spring|summer|autumn|winter|christmas|xmas|easter|thanksgiving|new year|holidays|half[- ]term|spring break|today|tonight|tomorrow|(?:this|next|in the) (?:week|weekend|month|year|fall)|(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)s?|in (?:a|\d+|one|two|three|four|five|six) (?:days?|weeks?|months?))\b|\b\d{1,2}(?:st|nd|rd|th)\b|\b\d{1,2}\/\d{1,2}\b|\b\d{4}-\d{2}-\d{2}\b/i;

/** When is said: a month, a season, a holiday, a day. */
export const whenSaid = (words: string) => MONTHS.test(words) || MAY.test(words) || WHEN.test(words);

const ONE_WAY = /\bone[- ]?way\b/i;
const ROUND_TRIP = /\bround[- ]?trip\b/i;

/** One way (true) or a round trip (false), when the words say which. */
export const oneWayIn = (words: string): boolean | null => (ONE_WAY.test(words) ? true : ROUND_TRIP.test(words) ? false : null);

/**
 * Answers contradicted by later edits to the first words, by question key: a trip type the dates weren't picked for, or a different
 * origin or destination. These are asked again, since a search treats an answer as set.
 */
export function contradicted(words: string, turns: { key: string; a: string }[], picked: { oneWay: boolean }): Set<string> {
  const out = new Set<string>();
  const answered = (key: string) => turns.find((t) => t.key === key)?.a;
  const trip = oneWayIn(words);
  if (answered("dates") && trip != null && trip !== picked.oneWay) out.add("dates");
  const from = originsIn(words);
  const origin = answered("origin");
  // An unknown place still counts when capitalised after "from": "from Milwaukee" is not Chicago.
  const named = [...words.matchAll(FROM_CUE)].map((m) => tokensOf(m[1])[0] ?? "").filter((t) => /^\p{Lu}/u.test(t));
  if (origin && from.size && ![...from].some((c) => metroCodes(c).has(resolveAirport(origin) ?? ""))) out.add("origin");
  if (origin && !from.size && named.length && !named.some((n) => origin.toLowerCase().includes(n.toLowerCase()))) out.add("origin");
  const destination = answered("destination");
  const to = [...placesIn(words)].filter((c) => !from.has(c));
  if (destination && to.length && !to.some((c) => metroCodes(c).has(resolveAirport(destination) ?? ""))) out.add("destination");
  return out;
}
