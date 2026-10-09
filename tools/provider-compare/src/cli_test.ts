import assert from "node:assert/strict";
import test from "node:test";

// Runs the real CLI as a subprocess. Dry-run is started WITHOUT --allow-net and --allow-run, which proves it needs
// neither the network nor a child process (so it cannot reach an API or read the Keychain).

const CLI = new URL("./cli.ts", import.meta.url).pathname;

async function runCli(args: string[], permissions: string[], env: Record<string, string> = {}) {
  const output = await new Deno.Command(Deno.execPath(), {
    args: ["run", "--no-config", ...permissions, CLI, ...args],
    env: { ...env },
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: output.code,
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
  };
}

const READ_ENV = ["--allow-read", "--allow-env"];

test("dry-run works with no network and no subprocess permission, reads no key, and prints an estimate table", async () => {
  const { code, stdout, stderr } = await runCli(
    ["--mode", "dry-run", "--tasks", "judgement_primary", "--providers", "anthropic:claude-haiku-5-5@effort=low,thinking=off"],
    READ_ENV,
    { ANTHROPIC_API_KEY: "sk-ant-FAKEFAKE0123456789" },
  );
  assert.equal(code, 0, stderr);
  assert.match(stdout, /mode=dry-run/);
  assert.match(stdout, /"calls":0/);
  assert.ok(!stdout.includes("FAKEFAKE") && !stderr.includes("FAKEFAKE"), "the key in the environment is never printed");
  assert.ok(!stdout.includes("key:"), "dry-run does not even look for a key");
  assert.match(stdout, /\| A /);
});

test("live mode is refused before anything else when the paid opt-in is missing", async () => {
  const { code, stderr, stdout } = await runCli(
    ["--mode", "live", "--max-calls", "5", "--max-usd", "0.1", "--providers", "anthropic:claude-haiku-5-5"],
    READ_ENV,
    { ANTHROPIC_API_KEY: "sk-ant-FAKEFAKE0123456789" },
  );
  assert.equal(code, 1);
  assert.match(stderr, /BUDGET_PAID_NOT_ALLOWED/);
  assert.ok(!stdout.includes("key:"));
  assert.ok(!stderr.includes("FAKEFAKE"));
});

test("live mode is refused without both limits even when the opt-in is present", async () => {
  const { code, stderr } = await runCli(
    ["--mode", "live", "--providers", "anthropic:claude-haiku-5-5"],
    READ_ENV,
    { PROVIDER_COMPARE_ALLOW_PAID: "1", ANTHROPIC_API_KEY: "sk-ant-FAKEFAKE0123456789" },
  );
  assert.equal(code, 1);
  assert.match(stderr, /BUDGET_INVALID_LIMITS/);
});

test("mock mode runs the whole pipeline without a key and with a perfect mirror", async () => {
  const { code, stdout } = await runCli(
    ["--mode", "mock", "--tasks", "judgement_primary,generation_fact", "--providers", "anthropic:claude-haiku-5-5"],
    READ_ENV,
  );
  assert.equal(code, 0);
  assert.match(stdout, /mode=mock/);
  assert.match(stdout, /"agreeWithRecorded":1/);
});

test("an unknown flag or task fails loudly", async () => {
  assert.equal((await runCli(["--bogus", "x"], READ_ENV)).code, 1);
  assert.equal((await runCli(["--tasks", "nonsense"], READ_ENV)).code, 1);
  assert.equal((await runCli(["--providers", "anthropic:claude-imaginary"], READ_ENV)).code, 1);
});
