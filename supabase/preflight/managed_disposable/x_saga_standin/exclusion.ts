// Structural production exclusion of the X saga stand-in (Phase 13, D-2). SOURCE ONLY, PURE: it reads file texts handed in by a
// reader and returns findings; it executes nothing and imports nothing from the code it examines.
//
// "Not reachable from production" is established by the IMPORT GRAPH, not by a flag:
//   E1  no file of the stand-in directory is reachable (value or type import, transitively) from any Edge function entry
//       (`supabase/functions/*/index.ts`), and no file under supabase/functions even MENTIONS the directory;
//   E2  no file outside the allowed set (the directory, its own runner and tests, documentation, coordination files) mentions the
//       directory anywhere under supabase/ or apps/;
//   E3  the stand-in's RUNTIME files (standin.ts, harness.ts) import only each other, and from production code only TYPES
//       (`import type`, erased: no runtime import of any cleanup, transport or secret reader);
//   E4  the runtime files contain no way out: no network, environment, file, subprocess, dynamic import, eval, global object; no
//       URL, host or credential-shaped text; no Vault / OAuth / X-API vocabulary in code;
//   E5  the word `done` as an outcome appears in exactly one place: the single conversion in harness.ts;
//   E6  nothing in the directory is secret-shaped.
// Every rule has a negative test that plants the violation and sees the finding (exclusion_test.ts).
import { secretFindings } from '../inventory.ts';

export type Reader = {
  /** every file path (repository-relative, `/`-separated) under a directory, recursively */
  walk(dir: string): string[];
  read(path: string): string;
};
export type ExclusionFinding = { code: string; file: string; detail: string };

export const STAND_IN_DIR = 'supabase/preflight/managed_disposable/x_saga_standin';
export const FUNCTIONS_DIR = 'supabase/functions';
/** The files that run inside the harness: strict rules (E3-E5). Everything else in the directory is tooling or a test. */
export const RUNTIME_FILES = ['standin.ts', 'harness.ts'] as const;
/** Paths that may mention the directory name outside of it. */
export const ALLOWED_MENTIONS: readonly RegExp[] = [
  /^supabase\/preflight\/managed_disposable\/x_saga_standin\//u,
  /^supabase\/tests\/common_account_phase13_d2_/u,
  /^docs\//u, /^\.agent/u,
];
const SOURCE_EXTENSIONS = /\.(?:ts|tsx|js|jsx|mjs|cjs|json|sql|sh|py|toml|yml|yaml)$/u;

/** Blanks comments (and, for `code`, string literals) with spaces so that offsets and line numbers survive. */
export function views(text: string): { noComments: string; code: string } {
  let noComments = '';
  let code = '';
  let i = 0;
  const push = (visible: string, blankedInCode: boolean) => {
    noComments += visible;
    code += blankedInCode ? visible.replace(/[^\n]/gu, ' ') : visible;
  };
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (c === '/' && next === '/') {
      const end = text.indexOf('\n', i);
      const stop = end < 0 ? text.length : end;
      const blank = ' '.repeat(stop - i);
      noComments += blank;
      code += blank;
      i = stop;
    } else if (c === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end < 0 ? text.length : end + 2;
      const blank = text.slice(i, stop).replace(/[^\n]/gu, ' ');
      noComments += blank;
      code += blank;
      i = stop;
    } else if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < text.length && text[j] !== c) j += text[j] === '\\' ? 2 : 1;
      const literal = text.slice(i, j + 1);
      noComments += literal;
      code += `${c}${literal.slice(1, -1).replace(/[^\n]/gu, ' ')}${literal.length > 1 ? c : ''}`;
      i = j + 1;
    } else {
      push(c, false);
      i += 1;
    }
  }
  return { noComments, code };
}

export type ImportRef = { specifier: string; typeOnly: boolean; dynamic: boolean };

/** Static `import ... from`, side-effect `import '...'`, `export ... from`, and dynamic `import('...')` with a literal. */
export function importsOf(text: string): ImportRef[] {
  // the raw text, comments included: a commented-out import only adds an edge, which is the strict direction for a reachability check
  const noComments = text;
  const found: ImportRef[] = [];
  for (const match of noComments.matchAll(/\b(import|export)\s+(type\s+)?(?:[\w*{}\s,$]+?\s+from\s+)?['"]([^'"]+)['"]/gu)) {
    if (match[1] === 'export' && !/\bfrom\b/u.test(match[0])) continue;
    found.push({ specifier: match[3], typeOnly: match[2] !== undefined, dynamic: false });
  }
  for (const match of noComments.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/gu)) found.push({ specifier: match[1], typeOnly: false, dynamic: true });
  return found;
}

/** Repository-relative resolution of a RELATIVE specifier; anything else (npm:, node:, https:, bare) is external (null). */
export function resolveRelative(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) return null;
  const parts = fromFile.split('/').slice(0, -1);
  for (const part of specifier.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return parts.join('/');
}

/** Every file reachable from the entries through relative imports (type-only imports count: the graph is deliberately strict). */
export function reachable(entries: readonly string[], read: (path: string) => string): Set<string> {
  const seen = new Set<string>();
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    let text: string;
    try {
      text = read(file);
    } catch {
      continue; // an import of a file that does not exist is not this check's business
    }
    for (const ref of importsOf(text)) {
      const target = resolveRelative(file, ref.specifier);
      if (target !== null) queue.push(target);
    }
  }
  return seen;
}

