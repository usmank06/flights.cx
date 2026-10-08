import type { Metadata, Viewport } from "next";
import { Comfortaa, Nunito } from "next/font/google";
import Script from "next/script";
import { Analytics } from "@vercel/analytics/next";
import { preconnect } from "react-dom";
import { AccountProvider } from "@/components/auth/account";
import { ErrorListener } from "@/components/site/error-listener";
import { GitHubButton } from "@/components/site/github-button";
import { SkipLink } from "@/components/site/skip-link";
import { ThemeColor } from "@/components/site/theme-color";
import { LOGO_ORIGIN } from "@/lib/flights/provider-config";
import { SITE_URL } from "@/lib/site";
import "./globals.css";
import { recaptchaOffLocally } from "@/lib/abuse/recaptcha";

/** Nunito for body text and numbers, Comfortaa for titles (see globals.css). Both are single variable font files. */
const nunito = Nunito({ subsets: ["latin"], variable: "--font-nunito", display: "swap" });
const comfortaa = Comfortaa({ subsets: ["latin"], variable: "--font-comfortaa", display: "swap" });

/**
 * reCAPTCHA v3 loads only with a site key, and only in production where the domain is registered (lib/abuse/recaptcha.ts).
 * With no key the endpoints skip verification, so demo mode works unconfigured. NEXT_PUBLIC_ is inlined at build time, so
 * changing the key needs a rebuild. Tokens are minted at submit because they expire after two minutes. On phones the badge
 * is hidden with `visibility` (tokens still mint) and the required reCAPTCHA attribution is shown in the page (globals.css).
 */
const recaptchaSiteKey = recaptchaOffLocally() ? undefined : process.env.NEXT_PUBLIC_RECAPTCHA_SITE_KEY;

const SITE_DESCRIPTION =
  "Tell it the trip in your own words. It asks only what it still needs, checks the dates and airports around yours, " +
  "and comes back in about a minute with the best few ways to fly, each with its reason.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  // `template` lets a result page title itself with its route and keep the brand.
  title: { default: "flights.cx — where to next?", template: "%s · flights.cx" },
  description: SITE_DESCRIPTION,
  applicationName: "flights.cx",
  // "./" makes each page its own canonical URL. The 404 pages override this with none.
  alternates: { canonical: "./" },
  appleWebApp: { title: "flights.cx", statusBarStyle: "default" },
  openGraph: {
    title: "flights.cx — where to next?",
    description: SITE_DESCRIPTION,
    siteName: "flights.cx",
    type: "website",
    url: "/",
  },
  twitter: { card: "summary_large_image", title: "flights.cx — where to next?", description: SITE_DESCRIPTION },
};

export const viewport: Viewport = {
  // The sky band's colour. The home page's first screen switches to white (components/site/theme-color.tsx).
  themeColor: "#c2d9fb",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  // Android's keyboard resizes the layout, so bottom-fixed bars stay above it.
  interactiveWidget: "resizes-content",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // Preconnect to the airline logo host before the first card needs it. React sends preconnect() as a Link header on
  // dynamic pages; the <link> covers browsers that only read the HTML.
  if (LOGO_ORIGIN) preconnect(LOGO_ORIGIN);
  return (
    <html lang="en" className={`${nunito.variable} ${comfortaa.variable} h-full`}>
      <head>{LOGO_ORIGIN && <link rel="preconnect" href={LOGO_ORIGIN} />}</head>
      <body className="min-h-full antialiased">
        <SkipLink />
        <ThemeColor />
        <ErrorListener />
        {/* Signed-in state as client context, since sign-in happens inline and a server-read value would go stale. */}
        <AccountProvider>{children}</AccountProvider>
        {/* A footer so the source link sits in a landmark like the rest of the page. */}
        <footer>
          <GitHubButton />
        </footer>
        {/* Vercel page-view analytics. Needs enabling on the project; sends nothing from a dev server. */}
        <Analytics />
        {recaptchaSiteKey ? (
          <Script
            src={`https://www.google.com/recaptcha/api.js?render=${recaptchaSiteKey}`}
            strategy="afterInteractive"
          />
        ) : null}
      </body>
    </html>
  );
}
