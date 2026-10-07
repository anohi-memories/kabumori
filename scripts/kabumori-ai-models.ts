// Developer inventory of the Kabumori AI model assignments (shared market-report pipeline only).
//
//   deno run --no-config --no-prompt scripts/kabumori-ai-models.ts            # human-readable
//   deno run --no-config --no-prompt scripts/kabumori-ai-models.ts --json     # machine-readable
//   npm run kabumori-ai-models
//
// Pure: reads only the source-controlled registry (supabase/functions/_shared/kabumori_ai_models.ts). It makes no
// network call, reads no environment variable and needs no permission, so it cannot reach OpenAI or production.
import {
  describeKabumoriAiModels,
  KABUMORI_AI_CONFIG_VERSION,
  KABUMORI_AI_MODELS,
  MODEL_PRICING,
} from "../supabase/functions/_shared/kabumori_ai_models.ts";

const args = typeof Deno !== "undefined" ? Deno.args : process.argv.slice(2);

if (args.includes("--json")) {
  console.log(JSON.stringify({ config_version: KABUMORI_AI_CONFIG_VERSION, roles: KABUMORI_AI_MODELS, pricing: MODEL_PRICING }, null, 2));
} else {
  console.log(describeKabumoriAiModels());
}
