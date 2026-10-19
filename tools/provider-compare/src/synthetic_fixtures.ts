// Fully synthetic stand-ins for the third-party bodies that are not part of this repository.
//
// The committed fixtures hold no TDnet, BBC, Al Jazeera or AP text (src/fixture_access.ts). The rights logic still has to be
// exercised with bodies that have the real lengths and the real hosts, so the tests use text written for this purpose: a
// per-case marker and a few neutral sentences, repeated to the length the manifest records. It resembles no publication.
import { type CaseFixture, loadCases } from "./fixtures.ts";
import { type BodyManifest, manifestFor } from "./fixture_access.ts";
import { sanitizeBody } from "./sanitize.ts";

// 16 kana, one per hexadecimal digit, so every case gets a distinct 8-character marker.
const KANA = "あいうえおかきくけこさしすせそた";

const SENTENCES = [
  "これは評価ツールの試験のために作った合成の文章であり、実在の開示や記事とは関係がありません。",
  "数値や固有名詞は含まず、長さと文字の種類だけを実物に近づけてあります。",
  "同じ文を繰り返して指定の長さまで伸ばし、最後は切り詰めています。",
];

export function markerOf(caseId: string): string {
  const hex = caseId.replace(/[^0-9a-f]/g, "").slice(-8).padStart(8, "0");
  return [...hex].map((c) => KANA[parseInt(c, 16)]).join("");
}

/** A deterministic synthetic body of exactly `chars` characters (after the sanitiser), distinct per case. */
export function syntheticBodyFor(caseId: string, chars: number): string {
  const marker = markerOf(caseId);
  let text = "";
  let i = 0;
  while (text.length < chars + 40) {
    text += `${marker}：${SENTENCES[i % SENTENCES.length]}`;
    i += 1;
  }
  const body = text.slice(0, chars);
  const clean = sanitizeBody(body);
  if (clean === null || clean !== body) throw new Error(`SYNTHETIC_BODY_NOT_STABLE for ${caseId}`);
  return body;
}

/** A synthetic headline for a case whose real headline is withheld; distinct per case, resembles no publication. */
export function syntheticTitleFor(caseId: string): string {
  return `${markerOf(caseId)}：合成の見出し（試験用・実在の記事とは無関係）`;
}

export type SyntheticLegacy = {
  /** Same 22 cases as the committed file; the unconfirmed ones carry a synthetic body, the open-terms ones their real body. */
  cases: CaseFixture[];
  /** The manifest for exactly those cases (hashes of the synthetic bodies). */
  manifest: BodyManifest;
};

export async function syntheticLegacy(): Promise<SyntheticLegacy> {
  const dir = new URL("../fixtures/", import.meta.url);
  const safe = await loadCases(new URL("cases.rights_safe.json", dir));
  const real = JSON.parse(await Deno.readTextFile(new URL("cases_body_manifest.json", dir))) as BodyManifest;
  const cases = safe.map((item) => {
    const entry = real.entries.find((e) => e.caseId === item.caseId);
    if (!entry || entry.rightsState !== "rights_unconfirmed") return item;
    return {
      ...item,
      candidate: { ...item.candidate, bodySummary: syntheticBodyFor(item.caseId, entry.bodyChars), title: syntheticTitleFor(item.caseId) },
    };
  });
  return { cases, manifest: await manifestFor(cases, "synthetic (tests only)") };
}

/**
 * A fixtures directory for tests: the committed cases and licence register, with the manifest replaced by the synthetic
 * one, so that runtime rows built from synthetic bodies verify. Returns the directory; the caller removes it.
 */
export async function writeSyntheticFixturesDir(overrides: { licences?: unknown } = {}): Promise<string> {
  const shipped = new URL("../fixtures/", import.meta.url);
  const dir = await Deno.makeTempDir({ prefix: "provider-compare-synthetic-" });
  const synthetic = await syntheticLegacy();
  await Deno.writeTextFile(`${dir}/cases.rights_safe.json`, await Deno.readTextFile(new URL("cases.rights_safe.json", shipped)));
  await Deno.writeTextFile(`${dir}/cases_body_manifest.json`, JSON.stringify(synthetic.manifest));
  const licences = overrides.licences === undefined
    ? await Deno.readTextFile(new URL("body_licences.json", shipped))
    : JSON.stringify(overrides.licences);
  await Deno.writeTextFile(`${dir}/body_licences.json`, licences);
  return dir;
}

/** A private-style legacy cases file (bodies present) made of synthetic text, for the offline-only legacy mode. */
export async function writeSyntheticLegacyFile(): Promise<string> {
  const synthetic = await syntheticLegacy();
  const path = await Deno.makeTempFile({ prefix: "provider-compare-legacy-", suffix: ".json" });
  await Deno.writeTextFile(path, JSON.stringify({ version: 1, exportedAt: "synthetic", cases: synthetic.cases }));
  return path;
}

/** JSON-lines rows in the shape scripts/export_cases.sql writes (`id`, `body_summary`), for the cases that have a body. */
export function bodyRowsOf(cases: readonly CaseFixture[]): Array<{ id: string; title: string; body_summary: string }> {
  return cases
    .filter((c) => c.candidate.bodySummary)
    .map((c) => ({
      id: `${c.caseId.slice(-8)}-0000-4000-8000-000000000000`,
      title: c.candidate.title,
      body_summary: c.candidate.bodySummary as string,
    }));
}
