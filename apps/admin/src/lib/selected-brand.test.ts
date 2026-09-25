import assert from "node:assert/strict";
import test from "node:test";
import type { AdminBrandAccess } from "./admin-context.ts";
import { ADMIN_BRANDS } from "./admin-brands.ts";
import { chooseActiveBrand, chooseAdminActiveBrand, isKabumoriMutationAllowed } from "./selected-brand.ts";

const GLOBAL: AdminBrandAccess = { kind: "global", brandIds: null };

function choose(access: AdminBrandAccess, requestedBrandId: string | null) {
  return chooseActiveBrand({ access, requestedBrandId, registry: ADMIN_BRANDS });
}

test("a global admin with no selection defaults to Kabumori (pre-Phase-2 behavior)", () => {
  const result = choose(GLOBAL, null);
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") return;
  assert.equal(result.active.id, "kabumori");
  assert.equal(result.active.xHandle, "yume_daka");
  assert.equal(result.selectionRejected, false);
  assert.deepEqual(result.options.map((brand) => brand.id), ["kabumori", "ai_salaryman_lab"]);
});

test("a valid selection within the admin's authority is honored", () => {
  const result = choose(GLOBAL, "ai_salaryman_lab");
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") return;
  assert.equal(result.active.id, "ai_salaryman_lab");
  assert.equal(result.active.xHandle, "kaishain_ai_lab");
  assert.equal(result.selectionRejected, false);
});

test("an unknown or tampered brand id is rejected and falls back to the default, never passed through", () => {
  for (const tampered of ["mio", "brand_x", "kabumori'--", " ", "KABUMORI"]) {
    const result = choose(GLOBAL, tampered);
    assert.equal(result.kind, "ok");
    if (result.kind !== "ok") return;
    assert.equal(result.active.id, "kabumori", `fallback for ${JSON.stringify(tampered)}`);
    assert.equal(result.selectionRejected, tampered.trim() !== "");
  }
});

test("a scoped admin cannot select a brand outside their membership", () => {
  const scoped: AdminBrandAccess = { kind: "scoped", brandIds: ["ai_salaryman_lab"] };
  const result = choose(scoped, "kabumori");
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") return;
  assert.equal(result.active.id, "ai_salaryman_lab");
  assert.equal(result.selectionRejected, true);
  assert.deepEqual(result.options.map((brand) => brand.id), ["ai_salaryman_lab"]);
});

test("a scoped admin with exactly one brand gets that brand by default", () => {
  const result = choose({ kind: "scoped", brandIds: ["ai_salaryman_lab"] }, null);
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") return;
  assert.equal(result.active.id, "ai_salaryman_lab");
  assert.equal(result.selectionRejected, false);
});

test("membership in a brand outside the admin registry does not add it as an option", () => {
  const result = choose({ kind: "scoped", brandIds: ["mio"] }, "mio");
  assert.deepEqual(result, { kind: "no_brand" });
});

test("an admin with no authorized brand gets no_brand (fail closed)", () => {
  assert.deepEqual(choose({ kind: "scoped", brandIds: [] }, null), { kind: "no_brand" });
  assert.deepEqual(choose({ kind: "scoped", brandIds: [] }, "kabumori"), { kind: "no_brand" });
});

test("the admin registry is the exact allowlist and excludes Mio", () => {
  assert.deepEqual(
    ADMIN_BRANDS.map(({ id, xHandle }) => ({ id, xHandle })),
    [
      { id: "kabumori", xHandle: "yume_daka" },
      { id: "ai_salaryman_lab", xHandle: "kaishain_ai_lab" },
    ],
  );
});

test("brand membership alone cannot enter the admin app or change its selected brand", () => {
  const scoped: AdminBrandAccess = { kind: "scoped", brandIds: ["ai_salaryman_lab"] };
  assert.deepEqual(
    chooseAdminActiveBrand({ access: scoped, requestedBrandId: "ai_salaryman_lab", registry: ADMIN_BRANDS }),
    { kind: "not_admin" },
  );
});

test("Kabumori settings can change only while its authorized selection is active", () => {
  const select = (requestedBrandId: string | null) =>
    chooseAdminActiveBrand({ access: GLOBAL, requestedBrandId, registry: ADMIN_BRANDS });
  assert.equal(isKabumoriMutationAllowed(select(null)), true);
  assert.equal(isKabumoriMutationAllowed(select("kabumori")), true);
  assert.equal(isKabumoriMutationAllowed(select("ai_salaryman_lab")), false);
  assert.equal(isKabumoriMutationAllowed(select("unknown-brand")), false);
  assert.equal(isKabumoriMutationAllowed({ kind: "not_admin" }), false);
  assert.equal(isKabumoriMutationAllowed({ kind: "unauthenticated" }), false);
});
