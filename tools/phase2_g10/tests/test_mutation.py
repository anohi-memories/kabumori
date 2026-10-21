"""ミューテーション確認: 安全ゲートを1つずつ壊したコピーで、対応する試験が失敗することを確認する。

各ミューテーションは、パッケージの一時コピーに対して文字列の置換で作る（元のファイルは変更しない）。
置換対象の文字列が見つからない場合も失敗にする（試験が古くなったことを検知するため）。
"""
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

PKG = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

MUTANTS = [
    ("final check ignores HALT", "g10runner/stub.py",
     'if st.halted or state.flags_say_halt(layout):\n        return "halted"', "if False:\n        pass",
     "test_race_halt.TestRace.test_soft_halt_before_final_check_blocks_spawn"),
    ("final check ignores authorization", "g10runner/stub.py",
     "if not state.authorization_ok(st, req, local_now, reference_now):\n        return \"not authorized at final check\"",
     "if False:\n        pass", "test_race_halt.TestRace.test_revoke_before_final_check_blocks_spawn"),
    ("control events appended without exclusive lock", "g10runner/control.py",
     'with FileLock(self.layout.halt_lock, "ex", timeout=timeout) as lock:',
     'with FileLock(self.layout.halt_lock, "sh", timeout=timeout) as lock:',
     "test_race_halt.TestRace.test_revoke_and_stop_events_wait_for_critical_section"),
    ("used_requests uniqueness removed", "g10runner/agent.py",
     'return False, "request/approval/run already used"', "pass",
     "test_gate_accept.TestAccept.test_replay_rejected"),
    ("rewind check removed", "g10runner/state.py",
     'raise RewindError("control log rewound (seen %d > current %d)" % (seen["seq"], n))', "pass",
     "test_logs_state.TestState.test_rewind_detection"),
    ("approval reuse allowed", "g10runner/control.py",
     'return False, "approval_id already used"', "pass",
     "test_gate_accept.TestClaim.test_approval_id_used_once"),
    ("outside-region field rule removed", "g10runner/meta.py",
     'r.fail("known field outside the formal region: %s (line %d)" % (key, i + 1))', "pass",
     "test_meta.TestRejections.test_known_field_outside_region_rejected"),
    ("hash line count in region not checked", "g10runner/norm.py",
     "if len(in_region) != 1:", "if False:", "test_norm.TestVectors.test_v6_two_hash_lines"),
    ("model check disabled", "g10runner/control.py",
     "checks[\"model_matches\"] = model_ok", "model_ok = True\n        checks[\"model_matches\"] = model_ok",
     "test_launch.TestLaunch.test_model_mismatch_is_safety_violation"),
    ("unhalt ignores completion problems", "g10runner/control.py",
     "            if problems:\n                return None, problems", "            pass",
     "test_race_halt.TestHaltUnhalt.test_unhalt_refused_while_process_present"),
    ("partial UNHALT accepted", "g10runner/state.py",
     "if halt_ids != set(st.control_halts.keys()) or agent_ids != expected_agent:", "if False:",
     "test_logs_state.TestState.test_partial_unhalt_is_ignored"),
    ("envelope expiry ignored", "g10runner/jstclock.py",
     "return local_now < expires_at and reference_now < expires_at", "return True",
     "test_gate_accept.TestClaim.test_envelope_expiry_at_0400_jst"),
    ("breaker disabled", "g10runner/control.py",
     'return False, "breaker (consecutive failures)"', "pass", "test_gate_accept.TestClaim.test_breaker"),
    ("rate guard disabled", "g10runner/control.py",
     'return False, "rate guard (too many starts in window)"', "pass",
     "test_gate_accept.TestClaim.test_rate_guard_and_unlimited_daily"),
    ("registry immutable check removed", "g10runner/registry.py",
     'raise RegistryError("immutable fields changed: " + run_id)', "pass",
     "test_recovery.TestOrphansAndTamper.test_registry_tamper_detected_by_watchdog"),
    ("S2 heartbeat not required", "g10runner/stub.py",
     "if not supervise.s2_fresh(layout, policy):", "if False:",
     "test_launch.TestLaunch.test_s2_unavailable_blocks_spawn"),
    ("lock fd inherited by child", "g10runner/fsutil.py",
     "self.fd = os.open(self.path, os.O_RDONLY)",
     "self.fd = os.open(self.path, os.O_RDONLY)\n        os.set_inheritable(self.fd, True)",
     "test_race_halt.TestRace.test_lock_fd_not_inherited_by_fake_claude"),
]


def run_mutant(rel, old, new, test_id):
    tmp = tempfile.mkdtemp(prefix="g10mut-", dir="/tmp")
    try:
        dst = os.path.join(tmp, "phase2_g10")
        shutil.copytree(PKG, dst, ignore=shutil.ignore_patterns("__pycache__"))
        path = os.path.join(dst, rel)
        with open(path, encoding="utf-8") as f:
            text = f.read()
        if old not in text:
            return "pattern-missing"
        with open(path, "w", encoding="utf-8") as f:
            f.write(text.replace(old, new, 1))
        if "inheritable" in new:
            # fd を継承させても、子に渡すには close_fds を外す必要がある
            stub = os.path.join(dst, "g10runner", "stub.py")
            s = open(stub, encoding="utf-8").read()
            s = s.replace("stdout=out, stderr=err, close_fds=True)", "stdout=out, stderr=err, close_fds=False)")
            open(stub, "w", encoding="utf-8").write(s)
        proc = subprocess.run([sys.executable, os.path.join(dst, "run_tests.py"), test_id],
                              capture_output=True, text=True, timeout=300)
        return "killed" if proc.returncode != 0 else "survived"
    finally:
        for dirpath, dirnames, filenames in os.walk(tmp):
            try:
                os.chmod(dirpath, 0o700)
            except OSError:
                pass
        shutil.rmtree(tmp, ignore_errors=True)


class TestMutants(unittest.TestCase):
    def test_each_safety_gate_is_covered(self):
        for name, rel, old, new, test_id in MUTANTS:
            with self.subTest(mutant=name):
                self.assertEqual(run_mutant(rel, old, new, test_id), "killed")


if __name__ == "__main__":
    unittest.main()
