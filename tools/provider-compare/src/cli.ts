// Comparison harness CLI.
//
//   deno run --no-config --allow-read --allow-env --allow-net --allow-write=<out> --allow-run=security \
//     tools/provider-compare/src/cli.ts --mode dry-run --providers anthropic:claude-haiku-5-5@effort=low,thinking=off
//
// Default mode is dry-run: no key is read and nothing leaves the machine. Live mode needs ALL of:
//   --mode live  PROVIDER_COMPARE_ALLOW_PAID=1  --max-calls N  --max-usd X  and an API key (env or --keychain-*).
// Nothing in this program writes to Supabase or any production system.
import { loadCases } from "./fixtures.ts";
import { averagesOf, loadLedgerSnapshot } from "./ledger_snapshot.ts";
import { budgetFromArgs, type RunMode } from "./budget.ts";
import { createMockProvider } from "./providers/mock.ts";
import { createRecordedProvider, recordedOutput } from "./providers/recorded.ts";
import { createOpenAiProvider } from "./providers/openai.ts";
import { createAnthropicProvider } from "./providers/anthropic.ts";
import { describeKey, resolveApiKey } from "./keys.ts";
import { estimateSpecOf, parseProviderSpec, type ProviderSpec } from "./provider_spec.ts";
import { runComparison, type Report } from "./runner.ts";
import { TASK_IDS, type TaskId } from "./tasks.ts";
import type { Provider } from "./types.ts";
import { markdownTable, simulateAll } from "./cost_simulation.ts";
import { redactSecrets } from "./redact.ts";

type Args = {
  mode: RunMode;
  tasks: TaskId[];
  providers: string[];
  out?: string;
  maxCalls?: number;
  maxUsd?: number;
  creditUsd: number;
  keychainAnthropic?: string;
  keychainOpenai?: string;
  caseFilter?: string;
  tokenizerFactor: number;
};

function parseArgs(argv: string[]): Args {
  const args: Args = { mode: "dry-run", tasks: [...TASK_IDS], providers: [], creditUsd: 0, tokenizerFactor: 1 };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case "--mode":
        if (value !== "mock" && value !== "dry-run" && value !== "live") throw new Error("--mode must be mock, dry-run or live");
        args.mode = value; i += 1; break;
      case "--tasks": args.tasks = value.split(",") as TaskId[]; i += 1; break;
      case "--providers": args.providers = value.split(";").filter(Boolean); i += 1; break;
      case "--out": args.out = value; i += 1; break;
      case "--max-calls": args.maxCalls = Number(value); i += 1; break;
      case "--max-usd": args.maxUsd = Number(value); i += 1; break;
      case "--credit-usd": args.creditUsd = Number(value); i += 1; break;
      case "--keychain-anthropic": args.keychainAnthropic = value; i += 1; break;
      case "--keychain-openai": args.keychainOpenai = value; i += 1; break;
      case "--cases": args.caseFilter = value; i += 1; break;
      case "--tokenizer-factor": args.tokenizerFactor = Number(value); i += 1; break;
      default: throw new Error(`unknown flag ${flag}`);
    }
  }
  for (const task of args.tasks) if (!(TASK_IDS as readonly string[]).includes(task)) throw new Error(`unknown task ${task}`);
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(Deno.args);
  const allCases = await loadCases();
  const cases = args.caseFilter ? allCases.filter((c) => c.caseId.includes(args.caseFilter as string)) : allCases;
  const snapshot = await loadLedgerSnapshot();
  const averages = averagesOf(snapshot);
  const budget = budgetFromArgs({ mode: args.mode, maxCalls: args.maxCalls, maxUsd: args.maxUsd }, Deno.env);
  const specs: ProviderSpec[] = args.providers.map(parseProviderSpec);
  const secrets: string[] = [];

  const providers: Provider[] = [createRecordedProvider(cases, averages)];
  const estimateSpecs = [null as ReturnType<typeof estimateSpecOf> | null];

  for (const spec of specs) {
    estimateSpecs.push(estimateSpecOf(spec, args.tokenizerFactor));
    if (args.mode === "mock") {
      // Plumbing check only: the "Claude" mock mirrors the recorded production answer, so agreement is 100% by construction.
      const byId = new Map(cases.map((c) => [c.caseId, c]));
      providers.push(createMockProvider({
        name: spec.provider,
        model: spec.model,
        label: `${spec.provider}:${spec.model} (mock)`,
        responder: (request) => {
          const fixture = byId.get(request.caseId);
          const text = fixture ? recordedOutput(request.taskId, fixture) : null;
          return { text: text ?? JSON.stringify({ candidates: [] }), usage: { inputTokens: 1000, outputTokens: 200 } };
        },
      }));
      continue;
    }
    if (args.mode === "dry-run") {
      // Never constructed with a key: dry-run estimates only and the provider's run() is not called.
      providers.push(createMockProvider({ name: spec.provider, model: spec.model, label: `${spec.provider}:${spec.model}`, responder: () => ({ text: "{}" }) }));
      continue;
    }
    const resolved = await resolveApiKey(spec.provider, {
      env: Deno.env,
      keychainService: spec.provider === "anthropic" ? args.keychainAnthropic : args.keychainOpenai,
    });
    console.log(`${spec.provider} key:`, JSON.stringify(describeKey(resolved)));
    if (!resolved) throw new Error(`no ${spec.provider} API key available (env or --keychain-${spec.provider})`);
    secrets.push(resolved.key);
    providers.push(
      spec.provider === "anthropic"
        ? createAnthropicProvider({ apiKey: resolved.key, model: spec.model, effort: spec.effort, thinking: spec.thinking })
        : createOpenAiProvider({ apiKey: resolved.key, model: spec.model }),
    );
  }

  const report: Report = await runComparison({
    cases, providers, estimateSpecs, tasks: args.tasks, mode: args.mode, budget, averages, knownSecrets: secrets,
  });
  if (args.out) await Deno.writeTextFile(args.out, JSON.stringify(report, null, 2) + "\n");
  console.log(`mode=${report.mode} entries=${report.entries.length} skipped=${report.skipped.length} stoppedBy=${report.stoppedBy ?? "-"}`);
  console.log(JSON.stringify(report.budget));
  for (const row of report.summary) console.log(JSON.stringify(row));
  console.log("\n" + markdownTable(simulateAll(snapshot, { creditUsd: args.creditUsd })));
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(redactSecrets(String((error as Error)?.message ?? error)));
    Deno.exit(1);
  }
}
