#!/usr/bin/env python3
"""S5: narrow real-AI smoke of the AI consultation V1 with ONE dedicated test account. No posts.

Usage: smoke.py <out_dir>   (called by `run.sh s5`; prompts for the test account on the terminal)

Exactly what the app does, nothing more:
  consult (proposal, no write) -> explicit confirmation = one versioned (CAS) write of the proposed delta
  -> read-back -> fresh consult -> dry-run preview; plus denial checks (no JWT, another workspace,
  stale version). Paid model calls: at most 3 (2 consults + 1 preview); no retries.
The email, password, access token and API key are never printed, stored or logged. The session is
signed out at the end. Results (codes, kinds, field names, counts) go to <out_dir>/s5_smoke.json.
"""
import getpass
import json
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

REF = "wsmznyzcvmuitkglfeuj"
BASE = f"https://{REF}.supabase.co"
FOREIGN_BRAND = "kabumori"  # exists and is never owned by a social-mobile test account
TABLE = "social_mobile_content_settings"
DEFAULTS = {
    "locale": "ja-JP",
    "preferredTone": "自然で親しみやすく、押しつけない",
    "themes": ["日々の生活や仕事に役立つ小さな工夫"],
    "objective": "読者にひとつの実用的な気づきを届ける",
    "frequencyTargetPerWeek": 3,
    "approvalMode": "manual_review",
    "generationWindow": {"timezone": "Asia/Tokyo", "startLocal": "09:00", "endLocal": "24:00",
                         "defaultGenerationLocal": "17:00", "generationDayOffset": -1},
    "optionalNgWords": [],
    "notes": "",
}
SETTINGS_DELTA_KEYS = {"preferredTone", "themes", "objective", "frequencyTargetPerWeek", "optionalNgWords", "notes"}
PROPOSAL_MESSAGE = ("投稿は週4回にしたいです。トーンは、やわらかく親しみやすい感じでお願いします。"
                    "絵文字は控えめにして、最後は読者への問いかけで締めたいです。")
EXPLAIN_MESSAGE = "今どういう設定になっていますか？"

results = {"steps": [], "model_calls": 0}
failures = []


def record(name, ok, **detail):
    results["steps"].append({"step": name, "ok": ok, **detail})
    print(("PASS " if ok else "FAIL ") + name + ("" if not detail else " " + json.dumps(detail, ensure_ascii=False)))
    if not ok:
        failures.append(name)


def anon_key():
    for flags in (["--output-format", "json"], ["-o", "json"]):
        proc = subprocess.run(["supabase", "projects", "api-keys", "--project-ref", REF, *flags],
                              capture_output=True, text=True)
        try:
            data = json.loads(proc.stdout)
        except ValueError:
            continue
        if isinstance(data, dict):
            data = next((v for v in data.values() if isinstance(v, list)), [])
        key = next((item.get("api_key") for item in data if isinstance(item, dict) and item.get("name") == "anon"), None)
        del data, proc  # only the public anon key is kept
        if key:
            return key
    raise SystemExit("STOP S5: could not read the project's anon key")


