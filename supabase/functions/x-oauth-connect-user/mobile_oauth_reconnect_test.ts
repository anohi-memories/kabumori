function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const migrationPath =
  "supabase/migrations/20260922003101_social_mobile_x_oauth_reconnect_preserve_verified.sql";

const migration = await Deno.readTextFile(migrationPath);

Deno.test("verified reconnect preserves identity_verified while pending accounts remain pending", () => {
  assert(
    migration.includes(
      "create or replace function public.begin_social_mobile_x_oauth_connection",
    ),
    "reconnect migration must replace the begin RPC",
  );
  assert(
    migration.includes(
      "when connection_status = 'identity_verified' then 'identity_verified'",
    ),
    "verified accounts must stay identity_verified during reconnect",
  );
  assert(
    migration.includes("else 'authorization_pending'"),
    "unverified accounts must enter authorization_pending during reconnect",
  );
  assert(
    migration.includes(
      "values (v_social_account_id, v_brand_id, 'x', 'pending', false, 'default', 'authorization_pending')",
    ),
    "new accounts must start authorization_pending",
  );
  assert(
    !migration.includes("set connection_status = 'authorization_pending',"),
    "reconnect must not unconditionally demote an existing account",
  );
  assert(
    !migration.includes("publish_enabled ="),
    "reconnect must not modify publish_enabled",
  );
});

Deno.test("reconnect migration keeps the authenticated-only RPC boundary", () => {
  assert(
    migration.includes(
      "revoke all on function public.begin_social_mobile_x_oauth_connection(text, text, timestamptz)",
    ),
    "begin RPC must remain revoked from public roles",
  );
  assert(
    migration.includes(
      "grant execute on function public.begin_social_mobile_x_oauth_connection(text, text, timestamptz)\n  to authenticated;",
    ),
    "begin RPC must remain authenticated-only",
  );
  assert(
    migration.includes("set search_path = 'public'"),
    "SECURITY DEFINER RPC must keep an explicit search_path",
  );
});
