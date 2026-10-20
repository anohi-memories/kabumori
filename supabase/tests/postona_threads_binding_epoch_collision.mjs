// G4-14 (H2 #329 C2 R1 on PR #388): two DIFFERENT top-level transactions that started in the same microsecond (equal
// now(), distinct pg_current_xact_id()), found by opening many sessions at once -- no clock change, no state or catalog
// rewrite. Run by postona_threads_binding_epoch_run.sh against a disposable LOCAL database that already holds 001 (or
// PR #388's version of it), the tb helpers, and two recorded, unconsumed states 'c1' (person 911) and 'c2' (person 912).
//   mode before: PR #388's 001 (consumed_at = now()). Expected FAIL-BEFORE: an attest in the other transaction succeeds
//                (A), and rolling it back leaves the completion committed (B) -- H2's two reproductions.
//   mode after:  this 001 (no attest entry; complete_and_attest_binding). The other transaction cannot bind (A'); a
//                rolled-back entry call undoes the completion too, and the colliding transaction then binds normally (B').
// Usage: node postona_threads_binding_epoch_collision.mjs <psql> <socket-dir> <port> <user> <db> <before|after>
import { spawn } from "node:child_process";

const [psql, host, port, user, db, mode] = process.argv.slice(2);
if (!/^\/(private\/)?tmp\//.test(host ?? "")) throw new Error("socket dir must be a local /tmp path");
if (mode !== "before" && mode !== "after") throw new Error("mode must be before or after");

class Session {
  constructor() {
    this.out = "";
    this.err = "";
    this.wait = null;
    this.n = 0;
    this.p = spawn(psql, ["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-h", host, "-p", port, "-U", user, "-d", db], {
      stdio: ["pipe", "pipe", "pipe"],
    });
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
    this.p.on("exit", (code) => {
      if (this.wait) this.wait.reject(new Error(`psql exited ${code}: ${this.err}`));
      this.wait = null;
    });
  }
  run(sql) {
    if (this.wait) throw new Error("overlapping command");
    return new Promise((resolve, reject) => {
      const marker = `G4_14_DONE_${++this.n}`;
      this.wait = { marker, resolve, reject };
      this.p.stdin.write(`${sql}\n\\echo ${marker}\n`);
    });
  }
  close() {
    this.p.stdin.end("ROLLBACK;\n\\q\n");
  }
}

const sessions = Array.from({ length: 24 }, () => new Session());
const fail = (msg) => {
  throw new Error(`COLLISION_${mode.toUpperCase()}_FAIL ${msg}`);
};

// Opens a transaction in every session until two report the same now() with different top-level transaction ids;
// returns [x, y, evidence] with both left open and every other session rolled back.
async function collide(label) {
  for (let round = 1; round <= 2000; round++) {
    const rows = await Promise.all(
      sessions.map((s) => s.run("BEGIN; SELECT extract(epoch FROM now())::text || '|' || pg_current_xact_id()::text;")),
    );
    const seen = new Map();
    for (let i = 0; i < rows.length; i++) {
      const [stamp] = rows[i].split("|");
      if (seen.has(stamp)) {
        const x = seen.get(stamp);
        const y = i;
        await Promise.all(sessions.filter((_, k) => k !== x && k !== y).map((s) => s.run("ROLLBACK;")));
        const evidence = {
          scenario: label,
          round,
          same_start_timestamp: stamp,
          xid_x: rows[x].split("|")[1],
          xid_y: rows[y].split("|")[1],
        };
        if (evidence.xid_x === evidence.xid_y) fail(`${label}: same transaction id`);
        return [sessions[x], sessions[y], evidence];
      }
      seen.set(stamp, i);
    }
    await Promise.all(sessions.map((s) => s.run("ROLLBACK;")));
  }
  fail(`${label}: no same-microsecond pair in 2000 rounds (inconclusive)`);
}

const fresh = sessions[0];
const readback = (tag, n) =>
  fresh.run(
    `SELECT concat_ws(',', (s.consumed_at is not null)::text, (sa.vault_access_token_secret_id is not null)::text,
            (g.attested_at is not null)::text, exists (select 1 from postona_threads_binding.bindings b where b.oauth_state_id = s.id)::text)
       FROM public.social_account_oauth_states s
       JOIN public.social_accounts sa ON sa.id = s.social_account_id
       JOIN postona_threads_binding.state_generations g ON g.oauth_state_id = s.id
      WHERE s.id = tb.state('${tag}') AND s.initiated_by_user_id = tb.uid(${n});`,
  );
const puid = (n) => `178414000000${String(n).padStart(5, "0")}`;
const completeAlone = (tag, n) => `SELECT tb.complete_alone(tb.uid(${n}), '${tag}', '${puid(n)}');`;
const directAttest = (tag, n) =>
  `SELECT tb.try(format('select postona_threads_binding.attest_binding(%L::uuid, %L::uuid, %L)', tb.uid(${n}), tb.state('${tag}'), '${puid(n)}'));`;
const entry = (tag, n) => `SELECT tb.connect(tb.uid(${n}), '${tag}', '${puid(n)}');`;
const consumedEqualsNow = (tag) => `SELECT (s.consumed_at = now())::text FROM public.social_account_oauth_states s WHERE s.id = tb.state('${tag}');`;

try {
  await Promise.all(sessions.map((s) => s.run("SELECT 1;")));
  if (mode === "before") {
    // A: X completes and commits; Y (same now(), other transaction) attests directly.
    {
      const [x, y, ev] = await collide("A");
      if ((await x.run(completeAlone("c1", 911))) !== "OK") fail("A: complete in X");
      await x.run("COMMIT;");
      ev.y_sees_consumed_at_equal_to_its_now = await y.run(consumedEqualsNow("c1"));
      ev.y_direct_attest = await y.run(directAttest("c1", 911));
      await y.run("COMMIT;");
      ev.after = await readback("c1", 911); // consumed, credential ref, attested, bound
      console.log(JSON.stringify(ev));
      if (ev.y_sees_consumed_at_equal_to_its_now !== "true" || ev.y_direct_attest !== "OK" || ev.after !== "true,true,true,true") {
        fail(`A: ${JSON.stringify(ev)}`);
      }
    }
    // B: X completes and commits; Y attests, then rolls back: the completion stays committed, nothing is bound.
    {
      const [x, y, ev] = await collide("B");
      if ((await x.run(completeAlone("c2", 912))) !== "OK") fail("B: complete in X");
      await x.run("COMMIT;");
      ev.y_direct_attest = await y.run(directAttest("c2", 912));
      await y.run("ROLLBACK;");
      ev.after = await readback("c2", 912);
      console.log(JSON.stringify(ev));
      if (ev.y_direct_attest !== "OK" || ev.after !== "true,true,false,false") fail(`B: ${JSON.stringify(ev)}`);
    }
    console.log("COLLISION_BEFORE_REPRODUCED (A: other-transaction attest accepted; B: rollback left the completion committed)");
  } else {
    // A': X completes on its own and commits; Y (same now(), other transaction) can neither attest nor bind.
    {
      const [x, y, ev] = await collide("A'");
      if ((await x.run(completeAlone("c1", 911))) !== "OK") fail("A': complete in X");
      await x.run("COMMIT;");
      ev.y_sees_consumed_at_equal_to_its_now = await y.run(consumedEqualsNow("c1"));
      ev.y_direct_attest = await y.run(directAttest("c1", 911));
      ev.y_entry = await y.run(entry("c1", 911));
      await y.run("COMMIT;");
      ev.after = await readback("c1", 911);
      console.log(JSON.stringify(ev));
      if (ev.y_sees_consumed_at_equal_to_its_now !== "true"
          || !/^ERR:function postona_threads_binding\.attest_binding\(.*\) does not exist/.test(ev.y_direct_attest)
          || !ev.y_entry.startsWith("ERR:THREADS_OAUTH_STATE_NOT_CONSUMABLE") || ev.after !== "true,true,false,false") {
        fail(`A': ${JSON.stringify(ev)}`);
      }
    }
    // B': Y's entry succeeds and Y rolls back: the completion is undone with the binding. X (same now()) then binds.
    {
      const [x, y, ev] = await collide("B'");
      ev.y_entry = await y.run(entry("c2", 912));
      await y.run("ROLLBACK;");
      ev.after_y_rollback = await readback("c2", 912);
      ev.x_entry = await x.run(entry("c2", 912));
      await x.run("COMMIT;");
      ev.after_x_commit = await readback("c2", 912);
      console.log(JSON.stringify(ev));
      if (ev.y_entry !== "OK" || ev.after_y_rollback !== "false,false,false,false" || ev.x_entry !== "OK"
          || ev.after_x_commit !== "true,true,true,true") {
        fail(`B': ${JSON.stringify(ev)}`);
      }
    }
    console.log("COLLISION_AFTER_PASS (A': no attest outside the completing call; B': rollback undoes the completion with the binding)");
  }
} finally {
  for (const s of sessions) s.close();
}
