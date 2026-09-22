import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../../..", import.meta.url);
async function source(path: string): Promise<string> {
  return await readFile(new URL(path, root), "utf8");
}

test("Phase 15 conversation boundary is confirmation-gated and cannot mutate publishing", async () => {
  const conversation = await source("apps/social-mobile/src/domain/content-settings-conversation.ts");
  assert.match(conversation, /requiresConfirmation:\s*true/iu);
  assert.match(conversation, /publishPermissionChanged:\s*false/iu);
  assert.match(conversation, /validateConversationalAssistantResult/iu);
  assert.match(conversation, /applyConfirmedConversationProposal/iu);
  assert.match(conversation, /source:\s*result\.provenance/iu);
  assert.doesNotMatch(conversation, /api\.x\.com|\/2\/tweets|scheduled_posts/iu);
});

test("Phase 15 history candidate has explicit consent, ownership, account, and bounded-fetch guards", async () => {
  const history = await source("apps/social-mobile/src/domain/past-post-learning.ts");
  assert.match(history, /MAX_HISTORY_POSTS\s*=\s*50/iu);
  assert.match(history, /MAX_HISTORY_PAGES\s*=\s*2/iu);
  assert.match(history, /HISTORY_CONSENT_REQUIRED/iu);
  assert.match(history, /HISTORY_WORKSPACE_FORBIDDEN/iu);
  assert.match(history, /HISTORY_ACCOUNT_NOT_CONFIGURED/iu);
  assert.match(history, /identity_verified/iu);
  assert.match(history, /isReply|isRetweet/iu);
  assert.match(history, /raw post text is not returned or persisted/iu);
});

test("Phase 15 mobile UI keeps history behind a second confirmation and has no X/publish path", async () => {
  const consult = await source("apps/social-mobile/src/app/(tabs)/consult.tsx");
  assert.match(consult, /これで覚えて/iu);
  assert.match(consult, /過去の投稿を読み込む前に確認/iu);
  assert.match(consult, /次の確認画面で明示同意後/iu);
  assert.match(consult, /自動投稿ON・X投稿・投稿予定作成は行いません/iu);
  assert.doesNotMatch(consult, /api\.x\.com|\/2\/users|\/2\/tweets|publish_enabled\s*[:=]/iu);
});

test("Phase 15 repository maps dedicated persona columns and strips duplicate metadata", async () => {
  const repository = await source("apps/social-mobile/src/data/content-settings-repository.ts");
  assert.match(repository, /persona_provenance/iu);
  assert.match(repository, /persona_confirmed/iu);
  assert.match(repository, /persona_last_analyzed_at/iu);
  assert.match(repository, /persona_last_analyzed_count/iu);
  assert.match(repository, /delete \(profile as/iu);
  assert.match(repository, /saveConfirmedProposal/iu);
});

test("Phase 15 preview reads canonical persona columns instead of profile metadata", async () => {
  const logic = await source("supabase/functions/social-mobile-brand-dry-run/logic.ts");
  assert.match(logic, /materializeSocialMobilePersonaProfile/iu);
  assert.match(logic, /persona_provenance,persona_confirmed,persona_last_analyzed_at,persona_last_analyzed_count/iu);
  assert.doesNotMatch(logic, /isSocialMobilePersonaProfile\(row\.persona_profile\)/iu);
});

test("Phase 15 shared persona mapping preserves confirmed-only preview guidance", async () => {
  const settings = await source("supabase/functions/_shared/brand/social_mobile_content_settings.ts");
  assert.match(settings, /materializeSocialMobilePersonaProfile/iu);
  assert.match(settings, /if \(persona && persona\.confirmed\)/iu);
  assert.match(settings, /source: source/iu);
  assert.match(settings, /confirmed,/iu);
});
