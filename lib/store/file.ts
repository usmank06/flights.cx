import { access, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isSlug } from "@/lib/slug";
import type { SearchRecord, SearchSummary } from "@/lib/types";
import { isDeleted, publicRecord, summarise, type Store } from "./index";

/** One JSON file per search under .data/searches/. Survives restarts but suits one instance only; use DATABASE_URL for more. */
const DIR = join(process.cwd(), ".data", "searches");

/** Per-slug write lock, so two follow-ups cannot interleave a read-modify-write. */
const locks = new Map<string, Promise<unknown>>();

function withLock<T>(slug: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(slug) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(
    slug,
    next.catch(() => {})
  );
  return next;
}

/** A record's file path. Slugs come from requests, so anything not shaped like one is refused to block path traversal. */
const path = (slug: string) => {
  if (!isSlug(slug)) throw new Error(`not a slug: ${JSON.stringify(slug).slice(0, 40)}`);
  return join(DIR, `${slug}.json`);
};

async function readRecord(slug: string): Promise<SearchRecord | null> {
  try {
    return JSON.parse(await readFile(path(slug), "utf8")) as SearchRecord;
  } catch {
    return null;
  }
}

/** Reads a record, treating a deleted one as missing. */
async function readLive(slug: string): Promise<SearchRecord | null> {
  const r = await readRecord(slug);
  return r && !isDeleted(r) ? r : null;
}

/** Writes via a temp file and rename, so a half-written record is never read. */
async function writeRecord(record: SearchRecord): Promise<void> {
  await mkdir(DIR, { recursive: true });
  const tmp = `${path(record.slug)}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(record), "utf8");
  await rename(tmp, path(record.slug));
}

export function fileStore(): Store {
  return {
    kind: "file",
    async create(record) {
      await withLock(record.slug, () => writeRecord(record));
    },
    get: readLive,
    async has(slug) {
      if (!isSlug(slug)) return false;
      const there = await access(path(slug)).then(
        () => true,
        () => false
      );
      return there && (await readLive(slug)) != null;
    },
    async getPublic(slug) {
      const r = await readLive(slug);
      return r ? publicRecord(r) : null;
    },
    async followUp(slug, id) {
      const r = await readLive(slug);
      return r?.followUps.find((f) => f.id === id) ?? null;
    },
    async update(slug, mutate) {
      return withLock(slug, async () => {
        const current = await readRecord(slug);
        if (!current) return null;
        const next = mutate(current);
        await writeRecord(next);
        return next;
      });
    },
    /** Scans every file, which is fine for local development. */
    async forUser(userId, limit) {
      const out: SearchSummary[] = [];
      for (const slug of await allSlugs()) {
        const r = await readLive(slug);
        if (r?.userId === userId) out.push(summarise(r));
      }
      return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
    },
    async summaries(slugs) {
      const out: SearchSummary[] = [];
      for (const slug of slugs.slice(0, 200)) {
        const r = await readLive(slug);
        if (r) out.push(summarise(r));
      }
      return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
  };
}

async function allSlugs(): Promise<string[]> {
  try {
    return (await readdir(DIR)).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""));
  } catch {
    return [];
  }
}
