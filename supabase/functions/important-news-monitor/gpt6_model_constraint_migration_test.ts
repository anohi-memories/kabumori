import assert from "node:assert/strict";
import test from "node:test";

const migration = await Deno.readTextFile(
  new URL("../../migrations/20260923035652_allow_gpt6_important_news_model_metadata.sql", import.meta.url),
);

test("GPT-6 metadata migration extends only the two model ID checks", () => {
  assert.match(migration, /^begin;[\s\S]*commit;\s*$/i);
  assert.equal(
    [...migration.matchAll(/drop constraint\s+([a-z0-9_]+)/gi)].map((match) => match[1]).join(","),
    "important_news_candidates_judgement_model_check,important_news_candidates_generation_model_check",
  );
  assert.equal(
    [...migration.matchAll(/add constraint\s+([a-z0-9_]+)/gi)].map((match) => match[1]).join(","),
    "important_news_candidates_judgement_model_check,important_news_candidates_generation_model_check",
  );
  assert.equal((migration.match(/alter table public\.important_news_candidates/gi) ?? []).length, 1);
  assert.match(
    migration,
    /judgement_model is null\s+or judgement_model in \('gpt-5\.6-luna', 'gpt-5\.6-sol', 'gpt-6-luna', 'gpt-6-sol'\)/i,
  );
  assert.match(
    migration,
    /generation_model is null\s+or generation_model in \('gpt-5\.6-luna', 'gpt-5\.6-sol', 'gpt-6-luna', 'gpt-6-sol'\)/i,
  );
  assert.doesNotMatch(migration, /\b(create|drop|alter)\s+(function|policy|index|trigger|type|schema)\b/i);
  assert.doesNotMatch(migration, /\b(grant|revoke|insert|update|delete)\b/i);
});
