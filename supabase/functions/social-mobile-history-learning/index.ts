import {
  disabledHistoryLearningDependencies,
  handleHistoryLearningRequest,
} from "./logic.ts";
import { createLiveHistoryDependencies, historyLiveEnabled } from "./live_dependencies.ts";

// Only the exact server-side value "true" enables live dependencies.
// Never read the service-role key, or construct its RPC adapter, while OFF.
Deno.serve((request) => {
  if (!historyLiveEnabled(Deno.env.get("SOCIAL_MOBILE_HISTORY_LIVE_ENABLED"))) {
    return handleHistoryLearningRequest(request, disabledHistoryLearningDependencies());
  }
  const url = Deno.env.get("SUPABASE_URL");
  const publishableKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !publishableKey || !serviceRoleKey) {
    return Response.json({ success: false, error: "HISTORY_CONFIGURATION_UNAVAILABLE" }, { status: 503 });
  }
  return handleHistoryLearningRequest(request, createLiveHistoryDependencies({
    supabaseUrl: url, publishableKey, serviceRoleKey,
  }));
});