def http(method, path, *, apikey=None, token=None, body=None, prefer=None):
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    if apikey:
        headers["apikey"] = apikey
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if prefer:
        headers["Prefer"] = prefer
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(BASE + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            raw, status = response.read(), response.status
    except urllib.error.HTTPError as error:
        raw, status = error.read(), error.code
    try:
        return status, json.loads(raw) if raw else None
    except ValueError:
        return status, None


def main(out_dir):
    key = anon_key()
    email = input("Test account email (not stored): ").strip()
    password = getpass.getpass("Test account password (hidden, not stored): ")
    status, body = http("POST", "/auth/v1/token?grant_type=password", apikey=key, body={"email": email, "password": password})
    del email, password
    if status != 200 or not isinstance(body, dict) or not body.get("access_token"):
        raise SystemExit(f"STOP S5: sign-in failed (HTTP {status})")
    token, user_id = body["access_token"], (body.get("user") or {}).get("id")
    del body
    try:
        run(key, token, user_id)
    finally:
        status, _ = http("POST", "/auth/v1/logout?scope=local", apikey=key, token=token)
        record("sign_out", status in (200, 204), http=status)
    results["verdict"] = "PASS" if not failures else "FAIL"
    results["failures"] = failures
    with open(f"{out_dir}/s5_smoke.json", "w", encoding="utf-8") as handle:
        json.dump(results, handle, ensure_ascii=False, indent=1)
    print(f"S5_SMOKE_{results['verdict']} (model calls: {results['model_calls']})")
    return 0 if not failures else 1


def read_row(key, token, brand_id):
    query = urllib.parse.urlencode({"select": "brand_id,settings,persona_profile,persona_provenance,persona_confirmed,"
                                              "persona_last_analyzed_at,persona_last_analyzed_count,updated_at",
                                    "brand_id": f"eq.{brand_id}"})
    status, rows = http("GET", f"/rest/v1/{TABLE}?{query}", apikey=key, token=token)
    if status != 200 or not isinstance(rows, list):
        raise SystemExit(f"STOP S5: settings read failed (HTTP {status})")
    return rows[0] if rows else None


def consult(key, token, brand_id, message):
    results["model_calls"] += 1
    return http("POST", "/functions/v1/social-mobile-consult", apikey=key, token=token,
                body={"brand_id": brand_id, "message": message, "history": []})


def run(key, token, user_id):
    # Which workspace: exactly one owned social-mobile workspace (RLS-scoped reads with this user's JWT).
    query = urllib.parse.urlencode({"select": "brand_id,role", "user_id": f"eq.{user_id}", "role": "eq.owner"})
    status, owned = http("GET", f"/rest/v1/brand_memberships?{query}", apikey=key, token=token)
    owned_ids = [row["brand_id"] for row in owned or [] if isinstance(row, dict)]
    query = urllib.parse.urlencode({"select": "id,code_profile_key", "id": "in.(" + ",".join(owned_ids) + ")"}) if owned_ids else ""
    status, brands = http("GET", f"/rest/v1/brands?{query}", apikey=key, token=token) if owned_ids else (200, [])
    workspaces = [b["id"] for b in brands or [] if b.get("code_profile_key") == "social_mobile_user_v1"]
    if len(workspaces) != 1 or FOREIGN_BRAND in owned_ids:
        raise SystemExit(f"STOP S5: the test account must own exactly one social-mobile workspace (found {len(workspaces)})")
    brand_id = workspaces[0]
    results["workspace"] = brand_id
    print(f"workspace: {brand_id}")

    # Denials first: they reach no model.
    status, body = http("POST", "/functions/v1/social-mobile-consult", body={"brand_id": brand_id, "message": "x", "history": []})
    record("consult_without_jwt_denied", status == 401, http=status)
    status, body = http("POST", "/functions/v1/social-mobile-brand-dry-run", body={"brand_id": brand_id})
    record("preview_without_jwt_denied", status == 401, http=status)
    status, body = http("POST", "/functions/v1/social-mobile-consult", apikey=key, token=token,
                        body={"brand_id": FOREIGN_BRAND, "message": "設定を教えて", "history": []})
    record("consult_other_workspace_denied", status == 404 and (body or {}).get("error") == "OWNED_WORKSPACE_NOT_FOUND",
           http=status, error=(body or {}).get("error"))
    status, body = http("POST", "/functions/v1/social-mobile-brand-dry-run", apikey=key, token=token, body={"brand_id": FOREIGN_BRAND})
    record("preview_other_workspace_denied", status in (403, 404), http=status, error=(body or {}).get("error"))
    query = urllib.parse.urlencode({"select": "brand_id", "brand_id": f"eq.{FOREIGN_BRAND}"})
    status, rows = http("GET", f"/rest/v1/{TABLE}?{query}", apikey=key, token=token)
    record("read_other_workspace_settings_empty", status == 200 and rows == [], http=status)
    status, body = http("POST", f"/rest/v1/{TABLE}", apikey=key, token=token, prefer="return=minimal",
                        body={"brand_id": FOREIGN_BRAND, "settings": DEFAULTS})
    record("write_other_workspace_denied", status in (401, 403) and (body or {}).get("code") == "42501",
           http=status, code=(body or {}).get("code"))
    status, body = http("POST", f"/rest/v1/{TABLE}", apikey=key, prefer="return=minimal",
                        body={"brand_id": brand_id, "settings": DEFAULTS})
    record("write_as_anon_denied", status in (401, 403), http=status, code=(body or {}).get("code"))

    # 1. A proposal only: nothing is written.
    before = read_row(key, token, brand_id)
    status, body = consult(key, token, brand_id, PROPOSAL_MESSAGE)
    result = (body or {}).get("result") or {}
    flags_ok = isinstance(body, dict) and body.get("success") is True and all(
        body.get(flag) is False for flag in ("settings_saved", "persona_saved", "publish_attempted", "scheduled_post_created", "x_api_called"))
    settings_delta = result.get("proposedSettingsDelta") or {}
    persona_delta = result.get("proposedPersonaDelta") or {}
    record("consult_proposal", status == 200 and flags_ok and result.get("kind") == "proposal",
           http=status, kind=result.get("kind"), settings_fields=sorted(settings_delta), persona_fields=sorted(persona_delta),
           reply_chars=len(result.get("assistantReply") or ""))
    after_proposal = read_row(key, token, brand_id)
    record("proposal_wrote_nothing", after_proposal == before)
    # Anything unexpected about the proposal (or a write it should not have made) ends the smoke before any write.
    if failures or result.get("kind") != "proposal" or not (settings_delta or persona_delta):
        return
    if set(settings_delta) - SETTINGS_DELTA_KEYS:
        record("proposal_settings_keys_allowed", False, keys=sorted(settings_delta))
        return

    # 2. Explicit confirmation: the app's versioned write of exactly the proposed delta.
    current_settings = (before or {}).get("settings") or DEFAULTS
    new_settings = {**current_settings, **settings_delta}
    values = {"settings": new_settings}
    if persona_delta:
        current_persona = (before or {}).get("persona_profile") or {}
        values.update({
            "persona_profile": {**current_persona, **persona_delta},
            "persona_provenance": "conversation",
            "persona_confirmed": True,
            "persona_last_analyzed_at": (before or {}).get("persona_last_analyzed_at"),
            "persona_last_analyzed_count": (before or {}).get("persona_last_analyzed_count"),
        })
    if before is None:
        status, rows = http("POST", f"/rest/v1/{TABLE}?select=brand_id", apikey=key, token=token,
                            prefer="return=representation", body={"brand_id": brand_id, **values})
    else:
        query = urllib.parse.urlencode({"brand_id": f"eq.{brand_id}", "updated_at": f"eq.{before['updated_at']}", "select": "brand_id"})
        status, rows = http("PATCH", f"/rest/v1/{TABLE}?{query}", apikey=key, token=token, prefer="return=representation", body=values)
    record("confirmed_cas_write_one_row", status in (200, 201) and rows == [{"brand_id": brand_id}], http=status,
           mode="insert" if before is None else "update")
    saved = read_row(key, token, brand_id)
    persona_ok = not persona_delta or (saved.get("persona_confirmed") is True and saved.get("persona_provenance") == "conversation"
                                       and all(saved["persona_profile"].get(k) == v for k, v in persona_delta.items()))
    record("read_back_matches_confirmation", bool(saved) and saved["brand_id"] == brand_id and saved["settings"] == new_settings and persona_ok,
           updated_at_advanced=bool(saved) and (before is None or saved["updated_at"] != before["updated_at"]))

    # Stale version and duplicate insert are refused (nothing changes).
    stale = before["updated_at"] if before else "2000-01-01T00:00:00+00:00"
    query = urllib.parse.urlencode({"brand_id": f"eq.{brand_id}", "updated_at": f"eq.{stale}", "select": "brand_id"})
    status, rows = http("PATCH", f"/rest/v1/{TABLE}?{query}", apikey=key, token=token, prefer="return=representation",
                        body={"settings": DEFAULTS})
    record("stale_version_write_refused", status == 200 and rows == [], http=status)
    status, body = http("POST", f"/rest/v1/{TABLE}", apikey=key, token=token, prefer="return=minimal",
                        body={"brand_id": brand_id, "settings": DEFAULTS})
    record("duplicate_insert_refused", status == 409 and (body or {}).get("code") == "23505", http=status, code=(body or {}).get("code"))
    record("row_unchanged_after_refusals", read_row(key, token, brand_id) == saved)

    # 3. A fresh consultation knows the confirmed state (no history sent).
    status, body = consult(key, token, brand_id, EXPLAIN_MESSAGE)
    result = (body or {}).get("result") or {}
    reply = result.get("assistantReply") or ""
    mentions = []
    if "frequencyTargetPerWeek" in settings_delta:
        mentions.append(str(settings_delta["frequencyTargetPerWeek"]) in reply)
    record("fresh_consult_answers", status == 200 and (body or {}).get("success") is True and result.get("kind") in ("chat", "question"),
           http=status, kind=result.get("kind"), mentions_confirmed_frequency=all(mentions) if mentions else None,
           reply_excerpt=reply[:160])
    record("fresh_consult_wrote_nothing", read_row(key, token, brand_id) == saved)

    # 4. The dry-run preview reads the confirmed settings (and never publishes or schedules).
    results["model_calls"] += 1
    status, body = http("POST", "/functions/v1/social-mobile-brand-dry-run", apikey=key, token=token, body={"brand_id": brand_id})
    body = body or {}
    planning = body.get("planning_defaults") or {}
    if status == 409 and body.get("error") == "SOCIAL_MOBILE_X_ACCOUNT_NOT_CONFIGURED":
        record("preview_uses_confirmed_settings", False, http=status, error=body.get("error"),
               note="the test workspace has no single identity-verified X account")
    else:
        record("preview_uses_confirmed_settings",
               status == 200 and body.get("success") is True and body.get("preview_only") is True
               and planning.get("frequency_target_per_week") == new_settings["frequencyTargetPerWeek"]
               and body.get("publish_attempted") is False and body.get("x_api_called") is False
               and body.get("scheduled_post_created") is False,
               http=status, frequency=planning.get("frequency_target_per_week"),
               draft_chars=(body.get("draft") or {}).get("character_count"), model=(body.get("draft") or {}).get("model"))
    record("preview_wrote_nothing", read_row(key, token, brand_id) == saved)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
