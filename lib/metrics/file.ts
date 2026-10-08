import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { rollUp, type MetricsStore } from "./index";
import type { MetricEvent } from "./types";

/**
 * Metrics as JSON lines in .data/metrics.jsonl, for local development. Single-line appends need no lock, and rollups are computed at
 * read time since the file stays small.
 */
const DIR = join(process.cwd(), ".data");
const PATH = join(DIR, "metrics.jsonl");

export function fileMetrics(): MetricsStore {
  return {
    kind: "file",

    async record(event) {
      await mkdir(DIR, { recursive: true });
      await appendFile(PATH, JSON.stringify(event) + "\n", "utf8");
    },

    async rollups(fromDay, toDay) {
      const events = (await readAll()).filter((e) => {
        const d = e.at.slice(0, 10);
        return d >= fromDay && d <= toDay;
      });
      return rollUp(events);
    },

    async recent(limit, type) {
      const all = await readAll();
      return all
        .filter((e) => !type || e.type === type)
        .sort((a, b) => b.at.localeCompare(a.at))
        .slice(0, limit);
    },

    async allTime() {
      return rollUp(await readAll()).reduce(
        (t, r) => ({ searches: t.searches + r.searches, flights: t.flights + r.sumItineraries, savedUsd: t.savedUsd + r.sumSavedUsd }),
        { searches: 0, flights: 0, savedUsd: 0 }
      );
    },
  };
}

async function readAll(): Promise<MetricEvent[]> {
  let text: string;
  try {
    text = await readFile(PATH, "utf8");
  } catch {
    return []; // no file yet
  }
  const out: MetricEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as MetricEvent);
    } catch {
      // Skip a last line truncated by a crash.
    }
  }
  return out;
}
