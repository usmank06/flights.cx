import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

/**
 * Search pages stay fetchable so link previewers that obey robots.txt (X, LinkedIn) can read their card tags. Their noindex tag
 * keeps them out of search results, and crawlers only see it on pages they may fetch.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: ["/api/", "/account"],
      },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
