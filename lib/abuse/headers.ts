import { PROVIDER_IMAGE_ORIGINS } from "../flights/provider-config";

/**
 * The headers every response carries, and the Content-Security-Policy for pages. A page rendered per request (a search, Your
 * trips) gets a fresh nonce from proxy.ts and runs no inline script without it. A page prerendered at build (the home page, the
 * 404) can't carry a nonce, so its policy allows the inline scripts Next writes into it. next.config.ts imports this too, so it
 * only imports dependency-free files, by relative path.
 */

/** reCAPTCHA's script, and the frames its badge and checks run in. */
const RECAPTCHA_SCRIPTS = ["https://www.google.com/recaptcha/", "https://www.gstatic.com/recaptcha/"];
const RECAPTCHA_FRAMES = ["https://www.google.com/recaptcha/", "https://recaptcha.google.com/recaptcha/"];

/** Where the page's images come from: the flight provider's airline logos and place photos, and flags. */
const IMAGES = [...PROVIDER_IMAGE_ORIGINS, "https://flagcdn.com"];

/** Vercel's toolbar on a preview deployment: a script, frames and a socket of its own. */
const PREVIEW_TOOLBAR = ["https://vercel.live"];

type PolicyOptions = {
  /** A per-request nonce; without one, inline scripts are allowed (a prerendered page). */
  nonce?: string;
  /** `next dev`: React rebuilds server errors with eval, the analytics script is its debug build, and the reload socket is a WebSocket. */
  dev?: boolean;
  /** VERCEL_ENV: a preview deployment shows Vercel's toolbar. */
  vercelEnv?: string;
  /** Served over HTTPS (on Vercel): anything still asked for over http is upgraded. */
  https?: boolean;
};

export function contentSecurityPolicy({ nonce, dev = false, vercelEnv, https = false }: PolicyOptions = {}): string {
  const preview = vercelEnv === "preview" ? PREVIEW_TOOLBAR : [];
  const directives: [string, string[]][] = [
    ["default-src", ["'self'"]],
    [
      "script-src",
      ["'self'", nonce ? `'nonce-${nonce}'` : "'unsafe-inline'", ...RECAPTCHA_SCRIPTS, ...(dev ? ["'unsafe-eval'", "https://va.vercel-scripts.com"] : []), ...preview],
    ],
    // Next writes some styles inline and the page relies on style attributes, so styles stay open. The policy targets scripts.
    ["style-src", ["'self'", "'unsafe-inline'", ...preview]],
    ["img-src", ["'self'", "data:", "blob:", ...IMAGES, ...preview]],
    ["font-src", ["'self'", "data:", ...preview]],
    ["connect-src", ["'self'", ...RECAPTCHA_SCRIPTS, ...(dev ? ["ws:", "https://va.vercel-scripts.com"] : []), ...(preview.length ? [...preview, "wss://ws-us3.pusher.com"] : [])]],
    ["frame-src", [...RECAPTCHA_FRAMES, ...preview]],
    ["object-src", ["'none'"]],
    ["base-uri", ["'self'"]],
    ["form-action", ["'self'"]],
    // Nobody frames this site: a framed page could be clicked into a search or a follow-up that spends money.
    ["frame-ancestors", ["'none'"]],
  ];
  const parts = directives.map(([name, values]) => `${name} ${values.join(" ")}`);
  if (https) parts.push("upgrade-insecure-requests");
  return parts.join("; ");
}

/** The rest, on every response. */
export const SECURITY_HEADERS: { key: string; value: string }[] = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Nothing here uses a camera, a microphone, the location or a payment sheet; sharing (navigator.share) stays allowed.
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()" },
];
