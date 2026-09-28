// MIC Phase 3A: Scenario evaluator entry point (State -> Scenario).
//
// Reads the rates / macro / equity_index States from market_state_current,
// decides deterministically whether a new Scenario is warranted, and only
// then asks AI (Luna, escalating to Sol only when justified) for a
// conditional base / upside / downside Scenario. Writes only the MIC
// Scenario tables and ai_usage_events.
//
// Loosely coupled: nothing calls this from the State evaluator. It is not
// deployed, scheduled or invoked in Phase 3A; how it is triggered after a
// State update is decided in a later phase.
//
// Auth: cron / manual invocation only, X-Cron-Secret compared with
// MIC_SCENARIO_EVALUATOR_CRON_SECRET (not yet provisioned). DB access uses
// the new-format secret key (SUPABASE_SECRET_KEYS['default']).
import {
  classifyStates,
  clampScenarioConfidence,
  confidenceCap,
  decideScenarioRegeneration,
  SCENARIO_PROMPT_VERSION,
} from "./mic_scenario_state_logic.ts";
import {
  callScenarioModel,
  parseScenarioResponse,
  SCENARIO_LUNA_MODEL,
  SCENARIO_SOL_MODEL,
  shouldEscalateScenarioToSol,
} from "./mic_scenario_ai_logic.ts";
import {
  applyScenarioUpdate,
  claimScenarioRun,
  completeScenarioRunNoChange,
  computeScenarioRunWindow,
  failScenarioRun,
  fetchScenarioCurrent,
  fetchScenarioRunStatus,
  fetchScenarioStates,
  reconcileStaleScenarioRuns,
  recordScenarioUsage,
  type RestContext,
  safeErrorMessage,
} from "./mic_scenario_run_logic.ts";

export type ScenarioEvalResult = {
  status: "evaluated" | "no_change" | "failed" | "skipped_duplicate";
  runId?: string;
  reason?: string;
  error?: string;
};

