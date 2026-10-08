import { createHash, timingSafeEqual } from "node:crypto";

/** Constant-time secret comparison. Both sides are hashed first, so their lengths always match. */
export function sameSecret(given: string | null, expected: string): boolean {
  const digest = (s: string) => createHash("sha256").update(s).digest();
  return given != null && timingSafeEqual(digest(given), digest(expected));
}
