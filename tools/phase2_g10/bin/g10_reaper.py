#!/usr/bin/env python3
"""S1（ランごとの期限監視）の入口（実行側）。"""
import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from g10runner import policy as policy_mod, signing, supervise  # noqa: E402
from g10runner.agent import Agent  # noqa: E402
from g10runner.layout import Layout  # noqa: E402


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--root", required=True)
    p.add_argument("--run-id", required=True)
    a = p.parse_args()
    layout = Layout(a.root)
    policy = policy_mod.load(layout.policy_pub)
    signer, verifier = signing.agent_side(a.root)
    return supervise.reaper_loop(layout, policy, Agent(layout, signer, verifier, policy), a.run_id)


if __name__ == "__main__":
    sys.exit(main())
