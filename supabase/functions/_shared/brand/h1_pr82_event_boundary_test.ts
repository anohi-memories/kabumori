// H1 safety regressions. Intentionally RED on PR82: no real DB/model/X calls.
// Each assertion describes the required safety contract, not observed unsafe behavior.
// Async stubs intentionally implement production Promise-returning dependency contracts.
// deno-lint-ignore-file require-await
import assert from "node:assert/strict";
import { resolveBrandContext } from "./brand_context.ts";
import {
  type AiLabTopicUsage,
  diaryEventsWithKeys,
  EVERGREEN_TOPIC_SEEDS,
  selectAiLabRotatingTopicSeed,
} from "./ai_lab_dev_diary_context.ts";
import {
  AiLabConfirmedPostCompletionError,
  dispatchAiLabScheduledBrandPost,
} from "./ai_lab_scheduled_brand_post.ts";
import {
  fingerprintText,
  type PublishedFingerprint,
} from "./cross_brand_dedupe.ts";
import { recordAiLabTopicUsage } from "./ai_lab_brand_post_store.ts";

const now = new Date("2026-10-01T03:00:00Z");
const event =
  "\n## 2026-09-30\nchanged: X接続画面のアカウント重複を確認した\ndifficulty: 前回のアカウントが残っていた\ndecided: 本番影響を避けて停止した\n";
const inserted = "\n## 2026-09-30\nchanged: 通知設定画面の保存ボタンを直した\n";
const texts = [
  "Xの接続画面で、前回のアカウントが残る問題を見つけた。 #個人開発",
  "接続先のアカウントが重複していたので、設定画面の確認を止めた。 #個人開発",
];
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
const select = (
  markdown: string,
  usage: AiLabTopicUsage[] | null,
  rotationIndex = 0,
) =>
  selectAiLabRotatingTopicSeed({
    markdown,
    now,
    recentUsage: usage,
    rotationIndex,
  });
function dispatch(
  index: number,
  overrides: Partial<Parameters<typeof dispatchAiLabScheduledBrandPost>[0]> =
    {},
) {
  return dispatchAiLabScheduledBrandPost({
    context,
    postType: "brand_post",
    scheduledPostId: `fixture-${index}`,
    openAiApiKey: "fixture-only",
    generate: async () => ({
      brandId: "ai_salaryman_lab",
      postType: "brand_post",
      text: texts[index % 2],
      model: "fixture",
      inputTokens: 1,
      outputTokens: 1,
      apiCostUsd: 0,
      characterCount: Array.from(texts[index % 2]).length,
    }),
    loadRecentFingerprints: async () => [],
    publishText: async () => ({ data: { id: String(index + 1) } }),
    recordTopicUsage: async () => true,
    completePublishedPost: async () => ({ fingerprintPersisted: true }),
    ...overrides,
  });
}

Deno.test("H1 REQUIRED: concurrent different schedules cannot both publish the same event", async () => {
  const selections = [select(event, [], 0), select(event, [], 1)];
  assert.equal(selections[0].eventKey, selections[1].eventKey);
  let reads = 0, publishes = 0;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const outcomes = await Promise.allSettled([0, 1].map((i) =>
    dispatch(i, {
      topicSeed: selections[i].topic,
      loadRecentFingerprints: async () => {
        if (++reads === 2) release();
        await barrier;
        return [];
      },
      publishText: async () => {
        publishes++;
        return { data: { id: String(i + 1) } };
      },
    })
  ));
  assert.equal(
    outcomes.filter((r) => r.status === "fulfilled").length,
    2,
    "both drafts pass existing guards",
  );
  assert.ok(publishes <= 1, `same event reached X ${publishes} times`);
});

Deno.test("H1 REQUIRED: usage write failure plus successful completion cannot republish on next schedule", async () => {
  const history: AiLabTopicUsage[] = [];
  const fingerprints: PublishedFingerprint[] = [];
  let publishes = 0;
  const first = select(event, history, 0);
  const result = await dispatch(0, {
    topicSeed: first.topic,
    recordTopicUsage: async () => false,
    publishText: async () => {
      publishes++;
      return { data: { id: "1" } };
    },
    completePublishedPost: async ({ normalizedTextSha256 }) => {
      fingerprints.push({
        brandId: "ai_salaryman_lab",
        normalizedTextSha256,
        publishedAt: now.toISOString(),
      });
      return { fingerprintPersisted: true };
    },
  });
  assert.equal(result.topicUsagePersisted, false);
  assert.equal(fingerprints.length, 1, "completion/fingerprint succeeded");
  const next = select(event, history, 1); // successful history GET returns the still-empty table
  if (next.eventKey === first.eventKey) {
    await dispatch(1, {
      topicSeed: next.topic,
      loadRecentFingerprints: async () => fingerprints,
      publishText: async () => {
        publishes++;
        return { data: { id: "2" } };
      },
    });
  }
  assert.equal(
    publishes,
    1,
    "same event was republished despite completed first schedule",
  );
});

