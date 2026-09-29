// Storage adapter for the News Signal Pool. N2 has no DB (no migration yet); the pipeline talks
// to this interface only, so a Postgres adapter (docs/news-sources/news_pool_schema_proposal.md)
// can replace the in-memory / JSON-file adapters without touching the pipeline.
import type { GroupingSignal } from "./pipeline.ts";
import type { NewsSignal } from "./types.ts";

export type DedupeLookup = {
  url_key: string;
  source_id: string;
  external_id: string | null;
  /** Cross-source title key; null when the title is too generic to dedupe on. */
  title_fingerprint: string | null;
  since_ms: number; // title-fingerprint window start
};

export type DedupeHit = { reason: "canonical_url" | "normalized_url" | "source_external_id" | "title_fingerprint"; signal_id: string };

export type DuplicateLookup = DedupeLookup & { canonical_url: string; title_fingerprint_any: string };

/** Which signals a store actually wrote (a DB may skip rows another run inserted first). */
/**
 * Which signals a store actually wrote. `duplicates` are rows the DB itself resolved as URL
 * duplicates of a row another (concurrent) run committed first — not written, not an error.
 */
export type SaveResult = {
  inserted: string[];
  conflicted: string[];
  duplicates?: Array<{ id: string; duplicate_of: string; reason: string }>;
};

export interface NewsSignalStore {
  findDuplicate(lookup: DuplicateLookup): Promise<DedupeHit | null>;
  /** Optional batched form (one round trip per request); results align with `lookups`. */
  findDuplicates?(lookups: readonly DuplicateLookup[]): Promise<Array<DedupeHit | null>>;
  /** Recent signals for same-event grouping (bounded window). */
  recent(sinceMs: number): Promise<GroupingSignal[]>;
  save(signals: readonly NewsSignal[]): Promise<SaveResult | void>;
}

type IndexedRef = { id: string; source_id: string; title_fingerprint: string; at: number };

/**
 * Dedupe rules (learned from live data, 2026-09-28):
 * - URL match from another source, or from the same source with the same title -> duplicate.
 *   The same source reusing one URL for a new title (ESRI's index page) is a new item.
 * - Title match only counts across *different* sources. The same publisher re-using a title is a
 *   new document (Federal Register "Qualification of Drivers..." x4; 官邸's missile-launch
 *   instruction has the same title every time) and must never be swallowed.
 */
export class InMemoryNewsSignalStore implements NewsSignalStore {
  protected signals: NewsSignal[] = [];
  #byCanonical = new Map<string, IndexedRef[]>();
  #byUrlKey = new Map<string, IndexedRef[]>();
  #byExternal = new Map<string, string>();
  #byTitle = new Map<string, IndexedRef[]>();
  #urlKeyOf: (signal: NewsSignal) => string;

  constructor(urlKeyOf: (signal: NewsSignal) => string, initial: readonly NewsSignal[] = []) {
    this.#urlKeyOf = urlKeyOf;
    this.#index(initial);
  }

  #index(signals: readonly NewsSignal[]): void {
    const push = (map: Map<string, IndexedRef[]>, key: string, ref: IndexedRef) => {
      const list = map.get(key) ?? [];
      list.push(ref);
      map.set(key, list);
    };
    for (const signal of signals) {
      this.signals.push(signal);
      const ref = { id: signal.id, source_id: signal.source_id, title_fingerprint: signal.title_fingerprint, at: Date.parse(signal.fetched_at) };
      push(this.#byCanonical, signal.canonical_url, ref);
      push(this.#byUrlKey, this.#urlKeyOf(signal), ref);
      if (signal.external_id) this.#byExternal.set(`${signal.source_id}\u0000${signal.external_id}`, signal.id);
      push(this.#byTitle, signal.title_fingerprint, ref);
    }
  }

  findDuplicate(lookup: DuplicateLookup): Promise<DedupeHit | null> {
    const urlHit = (refs: IndexedRef[] | undefined) =>
      refs?.find((ref) => ref.source_id !== lookup.source_id || ref.title_fingerprint === lookup.title_fingerprint_any);
    if (lookup.external_id) {
      const external = this.#byExternal.get(`${lookup.source_id}\u0000${lookup.external_id}`);
      if (external) return Promise.resolve({ reason: "source_external_id", signal_id: external });
    }
    const canonical = urlHit(this.#byCanonical.get(lookup.canonical_url));
    if (canonical) return Promise.resolve({ reason: "canonical_url", signal_id: canonical.id });
    const urlKey = urlHit(this.#byUrlKey.get(lookup.url_key));
    if (urlKey) return Promise.resolve({ reason: "normalized_url", signal_id: urlKey.id });
    if (lookup.title_fingerprint) {
      const title = this.#byTitle.get(lookup.title_fingerprint)?.find((ref) =>
        ref.source_id !== lookup.source_id && ref.at >= lookup.since_ms
      );
      if (title) return Promise.resolve({ reason: "title_fingerprint", signal_id: title.id });
    }
    return Promise.resolve(null);
  }

  recent(sinceMs: number): Promise<GroupingSignal[]> {
    return Promise.resolve(this.signals.filter((signal) => Date.parse(signal.fetched_at) >= sinceMs));
  }

  save(signals: readonly NewsSignal[]): Promise<SaveResult> {
    this.#index(signals);
    return Promise.resolve({ inserted: signals.map((signal) => signal.id), conflicted: [] });
  }

  all(): Promise<NewsSignal[]> {
    return Promise.resolve([...this.signals]);
  }
}

/** Local-only adapter for the observer CLI: loads/saves a JSON array. Never used in a Function. */
export class JsonFileNewsSignalStore extends InMemoryNewsSignalStore {
  constructor(private readonly path: string, urlKeyOf: (signal: NewsSignal) => string, initial: readonly NewsSignal[]) {
    super(urlKeyOf, initial);
  }

  static async open(path: string, urlKeyOf: (signal: NewsSignal) => string): Promise<JsonFileNewsSignalStore> {
    let initial: NewsSignal[] = [];
    try {
      initial = JSON.parse(await Deno.readTextFile(path)) as NewsSignal[];
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    return new JsonFileNewsSignalStore(path, urlKeyOf, initial);
  }

  override async save(signals: readonly NewsSignal[]): Promise<SaveResult> {
    const result = await super.save(signals);
    await Deno.writeTextFile(this.path, JSON.stringify(this.signals, null, 1));
    return result;
  }
}
