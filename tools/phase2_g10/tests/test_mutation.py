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
    # --- H3 R1〜R3（TASK 2）---
    ("request prompt hash binding removed", "g10runner/binding.py",
     'if computed != fields["phase2_task_sha256"] or computed != req["task_sha256"]:', "if False:",
     "test_issue_binding.AgentSide.test_task_hash_field_must_match_the_body"),
    ("request execution fields not compared with the TASK", "g10runner/binding.py",
     "if req[req_key] != fields[meta_key]:", "if False:",
     "test_review_regressions.R1Binding.test_runner_only_resign_cannot_widen_execution_fields"),
    # binding の model→model_id 照合は meta.validate_task と二重（片方だけ壊しても残る）ので、ここでは対象外
    ("layout containment removed", "g10runner/layout.py",
     "if os.path.dirname(os.path.realpath(path)) != real_base:", "if False:",
     "test_procs_identity.TestLayoutContainment.test_run_paths_stay_under_their_base"),
    ("finalize trusts the request instead of the CLAIM", "g10runner/control.py",
     'checks["request_matches_claim"] = bool(claim) and binding.request_matches_claim(req, claim)',
     'checks["request_matches_claim"] = True',
     "test_review_regressions.R1Binding.test_finalize_does_not_trust_request_model"),
    ("finalize model check uses the request model", "g10runner/control.py",
     'approved_model_id = claim.get("model_id") if claim else None\n'
     '        if claim and self.policy.get("models", {}).get(claim.get("model")) != approved_model_id:\n'
     '            approved_model_id = None',
     'approved_model_id = req["model_id"]',
     "test_review_regressions.R1Binding.test_finalize_does_not_trust_request_model"),
    ("ps failure becomes an empty list", "g10runner/procs.py",
     'raise ObservationError("ps exited with %d" % rc)', "return []",
     "test_procs_identity.TestObservationFailures.test_ps_nonzero_exit"),
    ("partial process list accepted", "g10runner/procs.py",
     'raise ObservationError("partial process list (own process missing)")', "pass",
     "test_procs_identity.TestObservationFailures.test_partial_list_without_own_process"),
    ("unknown observation treated as absent in stop_run", "g10runner/supervise.py",
     'absent = details["absent"] and not details["unknown"]\n    run_id',
     'absent = details["absent"] or details["unknown"]\n    run_id',
     "test_review_regressions.R2Observation.test_ps_failure_is_not_absence"),
    ("UNHALT completion ignores unknown observation", "g10runner/control.py",
     'if present is None:\n                problems.append("process observation unavailable: " + run_id)',
     "if False:\n                pass",
     "test_review_regressions.R2Observation.test_unhalt_completion_check_counts_unknown_observation"),
    ("finalize treats unknown observation as absent", "g10runner/control.py",
     "absent = present is False", "absent = present is not True",
     "test_review_regressions.R2Observation.test_finalize_with_ps_failure_is_not_success"),
    ("identity by substring", "g10runner/procs.py",
     "return (sessions == [ident.session_id] and len(settings) == 1",
     "return (ident.session_id in \" \".join(av) and len(settings) == 1",
     "test_review_regressions.R3Identity.test_session_prefix_collision_is_not_stopped"),
    ("settings not part of identity", "g10runner/procs.py",
     "and os.path.realpath(settings[0]) == ident.settings_path)", "and True)",
     "test_review_regressions.R3Identity.test_same_session_other_settings_is_not_stopped"),
    ("uid not part of identity", "g10runner/procs.py",
     'if info is None or info["zombie"] or info["uid"] != ident.uid:',
     'if info is None or info["zombie"]:',
     "test_procs_identity.TestIdentity.test_live_exact_argv_and_uid"),
    ("start time not re-verified before signal", "g10runner/supervise.py",
     "if not start or procs.start_time(pid) != start:", "if not start:",
     "test_observation_h4.CollectorVerify.test_verify_requires_start_uid_and_argv"),
    ("missing start time accepted as identity", "g10runner/procs.py",
     "    if not expected_start:\n        return False\n    if pid_status(pid) != \"alive\":\n        return False\n    return start_time(pid) == expected_start",
     "    if pid_status(pid) != \"alive\":\n        return False\n    return not expected_start or start_time(pid) == expected_start",
     "test_procs_identity.TestIdentity.test_missing_start_time_is_not_identity"),
    # --- H4 P1/P1/P2（TASK 3）---
    ("control does not check the fetched Issue", "g10runner/control.py",
     "        if problem:\n            return None, \"issue binding: \" + problem", "        pass",
     "test_issue_binding.ControlSide.test_unpublished_task_refused"),
    ("agent does not check the Issue evidence", "g10runner/agent.py",
     "        if reason:\n            return \"issue binding: \" + reason", "        pass",
     "test_review_regressions_h4.P1UnpublishedTask.test_runner_key_cannot_swap_in_an_unpublished_task"),
    ("stub final check ignores the Issue evidence", "g10runner/stub.py",
     "    if reason:\n        return \"issue binding: \" + reason", "    pass",
     "test_issue_binding.StubFinalCheck.test_evidence_stale_by_final_check_aborts"),
    ("Issue body equality not checked", "g10runner/issue.py",
     'if not isinstance(body, str) or sha256_hex(body.encode("utf-8")) != ev["body_sha256"]:',
     "if not isinstance(body, str):",
     "test_issue_binding.ControlSide.test_body_whitespace_change_is_not_the_same_body"),
    ("witness signature not verified", "g10runner/issue.py",
     'if not verifier.verify("witness", canonical(ev), doc["sig"]):', "if False:",
     "test_issue_binding.AgentSide.test_evidence_signed_with_runner_key"),
    ("stale Issue evidence accepted", "g10runner/issue.py",
     "if age > max_age or age < -jstclock.CLOCK_TOLERANCE_SECONDS:", "if False:",
     "test_issue_binding.AgentSide.test_stale_evidence"),
    ("closed Issue accepted", "g10runner/issue.py",
     'if ev["state"] != "OPEN":', "if False:",
     "test_issue_binding.AgentSide.test_evidence_for_closed_issue"),
    ("untrusted Issue editor accepted", "g10runner/issue.py",
     'if ev["author"] != TRUSTED_LOGIN or ev["editor"] not in (None, TRUSTED_LOGIN):',
     'if ev["author"] != TRUSTED_LOGIN:',
     "test_issue_binding.ControlSide.test_issue_conditions"),
    ("CLAIM does not bind the Issue evidence", "g10runner/binding.py",
     'return isinstance(ev, dict) and issue.evidence_digest(ev) == claim_payload.get("issue_evidence_sha256")',
     "return True",
     "test_issue_binding.AgentSide.test_finalize_detects_evidence_swapped_after_run"),
    ("kernel enumeration dropped (ps only)", "g10runner/procs.py",
     'pids = kernel_pids() | {row["pid"] for row in snapshot()}', 'pids = {row["pid"] for row in snapshot()}',
     "test_observation_h4.UnionObservation.test_ps_list_missing_target_still_found_via_kernel"),
    ("ps dropped (kernel only)", "g10runner/procs.py",
     'pids = kernel_pids() | {row["pid"] for row in snapshot()}', "pids = kernel_pids()",
     "test_review_regressions.R2Observation.test_ps_failure_is_not_absence"),
    ("registered child not checked directly", "g10runner/supervise.py",
     "            targets.setdefault(child_pid, child_start)", "            pass",
     "test_observation_h4.RegisteredChildDirect.test_both_lists_missing_child"),
    ("argv not re-verified before signal", "g10runner/supervise.py",
     "        return is_stub(pid, start) or procs.run_process_matches(pid, ident)", "        return True",
     "test_review_regressions_h4.P2SignalReverify.test_exec_to_other_argv_is_not_signalled"),
    ("signal-time verification error ignored", "g10runner/procs.py",
     "        except ObservationError as exc:\n            details[\"unknown\"] = True\n            details.setdefault",
     "        except ObservationError as exc:\n            os.kill(pid, sig)\n            details.setdefault",
     "test_procs_identity.TestIdentity.test_verify_error_is_unknown_and_not_signalled"),
    ("zombie/exiting disagreement treated as absent", "g10runner/procs.py",
     '    raise ObservationError("cannot read kernel info of pid %d (%s)" % (pid, detail))', "    return None",
     "test_observation_h4.KernelDisagreement.test_kill_says_alive_but_kernel_has_no_info"),
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
