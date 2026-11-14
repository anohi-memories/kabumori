import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createAiLabClaudeStages } from "./ai_lab_post.ts";
import {
  anthropicBody,
  FAKE_ANTHROPIC_KEY,
  fakeEnv,
  hangUntilAborted,
  jsonResponse,
  type RecordedCall,
  recordingFetch,
  type Responder,
} from "./test_support.ts";
import { resolveBrandContext } from "../brand/brand_context.ts";
import { createAiLabScheduledPostGenerator } from "../brand/ai_lab_engagement.ts";
import { dispatchAiLabScheduledBrandPost } from "../brand/ai_lab_scheduled_brand_post.ts";
import { generateBrandPost } from "../brand/brand_post_generator.ts";
import { fingerprintText } from "../brand/cross_brand_dedupe.ts";
import { prepareAiLabVoiceRewrite } from "../brand/ai_lab_voice_rewrite.ts";

const ORIGINAL =
  "通知の表示を2台で比較しています。\nhttps://example.test/notes\n#個人開発";
const EDITED =
  "通知の表示を2台で比較してます。\nhttps://example.test/notes\n#個人開発";
const options = ["通知", "予定", "履歴"];
const providerResponse = (payload: unknown) =>
  jsonResponse(200, anthropicBody(payload));

type Candidate = { id: number; at: number; from: string; options: string[] };
type Selection = readonly [from: string, replacement: string];
const defaultSelection = [["しています。", "してます。"]] as const;

function rewriteInput(call: RecordedCall) {
  const { messages } = call.body as { messages: { content: string }[] };
  return JSON.parse(messages[0].content) as {
    original: string;
    mode: string;
    candidates: Candidate[];
  };
}

function editedReply(
  call: RecordedCall,
  text: string,
  selections: readonly Selection[] = defaultSelection,
) {
  const { candidates } = rewriteInput(call);
  const edits = selections.map(([from, replacement]) => {
    const candidate = candidates.find((value) =>
      value.from === from &&
      value.options.includes(replacement)
    );
    assert.ok(candidate, `missing edit ${JSON.stringify([from, replacement])}`);
    return { id: candidate.id, option: candidate.options.indexOf(replacement) };
  }).sort((a, b) => a.id - b.id);
  return { decision: "edited", text, edits };
}

function normalResponse(call: RecordedCall, index: number) {
  return providerResponse(
    index ? editedReply(call, EDITED) : { text: ORIGINAL },
  );
}

