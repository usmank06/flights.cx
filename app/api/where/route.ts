import type { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The visitor's country from Vercel's IP geolocation header, used for the default currency. Null when not on Vercel. */
export async function GET(req: NextRequest) {
  const raw = req.headers.get("x-vercel-ip-country");
  const country = raw && /^[A-Za-z]{2}$/.test(raw) ? raw.toUpperCase() : null;
  return Response.json({ country }, { headers: { "cache-control": "private, no-store" } });
}
