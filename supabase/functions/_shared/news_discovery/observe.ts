// Local, read-only observer run (N2). Not a Function entry point; nothing is deployed or scheduled.
//
//   deno run --allow-net --allow-read --allow-write=<out dir> \
//     supabase/functions/_shared/news_discovery/observe.ts \
//     --stocks=<stocks_master.json> --out=<result.json> [--sources=a,b] [--gdelt=1] [--max-items=40]
//
// --stocks: JSON array of {ticker_code, company_name, is_listed} exported read-only from stocks_master.
// Writes only to --out (and --store when given). No DB writes, no AI, no Web Search, no posting.
import { buildAliasIndex, type StockMasterRow } from "./company_alias.ts";
import { GDELT_DISCOVERY_QUERIES, HostRateGate } from "./fetcher.ts";
import { runDiscovery, signalUrlKey, summarizeRates } from "./pipeline.ts";
import { fetchableSources, NEWS_SOURCE_REGISTRY, validateRegistry } from "./source_registry.ts";
import { InMemoryNewsSignalStore, JsonFileNewsSignalStore } from "./store.ts";

/** Default sample: one or two sources per category, Japan + overseas, plus a single GDELT query. */
export const DEFAULT_SAMPLE_SOURCES = [
  "us_federal_register",
  "us_fed_press",
  "us_sec_8k",
  "us_ustr",
  "us_eia_today_in_energy",
  "us_usgs_significant",
  "eu_ecb_press",
  "eu_commission_press",
  "jp_mof_news",
  "jp_fsa_news",
  "jp_kantei_news",
  "jp_esri",
  "jp_caa_news",
  "jp_jma_eqvol",
  "gdelt_doc",
];

function arg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return Deno.args.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

if (import.meta.main) {
  const problems = validateRegistry();
  if (problems.length) {
    console.error(JSON.stringify({ registry_invalid: problems }, null, 1));
    Deno.exit(1);
  }
  const wanted = (arg("sources") ?? DEFAULT_SAMPLE_SOURCES.join(",")).split(",").map((value) => value.trim());
  const allowed = new Map(fetchableSources().map((source) => [source.source_id, source]));
  const refused = wanted.filter((id) => !allowed.has(id));
  const sources = wanted.flatMap((id) => allowed.get(id) ?? []);
  const gdeltCount = Math.max(0, Math.min(Number(arg("gdelt") ?? "1"), GDELT_DISCOVERY_QUERIES.length));
  const stocksPath = arg("stocks");
  const rows: StockMasterRow[] = stocksPath ? JSON.parse(await Deno.readTextFile(stocksPath)) : [];
  const aliasIndex = rows.length ? buildAliasIndex(rows) : null;
  const storePath = arg("store");
  const store = storePath ? await JsonFileNewsSignalStore.open(storePath, signalUrlKey) : new InMemoryNewsSignalStore(signalUrlKey);

  const result = await runDiscovery({
    sources,
    store,
    aliasIndex,
    gate: new HostRateGate(),
    gdeltQueries: GDELT_DISCOVERY_QUERIES.slice(0, gdeltCount),
    maxItemsPerSource: Number(arg("max-items") ?? "40"),
  });

  const summary = {
    run: { started_at: result.started_at, finished_at: result.finished_at },
    registry: {
      total: NEWS_SOURCE_REGISTRY.length,
      direct: NEWS_SOURCE_REGISTRY.filter((s) => s.policy === "DIRECT_SOURCE").map((s) => s.source_id),
      discovery_only: NEWS_SOURCE_REGISTRY.filter((s) => s.policy === "DISCOVERY_ONLY").map((s) => s.source_id),
      disabled: NEWS_SOURCE_REGISTRY.filter((s) => s.policy === "DISABLED").map((s) => s.source_id),
      refused_by_policy_this_run: refused,
    },
    alias_index: aliasIndex
      ? { companies: aliasIndex.tickers.size, aliases: aliasIndex.entries.length, warnings: aliasIndex.warnings.slice(0, 20) }
      : null,
    totals: result.totals,
    rates: summarizeRates(result.totals),
    per_source: result.stats,
    ai_calls: result.ai_calls,
    web_search_calls: result.web_search_calls,
  };
  const outPath = arg("out");
  if (outPath) await Deno.writeTextFile(outPath, JSON.stringify({ summary, signals: result.signals, duplicates: result.duplicates }, null, 1));
  console.log(JSON.stringify(summary, null, 1));
}
