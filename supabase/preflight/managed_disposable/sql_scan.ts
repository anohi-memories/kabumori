// Fail-closed SQL effect scanner of the managed-disposable harness (F5 Phase 12). SOURCE ONLY, pure, no I/O.
//
// Question: "could applying this file make the database call out, schedule work, touch a secret, reach a file or a
// foreign server, or run SQL nobody reviewed?" The answer is NO only when every finding below is absent or has been
// accepted, statement by statement, in the allowlist lock (allowlist.ts). The scanner can only REJECT: the SHA-256 pin
// of each file (lock.ts) and the allowlist are the primary defence; this is the second line.
//
// What it does lexically (a hand-written PostgreSQL lexer, not a regular expression over raw text):
//   * comments (`--`, nested `/* */`) are blanked to whitespace BEFORE any rule runs, so `net./**/http_post(` and
//     `"net"."http_post"` and `net . http_post` are all the same name; text inside string literals and dollar-quoted
//     bodies is scanned (it is SQL that runs later: cron commands, EXECUTE strings, function bodies);
//   * quoted identifiers are unquoted and lower-cased; whitespace around dots is removed;
//   * a dollar-quoted body is lexed recursively; a body that does not lex as SQL is scanned raw (more findings, never fewer).
// What it cannot see (stated, not hidden): SQL assembled at run time from data (a URL read from a table, a string
// built with chr()); that is why an unaccepted EXECUTE is a finding and why accepted dynamic statements are pinned
// by the fingerprint of their text.

export type Severity = 'block' | 'review';
export type FindingCode =
  | 'SUPABASE_HOST_REFERENCE' | 'FOREIGN_PROJECT_HOST' | 'URL_LITERAL' | 'URL_FRAGMENT'
  | 'CRON_REFERENCE' | 'NET_REFERENCE' | 'EXTENSION_CREATE' | 'FILE_OR_PROGRAM_ACCESS' | 'FOREIGN_SERVER'
  | 'VAULT_REFERENCE' | 'ROLE_CHANGE' | 'SERVER_SETTING' | 'PLATFORM_TRIGGER' | 'EVENT_TRIGGER'
  | 'UNICODE_ESCAPE' | 'UNTRUSTED_LANGUAGE' | 'DYNAMIC_SQL' | 'DATA_WRITE' | 'TOP_LEVEL_SELECT' | 'INDIRECT_NETWORK_CALL' | 'UNKNOWN_STATEMENT' | 'UNTERMINATED_LITERAL';

export type Finding = { code: FindingCode; severity: Severity; line: number; detail: string; fingerprint?: string };
/**
 * A function (or procedure) the file defines. `calls` are the names it calls (its own name excluded), so the corpus can
 * be closed over: a helper that calls a helper that calls net.http_post is network capable too. `dynamic` = its text
 * assembles / runs SQL at run time (EXECUTE, PREPARE, query_to_xml...): what it reaches cannot be known lexically.
 * An `alter function A rename to B` is recorded as B calling A (an alias reaches whatever the original reaches).
 */
export type FunctionDefinition = { name: string; networkCapable: boolean; calls: string[]; dynamic: boolean };
export type ScanResult = {
  findings: Finding[];
  /** fingerprints (SHA-256 is added by the caller; the text is normalized) of every dynamic statement, with its line */
  dynamic: { text: string; line: number }[];
  /** table names written by INSERT / UPDATE / DELETE / TRUNCATE / MERGE anywhere in the text */
  writes: string[];
  /** normalized text of every top-level SELECT (a call of a stored function runs at apply time) */
  topLevelSelects: { text: string; line: number }[];
  definedFunctions: FunctionDefinition[];
  /** names that appear as `name(` (candidates for a helper call; `execute function name()` of a trigger is one) */
  calledNames: string[];
};

// ---- lexer -------------------------------------------------------------------------------------------------------

const DOLLAR_TAG = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/u;
const isWordChar = (ch: string | undefined) => ch !== undefined && /[A-Za-z0-9_$]/u.test(ch);

export type Normalized = { text: string; ok: boolean };

