// news-discovery-observer — observation-only Edge Function (N3).
//
// F8: every request (after authentication) and every outward call re-checks important_news_monitor_settings.is_active;
// see pause_gate.ts. Historical note below (the "NOT deployed / NOT scheduled" wording predates the production use).
// NOT deployed, NOT scheduled (no Cron), NOT connected to important-news-monitor, shadow, Fact,
// Voice, app copy, Push or X. Layer 3 Web Search runs only when a request sets search.enabled and
// OPENAI_API_KEY is present, and only within the DB-enforced daily budget. Requires migration
// 20260929090000_news_discovery_observer.sql (not applied to production) and the secret
// NEWS_DISCOVERY_OBSERVER_SECRET (not created); without the secret every call is refused (503).
// Design: docs/news-sources/n3_observer_db_function.md
import { postgrestRpcClient } from "../_shared/news_discovery/supabase_store.ts";
import { enforceNewsPauseEntry, installNewsPauseGuard } from "./pause_gate.ts";
import { OpenAiWebSearchProvider } from "../_shared/news_discovery/web_search.ts";
import { OBSERVER_SECRET_ENV } from "./observer_auth.ts";
import { createObserverHandler } from "./observer_handler.ts";
import { loadListedStocks } from "./stocks_master_reader.ts";

// F8 hard pause: install the egress guard BEFORE anything below captures `fetch` (postgrestRpcClient resolves it when it is
// constructed, the web-search provider as a constructor default). Order matters; the static test pins it.
installNewsPauseGuard();

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const openAiKey = Deno.env.get("OPENAI_API_KEY");

Deno.serve(createObserverHandler({
  observerSecret: Deno.env.get(OBSERVER_SECRET_ENV),
  rpc: postgrestRpcClient(supabaseUrl, serviceRoleKey),
  loadStocks: () => loadListedStocks(supabaseUrl, serviceRoleKey),
  searchProvider: openAiKey ? new OpenAiWebSearchProvider(openAiKey) : undefined,
  pauseCheck: () => enforceNewsPauseEntry(supabaseUrl, serviceRoleKey, fetch),
}));
