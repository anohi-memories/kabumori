import { handleSocialMobileBrandDryRun } from "./logic.ts";

Deno.serve((request) =>
  handleSocialMobileBrandDryRun(request, {
    supabaseUrl: Deno.env.get("SUPABASE_URL") ?? "",
    publishableKey: Deno.env.get("SUPABASE_ANON_KEY") ?? "",
    openAiApiKey: Deno.env.get("OPENAI_API_KEY") ?? "",
  })
);
