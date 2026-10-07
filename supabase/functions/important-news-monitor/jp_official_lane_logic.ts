import { classifyEnrichmentFailure, type EnrichmentResult } from "./jp_official_enrichment.ts";
import { JP_OFFICIAL_SOURCES } from "./jp_official_filters.ts";
import { jpOfficialBodySummary, type JpOfficialSelected } from "./jp_official_signal_fetchers.ts";

// JP official lane, Phase B.1 hardening. Pure orchestration (no DB, no HTTP of its own):
//  1. same-event collapse inside one read, so the same release published under two URLs is one candidate;
//  2. a fill loop that draws candidates round-robin across sources until the per-fetch quota of STORED candidates is
//     reached, so an item that cannot be enriched never uses up a slot or blocks the items behind it.

/** Same source + same normalised title this close together is one event; anything further apart stays separate. */
export const JP_OFFICIAL_SAME_EVENT_WINDOW_MS = 30 * 60 * 1000;

export function normalizeJpTitle(title: string): string {
  return title.normalize("NFKC").toLowerCase().replace(/\s+/gu, "");
}

/** Keeps the earliest of items that are the same release (same source, same title, published within 30 minutes). */
export function collapseSameEventItems(items: readonly JpOfficialSelected[]): { kept: JpOfficialSelected[]; collapsed: number } {
  const kept: JpOfficialSelected[] = [];
  let collapsed = 0;
  const sorted = [...items].sort((a, b) => Date.parse(a.publishedAt) - Date.parse(b.publishedAt));
  for (const item of sorted) {
    const title = normalizeJpTitle(item.row.title);
    const same = kept.some((other) =>
      other.sourceId === item.sourceId && normalizeJpTitle(other.row.title) === title &&
      Math.abs(Date.parse(other.publishedAt) - Date.parse(item.publishedAt)) <= JP_OFFICIAL_SAME_EVENT_WINDOW_MS
    );
    if (same) collapsed += 1;
    else kept.push(item);
  }
  // keep the caller's original read order (oldest fetched first)
  const order = new Map(items.map((item, index) => [item.sourceUrl, index]));
  kept.sort((a, b) => (order.get(a.sourceUrl) ?? 0) - (order.get(b.sourceUrl) ?? 0));
  return { kept, collapsed };
}

/** Best-effort memory of URLs that failed permanently (module scope: survives while the Edge isolate stays warm). */
export type PermanentFailureMemory = { has(url: string): boolean; add(url: string): void };

export function createPermanentFailureMemory(maxEntries = 500): PermanentFailureMemory {
  const urls = new Set<string>();
  return {
    has: (url) => urls.has(url),
    add: (url) => {
      if (urls.size >= maxEntries) urls.delete(urls.values().next().value as string);
      urls.add(url);
    },
  };
}

export type LaneSaved = { status: "pending_judgement" | "duplicate"; id: string; duplicateOf: string | null };

export type JpLaneDeps = {
  enrich: (item: JpOfficialSelected) => Promise<EnrichmentResult>;
  /** true when an equal / same-event candidate is already stored (checked right before the insert). */
  isStored: (item: JpOfficialSelected, body: string) => Promise<boolean>;
  insert: (item: JpOfficialSelected, body: string) => Promise<LaneSaved>;
  now: () => number;
  memory: PermanentFailureMemory;
};

export type JpLaneOutcome = {
  inserted: number;
  alreadyKnown: number;
  enrichedPages: number;
  deferred: number;
  skipped: Record<string, number>;
  errors: string[];
  results: Array<LaneSaved>;
};

export async function runJpOfficialFill(
  bySource: ReadonlyMap<string, readonly JpOfficialSelected[]>,
  quota: number,
  budgetMs: number,
  deps: JpLaneDeps,
  safeError: (error: unknown) => string,
): Promise<JpLaneOutcome> {
  const outcome: JpLaneOutcome = { inserted: 0, alreadyKnown: 0, enrichedPages: 0, deferred: 0, skipped: {}, errors: [], results: [] };
  const skip = (reason: string) => {
    outcome.skipped[reason] = (outcome.skipped[reason] ?? 0) + 1;
  };
  const queues = [...bySource.values()].map((items) => [...items]);
  const startedAt = deps.now();
  for (let progressed = true; progressed && outcome.inserted < quota;) {
    progressed = false;
    for (const queue of queues) {
      if (outcome.inserted >= quota) break;
      const item = queue.shift();
      if (!item) continue;
      progressed = true;
      try {
        if (deps.now() - startedAt > budgetMs) {
          skip("time_budget");
          continue;
        }
        if (deps.memory.has(item.sourceUrl)) {
          skip("known_permanent_failure");
          continue;
        }
        let enrichedText: string | null = null;
        if (JP_OFFICIAL_SOURCES[item.sourceId].enrich) {
          const page = await deps.enrich(item);
          if (!page.ok) {
            const kind = classifyEnrichmentFailure(page);
            if (kind === "permanent") deps.memory.add(item.sourceUrl);
            skip(`enrich_${kind}_${page.reason}`);
            continue; // does not use a quota slot; the next candidate is drawn
          }
          enrichedText = page.text;
          outcome.enrichedPages += 1;
        }
        const body = jpOfficialBodySummary(item, enrichedText);
        if (!body) {
          deps.memory.add(item.sourceUrl);
          skip("no_body");
          continue;
        }
        if (await deps.isStored(item, body)) {
          outcome.alreadyKnown += 1;
          continue;
        }
        const saved = await deps.insert(item, body);
        outcome.results.push(saved);
        if (saved.status === "duplicate") outcome.alreadyKnown += 1;
        else outcome.inserted += 1;
      } catch (error) {
        outcome.errors.push(`jp_official:${item.sourceId}:${safeError(error)}`);
      }
    }
  }
  outcome.deferred = queues.reduce((sum, queue) => sum + queue.length, 0);
  return outcome;
}
