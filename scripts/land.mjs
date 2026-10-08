/**
 * Fetches Natural Earth 110m land as TopoJSON for the home page scene (components/home/scene.tsx). The `world-atlas` version is
 * pinned so the output is reproducible.
 *   node scripts/land.mjs            # writes public/land-110m.json
 */

import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const SOURCE = "https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/land-110m.json";
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../public/land-110m.json");

const res = await fetch(SOURCE);
if (!res.ok) throw new Error(`${SOURCE}: ${res.status}`);
const topology = await res.json();
if (topology.type !== "Topology" || !topology.objects?.land) throw new Error("not a land topology");

await writeFile(OUT, JSON.stringify(topology));
console.log(`${OUT}: ${topology.arcs.length} arcs`);
