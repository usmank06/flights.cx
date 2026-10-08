import { randomUUID } from "node:crypto";

/** Search slugs: ten characters in two groups of five. Knowing the slug is the only access check on a share link. */

const SLUG_ALPHABET = "abcdefghijkmnopqrstuvwxyz23456789"; // no l, 0 or 1, so slugs can be read aloud
const SLUG = /^[a-km-z2-9]{5}-[a-km-z2-9]{5}$/;

export function newSlug(): string {
  const bytes = randomUUID().replace(/-/g, "");
  let out = "";
  for (let i = 0; i < 10; i++) out += SLUG_ALPHABET[parseInt(bytes.slice(i * 2, i * 2 + 2), 16) % SLUG_ALPHABET.length];
  return `${out.slice(0, 5)}-${out.slice(5)}`;
}

/** Whether a string is a valid slug. The file store builds paths from slugs, so this also blocks "../". */
export const isSlug = (s: unknown): s is string => typeof s === "string" && SLUG.test(s);
