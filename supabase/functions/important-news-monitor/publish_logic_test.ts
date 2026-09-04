import assert from "node:assert/strict";
import test from "node:test";
import {
  checkPublishCandidate,
  publishImportantNewsCandidate,
  type PublishCandidate,
  type PublishRepository,
  type XPublisher,
} from "./publish_logic.ts";

const sourceUrl = "https://www.release.tdnet.info/inbs/example.pdf";
const daytimeNow = new Date("2026-09-01T00:00:00Z");
// Auto-publish is scoped to most_important only for now, so that is the default fixture importance —
// "important" candidates are covered by their own dedicated tests below (6+7: rejected up front).
const candidate = (overrides: Partial<PublishCandidate> = {}): PublishCandidate => ({
  id: "candidate-1",
  importance: "most_important",
  status: "ready_for_publish",
  generatedText: `【重大速報】重要ニュース本文です。\n\n出典: ${sourceUrl}`,
  generationFactStatus: "passed",
  generationVoiceStatus: "passed",
  sourceUrl,
  xPostId: null,
  publishedAt: null,
  publishAttempts: 0,
  ...overrides,
});

function memoryRepository(
  initial: PublishCandidate,
  latestPublishedAt: string | null = null,
): PublishRepository & { state: PublishCandidate } {
  const repository = {
    state: { ...initial },
    async read(id: string) {
      return id === this.state.id ? { ...this.state } : null;
    },
    async latestPublishedAt() {
      return latestPublishedAt;
    },
    async claim(id: string) {
      if (id !== this.state.id || !checkPublishCandidate(this.state).passed) return null;
      this.state = {
        ...this.state,
        status: "publishing",
        publishAttempts: this.state.publishAttempts + 1,
      };
      return { ...this.state };
    },
    async markPublished(id: string, xPostId: string) {
      assert.equal(id, this.state.id);
      assert.equal(this.state.status, "publishing");
      this.state = { ...this.state, status: "published", xPostId, publishedAt: new Date().toISOString() };
    },
    async markFailed(id: string) {
      assert.equal(id, this.state.id);
      this.state = { ...this.state, status: "publish_failed" };
    },
  };
  return repository;
}

function runPublish(
  candidateId: string,
  dryRun: boolean,
  repository: PublishRepository,
  publisher: XPublisher,
  now = daytimeNow,
) {
  return publishImportantNewsCandidate(candidateId, dryRun, repository, publisher, now);
}

test("6: valid most_important candidate with required label is eligible to publish", () => {
  assert.equal(checkPublishCandidate(candidate()).passed, true);
});

test("importance and label mismatch is blocked before publish", () => {
  const check = checkPublishCandidate(candidate({
    generatedText: `【速報】重要ニュース本文です。\n\n出典: ${sourceUrl}`,
  }));
  assert.equal(check.passed, false);
  assert.equal(check.checks.labelMatchesImportance, false);
  assert.equal(check.blockReason, "NEWS_PUBLISH_BLOCKED:labelMatchesImportance");
});

// --- auto-publish scoped to most_important only (STEP 2-4) ------------------------------------------

test("2: an 'important' candidate — otherwise fully valid — is never eligible to auto-publish", () => {
  const check = checkPublishCandidate(candidate({
    importance: "important",
    generatedText: `【速報】重要ニュース本文です。\n\n出典: ${sourceUrl}`,
  }));
  assert.equal(check.passed, false);
  assert.equal(check.checks.importance, false);
  assert.equal(check.blockReason, "NEWS_PUBLISH_BLOCKED:importance");
});

test("1: a no_post candidate is never eligible to auto-publish", () => {
  const check = checkPublishCandidate(candidate({ importance: "no_post" }));
  assert.equal(check.passed, false);
  assert.equal(check.checks.importance, false);
});

test("6+7: an important candidate is rejected at the earliest gate, before rate control or overnight hold are ever evaluated", async () => {
  const repository = memoryRepository(candidate({
    importance: "important",
    generatedText: `【速報】重要ニュース本文です。\n\n出典: ${sourceUrl}`,
  }));
  let xCalls = 0;
  const result = await runPublish("candidate-1", false, repository, async () => {
    xCalls += 1;
    return { id: "unexpected", httpStatus: 201, refreshExecuted: false };
  });
  assert.equal(result.published, false);
  assert.equal(result.blockReason, "NEWS_PUBLISH_BLOCKED:importance");
  // Neither safety mechanism is even consulted — blocked before either runs.
  assert.equal(result.rateControl, null);
  assert.equal(result.overnightHold, null);
  assert.equal(repository.state.status, "ready_for_publish");
  assert.equal(repository.state.publishAttempts, 0);
  assert.equal(xCalls, 0);
});

test("Fact failure is blocked", () => {
  assert.equal(checkPublishCandidate(candidate({ generationFactStatus: "failed" })).passed, false);
});

test("Voice failure is blocked", () => {
  assert.equal(checkPublishCandidate(candidate({ generationVoiceStatus: "failed" })).passed, false);
});

