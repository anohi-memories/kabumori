// Prints the mode x state matrix (baseline vs full gate) as markdown. Usage: deno run --no-config tools/kabumori-pause/f8/print_table.ts
import { allRequests, baseWorld, BASELINE, FULL_GATE, handle, outwardTotal, type ActiveValue } from "./model.ts";

const states: Array<[string, Parameters<typeof baseWorld>[0]]> = [
  ["active", {}],
  ["paused(false)", { isActive: false }],
  ["unset", { isActive: undefined }],
  ["malformed", { isActive: "true" as ActiveValue }],
  ["read fails", { settingsReadFails: true }],
];
const cell = (c: ReturnType<typeof handle>) =>
  outwardTotal(c) === 0 ? "0" : `ai${c.ai}/http${c.http_external}/claim${c.db_claim}/w${c.db_write}/x${c.x_post}/push${c.push_enqueue}`;
const lines = [
  "| request | " + states.map(([name]) => `${name} baseline`).join(" | ") + " | paused gate |",
  "|---|" + states.map(() => "---").join("|") + "|---|",
];
for (const { name, req } of allRequests()) {
  const baseline = states.map(([, over]) => cell(handle(req, baseWorld(over), BASELINE)));
  const gated = states.slice(1).every(([, over]) => outwardTotal(handle(req, baseWorld(over), FULL_GATE)) === 0) ? "0 (all states)" : "NONZERO";
  lines.push(`| ${name} | ${baseline.join(" | ")} | ${gated} |`);
}
console.log(lines.join("\n"));