const FORBIDDEN_CODE: readonly { code: string; pattern: RegExp }[] = [
  { code: 'NETWORK', pattern: /\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b|\bEventSource\b|\bsendBeacon\b|\bBroadcastChannel\b/u },
  { code: 'DENO_NAMESPACE', pattern: /\bDeno\b/u },
  { code: 'ENVIRONMENT', pattern: /\bprocess\b|\benv\s*\.\s*get\b|\bgetEnv\b|\bimport\s*\.\s*meta\b/u },
  { code: 'DYNAMIC_CODE', pattern: /\bimport\s*\(|\beval\s*\(|\bnew\s+Function\b|\brequire\s*\(|\bglobalThis\b|\bself\b\s*\./u },
  { code: 'TIMER', pattern: /\bsetTimeout\b|\bsetInterval\b|\bqueueMicrotask\b/u },
  { code: 'RANDOM_OR_CLOCK', pattern: /\bMath\s*\.\s*random\b|\bDate\s*\.\s*now\b|\bnew\s+Date\b|\bperformance\s*\.\s*now\b/u },
  { code: 'DATABASE_OR_VAULT_OR_OAUTH', pattern: /psql|\bpg_[a-z]+|vault|oauth|service_role|api_?key|refresh_token|access_token|client_secret/iu },
];

/** The findings of E1-E6 for the stand-in directory, given a reader of the repository. */
export function exclusionFindings(reader: Reader): ExclusionFinding[] {
  const findings: ExclusionFinding[] = [];
  const add = (code: string, file: string, detail: string) => findings.push({ code, file, detail });
  const dirFiles = reader.walk(STAND_IN_DIR).filter((file) => file.endsWith('.ts'));
  const inDir = (file: string) => file === STAND_IN_DIR || file.startsWith(`${STAND_IN_DIR}/`);

  // E1: the import graph of production never reaches the directory, and production never names it
  const functionFiles = reader.walk(FUNCTIONS_DIR).filter((file) => file.endsWith('.ts') || file.endsWith('.tsx') || file.endsWith('.js'));
  const entries = functionFiles.filter((file) => /^supabase\/functions\/[^/]+\/index\.ts$/u.test(file));
  if (entries.length === 0) add('NO_PRODUCTION_ENTRY', FUNCTIONS_DIR, 'no Edge function entry was found: the reachability check would be vacuous');
  for (const file of reachable(entries, reader.read)) if (inDir(file)) add('REACHABLE_FROM_PRODUCTION', file, 'an Edge function entry reaches this stand-in file through its imports');
  for (const file of functionFiles) {
    if (reader.read(file).includes('x_saga_standin')) add('PRODUCTION_MENTIONS_STAND_IN', file, 'a file under supabase/functions names the stand-in directory');
  }

  // E2: nothing outside the allowed set names it
  for (const root of ['supabase', 'apps']) {
    for (const file of reader.walk(root)) {
      if (!SOURCE_EXTENSIONS.test(file) || ALLOWED_MENTIONS.some((allowed) => allowed.test(file))) continue;
      if (reader.read(file).includes('x_saga_standin')) add('MENTIONED_OUTSIDE_ALLOWED', file, 'this file is not allowed to name the stand-in directory');
    }
  }

  // E3-E5 on the runtime files
  const runtime = RUNTIME_FILES.map((name) => `${STAND_IN_DIR}/${name}`);
  for (const file of runtime) {
    let text: string;
    try {
      text = reader.read(file);
    } catch {
      add('RUNTIME_FILE_MISSING', file, 'a runtime file of the stand-in is missing');
      continue;
    }
    for (const ref of importsOf(text)) {
      if (ref.dynamic) add('DYNAMIC_IMPORT', file, `dynamic import of ${ref.specifier}`);
      const target = resolveRelative(file, ref.specifier);
      if (target === null) {
        add('EXTERNAL_IMPORT', file, `imports ${ref.specifier}: the runtime files import nothing external`);
      } else if (!inDir(target)) {
        if (!target.startsWith(`${FUNCTIONS_DIR}/`)) add('IMPORT_OUTSIDE_DIRECTORY', file, `imports ${target}`);
        else if (!ref.typeOnly) add('VALUE_IMPORT_FROM_PRODUCTION', file, `imports ${target} as a value: only \`import type\` is allowed`);
      } else if (!runtime.includes(target)) {
        add('IMPORT_OF_TOOLING', file, `imports ${target}, which is test support or tooling`);
      }
    }
    const { code } = views(text);
    for (const rule of FORBIDDEN_CODE) {
      const match = rule.pattern.exec(code);
      if (match) add(`FORBIDDEN_${rule.code}`, file, `code contains \`${match[0].trim().slice(0, 40)}\` (line ${code.slice(0, match.index).split('\n').length})`);
    }
    // E5: where the word `done` is an outcome
    const doneOutcome = [...views(text).noComments.matchAll(/\boutcome\s*:\s*['"]done['"]/gu)].length;
    const allowed = file.endsWith('/harness.ts') ? 1 : 0;
    if (doneOutcome !== allowed) add('DONE_OUTCOME', file, `${doneOutcome} occurrence(s) of the outcome \`done\`, ${allowed} allowed (the one conversion lives in harness.ts)`);
    if (!file.endsWith('/harness.ts') && /\bXCleanup(?:Result|Outcome)\b/u.test(views(text).noComments)) add('LIFECYCLE_TYPE_OUTSIDE_HARNESS', file, 'only harness.ts may name the lifecycle result types');
  }

  // E6: nothing secret-shaped, URL-shaped or host-shaped anywhere in the directory
  for (const file of dirFiles) {
    for (const finding of secretFindings(reader.read(file))) add('SECRET_SHAPED', file, finding.code);
  }
  return findings;
}
