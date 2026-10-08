import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Ownership of searches with no account. The browser that starts one gets a key once, with the slug, and the record stores only its
 * hash. Deleting requires the key. Share links don't carry it, so recipients can read a search but not delete it.
 */
export const OWNER_KEY_HEADER = "x-owner-key";

export const newOwnerKey = (): string => randomBytes(18).toString("base64url");

export const ownerKeyHash = (key: string): string => createHash("sha256").update(key).digest("hex");

/** Compares in constant time, so a key can't be found one character at a time. */
export function keyOpens(key: string | null, hash: string | null | undefined): boolean {
  if (!key || !hash || key.length > 64) return false;
  const a = Buffer.from(ownerKeyHash(key), "utf8");
  const b = Buffer.from(hash, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
