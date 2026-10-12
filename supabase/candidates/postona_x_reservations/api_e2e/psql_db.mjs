// TEST-ONLY ReservationDb for the disposable local PostgreSQL proof (never a remote project).
// One call = one psql process = ONE transaction: SET LOCAL ROLE postona_resv_api, the verified subject set as
// request.jwt.claims / request.jwt.claim.sub (local to the transaction), one owner function, commit.
// Every value travels as a psql variable and is quoted by psql (:'var'), never spliced into SQL text.
import { spawnSync } from 'node:child_process';

const SQL = {
  create_batch: "postona_x_resv.create_batch(:'a0', :'a1'::uuid, (:'a2')::integer, :'a3', nullif(:'a4', 'null')::jsonb, (:'a5')::jsonb)",
  list_reservations: "postona_x_resv.list_reservations(:'a0')",
  get_reservation: "postona_x_resv.get_reservation(:'a0'::uuid)",
  reschedule: "postona_x_resv.reschedule(:'a0'::uuid, (:'a1')::integer, (:'a2')::timestamptz)",
  reconfirm: "postona_x_resv.reconfirm(:'a0'::uuid, (:'a1')::integer, :'a2')",
  cancel: "postona_x_resv.cancel(:'a0'::uuid, (:'a1')::integer)",
};

const asText = (value) => (typeof value === 'string' ? value : value === null ? 'null' : typeof value === 'number' ? String(value) : JSON.stringify(value));

export function psqlReservationDb({ host, port, database, loginRole, onCall }) {
  if (!/^\/(private\/)?tmp\//u.test(host)) throw new Error('local /tmp socket only');
  return {
    async call(fn, args, subject) {
      const target = SQL[fn];
      if (!target) return { ok: false, code: 'DB_FUNCTION_UNKNOWN' };
      onCall?.(fn, subject);
      const vars = ['-v', `sub=${subject}`, '-v', `claims=${JSON.stringify({ sub: subject, role: 'authenticated' })}`];
      args.forEach((value, index) => vars.push('-v', `a${index}=${asText(value)}`));
      const script = [
        '\\set ON_ERROR_STOP on',
        'begin;',
        'set local role postona_resv_api;',
        "select set_config('request.jwt.claims', :'claims', true), set_config('request.jwt.claim.sub', :'sub', true) \\g /dev/null",
        `select coalesce(json_agg(r), '[]'::json) from ${target} r;`,
        'commit;',
      ].join('\n');
      const run = spawnSync('psql', ['-X', '-q', '-A', '-t', '-h', host, '-p', String(port), '-U', loginRole, '-d', database, ...vars], {
        input: script, encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', PGTZ: 'UTC' },
      });
      if (run.error) throw run.error; // the database could not be reached: outcome unknown
      if (run.status !== 0) {
        if (process.env.RESV_E2E_DEBUG) console.error(`[psql_db] ${fn}: ${run.stderr.trim()}`);
        const code = /ERROR:\s+(POSTONA_RESV_[A-Z_]+)/u.exec(run.stderr)?.[1];
        if (code) return { ok: false, code };
        if (/could not connect|connection to server/u.test(run.stderr)) throw new Error('DB_UNREACHABLE');
        return { ok: false, code: 'DB_ERROR' };
      }
      // The only statement with output is the json_agg (which may span several lines).
      return { ok: true, rows: JSON.parse(run.stdout.trim() || '[]') };
    },
  };
}

/** Runs SQL as a local role (fixture / worker / MOCK_ONLY setup steps). Throws with stderr on failure. */
export function psqlAs({ host, port, database, role }, sql) {
  const run = spawnSync('psql', ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-h', host, '-p', String(port), '-U', role, '-d', database], {
    input: sql, encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', PGTZ: 'UTC' },
  });
  if (run.status !== 0) {
    const error = new Error(run.stderr.trim());
    error.stderr = run.stderr;
    throw error;
  }
  return run.stdout.trim();
}
