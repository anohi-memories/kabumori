import assert from "node:assert/strict";
import test from "node:test";
import {
  applyRequiredNewsLabel,
  companyIdentityEvidence,
  generateImportantNewsPost,
  generationEligibility,
  hasMatchingRequiredNewsLabel,
  localFactIssues,
  localVoiceIssues,
  requestGenerationStep,
  type GenerationCandidate,
  type GenerationRunner,
  type GenerationStep,
} from "./post_generation_logic.ts";

const candidate = (overrides: Partial<GenerationCandidate> = {}): GenerationCandidate => ({
  id: "candidate-1",
  sourceType: "tdnet",
  sourceUrl: "https://www.release.tdnet.info/inbs/example.pdf",
  sourceName: "tdnet",
  title: "通期業績予想の上方修正について",
  bodySummary: "営業利益予想を上方修正",
  companyName: "テスト株式会社",
  companyCode: "1234",
  entityKey: "company:1234",
  category: "earnings_revision_up",
  publishedAt: "2026-08-31T06:00:00.000Z",
  importance: "important",
  affectedEntities: ["テスト株式会社", "1234"],
  japanMarketRelevance: "medium",
  judgementReason: "業績予想の修正で株価材料になりうるため",
  judgementFactStatus: "passed",
  status: "ready_for_generation",
  ...overrides,
});

function runner(overrides: Partial<Record<GenerationStep, unknown>> = {}): GenerationRunner {
  return async (step) => ({
    payload: overrides[step] ?? (step === "draft"
      ? { text: "テスト株式会社が通期業績予想を上方修正しました。業績の見通しが変わる発表として、同社株の反応が意識されそうです。", sufficient_information: true, notes: [] }
      : { passed: true, issues: [] }),
    model: "gpt-5.6-luna",
    inputTokens: 100,
    outputTokens: 50,
    estimatedCost: 0.00008,
  });
}

test("important candidate generates a concise post", async () => {
  const result = await generateImportantNewsPost(candidate(), runner());
  assert.equal(result.status, "ready_for_publish");
  assert.equal(result.generatedText?.startsWith("【速報】"), true);
  assert.equal((result.generatedText?.match(/【(?:重大)?速報】/g) ?? []).length, 1);
  assert.match(result.generatedText ?? "", /通期業績予想を上方修正/);
});

test("most_important candidate remains eligible for generation", async () => {
  const target = candidate({ importance: "most_important" });
  assert.equal(generationEligibility(target), null);
  const result = await generateImportantNewsPost(target, runner());
  assert.equal(result.status, "ready_for_publish");
  assert.equal(result.generatedText?.startsWith("【重大速報】"), true);
  assert.equal((result.generatedText?.match(/【(?:重大)?速報】/g) ?? []).length, 1);
});

test("important candidate with model-supplied breaking label is deduplicated", async () => {
  const result = await generateImportantNewsPost(candidate(), runner({
    draft: { text: "【速報】テスト株式会社が通期業績予想を上方修正しました。", sufficient_information: true, notes: [] },
  }));
  assert.equal(result.fact.status, "passed");
  assert.equal(result.generatedText?.startsWith("【速報】"), true);
  assert.equal((result.generatedText?.match(/【(?:重大)?速報】/g) ?? []).length, 1);
});

test("most_important normalizes a model-supplied breaking label", async () => {
  const result = await generateImportantNewsPost(candidate({ importance: "most_important" }), runner({
    draft: { text: "【速報】テスト株式会社が通期業績予想を上方修正しました。", sufficient_information: true, notes: [] },
  }));
  assert.equal(result.fact.status, "passed");
  assert.equal(result.status, "ready_for_publish");
  assert.equal(result.generatedText?.startsWith("【重大速報】"), true);
  assert.equal((result.generatedText?.match(/【(?:重大)?速報】/g) ?? []).length, 1);
});

test("mixed duplicate labels are normalized to the required label", () => {
  assert.equal(
    applyRequiredNewsLabel("【重大速報】【速報】本文", "important"),
    "【速報】本文",
  );
  assert.equal(
    applyRequiredNewsLabel("【速報】【重大速報】本文", "most_important"),
    "【重大速報】本文",
  );
});

