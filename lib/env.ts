import { PROVIDER_REQUIREMENTS } from "./flights/provider-config";

/**
 * Settings a production deployment can't run without. Each has a fallback that's fine locally and wrong in production: no flight
 * provider means invented fares, no AUTH_SECRET means a different secret per instance, no reCAPTCHA keys means no bot check. A
 * production build on Vercel fails without them (next.config.ts), so the previous deployment stays live. A local `next build` is
 * never refused. next.config.ts imports this, so it only imports dependency-free files, by relative path.
 */
const REQUIRED: { names: string[]; why: string }[] = [
  { names: ["OPENROUTER_API_KEY"], why: "the planner reads every trip; without it no search starts" },
  { names: ["DATABASE_URL"], why: "searches, accounts, watches and the rate limits live there" },
  { names: ["AUTH_SECRET"], why: "without it each instance signs with its own secret, so sign-in and unsubscribe links fail at random" },
  { names: ["CRON_SECRET"], why: "the hourly price checks and the error email refuse to run without it" },
  { names: ["RESEND_API_KEY", "EMAIL_WEBHOOK_URL"], why: "nobody can sign in without a way to send the code (either one)" },
  { names: ["EMAIL_FROM"], why: "without it mail goes from the provider's shared sender, which delivers to nobody but the account's owner" },
  { names: ["NEXT_PUBLIC_RECAPTCHA_SITE_KEY"], why: "without both reCAPTCHA keys the bot check is off" },
  { names: ["RECAPTCHA_SECRET_KEY"], why: "without both reCAPTCHA keys the bot check is off" },
  { names: ["NEXT_PUBLIC_CONTACT_EMAIL"], why: "the privacy page gives it as the address for questions and requests to erase data" },
];

/** True on the deployment travellers use: Vercel's production environment. Previews and local production builds are not. */
export const isProductionDeployment = (env: NodeJS.ProcessEnv = process.env): boolean => env.VERCEL_ENV === "production";

/** Each missing setting with what goes wrong without it; empty when everything is there. */
export function missingForProduction(env: NodeJS.ProcessEnv = process.env): string[] {
  const set = (name: string) => Boolean(env[name]?.trim());
  // FLIGHTS_BACKEND=demo runs the demo market, so the live provider's settings aren't needed.
  const required = env.FLIGHTS_BACKEND === "demo" ? REQUIRED : [...PROVIDER_REQUIREMENTS, ...REQUIRED];
  const missing = required.filter(({ names }) => !names.some(set)).map(({ names, why }) => `${names.join(" or ")}: ${why}`);
  if (set("AUTH_SECRET") && env.AUTH_SECRET!.trim().length < 16) missing.push("AUTH_SECRET: under 16 characters (openssl rand -hex 32)");
  if (env.FLIGHTS_STORE === "file") missing.push("FLIGHTS_STORE=file: production would write to files Vercel does not keep");
  return missing;
}
