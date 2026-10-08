import type { NextRequest } from "next/server";
import { notJson } from "@/lib/abuse/json-only";
import { rateLimit, tooMany } from "@/lib/abuse/limit";
import { currentUserId } from "@/lib/auth";
import { callerIp, INTAKE_ACTION, REFUSED_SAID, TOKEN_HEADER, verifyRecaptcha } from "@/lib/abuse/recaptcha";
import { nextQuestion, type NextTurn } from "@/lib/intake/next";
import { MAX_TURNS } from "@/lib/intake/questions";
import { liveJev } from "@/lib/search/jev";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** One Jev call (a few hundred ms) plus headroom. */
export const maxDuration = 15;

/** Strips control and zero-width characters (keeping line breaks), so a brief made only of them counts as empty. */
const unseen = (s: string) => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f​-‍⁠﻿]/g, "");

/**
 * Picks the next intake question from the brief and the answers so far. Returns a question key or "search".
 * Public and paid, so it is rate limited, behind reCAPTCHA, and clips every field before the model sees it.
 * If refused, the page asks in the default order (components/ask/conversation.tsx).
 */
export async function POST(req: NextRequest) {
  const wrongType = notJson(req.headers);
  if (wrongType) return wrongType;
  const limited = await rateLimit("intake", await currentUserId());
  if (!limited.ok) return tooMany(limited);
  const verdict = await verifyRecaptcha(req.headers.get(TOKEN_HEADER), INTAKE_ACTION, callerIp(req.headers));
  if (!verdict.allow) return Response.json({ error: REFUSED_SAID }, { status: 403 });

  const body = (await req.json().catch(() => null)) as { brief?: unknown; turns?: unknown } | null;
  const brief = typeof body?.brief === "string" ? unseen(body.brief).trim().slice(0, 1_000) : "";
  if (!brief) return Response.json({ error: "Tell me about the trip first." }, { status: 400 });
  const turns: NextTurn[] = (Array.isArray(body?.turns) ? body.turns : [])
    .slice(0, MAX_TURNS)
    .map((t) => t as Record<string, unknown>)
    .filter((t) => typeof t?.key === "string" && typeof t?.q === "string" && typeof t?.a === "string")
    .map((t) => ({ key: String(t.key).slice(0, 32), q: unseen(String(t.q)).slice(0, 200), a: unseen(String(t.a)).slice(0, 500) }));

  const outcome = await nextQuestion({ brief, turns }, process.env.OPENROUTER_API_KEY ? liveJev : null, { timeoutMs: 4_000 });
  if (outcome.failure) console.warn(`[intake] ${outcome.failure.slice(0, 160)} — asked "${outcome.next}" by the plain order`);
  return Response.json({ next: outcome.next, source: outcome.source }, { headers: { "cache-control": "no-store" } });
}
