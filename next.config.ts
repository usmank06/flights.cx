import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { NextConfig } from "next";
import { contentSecurityPolicy, SECURITY_HEADERS } from "./lib/abuse/headers";
import { isProductionDeployment, missingForProduction } from "./lib/env";

/**
 * Each API route's methods, read from its exports, for the Allow header. Next answers an unsupported method with a bare 405, which
 * must list the allowed methods. Header rules can't target one status, so Allow goes on every response from the route.
 */
function apiAllow(dir = join(__dirname, "app", "api"), route = "/api"): { source: string; allow: string }[] {
  const out: { source: string; allow: string }[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) out.push(...apiAllow(join(dir, entry.name), `${route}/${entry.name.replace(/^\[(.+)\]$/, ":$1")}`));
    else if (entry.name === "route.ts") {
      const source = readFileSync(join(dir, entry.name), "utf8");
      const methods = new Set([...source.matchAll(/export\s+(?:async\s+)?(?:function|const)\s+(GET|HEAD|POST|PUT|PATCH|DELETE)\b/g)].map((m) => m[1]));
      if (methods.has("GET")) methods.add("HEAD");
      out.push({ source: route, allow: [...methods, "OPTIONS"].sort().join(", ") });
    }
  }
  return out;
}

const dev = process.env.NODE_ENV === "development";

// Fail a production build that lacks required settings, so the previous deployment stays live (lib/env.ts).
if (isProductionDeployment()) {
  const missing = missingForProduction();
  if (missing.length) throw new Error(`Not building production without these settings:\n  - ${missing.join("\n  - ")}\n`);
}

const nextConfig: NextConfig = {
  // Pin the workspace root so Turbopack ignores stray lockfiles outside the repo
  turbopack: {
    root: __dirname,
  },
  devIndicators: false,
  poweredByHeader: false,
  agentRules: false,
  async headers() {
    return [
      { source: "/:path*", headers: SECURITY_HEADERS },
      // CSP for prerendered pages. Search pages and Your trips get a per-request nonce policy from proxy.ts, so they are excluded.
      {
        source: "/((?!s/[^/]+$|account$).*)",
        headers: [
          {
            key: "Content-Security-Policy",
            value: contentSecurityPolicy({ dev, vercelEnv: process.env.VERCEL_ENV, https: Boolean(process.env.VERCEL) }),
          },
        ],
      },
      ...apiAllow().map(({ source, allow }) => ({ source, headers: [{ key: "Allow", value: allow }] })),
    ];
  },
  // /about and /start go to the home page. The query is kept, so /start?from=<slug> reruns that search there.
  // Some clients request /favicon.ico whatever the page links, so send them the PNG home-screen icon.
  async redirects() {
    return [
      { source: "/about", destination: "/", permanent: true },
      { source: "/start", destination: "/", permanent: true },
      { source: "/favicon.ico", destination: "/apple-icon", permanent: true },
    ];
  },
};

export default nextConfig;
