// Isolation and Edge / Deno compatibility of the provider module (required test 29, and the Primary scope):
//   - runtime sources use web-standard APIs only: no node: imports, no Deno.* (the environment is read through the
//     injected reader), no console output;
//   - the only external dependency is the exactly pinned official Anthropic SDK, in the Anthropic adapter only;
//   - provider hosts and model ids appear only where they belong;
//   - Provider scope: outside this module, only the files in AUTHORIZED_REFERENCES name it, with exactly those
//     imports: the shared market report handler (F6 V0 / F2, the one Edge entry point that reaches it) and the
//     unwired H5 consumer bridge library (F6 / H5 boundary, 2026-10-15). Of all deployable sources only
//     AUTHORIZED_REACHERS reach it, and of the Edge Function entry points only market-report-analysis/index.ts.
//     A deployable file that imports the public entry (mod.ts) may use exactly the names in AUTHORIZED_MOD_IMPORTS
//     (least privilege: no ledger guard construction, no secret readers, no unpoliced executeAiRequest); the report
//     handler likewise takes exactly its names from market_report_primary.ts (AUTHORIZED_PROVIDER_IMPORTS). The
//     Anthropic SDK and key names stay inside it (plus the handler's offline test); no app references it or the key.
//   - The scan fails closed (F6 J1 R1, 2026-10-16): a dynamic import() hands over every export, and whatever it
//     cannot follow (computed or bare specifiers, missing or unreadable files, symlinks, import maps) is refused.
import assert from "node:assert/strict";
import test from "node:test";

const MODULE_DIR = new URL("./", import.meta.url);
const FUNCTIONS_DIR = new URL("../../", import.meta.url);
const REPO_ROOT = new URL("../../../../", import.meta.url);

async function moduleSources(): Promise<Array<{ name: string; text: string }>> {
  const out: Array<{ name: string; text: string }> = [];
  for await (const entry of Deno.readDir(MODULE_DIR)) {
    if (!entry.isFile || !entry.name.endsWith(".ts") || entry.name.endsWith("_test.ts") || entry.name === "test_support.ts") continue;
    out.push({ name: entry.name, text: await Deno.readTextFile(new URL(entry.name, MODULE_DIR)) });
  }
  return out;
}

