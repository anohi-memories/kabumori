import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../../..", import.meta.url);
async function source(path: string): Promise<string> {
  return await readFile(new URL(path, root), "utf8");
}

test("Phase 14 mobile settings UI does not expose publish controls or X history calls", async () => {
  const settings = await source("apps/social-mobile/src/app/(tabs)/settings.tsx");
  const consult = await source("apps/social-mobile/src/app/(tabs)/consult.tsx");
  const conversation = await source("apps/social-mobile/src/domain/content-settings-conversation.ts");
  for (const text of [settings, consult, conversation]) {
    assert.doesNotMatch(text, /publish_enabled\s*[:=]|livePublishingEnabled\s*[:=]\s*true/iu);
    assert.doesNotMatch(text, /api\.x\.com|\/2\/users|\/2\/tweets/iu);
  }
  const repository = await source("apps/social-mobile/src/data/content-settings-repository.ts");
  assert.doesNotMatch(repository, /error\.message/iu);
  assert.match(repository, /設定を保存できません/iu);
  assert.match(consult, /過去の自分の投稿を読んで/iu);
  assert.match(conversation, /explicitConsent/iu);
});
