import { timingSafeEqual } from "node:crypto";
import { hmac } from "@/lib/auth/core";
import { appUrl } from "./cron";

/**
 * Signed token for an alert's stop link, so it works without signing in and only for that watch. The `watch-stop:` prefix keeps it
 * apart from codes and sessions.
 */
export const stopToken = (id: string): string => hmac(`watch-stop:${id}`).slice(0, 32);

export function stopTokenValid(id: string, token: string): boolean {
  if (!/^wch_[0-9a-f]{6,40}$/.test(id) || !/^[0-9a-f]{32}$/.test(token)) return false;
  return timingSafeEqual(Buffer.from(stopToken(id)), Buffer.from(token));
}

/**
 * `page` is the stop link in the email body; `oneClick` is the List-Unsubscribe URL mail clients POST to (RFC 8058). A GET of either
 * changes nothing, because mail scanners fetch every link.
 */
export function stopUrls(id: string): { page: string; oneClick: string } {
  const q = `w=${encodeURIComponent(id)}&t=${stopToken(id)}`;
  return { page: `${appUrl()}/account/stop?${q}`, oneClick: `${appUrl()}/api/watch/stop?${q}` };
}
