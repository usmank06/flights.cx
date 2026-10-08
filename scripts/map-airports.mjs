/**
 * Builds the home page map's airport list from OurAirports (public domain): large airports with an IATA code and scheduled
 * service, as [code, city, lat, lon] to two decimals. The scene prefers lib/airports.ts's city and tier where it has the code.
 *   node scripts/map-airports.mjs [airports.csv]     # writes public/airports-map.json; with no path it downloads the current file
 */

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const SOURCE = "https://davidmegginson.github.io/ourairports-data/airports.csv";
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../public/airports-map.json");

const text = process.argv[2] ? await readFile(process.argv[2], "utf8") : await (await fetch(SOURCE)).text();

/** Minimal RFC 4180 line parser: quoted fields with doubled quotes and commas, but no embedded newlines. */
function parse(line) {
  const out = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

const lines = text.split(/\r?\n/).filter(Boolean);
const head = parse(lines[0]);
const col = (name) => {
  const i = head.indexOf(name);
  if (i < 0) throw new Error(`no ${name} column`);
  return i;
};
const [TYPE, NAME, LAT, LON, CITY, SCHED, IATA] = ["type", "name", "latitude_deg", "longitude_deg", "municipality", "scheduled_service", "iata_code"].map(col);

const city = (municipality, name) => {
  const m = (municipality || name).replace(/\s*\(.*?\)\s*/g, " ").split(/[,/]/)[0].trim();
  return m || name;
};

const airports = [];
for (const line of lines.slice(1)) {
  const f = parse(line);
  if (f[TYPE] !== "large_airport" || f[SCHED] !== "yes" || !/^[A-Z]{3}$/.test(f[IATA])) continue;
  const lat = Number(f[LAT]);
  const lon = Number(f[LON]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
  airports.push([f[IATA], city(f[CITY], f[NAME]), Math.round(lat * 100) / 100, Math.round(lon * 100) / 100]);
}
airports.sort((a, b) => a[0].localeCompare(b[0]));

await writeFile(OUT, JSON.stringify(airports));
console.log(`${OUT}: ${airports.length} airports`);
