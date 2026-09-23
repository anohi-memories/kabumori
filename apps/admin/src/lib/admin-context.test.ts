import assert from "node:assert/strict";
import test from "node:test";
import { canAccessBrand, resolveAdminBrandAccess } from "./admin-context.ts";

type QueryResult = { data: unknown; error: { code: string } | null };

// A minimal fake matching only the exact chain admin-context.ts calls:
//   .from(table).select(cols).eq(col, val).maybeSingle()   (admin_users)
//   .from(table).select(cols).eq(col, val)                 (brand_memberships, awaited directly)
function fakeSupabase(responses: { admin_users: QueryResult; brand_memberships: QueryResult }) {
  const calls: Array<{ table: string; eqColumn: string; eqValue: unknown }> = [];
  return {
    client: {
      from(table: "admin_users" | "brand_memberships") {
        return {
          select() {
            return {
              eq(column: string, value: unknown) {
                calls.push({ table, eqColumn: column, eqValue: value });
                const result = responses[table];
                return {
                  // brand_memberships: awaited directly (thenable)
                  then(resolve: (value: QueryResult) => void) {
                    resolve(result);
                  },
                  // admin_users: .maybeSingle() called on top
                  maybeSingle: async () => result,
                };
              },
            };
          },
        };
      },
    } as unknown as import("@supabase/supabase-js").SupabaseClient,
    calls,
  };
}

test("resolveAdminBrandAccess: an admin_users row grants global access regardless of brand_memberships", async () => {
  const { client, calls } = fakeSupabase({
    admin_users: { data: { user_id: "admin-1" }, error: null },
    brand_memberships: { data: [], error: null },
  });
  const access = await resolveAdminBrandAccess(client, "admin-1");
  assert.deepEqual(access, { kind: "global", brandIds: null });
  assert.equal(calls.some((c) => c.table === "admin_users" && c.eqValue === "admin-1"), true);
});

test("resolveAdminBrandAccess: no admin_users row falls back to brand_memberships, scoped to owner/admin roles only", async () => {
  const { client } = fakeSupabase({
    admin_users: { data: null, error: null },
    brand_memberships: {
      data: [
        { brand_id: "ai_salaryman_lab", role: "owner" },
        { brand_id: "kabumori", role: "viewer" }, // not an admin role -- must be excluded
      ],
      error: null,
    },
  });
  const access = await resolveAdminBrandAccess(client, "user-1");
  assert.deepEqual(access, { kind: "scoped", brandIds: ["ai_salaryman_lab"] });
});

test("resolveAdminBrandAccess: 'admin' role also counts as brand-scoped admin authority, duplicates are deduped", async () => {
  const { client } = fakeSupabase({
    admin_users: { data: null, error: null },
    brand_memberships: {
      data: [
        { brand_id: "mio", role: "admin" },
        { brand_id: "mio", role: "admin" },
      ],
      error: null,
    },
  });
  const access = await resolveAdminBrandAccess(client, "user-1");
  assert.deepEqual(access, { kind: "scoped", brandIds: ["mio"] });
});

test("resolveAdminBrandAccess: no admin_users row and no brand_memberships rows resolves to scoped with zero brands (fail closed, not global)", async () => {
  const { client } = fakeSupabase({
    admin_users: { data: null, error: null },
    brand_memberships: { data: [], error: null },
  });
  const access = await resolveAdminBrandAccess(client, "user-1");
  assert.deepEqual(access, { kind: "scoped", brandIds: [] });
});

test("resolveAdminBrandAccess: a brand_memberships read failure fails closed to zero brands, not to global or to a thrown error the caller must remember to handle", async () => {
  const { client } = fakeSupabase({
    admin_users: { data: null, error: null },
    brand_memberships: { data: null, error: { code: "500" } },
  });
  const access = await resolveAdminBrandAccess(client, "user-1");
  assert.deepEqual(access, { kind: "scoped", brandIds: [] });
});

test("canAccessBrand: global access permits any brand id", () => {
  assert.equal(canAccessBrand({ kind: "global", brandIds: null }, "kabumori"), true);
  assert.equal(canAccessBrand({ kind: "global", brandIds: null }, "anything-else"), true);
});

test("canAccessBrand: scoped access permits only listed brand ids", () => {
  const access = { kind: "scoped" as const, brandIds: ["ai_salaryman_lab"] };
  assert.equal(canAccessBrand(access, "ai_salaryman_lab"), true);
  assert.equal(canAccessBrand(access, "kabumori"), false);
  assert.equal(canAccessBrand(access, "mio"), false);
});
