// F8 (2026-10-16): OFFLINE, fully synthetic model of supabase/functions/news-discovery-observer's effect graph and of a
// candidate stop gate. It models control flow read from observer_handler.ts / index.ts (base dbe9e13c); it is NOT the handler,
// and a PASS is a property of the plan, not proof of an implementation. No network, DB, SDK or environment access.

export type ObsEffect = "db_read" | "rpc_write" | "http_external" | "ai_search";
export const OBS_OUTWARD: readonly ObsEffect[] = ["rpc_write", "http_external", "ai_search"];

export type ObsRequest = {
  method?: "POST" | "GET";
  authorized?: boolean;
  body?: "valid" | "invalid_json";
  includeGdelt?: boolean;
  /** search.enabled; the provider also needs OPENAI_API_KEY and a DB budget reservation */
  searchEnabled?: boolean;
  triggerType?: "manual" | "scheduled" | "local_validation" | "bogus";
  sources?: number;
};

export type ObsWorld = {
  /** the news pause setting read by the candidate gate (is_active) */
  isActive: unknown;
  settingsReadFails?: boolean;
  openAiKey: boolean;
  budgetAvailable: boolean;
  /** the setting flips after this many outward effects of THIS request (in-flight) */
  flipAfterOutward?: number;
};

export type ObsGate = {
  /** entry: after authentication and request-shape validation? "after_auth" = before any body/mode handling */
  entry: "after_auth" | "none";
  egress: boolean;
};

export const OBS_BASELINE: ObsGate = { entry: "none", egress: false };
export const OBS_CANDIDATE: ObsGate = { entry: "after_auth", egress: true };

export type ObsCounters = Record<ObsEffect, number> & { status: string };

export function handleObserver(request: ObsRequest, world: ObsWorld, gate: ObsGate): ObsCounters {
  const c: ObsCounters = { db_read: 0, rpc_write: 0, http_external: 0, ai_search: 0, status: "" };
  let outward = 0;
  let current: unknown = world.isActive;
  const readSetting = (): boolean => {
    c.db_read += 1;
    if (world.settingsReadFails) return false;
    return current === true;
  };
  const effect = (kind: ObsEffect): boolean => {
    if (OBS_OUTWARD.includes(kind)) {
      if (world.flipAfterOutward !== undefined && outward >= world.flipAfterOutward) current = false;
      if (gate.egress && !readSetting()) {
        c.status = "paused_egress";
        return false;
      }
      outward += 1;
    }
    c[kind] += 1;
    return true;
  };

  if ((request.method ?? "POST") !== "POST") {
    c.status = "405";
    return c;
  }
  if (request.authorized === false) {
    c.status = "401";
    return c;
  }
  // candidate entry gate: after authentication, before body handling / run creation
  if (gate.entry === "after_auth" && !readSetting()) {
    c.status = "paused";
    return c;
  }
  if (request.body === "invalid_json") {
    c.status = "400";
    return c;
  }
  if (request.triggerType === "bogus") {
    c.status = "400";
    return c;
  }
  // begin_run (RPC write) -> stocks_master read -> feeds -> persist -> optional web search -> finish_run
  if (!effect("rpc_write")) return c; // news_discovery_begin_run
  effect("db_read"); // loadStocks (read)
  const sources = request.sources ?? 3;
  for (let i = 0; i < sources + (request.includeGdelt ? 1 : 0); i += 1) {
    if (!effect("http_external")) return finish(c, effect);
  }
  if (!effect("rpc_write")) return finish(c, effect); // insert_signals
  if (request.searchEnabled && world.openAiKey) {
    if (world.budgetAvailable) {
      if (!effect("rpc_write")) return finish(c, effect); // reserve_search
      if (!effect("ai_search")) return finish(c, effect);
      effect("rpc_write"); // complete_search
    }
  }
  effect("rpc_write"); // finish_run
  return c;
}

function finish(c: ObsCounters, effect: (kind: ObsEffect) => boolean): ObsCounters {
  // finish_run is attempted on the way out; under a pause it is refused too (the run row stays 'running')
  effect("rpc_write");
  return c;
}

export const obsOutwardTotal = (c: ObsCounters) => OBS_OUTWARD.reduce((sum, kind) => sum + c[kind], 0);

export function observerRequests(): Array<{ name: string; req: ObsRequest }> {
  return [
    { name: "default run", req: {} },
    { name: "scheduled run", req: { triggerType: "scheduled" } },
    { name: "with GDELT", req: { includeGdelt: true } },
    { name: "web search enabled", req: { searchEnabled: true } },
    { name: "web search + GDELT + scheduled", req: { searchEnabled: true, includeGdelt: true, triggerType: "scheduled" } },
    { name: "local_validation", req: { triggerType: "local_validation" } },
    { name: "many sources", req: { sources: 40 } },
  ];
}
