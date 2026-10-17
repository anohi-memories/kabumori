#!/usr/bin/env python3
"""PASS/STOP decisions for the social-mobile AI consultation V1 activation (run.sh).

Every subcommand prints one line per finding and exits 0 only when everything matched.
Nothing here prints secret values, user rows or tokens: inputs are catalog JSON, function
metadata, secret *names* (values/digests are dropped on read) and source files.
"""
import json
import os
import sys

EXPECTED_HISTORY = [
    {"version": "20260922045046", "name": "social_mobile_content_settings_candidate"},
    {"version": "20261003120000", "name": "social_mobile_content_settings_hardening"},
]
API_ROLES = ["anon", "authenticated", "service_role"]
KNOWN_EVENT_TRIGGERS = {
    "ensure_rls", "issue_graphql_placeholder", "issue_pg_cron_access", "issue_pg_graphql_access",
    "issue_pg_net_access", "pgrst_ddl_watch", "pgrst_drop_watch",
}
MEMBERSHIP_FK = "FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE CASCADE"
MEMBERSHIP_ROLE_CHECK = "CHECK ((role = ANY (ARRAY['owner'::text, 'admin'::text, 'member'::text, 'viewer'::text])))"
CONSULT = "social-mobile-consult"
DRY_RUN = "social-mobile-brand-dry-run"
DRY_RUN_EXPECTED_VERSION = 16


def load_json(path):
    with open(path, encoding="utf-8") as handle:
        text = handle.read().strip()
    value = json.loads(text)
    # `supabase db query -o json` wraps rows when it detects an agent; psql -At prints the bare value.
    if isinstance(value, dict) and "rows" in value and isinstance(value["rows"], list) and value["rows"]:
        value = value["rows"][0]
    if isinstance(value, dict) and len(value) == 1:
        (only,) = value.values()
        if isinstance(only, str):
            try:
                return json.loads(only)
            except ValueError:
                return value
        if isinstance(only, dict):
            return only
    return value


class Findings:
    def __init__(self, stage):
        self.stage = stage
        self.problems = []

    def need(self, ok, message):
        if not ok:
            self.problems.append(message)

    def finish(self, pass_message):
        for problem in self.problems:
            print(f"STOP {self.stage}: {problem}")
        if self.problems:
            return 1
        print(f"PASS {self.stage}: {pass_message}")
        return 0


def check_s0(path, applier):
    s = load_json(path)
    f = Findings("S0")
    f.need(s.get("transaction_read_only") == "on", "preflight did not run in a read-only transaction")
    f.need(s.get("current_user") == applier, f"applying role is {s.get('current_user')!r}, expected {applier!r}")
    f.need(s.get("current_user_super") is False, "applying role is a superuser or unknown")
    f.need(str(s.get("server_version_num", "")).startswith("17"), "server is not PostgreSQL 17")
    f.need(s.get("target_table_present") is False, "public.social_mobile_content_settings already exists")
    f.need(s.get("target_function_count") == 0, "social_mobile_content_settings_* functions already exist")
    f.need(s.get("target_history_count") == 0, "a target migration history row already exists")
    f.need(s.get("history_not_null_columns") == ["version"], f"history NOT NULL columns {s.get('history_not_null_columns')}")
    f.need(s.get("history_has_name_column") is True, "history table has no name column")
    f.need(s.get("brands_owner") == applier, f"public.brands owner is {s.get('brands_owner')!r}")
    f.need(s.get("brands_id_type") == "text", "public.brands.id is not text")
    f.need(s.get("brands_pk") == "PRIMARY KEY (id)", f"public.brands primary key {s.get('brands_pk')!r}")
    f.need(s.get("brands_partitioned_or_inherited") is False, "public.brands takes part in inheritance")
    cols = dict(item.split(":", 2)[0:2] for item in (s.get("memberships_columns") or "").split(",") if item)
    f.need(cols == {"brand_id": "text", "role": "text", "user_id": "uuid"}, f"brand_memberships columns {s.get('memberships_columns')!r}")
    constraints = s.get("memberships_constraints") or []
    f.need(MEMBERSHIP_FK in constraints, "brand_memberships has no brand_id FK with ON DELETE CASCADE")
    f.need(MEMBERSHIP_ROLE_CHECK in constraints, "brand_memberships role CHECK differs")
    f.need(s.get("auth_uid_present") is True, "auth.uid() is absent")
    f.need(s.get("api_roles") == API_ROLES, f"API roles {s.get('api_roles')}")
    f.need(s.get("api_roles_super") is False, "an API role is a superuser")
    f.need(s.get("api_reaches_applier") is False, "an API role is a member of the applying role")
    f.need(s.get("anon_or_authenticated_reach_service_role") is False, "anon/authenticated reach service_role")
    allowed = set(API_ROLES) | {"PUBLIC"}
    for entry in s.get("default_acl") or []:
        if entry.get("objtype") in ("r", "f"):
            extra = set(entry.get("grantees") or []) - allowed
            f.need(not extra, f"default privileges ({entry.get('scope')}, {entry.get('objtype')}) grant to {sorted(extra)}")
    unknown = {t["name"] for t in s.get("event_triggers") or []} - KNOWN_EVENT_TRIGGERS
    f.need(not unknown, f"unknown event triggers {sorted(unknown)}")
    f.need(s.get("foreign_strong_locks") == 0, "another session holds a strong lock on brands/brand_memberships")
    summary = (f"applier={s.get('current_user')} history_count={s.get('history_count')} "
               f"history_max={s.get('history_max')} social_mobile_brands={s.get('social_mobile_brand_count')}")
    return f.finish(summary)