test("missing generated_text is blocked", () => {
  assert.equal(checkPublishCandidate(candidate({ generatedText: null })).passed, false);
});

test("missing source_url is blocked", () => {
  assert.equal(checkPublishCandidate(candidate({ sourceUrl: null })).passed, false);
});

test("already published candidate is blocked", () => {
  const check = checkPublishCandidate(candidate({
    status: "published", xPostId: "x-existing", publishedAt: "2026-08-31T07:00:00.000Z",
  }));
  assert.equal(check.passed, false);
  assert.equal(check.checks.notPublished, false);
  assert.equal(check.checks.xPostIdMissing, false);
});

test("concurrent calls claim and post the same candidate only once", async () => {
  const repository = memoryRepository(candidate());
  let xCalls = 0;
  const publisher = async () => {
    xCalls += 1;
    await Promise.resolve();
    return { id: "x-1", httpStatus: 201, refreshExecuted: false };
  };
  const [first, second] = await Promise.all([
    runPublish("candidate-1", false, repository, publisher),
    runPublish("candidate-1", false, repository, publisher),
  ]);
  assert.equal(xCalls, 1);
  assert.equal([first.published, second.published].filter(Boolean).length, 1);
});

test("X success alone transitions candidate to published", async () => {
  const repository = memoryRepository(candidate());
  const result = await runPublish("candidate-1", false, repository, async () => ({
    id: "x-2", httpStatus: 201, refreshExecuted: false,
  }));
  assert.equal(result.published, true);
  assert.equal(repository.state.status, "published");
  assert.equal(repository.state.xPostId, "x-2");
});

test("X failure never transitions candidate to published", async () => {
  const repository = memoryRepository(candidate());
  const result = await runPublish("candidate-1", false, repository, async () => {
    const error = new Error("X_REQUEST_FAILED:500") as Error & { httpStatus: number };
    error.httpStatus = 500;
    throw error;
  });
  assert.equal(result.published, false);
  assert.equal(repository.state.status, "publish_failed");
  assert.equal(repository.state.xPostId, null);
});

test("dry-run never calls X or changes the database", async () => {
  const repository = memoryRepository(candidate());
  let xCalls = 0;
  const result = await runPublish("candidate-1", true, repository, async () => {
    xCalls += 1;
    return { id: "unexpected", httpStatus: 201, refreshExecuted: false };
  });
  assert.equal(xCalls, 0);
  assert.equal(result.wouldPublish, true);
  assert.equal(result.published, false);
  assert.equal(repository.state.status, "ready_for_publish");
});

// important-tier rate-control/overnight-hold timing logic itself (5-minute-interval publishable
// windows, the 01:00-05:00 JST hold) is unaffected and still covered directly by
// rate_control_logic_test.ts / overnight_hold_logic_test.ts. Those code paths are simply unreachable
// from the live publish integration right now, per the "6+7" test above — important is rejected before
// either one is ever evaluated, so there is nothing further to exercise here at the integration level.

test("most_important bypasses rate control and can publish", async () => {
  const repository = memoryRepository(candidate({
    importance: "most_important",
    generatedText: `【重大速報】重要ニュース本文です。\n\n出典: ${sourceUrl}`,
  }), "2026-08-31T06:19:00Z");
  const result = await runPublish(
    "candidate-1",
    false,
    repository,
    async () => ({ id: "x-most", httpStatus: 201, refreshExecuted: false }),
    new Date("2026-08-31T06:20:00Z"),
  );
  assert.equal(result.published, true);
  assert.equal(result.rateControl?.bypassed, true);
});

test("duplicate or grouped member is blocked before rate control", async () => {
  const repository = memoryRepository(candidate({ status: "duplicate" }), "2026-08-31T06:00:00Z");
  let xCalls = 0;
  const result = await runPublish("candidate-1", false, repository, async () => {
    xCalls += 1;
    return { id: "unexpected", httpStatus: 201, refreshExecuted: false };
  });
  assert.equal(result.prePublishCheck.checks.status, false);
  assert.equal(result.rateControl, null);
  assert.equal(repository.state.status, "duplicate");
  assert.equal(xCalls, 0);
});

test("overnight window and post-release rate control still work correctly for most_important (always bypassed)", async () => {
  const overnight = await runPublish("candidate-1", false, memoryRepository(candidate()), async () => ({
    id: "x-1", httpStatus: 201, refreshExecuted: false,
  }), new Date("2026-09-01T17:00:00Z")); // 02:00 JST — inside the overnight window
  assert.equal(overnight.overnightHold?.bypassed, true);
  assert.equal(overnight.published, true);

  const postRelease = await runPublish("candidate-1", false, memoryRepository(candidate()), async () => ({
    id: "x-2", httpStatus: 201, refreshExecuted: false,
  }), new Date("2026-09-01T20:00:00Z")); // 05:00 JST — window just released
  assert.equal(postRelease.overnightHold?.held, false);
  assert.equal(postRelease.rateControl?.bypassed, true);
  assert.equal(postRelease.published, true);
});
