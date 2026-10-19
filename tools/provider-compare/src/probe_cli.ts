// Zero-cost preflight for the Claude side (models list + token counting; no /v1/messages call, so nothing is billed).
//
//   deno run --no-config --allow-read --allow-env --allow-net=api.anthropic.com --allow-run=security \
//     tools/provider-compare/src/probe_cli.ts [--keychain-anthropic <service>] [--models a,b] [--per-task 6] [--out probe.json]
//
// The key comes from ANTHROPIC_API_KEY, or from the macOS Keychain item named with --keychain-anthropic. Only
// whether a key was found and where from is printed, never any part of it.
import { loadCases } from "./fixtures.ts";
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
  const resolved = await resolveApiKey("anthropic", { env: Deno.env, keychainService: value("--keychain-anthropic") });
  console.log("anthropic key:", JSON.stringify(describeKey(resolved)));
  if (!resolved) throw new Error("no Anthropic API key available (ANTHROPIC_API_KEY or --keychain-anthropic <service>)");

  const cases = await loadCases();
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
