import { AIRPORTS, AIRPORT_LIST, type Airport, type Region } from "@/lib/airports";
import { countryCode, countryName } from "@/lib/countries";

/**
 * A region or set of countries named by an open destination ("China", "somewhere in Japan", "Southeast Asia"), so the
 * search can stay inside it. `areaOf` returns null for vague hints ("anywhere", "somewhere warm") and for exclusions.
 */
export type Area = { label: string; countries: Set<string>; regions: Set<Region> };

const REGIONS: [RegExp, string, Region[]][] = [
  [/\bsouth\s*east\s+asia\b/, "Southeast Asia", ["asia-se"]],
  [/\beast\s+asia\b|\bthe far east\b/, "East Asia", ["asia-e"]],
  [/\bsouth\s+asia\b/, "South Asia", ["asia-s"]],
  [/\basia\b/, "Asia", ["asia-e", "asia-se", "asia-s"]],
  [/\b(western|west)\s+europe\b/, "Western Europe", ["eu-west"]],
  [/\b(southern|south)\s+europe\b|\bthe mediterranean\b/, "Southern Europe", ["eu-south"]],
  [/\b(eastern|east|central)\s+europe\b/, "Eastern Europe", ["eu-east"]],
  [/\b(northern|north)\s+europe\b|\bscandinavia\b|\bthe nordics\b|\bnordic\b/, "Northern Europe", ["eu-north"]],
  [/\beurope\b/, "Europe", ["eu-west", "eu-south", "eu-north", "eu-east"]],
  [/\bthe middle east\b|\bmiddle east\b/, "the Middle East", ["me"]],
  [/\bafrica\b/, "Africa", ["africa"]],
  [/\bsouth america\b|\blatin america\b/, "South America", ["sa"]],
  [/\bthe caribbean\b|\bcaribbean\b/, "the Caribbean", ["carib"]],
  [/\boceania\b|\bthe south pacific\b/, "Oceania", ["oceania"]],
];

/** Each country's region, from the airports the table has there. */
const REGION_OF = new Map<string, Region>();
for (const a of AIRPORT_LIST) if (!REGION_OF.has(a.country)) REGION_OF.set(a.country, a.region);

export function areaOf(hint: string | null | undefined): Area | null {
  const text = (hint ?? "").toLowerCase().replace(/[^a-z\s'-]/g, " ").replace(/\s+/g, " ").trim();
  if (!text || /\b(except|but|other than|outside|besides|avoid|not in|not to)\b/.test(text)) return null;
  for (const [re, label, regions] of REGIONS) if (re.test(text)) return { label, countries: new Set(), regions: new Set(regions) };
  // Match every country named, longest phrases first so "south korea" doesn't match "korea". "Italy or Spain" yields both.
  const words = text.split(" ");
  const used = new Set<number>();
  const found: string[] = [];
  for (let n = Math.min(4, words.length); n >= 1; n--)
    for (let i = 0; i + n <= words.length; i++) {
      if (words.slice(i, i + n).some((_, j) => used.has(i + j))) continue;
      const phrase = words.slice(i, i + n).join(" ");
      const code = countryCode(phrase) ?? countryCode(phrase.replace(/^the /, ""));
      if (!code || found.includes(code)) continue;
      found.push(code);
      for (let j = i; j < i + n; j++) used.add(j);
    }
  if (!found.length) return null;
  return { label: found.map((c) => countryName(c) ?? c).join(" or "), countries: new Set(found), regions: new Set() };
}

/** Whether a place is inside the area, by its airport when the table has it, else by the country the provider reports. */
export function inArea(area: Area, code: string, country: string | null | undefined): boolean {
  const cc = AIRPORTS[code]?.country ?? countryCode(country);
  if (!cc) return false;
  if (area.countries.has(cc)) return true;
  const region = AIRPORTS[code]?.region ?? REGION_OF.get(cc);
  return !!region && area.regions.has(region);
}

/** The area's main airports, one per city, hubs first. Priced when the provider lists no destinations there. */
export function gatewaysOf(area: Area, max: number): Airport[] {
  const cities = new Set<string>();
  return AIRPORT_LIST.filter((a) => area.countries.has(a.country) || area.regions.has(a.region))
    .sort((a, b) => a.tier - b.tier)
    .filter((a) => !cities.has(`${a.country}~${a.city}`) && cities.add(`${a.country}~${a.city}`))
    .slice(0, max);
}
