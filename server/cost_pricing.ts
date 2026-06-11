export type ModelPricing = {
  id: string;
  input_cost_per_1k: number;
  output_cost_per_1k: number;
  match: (model: string) => boolean;
};

const DEFAULT_COST_PRICING: ModelPricing[] = [
  // --- Claude 4 family ---
  {
    id: "claude-opus-4",
    input_cost_per_1k: 0.015,
    output_cost_per_1k: 0.075,
    match: (model) => model.includes("claude-opus-4"),
  },
  {
    id: "claude-sonnet-4",
    input_cost_per_1k: 0.003,
    output_cost_per_1k: 0.015,
    // Matches claude-sonnet-4-6, claude-sonnet-4-20250514, etc.
    match: (model) => model.includes("claude-sonnet-4"),
  },
  {
    id: "claude-haiku-4",
    input_cost_per_1k: 0.0008,
    output_cost_per_1k: 0.004,
    // Matches claude-haiku-4-5-20251001, etc.
    match: (model) => model.includes("claude-haiku-4"),
  },
  // --- Claude 3.x family (legacy) ---
  {
    id: "claude-3-opus",
    input_cost_per_1k: 0.015,
    output_cost_per_1k: 0.075,
    match: (model) => model.includes("claude-3-opus"),
  },
  {
    id: "claude-3-5-sonnet",
    input_cost_per_1k: 0.003,
    output_cost_per_1k: 0.015,
    match: (model) =>
      model.includes("claude-3-5-sonnet") || model.includes("claude-3.5-sonnet"),
  },
  {
    id: "claude-3-haiku",
    input_cost_per_1k: 0.00025,
    output_cost_per_1k: 0.00125,
    match: (model) => model.includes("claude-3-haiku") || model.includes("claude-3.haiku"),
  },
  // --- Codex / GPT family ---
  {
    id: "gpt-5.3-codex",
    input_cost_per_1k: 0.015,
    output_cost_per_1k: 0.06,
    // Keep compatibility with historical runs that logged gpt-5.2-codex.
    match: (model) => model.includes("gpt-5.3-codex") || model.includes("gpt-5.2-codex"),
  },
  {
    id: "gpt-4",
    input_cost_per_1k: 0.03,
    output_cost_per_1k: 0.06,
    match: (model) => model.includes("gpt-4"),
  },
];

/**
 * The most expensive known rate — used as a conservative estimate for models
 * whose pricing is not in the table, so that budget enforcement fails closed
 * rather than silently recording $0.
 */
const FALLBACK_PRICING: ModelPricing = {
  id: "unknown-fallback",
  input_cost_per_1k: 0.015,
  output_cost_per_1k: 0.075,
  match: () => true,
};

export function resolveModelPricing(model: string): ModelPricing | null {
  const normalized = model.trim().toLowerCase();
  if (!normalized) return null;
  return DEFAULT_COST_PRICING.find((entry) => entry.match(normalized)) ?? null;
}

/**
 * Like resolveModelPricing but never returns null.
 * Unknown or empty model strings fall back to the most expensive known rate so
 * that budget enforcement fails closed.  A one-line warning is logged so the
 * operator knows to add a proper entry.
 */
export function resolveModelPricingConservative(model: string): ModelPricing {
  const normalized = model.trim().toLowerCase();
  const known = DEFAULT_COST_PRICING.find((entry) => entry.match(normalized));
  if (known) return known;
  // eslint-disable-next-line no-console
  console.warn(
    `[cost_pricing] Unknown model "${model}" — applying conservative fallback rate ($${FALLBACK_PRICING.input_cost_per_1k}/1k in, $${FALLBACK_PRICING.output_cost_per_1k}/1k out). Add a pricing entry for this model.`
  );
  return FALLBACK_PRICING;
}
