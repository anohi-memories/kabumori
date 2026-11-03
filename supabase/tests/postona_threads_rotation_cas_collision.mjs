// G4-25 (Issue #319): the rotation CAS across two DIFFERENT transactions that started in the same microsecond (equal now(),
// distinct pg_current_xact_id()) -- found by opening many sessions at once; no clock change, no catalog or row rewrite.
//   P (now = T): completes connect s1 (entry + custody: recorded_at = T) and commits.
//   C (any time): H5 claims a refresh lease on that version (custody_recorded_at = T).
//   R (now = T, still open): completes reconnect s2 (entry + custody: recorded_at = T again) and commits.
//   then H5 rotates with the lease and the claimed version T.
// mode none: the candidate as it is (expected: the rotation is accepted -> reported as a reproduced finding).
// mode fix:  the TEST-WORLD prototype (every custody write deletes the account's lease) -> expected refused.
// Usage: node postona_threads_rotation_cas_collision.mjs <psql> <socket-dir> <port> <user> <db> <none|fix>
import { spawn } from "node:child_process";

const [psql, host, port, user, db, mode] = process.argv.slice(2);
if (!/^\/(private\/)?tmp\//.test(host ?? "")) throw new Error("socket dir must be a local /tmp path");
if (mode !== "none" && mode !== "fix") throw new Error("mode must be none or fix");

class Session {
  constructor() {
    this.out = ""; this.err = ""; this.wait = null; this.n = 0;
    this.p = spawn(psql, ["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-h", host, "-p", port, "-U", user, "-d", db], { stdio: ["pipe", "pipe", "pipe"] });
    this.p.stdout.on("data", (b) => {
      this.out += b;
      const w = this.wait;
      if (w && this.out.includes(w.marker)) {
        const i = this.out.indexOf(w.marker);
        const text = this.out.slice(0, i).trim();
        this.out = this.out.slice(i + w.marker.length).replace(/^\r?\n/, "");
        this.wait = null;
        w.resolve(text);
      }
    });
    this.p.stderr.on("data", (b) => (this.err += b));
    this.p.on("exit", (code) => { if (this.wait) this.wait.reject(new Error(`psql exited ${code}: ${this.err}`)); this.wait = null; });
  }
  run(sql) {
    if (this.wait) throw new Error("overlapping command");
    return new Promise((resolve, reject) => {
      const marker = `G4_25_DONE_${++this.n}`;
      this.wait = { marker, resolve, reject };
      this.p.stdin.write(`${sql}\n\\echo ${marker}\n`);
    });
  }
  close() { this.p.stdin.end("ROLLBACK;\n\\q\n"); }
}

const sessions = Array.from({ length: 24 }, () => new Session());
const fail = (msg) => { throw new Error(`ROTATION_COLLISION_${mode.toUpperCase()}_FAIL ${msg}`); };

async function collide() {
  for (let round = 1; round <= 2000; round++) {
    const rows = await Promise.all(sessions.map((s) => s.run("BEGIN; SELECT extract(epoch FROM now())::text || '|' || pg_current_xact_id()::text;")));
    const seen = new Map();
    for (let i = 0; i < rows.length; i++) {
      const [stamp] = rows[i].split("|");
      if (seen.has(stamp)) {
        const x = seen.get(stamp), y = i;
        await Promise.all(sessions.filter((_, k) => k !== x && k !== y).map((s) => s.run("ROLLBACK;")));
        const ev = { round, same_start_timestamp: stamp, xid_p: rows[x].split("|")[1], xid_r: rows[y].split("|")[1] };
        if (ev.xid_p === ev.xid_r) fail("same transaction id");
        return [sessions[x], sessions[y], ev];
      }
      seen.set(stamp, i);
    }
    await Promise.all(sessions.map((s) => s.run("ROLLBACK;")));
  }
  fail("no same-microsecond pair in 2000 rounds (inconclusive)");
}

try {
  await Promise.all(sessions.map((s) => s.run("SELECT 1;")));
  const [P, R, ev] = await collide();
  const others = sessions.filter((s) => s !== P && s !== R);
  const C = others[0];
  const acct = "(SELECT id FROM public.social_accounts WHERE platform_user_id = '17841400000000181')";
  ev.p_connect = await P.run("SELECT cr.t_complete(cr.uid(181), 's1', '17841400000000181', now() + interval '30 days');");
  await P.run("COMMIT;");
  const claim = await C.run(`SELECT cr.claim(${acct})::text;`);
  ev.claim_status = JSON.parse(claim).status;
  ev.claimed_version = JSON.parse(claim).custody_recorded_at;
  ev.r_sees_recorded_equal_to_its_now = await R.run(`SELECT (cr.recorded(${acct}) = now())::text;`);
  ev.r_reconnect = await R.run("SELECT cr.t_complete(cr.uid(181), 's2', '17841400000000181', now() + interval '40 days');");
  await R.run("COMMIT;");
  const rot = await C.run(`SELECT cr.rotate(${acct}, '${claim}'::jsonb, ('${claim}'::jsonb ->> 'custody_recorded_at')::timestamptz, now() + interval '55 days')::text;`);
  ev.rotation = JSON.parse(rot);
  if (ev.rotation.status === "rotated") await C.run(`SELECT cr.h5_write(${acct}, 'fakeTHREADSstaleLineage_0123456789');`);
  ev.token_now = await C.run(`SELECT cr.token_of(${acct});`);
  ev.reconnect_token = await C.run("SELECT cr.token('s2');");
  console.log(JSON.stringify(ev));
  if (ev.p_connect !== "OK" || ev.claim_status !== "claimed" || ev.r_reconnect !== "OK") fail(`setup: ${JSON.stringify(ev)}`);
  if (mode === "none") {
    if (ev.rotation.status !== "rotated" || ev.token_now !== "fakeTHREADSstaleLineage_0123456789") fail(`expected the reproduction: ${JSON.stringify(ev)}`);
    console.log("ROTATION_COLLISION_FINDING_REPRODUCED (two transactions with the same now(): the stale refresh rotated over the reconnect)");
  } else {
    if (ev.rotation.status !== "refused" || ev.token_now !== ev.reconnect_token) fail(`prototype fix did not hold: ${JSON.stringify(ev)}`);
    console.log(`ROTATION_COLLISION_FIX_PROTOTYPE_HOLDS (${ev.rotation.code})`);
  }
} finally {
  for (const s of sessions) s.close();
}
