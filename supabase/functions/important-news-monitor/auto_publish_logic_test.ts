import assert from "node:assert/strict";
import test from "node:test";
import {
  AUTO_PUBLISH_DISABLED_REASON,
  executeWhenAutoPublishEnabled,
} from "./auto_publish_logic.ts";
import {
  checkPublishCandidate,
  publishImportantNewsCandidate,
  type PublishCandidate,
  type PublishRepository,
} from "./publish_logic.ts";

const sourceUrl = "https://www.release.tdnet.info/inbs/example.pdf";

function candidate(): PublishCandidate {
  return {
    id: "candidate-1",
    importance: "important",
    status: "ready_for_publish",
    generatedText: `【速報】重要ニュース本文です。\n\n出典: ${sourceUrl}`,
    generationFactStatus: "passed",
    generationVoiceStatus: "passed",
    sourceUrl,
    xPostId: null,
    publishedAt: null,
    publishAttempts: 0,
  };
}

function repository(initial: PublishCandidate, latestPublishedAt: string | null = null) {
  let claimCalls = 0;
  const value: PublishRepository & { state: PublishCandidate; claimCalls(): number } = {
    state: { ...initial },
    claimCalls: () => claimCalls,
    async read(id) {
      return id === this.state.id ? { ...this.state } : null;
    },
    async latestPublishedAt() {
      return latestPublishedAt;
    },
    async claim(id) {
      claimCalls += 1;
      if (id !== this.state.id || !checkPublishCandidate(this.state).passed) return null;
      this.state = { ...this.state, status: "publishing", publishAttempts: this.state.publishAttempts + 1 };
      return { ...this.state };
    },
    async markPublished(id, xPostId) {
      assert.equal(id, this.state.id);
      this.state = { ...this.state, status: "published", xPostId, publishedAt: new Date().toISOString() };
    },
    async markFailed(id) {
      assert.equal(id, this.state.id);
      this.state = { ...this.state, status: "publish_failed" };
    },
  };
  return value;
}

test("auto_publish=false skips before candidate claim or X publication", async () => {
  const store = repository(candidate());
  let operationCalls = 0;
  let xCalls = 0;
  const result = await executeWhenAutoPublishEnabled(false, async () => {
    operationCalls += 1;
    return publishImportantNewsCandidate("candidate-1", false, store, async () => {
      xCalls += 1;
      return { id: "unexpected", httpStatus: 201, refreshExecuted: false };
    });
  });

  assert.equal(result.executed, false);
  assert.equal(result.blockReason, AUTO_PUBLISH_DISABLED_REASON);
  assert.equal(operationCalls, 0);
  assert.equal(store.claimCalls(), 0);
  assert.equal(store.state.publishAttempts, 0);
  assert.equal(store.state.status, "ready_for_publish");
  assert.equal(xCalls, 0);
});

test("auto_publish=true enters the existing publish flow", async () => {
  const store = repository(candidate());
  const result = await executeWhenAutoPublishEnabled(true, () =>
    publishImportantNewsCandidate("candidate-1", false, store, async () => ({
      id: "x-enabled", httpStatus: 201, refreshExecuted: false,
    }))
  );

  assert.equal(result.executed, true);
  assert.equal(result.result?.published, true);
  assert.equal(store.state.status, "published");
  assert.equal(store.state.publishAttempts, 1);
});

test("auto_publish=true preserves overnight hold", async () => {
  const store = repository(candidate());
  const result = await executeWhenAutoPublishEnabled(true, () =>
    publishImportantNewsCandidate(
      "candidate-1",
      false,
      store,
      async () => ({ id: "unexpected", httpStatus: 201, refreshExecuted: false }),
      new Date("2026-09-01T17:00:00Z"),
    )
  );

  assert.equal(result.result?.blockReason, "NEWS_PUBLISH_OVERNIGHT_HOLD");
  assert.equal(store.claimCalls(), 0);
  assert.equal(store.state.status, "ready_for_publish");
});

test("auto_publish=true preserves rate control", async () => {
  const store = repository(candidate(), "2026-08-31T06:15:00Z");
  const result = await executeWhenAutoPublishEnabled(true, () =>
    publishImportantNewsCandidate(
      "candidate-1",
      false,
      store,
      async () => ({ id: "unexpected", httpStatus: 201, refreshExecuted: false }),
      new Date("2026-08-31T06:20:00Z"),
    )
  );

  assert.equal(result.result?.blockReason, "NEWS_PUBLISH_RATE_LIMITED");
  assert.equal(store.claimCalls(), 0);
  assert.equal(store.state.status, "ready_for_publish");
});
