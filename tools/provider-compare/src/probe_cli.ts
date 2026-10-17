// Zero-cost preflight for the Claude side (models list + token counting; no /v1/messages call, so nothing is billed).
//
//   deno run --no-config --allow-read --allow-env --allow-net=api.anthropic.com --allow-run=security \
//     tools/provider-compare/src/probe_cli.ts [--keychain-anthropic <service>] [--models a,b] [--per-task 6] [--out probe.json]
//
// The key comes from ANTHROPIC_API_KEY, or from the macOS Keychain item named with --keychain-anthropic. Only
// whether a key was found and where from is printed, never any part of it.
//
// Every request this program sends (models list, count_tokens) goes to a vendor endpoint, so the order is fixed:
//   1. refuse `--fixtures legacy` (it holds third-party bodies);
//   2. load the rights-safe fixtures LOCALLY and ask the external-send gate which cases are cleared;
//   3. only then look for an API key and open the network.
// `--plan-only` stops after step 2: it prints what would be sent and needs no key and no network permission.
import { type FixtureMode, loadRunnableCases } from "./fixture_loader.ts";
import { assertRequestsSendable, describePayloadScope, planExternalSend } from "./external_send_gate.ts";
import { averagesOf, loadLedgerSnapshot } from "./ledger_snapshot.ts";
import { describeKey, resolveApiKey } from "./keys.ts";
import { runProbe } from "./probe.ts";
import { buildTaskRequest, buildWebSearchRequests } from "./tasks.ts";
import type { NeutralRequest } from "./types.ts";
import { redactSecrets } from "./redact.ts";

type TaskName = Exclude<Parameters<typeof buildTaskRequest>[0], never>;

async function main(): Promise<void> {
  const args = Deno.args;
  const value = (flag: string) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const models = (value("--models") ?? "claude-haiku-5-5,claude-sonnet-5-5,claude-opus-5-5").split(",");
  const perTask = Number(value("--per-task") ?? "6");

  // 1. The probe sends request bodies to a vendor endpoint: the legacy fixture file is refused before anything else
  //    (before the key is looked up, before any case is loaded, before the network can be touched).
  const fixtures = (value("--fixtures") ?? "rights_safe") as FixtureMode;
  if (fixtures === "legacy") throw new Error("LEGACY_FIXTURES_REFUSED_FOR_EXTERNAL_CALLS: use --fixtures rights_safe");
  if (fixtures !== "rights_safe") throw new Error("--fixtures must be rights_safe (legacy is refused for external calls)");

  // 2. Local load + gate. A case without a licence record is never sent, even with a matching hash.
  const loaded = await loadRunnableCases({
    fixtures,
    runtimeBodiesPath: value("--runtime-bodies"),
    fixturesDir: value("--fixtures-dir"),
  });
  const plan = planExternalSend({
    fixtureMode: loaded.mode,
    cases: loaded.cases,
    provenance: loaded.provenance,
    manifest: loaded.manifest,
    licences: loaded.licences,
    providers: ["anthropic"],
    today: new Date().toISOString().slice(0, 10),
  });
  console.log(`fixtures=${loaded.mode} ready=${loaded.cases.length} excluded=${loaded.excluded.length} ${JSON.stringify(loaded.summary)}`);
  console.log(`external_send cleared=${plan.allowedCases.length} blocked=${plan.blocked.length} ${JSON.stringify(plan.counts)}`);
  for (const d of plan.blocked) console.log(`external_send blocked ${d.caseId}: ${d.code} (${d.reason})`);
  for (const item of plan.allowedCases) console.log(`external_send payload ${JSON.stringify(describePayloadScope(item))}`);
  if (plan.allowedCases.length === 0) throw new Error("EXTERNAL_SEND_NO_ELIGIBLE_CASES");
  const cases = plan.allowedCases;
  const requests: NeutralRequest[] = [];
  const tasks: TaskName[] = ["judgement_primary", "judgement_detail", "generation_draft", "generation_fact", "generation_voice"];
  for (const task of tasks) {
    let taken = 0;
    for (const fixture of cases) {
      if (taken >= perTask) break;
      const request = await buildTaskRequest(task, fixture);
      if (request) { requests.push(request); taken += 1; }
    }
  }
  requests.push(...buildWebSearchRequests()); // skipped by the count endpoint; listed so the report shows it
  assertRequestsSendable(requests, plan); // last local check: no payload may carry a case that is not cleared
  if (args.includes("--plan-only")) {
    console.log(`plan-only: ${requests.length} requests would be sent to ${models.length} models; no key was read and no request was made`);
    return;
  }
  // 3. Only now: key discovery, then the network.
  const resolved = await resolveApiKey("anthropic", { env: Deno.env, keychainService: value("--keychain-anthropic") });
  console.log("anthropic key:", JSON.stringify(describeKey(resolved)));
  if (!resolved) throw new Error("no Anthropic API key available (ANTHROPIC_API_KEY or --keychain-anthropic <service>)");
  const snapshot = await loadLedgerSnapshot();
  const averages = averagesOf(snapshot);
  const ledgerInputTokens = {
    judgement_primary: averages.judgement_luna.avgInputTokens,
    judgement_detail: averages.judgement_sol.avgInputTokens,
    generation_draft: averages.generation_draft.avgInputTokens,
    generation_fact: averages.generation_fact.avgInputTokens,
    generation_voice: averages.generation_voice.avgInputTokens,
  };
  const report = await runProbe({ apiKey: resolved.key, models, requests, ledgerInputTokens });
  const text = JSON.stringify(report, null, 2);
  const out = value("--out");
  if (out) await Deno.writeTextFile(out, text + "\n");
  console.log(JSON.stringify({ keyWorks: report.keyWorks, error: report.error, models: report.models, factors: report.factors }, null, 2));
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(redactSecrets(String((error as Error)?.message ?? error)));
    Deno.exit(1);
  }
}