export async function evaluateScenario(
  ctx: RestContext,
  openAiApiKey: string | null,
  now: Date,
  fetchImpl: typeof fetch = fetch,
): Promise<ScenarioEvalResult> {
  await reconcileStaleScenarioRuns(ctx, now, fetchImpl);

  const claim = await claimScenarioRun(ctx, computeScenarioRunWindow(now), fetchImpl);
  if (!claim.claimed) return { status: "skipped_duplicate" };
  const runId = claim.runId;

  try {
    const current = await fetchScenarioCurrent(ctx, fetchImpl);
    const classification = classifyStates(await fetchScenarioStates(ctx, fetchImpl), now.getTime());
    const decision = decideScenarioRegeneration(classification, current);
    const excluded = classification.excluded.map((item) => ({ domain: item.domain, reason: item.reason }));

    if (!decision.generate) {
      await completeScenarioRunNoChange(ctx, runId, {
        generate: false,
        reason: decision.reason,
        fingerprint: decision.fingerprint,
        usable_domains: classification.usable.map((state) => state.snapshot.domain),
        excluded,
      }, fetchImpl);
      return { status: "no_change", runId, reason: decision.reason };
    }

    if (!openAiApiKey) throw new Error("SECRET_MISSING:OPENAI_API_KEY");

    const aiInput = { usable: classification.usable, excluded: classification.excluded };
    const usedDomains = new Set<string>(classification.usable.map((state) => state.snapshot.domain));
    const cap = confidenceCap(classification.usable, classification.excluded.length);

    // Usage is recorded for every call that reached OpenAI, before its output
    // is validated, so a malformed answer still leaves its real cost on the run.
    const lunaCall = await callScenarioModel({ apiKey: openAiApiKey, model: SCENARIO_LUNA_MODEL, input: aiInput }, fetchImpl);
    let finalUsageId = await recordScenarioUsage(ctx, { runId, ...lunaCall }, fetchImpl);
    let finalCall = lunaCall;
    let finalOutput = parseScenarioResponse(lunaCall.payload, usedDomains);
    let escalated = false;

    if (shouldEscalateScenarioToSol(finalOutput, cap)) {
      const solCall = await callScenarioModel({ apiKey: openAiApiKey, model: SCENARIO_SOL_MODEL, input: aiInput }, fetchImpl);
      finalUsageId = await recordScenarioUsage(ctx, { runId, ...solCall }, fetchImpl);
      finalOutput = parseScenarioResponse(solCall.payload, usedDomains);
      finalCall = solCall;
      escalated = true;
    }

    const confidence = clampScenarioConfidence(finalOutput.confidence, cap, finalOutput.assessmentStatus);

    await applyScenarioUpdate(ctx, {
      runId,
      expectedCurrentUpdatedAt: current.updatedAt,
      inputFingerprint: decision.fingerprint,
      promptVersion: SCENARIO_PROMPT_VERSION,
      assessmentStatus: finalOutput.assessmentStatus,
      baseCase: finalOutput.baseCase,
      upsideCase: finalOutput.upsideCase,
      downsideCase: finalOutput.downsideCase,
      stateConflicts: finalOutput.stateConflicts,
      confidence: confidence.confidence,
      aiConfidence: confidence.aiConfidence,
      stateSnapshots: classification.usable.map((state) => state.snapshot),
      evidenceMeta: classification.usable.map((state) => ({
        domain: state.snapshot.domain,
        freshness: state.freshness,
        usability: state.usability,
      })),
      aiModel: finalCall.model,
      aiInputTokens: finalCall.inputTokens,
      aiOutputTokens: finalCall.outputTokens,
      aiCostUsd: finalCall.costUsd,
      decisionDetail: {
        generate: true,
        reason: decision.reason,
        new_domains: decision.newDomains,
        excluded,
        weak: classification.usable
          .filter((state) => state.usability === "weak")
          .map((state) => ({ domain: state.snapshot.domain, reasons: state.weakReasons })),
        confidence_cap: cap,
        escalated_to_sol: escalated,
      },
      aiUsageEventId: finalUsageId,
    }, fetchImpl);
    return { status: "evaluated", runId, reason: decision.reason };
  } catch (error) {
    const reason = safeErrorMessage(error);
    await failScenarioRun(ctx, runId, reason, fetchImpl);
    // A write whose response was lost may already have committed.
    const committed = await fetchScenarioRunStatus(ctx, runId, fetchImpl);
    if (committed === "evaluated" || committed === "no_change") {
      return { status: committed, runId, reason: "reconciled_after_error", error: reason };
    }
    return { status: "failed", runId, error: reason };
  }
}

const jsonHeaders = { "Content-Type": "application/json; charset=utf-8" };

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
}

function isAuthorizedCronCaller(req: Request): boolean {
  const expected = Deno.env.get("MIC_SCENARIO_EVALUATOR_CRON_SECRET");
  const provided = req.headers.get("X-Cron-Secret");
  return typeof expected === "string" && expected.length > 0 && provided === expected;
}

function getSecretKey(): string | null {
  const raw = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (!raw) return null;
  try {
    const value = (JSON.parse(raw) as Record<string, unknown>)["default"];
    return typeof value === "string" && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

export async function handleRequest(req: Request): Promise<Response> {
  if (req.method !== "POST") return response({ error: "POST_REQUIRED" }, 405);
  if (!isAuthorizedCronCaller(req)) return response({ error: "UNAUTHORIZED" }, 401);
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const secretKey = getSecretKey();
  if (!supabaseUrl || !secretKey) return response({ error: "SERVER_CONFIGURATION_MISSING" }, 500);
  const result = await evaluateScenario({ supabaseUrl, secretKey }, Deno.env.get("OPENAI_API_KEY") ?? null, new Date());
  return response({ status: "completed", result });
}

if (import.meta.main) {
  Deno.serve(handleRequest);
}
