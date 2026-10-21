"""ローカルREPORT。仕様 v5 §10-4、v5.1 §4-5。

第1部＝実行係が記録した実行事実。第2部＝Claude（偽Claude）の自己申告と、GitHubへ投稿できる形の
REPORTの下書き。両者を混ぜない。GitHubへの投稿は G10担当ちゃが行う（このコードは投稿しない）。
"""
from . import jstclock
from .textutil import redact


def build(request, entry, result, checks, status, safety_violations):
    parsed = (result or {}).get("parsed") or {}
    self_report = redact(parsed.get("result", "")) if isinstance(parsed.get("result"), str) else ""
    lines = []
    lines.append("# REPORT_LOCAL（G10 Phase 2・偽Claudeのラン）")
    lines.append("")
    lines.append("## 第1部 実行事実（実行係が記録・検証）")
    lines.append("- run_id: %s" % request["run_id"])
    lines.append("- task_id: %s" % request["task_id"])
    lines.append("- approval_id: %s" % request["approval_id"])
    lines.append("- 承認の種類: %s" % request["authorization"])
    lines.append("- phase2_task_sha256: %s" % request["task_sha256"])
    lines.append("- policy_sha256: %s" % request["policy_sha256"])
    lines.append("- 指定モデル: %s（%s）" % (request["model"], request["model_id"]))
    usage = parsed.get("modelUsage")
    lines.append("- 実使用モデル: %s" % (", ".join(sorted(usage.keys())) if isinstance(usage, dict) else "不明"))
    lines.append("- base_ref / base_sha: %s / %s" % (request["base_ref"], request["base_sha"]))
    if entry:
        lines.append("- 登録簿の最終状態: %s（停止理由: %s）" % (entry.get("state"), entry.get("stop_reason", "なし")))
    lines.append("- 終了コード: %s" % (result or {}).get("exit_code", "不明"))
    lines.append("- 出力の raw_sha256: %s" % (result or {}).get("raw_sha256", "なし"))
    lines.append("- 状態（実行係の判定）: %s" % status)
    for name in sorted(checks):
        lines.append("- 確認 %s: %s" % (name, "OK" if checks[name] else "NG"))
    if safety_violations:
        lines.append("- 安全違反（観測）: %s" % "; ".join(safety_violations))
    lines.append("- 記録時刻: %s" % jstclock.jst_text((result or {}).get("ended_at", 0) or 0))
    lines.append("- 注意: これは実行の終了の記録で、受入ではない。K10は G10担当ちゃが判定する。")
    lines.append("")
    lines.append("## 第2部 Claudeの自己申告（未検証）")
    lines.append(self_report or "（自己申告なし）")
    lines.append("")
    lines.append("### GitHubへ投稿する形のREPORT（下書き・投稿は担当ちゃ）")
    lines.append("```")
    lines.append("type: REPORT")
    lines.append("task_id: %s" % request["task_id"])
    lines.append("next_task_allowed: false")
    lines.append("tests: なし（読み取り専用）。実行係の確認は第1部を参照")
    lines.append("changed_files: なし")
    lines.append("PR/HEAD: %s / %s" % (request["base_ref"], request["base_sha"]))
    lines.append("remaining_issues: 第2部の自己申告を担当ちゃが確認")
    lines.append("safety_checks: %s" % ("PASS（実行係の確認）" if status == "ended_checks_passed" else status))
    lines.append("return_to: G10担当ちゃ")
    lines.append("completion_code: K10")
    lines.append("```")
    # 伏せ字は、信頼できない第2部（自己申告）にだけ適用済み。第1部のハッシュ・SHAは監査のため残す。
    return "\n".join(lines) + "\n"