/** Blanks comments, unquotes simple identifiers, recurses into dollar-quoted bodies. Newlines are preserved. */
export function normalize(sql: string, depth = 0): Normalized {
  let ok = true;
  let out = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (ch === '-' && next === '-') {
      while (i < n && sql[i] !== '\n') i++;
      out += ' ';
      continue;
    }
    if (ch === '/' && next === '*') {
      let level = 1;
      let newlines = 0;
      i += 2;
      while (i < n && level > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') { level++; i += 2; continue; }
        if (sql[i] === '*' && sql[i + 1] === '/') { level--; i += 2; continue; }
        if (sql[i] === '\n') newlines++;
        i++;
      }
      if (level > 0) ok = false;
      out += ' ' + '\n'.repeat(newlines);
      continue;
    }
    if (ch === "'") {
      const escaped = i > 0 && /[eE]/u.test(sql[i - 1]) && !isWordChar(sql[i - 2]);
      let j = i + 1;
      let closed = false;
      while (j < n) {
        if (escaped && sql[j] === '\\') { j += 2; continue; }
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") { j += 2; continue; }
          closed = true;
          j++;
          break;
        }
        j++;
      }
      if (!closed) ok = false;
      out += sql.slice(i, j);
      i = j;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let content = '';
      let closed = false;
      while (j < n) {
        if (sql[j] === '"') {
          if (sql[j + 1] === '"') { content += '"'; j += 2; continue; }
          closed = true;
          j++;
          break;
        }
        content += sql[j];
        j++;
      }
      if (!closed) ok = false;
      out += /^[A-Za-z_][A-Za-z0-9_$]*$/u.test(content) ? content.toLowerCase() : `"${content.toLowerCase()}"`;
      i = j;
      continue;
    }
    if (ch === '$' && !isWordChar(sql[i - 1])) {
      const tag = DOLLAR_TAG.exec(sql.slice(i, i + 80));
      if (tag) {
        const delimiter = tag[0];
        const close = sql.indexOf(delimiter, i + delimiter.length);
        if (close === -1) {
          ok = false;
          out += sql.slice(i);
          i = n;
          continue;
        }
        const inner = sql.slice(i + delimiter.length, close);
        const lexed = depth < 8 ? normalize(inner, depth + 1) : { text: inner, ok: false };
        // a body that is not SQL (e.g. text with an apostrophe) is scanned raw: comments are NOT blanked then
        out += delimiter + (lexed.ok ? lexed.text : inner) + delimiter;
        i = close + delimiter.length;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return { text: out, ok };
}

/** Collapses whitespace around dots so that `net . http_post` and `net.http_post` match one rule. Line breaks are kept. */
const tidy = (text: string) => text.replace(/[ \t\r\f\v]*\.[ \t\r\f\v]*/gu, '.').replace(/\.\s*\n\s*/gu, '.');

/** Splits normalized text at top-level semicolons (outside single quotes, double quotes and dollar quotes). */
export function splitStatements(text: string): { text: string; line: number }[] {
  const statements: { text: string; line: number }[] = [];
  let current = '';
  let start = 0;
  let i = 0;
  const n = text.length;
  const flush = (end: number) => {
    const trimmed = current.trim();
    if (trimmed !== '') {
      const lead = current.length - current.trimStart().length;
      statements.push({ text: trimmed, line: text.slice(0, start + lead).split('\n').length });
    }
    current = '';
    start = end;
  };
  while (i < n) {
    const ch = text[i];
    if (ch === "'") {
      let j = i + 1;
      while (j < n) {
        if (text[j] === "'") { if (text[j + 1] === "'") { j += 2; continue; } j++; break; }
        j++;
      }
      current += text.slice(i, j);
      i = j;
      continue;
    }
    if (ch === '"') {
      const j = text.indexOf('"', i + 1);
      const end = j === -1 ? n : j + 1;
      current += text.slice(i, end);
      i = end;
      continue;
    }
    if (ch === '$' && !isWordChar(text[i - 1])) {
      const tag = DOLLAR_TAG.exec(text.slice(i, i + 80));
      if (tag) {
        const close = text.indexOf(tag[0], i + tag[0].length);
        const end = close === -1 ? n : close + tag[0].length;
        current += text.slice(i, end);
        i = end;
        continue;
      }
    }
    if (ch === ';') {
      flush(i + 1);
      i++;
      continue;
    }
    current += ch;
    i++;
  }
  flush(n);
  return statements;
}

// ---- rules -------------------------------------------------------------------------------------------------------

const RULES: { code: FindingCode; pattern: RegExp; detail: string }[] = [
  { code: 'SUPABASE_HOST_REFERENCE', pattern: /\bsupabase\.(co|in|net)\b/giu, detail: 'names a Supabase host' },
  { code: 'URL_LITERAL', pattern: /\bhttps?:\/\//giu, detail: 'contains an http(s) URL' },
  { code: 'URL_FRAGMENT', pattern: /(:\/\/|\/functions\/v1|\/rest\/v1|\/auth\/v1|\.supabase\b)/giu, detail: 'contains a URL fragment' },
  { code: 'CRON_REFERENCE', pattern: /\b(cron\.[a-z_]+|pg_cron)\b/giu, detail: 'references pg_cron' },
  { code: 'NET_REFERENCE', pattern: /\b(net\.[a-z_]+|pg_net|http_(get|post|put|delete|head|patch|request|header|set_curlopt)\s*\(|dblink(_[a-z_]+)?\s*\()/giu, detail: 'calls out over the network from the database' },
  { code: 'EXTENSION_CREATE', pattern: /\bcreate\s+extension\b/giu, detail: 'creates an extension' },
  { code: 'FILE_OR_PROGRAM_ACCESS', pattern: /\b(pg_read_file|pg_read_binary_file|pg_ls_dir|pg_stat_file|lo_import|lo_export|lo_from_bytea|pg_file_write|copy\s+[^;]*\bprogram\b)\b/giu, detail: 'reaches a file or a program' },
  { code: 'FOREIGN_SERVER', pattern: /\bcreate\s+(server|foreign\s+data\s+wrapper|foreign\s+table|user\s+mapping|subscription|publication)\b/giu, detail: 'creates a foreign server / replication object' },
  { code: 'VAULT_REFERENCE', pattern: /\b(vault\.[a-z_]+|pgsodium)\b/giu, detail: 'references Vault' },
  { code: 'ROLE_CHANGE', pattern: /\b((create|alter|drop)\s+(role|user|group)|set\s+(local\s+|session\s+)?(session\s+authorization|role))\b/giu, detail: 'changes roles' },
  { code: 'SERVER_SETTING', pattern: /\b(alter\s+system|pg_reload_conf|pg_terminate_backend|pg_cancel_backend)\b/giu, detail: 'changes the server' },
  { code: 'PLATFORM_TRIGGER', pattern: /\bcreate\s+(or\s+replace\s+)?(constraint\s+)?trigger\b[^;]*?\bon\s+(auth|storage|vault|cron|net|extensions|realtime|supabase_functions)\./giu, detail: 'a trigger on a platform table' },
  { code: 'EVENT_TRIGGER', pattern: /\bcreate\s+event\s+trigger\b/giu, detail: 'creates an event trigger' },
  { code: 'UNICODE_ESCAPE', pattern: /\bu&\s*["']/giu, detail: 'a unicode-escaped identifier or string (a way to spell a name the rules cannot read)' },
  { code: 'UNTRUSTED_LANGUAGE', pattern: /\blanguage\s+(?!sql\b|plpgsql\b)[a-z_][a-z0-9_]*/giu, detail: 'a function in a language other than SQL / PL/pgSQL' },
];

// `execute` as a statement (dynamic SQL), not the privilege word: grant/revoke ... execute on, 'EXECUTE' as a string,
// `execute function|procedure` of a trigger.
const DYNAMIC = /(?<!grant\s)(?<!revoke\s)(?<!['"])\b(execute|prepare|query_to_xml(?:_and_xmlschema)?|cursor_to_xml)\b(?!['"])(?!\s+(on\s|function\b|procedure\b|privilege))/giu;
// a write names its target: INSERT INTO t, UPDATE t [alias] SET, DELETE FROM t, TRUNCATE t, MERGE INTO t (not `ON UPDATE`, `AFTER DELETE ON`)
const WRITE = /\b(?:insert\s+into\s+(?:only\s+)?|update\s+(?:only\s+)?(?=[a-z_][a-z0-9_.]*(?:\s+(?:as\s+)?[a-z_][a-z0-9_]*)?\s+set\b)|delete\s+from\s+(?:only\s+)?|truncate\s+(?:table\s+)?(?:only\s+)?(?!on\b)|merge\s+into\s+)([a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)?)/giu;
const FUNCTION_DEF = /\bcreate\s+(?:or\s+replace\s+)?(?:function|procedure)\s+([a-z_][a-z0-9_.]*)\s*\(/giu;
const FUNCTION_RENAME = /\balter\s+(?:function|procedure)\s+([a-z_][a-z0-9_.]*)\s*(?:\([^)]*\))?\s+rename\s+to\s+([a-z_][a-z0-9_]*)/giu;
const CALL = /\b([a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)?)\s*\(/giu;
const KNOWN_STATEMENTS = new Set([
  'begin', 'commit', 'end', 'rollback', 'start', 'set', 'reset', 'create', 'alter', 'drop', 'grant', 'revoke', 'comment',
  'do', 'select', 'with', 'insert', 'update', 'delete', 'lock',
]);

const collapse = (text: string) => text.replace(/\s+/gu, ' ').trim().toLowerCase();
const lineOf = (text: string, index: number) => text.slice(0, index).split('\n').length;

/**
 * Collects every CREATE FUNCTION / PROCEDURE statement (normalized). The WHOLE statement is the body: a body in dollar
 * quotes, in single quotes (`AS '...'`) or SQL-standard (`BEGIN ATOMIC`) is scanned alike, so no spelling hides a call.
 */
function functionBodies(text: string): { name: string; body: string }[] {
  const found: { name: string; body: string }[] = [];
  for (const statement of splitStatements(text)) {
    FUNCTION_DEF.lastIndex = 0;
    const def = FUNCTION_DEF.exec(statement.text);
    if (!def) continue;
    found.push({ name: def[1], body: statement.text });
  }
  return found;
}

/** Names called inside `text` (`name(` or `schema.name(`), lower-case, without `own`. */
function callsIn(text: string, own: string): string[] {
  const called = new Set<string>();
  CALL.lastIndex = 0;
  for (const match of text.matchAll(CALL)) {
    const name = match[1].toLowerCase();
    if (name !== own) called.add(name);
  }
  return [...called].sort();
}

// a function body that CALLS out or touches cron (a URL string in data is not a call)
const NETWORK_BODY = [RULES.find((r) => r.code === 'CRON_REFERENCE')!.pattern, RULES.find((r) => r.code === 'NET_REFERENCE')!.pattern];
const matches = (pattern: RegExp, text: string) => {
  pattern.lastIndex = 0;
  const hit = pattern.test(text);
  pattern.lastIndex = 0;
  return hit;
};

export type ScanOptions = {
  /** the project the file is meant for; its own host is not "foreign" (it is still a Supabase host reference) */
  targetRef?: string;
};

export function scanSql(sql: string, options: ScanOptions = {}): ScanResult {
  const lexed = normalize(sql);
  const text = tidy(lexed.text);
  const findings: Finding[] = [];
  const add = (code: FindingCode, severity: Severity, index: number, detail: string, fingerprint?: string) => {
    findings.push({ code, severity, line: lineOf(text, index), detail, ...(fingerprint ? { fingerprint } : {}) });
  };
  if (!lexed.ok) findings.push({ code: 'UNTERMINATED_LITERAL', severity: 'block', line: 1, detail: 'a quote, comment or dollar quote does not close: scanned raw' });

  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    for (const match of text.matchAll(rule.pattern)) add(rule.code, 'block', match.index ?? 0, rule.detail);
  }
  // another project's host (a 20-character ref); the target's own host is only a SUPABASE_HOST_REFERENCE
  for (const match of text.matchAll(/\b([a-z0-9]{20})\.supabase\.(?:co|in|net)\b/giu)) {
    if (match[1].toLowerCase() !== options.targetRef) add('FOREIGN_PROJECT_HOST', 'block', match.index ?? 0, `names project ${match[1].slice(0, 4).toLowerCase()}…${match[1].slice(-4).toLowerCase()}`);
  }

  const dynamic: ScanResult['dynamic'] = [];
  DYNAMIC.lastIndex = 0;
  for (const match of text.matchAll(DYNAMIC)) {
    const start = match.index ?? 0;
    const end = statementEnd(text, start);
    const unit = collapse(text.slice(start, end));
    dynamic.push({ text: unit, line: lineOf(text, start) });
    add('DYNAMIC_SQL', 'review', start, 'dynamic SQL (EXECUTE / PREPARE)', unit);
  }

  const writes = new Set<string>();
  for (const match of text.matchAll(WRITE)) {
    const target = match[1].toLowerCase();
    writes.add(target);
    add('DATA_WRITE', 'review', match.index ?? 0, `writes ${target}`, target);
  }

  const topLevelSelects: ScanResult['topLevelSelects'] = [];
  for (const statement of splitStatements(text)) {
    const first = /^[a-z_]+/u.exec(statement.text.toLowerCase())?.[0] ?? '';
    if (first === '') continue;
    if (!KNOWN_STATEMENTS.has(first)) {
      findings.push({ code: 'UNKNOWN_STATEMENT', severity: 'block', line: statement.line, detail: `statement starts with "${first}"` });
    }
    if (first === 'select' || first === 'with') {
      const unit = collapse(statement.text);
      topLevelSelects.push({ text: unit, line: statement.line });
      findings.push({ code: 'TOP_LEVEL_SELECT', severity: 'review', line: statement.line, detail: 'a top-level SELECT runs a stored function at apply time', fingerprint: unit });
    }
  }

  const definedFunctions: FunctionDefinition[] = [];
  for (const { name, body } of functionBodies(text)) {
    const lower = name.toLowerCase();
    definedFunctions.push({
      name: lower,
      networkCapable: NETWORK_BODY.some((pattern) => matches(pattern, body)),
      calls: callsIn(body, lower),
      dynamic: matches(DYNAMIC, body),
    });
  }
  FUNCTION_RENAME.lastIndex = 0;
  for (const match of text.matchAll(FUNCTION_RENAME)) {
    definedFunctions.push({ name: match[2].toLowerCase(), networkCapable: false, calls: [match[1].toLowerCase()], dynamic: false });
  }

  const called = new Set<string>();
  for (const match of text.matchAll(/\b([a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)?)\s*\(/giu)) called.add(match[1].toLowerCase());

  return { findings, dynamic, writes: [...writes].sort(), topLevelSelects, definedFunctions, calledNames: [...called].sort() };
}

/** End of the statement that starts at `start`: the next semicolon outside quotes (inside a body that is the plpgsql statement). */
function statementEnd(text: string, start: number): number {
  let i = start;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === "'") {
      i++;
      while (i < n) {
        if (text[i] === "'") { if (text[i + 1] === "'") { i += 2; continue; } i++; break; }
        i++;
      }
      continue;
    }
    if (ch === '$' && !isWordChar(text[i - 1]) && DOLLAR_TAG.test(text.slice(i, i + 80))) {
      const tag = DOLLAR_TAG.exec(text.slice(i, i + 80)) as RegExpExecArray;
      const close = text.indexOf(tag[0], i + tag[0].length);
      i = close === -1 ? n : close + tag[0].length;
      continue;
    }
    if (ch === ';') return i;
    i++;
  }
  return n;
}

// ---- the corpus: helper functions that reach the network, and who calls them -------------------------------------------

const bare = (name: string) => name.slice(name.lastIndexOf('.') + 1);

/**
 * Closes a property over the call graph of the corpus: a function has it when its text has it, or when it calls a
 * function that has it, to a fixed point (so multi-hop helpers, cycles and helpers split over files are all reached).
 * Names are matched WITHOUT their schema and without a signature: any definition of a bare name that has the property
 * taints the bare name for every schema and overload. Over-approximating is the safe direction.
 */
function closure(scans: readonly ScanResult[], direct: (fn: FunctionDefinition) => boolean): Set<string> {
  const definitions = scans.flatMap((scan) => scan.definedFunctions);
  const tainted = new Set<string>();
  for (const fn of definitions) if (direct(fn)) tainted.add(bare(fn.name));
  for (let changed = true; changed;) {
    changed = false;
    for (const fn of definitions) {
      const name = bare(fn.name);
      if (!tainted.has(name) && fn.calls.some((called) => tainted.has(bare(called)))) {
        tainted.add(name);
        changed = true;
      }
    }
  }
  const names = new Set<string>();
  for (const fn of definitions) {
    if (!tainted.has(bare(fn.name))) continue;
    names.add(fn.name);
    names.add(bare(fn.name));
    names.add(`public.${bare(fn.name)}`);
  }
  return names;
}

/** Names (with and without a schema) of every corpus function that reaches the network or cron, directly or through helpers. */
export function networkFunctionNames(scans: readonly ScanResult[]): Set<string> {
  return closure(scans, (fn) => fn.networkCapable);
}

/** Names of corpus functions that run SQL assembled at run time, directly or through helpers: what they reach is unknowable. */
export function dynamicFunctionNames(scans: readonly ScanResult[]): Set<string> {
  return closure(scans, (fn) => fn.dynamic);
}

/**
 * Calls (as written, lower-case) of corpus functions that run SQL assembled at run time, by a scan that does not define
 * them. What such a callee reaches is unknowable lexically, so each one is an effect the review must accept by name.
 */
export function indirectDynamicCalls(scan: ScanResult, dynamic: ReadonlySet<string>): string[] {
  const own = new Set(scan.definedFunctions.map((fn) => fn.name));
  const tainted = new Set([...dynamic].map(bare));
  return scan.calledNames.filter((name) => tainted.has(bare(name)) && !own.has(name)).sort();
}

/** Calls of corpus network helpers by a scan that does not itself define them. */
export function indirectNetworkCalls(scan: ScanResult, network: ReadonlySet<string>): Finding[] {
  const own = new Set(scan.definedFunctions.map((fn) => fn.name));
  const tainted = new Set([...network].map(bare));
  const out: Finding[] = [];
  for (const name of scan.calledNames) {
    if (tainted.has(bare(name)) && !own.has(name)) {
      out.push({ code: 'INDIRECT_NETWORK_CALL', severity: 'block', line: 1, detail: `calls ${name}, which reaches the network or cron` });
    }
  }
  return out;
}
