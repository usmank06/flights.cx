import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { SiteHeader } from "./header";
import { CloudBand } from "./cloud-band";
import { HowItWorks } from "./how-it-works";

/** Not-found page with the site chrome. The illustration is a dotted route ending in a question mark. */
export function Missing({ title, body }: { title: string; body: string }) {
  return (
    <div className="relative isolate flex min-h-dvh flex-col bg-ground">
      <CloudBand className="h-[240px] sm:h-[300px]" />
      <SiteHeader />
      <HowItWorks />
      <main className="mx-auto flex w-full max-w-[640px] flex-1 flex-col items-center justify-center px-5 py-10 text-center sm:py-16">
        <svg viewBox="0 0 240 60" aria-hidden className="h-auto w-[180px] overflow-visible sm:w-[220px]">
          <circle cx="20" cy="30" r="9" fill="var(--color-ground)" stroke="var(--color-ink-faint)" strokeWidth="3.5" />
          <path d="M40 30H188" stroke="var(--color-rule-strong)" strokeWidth="3.5" strokeLinecap="round" strokeDasharray="0.1 11" />
          <circle cx="216" cy="30" r="26" fill="var(--color-accent)" opacity="0.14" />
          <circle cx="216" cy="30" r="17" fill="var(--color-accent)" />
          <text x="216" y="37" textAnchor="middle" fontSize="20" fontWeight="700" fill="#fff" style={{ fontFamily: "var(--font-sans)" }}>
            ?
          </text>
        </svg>
        <h1 className="display mt-7 sm:mt-9 text-[36px] leading-[1.02] font-semibold text-balance text-ink sm:text-[54px]">{title}</h1>
        <p className="mt-4 max-w-[30rem] text-[16.5px] leading-relaxed text-balance text-ink-muted">{body}</p>
        <Link href="/" className="btn-primary press mt-8 inline-flex h-12 items-center justify-center gap-2 rounded-full px-6 text-[15px] font-semibold max-sm:w-full max-sm:max-w-[17rem]">
          Start a search
          <ArrowRight className="h-4 w-4" strokeWidth={2.4} />
        </Link>
      </main>
    </div>
  );
}