def check_s2(path, expected_path):
    actual = load_json(path)
    expected = load_json(expected_path)
    f = Findings("S2")
    f.need(actual.get("history") == EXPECTED_HISTORY, f"history rows {actual.get('history')}")
    for key in sorted(set(expected) | set(actual)):
        if key == "history":
            continue
        if actual.get(key) != expected.get(key):
            f.need(False, f"{key} differs from the reviewed local apply:\n  actual:   {json.dumps(actual.get(key), ensure_ascii=False)}\n  expected: {json.dumps(expected.get(key), ensure_ascii=False)}")
    return f.finish("history 2 rows, table/RLS/policies/ACL/functions identical to the reviewed local apply")


def functions_by_slug(path):
    value = json.load(open(path, encoding="utf-8"))
    if isinstance(value, dict):
        for item in value.values():
            if isinstance(item, list):
                value = item
                break
    return {fn["slug"]: fn for fn in value if isinstance(fn, dict) and "slug" in fn}


def check_functions_pre(path):
    fns = functions_by_slug(path)
    f = Findings("S0-functions")
    f.need(CONSULT not in fns, f"{CONSULT} already exists (version {fns.get(CONSULT, {}).get('version')})")
    dry = fns.get(DRY_RUN)
    f.need(dry is not None, f"{DRY_RUN} is missing")
    if dry:
        f.need(dry.get("version") == DRY_RUN_EXPECTED_VERSION, f"{DRY_RUN} version {dry.get('version')} (expected {DRY_RUN_EXPECTED_VERSION})")
        f.need(dry.get("status") == "ACTIVE", f"{DRY_RUN} status {dry.get('status')}")
        f.need(dry.get("verify_jwt") is True, f"{DRY_RUN} verify_jwt is not true")
    return f.finish(f"{CONSULT} absent, {DRY_RUN} v{DRY_RUN_EXPECTED_VERSION} ACTIVE verify_jwt=true, {len(fns)} functions")


def check_functions_post(pre_path, post_path):
    pre = functions_by_slug(pre_path)
    post = functions_by_slug(post_path)
    f = Findings("S3/S4-functions")
    consult = post.get(CONSULT)
    f.need(consult is not None and consult.get("status") == "ACTIVE" and consult.get("verify_jwt") is True,
           f"{CONSULT} not ACTIVE with verify_jwt=true: {consult and {k: consult.get(k) for k in ('status', 'version', 'verify_jwt')}}")
    dry = post.get(DRY_RUN)
    f.need(dry is not None and dry.get("status") == "ACTIVE" and dry.get("verify_jwt") is True
           and isinstance(dry.get("version"), int) and dry["version"] > pre.get(DRY_RUN, {}).get("version", 10**9),
           f"{DRY_RUN} not redeployed as ACTIVE with verify_jwt=true: {dry and {k: dry.get(k) for k in ('status', 'version', 'verify_jwt')}}")
    keys = ("version", "status", "verify_jwt", "ezbr_sha256", "updated_at", "entrypoint_path", "import_map")
    for slug, before in sorted(pre.items()):
        if slug in (CONSULT, DRY_RUN):
            continue
        after = post.get(slug)
        f.need(after is not None, f"{slug} disappeared")
        if after is not None:
            changed = [k for k in keys if before.get(k) != after.get(k)]
            f.need(not changed, f"{slug} changed {changed}")
    f.need(set(post) - set(pre) == {CONSULT}, f"unexpected new functions {sorted(set(post) - set(pre) - {CONSULT})}")
    versions = f"{CONSULT} v{consult and consult.get('version')}, {DRY_RUN} v{dry and dry.get('version')}"
    return f.finish(f"{versions}; every other function unchanged")


