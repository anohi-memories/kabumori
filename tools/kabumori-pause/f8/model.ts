// F8 (2026-10-15): OFFLINE, fully synthetic model of the important-news-monitor HTTP handler's side-effect graph and of the
// candidate hard-pause gate. It models the control flow that was read from
// supabase/functions/important-news-monitor/index.ts (Deno.serve, base d2309afc) — it is NOT the handler and a PASS here is a
// property of the design, not proof of an implementation. No network, no database, no SDK, no environment variables.

export type Effect = "db_read" | "db_write" | "db_claim" | "ai" | "http_external" | "x_post" | "push_enqueue";

export const OUTWARD: readonly Effect[] = ["db_write", "db_claim", "ai", "http_external", "x_post", "push_enqueue"];

/** `is_active` of important_news_monitor_settings, or an unreadable / malformed value. */
export type ActiveValue = true | false | undefined | "true" | 1 | null;

export type Request = {
  /** Anything the body may carry; the handler dispatches on `mode` only. */
  mode?: string;
  trigger?: string;
  fetchSources?: boolean;
  candidates?: unknown[];
  /** hostile / confused fields that must never unlock a paused handler */
  extra?: Record<string, unknown>;
};

export type World = {
  isActive: ActiveValue;
  settingsReadFails: boolean;
  autoPublish: boolean;
  openAiKey: boolean;
  /** important_news_monitor_settings.luna_enabled: judge_pending already refuses (409) when false, before any AI */
  lunaEnabled?: boolean;
  xTokens: boolean;
  /** pending candidates / ready candidates / app-copy targets available to the lanes */
  pendingJudgement: number;
  readyForGeneration: number;
  appCopyTargets: number;
  readyForPublish: number;
  /** collection lane switches */
  jpOfficialLane: boolean;
  /** the settings value flips to `flipTo` after this many outward effects were attempted (in-flight pause) */
  flip?: { afterOutward: number; to: ActiveValue };
};

export type Counters = Record<Effect, number> & { status: string; touched: Set<string> };

export type Gate = {
  /** where the pause check sits: before mode dispatch for every mode, only for non-dry-run modes, or only in the scheduled collection branch (today's code) */
  entry: "all" | "non-dry" | "scheduled-only" | "none";
  /** re-read the setting immediately before every outward effect */
  recheck: boolean;
  /** modes (exact names) that bypass the gate even when paused (negative-control knob) */
  bypassModes?: string[];
  /** false = skip the X-post recheck (negative-control knob) */
  recheckX?: boolean;
};

export const BASELINE: Gate = { entry: "scheduled-only", recheck: false };
export const ENTRY_ONLY: Gate = { entry: "all", recheck: false };
export const FULL_GATE: Gate = { entry: "all", recheck: true };

export const KNOWN_MODES = [
  "unpdf_edge_verification", "app_copy_dry_run", "notification_enqueue_dry_run", "publish_dry_run", "publish_ready",
  "generation_dry_run", "generate_ready", "judgement_dry_run", "judge_pending",
] as const;

const DRY = new Set(["app_copy_dry_run", "notification_enqueue_dry_run", "publish_dry_run", "generation_dry_run", "judgement_dry_run", "unpdf_edge_verification"]);

function newCounters(): Counters {
  return { db_read: 0, db_write: 0, db_claim: 0, ai: 0, http_external: 0, x_post: 0, push_enqueue: 0, status: "", touched: new Set() };
}

const isRunning = (value: ActiveValue) => value === true;

