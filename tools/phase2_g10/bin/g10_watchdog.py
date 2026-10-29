#!/usr/bin/env python3
"""S2（監視エージェント）の入口（実行側）。実運用では launchd の KeepAlive つき Daemon（未導入）。"""
import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from g10runner import policy as policy_mod, release, supervise, wiring  # noqa: E402
from g10runner.agent import Agent  # noqa: E402
from g10runner.layout import Layout  # noqa: E402


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--root", required=True)
    p.add_argument("--interval", type=float, default=30.0)
    p.add_argument("--once", action="store_true")
    p.add_argument("--release-digest", help="固定版のマニフェストのハッシュ（固定版から動くときは必須。TASK 22）")
    a = p.parse_args()
    package = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    if release.package_manifest(package) is not None:
        problems = release.verify(package, a.release_digest or "")
        if problems:
            raise SystemExit("release verification failed: %s" % "; ".join(problems[:3]))
    elif a.release_digest:
        raise SystemExit("--release-digest is only for an installed release")
    layout = Layout(a.root)
    policy = policy_mod.load_current(layout)  # TASK 28: 正本と公開用が一致しなければ始めない
    signer, verifier = wiring.agent_side(a.root)
    agent = Agent(layout, signer, verifier, policy)
    if a.once:
        supervise.write_s2_heartbeat(layout)
        supervise.watchdog_cycle(layout, policy, agent)
        return 0
    supervise.watchdog_loop(layout, policy, agent, a.interval,
                            make_agent=lambda pol: Agent(layout, signer, verifier, pol))  # TASK 28: 周期ごとに読み直す
    return 0


if __name__ == "__main__":
    sys.exit(main())