async function draftInstructions(target: GenerationCandidate): Promise<string> {
  let instructions = "";
  await requestGenerationStep("test-key", "draft", target, undefined, async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { instructions?: unknown };
    instructions = typeof body.instructions === "string" ? body.instructions : "";
    return new Response(JSON.stringify({
      output: [{ content: [{
        type: "output_text",
        text: JSON.stringify({ text: "本文", sufficient_information: true, notes: [] }),
      }] }],
      usage: { input_tokens: 10, output_tokens: 5 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  });
  return instructions;
}

test("draft instructions tell the model not to choose a news label for important", async () => {
  const instructions = await draftInstructions(candidate());
  assert.match(instructions, /textには【速報】や【重大速報】を含めず/);
});

test("draft instructions tell the model not to choose a news label for most_important", async () => {
  const instructions = await draftInstructions(candidate({ importance: "most_important" }));
  assert.match(instructions, /textには【速報】や【重大速報】を含めず/);
});

test("draft instructions prohibit unsupported market interpretations", async () => {
  const instructions = await draftInstructions(candidate());
  assert.match(instructions, /一次情報または確定済みjudgementに直接の根拠がない市場解釈/);
  assert.match(instructions, /材料として意識される/);
  assert.match(instructions, /投資家心理へ影響する/);
});

test("draft instructions prohibit ambiguous entity-role grouping", async () => {
  const instructions = await draftInstructions(candidate());
  assert.match(instructions, /対象会社、買付者、親会社、提携先、株主の役割を区別/);
  assert.match(instructions, /『対象となるのはAとB』『関係するのはAとB』『影響を受けるのはAとB』/);
});

test("TDnet metadata and primary issuer name are safely confirmed as the same company", () => {
  const identity = companyIdentityEvidence(candidate({
    sourceType: "tdnet",
    sourceName: "tdnet",
    sourceUrl: "https://www.release.tdnet.info/inbs/example.pdf",
    companyName: "Ｇ－ＢＡＳＥ",
    companyCode: "44770",
    entityKey: "company:44770",
    bodySummary: "各 位\n会 社 名 BASE 株式会社\n代表者名 代表取締役",
  }));
  assert.deepEqual(identity, {
    metadataName: "Ｇ－ＢＡＳＥ",
    primarySourceName: "BASE 株式会社",
    companyCode: "44770",
    sameCompanyConfirmed: true,
  });
});

test("company name difference without code identity cannot be confirmed", () => {
  const identity = companyIdentityEvidence(candidate({
    sourceType: "tdnet",
    sourceName: "tdnet",
    sourceUrl: "https://www.release.tdnet.info/inbs/example.pdf",
    companyName: "Ｇ－ＢＡＳＥ",
    companyCode: null,
    entityKey: null,
    bodySummary: "会 社 名 BASE 株式会社",
  }));
  assert.equal(identity.sameCompanyConfirmed, false);
});

test("clearly different companies cannot be confirmed by partial similarity", () => {
  const identity = companyIdentityEvidence(candidate({
    sourceType: "tdnet",
    sourceName: "tdnet",
    sourceUrl: "https://www.release.tdnet.info/inbs/example.pdf",
    companyName: "Ｇ－ＢＡＳＥホールディングス",
    companyCode: "44770",
    entityKey: "company:44770",
    bodySummary: "会 社 名 BASE 株式会社",
  }));
  assert.equal(identity.sameCompanyConfirmed, false);
});

test("ambiguous grouping of companies with different roles fails local Fact", () => {
  const target = candidate();
  const text = `【速報】公開買付けへの賛同を発表しました。対象となるのはBASEとSBIホールディングスです。\n\n出典: ${target.sourceUrl}`;
  assert.deepEqual(localFactIssues(target, text), ["AMBIGUOUS_ENTITY_RELATIONSHIP"]);
});

test("specific TOB roles can pass local Fact", () => {
  const target = candidate({
    bodySummary: "SBINM合同会社（SBIホールディングスの完全子会社）がBASE株式への公開買付けを実施し、BASEは賛同しました。",
    judgementReason: "SBINM合同会社によるBASE株式への公開買付け",
    category: "tob",
  });
  const text = `【速報】SBINM合同会社がBASE株式への公開買付けを実施し、BASEは賛同しました。SBINMはSBIホールディングスの完全子会社です。\n\n出典: ${target.sourceUrl}`;
  assert.deepEqual(localFactIssues(target, text), []);
});

// --- company_identity extraction: TOB / subsidiary-change / press-release formats -----------------

test("1: an existing 会社名-header disclosure (kessan-tanshin style) still confirms the same company", () => {
  const identity = companyIdentityEvidence(candidate({
    sourceType: "tdnet",
    sourceName: "tdnet",
    sourceUrl: "https://www.release.tdnet.info/inbs/example.pdf",
    companyName: "コロンビア・ワークス",
    companyCode: "146A0",
    entityKey: "company:146a0",
    bodySummary: "各 位\n会社名 コロンビア・ワークス株式会社\n代表者名 代表取締役 中内 準",
  }));
  assert.equal(identity.sameCompanyConfirmed, true);
  assert.equal(identity.primarySourceName, "コロンビア・ワークス株式会社");
});

test("2: a self-tender (TOB) results notice confirms the issuer via 公開買付者の名称", () => {
  const identity = companyIdentityEvidence(candidate({
    sourceType: "tdnet",
    sourceName: "tdnet",
    sourceUrl: "https://www.release.tdnet.info/inbs/example.pdf",
    companyName: "伊藤忠",
    companyCode: "80010",
    entityKey: "company:80010",
    bodySummary: "自己株式の公開買付けの結果並びに市場買付の開始に関するお知らせ\n" +
      "１．買付け等の概要\n（１）公開買付者の名称及び所在地\n伊藤忠商事株式会社 大阪市北区梅田３丁目１番３号",
  }));
  assert.equal(identity.sameCompanyConfirmed, true);
  assert.equal(identity.primarySourceName, "伊藤忠商事株式会社");
});

test("3: a subsidiary-change (孫会社の異動) notice confirms the issuer via its 当社 self-reference", () => {
  const identity = companyIdentityEvidence(candidate({
    sourceType: "tdnet",
    sourceName: "tdnet",
    sourceUrl: "https://www.release.tdnet.info/inbs/example.pdf",
    companyName: "第一ライフグループ",
    companyCode: "87500",
    entityKey: "company:87500",
    bodySummary: "Fidelity Life 社の子会社化（孫会社の異動）について\n" +
      "株式会社第一ライフグループ（代表取締役社長グループ CEO：菊田 徹也、以下「当社」）のニュージーランド子会社である " +
      "Partners Group Holdings Limited（以下、「パートナーズ・ライフ社」）は、Fidelity Life Assurance Company Limited" +
      "（以下、「Fidelity Life 社」）を買収することを決定しました。",
  }));
  assert.equal(identity.sameCompanyConfirmed, true);
  assert.equal(identity.primarySourceName, "株式会社第一ライフグループ");
});

test("4: a press-release style disclosure confirms the issuer via its own 以下-alias, without a 当社 marker", () => {
  const identity = companyIdentityEvidence(candidate({
    sourceType: "tdnet",
    sourceName: "tdnet",
    sourceUrl: "https://www.release.tdnet.info/inbs/example.pdf",
    companyName: "エーザイ",
    companyCode: "45230",
    entityKey: "company:45230",
    bodySummary: "「レケンビ」の皮下注射製剤、早期アルツハイマー病に対する初期療法として中国で承認取得\n" +
      "エーザイ株式会社（本社：東京都、代表執行役 CEO：内藤晴夫、以下 エーザイ）とバイオジェン・インクは、承認を取得したことをお知らせします。",
  }));
  assert.equal(identity.sameCompanyConfirmed, true);
  assert.equal(identity.primarySourceName, "エーザイ株式会社");
});

test("5: a plain acquisition mention of the target company does not confirm the target as the issuer", () => {
  const identity = companyIdentityEvidence(candidate({
    sourceType: "tdnet",
    sourceName: "tdnet",
    sourceUrl: "https://www.release.tdnet.info/inbs/example.pdf",
    companyName: "B社",
    companyCode: "99990",
    entityKey: "company:99990",
    bodySummary: "A社がB社を買収することを決定しました。",
  }));
  assert.equal(identity.sameCompanyConfirmed, false);
  assert.equal(identity.primarySourceName, null);
});

test("6: only a subsidiary being named (no issuer 当社/alias match) does not confirm the parent company", () => {
  const identity = companyIdentityEvidence(candidate({
    sourceType: "tdnet",
    sourceName: "tdnet",
    sourceUrl: "https://www.release.tdnet.info/inbs/example.pdf",
    companyName: "親会社ホールディングス",
    companyCode: "88880",
    entityKey: "company:88880",
    bodySummary: "子会社の異動について\n子会社サービス株式会社（以下「子会社サービス」）の株式を譲渡することを決定しました。",
  }));
  assert.equal(identity.sameCompanyConfirmed, false);
});

test("7: a document with no extractable company name stays unconfirmed (fail-closed)", () => {
  const identity = companyIdentityEvidence(candidate({
    sourceType: "tdnet",
    sourceName: "tdnet",
    sourceUrl: "https://www.release.tdnet.info/inbs/example.pdf",
    companyName: "テスト株式会社",
    companyCode: "1234",
    entityKey: "company:1234",
    bodySummary: "業績予想の一部を修正しましたのでお知らせします。",
  }));
  assert.equal(identity.sameCompanyConfirmed, false);
  assert.equal(identity.primarySourceName, null);
});

test("Fact instructions receive only verified company identity evidence", async () => {
  const target = candidate({
    sourceType: "tdnet",
    sourceName: "tdnet",
    sourceUrl: "https://www.release.tdnet.info/inbs/example.pdf",
    companyName: "Ｇ－ＢＡＳＥ",
    companyCode: "44770",
    entityKey: "company:44770",
    bodySummary: "会 社 名 BASE 株式会社",
  });
  let instructions = "";
  let input: { company_identity?: { sameCompanyConfirmed?: unknown } } = {};
  await requestGenerationStep("test-key", "fact", target, "【速報】本文", async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { instructions?: unknown; input?: unknown };
    instructions = typeof body.instructions === "string" ? body.instructions : "";
    input = JSON.parse(String(body.input));
    return new Response(JSON.stringify({
      output: [{ content: [{ type: "output_text", text: JSON.stringify({ passed: true, issues: [] }) }] }],
      usage: { input_tokens: 10, output_tokens: 5 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  });
  assert.equal(input.company_identity?.sameCompanyConfirmed, true);
  assert.match(instructions, /sameCompanyConfirmedがtrueの場合に限り/);
  assert.match(instructions, /部分一致で同一企業と推測せず/);
});

test("no_post candidate is not generated", async () => {
  let called = false;
  const result = await generateImportantNewsPost(candidate({ importance: "no_post" }), async (...args) => {
    called = true;
    return runner()(...args);
  });
  assert.equal(called, false);
  assert.equal(result.status, "generation_failed");
  assert.equal(result.stoppedReason, "NEWS_NOT_GENERATION_IMPORTANCE");
});

test("Fact failure never transitions to ready_for_publish", async () => {
  const result = await generateImportantNewsPost(candidate(), runner({
    fact: { passed: false, issues: ["元情報にない数値"] },
  }));
  assert.equal(result.fact.status, "failed");
  assert.equal(result.voice.status, "not_run");
  assert.equal(result.status, "generation_failed");
});

test("Voice failure never transitions to ready_for_publish", async () => {
  const result = await generateImportantNewsPost(candidate(), runner({
    voice: { passed: false, issues: ["証券会社レポート風"] },
  }));
  assert.equal(result.fact.status, "passed");
  assert.equal(result.voice.status, "failed");
  assert.equal(result.status, "generation_failed");
});

test("concise fact-focused breaking news can pass Voice", async () => {
  const result = await generateImportantNewsPost(candidate(), runner({
    draft: {
      text: "テスト株式会社が通期業績予想を上方修正しました。\n\n営業利益予想を引き上げています。",
      sufficient_information: true,
      notes: [],
    },
  }));
  assert.equal(result.voice.status, "passed");
  assert.equal(result.status, "ready_for_publish");
});

test("natural fact listing is not a local Voice failure", () => {
  const text = "【速報】BASE、自己株式の取得を中止\n\n公開買付けへの賛同に伴うものです。\n\n取得実績は0株、0円でした。\n\n出典: https://example.com/source.pdf";
  assert.deepEqual(localVoiceIssues(text), []);
});

test("unnecessary related-entities closing fails Voice", async () => {
  const result = await generateImportantNewsPost(candidate(), runner({
    draft: {
      text: "テスト株式会社が通期業績予想を上方修正しました。\n\n関係するのはテスト株式会社です。",
      sufficient_information: true,
      notes: [],
    },
  }));
  assert.equal(result.fact.status, "passed");
  assert.deepEqual(result.voice.issues, ["UNNATURAL_EXPLANATORY_CLOSING"]);
  assert.equal(result.status, "generation_failed");
});

test("つまりというニュースです closing fails Voice", () => {
  assert.deepEqual(
    localVoiceIssues("【速報】本文です。\n\nつまり、業績予想を修正したというニュースです。\n\n出典: https://example.com/source.pdf"),
    ["UNNATURAL_EXPLANATORY_CLOSING"],
  );
});

test("unnatural announcement recap fails Voice", () => {
  assert.deepEqual(
    localVoiceIssues("【速報】本文です。\n\nこれは自己株式取得の中止に関する発表です。\n\n出典: https://example.com/source.pdf"),
    ["UNNATURAL_EXPLANATORY_CLOSING"],
  );
});

test("Voice instructions accept concise facts and reject explanatory recaps", async () => {
  let instructions = "";
  await requestGenerationStep("test-key", "voice", candidate(), "【速報】本文", async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { instructions?: unknown };
    instructions = typeof body.instructions === "string" ? body.instructions : "";
    return new Response(JSON.stringify({
      output: [{ content: [{ type: "output_text", text: JSON.stringify({ passed: true, issues: [] }) }] }],
      usage: { input_tokens: 10, output_tokens: 5 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  });
  assert.match(instructions, /事実中心・事実列挙であることだけを理由にfailedにしません/);
  assert.match(instructions, /『関係するのは〜』『つまり〜というニュースです』『〜に関する発表です』/);
});

test("source_url is appended exactly once at the end", async () => {
  const target = candidate();
  const result = await generateImportantNewsPost(target, runner());
  const text = result.generatedText ?? "";
  assert.equal(text.endsWith(`出典: ${target.sourceUrl}`), true);
  assert.equal((text.match(/https:\/\//g) ?? []).length, 1);
});

test("unsupported EC and finance theme interpretation fails local Fact", async () => {
  const target = candidate({
    title: "自己株式の取得中止及び取得状況に関するお知らせ",
    bodySummary: "公開買付けへの賛同と資本業務提携に伴い、自己株式の取得を中止。取得実績は0株、0円。",
    judgementReason: "公開買付けと資本業務提携に伴う自己株式取得中止",
    category: "tob",
  });
  const result = await generateImportantNewsPost(target, runner({
    draft: {
      text: "公開買付けへの賛同に伴い、自己株式の取得を中止しました。関連するEC・金融テーマで意識される可能性があります。",
      sufficient_information: true,
      notes: [],
    },
  }));
  assert.equal(result.fact.status, "failed");
  assert.deepEqual(result.fact.issues, ["UNSUPPORTED_MARKET_INTERPRETATION"]);
  assert.equal(result.voice.status, "not_run");
});

test("label normalization keeps unsupported market interpretation detection", async () => {
  const target = candidate({
    bodySummary: "公開買付けへの賛同に伴い、自己株式の取得を中止しました。",
    judgementReason: "公開買付けへの賛同に伴う自己株式取得中止",
    category: "tob",
  });
  const result = await generateImportantNewsPost(target, runner({
    draft: {
      text: "【速報】自己株式の取得を中止しました。資本業務提携が材料として意識される可能性があります。",
      sufficient_information: true,
      notes: [],
    },
  }));
  assert.equal(result.fact.status, "failed");
  assert.deepEqual(result.fact.issues, ["UNSUPPORTED_MARKET_INTERPRETATION"]);
  assert.equal(result.generatedText?.startsWith("【速報】"), true);
  assert.equal((result.generatedText?.match(/【(?:重大)?速報】/g) ?? []).length, 1);
  assert.equal(result.voice.status, "not_run");
});

test("importance and news label mismatch fails local Fact", () => {
  const target = candidate();
  const text = `【重大速報】本文\n\n出典: ${target.sourceUrl}`;
  assert.equal(hasMatchingRequiredNewsLabel(text, target.importance), false);
  assert.deepEqual(localFactIssues(target, text), ["NEWS_LABEL_IMPORTANCE_MISMATCH"]);
});

test("directly disclosed causality is not treated as unsupported market interpretation", async () => {
  const result = await generateImportantNewsPost(candidate({
    bodySummary: "公開買付けへの賛同に伴い、自己株式の取得を中止しました。",
    judgementReason: "公開買付けへの賛同に伴う自己株式取得中止",
    category: "tob",
  }), runner({
    draft: {
      text: "公開買付けへの賛同に伴い、自己株式の取得を中止しました。",
      sufficient_information: true,
      notes: [],
    },
  }));
  assert.equal(result.fact.status, "passed");
  assert.equal(result.status, "ready_for_publish");
});

test("insufficient stored information stops safely before AI generation", async () => {
  let called = false;
  const result = await generateImportantNewsPost(
    candidate({ judgementReason: null, judgementFactStatus: "needs_review" }),
    async (...args) => {
      called = true;
      return runner()(...args);
    },
  );
  assert.equal(called, false);
  assert.equal(result.generatedText, null);
  assert.equal(result.status, "generation_failed");
});

test("normal generation transitions only after both checks pass", async () => {
  const calls: GenerationStep[] = [];
  const base = runner();
  const result = await generateImportantNewsPost(candidate(), async (...args) => {
    calls.push(args[0]);
    return base(...args);
  });
  assert.deepEqual(calls, ["draft", "fact", "voice"]);
  assert.equal(result.fact.status, "passed");
  assert.equal(result.voice.status, "passed");
  assert.equal(result.status, "ready_for_publish");
  assert.equal(result.inputTokens, 300);
  assert.equal(result.outputTokens, 150);
});
