import type { Metadata } from "next";
import { CloudBand } from "@/components/site/cloud-band";
import { SiteHeader } from "@/components/site/header";
import { HowItWorks } from "@/components/site/how-it-works";
import { CONTACT_EMAIL } from "@/lib/site";

export const metadata: Metadata = {
  title: "Privacy",
  description: "What flights.cx keeps, who it shares it with, and how to have it removed.",
  alternates: { canonical: "/privacy" },
};

const UPDATED = "October 7, 2026";

/** Policy sections. Keep every claim in line with what the code does. */
const SECTIONS: { title: string; body: string[] }[] = [
  {
    title: "What you type",
    body: [
      "Your trip, the answers to its questions and anything else you add are kept with the search, so it can run, be searched again and answer your follow-up questions.",
      "A search has a link. Anyone you give it to sees the flights it found and the questions asked about it, but not the words you typed to start it.",
    ],
  },
  {
    title: "Who else sees it",
    body: [
      "Your words go to an AI model provider, which reads them into a trip and writes the short explanations next to the results. The places, dates and number of travelers are searched with flight data providers. Nothing that identifies you is sent with either.",
      "Bot protection is Google reCAPTCHA, which sees your browser and your address under Google’s own privacy policy and terms. Page views are counted without cookies.",
    ],
  },
  {
    title: "Your email",
    body: [
      "You only give it to sign in. It is used to send your sign-in codes and the price alerts you ask for, through an email delivery provider, and for nothing else. No newsletters, and it is never sold or shared.",
      "Every alert has a link that stops it in one click.",
    ],
  },
  {
    title: "Cookies and your browser",
    body: [
      "Signing in sets one cookie that keeps you signed in. There are no advertising or tracking cookies.",
      "The searches you start are listed in your own browser’s storage, so you can find them again without an account. Clearing your browser’s data clears the list.",
    ],
  },
  {
    title: "Keeping it safe",
    body: [
      "Your internet address is used to stop abuse, such as too many searches at once. It is stored only in a scrambled form, and only for as long as the limit lasts.",
      "When something breaks, the error is recorded with the page it happened on and the kind of browser, so it can be fixed.",
    ],
  },
  {
    title: "Removing it",
    body: [
      "Deleting a search in Your trips takes it off your list and stops its link working for everyone. A record that the search happened is kept for counting.",
      "To have your account, your searches and your price alerts erased completely, write to the address below.",
    ],
  },
];

export default function Privacy() {
  return (
    <div className="relative isolate flex min-h-dvh flex-col bg-ground">
      <CloudBand className="h-[240px] sm:h-[300px]" />
      <SiteHeader />
      <HowItWorks />
      <main id="main" className="mx-auto w-full max-w-[680px] flex-1 px-5 pt-28 pb-24 sm:pt-36">
        <h1 className="display text-[36px] leading-[1.05] font-semibold text-ink sm:text-[50px]">Privacy</h1>
        <p className="mt-4 text-[16.5px] leading-relaxed text-pretty text-ink-soft">
          What flights.cx keeps, who else sees it, and how to have it removed. In short: what you type is used to find your flights, your email is used to sign you in and send the alerts you ask for, and nothing is sold.
        </p>
        <div className="slip mt-8 flex flex-col divide-y divide-rule rounded-3xl px-6 sm:mt-10 sm:px-8">
          {SECTIONS.map((s) => (
            <section key={s.title} className="py-6 sm:py-7">
              <h2 className="text-[17px] font-semibold tracking-[-0.01em] text-ink">{s.title}</h2>
              {s.body.map((p) => (
                <p key={p} className="mt-2 text-[15px] leading-relaxed text-pretty text-ink-muted">
                  {p}
                </p>
              ))}
            </section>
          ))}
        </div>
        <p className="mt-8 text-[15px] leading-relaxed text-ink-soft">
          Questions, or a request to erase your data:{" "}
          {CONTACT_EMAIL ? (
            <a href={`mailto:${CONTACT_EMAIL}`} className="font-semibold text-accent-ink underline underline-offset-2">
              {CONTACT_EMAIL}
            </a>
          ) : (
            <span className="font-semibold">the address on the site’s source page</span>
          )}
          .
        </p>
        <p className="mt-2 text-[13.5px] text-ink-muted">Last updated {UPDATED}.</p>
      </main>
    </div>
  );
}
