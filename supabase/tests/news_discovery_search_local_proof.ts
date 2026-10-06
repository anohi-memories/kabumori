// Disposable-only proof of the Layer 3 search path against the local proof DB (through the
// PostgREST stand-in): handler -> planSearches -> SupabaseSearchBudget (reserve/complete RPC,
// DB-enforced cap) -> stub provider (NO real search, no API key) -> search signals stored.
//   SUPABASE_URL=http://127.0.0.1:54399 SUPABASE_SERVICE_ROLE_KEY=<shim key> \
//   deno run --allow-net=127.0.0.1 --allow-env supabase/tests/news_discovery_search_local_proof.ts
import { postgrestRpcClient } from "../functions/_shared/news_discovery/supabase_store.ts";
import type { ProviderResult, WebSearchProvider } from "../functions/_shared/news_discovery/web_search.ts";
import { OBSERVER_SECRET_HEADER } from "../functions/news-discovery-observer/observer_auth.ts";
import { createObserverHandler } from "../functions/news-discovery-observer/observer_handler.ts";

const url = Deno.env.get("SUPABASE_URL") ?? "";
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(url)) throw new Error("Refusing: local stand-in URL only");
const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const secret = "A".repeat(42) + "A";

/** Canned results (fixtures, not real search output): one open publisher, one no_direct_fetch, one no_access. */
class StubProvider implements WebSearchProvider {
  readonly name = "stub_local_proof";
  readonly model = "none";
  calls = 0;
  search(): Promise<ProviderResult> {
    this.calls += 1;
    return Promise.resolve({
      ok: true,
      results: [
        { url: "https://open.example/energy/pipeline-outage", title: "Oil jumps after Gulf pipeline outage (fixture)", publisher: "open.example" },
        { url: "https://www3.nhk.or.jp/news/html/fixture.html", title: "トヨタ自動車 工場火災で生産停止（fixture）", publisher: "NHK" },
        { url: "https://www.aljazeera.com/news/fixture", title: "Tanker struck (fixture)", publisher: "Al Jazeera" },
      ],
      rejected_unverified: 1,
      usage: { model_calls: 1, web_search_calls: 1, input_tokens: 0, output_tokens: 0 },
    });
  }
}

const provider = new StubProvider();
const handler = createObserverHandler({
  observerSecret: secret,
  rpc: postgrestRpcClient(url, key),
  loadStocks: () => Promise.resolve([{ ticker_code: "7203", company_name: "トヨタ自動車", is_listed: true }]),
  searchProvider: provider,
});
const call = async () =>
  await (await handler(new Request("http://local/observer", {
    method: "POST",
    headers: { [OBSERVER_SECRET_HEADER]: secret, "Content-Type": "application/json" },
    body: JSON.stringify({ trigger_type: "local_validation", sources: [], search: { enabled: true, anomalies: [{ instrument: "WTI", change_pct: 4.5 }] } }),
  }))).json();

const first = await call();
const second = await call();
console.log(JSON.stringify({
  first: { status: first.status, totals: first.totals, search: { ...first.search, per_search: first.search.per_search.length } },
  second: { status: second.status, search_count: second.totals.search_count, denied: second.search.denied },
  provider_calls: provider.calls,
}, null, 1));
