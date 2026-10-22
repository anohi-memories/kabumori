"""H4（C4）独立再レビューの反例の固定。修正前HEAD（fa1967e8）では失敗し、修正後に通ることを確認する。

- P1-a: ENVELOPE だけ（人の CONFIRM なし）で、Issue #323 に発行されていない形式上有効なTASKが起動される。
- P1-b: /bin/ps が成功（自己PIDを含む）しつつ対象の子だけを欠いた一覧を返すと、停止・HALT解決・UNHALT が誤って完了する。
- P2:   signal の直前に開始時刻しか再照合しないため、exec で別の argv になった同じ pid に signal が届く。

修正前のコードでも動くように、振る舞いだけを使う（新しいAPIは getattr で存在するときだけ使う）。
"""
import json
import os
import subprocess
import sys
import time
from unittest import mock

from g10runner import procs, registry, supervise
from g10runner.fsutil import canonical
from helpers import EnvTestCase, TRUSTED_ISSUE, make_body

FICTITIOUS_TASK_ID = "g10-phase2-not-published-20261022"


def publish(env, body):
    """修正後のコード: 模擬の Issue #323 に本文を載せる（修正前のコードには Issue の取得がない）。"""
    issue = getattr(env, "issue", None)
    if issue is not None:
        issue.publish(body)


class P1UnpublishedTask(EnvTestCase):
    def setUp(self):
        super().setUp()
        self.env.envelope()  # 人の CONFIRM は0件
        self.env.s2_heartbeat()
        self.marker = os.path.join(self.env.tmp, "started")

    def assert_not_launched(self, run_id):
        if run_id is not None:
            stub, reason = self.env.agent.handle_request_file(self.env.layout.request_file(run_id),
                                                              scenario={"started_marker": self.marker})
            if stub is not None:
                stub.wait(timeout=30)
                self.wait_terminal(run_id)
            self.assertIsNone(stub, "an unpublished TASK was accepted and launched")
        self.assertEqual([r for r in self.env.agent.used.read_all() if r["type"] == "ACCEPTED"], [])
        self.assertFalse(os.path.exists(self.marker), "fake Claude was started for an unpublished TASK")

    def test_envelope_does_not_run_a_task_absent_from_the_issue(self):
        publish(self.env, make_body(self.env.policy))  # Issue には別の（正規の）TASK
        fict = make_body(self.env.policy, task_id=FICTITIOUS_TASK_ID, approval_id="g10-p2-test-0099")
        run_id, reason = self.env.control.try_claim(fict, TRUSTED_ISSUE, time.time())
        self.assert_not_launched(run_id)

    def test_runner_key_cannot_swap_in_an_unpublished_task(self):
        """正規のTASKで発行された要求を、runner 鍵だけで架空のTASKに差し替えて再署名しても受理されない。"""
        body = make_body(self.env.policy)
        publish(self.env, body)
        run_id, reason = self.env.control.try_claim(body, TRUSTED_ISSUE, time.time())
        self.assertIsNotNone(run_id, reason)
        path = self.env.layout.request_file(run_id)
        doc = json.load(open(path))
        fict = make_body(self.env.policy, task_id=FICTITIOUS_TASK_ID, approval_id="g10-p2-test-0098")
        from g10runner import norm
        doc["request"].update(prompt=fict, task_id=FICTITIOUS_TASK_ID, approval_id="g10-p2-test-0098",
                              task_sha256=norm.compute_hash(fict))
        doc["sig"] = self.env.control_signer.sign("runner", canonical(doc["request"]))
        json.dump(doc, open(path, "w"))
        self.assert_not_launched(run_id)


class P1PartialPs(EnvTestCase):
    def setUp(self):
        super().setUp()
        self.env.envelope()
        self.env.s2_heartbeat()

    def test_ps_list_missing_the_child_is_not_absence(self):
        body = make_body(self.env.policy, max_minutes="60")
        publish(self.env, body)
        run_id, stub, body = self.claim_and_run(body=body, scenario={"sleep": 30}, wait=False)
        deadline = time.time() + 20
        e = None
        while time.time() < deadline:
            e = registry.load(self.env.layout, run_id)
            if e and e["state"] == "running":
                break
            time.sleep(0.05)
        child = e["child_pid"]
        real_run = subprocess.run

        def partial_ps(args, *a, **kw):
            out = real_run(args, *a, **kw)
            if isinstance(args, list) and "-axww" in args:
                lines = [ln for ln in out.stdout.splitlines() if ln.split()[:1] != [str(child)]]
                out = subprocess.CompletedProcess(out.args, out.returncode, "\n".join(lines) + "\n", out.stderr)
            return out

        try:
            with mock.patch.object(procs.subprocess, "run", side_effect=partial_ps):
                absent = supervise.stop_run(self.env.layout, self.env.policy, self.env.agent, e,
                                            "emergency_stop", "test")
                child_alive = procs.pid_status(child) == "alive" if hasattr(procs, "pid_status") \
                    else os.path.exists("/proc/%d" % child)
                if absent:
                    self.assertFalse(child_alive, "stop reported absent while the child was still alive")
                result = self.env.control.halt("hard", "partial ps", wait_sync=1.0)
                rec, problems = self.env.control.unhalt("try")
                child_alive = self._alive(child)
                if result.get("resolved") or rec is not None:
                    self.assertFalse(child_alive, "HALT resolved / UNHALT allowed while the child was alive")
        finally:
            try:
                os.kill(child, 9)
            except OSError:
                pass
            stub.wait(timeout=30)

    @staticmethod
    def _alive(pid):
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return False
        out = subprocess.run(["/bin/ps", "-o", "stat=", "-p", str(pid)], capture_output=True, text=True)
        return bool(out.stdout.strip()) and not out.stdout.strip().startswith("Z")


EXEC_LATER = ("import os, sys, time\n"
              "time.sleep(0.6)\n"
              "os.execv(sys.executable, [sys.executable, '-c', 'import time; time.sleep(30)'])\n")


class P2SignalReverify(EnvTestCase):
    def setUp(self):
        super().setUp()
        self.env.envelope()
        self.env.s2_heartbeat()

    def test_exec_to_other_argv_is_not_signalled(self):
        body = make_body(self.env.policy)
        publish(self.env, body)
        run_id, stub, body = self.claim_and_run(body=body)
        e = registry.load(self.env.layout, run_id)
        p = subprocess.Popen([sys.executable, "-I", "-c", EXEC_LATER, "--session-id", e["session_id"],
                              "--settings", e["settings_path"]],
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.addCleanup(lambda: (p.poll() is None and p.kill(), p.wait(timeout=10)))
        time.sleep(0.3)
        collect = supervise.collector(self.env.layout, e)
        stale = collect()
        self.assertIn(p.pid, stale, "the decoy should match the run identity before exec")
        time.sleep(1.0)  # exec で argv が変わる（pid・開始時刻は同じ）
        calls = []

        def stale_then_live():
            calls.append(1)
            return dict(stale) if len(calls) == 1 else collect()
        if hasattr(collect, "verify"):
            stale_then_live.verify = collect.verify
        procs.terminate(stale_then_live, 0.3, 0.5)
        time.sleep(0.2)
        self.assertIsNone(p.poll(), "a process whose argv changed by exec was signalled")
