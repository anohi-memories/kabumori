import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

// The inventory command prints the Kabumori model assignments and nothing else. These tests run the real script
// as a child process with an empty environment and no network or file permission (Deno) / no flags (Node), so
// they prove it needs neither OpenAI nor production access.
const SCRIPT = new URL("./kabumori-ai-models.ts", import.meta.url).pathname;

function run(args: string[] = []): { status: number | null; out: string; err: string } {
  const result = spawnSync("deno", ["run", "--no-config", "--no-prompt", SCRIPT, ...args], {
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" }, encoding: "utf8",
  });
  return { status: result.status, out: result.stdout, err: result.stderr };
}

test("inventory prints each role with model, reasoning, the configuration version and the price", () => {
  const { status, out, err } = run();
  assert.equal(status, 0, err);
  const lines = out.trimEnd().split("\n");
  assert.match(lines[0], /^Kabumori AI models \(config kabumori-ai-models\/\d{4}-\d{2}-\d{2}\.\d+\)$/);
  assert.ok(lines.some((line) => /^Market Report Generate: gpt-6\.1-sol \/ reasoning medium /.test(line)), out);
  assert.ok(lines.some((line) => /^Market Report Fact: gpt-6\.1-sol \/ reasoning low /.test(line)), out);
  assert.ok(out.includes("$2 in / $0.1 cached / $10 out per 1M tokens"));
});

test("inventory is deterministic and needs no permission, network or environment variable", () => {
  const first = run();
  const second = run();
  assert.equal(first.status, 0);
  assert.equal(first.out, second.out);
  assert.doesNotMatch(first.err, /requires (net|env|read|write)|permission/i);
});

test("--json prints the same registry as data", () => {
  const { status, out, err } = run(["--json"]);
  assert.equal(status, 0, err);
  const data = JSON.parse(out) as { config_version: string; roles: Record<string, { model: string; reasoning: { effort: string } }>; pricing: Record<string, unknown> };
  assert.deepEqual(Object.keys(data.roles).sort(), ["kabumori.market_report.fact", "kabumori.market_report.generate"]);
  assert.equal(data.roles["kabumori.market_report.generate"].reasoning.effort, "medium");
  assert.equal(data.roles["kabumori.market_report.fact"].reasoning.effort, "low");
  assert.ok(data.pricing["gpt-6.1-sol"]);
  assert.match(data.config_version, /^kabumori-ai-models\//);
});

test("the script contains no network, environment or file access of its own", async () => {
  const { readFile } = await import("node:fs/promises");
  const code = (await readFile(SCRIPT, "utf8")).split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
  assert.doesNotMatch(code, /\bfetch\s*\(|process\.env|Deno\.env|readFile|writeFile|XMLHttpRequest|WebSocket/);
});
