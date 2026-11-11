import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { api, collect } from "./github.ts";
import { classify, type Slot, SLOTS, type Snapshot } from "./model.ts";
import { queueSession, runSession } from "./record.ts";

const args = process.argv.slice(2), command = args.shift();
const optionArgs = args.includes("--") ? args.slice(0, args.indexOf("--")) : args;
const value = (flag: string) => {
  const n = optionArgs.indexOf(flag);
  return n < 0 ? undefined : optionArgs[n + 1];
};
const slot = value("--slot") as Slot | undefined;
if (slot && !(slot in SLOTS)) throw new Error("unknown slot");
if (command === "F" || command === "f") {
  const file = value("--snapshot");
  const snapshots: Snapshot[] = file
    ? JSON.parse(readFileSync(file, "utf8"))
    : Object.keys(SLOTS).map((s) => collect(s as Slot, api(), args.includes("--audit")));
  if (
    !Array.isArray(snapshots) || snapshots.length !== 15 || new Set(snapshots.map((s) => s.slot)).size !== 15 ||
    snapshots.some((s) => !(s.slot in SLOTS))
  ) throw new Error("F requires exactly the current 15 unique slots");
  const rows = snapshots.map((s) => classify(s));
  if (args.includes("--json")) console.log(JSON.stringify(rows, null, 2));
  else {
    console.log("| 枠 | Issue | 判定 | 根拠 |\n|---|---|---|---|");
    for (const r of rows) {
      console.log(
        `| ${r.slot} | #${r.issue} | ${r.label}${r.delayed ? "（状態更新遅延・証拠あり）" : ""} | ${
          r.reason.replaceAll("|", "/")
        } |`,
      );
    }
    console.log("\n判定は取得時点の観測。本番 NO_GO。TASK更新・受入・自動起動は行いません。");
  }
} else if (command === "queue") {
  const taskId = value("--task-id");
  if (!slot || !taskId || !optionArgs.includes("--all-starts-instrumented")) {
    throw new Error("queue requires --slot, --task-id and explicit --all-starts-instrumented rollout acknowledgement");
  }
  console.log(queueSession(slot, taskId, api(), optionArgs.includes("--publish")));
} else if (command === "run") {
  const marker = args.indexOf("--"), taskId = value("--task-id"), directory = value("--worktree");
  if (!slot || !taskId || !directory || marker < 0) {
    throw new Error(
      "run --slot Gn/Hn --task-id ID --worktree PATH --start-gates-passed [--publish] -- authorized-command",
    );
  }
  console.log(
    JSON.stringify(
      await runSession({
        slot,
        taskId,
        directory: resolve(directory),
        command: args.slice(marker + 1),
        call: api(),
        live: optionArgs.includes("--publish"),
        gatePassed: optionArgs.includes("--start-gates-passed"),
      }),
    ),
  );
} else throw new Error("Use exact F/f [--snapshot file] [--audit] [--json], or explicit run. F1/F10 are not F.");
