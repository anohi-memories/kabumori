"""Replay main's first-parent history and list TASK-header vs ACTIVE-index mismatch episodes (read-only).

Usage (from a clone that has fetched origin/main):
  python3 -I .agent_v3/evidence/mismatch_scan.py --system v2 --start 4e80c79d --end 017583cc4040706bc9d3249a9e6ba9476f827723 --out v2.json
  python3 -I .agent_v3/evidence/mismatch_scan.py --system legacy --start 619a7526 --end 4e80c79d --out legacy.json

An episode starts at the first commit where a slot's TASK header and its index entry disagree on task_id /
status / next_owner, and ends at the first later commit where they agree again. The legacy index format
varies over time, so legacy counts are approximate.
"""
import argparse
import json
import re
import subprocess
from datetime import datetime

FIELDS = ("task_id", "status", "next_owner")
V2 = {
    "slots": [f"F{n}" for n in range(1, 11)] + [f"J{n}" for n in range(1, 6)],
    "task": lambda s: f".agent_v2/tasks/{s}.md",
    "index": ".agent_v2/ACTIVE_TASK.md",
    "heading": re.compile(r"^## ([FJ]\d+)\s*$"),
    "watch": lambda c: c.startswith(".agent_v2/tasks/") or c == ".agent_v2/ACTIVE_TASK.md",
}
LEGACY_TASK = {"G1": ".agent/tasks/CLAUDE_TASK_1.md", "G2": ".agent/tasks/CLAUDE_TASK.md", "H1": ".agent/tasks/CODEX_TASK.md"}
LEGACY_TASK.update({f"G{n}": f".agent/tasks/CLAUDE_TASK_{n}.md" for n in range(3, 11)})
LEGACY_TASK.update({f"H{n}": f".agent/tasks/CODEX_TASK_{n}.md" for n in range(2, 6)})
LEGACY = {
    "slots": [f"G{n}" for n in range(1, 11)] + [f"H{n}" for n in range(1, 6)],
    "task": lambda s: LEGACY_TASK[s],
    "index": ".agent/ACTIVE_TASK.md",
    "heading": re.compile(r"^## (?:Claude|Codex) ([GH]\d+)\s*$"),
    "watch": lambda c: c.startswith(".agent/tasks/") or c == ".agent/ACTIVE_TASK.md",
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", default=".")
    ap.add_argument("--system", choices=["v2", "legacy"], required=True)
    ap.add_argument("--start", required=True)
    ap.add_argument("--end", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    cfg = V2 if a.system == "v2" else LEGACY

    def git(*args):
        return subprocess.run(["git", "-C", a.repo, *args], capture_output=True, text=True, check=True).stdout

    cat = subprocess.Popen(["git", "-C", a.repo, "cat-file", "--batch"], stdin=subprocess.PIPE, stdout=subprocess.PIPE)

    def blob(rev, path):
        cat.stdin.write(f"{rev}:{path}\n".encode())
        cat.stdin.flush()
        head = cat.stdout.readline().decode()
        if head.endswith("missing\n"):
            return ""
        data = cat.stdout.read(int(head.split()[2]))
        cat.stdout.read(1)
        return data.decode("utf-8", "replace")

    def norm(v):
        return re.sub(r"[`*]", "", v).strip().split(" ")[0]

    def task_fields(text):
        out = {}
        for line in text.split("\n")[:30]:
            m = re.match(r"^- (task_id|status|next_owner): *(.*)$", line)
            if m and m.group(1) not in out:
                out[m.group(1)] = norm(m.group(2))
        return out

    def index_fields(text):
        res, cur = {}, None
        for line in text.split("\n"):
            m = cfg["heading"].match(line)
            if m:
                cur = m.group(1)
                res[cur] = {}
                continue
            if line.startswith("## "):
                cur = None
            m = re.match(r"^- (task_id|status|next_owner): *(.*)$", line)
            if cur and m and m.group(1) not in res[cur]:
                res[cur][m.group(1)] = norm(m.group(2))
        return res

    commits = [l.split("\x1f") for l in git("log", "--first-parent", "--reverse", "--format=%H\x1f%cI\x1f%s", f"{a.start}..{a.end}").splitlines()]
    one = multi = 0
    open_ep, episodes = {}, []
    for sha, date, subj in commits:
        changed = git("diff-tree", "--no-commit-id", "--name-only", "-r", sha).split()
        one += len(changed) == 1
        multi += len(changed) > 1
        if not any(cfg["watch"](c) for c in changed):
            continue
        idx = index_fields(blob(sha, cfg["index"]))
        for s in cfg["slots"]:
            t, i = task_fields(blob(sha, cfg["task"](s))), idx.get(s, {})
            diff = {k: [t.get(k), i.get(k)] for k in FIELDS if t.get(k) != i.get(k)}
            if diff and s not in open_ep:
                open_ep[s] = {"slot": s, "start_sha": sha, "start": date, "start_subject": subj, "start_changed": changed, "diff": diff}
            if diff and s in open_ep:
                open_ep[s]["last_diff"] = diff
            if not diff and s in open_ep:
                ep = open_ep.pop(s)
                ep.update(end_sha=sha, end=date, end_subject=subj, end_changed=changed,
                          minutes=round((datetime.fromisoformat(date) - datetime.fromisoformat(ep["start"])).total_seconds() / 60, 1))
                episodes.append(ep)
    for ep in open_ep.values():
        ep.update(end_sha=None, end=None, minutes=None)
        episodes.append(ep)
    buckets = {"<=2min": 0, "2-10min": 0, "10-60min": 0, ">60min": 0, "open": 0}
    for ep in episodes:
        m = ep["minutes"]
        buckets["open" if m is None else "<=2min" if m <= 2 else "2-10min" if m <= 10 else "10-60min" if m <= 60 else ">60min"] += 1
    summary = {"system": a.system, "start": a.start, "end": a.end, "commits": len(commits), "one_file_commits": one,
               "multi_file_commits": multi, "episodes": len(episodes), "buckets": buckets}
    json.dump({**summary, "episode_list": episodes}, open(a.out, "w"), ensure_ascii=False, indent=1)
    print(json.dumps(summary, ensure_ascii=False))


if __name__ == "__main__":
    main()
