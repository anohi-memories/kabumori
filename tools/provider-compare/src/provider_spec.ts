import type { EstimateSpec } from "./estimate.ts";
import { MODEL_PRICES } from "./pricing.ts";

// "<provider>:<model>[@effort=low|medium|high][,thinking=off]" e.g. anthropic:claude-haiku-5-5@effort=low,thinking=off

export type ProviderSpec = {
  provider: "openai" | "anthropic";
  model: string;
  effort?: "low" | "medium" | "high";
  thinking?: "default" | "off";
};

export class SpecError extends Error {
  constructor(message: string) {
    super(`PROVIDER_SPEC_INVALID:${message}`);
    this.name = "SpecError";
  }
}

export function parseProviderSpec(text: string): ProviderSpec {
  const [head, settings = ""] = text.split("@");
  const [provider, model] = head.split(":");
  if ((provider !== "openai" && provider !== "anthropic") || !model) throw new SpecError(text);
  const price = MODEL_PRICES[model];
  if (!price || price.provider !== provider) throw new SpecError(`unknown ${provider} model ${model}`);
  const spec: ProviderSpec = { provider, model };
  for (const part of settings.split(",").filter(Boolean)) {
    const [key, value] = part.split("=");
    if (key === "effort" && (value === "low" || value === "medium" || value === "high")) spec.effort = value;
    else if (key === "thinking" && (value === "off" || value === "default")) spec.thinking = value;
    else throw new SpecError(`bad setting ${part}`);
  }
  if (spec.provider === "openai" && (spec.thinking !== undefined)) throw new SpecError("thinking applies to Claude only");
  return spec;
}

export function estimateSpecOf(spec: ProviderSpec, tokenizerFactor = 1): EstimateSpec {
  return {
    model: spec.model,
    ...(spec.effort ? { effort: spec.effort } : {}),
    ...(spec.thinking ? { thinking: spec.thinking } : {}),
    tokenizerFactor: spec.provider === "anthropic" ? tokenizerFactor : 1,
  };
}