Deno.test("H1 REQUIRED: X side effect then lost response leaves durable event protection", async () => {
  const first = select(event, []);
  let publishes = 0;
  await assert.rejects(() =>
    dispatch(0, {
      topicSeed: first.topic,
      publishText: async () => {
        publishes++;
        throw new Error("response lost after provider accepted");
      },
    })
  );
  const next = select(event, [], 1);
  if (next.eventKey === first.eventKey) {
    await dispatch(1, {
      topicSeed: next.topic,
      publishText: async () => {
        publishes++;
        return { data: { id: "2" } };
      },
    });
  }
  assert.equal(
    publishes,
    1,
    "ambiguous X outcome allows next slot to republish",
  );
});

Deno.test("H1 control: persisted usage protects event despite completion failure", async () => {
  const history: AiLabTopicUsage[] = [];
  const first = select(event, history);
  await assert.rejects(() =>
    dispatch(0, {
      topicSeed: first.topic,
      recordTopicUsage: async () => {
        history.push({
          eventKey: first.eventKey,
          publishedAt: now.toISOString(),
        });
        return true;
      },
      completePublishedPost: async () => {
        throw new Error("lost completion response");
      },
    }), AiLabConfirmedPostCompletionError);
  assert.notEqual(select(event, history).eventKey, first.eventKey);
});

Deno.test("H1 REQUIRED: confirmed X success before usage commit already protects the event", async () => {
  const first = select(event, []);
  let publishes = 0;
  let entered!: () => void;
  let resume!: () => void;
  const beforeUsage = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const paused = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const running = dispatch(0, {
    topicSeed: first.topic,
    publishText: async () => {
      publishes++;
      return { data: { id: "1" } };
    },
    recordTopicUsage: async () => {
      entered();
      await paused;
      return false;
    },
  });
  await beforeUsage; // confirmed provider ID, but no durable usage yet; crash here preserves nothing
  const next = select(event, [], 1);
  try {
    if (next.eventKey === first.eventKey) {
      await dispatch(1, {
        topicSeed: next.topic,
        publishText: async () => {
          publishes++;
          return { data: { id: "2" } };
        },
      });
    }
  } finally {
    resume();
    await running;
  }
  assert.equal(
    publishes,
    1,
    "next schedule republishes inside confirmed-X/before-usage crash window",
  );
});

Deno.test("H1 REQUIRED: inserting same-date event cannot rename/revive a used event", () => {
  const oldKey = diaryEventsWithKeys(event)[0].eventKey;
  const next = select(inserted + event, [{
    eventKey: oldKey,
    publishedAt: now.toISOString(),
  }]);
  assert.ok(
    !next.topic.includes("X接続画面のアカウント重複"),
    "used event renamed from ordinal 1 to 2 and selected again",
  );
});

Deno.test("H1 REQUIRED: reordering same-date events cannot rename/revive a used event", () => {
  const oldKey = diaryEventsWithKeys(event + inserted)[0].eventKey;
  const next = select(inserted + event, [{
    eventKey: oldKey,
    publishedAt: now.toISOString(),
  }]);
  assert.ok(!next.topic.includes("X接続画面のアカウント重複"));
});

Deno.test("H1 REQUIRED: removal of changed field before parsing cannot rename a later event", () => {
  const oldKey = diaryEventsWithKeys(inserted + event)[1].eventKey;
  const malformed = inserted.replace(
    "changed: 通知設定画面の保存ボタンを直した",
    "difficulty: 保存ボタンがなかった",
  );
  const next = select(malformed + event, [{
    eventKey: oldKey,
    publishedAt: now.toISOString(),
  }]);
  assert.ok(!next.topic.includes("X接続画面のアカウント重複"));
});

Deno.test("H1 REQUIRED: ignored conflicting scheduled ID cannot report new event persisted", async () => {
  const old = { event_key: "diary-2026-09-30-1", x_post_id: "1" };
  const ok = await recordAiLabTopicUsage({
    supabaseUrl: "https://fixture.invalid",
    serviceRoleKey: "fixture-only",
    scheduledPostId: "00000000-0000-0000-0000-000000000001",
    eventKey: "diary-2026-10-01-1",
    unitKey: "diary-2026-10-01-1#changed",
    xPostId: "2",
    fetchImpl: (async () =>
      new Response(null, { status: 201 })) as typeof fetch,
  });
  assert.equal(
    old.event_key,
    "diary-2026-09-30-1",
    "PostgREST ignore-duplicates leaves the old row unchanged",
  );
  assert.equal(
    ok,
    false,
    "HTTP success alone falsely acknowledges a different event/X identity",
  );
});

Deno.test("H1 REQUIRED: exhausted evergreen pool must not override 72-hour cooldown", () => {
  const usage = EVERGREEN_TOPIC_SEEDS.map((_, i) => ({
    eventKey: `evergreen-${i}`,
    publishedAt: new Date(now.getTime() - (i + 1) * 3_600_000).toISOString(),
  }));
  const selected = select("", usage);
  assert.ok(
    !usage.some((u) => u.eventKey === selected.eventKey),
    "all seeds still within 72 hours; safely skip instead of selecting one",
  );
});

Deno.test("H1 control: different paraphrases have different fingerprints", async () => {
  assert.notEqual(
    await fingerprintText(texts[0]),
    await fingerprintText(texts[1]),
  );
});
