/**
 * Client for Jev (TypeSafe) on OpenRouter's decisions endpoint: a state and typed questions in, probabilities out.
 * The chat-completions endpoint rejects this model.
 */
const URL = "https://openrouter.ai/api/alpha/decisions";
export const JEV_MODEL = "typesafe/jev-1.13";

export type NoulQuestion = { type: "noul"; instructions: string; criteria?: { true: string; false: string } };
export type ChoiceQuestion = { type: "choice"; instructions: string; criteria: Record<string, string> };
export type ScoreQuestion = { type: "score"; instructions: string; criteria: string[] };
export type JevQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export type NoulAnswer = { type: "noul"; noul: number };
export type ChoiceAnswer = { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number };
export type ScoreAnswer = { type: "score"; score: number; probabilities: Record<string, number>; confidence: number; legend?: Record<string, string> };
export type JevAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export type JevResult = {
  answers: Record<string, JevAnswer>;
  usage: { in: number; out: number; costUsd: number | null };
  ms: number;
};

export type JevClient = (state: unknown, questions: Record<string, JevQuestion>, opts: { signal?: AbortSignal; timeoutMs?: number }) => Promise<JevResult>;

/** Throws on any failure. The picking stage catches it and falls back to code. */
export const liveJev: JevClient = async (state, questions, opts) => {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY is not set");
  const t0 = Date.now();
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 5_000);
  const res = await fetch(URL, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ model: JEV_MODEL, state, questions }),
    signal: opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout,
  });
  if (!res.ok) throw new Error(`Jev HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  const data = (await res.json()) as { answers?: Record<string, JevAnswer>; usage?: { input_tokens?: number; output_tokens?: number; cost?: number } };
  if (!data.answers || typeof data.answers !== "object") throw new Error("Jev returned no answers");
  return {
    answers: data.answers,
    usage: { in: data.usage?.input_tokens ?? 0, out: data.usage?.output_tokens ?? 0, costUsd: typeof data.usage?.cost === "number" ? data.usage.cost : null },
    ms: Date.now() - t0,
  };
};
