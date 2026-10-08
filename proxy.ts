import { NextResponse, type NextRequest } from "next/server";
import { contentSecurityPolicy } from "@/lib/abuse/headers";
import { isSlug } from "@/lib/slug";
import { MISSING_SEARCH_HEADER, store } from "@/lib/store";

/**
 * Runs in front of the per-request pages (search pages and Your trips):
 * - Sets a CSP with a fresh nonce, which Next applies to its own scripts so no other inline script runs. Prerendered pages
 *   get next.config.ts's policy instead.
 * - Answers 404 with a full page for a missing search. A `notFound()` thrown during render reaches the browser only as an
 *   empty script-drawn shell, so the check happens here and the page renders the 404 itself.
 */
export async function proxy(req: NextRequest) {
  const nonce = btoa(crypto.randomUUID());
  const csp = contentSecurityPolicy({ nonce, dev: process.env.NODE_ENV === "development", vercelEnv: process.env.VERCEL_ENV, https: Boolean(process.env.VERCEL) });
  const headers = new Headers(req.headers);
  headers.set("content-security-policy", csp);
  headers.delete(MISSING_SEARCH_HEADER);

  let missing = false;
  const at = req.nextUrl.pathname.match(/^\/s\/([^/]+)$/);
  if (at) {
    let slug = at[1];
    try {
      slug = decodeURIComponent(slug);
    } catch {
      /* not a slug either way */
    }
    // Slugs are lower case; a link pasted in capitals is the same search.
    const lower = slug.toLowerCase();
    if (lower !== slug && isSlug(lower)) {
      const url = req.nextUrl.clone();
      url.pathname = `/s/${lower}`;
      return NextResponse.redirect(url, 308);
    }
    // Full page loads only. Client navigations and prefetches handle notFound() in the browser, and a prefetch answered 404 never
    // settles. Next strips `rsc` and `next-router-prefetch` first, so detect them by `sec-fetch-dest: empty` and `next-url`.
    const appFetch = req.headers.get("sec-fetch-dest") === "empty" || req.headers.has("next-url") || req.headers.has("rsc");
    if (!appFetch) {
      // If the store lookup fails, let the page load and check the record itself.
      missing = !isSlug(slug) || !(await (await store()).has(slug).catch(() => true));
      if (missing) headers.set(MISSING_SEARCH_HEADER, "1");
    }
  }

  const res = missing ? NextResponse.rewrite(req.nextUrl, { status: 404, request: { headers } }) : NextResponse.next({ request: { headers } });
  res.headers.set("content-security-policy", csp);
  return res;
}

// Keep in sync with the CSP rule's `source` pattern in next.config.ts.
export const config = { matcher: ["/s/:slug", "/account"] };
