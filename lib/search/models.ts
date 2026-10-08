/** Model roster, all served through OpenRouter. Keep this file free of server imports so the UI can import the labels. */

export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "none";

export type ProviderRouting = {
  /** Rank eligible providers per request. Preferred over a hardcoded `order`, which goes stale silently. */
  sort?: "throughput" | "latency" | "price";
  /** Preferred provider slugs, tried first. Omit unless there is a reason. */
  order?: string[];
  /** false pins routing to `order`; true lets OpenRouter route past it. */
  allow_fallbacks?: boolean;
  quantizations?: string[];
  /** Restrict routing to providers supporting every parameter sent. */
  require_parameters?: boolean;
};

export type ModelOption = {
  key: string;
  label: string;
  id: string;
  reasoning?: ReasoningEffort;
  provider?: ProviderRouting;
  /** Per-model output cap; omit for DEFAULT_MAX_OUTPUT_TOKENS. */
  maxOutputTokens?: number;
  /** false when the model's endpoints reject `temperature`. With `require_parameters`, sending it would match no endpoint. */
  acceptsTemperature?: boolean;
  /** The effort the planner asks this model for; unset is "low". */
  plannerEffort?: ReasoningEffort;
  note?: string;
};

const MODELS: ModelOption[] = [
  {
    key: "glm-5.3-flash",
    label: "GLM 5.3 Flash · fp8",
    id: "z-ai/glm-5.3-flash",
    reasoning: "high",
    provider: {
      sort: "throughput",
      allow_fallbacks: true,
      quantizations: ["fp8"],
      // Otherwise a fallback can hit an endpoint that ignores response_format and answers a structured call in prose.
      require_parameters: true,
    },
    maxOutputTokens: 128_000,
    note: "agentic loop (decision 004); ~2–3¢/search",
  },
  // No quantizations filter: GLM's fp8 filter matches none of these endpoints. Reasoning stays at "high" because "xhigh" uses up
  // the output budget before the JSON closes.
  {
    key: "deepseek-v4.1-flash",
    label: "DeepSeek V4.1 Flash",
    id: "deepseek/deepseek-v4.1-flash",
    reasoning: "high",
    provider: { sort: "throughput", allow_fallbacks: true, require_parameters: true },
    maxOutputTokens: 128_000,
    note: "evaluated 2026-09-18, not adopted — lost to GLM on price, speed and 5x the cost",
  },
  {
    key: "luna-pro",
    label: "GPT-5.6 Luna Pro",
    id: "openai/gpt-5.6-luna-pro",
    reasoning: "high",
    acceptsTemperature: false,
    // First-party OpenAI/Azure endpoints, so there is no quantization filter to apply.
    provider: { sort: "throughput", allow_fallbacks: true, require_parameters: true },
    maxOutputTokens: 128_000,
    note: "evaluating; best prose of the roster, worst search — see the split-brain note",
  },
  // Meta accepts only tool_choice "auto". `require_parameters` checks that a parameter is supported, not its value.
  {
    key: "muse-spark-1.3",
    label: "Muse Spark 1.3",
    id: "meta/muse-spark-1.3",
    reasoning: "high",
    provider: { sort: "throughput", allow_fallbacks: true, require_parameters: true },
    maxOutputTokens: 128_000,
    note: "unusable — Meta rejects tool_choice:required, so the agent loop cannot run",
  },
];

const DEFAULT_MODEL_KEY = "glm-5.3-flash";

export function resolveModel(key: string | undefined): ModelOption {
  return MODELS.find((m) => m.key === key) ?? MODELS.find((m) => m.key === DEFAULT_MODEL_KEY)!;
}
