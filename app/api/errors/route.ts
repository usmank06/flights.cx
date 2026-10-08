import type { NextRequest } from "next/server";
import { jsonUpTo, notJson } from "@/lib/abuse/json-only";
import { rateLimitEveryone, tooMany } from "@/lib/abuse/limit";
import { reportError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Enough for a message and a stack trace. */
const MAX_BODY_BYTES = 8_192;

const text = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() ? v.slice(0, max) : null);

/** Logs an error reported by the browser (components/site/report-error.ts). Answers 204 whatever the body holds. */
export async function POST(req: NextRequest) {
  const wrongType = notJson(req.headers);
  if (wrongType) return wrongType;
  const limited = await rateLimitEveryone("errors");
  if (!limited.ok) return tooMany(limited);
  const read = await jsonUpTo(req, MAX_BODY_BYTES);
  if (read instanceof Response) return read;
  const body = read.body as Record<string, unknown> | null;
  const message = text(body?.message, 1000);
  if (!message) return new Response(null, { status: 204 });
  const error = Object.assign(new Error(message), { stack: text(body?.stack, 4000) ?? undefined });
  // Collapse search pages to /s/[slug] so the same error across many searches is one row.
  const page = (text(body?.page, 200) ?? "").replace(/^\/s\/[^/]+/, "/s/[slug]");
  await reportError("browser", error, {
    where: `${text(body?.where, 60) ?? "page"} ${page}`.trim(),
    slug: text(body?.page, 200)?.match(/^\/s\/([^/]+)/)?.[1] ?? null,
    detail: { digest: text(body?.digest, 60), agent: req.headers.get("user-agent")?.slice(0, 200) ?? null },
  });
  return new Response(null, { status: 204 });
}
