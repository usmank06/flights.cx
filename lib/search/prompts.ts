/**
 * The system prompt for each model call. In this public version each one is cut down to a single sentence. The app still
 * works, but plans, picks and write-ups come out plainer and less reliable than with fuller prompts, so write your own.
 */

/** Reads the conversation into a trip plan (plan.ts). */
export const PLAN_SYSTEM = `Read everything the traveller said about their trip and fill in the search plan, using single-airport IATA codes, YYYY-MM-DD dates from today onward, and only what they actually said.`;

/** The results page's summary and the line under each option (voice.ts). */
export const VOICE_SYSTEM = `Write one short sentence on the trade-off between these flight options and one short line per option on what sets it apart, using only the facts given and never putting a price on an option's line.`;

/** Answers a follow-up question about a finished search (voice.ts). */
export const ANSWER_SYSTEM = `Answer the traveller's question about their flight results in one or two short sentences using only the rows you're given, and return a search when the answer isn't in them.`;

/** Each round of the open-destination search: which places to price, which to look up (explore-agent.ts). */
export const ROUND_SYSTEM = `Pick the listed places that fit the traveller's brief well enough to price now, and suggest a few unlisted places that would fit better, without writing any prices.`;

/** The open-destination search's final choice of places to show (explore-agent.ts). */
export const FINAL_SYSTEM = `Choose up to six of the priced places that best fit the traveller's brief, best fit first, each with a few words on why it fits and no numbers.`;
