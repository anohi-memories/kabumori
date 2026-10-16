import assert from "node:assert/strict";
import test from "node:test";
import {
  handleObserver, OBS_BASELINE, OBS_CANDIDATE, obsOutwardTotal, observerRequests, type ObsGate, type ObsWorld,
} from "./observer_model.ts";

const world = (over: Partial<ObsWorld> = {}): ObsWorld => ({ isActive: true, openAiKey: true, budgetAvailable: true, ...over });
const NOT_RUNNING: Array<[string, ObsWorld]> = [
  ["is_active=false", world({ isActive: false })], ["null", world({ isActive: null })], ["missing", world({ isActive: undefined })],
  ["malformed 'true'", world({ isActive: "true" })], ["malformed 1", world({ isActive: 1 })], ["read fails", world({ settingsReadFails: true })],
];

test("baseline: the observer has NO stop predicate — a paused news setting does not change anything it does", () => {
  for (const { name, req } of observerRequests()) {
    const running = handleObserver(req, world(), OBS_BASELINE);
    const paused = handleObserver(req, world({ isActive: false }), OBS_BASELINE);
    assert.deepEqual(paused, running, name);
    assert.ok(obsOutwardTotal(paused) > 0, `${name} still has outward effects`);
  }
  // web search spends AI money whenever it is enabled and budgeted
  assert.ok(handleObserver({ searchEnabled: true }, world({ isActive: false }), OBS_BASELINE).ai_search > 0);
});

test("candidate gate: every request shape x every non-running state has ZERO outward effects (one settings read only)", () => {
  for (const [state, w] of NOT_RUNNING) {
    for (const { name, req } of observerRequests()) {
      const c = handleObserver(req, w, OBS_CANDIDATE);
      assert.equal(obsOutwardTotal(c), 0, `${name} under ${state}: ${JSON.stringify(c)}`);
      assert.equal(c.db_read, 1, `${name} under ${state}`);
    }
  }
});

test("candidate gate: authentication is unchanged (401 / 405 before any setting read) and running behaves like the baseline", () => {
  assert.equal(handleObserver({ authorized: false }, world({ isActive: false }), OBS_CANDIDATE).status, "401");
  assert.equal(handleObserver({ authorized: false }, world({ isActive: false }), OBS_CANDIDATE).db_read, 0);
  assert.equal(handleObserver({ method: "GET" }, world({ isActive: false }), OBS_CANDIDATE).status, "405");
  for (const { name, req } of observerRequests()) {
    const a = handleObserver(req, world(), OBS_BASELINE);
    const b = handleObserver(req, world(), OBS_CANDIDATE);
    for (const kind of ["rpc_write", "http_external", "ai_search"] as const) assert.equal(b[kind], a[kind], `${name}: ${kind}`);
  }
});

test("in-flight: a pause set mid-run stops later feeds, search and persistence only with the egress guard", () => {
  const flipped = world({ flipAfterOutward: 2 });
  const noEgress = handleObserver({ searchEnabled: true, sources: 10 }, flipped, { entry: "after_auth", egress: false });
  const guarded = handleObserver({ searchEnabled: true, sources: 10 }, flipped, OBS_CANDIDATE);
  assert.ok(obsOutwardTotal(noEgress) > obsOutwardTotal(guarded));
  assert.equal(guarded.ai_search, 0, "the paid web search is not reached after the flip");
  assert.ok(obsOutwardTotal(guarded) <= 3);
});

test("repeated invocations (Cron / retry) while paused add nothing", () => {
  let total = 0;
  for (let i = 0; i < 100; i += 1) for (const { req } of observerRequests()) total += obsOutwardTotal(handleObserver(req, world({ isActive: false }), OBS_CANDIDATE));
  assert.equal(total, 0);
});

test("negative controls: a missing entry gate or egress guard is detected", () => {
  const violations = (gate: ObsGate) => NOT_RUNNING.flatMap(([state, w]) =>
    observerRequests().filter(({ req }) => obsOutwardTotal(handleObserver(req, w, gate)) > 0).map(({ name }) => `${name} under ${state}`));
  assert.ok(violations({ entry: "none", egress: false }).length > 0);
  assert.ok(violations({ entry: "none", egress: true }).length === 0, "the egress guard alone also stops an unflipped pause (defence in depth)");
  assert.equal(violations({ entry: "after_auth", egress: true }).length, 0);
  // the in-flight bound is what the egress guard adds
  const flipped = world({ flipAfterOutward: 1 });
  assert.ok(obsOutwardTotal(handleObserver({ sources: 8 }, flipped, { entry: "after_auth", egress: false })) >
    obsOutwardTotal(handleObserver({ sources: 8 }, flipped, OBS_CANDIDATE)));
});
