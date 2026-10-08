import { after, type NextRequest } from "next/server";
import { notJson } from "@/lib/abuse/json-only";
import { rateLimit, tooMany } from "@/lib/abuse/limit";
import { currentUserId } from "@/lib/auth";
import { ASK_ACTION, callerIp, REFUSED_SAID, TOKEN_HEADER, verifyRecaptcha } from "@/lib/abuse/recaptcha";
import { TODAY_HEADER, travellersDay } from "@/lib/search/intake";
import { answerFollowUp, askFollowUp } from "@/lib/search/run";
import { followUpLiveness, store } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Covers waiting on an in-flight search (capped at 20 s in answerFollowUp), two model passes and a batch of queries. */
export const maxDuration = 180;

/** One follow-up by id, for the page to poll while it is being answered. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const id = req.nextUrl.searchParams.get("id") ?? "";
  if (!id) return Response.json({ error: "Something’s missing from that request." }, { status: 400 });
  const followUp = await (await store()).followUp(slug, id);
  if (!followUp) return Response.json({ error: "That question isn’t here any more." }, { status: 404 });
  // A follow-up cut off mid-answer reads as failed, so the page stops polling it.
  return Response.json({ followUp: followUpLiveness(followUp) }, { headers: { "cache-control": "no-store" } });
}

/** Asks a follow-up. Returns once it is queued; `after()` keeps the invocation alive while it is answered. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const wrongType = notJson(req.headers);
  if (wrongType) return wrongType;
  const limited = await rateLimit("ask", await currentUserId());
  if (!limited.ok) return tooMany(limited);
  // Anyone with a share link can spend money here, so check reCAPTCHA first.
  const verdict = await verifyRecaptcha(req.headers.get(TOKEN_HEADER), ASK_ACTION, callerIp(req.headers));
  if (!verdict.allow) return Response.json({ error: REFUSED_SAID }, { status: 403 });
  const body = await req.json().catch(() => null);
  const question = typeof body?.question === "string" ? body.question.trim().slice(0, 500) : "";
  if (!question) return Response.json({ error: "Ask a question first." }, { status: 400 });

  const followUp = await askFollowUp(slug, question);
  if (!followUp) return Response.json({ error: "That search isn’t here any more." }, { status: 404 });
  if (followUp === "full") return Response.json({ error: "That’s a lot of questions for one search. Start a new one to keep going." }, { status: 429 });
  after(() => answerFollowUp(slug, followUp.id, undefined, { today: travellersDay(req.headers.get(TODAY_HEADER)), source: body?.source === "grid" ? "grid" : undefined }));
  return Response.json({ followUp }, { status: 202 });
}