test("scheduled entry binds both stages in the AI Lab branch and keeps the native 24-hour transport", async () => {
  const source = await readFile(
    new URL("../../x-test-post/index.ts", import.meta.url),
    "utf8",
  );
  const brandBranch = source.slice(
    source.indexOf('if (scheduledPost.post_type === "brand_post") {'),
  );
  const aiLabBranch = brandBranch.slice(
    brandBranch.indexOf("const diaryMarkdown ="),
    brandBranch.indexOf("// Shared market report consumer"),
  );
  assert.match(
    aiLabBranch,
    /const \{ textProvider, rewriteVoice \} = createAiLabClaudeStages\(/u,
  );
  assert.match(
    aiLabBranch,
    /generateBrandPost\(\{ \.\.\.args, textProvider \}\)\),\s+rewriteVoice,/u,
  );
  assert.match(
    aiLabBranch,
    /requestXPost\(accessToken, text, undefined, pollOptions, "manual"\)/u,
  );
  assert.match(
    source,
    /poll: \{ options: pollOptions, duration_minutes: 1440 \}/u,
  );
  assert.equal(source.match(/createAiLabClaudeStages\(/gu)?.length, 1);
});

test("the editor keeps multiline quotations, URLs and question intent intact", () => {
  const original =
    "「通知を\n確認しています。\n」と書きました。\nhttps://example.test/通知を確認しています。\nどれを選びますか？";
  const prepared = prepareAiLabVoiceRewrite({
    brandId: "ai_salaryman_lab",
    postType: "brand_post",
    text: original,
  });
  const { candidates } = JSON.parse(prepared.request.input) as {
    candidates: Candidate[];
  };
  assert.equal(candidates.some(({ from }) => from === "しています。"), false);
  assert.equal(
    candidates.some(({ from }) => from === "どれを選びますか？"),
    true,
  );
  assert.throws(() =>
    prepared.validate({
      decision: "keep",
      text: original.replace("か？", "。"),
      edits: [],
    }), /VOICE_REWRITE_REJECTED/);
});

test("ambiguous clause endings and malformed quotation boundaries stay untouched", () => {
  const draft = { brandId: "ai_salaryman_lab", postType: "brand_post" };
  const request = (text: string) =>
    (JSON.parse(prepareAiLabVoiceRewrite({ ...draft, text }).request.input) as {
      candidates: Candidate[];
    }).candidates;
  assert.equal(
    request("連絡しましたが、よければ見てもらえますか？").some(({ from }) =>
      from === "しましたが、"
    ),
    false,
  );
  assert.deepEqual(
    request("結論から言うと、確認を行いました。表示は同じでした」"),
    [],
  );
});

function fixture(
  respond: Responder,
  {
    rotation = 0,
    flag = "enabled",
    key = FAKE_ANTHROPIC_KEY,
    publishError,
  }: { rotation?: number; flag?: string; key?: string; publishError?: Error } =
    {},
) {
  const events: string[] = [];
  const recorder = recordingFetch((call, index, init) => {
    events.push(`Claude:${index}`);
    return respond(call, index, init);
  });
  const env = fakeEnv({
    AI_LAB_CLAUDE_TWO_STAGE: flag,
    AI_LAB_TEXT_API_KEY: key,
    ANTHROPIC_API_KEY: "shared-key-must-never-be-used",
  });
  const { textProvider, rewriteVoice } = createAiLabClaudeStages({
    readEnv: env.readEnv,
    fetch: recorder.fetch,
  });
  const context = resolveBrandContext(
    {
      id: "ai_salaryman_lab",
      display_name: "fixture",
      is_active: true,
      publish_mode: "live",
      code_profile_key: "ai_salaryman_lab_v1",
    },
    {
      id: "ai_salaryman_lab_x",
      brand_id: "ai_salaryman_lab",
      platform: "x",
      handle: "kaishain_ai_lab",
      publish_enabled: true,
      oauth_client_ref: "default",
    },
    {
      brand_id: "ai_salaryman_lab",
      fixed_hashtags: [],
      note_url: null,
      image_policy: {},
      enabled_post_types: ["brand_post"],
    },
  );
  const payloads: { text: string; pollOptions?: string[] }[] = [];
  const completedFingerprints: string[] = [];
  let started = false;
  const args: Parameters<typeof dispatchAiLabScheduledBrandPost>[0] = {
    context,
    postType: "brand_post",
    scheduledPostId: "fixture-schedule",
    openAiApiKey: "fixture-only",
    loadRecentFingerprints: () => Promise.resolve([]),
    topic: {
      claim: () => {
        if (started) throw new Error("fixture: topic already started");
        events.push("claim");
        return Promise.resolve({
          claimId: "fixture-claim",
          eventKey: "fixture-event",
          unitKey: "fixture-unit",
          kind: "evergreen",
          topic: "通知と画面表示の確認",
        });
      },
      release: (_claim, reason) => {
        events.push(`release:${reason}`);
        return Promise.resolve("RELEASED");
      },
      startProvider: () => {
        events.push("start X");
        started = true;
        return Promise.resolve(true);
      },
      markAmbiguous: () => {
        events.push("ambiguous X");
        return Promise.resolve("AMBIGUOUS");
      },
      settlePublished: () => {
        events.push("settle");
        return Promise.resolve("PUBLISHED");
      },
    },
    generate: createAiLabScheduledPostGenerator(
      rotation,
      (request) =>
        generateBrandPost({
          ...request,
          textProvider,
          fetchImpl: (input, init) => {
            events.push("OpenAI");
            assert.equal(String(input), "https://api.openai.com/v1/responses");
            assert.equal(
              new Headers(init?.headers).get("authorization"),
              "Bearer fixture-only",
            );
            return Promise.resolve(jsonResponse(200, {
              output: [{ content: [{ type: "output_text", text: ORIGINAL }] }],
            }));
          },
        }),
    ),
    rewriteVoice,
    publishText: (text, pollOptions) => {
      events.push("X");
      payloads.push({ text, pollOptions });
      if (publishError) throw publishError;
      return Promise.resolve({ data: { id: "fixture-post" } });
    },
    completePublishedPost: ({ normalizedTextSha256 }) => {
      events.push("complete");
      completedFingerprints.push(normalizedTextSha256);
      return Promise.resolve({ fingerprintPersisted: true });
    },
  };
  return {
    args,
    events,
    recorder,
    env,
    payloads,
    completedFingerprints,
    textProvider,
    rewriteVoice,
  };
}

for (
  const [mode, rotation, original, edited] of [
    ["regular", 0, ORIGINAL, EDITED],
    [
      "experience",
      2,
      "通知が多いとき、見落としたことがありますか？",
      "通知が多いとき、見落としたことありますか？",
    ],
    [
      "opinion",
      5,
      "予定一覧に通知時刻を出す案、どう思いますか？",
      "予定一覧に通知時刻を出す案、どう思います？",
    ],
    [
      "choices",
      8,
      "最初に開くなら、どれを選びますか？",
      "最初に開くなら、どれを選びます？",
    ],
  ] as const
) {
  test(`Claude stages produce the checked ${mode} payload and fingerprint`, async () => {
    const selection = {
      regular: defaultSelection[0],
      experience: ["ことがありますか？", "ことありますか？"],
      opinion: ["どう思いますか？", "どう思います？"],
      choices: ["どれを選びますか？", "どれを選びます？"],
    }[mode] as Selection;
    const pollOptions = mode === "choices" ? options : undefined;
    const f = fixture(
      (call, index) =>
        providerResponse(
          index
            ? editedReply(call, edited, [selection])
            : pollOptions
            ? { text: original, poll_options: pollOptions }
            : { text: original },
        ),
      { rotation },
    );
    const result = await dispatchAiLabScheduledBrandPost(f.args);
    assert.deepEqual(f.events, [
      "claim",
      "Claude:0",
      "Claude:1",
      "start X",
      "X",
      "settle",
      "complete",
    ]);
    assert.deepEqual(f.payloads, [{ text: edited, pollOptions }]);
    assert.deepEqual(f.completedFingerprints, [await fingerprintText(edited)]);
    assert.equal(result.pollCreated, mode === "choices" ? true : undefined);
    assert.equal(result.characterCount, Array.from(edited).length);
    assert.equal(result.voiceRewriteDecision, "edited");
    const calls = f.recorder.calls.map(({ url, headers, body }) => {
      assert.equal(url, "https://api.anthropic.com/v1/messages");
      assert.equal(headers.get("x-api-key"), FAKE_ANTHROPIC_KEY);
      return body as { model: string; messages: { content: string }[] };
    });
    assert.deepEqual(calls.map(({ model }) => model), [
      "claude-opus-5-5",
      "claude-opus-5-5",
    ]);
    const input = rewriteInput(f.recorder.calls[1]);
    assert.equal(input.original, original);
    assert.equal(input.mode, mode);
    assert.equal(Object.hasOwn(input, "poll_options"), false);
    assert.deepEqual(f.env.reads, [
      "AI_LAB_CLAUDE_TWO_STAGE",
      "AI_LAB_TEXT_API_KEY",
      "AI_LAB_TEXT_API_KEY",
    ]);
  });
}

const detail =
  "通知欄では更新した順に項目が並び、予定一覧では日付の順に並びます。両方を横に置いて見ると、見出しの位置の違いが分かりました。予定の日時は詳細画面を開いて確認しました。確認の途中で設定や並び順は変更していません。比較した画面の記録はリンク先にまとめました。";
const longDraft =
  "結論から言うと、私自身は、2026年11月12日にPOSTONAの通知画面を2台で確認しましたが、片方では予定の見出しが残りました。画面の表示は「確認中」です。" +
  detail +
  "日付と通知を一緒に見るほうが予定を追いやすいです。日付と通知を一緒に見るほうが予定を追いやすいです。以上が今回の話です。\n#個人開発 @sample_dev https://example.test/notes";
const longEdited =
  "私は2026年11月12日にPOSTONAの通知画面を2台で確認しました。\nただ、片方では予定の見出しが残りました。画面の表示は「確認中」です。" +
  detail +
  "日付と通知を一緒に見るほうが予定を追いやすいです。\n#個人開発 @sample_dev https://example.test/notes";

const structuralExamples: readonly [
  mode: string,
  rotation: number,
  original: string,
  edited: string,
  edits: readonly Selection[],
][] = [
  ["regular", 0, longDraft, longEdited, [
    ["結論から言うと、", ""],
    ["私自身は、", "私は"],
    ["しましたが、", "しました。\nただ、"],
    ["日付と通知を一緒に見るほうが予定を追いやすいです。", ""],
    ["以上が今回の話です。", ""],
  ]],
  [
    "regular",
    0,
    "私自身は、通知の順番を確認しました。以上が今回の話です。",
    "私は通知の順番を確認しました。",
    [["私自身は、", "私は"], ["以上が今回の話です。", ""]],
  ],
  [
    "experience",
    2,
    "私自身の体験としては、朝は通知から確認します。通知を見落としたことがありますか？",
    "私の場合は朝は通知から確認します。\n通知を見落としたことありますか？",
    [["私自身の体験としては、", "私の場合は"], ["", "\n"], [
      "ことがありますか？",
      "ことありますか？",
    ]],
  ],
  [
    "experience",
    2,
    "簡単に言うと、朝は予定を確認しましたが、一方で夜は通知を先に見ました。似たことがありますか？",
    "朝は予定を確認しました。\n一方で夜は通知を先に見ました。似たことありますか？",
    [["簡単に言うと、", ""], ["しましたが、", "しました。\n"], [
      "ことがありますか？",
      "ことありますか？",
    ]],
  ],
  [
    "opinion",
    5,
    "私自身は、通知時刻の表示を確認しました。予定にも時刻を出す案、どう思いますか？",
    "私は通知時刻の表示を確認しました。予定にも時刻を出す案、どう思います？",
    [["私自身は、", "私は"], ["どう思いますか？", "どう思います？"]],
  ],
  [
    "opinion",
    5,
    "まとめると、通知一覧を見ながら、確認を行いました。先に日付を出す案、どう思いますか？",
    "通知一覧を見ながら、確認しました。\n先に日付を出す案、どう思います？",
    [["まとめると、", ""], ["確認を行いました", "確認しました"], [
      "",
      "\n",
    ], ["どう思いますか？", "どう思います？"]],
  ],
  [
    "choices",
    8,
    "結論から言うと、朝に一つだけ画面を開くなら、どれを選びますか？",
    "朝に一つだけ画面を開くなら、どれを選びます？",
    [["結論から言うと、", ""], ["どれを選びますか？", "どれを選びます？"]],
  ],
  [
    "choices",
    8,
    "簡単に言うと、朝は通知を確認しましたが、一方で夜は履歴を見ました。朝に開くなら、どれを選びますか？",
    "朝は通知を確認しました。\n一方で夜は履歴を見ました。朝に開くなら、どれを選びます？",
    [["簡単に言うと、", ""], ["しましたが、", "しました。\n"], [
      "どれを選びますか？",
      "どれを選びます？",
    ]],
  ],
];

for (
  const [number, [mode, rotation, original, edited, selections]]
    of structuralExamples.entries()
) {
  test(
    "synthetic " + mode + " rewrite " + (number + 1) +
      " improves structure before sending only the final text",
    async () => {
      const pollOptions = mode === "choices" ? options : undefined;
      const f = fixture((call, index) =>
        providerResponse(
          index
            ? editedReply(call, edited, selections)
            : pollOptions
            ? { text: original, poll_options: pollOptions }
            : { text: original },
        ), { rotation });
      const result = await dispatchAiLabScheduledBrandPost(f.args);
      assert.deepEqual(f.events, [
        "claim",
        "Claude:0",
        "Claude:1",
        "start X",
        "X",
        "settle",
        "complete",
      ]);
      assert.equal(result.voiceRewriteDecision, "edited");
      assert.deepEqual(f.payloads, [{ text: edited, pollOptions }]);
      assert.deepEqual(f.completedFingerprints, [
        await fingerprintText(edited),
      ]);
      assert.equal(result.characterCount, Array.from(edited).length);
      assert.ok(edited.length < original.length);
      if (number === 0) assert.ok(original.length > 280);
    },
  );
}

// Synthetic fixtures. Statements about the author in this table are not real experiences.
const preservedLines =
  "\n#個人開発 @sample_dev https://example.test/記録。笑、全文\n「私、先に、確認しました。笑」\n" +
  JSON.stringify({ text: '私、先に、確認しました。笑 "メモ["', count: 2 });
const chatExamples: typeof structuralExamples = [
  [
    "regular",
    0,
    "まぁエラーはしょっちゅう出るし、AIが意味わからんことする時もあるけど。笑",
    "まぁエラーはしょっちゅう出るし、AIが意味わからんことする時もあるけど😂",
    [["。笑", "😂"]],
  ],
  [
    "regular",
    0,
    "私、プログラミングなんてほとんどわからないんですよ。",
    "プログラミングなんてほとんどわからないんですよ。",
    [["私、", ""]],
  ],
  [
    "regular",
    0,
    detail +
    "確認を行いました。田中さんと2026年11月12日の記録を2台で確認できてほっとしました。" +
    preservedLines,
    detail +
    "確認しました。田中さんと2026年11月12日の記録を2台で確認できてほっとしました😊" +
    preservedLines,
    [["確認を行いました", "確認しました"], [
      "ほっとしました。",
      "ほっとしました😊",
    ]],
  ],
  [
    "experience",
    2,
    "私、設定の説明がわからないんです。ちなみに、通知は多いし、迷ったことがありますか？",
    "設定の説明がわからないんです。ちなみに通知は多いし、迷ったことありますか？",
    [["私、", ""], ["、", ""], ["ことがありますか？", "ことありますか？"]],
  ],
  [
    "experience",
    2,
    "朝は、手順どおりに確認したつもりでしたね。　笑\n同じ経験ありますか？",
    "朝は、手順どおりに確認したつもりでしたね笑\n同じ経験ありますか？",
    [["。　笑", "笑"]],
  ],
  [
    "opinion",
    5,
    "たとえば、予定の横に、通知時刻を出す案はどう思いますか？",
    "たとえば予定の横に、通知時刻を出す案はどう思います？",
    [["、", ""], ["どう思いますか？", "どう思います？"]],
  ],
  [
    "opinion",
    5,
    "私は、並び順が見えると、ほっとしました。今の並びはどう思いますか？",
    "私は並び順が見えると、ほっとしました。今の並びはどう思います？",
    [["私は、", "私は"], ["どう思いますか？", "どう思います？"]],
  ],
  [
    "choices",
    8,
    "私は、最初の画面で迷うことがあるし、朝に開くならどれを選びますか？",
    "私は最初の画面で迷うことがあるし、朝に開くならどれを選びます？",
    [["私は、", "私は"], ["どれを選びますか？", "どれを選びます？"]],
  ],
  [
    "choices",
    8,
    "まず、朝に画面を開くとき、どれを選びますか？",
    "まず朝に画面を開くとき、どれを選びます？",
    [["、", ""], ["どれを選びますか？", "どれを選びます？"]],
  ],
];

for (
  const [number, [mode, rotation, original, edited, selections]] of chatExamples
    .entries()
) {
  test(
    "synthetic chat voice " + mode + " " + (number + 1) +
      " publishes the verified text only",
    async () => {
      const pollOptions = mode === "choices" ? options : undefined;
      const f = fixture((call, index) =>
        providerResponse(
          index
            ? editedReply(call, edited, selections)
            : pollOptions
            ? { text: original, poll_options: pollOptions }
            : { text: original },
        ), { rotation });
      const result = await dispatchAiLabScheduledBrandPost(f.args);
      assert.equal(result.voiceRewriteDecision, "edited");
      assert.deepEqual(f.payloads, [{ text: edited, pollOptions }]);
      assert.deepEqual(f.completedFingerprints, [
        await fingerprintText(edited),
      ]);
      assert.deepEqual(f.events, [
        "claim",
        "Claude:0",
        "Claude:1",
        "start X",
        "X",
        "settle",
        "complete",
      ]);
      const { system } = f.recorder.calls[1].body as { system: string };
      assert.match(system, /友達と話す/u);
      assert.match(system, /一文に最大1個/u);
      assert.match(system, /けど😂/u);
      assert.equal(rewriteInput(f.recorder.calls[1]).original, original);
    },
  );
}

for (const rotation of [0, 2, 5, 8]) {
  for (
    const [kind, original] of [
      [
        "commas across a line break",
        "通知を、朝に見て、\n予定は後で見ます。どれを選びますか？",
      ],
      [
        "period before laughter",
        "確認できました。 \u200B\n（ 笑 ）\nどれを選びますか？",
      ],
      [
        "unnecessary subject comma",
        "私、設定の説明がわからないんです。どれを選びますか？",
      ],
    ] as const
  ) {
    test(
      "keep holds " + kind + " before X in format slot " + rotation,
      async () => {
        const f = fixture((_call, index) =>
          providerResponse(
            index
              ? { decision: "keep", text: original, edits: [] }
              : rotation === 8
              ? { text: original, poll_options: options }
              : { text: original },
          ), { rotation });
        await assert.rejects(
          dispatchAiLabScheduledBrandPost(f.args),
          /AI_LAB_VOICE_STYLE_REJECTED/,
        );
        assert.deepEqual(f.events, [
          "claim",
          "Claude:0",
          "Claude:1",
          "release:PRE_X_CONTENT_REJECTED",
        ]);
        assert.deepEqual(f.payloads, []);
      },
    );
  }
}

test("valid edit IDs cannot publish when another body sentence still breaks the style rule", async () => {
  const original = "通知を、朝に見て、予定は後で見ます。確認できました。笑";
  const edited = "通知を、朝に見て、予定は後で見ます。確認できました笑";
  const f = fixture((call, index) =>
    providerResponse(
      index ? editedReply(call, edited, [["。笑", "笑"]]) : { text: original },
    )
  );
  await assert.rejects(
    dispatchAiLabScheduledBrandPost(f.args),
    /AI_LAB_VOICE_STYLE_REJECTED/,
  );
  assert.deepEqual(f.payloads, []);
});

test("an ambiguous protected boundary and alternate first-person forms hold before X", async () => {
  for (
    const original of [
      "メモに「確認できました。笑",
      "僕は予定から確認しました。",
    ]
  ) {
    const f = fixture((_call, index) =>
      providerResponse(
        index
          ? { decision: "keep", text: original, edits: [] }
          : { text: original },
      )
    );
    await assert.rejects(
      dispatchAiLabScheduledBrandPost(f.args),
      /AI_LAB_VOICE_STYLE_REJECTED/,
    );
    assert.deepEqual(f.payloads, []);
  }
});

test("voice edits allow at most one new emoji and cannot add a first-person claim", async () => {
  const original = "確認しましたけど。笑\nほっとしました。";
  for (
    const [edited, selections, expected] of [
      ["確認しましたけど😂\nほっとしました😊", [["。笑", "😂"], [
        "ほっとしました。",
        "ほっとしました😊",
      ]], /AI_LAB_VOICE_STYLE_REJECTED/],
      [
        "私は確認しましたけど笑\nほっとしました。",
        [["。笑", "笑"]],
        /AI_LAB_VOICE_REWRITE_REJECTED/,
      ],
    ] as const
  ) {
    const f = fixture((call, index) =>
      providerResponse(
        index ? editedReply(call, edited, selections) : { text: original },
      )
    );
    await assert.rejects(dispatchAiLabScheduledBrandPost(f.args), expected);
    assert.deepEqual(f.payloads, []);
  }
});

test("flag OFF uses the existing OpenAI path and reads no Anthropic credential", async () => {
  const f = fixture(() => assert.fail("unexpected Claude call"), {
    flag: "off",
  });
  await dispatchAiLabScheduledBrandPost(f.args);
  assert.deepEqual(f.events, [
    "claim",
    "OpenAI",
    "start X",
    "X",
    "settle",
    "complete",
  ]);
  assert.deepEqual(f.env.reads, ["AI_LAB_CLAUDE_TWO_STAGE"]);
  assert.deepEqual(f.payloads, [{ text: ORIGINAL, pollOptions: undefined }]);
});

test("unchanged keep cannot fall through to the X send boundary", async () => {
  const f = fixture((_call, index) =>
    providerResponse(
      index
        ? { decision: "keep", text: ORIGINAL, edits: [] }
        : { text: ORIGINAL },
    )
  );
  await assert.rejects(
    dispatchAiLabScheduledBrandPost(f.args),
    /VOICE_REWRITE_REVIEW_REQUIRED/,
  );
  assert.equal(f.recorder.calls.length, 2);
  assert.deepEqual(f.events, [
    "claim",
    "Claude:0",
    "Claude:1",
    "release:PRE_X_CONTENT_REJECTED",
  ]);
  assert.deepEqual(f.payloads, []);
});

test("a whitespace-only edit cannot fall through to the X send boundary", async () => {
  const original = "通知の順番を確認しました。次は予定です。";
  const edited = "通知の順番を確認しました。\n次は予定です。";
  const f = fixture((call, index) =>
    providerResponse(
      index ? editedReply(call, edited, [["", "\n"]]) : { text: original },
    )
  );
  await assert.rejects(
    dispatchAiLabScheduledBrandPost(f.args),
    /VOICE_REWRITE_REVIEW_REQUIRED/,
  );
  assert.deepEqual(f.events, [
    "claim",
    "Claude:0",
    "Claude:1",
    "release:PRE_X_CONTENT_REJECTED",
  ]);
  assert.deepEqual(f.payloads, []);
});

test("the saved synthetic Opus draft can be repaired with substantive candidates", async () => {
  // Exact nonsecret synthetic first draft from the authorized preview.
  const original = [
    "開発メモの見出しって、書いた直後は長いほうが親切に見える。「ログイン画面でボタンを押しても反応しない件の原因と対応について」みたいに。",
    "でも後から探すときに目で拾えるのは、たぶん最初の数文字くらい。一覧にずらっと並ぶと、長い見出しほど似たような文に見えて、結局ひとつずつ開くことになりがちだと思う。",
    "「ログイン：ボタン無反応」くらいまで削ると、画面名や機能名が頭に揃うので、流し見でも引っかかりやすい。詳しい経緯は本文に書けばいい。",
    "ただ短くしすぎて「修正」「バグ対応」だけになると、それはそれで何の話かわからない。どこの、何が、くらいは残す。そのあたりの線引きは、後から自分が検索しそうな言葉を入れておくかどうかで決まる気がする。",
    "#個人開発",
  ].join("\n\n");
  assert.equal(original.length, 326);
  const selections = [
    ["見えて、結局", "見える。で、結局"],
    ["揃うので、", "揃う。だから"],
    ["詳しい経緯は本文に", "細かい話は本文に"],
    ["どこの、何が、", "場所と内容"],
    ["そのあたりの線引きは、", "その目安は"],
    [
      "言葉を入れておくかどうかで決まる気がする。",
      "言葉が入ってるかどうかだと思う。",
    ],
  ] as const;
  const edited = selections.reduce(
    (s, [from, to]) => s.replace(from, to),
    original,
  );
  const f = fixture((call, index) =>
    providerResponse(
      index ? editedReply(call, edited, selections) : { text: original },
    )
  );
  await dispatchAiLabScheduledBrandPost(f.args);
  assert.deepEqual(f.payloads, [{ text: edited, pollOptions: undefined }]);
  const { system } = f.recorder.calls[0].body as { system: string };
  assert.match(system, /文字数の目安を埋めるために段落を足さない/u);
  assert.match(system, /読点は一文に最大1個/u);
  const rewrite = f.recorder.calls[1].body as { system: string };
  assert.match(rewrite.system, /読点と改行だけを直した案では送信できません/u);
});

test("emoji decoration alone holds before X", async () => {
  const original = "通知を見つけてほっとしました。";
  const edited = "通知を見つけてほっとしました😊";
  const f = fixture((call, index) =>
    providerResponse(
      index
        ? editedReply(call, edited, [["ほっとしました。", "ほっとしました😊"]])
        : { text: original },
    )
  );
  await assert.rejects(
    dispatchAiLabScheduledBrandPost(f.args),
    /VOICE_REWRITE_REVIEW_REQUIRED/,
  );
  assert.deepEqual(f.events, [
    "claim",
    "Claude:0",
    "Claude:1",
    "release:PRE_X_CONTENT_REJECTED",
  ]);
  assert.deepEqual(f.payloads, []);
});

test("original content and fingerprint guards run before rewrite", async () => {
  const rejected = fixture(() =>
    providerResponse({ text: "個人開発は、通知が多いです。" })
  );
  await assert.rejects(
    dispatchAiLabScheduledBrandPost(rejected.args),
    /CONTENT_DIVERSITY_REJECTED/,
  );
  assert.deepEqual(rejected.events, [
    "claim",
    "Claude:0",
    "Claude:1",
    "Claude:2",
    "release:PRE_X_CONTENT_REJECTED",
  ]);
  for (const [text, calls] of [[ORIGINAL, 1], [EDITED, 2]] as const) {
    const f = fixture(normalResponse);
    const normalizedTextSha256 = await fingerprintText(text);
    f.args.loadRecentFingerprints = () =>
      Promise.resolve([{
        brandId: "kabumori",
        normalizedTextSha256,
        publishedAt: new Date().toISOString(),
      }]);
    await assert.rejects(
      dispatchAiLabScheduledBrandPost(f.args),
      /CROSS_BRAND_DUPLICATE/,
    );
    assert.equal(f.recorder.calls.length, calls);
    assert.equal(f.events.at(-1), "release:PRE_X_FINGERPRINT_BLOCKED");
    assert.deepEqual(f.payloads, []);
  }
});

for (
  const [name, response, reason] of [
    [
      "changed fact",
      (call) =>
        providerResponse(editedReply(call, EDITED.replace("2台", "3台"))),
      /VOICE_REWRITE_REJECTED/,
    ],
    [
      "invented achievement",
      (call) =>
        providerResponse(
          editedReply(call, EDITED + "\n今日は100人に使ってもらえました。"),
        ),
      /VOICE_REWRITE_REJECTED/,
    ],
    [
      "removed URL",
      (call) =>
        providerResponse(
          editedReply(call, EDITED.replace("https://example.test/notes\n", "")),
        ),
      /VOICE_REWRITE_REJECTED/,
    ],
    [
      "removed tag",
      (call) =>
        providerResponse(editedReply(call, EDITED.replace("#個人開発", ""))),
      /VOICE_REWRITE_REJECTED/,
    ],
    [
      "length violation",
      (call) => providerResponse(editedReply(call, "あ".repeat(121))),
      /VOICE_REWRITE_REJECTED/,
    ],
    [
      "changed poll options",
      (call) =>
        providerResponse({
          ...editedReply(call, EDITED),
          poll_options: ["別の選択肢", "履歴"],
        }),
      /AI_LAB_OPUS_GENERATION_FAILED/,
    ],
    ["HTTP 429", () =>
      jsonResponse(429, {
        error: { type: "rate_limit_error", message: "fixture" },
      }), /AI_LAB_OPUS_GENERATION_FAILED/],
    ["refusal", () =>
      jsonResponse(
        200,
        anthropicBody({ text: EDITED }, { stopReason: "refusal" }),
      ), /AI_LAB_OPUS_GENERATION_FAILED/],
    [
      "malformed",
      () => jsonResponse(200, anthropicBody(null, { text: "invalid JSON" })),
      /AI_LAB_OPUS_GENERATION_FAILED/,
    ],
    ["unknown response", () => {
      throw new TypeError("fixture disconnect");
    }, /AI_LAB_OPUS_GENERATION_FAILED/],
    [
      "timeout",
      (_call, _index, init) => hangUntilAborted(init),
      /AI_LAB_OPUS_GENERATION_FAILED:TIMEOUT/,
    ],
  ] satisfies [string, Responder, RegExp][]
) {
  test(`rewrite ${name} releases before X with no Claude retry or fallback`, async () => {
    const f = fixture(
      (call, index, init) =>
        index === 0
          ? providerResponse({ text: ORIGINAL, poll_options: options })
          : response(call, index, init),
      { rotation: 8 },
    );
    await assert.rejects(dispatchAiLabScheduledBrandPost(f.args), reason);
    assert.deepEqual(f.events.slice(0, -1), ["claim", "Claude:0", "Claude:1"]);
    assert.match(f.events.at(-1) ?? "", /^release:PRE_X_/u);
    assert.deepEqual(f.payloads, []);
  });
}

test("third original attempt still leaves exactly one rewrite; additional calls are blocked", async () => {
  const f = fixture((call, index) =>
    providerResponse(
      index === 3
        ? editedReply(call, EDITED)
        : { text: index < 2 ? "個人開発は、通知が多いです。" : ORIGINAL },
    )
  );
  await dispatchAiLabScheduledBrandPost(f.args);
  assert.equal(f.recorder.calls.length, 4);
  assert.equal(f.payloads.length, 1);
  await assert.rejects(
    f.args.generate!({
      context: f.args.context,
      postType: "brand_post",
      openAiApiKey: "fixture",
      topicSeed: "通知",
      retryViolations: [],
    }),
    /BUDGET_DENIED/,
  );
  assert.equal(f.recorder.calls.length, 4);
});

for (
  const [label, mutate] of [
    ["date", (text: string) => text.replace("11月12日", "11月13日")],
    ["named product", (text: string) => text.replace("POSTONA", "かぶモリ")],
    ["quotation", (text: string) => text.replace("「確認中」", "確認済み")],
    ["mention", (text: string) => text.replace(" @sample_dev", "")],
    [
      "negation",
      (text: string) =>
        text.replace("見出しが残りました", "見出しは残りませんでした"),
    ],
    [
      "unrelated topic",
      (_text: string) => "今日は株式の取引について解説します。",
    ],
  ] as const
) {
  test(
    "rewrite refuses an unauthorized change to " + label +
      " with otherwise valid edit IDs",
    async () => {
      const f = fixture((call, index) =>
        providerResponse(
          index
            ? editedReply(call, mutate(longEdited), structuralExamples[0][4])
            : { text: longDraft },
        )
      );
      await assert.rejects(
        dispatchAiLabScheduledBrandPost(f.args),
        /VOICE_REWRITE_REJECTED/,
      );
      assert.deepEqual(f.events, [
        "claim",
        "Claude:0",
        "Claude:1",
        "release:PRE_X_CONTENT_REJECTED",
      ]);
      assert.deepEqual(f.payloads, []);
    },
  );
}

test("manual review holds the post and never falls through to the original", async () => {
  const f = fixture((_call, index) =>
    providerResponse(
      index
        ? { decision: "review", text: ORIGINAL, edits: [] }
        : { text: ORIGINAL },
    )
  );
  await assert.rejects(
    dispatchAiLabScheduledBrandPost(f.args),
    /VOICE_REWRITE_REVIEW_REQUIRED/,
  );
  assert.deepEqual(f.events, [
    "claim",
    "Claude:0",
    "Claude:1",
    "release:PRE_X_CONTENT_REJECTED",
  ]);
  assert.deepEqual(f.payloads, []);
});

test("duplicate or out-of-order edit IDs cannot be applied or counted as keep", () => {
  const { request, validate } = prepareAiLabVoiceRewrite({
    brandId: "ai_salaryman_lab",
    postType: "brand_post",
    text: longDraft,
  });
  const candidates =
    (JSON.parse(request.input) as { candidates: Candidate[] }).candidates;
  const first = { id: candidates[0].id, option: 0 };
  const second = { id: candidates[1].id, option: 0 };
  for (
    const edits of [[first, first], [second, first], [{ id: 999, option: 0 }]]
  ) {
    assert.throws(
      () => validate({ decision: "edited", text: longEdited, edits }),
      /VOICE_REWRITE_REJECTED/,
    );
  }
  assert.throws(
    () => validate({ decision: "keep", text: longDraft, edits: [first] }),
    /VOICE_REWRITE_REJECTED/,
  );
});

test("a mechanically allowed reflow still goes through the final engagement line guard", async () => {
  const original =
    "画面を見ました。通知を読みました。履歴を開きました。予定も見ました。どれを選びますか？";
  const text = original.replaceAll("。", "。\n\n").replace(
    "どれを選びますか？",
    "どれを選びます？",
  );
  const f = fixture((call, index) => {
    if (!index) {
      return providerResponse({ text: original, poll_options: options });
    }
    const { candidates } = rewriteInput(call);
    const edits = candidates.filter(({ from }) => from === "").map((
      { id, options },
    ) => ({
      id,
      option: options.indexOf("\n\n"),
    }));
    assert.equal(edits.length, 4);
    edits.push(
      ...editedReply(call, text, [["どれを選びますか？", "どれを選びます？"]])
        .edits,
    );
    return providerResponse({ decision: "edited", text, edits });
  }, { rotation: 8 });
  await assert.rejects(
    dispatchAiLabScheduledBrandPost(f.args),
    /AI_LAB_ENGAGEMENT_INVALID/,
  );
  assert.deepEqual(f.events, [
    "claim",
    "Claude:0",
    "Claude:1",
    "release:PRE_X_FAILED",
  ]);
  assert.deepEqual(f.payloads, []);
});

test("rewrite stage has its own one-call limit even with remaining shared capacity", async () => {
  const f = fixture(normalResponse);
  await dispatchAiLabScheduledBrandPost(f.args);
  await assert.rejects(
    f.rewriteVoice!(
      prepareAiLabVoiceRewrite({
        brandId: "ai_salaryman_lab",
        postType: "brand_post",
        text: ORIGINAL,
      }).request,
    ),
    /BUDGET_DENIED/,
  );
  assert.equal(f.recorder.calls.length, 2);
});

test("other brand, missing dedicated key and oversized estimated spend never send", async () => {
  const f = fixture(() => assert.fail("unexpected Claude call"));
  const request = {
    brandId: "ai_salaryman_lab",
    postType: "brand_post",
    instructions: "fixture",
    input: "あ".repeat(50000),
    maxOutputTokens: 2000,
  };
  await assert.rejects(
    f.textProvider!({ ...request, brandId: "kabumori" }),
    /SCOPE_MISMATCH/,
  );
  await assert.rejects(f.textProvider!(request), /BUDGET_DENIED/);
  assert.equal(f.recorder.calls.length, 0);
  const missing = fixture(() => assert.fail("unexpected Claude call"), {
    key: "",
  });
  await assert.rejects(
    dispatchAiLabScheduledBrandPost(missing.args),
    /KEY_MISSING/,
  );
  assert.deepEqual(missing.env.reads, [
    "AI_LAB_CLAUDE_TWO_STAGE",
    "AI_LAB_TEXT_API_KEY",
  ]);
  assert.deepEqual(missing.payloads, []);
});

test("ambiguous X write keeps the claim and does not replay either Claude stage or X", async () => {
  const f = fixture(
    normalResponse,
    {
      publishError: new TypeError("fixture X disconnect"),
    },
  );
  await assert.rejects(
    dispatchAiLabScheduledBrandPost(f.args),
    /fixture X disconnect/,
  );
  await assert.rejects(
    dispatchAiLabScheduledBrandPost(f.args),
    /topic already started/,
  );
  assert.deepEqual(f.events, [
    "claim",
    "Claude:0",
    "Claude:1",
    "start X",
    "X",
    "ambiguous X",
  ]);
  assert.equal(f.payloads.length, 1);
  assert.deepEqual(f.completedFingerprints, []);
});