function code(text: string): string {
  // Drop comments so documentation may name things freely.
  return text.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/(^|[^:"'`])\/\/.*$/gmu, "$1");
}

test("29. runtime sources use web-standard APIs only (no node:, no Deno.*, no console)", async () => {
  const sources = await moduleSources();
  assert.ok(sources.length >= 12, "scanned the module");
  for (const { name, text } of sources) {
    const body = code(text);
    assert.doesNotMatch(body, /from\s+["']node:/u, `${name} imports a Node built-in`);
    // (The string "Deno.customInspect" passed to Symbol.for is a symbol name, not an API call.)
    assert.doesNotMatch(body, /(?<!["'])\bDeno\./u, `${name} uses a Deno-only API`);
    assert.doesNotMatch(body, /\bconsole\./u, `${name} logs`);
    assert.doesNotMatch(body, /\bprocess\.env\b/u, `${name} reads process.env`);
  }
});

test("29. the only external import is the pinned Anthropic SDK, in the Anthropic adapter; relative imports stay inside", async () => {
  for (const { name, text } of await moduleSources()) {
    const specifiers = [...code(text).matchAll(/(?:import|export)[^"']*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/gu)].map((m) => m[1] ?? m[2]);
    for (const specifier of specifiers) {
      if (specifier.startsWith("./")) continue;
      assert.equal(name, "anthropic_adapter.ts", `${name} imports ${specifier}`);
      assert.equal(specifier, "npm:@anthropic-ai/sdk@0.132.1");
    }
  }
});

test("provider hosts appear only in their adapters; model ids only in the catalog", async () => {
  for (const { name, text } of await moduleSources()) {
    const body = code(text);
    if (name !== "openai_adapter.ts") assert.doesNotMatch(body, /api\.openai\.com/u, name);
    if (name !== "anthropic_adapter.ts") assert.doesNotMatch(body, /api\.anthropic\.com/u, name);
    if (name !== "model_catalog.ts") assert.doesNotMatch(body, /["'`](claude-[a-z0-9-]+|gpt-[0-9][0-9.]*-[a-z]+)["'`]/u, `${name} names a model`);
  }
});

// ---- Primary scope ------------------------------------------------------------------------------------------------
// The checks below are pure functions over a file tree (path relative to supabase/functions/ -> text), so the same
// code runs on the repository and on synthetic trees that must be refused.
//
// Fail closed (F6 J1 R1, 2026-10-16). Imports are read from the module's tokens (lexer and parser below, J1 R1b /
// R1c), and the text of every comment and literal is scanned as well, so neither can hide one (at worst a text adds an
// edge). Whatever the scan cannot follow is refused instead of counting as "does not reach":
// an import() whose argument is not one plain string literal, a bare / absolute / data: specifier, a relative import
// of a file the scanned tree does not have (missing, another letter case, a hidden or skipped directory, outside the
// functions directory), a symlink, an unreadable file or directory, and any configuration that can remap specifiers
// (import maps, scopes, workspaces, links, patches, package.json). A deployable file takes from a module file only
// the names listed for it; a dynamic import(), a namespace import or `export *` takes "*" (every export).

type Tree = ReadonlyMap<string, string>;

const MODULE_PREFIX = "_shared/ai_provider/";

/** Every file outside this module that names it, with every specifier it uses for it. Nothing else may. */
const AUTHORIZED_REFERENCES: Record<string, readonly string[]> = {
  "market-report-analysis/handler.ts": [
    "../_shared/ai_provider/market_report_primary.ts",
  ],
  // H5 consumer bridge (PR #198): an unwired server library and its offline tests.
  "_shared/ai_consumer_bridge/bridge.ts": ["../ai_provider/mod.ts"],
  "_shared/ai_consumer_bridge/types.ts": ["../ai_provider/mod.ts"],
  "_shared/ai_consumer_bridge/bridge_test.ts": ["../ai_provider/test_support.ts"],
  "_shared/ai_consumer_bridge/isolation_test.ts": ["../ai_provider/mod.ts"],
  "_shared/ai_consumer_bridge/offline_samples_test.ts": ["../ai_provider/mod.ts", "../ai_provider/test_support.ts"],
};

/** The deployable sources that may reach this module: the report handler and its entry point, and the bridge library. */
const AUTHORIZED_REACHERS = [
  "_shared/ai_consumer_bridge/bridge.ts",
  "_shared/ai_consumer_bridge/types.ts",
  "market-report-analysis/handler.ts",
  "market-report-analysis/index.ts",
];

/** Edge Function entry points (<function>/index.ts) that may reach this module. */
const AUTHORIZED_ENTRY_POINTS = ["market-report-analysis/index.ts"];

/**
 * Deployable files that import a file of the module -> per module file, exactly the names each may take from it.
 * Anything else is refused: "*" (a namespace import, `export *` or a dynamic import(), which hands over every
 * export), a default or side-effect import, an import clause the scan cannot read ("<unparsed>"), or another name
 * (SupabaseLedgerBudgetGuard, InMemoryBudgetGuard, resolveProviderApiKey, resolveSecret, executeAiRequest,
 * primaryLedgerFromEdgeEnv, ...). The bridge spends only through model policies and caller deps; the report handler
 * only through its primary.
 */
const AUTHORIZED_PROVIDER_IMPORTS: Record<string, Record<string, readonly string[]>> = {
  "_shared/ai_consumer_bridge/bridge.ts": {
    "_shared/ai_provider/mod.ts": [
      "AiReasoningEffort",
      "AiSubject",
      "assertSchemaSupported",
      "BudgetGuard",
      "defineAnthropicModelPolicies",
      "executeWithModelPolicy",
      "findModelSpec",
      "ModelPolicyRegistry",
      "modelPolicyRequest",
      "resolveModelChoice",
      "upperBoundAttemptCostUsd",
      "validateAgainstSchema",
      "validateAiRequest",
    ],
  },
  "_shared/ai_consumer_bridge/types.ts": {
    "_shared/ai_provider/mod.ts": ["AiSubject", "AnthropicModelPolicy", "ExecuteDeps", "JsonSchema"],
  },
  "market-report-analysis/handler.ts": {
    "_shared/ai_provider/market_report_primary.ts": [
      "MARKET_REPORT_AI_MODE_ENV",
      "MarketReportPrimaryRecord",
      "PRIMARY_RUN_BUDGET_MS",
      "prepareMarketReportPrimary",
    ],
  },
};

/** Outside this module, the Anthropic SDK and ANTHROPIC_* names appear only in the handler's offline test. */
const AUTHORIZED_ANTHROPIC_NAMES = ["market-report-analysis/opus_primary_handler_test.ts"];

/** Specifiers that never name a file of this tree: the package registries, Node built-ins and HTTPS modules. */
const EXTERNAL_SPECIFIER = /^(?:npm:|jsr:|node:|https:\/\/)/u;

/** Keys of a Deno config / import map / package.json that can send a specifier to another file. */
const REMAPPING_KEYS = ["imports", "scopes", "importMap", "workspace", "workspaces", "links", "patch"];

const isTestFile = (path: string) => path.endsWith("_test.ts") || path.endsWith("/test_support.ts");
const isCode = (path: string) => /\.(ts|tsx|js|mjs)$/u.test(path);
const isDeployable = (path: string) => !path.startsWith(MODULE_PREFIX) && isCode(path) && !isTestFile(path);

/** Files outside the module that mention it (any letter case) -> sorted specifiers; a mention outside a string literal is "<bare>". */
function directReferences(tree: Tree): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [path, text] of tree) {
    if (path.startsWith(MODULE_PREFIX) || !/ai_provider\//iu.test(text)) continue;
    const literals = [...text.matchAll(/["'`]([^"'`\n]*ai_provider\/[^"'`\n]*)["'`]/giu)].map((m) => m[1]);
    const mentions = text.match(/ai_provider\//giu)?.length ?? 0;
    const specifiers = new Set(literals);
    if (mentions !== literals.length) specifiers.add("<bare>");
    out[path] = [...specifiers].sort();
  }
  return out;
}

type ImportEdge = {
  /** The specifier, or null when it is computed (an import() whose argument is not one plain string literal). */
  readonly specifier: string | null;
  /** What it takes: names, "default:<local>", "*" (every export), "<side-effect>" or "<unparsed>". */
  readonly names: readonly string[];
  /** False for a `from "x"` that is not plainly part of an import / export statement (it may be text in a string). */
  readonly statement: boolean;
};

/**
 * ECMAScript trivia, legal between any two tokens (F6 J1 R1a, 2026-10-16): white space and line terminators (`\s`
 * covers every Unicode space, U+2028 / U+2029 and the BOM), block comments and line comments. `import/* x *\/(...)`,
 * `import // x` + a new line + `(...)` and `from/* x *\/"..."` are ordinary imports.
 */
const TRIVIA = String.raw`(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n\r\u2028\u2029]*)*`;
/** A string literal (group 1 = quote, group 2 = raw body), escapes and line continuations included. */
const STRING_LITERAL = String.raw`(["'])((?:[^"'\\\n\r]|\\(?:\r\n|[\s\S])|(?!\1)["'])*)\1`;
const FROM_CLAUSE = new RegExp(String.raw`\bfrom${TRIVIA}${STRING_LITERAL}`, "gu");
const SIDE_EFFECT_IMPORT = new RegExp(String.raw`\bimport${TRIVIA}${STRING_LITERAL}`, "gu");
const DYNAMIC_IMPORT = new RegExp(String.raw`\bimport${TRIVIA}\(`, "gu");
/** A keyword followed by a comment that never ends: a module the loader rejects, and the scan cannot read. */
const UNTERMINATED_TRIVIA = new RegExp(String.raw`\b(?:import|export|from)${TRIVIA}\/\*(?![\s\S]*\*\/)`, "gu");
const TRIVIA_AT = new RegExp(TRIVIA, "uy");
const STRING_AT = new RegExp(STRING_LITERAL, "uy");
const COMMENT = /\/\*[\s\S]*?\*\/|\/\/[^\n\r\u2028\u2029]*/gu;

/** The index after the trivia starting at `i`. */
function skipTrivia(text: string, i: number): number {
  TRIVIA_AT.lastIndex = i;
  return TRIVIA_AT.exec(text) ? TRIVIA_AT.lastIndex : i;
}

/**
 * The value of a string literal body: escapes and line continuations decoded the way the module loader sees them, or
 * null for anything a strict-mode module would reject (legacy octal escapes) or the scan does not decode.
 */
function decodeString(body: string): string | null {
  let out = "";
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const next = body[i + 1];
    i += 1;
    if (next === undefined) return null;
    if (next === "\r") {
      if (body[i + 1] === "\n") i += 1;
    } else if (next === "\n" || next === "\u2028" || next === "\u2029") {
      // A line continuation adds nothing.
    } else if (next === "u") {
      const braced = /^\{([0-9a-fA-F]{1,6})\}/u.exec(body.slice(i + 1));
      const plain = /^[0-9a-fA-F]{4}/u.exec(body.slice(i + 1));
      if (braced) {
        const code = parseInt(braced[1], 16);
        if (code > 0x10ffff) return null;
        out += String.fromCodePoint(code);
        i += braced[0].length;
      } else if (plain) {
        out += String.fromCharCode(parseInt(plain[0], 16));
        i += 4;
      } else return null;
    } else if (next === "x") {
      const hex = /^[0-9a-fA-F]{2}/u.exec(body.slice(i + 1));
      if (!hex) return null;
      out += String.fromCharCode(parseInt(hex[0], 16));
      i += 2;
    } else if (next === "0" && !/[0-9]/u.test(body[i + 1] ?? "")) {
      out += "\0";
    } else if (/[0-9]/u.test(next)) {
      return null;
    } else {
      out += ({ b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" } as Record<string, string>)[next] ?? next;
    }
  }
  return out;
}

/** `{ a, b as c }`, `* as ns`, `*`, `x`, `x, { a }`, `x, * as ns`, each optionally after `type`; no quotes. */
const PLAIN_CLAUSE =
  /^\s*(?:type\s+)?(?:\{[^{}"'`;]*\}|\*(?:\s+as\s+[\w$]+)?|[\w$]+(?:\s*,\s*(?:\{[^{}"'`;]*\}|\*\s+as\s+[\w$]+))?)\s*$/u;

/** The names a plain import / export clause (comments removed) takes. */
function clauseNames(clause: string): string[] {
  const names = new Set<string>();
  const body = clause.trim().replace(/^type\s+/u, "");
  if (body.includes("*")) names.add("*");
  const braces = body.match(/\{([^}]*)\}/u);
  if (braces) {
    for (const part of braces[1].split(",")) {
      const name = part.trim().replace(/^type\s+/u, "").split(/\s+as\s+/u)[0].trim();
      if (name) names.add(name);
    }
  }
  const head = body.replace(/\{[^}]*\}/u, "").replace(/\*(?:\s+as\s+[\w$]+)?/u, "").replace(/,/gu, " ").trim();
  if (head) names.add(`default:${head}`);
  return [...names];
}

/**
 * The argument of the import( ending at `start`: its value if it is one string literal (trivia allowed around it,
 * optionally followed by import options), else null (computed).
 */
function literalArgument(text: string, start: number): string | null {
  const i = skipTrivia(text, start);
  let value: string | null;
  let after: number;
  if (text[i] === "`") {
    const end = text.indexOf("`", i + 1);
    if (end < 0) return null;
    value = text.slice(i + 1, end);
    // An escape or an interpolation would have to be evaluated: computed.
    if (/[\\]|\$\{/u.test(value)) return null;
    after = end + 1;
  } else {
    STRING_AT.lastIndex = i;
    const literal = STRING_AT.exec(text);
    if (!literal) return null;
    value = decodeString(literal[2]);
    after = STRING_AT.lastIndex;
  }
  const j = skipTrivia(text, after);
  // `import("x")` or `import("x", options)`; "x" + y, "x".concat(y) and anything else are computed.
  return value !== null && (text[j] === ")" || text[j] === ",") ? value : null;
}

/**
 * The import forms found in a piece of TEXT: a comment, a string, a template chunk or a regex body, read with the
 * trivia-aware patterns above. Code is read by the lexer below. Text is scanned too because the one guess a lexer
 * without a full parser makes (does "/" start a regex or divide?) could, if wrong, turn code into text; this scan
 * can only add edges, never remove one.
 */
function textEdges(text: string): ImportEdge[] {
  const edges: ImportEdge[] = [];
  const keywordEnds = [...text.matchAll(/\b(?:import|export)\b/gu)].map((m) => m.index + m[0].length);
  let k = -1;
  for (const m of text.matchAll(FROM_CLAUSE)) {
    while (k + 1 < keywordEnds.length && keywordEnds[k + 1] <= m.index) k += 1;
    const clause = k >= 0 ? text.slice(keywordEnds[k], m.index).replace(COMMENT, " ") : null;
    const plain = clause !== null && PLAIN_CLAUSE.test(clause);
    edges.push({ specifier: decodeString(m[2]), names: plain ? clauseNames(clause) : ["<unparsed>"], statement: plain });
  }
  for (const m of text.matchAll(SIDE_EFFECT_IMPORT)) edges.push({ specifier: decodeString(m[2]), names: ["<side-effect>"], statement: true });
  for (const m of text.matchAll(DYNAMIC_IMPORT)) {
    edges.push({ specifier: literalArgument(text, m.index + m[0].length), names: ["*"], statement: true });
  }
  for (const _ of text.matchAll(UNTERMINATED_TRIVIA)) edges.push({ specifier: null, names: ["<unparsed>"], statement: true });
  return edges;
}

// ---- Lexer and module-edge parser (F6 J1 R1b / R1c, 2026-10-16) ----------------------------------------------------
// The module is split into tokens the way an ECMAScript / TypeScript lexer does: white space, line terminators and
// comments are trivia (a block comment ends at its FIRST "*/"); string, template, regex and number literals are single
// tokens; names and punctuators are the rest. Text inside a literal or a comment is never read as code, so a string
// such as "import/*" cannot open a comment, and comments between the tokens of an import are just trivia. The edges
// are then read from the tokens by the grammar of import / export declarations and import(). The one context guess is
// whether "/" starts a regex or divides; it follows the usual rules (a regex after an operator, after a keyword such
// as return, after the ")" of if / while / for / with and after the "}" of a block; otherwise division), and textEdges
// covers the text of every literal and comment in case a guess is wrong. Malformed input (an unterminated string,
// template, regex or comment, unbalanced brackets, an unknown character) makes the whole file unparsed: refused.
// This is a static CI check of the source, not a runtime sandbox.

type Token =
  | { readonly kind: "name"; readonly value: string; readonly escaped: boolean }
  | { readonly kind: "punct"; readonly value: string }
  | { readonly kind: "string"; readonly value: string | null }
  | { readonly kind: "template"; readonly value: string | null }
  | { readonly kind: "regex" }
  | { readonly kind: "number" };

type Lexed = { readonly tokens: readonly Token[]; readonly texts: readonly string[]; readonly error: string | null };

const WHITE_SPACE_AT = /\s+/uy;
const LINE_BREAK = /[\n\r\u2028\u2029]/u;
const LINE_COMMENT_AT = /\/\/([^\n\r\u2028\u2029]*)/uy;
const HASHBANG_AT = /#![^\n\r\u2028\u2029]*/uy;
const NAME_AT = /(?:[\p{ID_Start}$_#]|\\u[0-9a-fA-F]{4}|\\u\{[0-9a-fA-F]+\})(?:[\p{ID_Continue}$]|\\u[0-9a-fA-F]{4}|\\u\{[0-9a-fA-F]+\})*/uy;
const NUMBER_AT = /(?:0[xXoObB][0-9a-fA-F_]+n?|(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d[\d_]*)?n?)/uy;
const REGEX_FLAGS_AT = /[\p{ID_Continue}$]*/uy;
/** Longest first. "/" and "/=" are decided separately (regex or division). */
const PUNCTUATORS = [
  ">>>=", "...", "===", "!==", "**=", "<<=", ">>=", ">>>", "&&=", "||=", "??=",
  "=>", "==", "!=", "<=", ">=", "&&", "||", "??", "?.", "++", "--", "+=", "-=", "*=", "%=", "&=", "|=", "^=", "<<", ">>", "**",
  "{", "}", "(", ")", "[", "]", ";", ",", "<", ">", "+", "-", "*", "%", "&", "|", "^", "!", "~", "?", ":", "=", ".", "@",
];
/** Keywords after which an expression (so a regex, or an object literal) starts. */
const KEYWORDS_BEFORE_EXPRESSION: ReadonlySet<string> = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await",
]);
const CONTROL_KEYWORDS: ReadonlySet<string> = new Set(["if", "while", "for", "with"]);

function decodeName(raw: string): string {
  return raw.replace(/\\u\{([0-9a-fA-F]+)\}|\\u([0-9a-fA-F]{4})/gu, (_m, braced, plain) => String.fromCodePoint(parseInt(braced ?? plain, 16)));
}

/** Whether a "{" after `prev` opens a block (a "/" after its "}" starts a regex) rather than an object literal. */
function braceOpensBlock(prev: Token | undefined): boolean {
  if (prev === undefined) return true;
  if (prev.kind === "punct") return [")", "]", "}", ";", "{", "=>", ">"].includes(prev.value);
  if (prev.kind === "name") return !KEYWORDS_BEFORE_EXPRESSION.has(prev.value) || prev.value === "do" || prev.value === "else";
  return false;
}

function lexModule(text: string): Lexed {
  const tokens: Token[] = [];
  const texts: string[] = [];
  // Open brackets: "(" or "(if" (after if / while / for / with), "[", "{block", "{expr", and "${" (a substitution).
  const open: string[] = [];
  let regexAllowed = true;
  let i = 0;
  const fail = (reason: string): Lexed => ({ tokens, texts, error: `${reason}@${i}` });
  const sticky = (pattern: RegExp): RegExpExecArray | null => {
    pattern.lastIndex = i;
    const match = pattern.exec(text);
    if (match) i = pattern.lastIndex;
    return match;
  };
  // A template chunk from i (just after "`", or after the "}" that closes a substitution) up to "`" or "${".
  const templateChunk = (whole: boolean): boolean => {
    let j = i;
    while (j < text.length && text[j] !== "`" && !(text[j] === "$" && text[j + 1] === "{")) j += text[j] === "\\" ? 2 : 1;
    if (j >= text.length) return false;
    const raw = text.slice(i, j);
    texts.push(raw);
    if (text[j] === "`") {
      tokens.push({ kind: "template", value: whole ? decodeString(raw) : null });
      i = j + 1;
      regexAllowed = false;
    } else {
      tokens.push({ kind: "template", value: null });
      open.push("${");
      i = j + 2;
      regexAllowed = true;
    }
    return true;
  };

  if (text.startsWith("#!")) sticky(HASHBANG_AT);
  while (i < text.length) {
    if (sticky(WHITE_SPACE_AT)) continue;
    const ch = text[i];
    const next = text[i + 1];
    if (ch === "/" && next === "/") {
      texts.push(sticky(LINE_COMMENT_AT)![1]);
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end < 0) return fail("unterminated comment");
      texts.push(text.slice(i + 2, end));
      i = end + 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const literal = sticky(STRING_AT);
      if (!literal) return fail("unterminated string");
      texts.push(literal[2]);
      tokens.push({ kind: "string", value: decodeString(literal[2]) });
      regexAllowed = false;
      continue;
    }
    if (ch === "`" || (ch === "}" && open.at(-1) === "${")) {
      if (ch === "}") open.pop();
      i += 1;
      if (!templateChunk(ch === "`")) return fail("unterminated template");
      continue;
    }
    if (ch === "/" && regexAllowed) {
      let j = i + 1;
      let inClass = false;
      for (;; j += 1) {
        const c = text[j];
        if (c === undefined || LINE_BREAK.test(c)) return fail("unterminated regex");
        if (c === "\\") {
          j += 1;
          if (text[j] === undefined || LINE_BREAK.test(text[j])) return fail("unterminated regex");
        } else if (c === "[") inClass = true;
        else if (c === "]") inClass = false;
        else if (c === "/" && !inClass) break;
      }
      texts.push(text.slice(i + 1, j));
      i = j + 1;
      sticky(REGEX_FLAGS_AT);
      tokens.push({ kind: "regex" });
      regexAllowed = false;
      continue;
    }
    if (/\d/u.test(ch) || (ch === "." && /\d/u.test(next ?? ""))) {
      sticky(NUMBER_AT);
      tokens.push({ kind: "number" });
      regexAllowed = false;
      continue;
    }
    const prev = tokens.at(-1);
    const name = sticky(NAME_AT);
    if (name) {
      const escaped = name[0].includes("\\");
      const value = escaped ? decodeName(name[0]) : name[0];
      const property = prev?.kind === "punct" && (prev.value === "." || prev.value === "?.");
      tokens.push({ kind: "name", value, escaped });
      regexAllowed = !property && KEYWORDS_BEFORE_EXPRESSION.has(value);
      continue;
    }
    const punct = ch === "/"
      ? (next === "=" ? "/=" : "/")
      : PUNCTUATORS.find((candidate) => text.startsWith(candidate, i) && !(candidate === "?." && /\d/u.test(text[i + 2] ?? "")));
    if (punct === undefined) return fail("unexpected character");
    i += punct.length;
    tokens.push({ kind: "punct", value: punct });
    if (punct === "(") {
      open.push(prev?.kind === "name" && CONTROL_KEYWORDS.has(prev.value) ? "(if" : "(");
      regexAllowed = true;
    } else if (punct === "[") {
      open.push("[");
      regexAllowed = true;
    } else if (punct === "{") {
      open.push(braceOpensBlock(prev) ? "{block" : "{expr");
      regexAllowed = true;
    } else if (punct === ")" || punct === "]" || punct === "}") {
      const top = open.pop();
      const expected = punct === ")" ? ["(", "(if"] : punct === "]" ? ["["] : ["{block", "{expr"];
      if (top === undefined || !expected.includes(top)) return fail(`unbalanced ${punct}`);
      regexAllowed = top === "(if" || top === "{block";
    } else if (punct === "!") {
      // After an expression "!" is TypeScript's non-null assertion (`x! / 2` divides); otherwise it is logical not.
      // regexAllowed still holds the state before "!", which is exactly that distinction.
    } else {
      regexAllowed = punct !== "++" && punct !== "--";
    }
  }
  if (open.length > 0) return fail("unclosed bracket");
  return { tokens, texts, error: null };
}

/**
 * An import / export clause starting at `start` and ending with `from "specifier"`: the names it takes ("*" for a
 * namespace import or `export *`, "default:<local>" for a default import). null for anything that is not one of the
 * forms ECMAScript and TypeScript allow (refused); "local" for `export { ... }` without `from` (no module is loaded).
 */
function parseClause(tokens: readonly Token[], start: number, kind: "import" | "export"): ImportEdge | null | "local" {
  const names: string[] = [];
  let k = start;
  const punctAt = (j: number, value: string) => {
    const token = tokens[j];
    return token?.kind === "punct" && token.value === value;
  };
  const nameAt = (j: number): string | null => {
    const token = tokens[j];
    return token?.kind === "name" && !token.escaped ? token.value : null;
  };
  // A module export name: an identifier or a string (`{ "a-b" as c }`).
  const exportName = (j: number): string | null => {
    const token = tokens[j];
    return token?.kind === "name" && !token.escaped ? token.value : token?.kind === "string" ? token.value : null;
  };
  const fromString = (j: number) => nameAt(j) === "from" && tokens[j + 1]?.kind === "string";

  // A `type` modifier, unless `type` is itself the default binding (`import type from "x"`, `import type, { a }`).
  if (nameAt(k) === "type" && !(kind === "import" && (fromString(k + 1) || punctAt(k + 1, ",")))) k += 1;
  if (kind === "import" && nameAt(k) !== null) {
    names.push(`default:${nameAt(k)}`);
    k += 1;
    if (punctAt(k, ",") && (punctAt(k + 1, "{") || punctAt(k + 1, "*"))) k += 1;
    else if (!fromString(k)) return null;
  }
  if (punctAt(k, "*")) {
    names.push("*");
    k += 1;
    if (nameAt(k) === "as") {
      if (exportName(k + 1) === null) return null;
      k += 2;
    } else if (kind === "import") return null;
  } else if (punctAt(k, "{")) {
    k += 1;
    while (!punctAt(k, "}")) {
      if (nameAt(k) === "type") {
        const typeIsTheName = punctAt(k + 1, ",") || punctAt(k + 1, "}") ||
          (nameAt(k + 1) === "as" && exportName(k + 2) !== null && (punctAt(k + 3, ",") || punctAt(k + 3, "}")));
        if (!typeIsTheName) k += 1;
      }
      const imported = exportName(k);
      if (imported === null) return null;
      k += 1;
      if (nameAt(k) === "as") {
        if (exportName(k + 1) === null) return null;
        k += 2;
      }
      names.push(imported);
      if (punctAt(k, ",")) k += 1;
      else if (!punctAt(k, "}")) return null;
    }
    k += 1;
  } else if (names.length === 0) return null;
  if (fromString(k)) {
    const specifier = tokens[k + 1] as { readonly kind: "string"; readonly value: string | null };
    return { specifier: specifier.value, names, statement: true };
  }
  return kind === "export" && !names.includes("*") ? "local" : null;
}

/** Module edges in a token stream: import declarations, side-effect imports, re-exports and import(). */
function moduleEdges(tokens: readonly Token[]): ImportEdge[] {
  const edges: ImportEdge[] = [];
  const punctAt = (j: number, value: string) => {
    const token = tokens[j];
    return token?.kind === "punct" && token.value === value;
  };
  const unparsed = (specifier: string | null) => edges.push({ specifier, names: ["<unparsed>"], statement: true });
  for (let k = 0; k < tokens.length; k += 1) {
    const token = tokens[k];
    if (token.kind !== "name" || (token.value !== "import" && token.value !== "export")) continue;
    // A property or key named import / export (`x.import`, `{ import: 1 }`) loads nothing.
    if (punctAt(k - 1, ".") || punctAt(k - 1, "?.") || punctAt(k + 1, ":")) continue;
    // An escaped keyword is a syntax error in a module; the scan does not guess what was meant.
    if (token.escaped) {
      unparsed(null);
      continue;
    }
    const next = tokens[k + 1];
    if (token.value === "import") {
      if (punctAt(k + 1, ".")) continue; // import.meta
      if (punctAt(k + 1, "(")) {
        const argument = tokens[k + 2];
        const literal = (argument?.kind === "string" || argument?.kind === "template") && (punctAt(k + 3, ")") || punctAt(k + 3, ","));
        edges.push({ specifier: literal ? (argument as { readonly value: string | null }).value : null, names: ["*"], statement: true });
        continue;
      }
      if (next?.kind === "string") {
        edges.push({ specifier: next.value, names: ["<side-effect>"], statement: true });
        continue;
      }
      // TypeScript `import x = require("y")` loads a module (refused); `import x = A.B` is a namespace alias.
      if (next?.kind === "name" && punctAt(k + 2, "=")) {
        const required = tokens[k + 5];
        if (tokens[k + 3]?.kind === "name" && (tokens[k + 3] as { value: string }).value === "require") {
          unparsed(required?.kind === "string" ? required.value : null);
        }
        continue;
      }
      const clause = parseClause(tokens, k + 1, "import");
      if (clause === null || clause === "local") unparsed(null);
      else edges.push(clause);
      continue;
    }
    // Only `export * ... from` and `export { ... } from` (optionally `export type`) load a module.
    const typed = next?.kind === "name" && next.value === "type";
    if (!punctAt(k + 1, "{") && !punctAt(k + 1, "*") && !(typed && (punctAt(k + 2, "{") || punctAt(k + 2, "*")))) continue;
    const clause = parseClause(tokens, k + 1, "export");
    if (clause === null) unparsed(null);
    else if (clause !== "local") edges.push(clause);
  }
  return edges;
}

const edgeCache = new Map<string, readonly ImportEdge[]>();

/**
 * Every module edge of a file: the edges the parser reads from the code tokens, plus what textEdges finds in the
 * text of each comment and literal (it can only add edges). A file the lexer cannot read is refused as a whole
 * ("<unparsed>") and its raw text is still scanned.
 */
function importEdges(text: string): readonly ImportEdge[] {
  const cached = edgeCache.get(text);
  if (cached) return cached;
  const lexed = lexModule(text);
  const edges = lexed.error !== null
    ? [{ specifier: null, names: ["<unparsed>"], statement: true }, ...textEdges(text)]
    : [...moduleEdges(lexed.tokens), ...lexed.texts.flatMap(textEdges)];
  edgeCache.set(text, edges);
  return edges;
}

type Resolution = { readonly path: string } | { readonly external: true } | { readonly unresolved: true };

/** Where a specifier used in `from` points: a file of the tree (or of the module), an external package, or nowhere. */
function resolveSpecifier(from: string, specifier: string | null, tree: Tree): Resolution {
  if (specifier === null) return { unresolved: true };
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    try {
      const pathname = decodeURIComponent(new URL(specifier, new URL(from, "file:///functions/")).pathname);
      const path = pathname.slice("/functions/".length);
      if (pathname.startsWith("/functions/") && (tree.has(path) || path.startsWith(MODULE_PREFIX))) return { path };
    } catch {
      // A malformed escape cannot be followed.
    }
    return { unresolved: true };
  }
  return EXTERNAL_SPECIFIER.test(specifier) ? { external: true } : { unresolved: true };
}

/** The files of the tree (or of the module) one file imports. */
function localImports(path: string, text: string, tree: Tree): string[] {
  return importEdges(text)
    .map((edge) => resolveSpecifier(path, edge.specifier, tree))
    .flatMap((resolution) => "path" in resolution ? [resolution.path] : []);
}

/** Deployable (non-test) sources outside the module whose import graph reaches the module. */
function reachingProductionFiles(tree: Tree): string[] {
  const memo = new Map<string, boolean>();
  const reaches = (path: string, stack: Set<string>): boolean => {
    if (path.startsWith(MODULE_PREFIX)) return true;
    const known = memo.get(path);
    if (known !== undefined) return known;
    const text = tree.get(path);
    if (text === undefined || stack.has(path)) return false;
    stack.add(path);
    const result = localImports(path, text, tree).some((dep) => reaches(dep, stack));
    stack.delete(path);
    memo.set(path, result);
    return result;
  };
  return [...tree.keys()].filter((path) => isDeployable(path) && reaches(path, new Set())).sort();
}

/** Edge Function entry points (<function>/index.ts) among the deployable sources that reach the module. */
function reachingEntryPoints(tree: Tree): string[] {
  return reachingProductionFiles(tree).filter((path) => /^[^/_][^/]*\/index\.ts$/u.test(path));
}

/**
 * Imports the scan cannot follow, in every file outside the module that deployable code loads (the deployable files
 * and whatever they import, tests included) -> "path: specifier" ("<computed>" for a computed import()).
 */
function unresolvedImports(tree: Tree): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const queue = [...tree.keys()].filter(isDeployable);
  while (queue.length > 0) {
    const path = queue.pop()!;
    if (seen.has(path) || path.startsWith(MODULE_PREFIX)) continue;
    seen.add(path);
    const text = tree.get(path);
    if (text === undefined || !isCode(path)) continue;
    for (const edge of importEdges(text)) {
      const resolution = resolveSpecifier(path, edge.specifier, tree);
      if ("path" in resolution) queue.push(resolution.path);
      if (!("unresolved" in resolution)) continue;
      const relative = edge.specifier !== null && /^\.\.?\//u.test(edge.specifier);
      // A bare word after `from` inside a text (SQL, prose) is not an import; every other edge must be followed.
      if (edge.statement || relative) out.push(`${path}: ${edge.specifier ?? "<computed>"}`);
    }
  }
  return out.sort();
}

/**
 * Deployable files outside the module that import its files -> module file -> the sorted names taken from it
 * (dynamic imports included: "*").
 */
function providerImports(tree: Tree): Record<string, Record<string, string[]>> {
  const out: Record<string, Record<string, string[]>> = {};
  for (const [path, text] of tree) {
    if (!isDeployable(path)) continue;
    for (const edge of importEdges(text)) {
      const resolution = resolveSpecifier(path, edge.specifier, tree);
      if (!("path" in resolution) || !resolution.path.startsWith(MODULE_PREFIX)) continue;
      const byTarget = (out[path] ??= {});
      byTarget[resolution.path] = [...new Set([...(byTarget[resolution.path] ?? []), ...edge.names])].sort((a, b) => a.localeCompare(b, "en"));
    }
  }
  return out;
}

/** Deno configs, import maps and package.json files that can remap a specifier -> "path: keys" (or "unreadable"). */
function remappingConfigs(tree: Tree): string[] {
  const out: string[] = [];
  for (const [path, text] of tree) {
    const name = path.slice(path.lastIndexOf("/") + 1);
    if (name === "package.json") {
      out.push(`${path}: package.json`);
      continue;
    }
    if (!/^(?:deno\.jsonc?|import_map[^/]*\.jsonc?)$/u.test(name)) continue;
    let value: unknown;
    try {
      value = JSON.parse(name.endsWith(".jsonc") ? code(text) : text);
    } catch {
      out.push(`${path}: unreadable`);
      continue;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      out.push(`${path}: unreadable`);
      continue;
    }
    const keys = REMAPPING_KEYS.filter((key) => key in value);
    if (keys.length > 0) out.push(`${path}: ${keys.join(",")}`);
  }
  return out.sort();
}

/** Files outside the module that name the Anthropic SDK or an ANTHROPIC_* setting. */
function anthropicNames(tree: Tree): string[] {
  return [...tree.entries()]
    .filter(([path, text]) => !path.startsWith(MODULE_PREFIX) && /@anthropic-ai\/|\bANTHROPIC_[A-Z_]+/u.test(text))
    .map(([path]) => path)
    .sort();
}

/** App files (src/, apps/) that name the provider module, the Anthropic key or its SDK. */
function appLeaks(tree: Tree): string[] {
  return [...tree.entries()].filter(([, text]) => /ai_provider|ANTHROPIC_API_KEY|@anthropic-ai\/sdk/u.test(text)).map(([path]) => path).sort();
}

type DirReader = (dir: URL) => AsyncIterable<Deno.DirEntry>;
type TextReader = (file: URL) => Promise<string>;

/**
 * Code and JSON files under `dir`. Nothing is skipped silently: an unreadable directory and every symlink (another
 * name for a file or directory, which the scan would miss or see twice) go to `issues`, and are never followed.
 */
async function* walk(dir: URL, label: string, issues: string[], readDir: DirReader): AsyncGenerator<URL> {
  const entries: Deno.DirEntry[] = [];
  try {
    for await (const entry of readDir(dir)) entries.push(entry);
  } catch {
    issues.push(`unreadable directory: ${label || "."}`);
    return;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const name = entry.name + (entry.isDirectory ? "/" : "");
    const child = new URL(encodeURIComponent(entry.name) + (entry.isDirectory ? "/" : ""), dir);
    if (entry.isSymlink) issues.push(`symlink: ${label}${entry.name}`);
    else if (entry.isDirectory) yield* walk(child, label + name, issues, readDir);
    else if (/\.(ts|tsx|js|mjs|json|jsonc)$/u.test(entry.name)) yield child;
  }
}

async function readTree(root: URL, issues: string[] = [], readDir: DirReader = Deno.readDir, readText: TextReader = Deno.readTextFile) {
  const tree = new Map<string, string>();
  for await (const file of walk(root, "", issues, readDir)) {
    const path = decodeURIComponent(file.href.slice(root.href.length));
    try {
      tree.set(path, await readText(file));
    } catch {
      issues.push(`unreadable file: ${path}`);
    }
  }
  return tree;
}

const functionsIssues: string[] = [];
const functionsTree = readTree(FUNCTIONS_DIR, functionsIssues);

async function appTree(): Promise<Map<string, string>> {
  const tree = new Map<string, string>();
  for (const dir of ["src/", "apps/"]) {
    for (const [path, text] of await readTree(new URL(dir, REPO_ROOT))) tree.set(dir + path, text);
  }
  return tree;
}

const sortedAuthorized = () =>
  Object.fromEntries(Object.entries(AUTHORIZED_REFERENCES).map(([path, specifiers]) => [path, [...specifiers].sort()]));
const sortedProviderImports = (): Record<string, Record<string, string[]>> =>
  Object.fromEntries(
    Object.entries(AUTHORIZED_PROVIDER_IMPORTS).map((
      [path, targets],
    ) => [path, Object.fromEntries(Object.entries(targets).map(([target, names]) => [target, [...names].sort((a, b) => a.localeCompare(b, "en"))]))]),
  );

test("Provider scope: only the authorized files (report handler, consumer bridge) name the provider module, with exactly these imports", async () => {
  assert.deepEqual(directReferences(await functionsTree), sortedAuthorized());
});

test("Provider scope: of all deployable sources only the authorized ones reach the module; of the entry points only the report", async () => {
  const tree = await functionsTree;
  assert.deepEqual(reachingProductionFiles(tree), AUTHORIZED_REACHERS);
  assert.deepEqual(reachingEntryPoints(tree), AUTHORIZED_ENTRY_POINTS);
});

test("Provider scope: deployable importers take exactly their authorized names from each module file (least privilege)", async () => {
  assert.deepEqual(providerImports(await functionsTree), sortedProviderImports());
});

test("Provider scope: the scan is complete: every file read, no symlink, every import followed, no specifier remapping", async () => {
  const tree = await functionsTree;
  assert.ok(tree.size > 100, "scanned the functions directory");
  assert.deepEqual(functionsIssues, []);
  assert.deepEqual(unresolvedImports(tree), []);
  assert.deepEqual(remappingConfigs(tree), []);
});

test("Provider scope: the Anthropic SDK and ANTHROPIC_* names stay in the module (and the handler's offline test)", async () => {
  assert.deepEqual(anthropicNames(await functionsTree), AUTHORIZED_ANTHROPIC_NAMES);
});

test("apps never reference the provider module or the Anthropic key (keys stay server-side)", async () => {
  assert.deepEqual(appLeaks(await appTree()), []);
});

const BRIDGE = "_shared/ai_consumer_bridge/bridge.ts";
const BRIDGE_TYPES = "_shared/ai_consumer_bridge/types.ts";
const HANDLER = "market-report-analysis/handler.ts";
const MOD = "_shared/ai_provider/mod.ts";

test("Provider scope: every widening is refused (synthetic trees built on the real one)", async () => {
  const real = await functionsTree;
  const withFile = (path: string, text: string) => new Map([...real, [path, text]]);
  const refusedDirect = (tree: Tree, path: string) => {
    assert.notDeepEqual(directReferences(tree), sortedAuthorized(), `${path}: direct reference not refused`);
    assert.ok(path in directReferences(tree), path);
  };

  // Another Edge Function imports the module (static, dynamic, re-export, side effect): refused twice over.
  for (const [path, text] of [
    ["x-test-post/index.ts", `${real.get("x-test-post/index.ts") ?? ""}\nimport { executeAiRequest } from "../_shared/ai_provider/mod.ts";\n`],
    ["personalized-reports/ai.ts", `export const load = () => import("../_shared/ai_provider/execute.ts");\n`],
    ["social-mobile-consult/provider.ts", `export * from "../_shared/ai_provider/mod.ts";\n`],
    ["important-news-monitor/boot.ts", `import "../_shared/ai_provider/anthropic_adapter.ts";\n`],
  ] as const) {
    const tree = withFile(path, text);
    refusedDirect(tree, path);
    assert.ok(reachingProductionFiles(tree).includes(path), `${path}: reach not refused`);
  }

  // Indirect: a deployable file that imports the handler reaches the module without naming it.
  const bridge = withFile("_shared/report_bridge.ts", `export { handleRequest } from "../market-report-analysis/handler.ts";\n`);
  assert.deepEqual(directReferences(bridge), sortedAuthorized(), "no direct reference");
  assert.deepEqual(reachingProductionFiles(bridge), [...AUTHORIZED_REACHERS, "_shared/report_bridge.ts"].sort());

  // The handler imports one more provider file, or another market report source starts using the module.
  const handler = real.get(HANDLER)!;
  refusedDirect(withFile(HANDLER, `${handler}\nimport { AnthropicAdapter } from "../_shared/ai_provider/anthropic_adapter.ts";\n`), HANDLER);
  const extra = withFile("market-report-analysis/extra.ts", `import { prepareMarketReportShadow } from "../_shared/ai_provider/market_report_wiring.ts";\n`);
  refusedDirect(extra, "market-report-analysis/extra.ts");
  assert.ok(reachingProductionFiles(extra).includes("market-report-analysis/extra.ts"));

  // Another function's test may not use the module either (the allowlist names files, not directories or kinds).
  refusedDirect(withFile("x-test-post/provider_test.ts", `import { fakeEnv } from "../_shared/ai_provider/test_support.ts";\n`), "x-test-post/provider_test.ts");

  // A path mentioned outside a string literal is still a reference.
  assert.deepEqual(directReferences(withFile("x-test-post/notes.ts", "// see _shared/ai_provider/mod.ts\n"))["x-test-post/notes.ts"], ["<bare>"]);

  // Production code outside the module may not read the Anthropic key or import its SDK.
  for (const [path, text] of [
    ["personalized-reports/claude.ts", `export const key = Deno.env.get("ANTHROPIC_API_KEY");\n`],
    [HANDLER, `${handler}\nimport Anthropic from "npm:@anthropic-ai/sdk@0.132.1";\n`],
  ] as const) {
    assert.ok(anthropicNames(withFile(path, text)).includes(path), `${path}: Anthropic name not refused`);
  }

  // The consumer bridge (2026-10-15): it may not widen its imports, and nothing may start using it unnoticed.
  const bridgeSource = real.get(BRIDGE)!;
  const modRefused = (tree: Tree, path: string, label: string) => {
    assert.ok(path in sortedProviderImports(), `${path} is an authorized importer`);
    assert.notDeepEqual(providerImports(tree)[path], sortedProviderImports()[path], `${path} (${label}): widening not refused`);
  };
  for (const [extraImport, label] of [
    [`import { SupabaseLedgerBudgetGuard } from "../ai_provider/mod.ts";`, "ledger guard construction"],
    [`import { executeAiRequest as run } from "../ai_provider/mod.ts";`, "unpoliced execution (aliased)"],
    [`import { resolveProviderApiKey, type SecretValue } from "../ai_provider/mod.ts";`, "secret readers"],
    [`import * as provider from "../ai_provider/mod.ts";`, "namespace import"],
    [`export * from "../ai_provider/mod.ts";`, "re-export of everything"],
    [`export { InMemoryBudgetGuard } from "../ai_provider/mod.ts";`, "re-export of an in-memory budget"],
  ] as const) {
    modRefused(withFile(BRIDGE, `${extraImport}\n${bridgeSource}`), BRIDGE, label);
  }
  refusedDirect(withFile(BRIDGE, `${bridgeSource}\nimport { SupabaseLedgerBudgetGuard } from "../ai_provider/ledger_guard.ts";\n`), BRIDGE);
  refusedDirect(withFile("_shared/ai_consumer_bridge/helper.ts", `export { executeWithModelPolicy } from "../ai_provider/mod.ts";\n`), "_shared/ai_consumer_bridge/helper.ts");
  refusedDirect(withFile("_shared/ai_consumer_bridge/new_test.ts", `import { fakeEnv } from "../ai_provider/test_support.ts";\n`), "_shared/ai_consumer_bridge/new_test.ts");
  // An Edge Function that starts using the bridge reaches the module: refused until the allowlist names it.
  for (const [path, text] of [
    ["x-test-post/ai.ts", `export { createConsumerBridge } from "../_shared/ai_consumer_bridge/bridge.ts";\n`],
    ["social-mobile-consult/index.ts", `${real.get("social-mobile-consult/index.ts") ?? ""}\nimport "../_shared/ai_consumer_bridge/bridge.ts";\n`],
  ] as const) {
    const tree = withFile(path, text);
    assert.deepEqual(directReferences(tree), sortedAuthorized(), `${path} names only the bridge`);
    assert.ok(reachingProductionFiles(tree).includes(path), `${path}: reach through the bridge not refused`);
  }
  assert.ok(
    reachingEntryPoints(withFile("social-mobile-consult/index.ts", `import "../_shared/ai_consumer_bridge/types.ts";\n`)).includes("social-mobile-consult/index.ts"),
    "a new entry point is refused",
  );

  // App leaks are still found.
  for (const [path, text] of [
    ["src/lib/ai.ts", `const key = process.env.ANTHROPIC_API_KEY;\n`],
    ["src/lib/sdk.ts", `import Anthropic from "@anthropic-ai/sdk";\n`],
    ["apps/social-mobile/src/ai.ts", `import { executeAiRequest } from "../../../supabase/functions/_shared/ai_provider/mod.ts";\n`],
  ] as const) {
    assert.deepEqual(appLeaks(new Map([[path, text]])), [path]);
  }
});

test("J1 R1: dynamic, computed, aliased, symlinked, transitive and unreadable paths are refused (fail closed)", async () => {
  const real = await functionsTree;
  const withFiles = (...files: Array<readonly [string, string]>) => new Map([...real, ...files]);
  const bridgeSource = real.get(BRIDGE)!;
  const typesSource = real.get(BRIDGE_TYPES)!;
  const handler = real.get(HANDLER)!;
  const importsRefused = (tree: Tree, path: string, label: string) =>
    assert.notDeepEqual(providerImports(tree)[path], sortedProviderImports()[path], `${path} (${label}): not refused`);
  const unresolved = (tree: Tree, path: string, label: string) =>
    assert.ok(unresolvedImports(tree).some((item) => item.startsWith(`${path}: `)), `${path} (${label}): unfollowable import not refused`);

  // 1. The exact J1 reproduction: the authorized bridge takes the whole public entry through import(). It uses only
  //    the specifier the bridge already has and reaches nothing new, so only the symbol policy can see it.
  const r1 = withFiles([BRIDGE, `${bridgeSource}\nexport const auditOnlyMutation = async () =>\n  (await import("../ai_provider/mod.ts")).executeAiRequest;\n`]);
  assert.deepEqual(directReferences(r1), sortedAuthorized());
  assert.deepEqual(reachingProductionFiles(r1), AUTHORIZED_REACHERS);
  assert.ok(providerImports(r1)[BRIDGE][MOD].includes("*"), "import() hands over every export");
  importsRefused(r1, BRIDGE, "J1 exact reproduction");

  // 2. Dynamic namespace forms, in the bridge, its types and the handler.
  for (const [path, source, extra] of [
    [BRIDGE, bridgeSource, `export const provider = await import("../ai_provider/mod.ts");`],
    [BRIDGE, bridgeSource, `export const run = () => import("../ai_provider/mod.ts").then((m) => m.executeAiRequest);`],
    [BRIDGE, bridgeSource, `export const guard = async () => (await import('../ai_provider/mod.ts', { with: {} })).SupabaseLedgerBudgetGuard;`],
    [BRIDGE, bridgeSource, "export const key = async () => (await import(`../ai_provider/mod.ts`)).resolveProviderApiKey;"],
    [BRIDGE_TYPES, typesSource, `export type Provider = typeof import("../ai_provider/mod.ts");`],
    [HANDLER, handler, `export const primary = () => import("../_shared/ai_provider/market_report_primary.ts");`],
  ] as const) {
    importsRefused(withFiles([path, `${source}\n${extra}\n`]), path, extra);
  }

  // 3. Computed paths: whatever they evaluate to, the scan cannot follow them, so they are refused. (None of these
  //    names the module literally, and the old scan saw no edge at all.)
  for (const [path, text] of [
    [BRIDGE, `${bridgeSource}\nconst target = "../ai_" + "provider/mod.ts";\nexport const load = () => import(target);\n`],
    ["x-test-post/ai_loader.ts", 'const dir = ["ai", "consumer", "bridge"].join("_");\nexport const load = () => import(`../_shared/${dir}/bridge.ts`);\n'],
    ["x-test-post/ai_loader.ts", `export const load = () => import("../_shared/ai_" + "consumer_bridge/bridge.ts");\n`],
    ["x-test-post/ai_loader.ts", `export const load = (name: string) => import(name);\n`],
    ["x-test-post/ai_loader.ts", `export const load = () => import(\n  "../_shared/" + ["ai", "provider"].join("_") + "/mod.ts"\n);\n`],
  ] as const) {
    const tree = withFiles([path, text]);
    unresolved(tree, path, text);
    assert.equal(directReferences(tree)["x-test-post/ai_loader.ts"], undefined, "no literal mention");
  }

  // An escaped specifier is decoded the way the loader decodes it (J1 R1a), so it is followed: it reaches the module.
  const escaped = withFiles(["x-test-post/ai_loader.ts", `export const load = () => import("../_shared/ai\\u005fconsumer_bridge/bridge.ts");\n`]);
  assert.ok(reachingProductionFiles(escaped).includes("x-test-post/ai_loader.ts"), "escaped specifier");

  // 4. Aliases: any config that can remap a specifier is refused, and so is every bare / absolute / data: import.
  for (const [path, text] of [
    ["x-test-post/deno.json", JSON.stringify({ imports: { "s/": "../_shared/" } })],
    ["x-test-post/deno.json", JSON.stringify({ imports: { "./harmless.ts": "../_shared/ai_consumer_bridge/bridge.ts" } })],
    ["import_map.json", JSON.stringify({ scopes: { "./x-test-post/": { "./harmless.ts": "./_shared/ai_consumer_bridge/bridge.ts" } } })],
    ["deno.jsonc", `{\n  // a workspace member is a local package\n  "workspace": ["./_shared/ai_consumer_bridge"]\n}\n`],
    ["x-test-post/deno.json", JSON.stringify({ links: ["../_shared/ai_consumer_bridge"] })],
    ["x-test-post/deno.json", JSON.stringify({ importMap: "../import_map.json" })],
    ["x-test-post/deno.json", JSON.stringify({ patch: ["../_shared/ai_consumer_bridge"] })],
    ["x-test-post/package.json", JSON.stringify({ name: "x", dependencies: { consumer: "file:../_shared/ai_consumer_bridge" } })],
    ["x-test-post/deno.json", "{ not json"],
  ] as const) {
    assert.ok(remappingConfigs(withFiles([path, text])).some((item) => item.startsWith(`${path}: `)), `${path}: ${text}`);
  }
  for (const text of [
    `import { createConsumerBridge } from "s/ai%5Fconsumer%5Fbridge/bridge.ts";\n`,
    `import { createConsumerBridge } from "consumer";\n`,
    `import "consumer";\n`,
    `export * from "/Users/someone/kabumori/supabase/functions/_shared/ai_consumer_bridge/bridge.ts";\n`,
    `import { createConsumerBridge } from "file:///srv/functions/_shared/ai_consumer_bridge/bridge.ts";\n`,
    `export const m = () => import("data:application/javascript,export%20default%201");\n`,
    `import { createConsumerBridge } from "http://localhost:8000/bridge.ts";\n`,
  ]) {
    unresolved(withFiles(["x-test-post/alias.ts", text]), "x-test-post/alias.ts", text);
  }

  // 5. Symlinks and unreadable entries are reported, never followed or skipped (injected reader: nothing is written).
  type FakeEntry = { name: string; kind: "file" | "dir" | "symlink" };
  const fakeTree: Record<string, FakeEntry[] | "denied"> = {
    "file:///fake/": [{ name: "x-test-post", kind: "dir" }],
    "file:///fake/x-test-post/": [
      { name: "index.ts", kind: "file" },
      { name: "consumer", kind: "symlink" },
      { name: "provider.ts", kind: "symlink" },
      { name: "generated", kind: "dir" },
      { name: "secret.ts", kind: "file" },
    ],
    "file:///fake/x-test-post/generated/": "denied",
  };
  const fakeReadDir: DirReader = async function* (dir) {
    const listing = fakeTree[dir.href];
    if (listing === undefined || listing === "denied") throw new Deno.errors.PermissionDenied("denied");
    for (const entry of listing) {
      yield { name: entry.name, isFile: entry.kind === "file", isDirectory: entry.kind === "dir", isSymlink: entry.kind === "symlink" };
    }
  };
  const fakeReadText: TextReader = (file) =>
    file.href.endsWith("secret.ts")
      ? Promise.reject(new Deno.errors.PermissionDenied("denied"))
      : Promise.resolve(`import "./consumer/bridge.ts";\nimport "./provider.ts";\nimport "./generated/shim.ts";\n`);
  const issues: string[] = [];
  const fake = await readTree(new URL("file:///fake/"), issues, fakeReadDir, fakeReadText);
  assert.deepEqual(issues.sort(), [
    "symlink: x-test-post/consumer",
    "symlink: x-test-post/provider.ts",
    "unreadable directory: x-test-post/generated/",
    "unreadable file: x-test-post/secret.ts",
  ]);
  assert.deepEqual([...fake.keys()], ["x-test-post/index.ts"]);
  // What they would have hidden is not "unreachable": every import of it is unfollowable, so it is refused too.
  assert.deepEqual(unresolvedImports(fake), [
    "x-test-post/index.ts: ./consumer/bridge.ts",
    "x-test-post/index.ts: ./generated/shim.ts",
    "x-test-post/index.ts: ./provider.ts",
  ]);

  // 6. Export-star and transitive paths.
  importsRefused(withFiles([BRIDGE_TYPES, `${typesSource}\nexport * from "../ai_provider/mod.ts";\n`]), BRIDGE_TYPES, "types re-export everything");
  importsRefused(withFiles([HANDLER, `${handler}\nexport * from "../_shared/ai_provider/market_report_primary.ts";\n`]), HANDLER, "handler re-exports the primary");
  importsRefused(withFiles([HANDLER, `${handler}\nimport { primaryLedgerFromEdgeEnv } from "../_shared/ai_provider/market_report_primary.ts";\n`]), HANDLER, "handler takes the ledger");
  importsRefused(withFiles([HANDLER, `${handler}\nimport * as primary from "../_shared/ai_provider/market_report_primary.ts";\n`]), HANDLER, "handler namespace");
  // A chain of new files ending at the bridge, or a deployable file that loads a test fixture: every link reaches.
  const chain = withFiles(
    ["x-test-post/a.ts", `export * from "./b.ts";\n`],
    ["x-test-post/b.ts", `export * from "../_shared/c.ts";\n`],
    ["_shared/c.ts", `export { createConsumerBridge } from "./ai_consumer_bridge/bridge.ts";\n`],
  );
  assert.deepEqual(reachingProductionFiles(chain), [...AUTHORIZED_REACHERS, "_shared/c.ts", "x-test-post/a.ts", "x-test-post/b.ts"].sort());
  const fixture = withFiles(["x-test-post/fixtures.ts", `export { world } from "../_shared/ai_consumer_bridge/offline_samples_test.ts";\n`]);
  assert.ok(reachingProductionFiles(fixture).includes("x-test-post/fixtures.ts"));
  // An import after a string that looks like a comment opener is still read (the old scan stripped it as a comment).
  for (const prefix of [`const s = "a//b"; `, `const s = "/*"; `]) {
    importsRefused(withFiles([BRIDGE, `${bridgeSource}\n${prefix}import { executeAiRequest as run } from "../ai_provider/mod.ts";\n`]), BRIDGE, prefix);
  }
  // A string-named import clause cannot be read: refused, not ignored.
  importsRefused(withFiles([BRIDGE, `${bridgeSource}\nimport { "executeAiRequest" as run } from "../ai_provider/mod.ts";\n`]), BRIDGE, "string-named import");

  // 7. Unresolved edges: an import of a file the scanned tree does not have is refused, never "does not reach".
  for (const text of [
    `import "./generated/provider_shim.ts";\n`,
    `import { executeAiRequest } from "../_shared/AI_PROVIDER/mod.ts";\n`,
    `import "./.hidden/shim.ts";\n`,
    `import "./node_modules/shim/index.ts";\n`,
    `import "../../../src/lib/ai.ts";\n`,
    `import "./%E0%A4%A.ts";\n`,
    `export const load = () => import("./missing.ts");\n`,
  ]) {
    unresolved(withFiles(["x-test-post/shim_user.ts", text]), "x-test-post/shim_user.ts", text);
  }
  // A path in another letter case is a reference too (case-insensitive file systems resolve it).
  assert.ok("x-test-post/shim_user.ts" in directReferences(withFiles(["x-test-post/shim_user.ts", `import "../_shared/AI_PROVIDER/mod.ts";\n`])));
});

test("J1 R1a: comment trivia, escapes and line continuations cannot hide an import (fail closed)", async () => {
  const real = await functionsTree;
  const withFiles = (...files: Array<readonly [string, string]>) => new Map([...real, ...files]);
  const bridgeSource = real.get(BRIDGE)!;
  const handler = real.get(HANDLER)!;
  const importsRefused = (tree: Tree, path: string, label: string) =>
    assert.notDeepEqual(providerImports(tree)[path], sortedProviderImports()[path], `${path} (${label}): not refused`);
  const unresolved = (tree: Tree, path: string, label: string) =>
    assert.ok(unresolvedImports(tree).some((item) => item.startsWith(`${path}: `)), `${path} (${label}): unfollowable import not refused`);

  // 1. The exact J1 R1a reproduction: a comment between `import` and `(` in the authorized bridge.
  const r1a = withFiles([BRIDGE, `${bridgeSource}\nexport const auditOnlyMutation = async () =>\n  (await import/* audit */("../ai_provider/mod.ts")).executeAiRequest;\n`]);
  assert.deepEqual(directReferences(r1a), sortedAuthorized(), "it uses only the specifier the bridge already has");
  assert.deepEqual(reachingProductionFiles(r1a), AUTHORIZED_REACHERS, "and reaches nothing new");
  assert.ok(providerImports(r1a)[BRIDGE][MOD].includes("*"), "import() with trivia still hands over every export");
  importsRefused(r1a, BRIDGE, "J1 R1a exact reproduction");

  // 2. Other legal trivia and namespace access around a literal dynamic import.
  for (const extra of [
    `export const a = () => import // a line comment\n("../ai_provider/mod.ts");`,
    `export const b = () => import\u2028("../ai_provider/mod.ts");`,
    `export const c = () => import /* one */ /* two */ (/* before */ "../ai_provider/mod.ts" /* after */);`,
    `export const d = async () => (await import/**/('../ai_provider/mod.ts', { with: {} }))["SupabaseLedgerBudgetGuard"];`,
    `export const e = () => import/**/("../ai_provider/mod.ts").then(({ resolveProviderApiKey }) => resolveProviderApiKey);`,
    `export const f = async () => { const { executeAiRequest: run } = await import/*\n multi-line\n*/("../ai_provider/mod.ts"); return run; };`,
  ]) {
    importsRefused(withFiles([BRIDGE, `${bridgeSource}\n${extra}\n`]), BRIDGE, extra);
  }
  importsRefused(withFiles([HANDLER, `${handler}\nexport const p = () => import/* x */("../_shared/ai_provider/market_report_primary.ts");\n`]), HANDLER, "handler");

  // 3. Commented computed imports: still computed, still refused.
  for (const text of [
    `export const load = (target: string) => import/* c */(target);\n`,
    `export const load = () => import/**/("../_shared/ai_" + "consumer_bridge/bridge.ts");\n`,
    `export const load = () => import // c\n(["..", "_shared", "ai_consumer_bridge", "bridge.ts"].join("/"));\n`,
    "export const load = () => import/**/(`../_shared/${\"ai_consumer_bridge\"}/bridge.ts`);\n",
    `export const load = () => import/* unterminated\n("../_shared/ai_consumer_bridge/bridge.ts");\n`,
  ]) {
    unresolved(withFiles(["x-test-post/ai_loader.ts", text]), "x-test-post/ai_loader.ts", text);
  }

  // 4. Static imports with trivia: the specifier and the names are still read.
  for (const extra of [
    `import { executeAiRequest } from/* c */"../ai_provider/mod.ts";`,
    `import/* c */{ executeAiRequest }/* c */from/* c */"../ai_provider/mod.ts";`,
    `import { findModelSpec, /* } */ executeAiRequest } from "../ai_provider/mod.ts";`,
    `export/**/*/**/from/**/"../ai_provider/mod.ts";`,
    `export * as everything from // c\n"../ai_provider/mod.ts";`,
    `import/* c */"../ai_provider/mod.ts";`,
  ]) {
    importsRefused(withFiles([BRIDGE, `${extra}\n${bridgeSource}`]), BRIDGE, extra);
  }
  // A new Edge file that loads the bridge with trivia reaches the module.
  for (const text of [
    `import/**/"../_shared/ai_consumer_bridge/bridge.ts";\n`,
    `export { createConsumerBridge } from/* c */"../_shared/ai_consumer_bridge/bridge.ts";\n`,
    `export * from // c\n"../_shared/ai_consumer_bridge/types.ts";\n`,
  ]) {
    assert.ok(reachingProductionFiles(withFiles(["x-test-post/ai.ts", text])).includes("x-test-post/ai.ts"), text);
  }

  // 5. Escapes and line continuations inside the specifier are decoded the way the loader decodes them.
  for (const specifier of [
    String.raw`../ai\u005fprovider/mod.ts`,
    String.raw`../ai\x5fprovider/mod.ts`,
    String.raw`../ai\u{5f}provider/mod.ts`,
    "../ai_\\\nprovider/mod.ts",
    "../ai_\\\r\nprovider/mod.ts",
  ]) {
    const tree = withFiles([BRIDGE, `import { executeAiRequest } from "${specifier}";\n${bridgeSource}`]);
    assert.ok(providerImports(tree)[BRIDGE][MOD].includes("executeAiRequest"), specifier);
    importsRefused(tree, BRIDGE, specifier);
    const dynamic = withFiles([BRIDGE, `${bridgeSource}\nexport const g = () => import("${specifier}");\n`]);
    importsRefused(dynamic, BRIDGE, `dynamic ${specifier}`);
  }
  // Not a module specifier the scan can follow: a legacy octal escape (a syntax error in a module), refused.
  unresolved(withFiles(["x-test-post/octal.ts", String.raw`import "./\101.ts";` + "\n"]), "x-test-post/octal.ts", "octal escape");

  // 6. Transitive export with trivia through a chain of new files.
  const chain = withFiles(
    ["x-test-post/a.ts", `export * from/**/"./b.ts";\n`],
    ["x-test-post/b.ts", `export * from // c\n"../_shared/c.ts";\n`],
    ["_shared/c.ts", `export { createConsumerBridge } from/* c */"./ai_consumer_bridge/bridge.ts";\n`],
  );
  assert.deepEqual(reachingProductionFiles(chain), [...AUTHORIZED_REACHERS, "_shared/c.ts", "x-test-post/a.ts", "x-test-post/b.ts"].sort());
});

test("J1 R1b / R1c: code is read as tokens; literals and comments can neither fake nor hide an import", async () => {
  const real = await functionsTree;
  const withFiles = (...files: Array<readonly [string, string]>) => new Map([...real, ...files]);
  const bridgeSource = real.get(BRIDGE)!;
  const typesSource = real.get(BRIDGE_TYPES)!;
  const importsRefused = (tree: Tree, path: string, label: string) =>
    assert.notDeepEqual(providerImports(tree)[path], sortedProviderImports()[path], `${path} (${label}): not refused`);
  const importsAccepted = (tree: Tree, label: string) => {
    assert.deepEqual(providerImports(tree), sortedProviderImports(), `${label}: legal import refused`);
    assert.deepEqual(unresolvedImports(tree), [], label);
  };
  const unresolved = (tree: Tree, path: string, label: string) =>
    assert.ok(unresolvedImports(tree).some((item) => item.startsWith(`${path}: `)), `${path} (${label}): not refused`);

  // 1. The exact J1 R1b reproduction: two string fragments that look like a comment around a real import().
  const r1b = withFiles([BRIDGE, `${bridgeSource}\nconst auditNoteBefore = "import/*";\nexport const auditOnlyMutation = async () =>\n  (await import("../ai_provider/mod.ts")).executeAiRequest;\nconst auditNoteAfter = "*/('./types.ts')";\n`]);
  assert.deepEqual(directReferences(r1b), sortedAuthorized(), "no new specifier");
  assert.deepEqual(reachingProductionFiles(r1b), AUTHORIZED_REACHERS, "no new reacher");
  assert.ok(providerImports(r1b)[BRIDGE][MOD].includes("*"), "the real import() is read from the code tokens");
  importsRefused(r1b, BRIDGE, "J1 R1b exact reproduction");

  // 2. The same trick with other literals and around other imports.
  for (const extra of [
    "const a = `import/*`;\nexport const b = async () => (await import(\"../ai_provider/mod.ts\")).resolveProviderApiKey;\nconst c = `*/(\"./types.ts\")`;",
    "const a = 'import/*';\nimport { SupabaseLedgerBudgetGuard } from '../ai_provider/mod.ts';\nconst c = '*/\"./types.ts\"';",
    "const a = `import/*${1}`;\nexport const b = () => import(\"../ai_provider/mod.ts\");\nconst c = `${2}*/(\"./types.ts\")`;",
    "const a = /import\\/*/u;\nexport const b = () => import(\"../ai_provider/mod.ts\");\nconst c = /*\\/(\"\\.\\/types\\.ts\")/u;".replace("/*\\/", "/[*]\\/"),
    "// import/*\nexport const b = () => import(\"../ai_provider/mod.ts\");\n// */('./types.ts')",
  ]) {
    importsRefused(withFiles([BRIDGE, `${bridgeSource}\n${extra}\n`]), BRIDGE, extra);
  }
  unresolved(
    withFiles(["x-test-post/ai_loader.ts", 'const x = "import/*";\nconst dir = ["ai", "consumer", "bridge"].join("_");\nexport const load = () => import(`../_shared/${dir}/bridge.ts`);\nconst y = "*/(\'./index.ts\')";\n']),
    "x-test-post/ai_loader.ts",
    "fragments around a computed import",
  );

  // 3. The exact J1 R1c reproduction and other legal comment layouts: accepted (allowed names only).
  for (const extra of [
    `import/**/{ findModelSpec as same }/* ordinary */from/**/"../ai_provider/mod.ts";`,
    `import /* a */ type /* b */ { /* c */ AiSubject /* d */ as /* e */ S /* f */, BudgetGuard } /* g */ from /* h */ "../ai_provider/mod.ts" /* i */;`,
    `import { findModelSpec } /* ** / */ from // a line comment\n"../ai_provider/mod.ts";`,
    `import {\n  // one\n  validateAiRequest, /* two */\n  type ModelPolicyRegistry, // three\n} from "../ai_provider/mod.ts";`,
  ]) {
    importsAccepted(withFiles([BRIDGE, `${extra}\n${bridgeSource}`]), extra);
  }
  importsAccepted(withFiles([BRIDGE_TYPES, `${typesSource}\nexport /* x */ type /* y */ { AiSubject } /* z */ from "../ai_provider/mod.ts";\n`]), "types re-export");
  // A block comment ends at its first "*/": what follows is code again, and it is read.
  importsRefused(withFiles([BRIDGE, `import/* /* not nested */ { executeAiRequest } from "../ai_provider/mod.ts";\n${bridgeSource}`]), BRIDGE, "first */");

  // 4. Grammar: what loads a module is an edge, what does not is not.
  const helper = ["x-new-fn/helper.ts", "export const helper = 1;\nexport default 2;\n"] as const;
  for (const [text, expected] of [
    [`import type from "./helper.ts";\nexport { type };`, [["./helper.ts", ["default:type"]]]],
    [`import { type } from "./helper.ts";\nexport { type };`, [["./helper.ts", ["type"]]]],
    [`import { type as kind } from "./helper.ts";\nexport { kind };`, [["./helper.ts", ["type"]]]],
    [`import def, * as all from "./helper.ts";\nexport { all, def };`, [["./helper.ts", ["*", "default:def"]]]],
    [`export * as everything from "./helper.ts";`, [["./helper.ts", ["*"]]]],
    [`const helper = 1;\nexport { helper };\nexport { helper as again };`, []],
    [`const o = { import: 1, export: 2 };\nexport const v = o.import + o.export;`, []],
    [`export const meta = import.meta.url;`, []],
  ] as const) {
    const got = importEdges(text).map((edge) => [edge.specifier, [...edge.names].sort()]);
    assert.deepEqual(got, expected, text);
    assert.deepEqual(unresolvedImports(withFiles(["x-new-fn/index.ts", text], helper)), [], text);
  }
  // Not readable as one of those forms: refused, never skipped.
  // TypeScript `import x = require(...)` is followed, and taking a module file that way is refused.
  importsRefused(withFiles([BRIDGE, `import provider = require("../ai_provider/mod.ts");\n${bridgeSource}`]), BRIDGE, "import = require");
  for (const text of [
    String.raw`export const load = () => \u0069mport("../ai_provider/mod.ts");` + "\n",
    `import defer * as later from "./helper.ts";\n`,
    `import { a b } from "./helper.ts";\n`,
  ]) {
    unresolved(withFiles(["x-new-fn/index.ts", text], helper), "x-new-fn/index.ts", text);
  }

  // 5. Malformed source is refused as a whole (and its raw text is still scanned).
  for (const text of [
    `const s = "never closed;\nexport const x = 1;\n`,
    "const t = `never closed;\n",
    `/* never closed\nexport const x = 1;\n`,
    `export const f = () => { return 1;\n`,
    `export const r = /never closed;\n`,
    `export const g = (x: number) => x ]\n`,
  ]) {
    unresolved(withFiles(["x-new-fn/index.ts", text]), "x-new-fn/index.ts", text);
  }

  // 6. "/" after an expression divides (TypeScript `x!` included); after a block it starts a regex. If a guess is
  //    wrong, the code it turned into text is still scanned: the import below is refused either way.
  for (const extra of [
    "const ratio = (a: number | undefined, b: number) => a! / b / 2;\nexport const h = () => import(\"../ai_provider/mod.ts\");",
    "if (Math.random() > 2) { } /import(?:x)/u.test(\"y\");\nexport const h = () => import(\"../ai_provider/mod.ts\");",
    "const v = function () { return 1; } / 2; export const h = () => import(\"../ai_provider/mod.ts\"); const w = 4 / 2;",
  ]) {
    importsRefused(withFiles([BRIDGE, `${bridgeSource}\n${extra}\n`]), BRIDGE, extra);
  }

  // 7. Import-like text inside literals and comments is scanned conservatively: it may refuse, it never hides.
  unresolved(withFiles(["x-new-fn/index.ts", `export const doc = "load it with import('./missing.ts')";\n`]), "x-new-fn/index.ts", "string");
  assert.deepEqual(unresolvedImports(withFiles(["x-new-fn/index.ts", "export const doc = `see import { helper } from \"./helper.ts\"`;\n"], helper)), []);
});

test("J1 R1: ordinary imports stay accepted (no false refusal)", async () => {
  const real = await functionsTree;
  const valid = new Map([
    ...real,
    [
      "x-new-fn/index.ts",
      [
        `import { serveDir } from "jsr:@std/http@1.0.0";`,
        `import { z } from "npm:zod@3.23.8";`,
        `import { decodeBase64 } from "https://deno.land/std@0.224.0/encoding/base64.ts";`,
        `import { Buffer } from "node:buffer";`,
        `import { helper } from "./helper.ts";`,
        `import type { Shape } from "./helper.ts";`,
        `import data from "./data.json" with { type: "json" };`,
        `import "./side.ts";`,
        `import {`,
        `  helper as helperAgain,`,
        `  type Shape as ShapeAgain,`,
        `} from "./helper.ts";`,
        `export { helper as again } from "./helper.ts";`,
        `export * from "./helper.ts";`,
        `const sql = 'select id from "public"."reports"';`,
        `// Notes may mention from "somewhere" freely.`,
        `export const lazy = () => import("./helper.ts");`,
        `import { helper as helperThree /* why */, type Shape as ShapeThree } from /* local */ "./helper.ts"; // trailing`,
        `export const lazyCommented = () => import(/* chunk */ "./helper.ts");`,
        `export const lazyLine = () => import // next line\n("./helper.ts");`,
        `export const lazyJson = () => import("./data.json", { with: { type: "json" } });`,
        `export const shared = () => import("../_shared/x_post_config.ts");`,
        ``,
      ].join("\n"),
    ],
    ["x-new-fn/helper.ts", "export const helper = 1;\nexport type Shape = { a: number };\n"],
    ["x-new-fn/side.ts", "export {};\n"],
    ["x-new-fn/data.json", JSON.stringify({ imports: 3, scopes: ["a"] })],
    ["x-new-fn/deno.json", JSON.stringify({ lock: false, nodeModulesDir: "none", compilerOptions: { strict: true } })],
    ["_shared/x_post_config.ts", real.get("_shared/x_post_config.ts") ?? "export const config = 1;\n"],
    // The bridge may restate its authorized names, type-only and over several lines.
    [BRIDGE, `import type {\n  AiSubject, // who\n  BudgetGuard,\n} from /* public entry */ "../ai_provider/mod.ts";\n${real.get(BRIDGE)!}`],
  ]);
  // Compared with the real tree, so this test fails only when the ordinary imports themselves are refused.
  assert.deepEqual(unresolvedImports(valid), unresolvedImports(real));
  assert.deepEqual(remappingConfigs(valid), remappingConfigs(real));
  assert.deepEqual(reachingProductionFiles(valid), reachingProductionFiles(real));
  assert.deepEqual(reachingEntryPoints(valid), reachingEntryPoints(real));
  assert.deepEqual(providerImports(valid), providerImports(real));
  assert.deepEqual(directReferences(valid), directReferences(real));
});