def check_s5(before_path, after_path, functions_before_path, functions_after_path):
    before, after = load_json(before_path), load_json(after_path)
    f = Findings("S5-side-effects")
    for key in ("social_mobile_brands", "scheduled_posts_social_mobile", "post_execution_logs_social_mobile",
                "fingerprints_social_mobile", "social_accounts_publish_md5", "brands_md5", "brand_settings_md5"):
        f.need(before.get(key) == after.get(key), f"{key} changed: {before.get(key)} -> {after.get(key)}")
    grew = (after.get("content_settings_rows") or 0) - (before.get("content_settings_rows") or 0)
    f.need(grew in (0, 1), f"content settings rows grew by {grew}")
    fb, fa = functions_by_slug(functions_before_path), functions_by_slug(functions_after_path)
    keys = ("version", "status", "verify_jwt", "ezbr_sha256", "updated_at")
    for slug in sorted(set(fb) | set(fa)):
        f.need(fb.get(slug) is not None and fa.get(slug) is not None
               and all(fb[slug].get(k) == fa[slug].get(k) for k in keys), f"function {slug} changed during the smoke")
    return f.finish(f"no scheduled post / execution log / fingerprint for social-mobile workspaces, no publish-permission, "
                    f"brand or brand-setting change, functions unchanged; settings rows +{grew}")


def check_secret_names(stream):
    raw = stream.read()
    try:
        value = json.loads(raw)
    except ValueError:
        value = []
    if isinstance(value, dict):
        for item in value.values():
            if isinstance(item, list):
                value = item
                break
    names = {item.get("name") for item in value if isinstance(item, dict)} if isinstance(value, list) else set()
    del raw, value  # drop digests immediately; only names are kept
    f = Findings("S0-secrets")
    f.need("OPENAI_API_KEY" in names, "OPENAI_API_KEY is not set for Edge Functions")
    return f.finish(f"OPENAI_API_KEY present ({len(names)} secret names, values not read)")


def check_bundle(download_root, source_root, slug):
    """Every downloaded file must be byte-identical to the reviewed checkout."""
    f = Findings(f"bundle:{slug}")
    base = os.path.join(download_root, "supabase", "functions")
    files = []
    for directory, _, names in os.walk(base):
        for name in names:
            files.append(os.path.relpath(os.path.join(directory, name), base))
    f.need(f"{slug}/index.ts" in files and f"{slug}/logic.ts" in files, f"entry files missing from the download: {sorted(files)}")
    for rel in sorted(files):
        source = os.path.join(source_root, "supabase", "functions", rel)
        if not os.path.exists(source):
            f.need(False, f"{rel} is deployed but not in the reviewed checkout")
            continue
        with open(os.path.join(base, rel), "rb") as a, open(source, "rb") as b:
            f.need(a.read() == b.read(), f"{rel} differs from the reviewed checkout")
    return f.finish(f"{len(files)} deployed files byte-identical to the reviewed checkout")


def main(argv):
    if len(argv) < 2:
        print(__doc__)
        return 2
    command, args = argv[1], argv[2:]
    if command == "s0":
        return check_s0(args[0], args[1] if len(args) > 1 else "postgres")
    if command == "s2":
        return check_s2(args[0], args[1])
    if command == "functions-pre":
        return check_functions_pre(args[0])
    if command == "functions-post":
        return check_functions_post(args[0], args[1])
    if command == "s5":
        return check_s5(args[0], args[1], args[2], args[3])
    if command == "secret-names":
        return check_secret_names(sys.stdin)
    if command == "bundle":
        return check_bundle(args[0], args[1], args[2])
    print(f"unknown command {command}")
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
