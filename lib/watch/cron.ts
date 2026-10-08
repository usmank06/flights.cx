import { createHash, timingSafeEqual } from "node:crypto";

/** Constant-time comparison over equal-length digests. */
export function sameSecret(given: string, expected: string): boolean {
  const digest = (v: string) => createHash("sha256").update(v).digest();
  return timingSafeEqual(digest(given), digest(expected));
}

/**
 * Authorises scheduler calls. Vercel's cron sends `Authorization: Bearer $CRON_SECRET`, and the dispatcher forwards it to each
 * watch's call. Without CRON_SECRET, production refuses, since an open scheduler would let anyone trigger paid searches.
 */
export function cronRefusal(req: Request): Response | null {
  const secret = process.env.CRON_SECRET;
  if (secret) return sameSecret(req.headers.get("authorization") ?? "", `Bearer ${secret}`) ? null : Response.json({ error: "unauthorized" }, { status: 401 });
  if (process.env.NODE_ENV === "production")
    return Response.json({ error: "CRON_SECRET is not set — refusing to run the scheduler unauthenticated" }, { status: 503 });
  return null;
}

/**
 * Dispatcher status: 502 when watches were due, calls failed and none started, so a cron monitor flags the hour. Skipped watches
 * (held by another run, or not due when claimed) are normal on redelivery.
 */
export const dispatchStatus = (r: { due: number; started: number; errors: number }): number => (r.due > 0 && r.started === 0 && r.errors > 0 ? 502 : 200);

/** The site's public production URL, for email links and dispatcher calls. */
export function appUrl(): string {
  const configured = process.env.APP_URL;
  if (configured) return configured.replace(/\/$/, "");
  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (vercel) return `https://${vercel}`;
  return "http://localhost:3000";
}

/**
 * Where the dispatcher sends each watch's call. Vercel's cron hits the deployment's own *.vercel.app address, which deployment
 * protection may block, so production targets the public address and adds the automation bypass header if configured.
 */
export function runTarget(req: Request): { url: URL; headers: Record<string, string> } {
  // Outside production, use the request's own origin so a local dispatch can't start runs on the live site.
  const live = process.env.NODE_ENV === "production" && Boolean(process.env.APP_URL || process.env.VERCEL_PROJECT_PRODUCTION_URL);
  const base = live ? appUrl() : new URL(req.url).origin;
  const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  return { url: new URL("/api/cron/watches/run", base), headers: bypass ? { "x-vercel-protection-bypass": bypass } : {} };
}
