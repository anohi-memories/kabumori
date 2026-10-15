// SDK 0.132.1 environment containment (F6, 2026-10-15). The SDK reads ANTHROPIC_CUSTOM_HEADERS on every client
// construction and merges it into the request headers; without containment a value there replaced x-api-key and
// added Authorization / arbitrary headers (reproduced offline before the fix). Fake provider only: no network, no key.
//   deno test --no-config --allow-env --allow-read supabase/functions/_shared/ai_provider/anthropic_env_containment_test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { ANTHROPIC_API_VERSION, ANTHROPIC_FORWARDED_HEADERS, containAnthropicHeaders } from "./anthropic_adapter.ts";
import { executeAiRequest } from "./execute.ts";
import { anthropicBody, FAKE_ANTHROPIC_KEY, jsonResponse, recordingFetch, sampleRequest, testDeps, VALID_PAYLOAD } from "./test_support.ts";

/** Runs `fn` with ANTHROPIC_CUSTOM_HEADERS set (or unset) and records every environment name the process reads. */
async function withEnv<T>(customHeaders: string | null, fn: () => Promise<T>): Promise<{ value: T; reads: string[] }> {
  const reads: string[] = [];
  const original = Deno.env.get.bind(Deno.env);
  const previous = original("ANTHROPIC_CUSTOM_HEADERS");
  if (customHeaders === null) Deno.env.delete("ANTHROPIC_CUSTOM_HEADERS");
  else Deno.env.set("ANTHROPIC_CUSTOM_HEADERS", customHeaders);
  Deno.env.get = (name: string) => {
    reads.push(name);
    return original(name);
  };
  try {
    return { value: await fn(), reads };
  } finally {
    Deno.env.get = original;
    if (previous === undefined) Deno.env.delete("ANTHROPIC_CUSTOM_HEADERS");
    else Deno.env.set("ANTHROPIC_CUSTOM_HEADERS", previous);
  }
}

async function oneCall() {
  const net = recordingFetch(() => jsonResponse(200, anthropicBody(VALID_PAYLOAD)));
  const result = await executeAiRequest(sampleRequest("anthropic"), testDeps(net.fetch).deps);
  return { result, headers: net.calls[0].headers };
}

const allowedName = (name: string) => ANTHROPIC_FORWARDED_HEADERS.has(name) || name.startsWith("x-stainless-");

test("an injected ANTHROPIC_CUSTOM_HEADERS cannot replace the key, add headers or change the API version", async () => {
  const { value: { result, headers } } = await withEnv(
    "X-Evil: injected\nx-api-key: attacker-key\nAuthorization: Bearer leak\nanthropic-version: 1999-01-01\naccept: text/html\ncontent-type: text/plain",
    oneCall,
  );
  assert.equal(result.ok, true);
  assert.equal(headers.get("x-api-key"), FAKE_ANTHROPIC_KEY, "always this adapter's key");
  assert.equal(headers.get("anthropic-version"), ANTHROPIC_API_VERSION);
  assert.equal(headers.get("accept"), "application/json");
  assert.equal(headers.get("content-type"), "application/json");
  assert.equal(headers.get("authorization"), null);
  assert.equal(headers.get("x-evil"), null);
  for (const name of headers.keys()) assert.ok(allowedName(name), `unexpected header ${name}`);
});

test("the SDK reads no environment value besides ANTHROPIC_CUSTOM_HEADERS (key, base URL, auth token, log, webhook)", async () => {
  const { reads } = await withEnv(null, oneCall);
  assert.deepEqual([...new Set(reads)].sort(), ["ANTHROPIC_CUSTOM_HEADERS"]);
});

test("without the variable the request carries exactly the SDK's own headers", async () => {
  const { value: { result, headers } } = await withEnv(null, oneCall);
  assert.equal(result.ok, true);
  const names = [...headers.keys()].sort();
  assert.deepEqual(names.filter((n) => !n.startsWith("x-stainless-")), ["accept", "anthropic-version", "content-type", "user-agent", "x-api-key"]);
  assert.ok(names.some((n) => n.startsWith("x-stainless-")), "SDK telemetry headers are kept");
});

test("containAnthropicHeaders also filters a Request input and keeps the body and method", async () => {
  const seen: Array<{ headers: Headers; method: string | undefined; body: unknown }> = [];
  const base = (_input: string | URL | Request, init?: RequestInit) => {
    seen.push({ headers: new Headers(init?.headers), method: init?.method, body: init?.body });
    return Promise.resolve(new Response("{}"));
  };
  const contained = containAnthropicHeaders(base, "key-under-test");
  await contained(new Request("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "x-api-key": "other", "x-extra": "1" } }), {
    method: "POST",
    body: "{\"a\":1}",
  });
  assert.deepEqual([...seen[0].headers.keys()].sort(), ["accept", "anthropic-version", "content-type", "x-api-key"]);
  assert.equal(seen[0].headers.get("x-api-key"), "key-under-test");
  assert.deepEqual([seen[0].method, seen[0].body], ["POST", "{\"a\":1}"]);
});
