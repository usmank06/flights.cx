/**
 * The site's base URL, for absolute URLs in link previews, robots.txt and the sitemap. Some pages render once at build time, so a
 * production build without APP_URL or Vercel's URL falls back to the public domain instead of localhost.
 */
export const SITE_URL =
  process.env.APP_URL?.replace(/\/$/, "") ||
  (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "") ||
  (process.env.NODE_ENV === "production" ? "https://flights.cx" : `http://localhost:${process.env.PORT || 3000}`);

/** Where privacy questions and requests to erase data go (app/privacy). Required in production (lib/env.ts). */
export const CONTACT_EMAIL = process.env.NEXT_PUBLIC_CONTACT_EMAIL?.trim() || null;
