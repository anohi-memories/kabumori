import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import { createG4ThreadsOwnerBridge, verifiedActorClaims } from "./owner_bridge.ts";
import { createActorVerifier, RuntimeRefusal } from "../postona_threads_auth_runtime/verified_actor.ts";

const SUB = "00000000-0000-4000-8000-000000004501";
const SID = "00000001-0000-4000-9000-000000004501";
const sealed = (anon: unknown) =>
  createActorVerifier({
    getClaims: () =>
      Promise.resolve({
        data: { claims: { sub: SUB, session_id: SID, role: "authenticated", aud: "authenticated", is_anonymous: anon, exp: Math.floor(Date.now() / 1000) + 600 } },
        error: null,
      }),
    getUser: () => Promise.resolve({ data: { user: { id: SUB, is_anonymous: anon as boolean } }, error: null }),
  } as Parameters<typeof createActorVerifier>[0])("Bearer t");

Deno.test("claims: is_anonymous=false only for an actor the verifier sealed", async () => {
  assertEquals(JSON.parse(verifiedActorClaims(await sealed(false))), { sub: SUB, session_id: SID, role: "authenticated", is_anonymous: false });
  // A look-alike object (never sealed) is refused before any claim is written.
  const forged = Object.freeze({ userId: SUB, sessionId: SID, expiresAt: Date.now() + 600000 });
  assertThrows(() => verifiedActorClaims(forged), RuntimeRefusal, "AUTH_REQUIRED");
  // The verifier itself refuses anonymous / missing values, so no anonymous actor can reach the bridge.
  for (const anon of [true, undefined, null, "false"]) await assertRejects(() => sealed(anon), RuntimeRefusal, "AUTH_REQUIRED");
});

Deno.test("bridge: an unsealed actor never opens a connection", async () => {
  let opened = 0;
  const bridge = createG4ThreadsOwnerBridge(() => {
    opened++;
    return Promise.reject(new Error("unreachable"));
  });
  const forged = Object.freeze({ userId: SUB, sessionId: SID, expiresAt: Date.now() + 600000 });
  await assertRejects(() => bridge.begin(forged, "a".repeat(64), "https://app.postona.test/cb", new Date(Date.now() + 300000)), RuntimeRefusal);
  await assertRejects(() => bridge.uncertain(forged, "a".repeat(64)), RuntimeRefusal);
  assertEquals(opened, 0);
});

// G4-02 #2: the G5 profile is pinned (full | personal); anything else is refused before any connection exists.
Deno.test("bridge: an unknown G5 profile is refused at construction", () => {
  let opened = 0;
  const connect = () => {
    opened++;
    return Promise.reject(new Error("unreachable"));
  };
  for (const profile of ["", "Personal", "g5pv", "full ", undefined as unknown as string, null as unknown as string]) {
    if (profile === undefined) continue; // the default is "full" (the existing callers)
    assertThrows(() => createG4ThreadsOwnerBridge(connect, Date.now, profile as "full"), RuntimeRefusal, "OWNER_TRANSPORT_UNAVAILABLE");
  }
  createG4ThreadsOwnerBridge(connect, Date.now, "full");
  createG4ThreadsOwnerBridge(connect, Date.now, "personal");
  assertEquals(opened, 0);
});
