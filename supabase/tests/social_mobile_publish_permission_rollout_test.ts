// The approved rollout order of the publish-permission boundary (H2 finding F3), checked as a state
// machine. The plan is the `rollout-plan` block in social_mobile_publish_permission.md (section 6); this
// test walks the forward sequence and every abort path from every step and requires that NO reachable
// state lets the new switch be used while an older sender (one that never asks for permission) may still
// be running. The states themselves are proven on a disposable database by
// social_mobile_publish_permission_rollout_e2e_test.ts (guarded runtime, migration not applied) and
// social_mobile_publish_permission_e2e_test.ts (after the migration). No network, no database.
// PUB_ROLLOUT_DOC=<file> checks another copy (social_mobile_publish_permission_mutations.sh).
import assert from "node:assert/strict";
import test from "node:test";

type Runtime = "old" | "guarded";
type State = {
  /** x-test-post versions that may still be executing. */
  runtime: Runtime[];
  /** set_social_account_publish_enabled callable by `authenticated` (directly, or through the Edge function). */
  toggle: "absent" | "usable" | "revoked";
  /** assert_x_publish_permission_for_legacy_post callable by `service_role`. */
  check: "absent" | "present" | "revoked";
  edge: "absent" | "deployed";
  app: "hidden" | "shown";
};
type Step = { id: string; action: string; set: Partial<State> };
type Plan = { initial: State; steps: Step[]; aborts: Array<{ from: string[]; steps: Step[] }> };

const docPath = Deno.env.get("PUB_ROLLOUT_DOC") ?? new URL("./social_mobile_publish_permission.md", import.meta.url).pathname;
const doc = await Deno.readTextFile(docPath);
const block = /```rollout-plan\n([\s\S]*?)\n```/u.exec(doc);
assert.ok(block, "the document has a rollout-plan block");
const plan = JSON.parse(block[1]) as Plan;

const apply = (state: State, step: Step): State => ({ ...state, ...step.set });
const show = (state: State) => JSON.stringify(state);
/** The one safety property: the switch is usable only when every sender that may run checks permission. */
function failClosed(state: State): boolean {
  return state.toggle !== "usable" || (state.runtime.length === 1 && state.runtime[0] === "guarded");
}
/** Every state the forward sequence passes through, after each step. */
function forwardStates(): Array<{ id: string; state: State }> {
  const out: Array<{ id: string; state: State }> = [];
  let state = plan.initial;
  for (const step of plan.steps) {
    state = apply(state, step);
    out.push({ id: step.id, state });
  }
  return out;
}

test("the plan starts from production today and ends fully rolled out", () => {
  assert.deepEqual(plan.initial, { runtime: ["old"], toggle: "absent", check: "absent", edge: "absent", app: "hidden" });
  const states = forwardStates();
  assert.deepEqual(states.at(-1)?.state, { runtime: ["guarded"], toggle: "usable", check: "present", edge: "deployed", app: "shown" });
  assert.equal(new Set(plan.steps.map((step) => step.id)).size, plan.steps.length, "step ids are unique");
});

test("forward: every state fails closed; old runtime and a usable switch never coexist", () => {
  for (const { id, state } of [{ id: "initial", state: plan.initial }, ...forwardStates()]) {
    assert.ok(failClosed(state), `after ${id}: ${show(state)}`);
  }
});

test("forward order: guarded runtime only and the check in place before the switch; the Edge function and the app control last", () => {
  for (const { id, state } of forwardStates()) {
    if (state.toggle === "usable") assert.equal(state.check, "present", `after ${id}: the switch before the check`);
    if (state.edge === "deployed") assert.equal(state.toggle, "usable", `after ${id}: the Edge function before the switch`);
    if (state.app === "shown") assert.equal(state.edge, "deployed", `after ${id}: the app control before the Edge function`);
  }
  // The switch arrives in a step of its own, after a step that drained the old runtime.
  const ids = plan.steps.map((step) => step.id);
  const migration = plan.steps.findIndex((step) => step.set.toggle === "usable");
  assert.ok(migration > 0, "the migration is a step");
  const drained = plan.steps.findIndex((step) => JSON.stringify(step.set.runtime) === '["guarded"]');
  assert.ok(drained >= 0 && drained < migration, `the old runtime is drained before ${ids[migration]}`);
  // A read-back step (no state change) directly follows the migration, before anything is exposed.
  assert.deepEqual(plan.steps[migration + 1]?.set, {}, "a read-back step follows the migration");
});

test("abort: every step after the preflight has an explicit abort path, and every state on it fails closed", () => {
  const states = forwardStates();
  for (const [index, step] of plan.steps.entries()) {
    const paths = plan.aborts.filter((abort) => abort.from.includes(step.id));
    if (index === 0) {
      assert.deepEqual(step.set, {}, "the first step is a read-only preflight");
      continue;
    }
    assert.equal(paths.length, 1, `exactly one abort path after ${step.id}`);
    let state = states[index].state;
    for (const undo of paths[0].steps) {
      state = apply(state, undo);
      assert.ok(failClosed(state), `abort after ${step.id}, ${undo.id}: ${show(state)}`);
    }
    // The end of an abort: no old sender next to a usable switch, and nothing user-facing left half-working.
    assert.ok(state.toggle !== "usable" || state.runtime.every((r) => r === "guarded"), `abort after ${step.id} ends unsafe`);
  }
  for (const abort of plan.aborts) {
    for (const from of abort.from) assert.ok(plan.steps.some((step) => step.id === from), `abort from unknown step ${from}`);
  }
});

test("abort: the runtime is rolled back to the old sender only after the switch is unusable", () => {
  const states = forwardStates();
  for (const abort of plan.aborts) {
    for (const from of abort.from) {
      let state = states[plan.steps.findIndex((step) => step.id === from)].state;
      for (const undo of abort.steps) {
        const next = apply(state, undo);
        if (next.runtime.includes("old") && !state.runtime.includes("old")) {
          assert.notEqual(next.toggle, "usable", `abort after ${from}, ${undo.id}: old runtime while the switch is usable`);
        }
        state = next;
      }
    }
  }
});