export function handle(request: Request, world: World, gate: Gate): Counters {
  const c = newCounters();
  let outward = 0;
  let current: ActiveValue = world.isActive;

  const readSetting = (): boolean | "fail" => {
    c.db_read += 1;
    c.touched.add("news_settings");
    if (world.settingsReadFails) return "fail";
    return isRunning(current);
  };
  /** performs one effect; returns false when the recheck refuses it */
  const effect = (kind: Effect, resource: string): boolean => {
    if (OUTWARD.includes(kind)) {
      // an in-flight pause: the setting flips once `afterOutward` outward effects of THIS request have been performed
      if (world.flip && outward >= world.flip.afterOutward) current = world.flip.to;
      if (gate.recheck && !(kind === "x_post" && gate.recheckX === false) && !(request.mode && gate.bypassModes?.includes(request.mode))) {
        const state = readSetting();
        if (state !== true) {
          c.status = "paused_recheck";
          return false;
        }
      }
      outward += 1;
    }
    c[kind] += 1;
    c.touched.add(resource);
    return true;
  };

  // --- auth and configuration happen first today; the gate must not weaken them (not modelled further)
  const mode = request.mode;
  const gated = gate.entry === "all" || (gate.entry === "non-dry" && !(mode !== undefined && DRY.has(mode)));
  if (gated && !(mode && gate.bypassModes?.includes(mode))) {
    const state = readSetting();
    if (state !== true) {
      c.status = state === "fail" ? "paused_read_failed" : "paused";
      return c;
    }
  }

  switch (mode) {
    case "unpdf_edge_verification":
      effect("http_external", "external_pdf");
      return c;
    case "app_copy_dry_run":
      if (!world.openAiKey) return c;
      effect("db_read", "news_candidates");
      if (!effect("ai", "openai")) return c;
      if (!effect("ai", "openai")) return c;
      effect("db_write", "usage_ledger");
      return c;
    case "notification_enqueue_dry_run":
      effect("db_read", "news_candidates");
      effect("db_read", "tracked_users");
      return c;
    case "publish_dry_run":
      effect("db_read", "news_candidates");
      return c;
    case "publish_ready": {
      effect("db_read", "news_settings");
      if (!world.autoPublish) return c;
      effect("db_read", "news_candidates");
      if (!world.xTokens) return c;
      effect("db_read", "x_tokens");
      if (world.readyForPublish === 0) return c;
      if (!effect("x_post", "x_api")) return c;
      effect("db_write", "news_candidates");
      effect("push_enqueue", "notifications");
      return c;
    }
    case "generation_dry_run":
      if (!world.openAiKey) return c;
      effect("db_read", "news_candidates");
      if (effect("ai", "openai")) effect("db_write", "usage_ledger");
      return c;
    case "generate_ready": {
      if (!world.openAiKey) return c;
      effect("db_read", "news_candidates");
      for (let i = 0; i < world.readyForGeneration; i += 1) {
        if (!effect("db_claim", "news_candidates")) return c;
        if (!effect("ai", "openai")) return c;
        if (!effect("ai", "openai")) return c;
        effect("db_write", "news_candidates");
      }
      // app copy and notification enqueue also run when there was nothing to generate
      for (let i = 0; i < world.appCopyTargets; i += 1) {
        if (!effect("ai", "openai")) return c;
        effect("db_write", "news_candidates");
      }
      effect("push_enqueue", "notifications");
      return c;
    }
    case "judgement_dry_run":
      if (!world.openAiKey) return c;
      effect("db_read", "news_candidates");
      if (effect("ai", "openai")) effect("db_write", "usage_ledger");
      return c;
    case "judge_pending": {
      if (!world.openAiKey) return c;
      effect("db_read", "news_settings");
      if (world.lunaEnabled === false) {
        c.status = "judgement_disabled";
        return c;
      }
      effect("db_read", "news_candidates");
      for (let i = 0; i < world.pendingJudgement; i += 1) {
        if (!effect("ai", "openai")) return c;
        effect("db_write", "usage_ledger");
        effect("db_write", "news_candidates");
        // immediate generation of a candidate that just became ready
        if (effect("db_claim", "news_candidates")) {
          effect("ai", "openai");
          effect("ai", "openai");
          effect("db_write", "news_candidates");
        } else return c;
      }
      return c;
    }
    default: {
      // absent / unknown mode falls into the collection branch (no mode check exists there)
      const supplied = request.candidates;
      if ((supplied !== undefined && !Array.isArray(supplied)) || (request.fetchSources !== true && supplied === undefined)) {
        c.status = "invalid_batch";
        return c;
      }
      const scheduled = request.trigger === "scheduled";
      if (scheduled && gate.entry === "scheduled-only") {
        const state = readSetting();
        if (state === "fail") {
          c.status = "settings_failed";
          return c;
        }
        if (state !== true) {
          effect("db_write", "monitor_runs");
          c.status = "skipped_inactive";
          return c;
        }
      }
      if (!effect("db_write", "monitor_runs")) return c; // stale-run reconciliation + run row
      for (const _ of supplied ?? []) if (!effect("db_write", "news_candidates")) return c;
      if (request.fetchSources === true) {
        if (!effect("http_external", "tdnet_and_feeds")) return c;
        effect("db_read", "news_discovery_signals");
        if (world.jpOfficialLane) effect("db_write", "news_candidates");
        if (world.openAiKey) {
          if (!effect("ai", "openai")) return c; // breaking_market web search
          if (!effect("ai", "openai")) return c; // headline trigger triage
        }
        effect("db_write", "news_candidates");
      }
      return c;
    }
  }
}

export function outwardTotal(c: Counters): number {
  return OUTWARD.reduce((sum, kind) => sum + c[kind], 0);
}

export const baseWorld = (over: Partial<World> = {}): World => ({
  isActive: true, settingsReadFails: false, autoPublish: true, openAiKey: true, xTokens: true,
  pendingJudgement: 2, readyForGeneration: 2, appCopyTargets: 2, readyForPublish: 1, jpOfficialLane: true, ...over,
});

/** every request shape worth exercising, including hostile ones */
export function allRequests(): Array<{ name: string; req: Request }> {
  const out: Array<{ name: string; req: Request }> = [];
  for (const mode of KNOWN_MODES) out.push({ name: mode, req: { mode } });
  out.push({ name: "collect:manual+fetchSources", req: { fetchSources: true } });
  out.push({ name: "collect:scheduled+fetchSources", req: { trigger: "scheduled", fetchSources: true } });
  out.push({ name: "collect:manual+candidates", req: { candidates: [{}, {}] } });
  out.push({ name: "unknown_mode+fetchSources", req: { mode: "totally_unknown", fetchSources: true } });
  out.push({ name: "unknown_mode+candidates", req: { mode: "totally_unknown", candidates: [{}] } });
  out.push({ name: "mode_case_variant", req: { mode: "Judge_Pending", fetchSources: true } });
  out.push({ name: "judge_pending+body_override", req: { mode: "judge_pending", extra: { is_active: true, force: true, dry_run: false, paused: false } } });
  out.push({ name: "generate_ready+body_override", req: { mode: "generate_ready", extra: { is_active: true, bypass_pause: true } } });
  out.push({ name: "publish_ready+body_override", req: { mode: "publish_ready", extra: { auto_publish: true, trigger: "scheduled" } } });
  return out;
}
