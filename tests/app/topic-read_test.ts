import assert from "node:assert/strict";
import test from "node:test";

import type { KeyValueStorage } from "../../src/lib/home-topic.ts";
import {
  addReadId,
  createTopicReadStore,
  isTopicRead,
  parseReadIds,
  TOPIC_READ_MAX,
  TOPIC_READ_STORAGE_KEY,
} from "../../src/lib/topic-read.ts";

const repoRoot = new URL("../../", import.meta.url);
const read = (path: string) => Deno.readTextFile(new URL(path, repoRoot));
const code = async (path: string) => (await read(path)).replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/^\s*\/\/.*$/gm, "");

function memoryStorage(initial: Record<string, string> = {}, options: { failSet?: boolean; failGet?: boolean } = {}) {
  const data = new Map(Object.entries(initial));
  const writes: Array<[string, string]> = [];
  const storage: KeyValueStorage = {
    getItem: async (key) => {
      if (options.failGet) throw new Error("read failed");
      return data.get(key) ?? null;
    },
    setItem: async (key, value) => {
      if (options.failSet) throw new Error("write failed");
      // A real store takes a tick; this lets overlapping writers interleave if they are not serialized.
      await Promise.resolve();
      data.set(key, value);
      writes.push([key, value]);
    },
  };
  return { data, writes, storage };
}

test("storage key and version are pinned, and are separate from the Home level preference", () => {
  assert.equal(TOPIC_READ_STORAGE_KEY, "kabumori:topic-read:v1");
  assert.notEqual(TOPIC_READ_STORAGE_KEY, "kabumori:topic-level:v1");
});

test("corrupt, missing or wrongly-shaped storage is safely 'nothing read yet'", () => {
  for (const raw of [null, undefined, "", "not json", "{", "{}", '"abc"', "42", "null", '{"ids":["a"]}']) {
    assert.deepEqual(parseReadIds(raw), [], String(raw));
  }
  // Wrong entries inside a valid array are dropped, the good ones kept.
  assert.deepEqual(parseReadIds('["a", 3, null, "", "  ", "b", {"x":1}, "a"]'), ["a", "b"]);
  assert.deepEqual(parseReadIds(`["${"x".repeat(101)}", "ok"]`), ["ok"], "over-long ids are ignored");
});

test("marking is deduplicated: the same topic twice is one identity (moved to newest)", () => {
  assert.deepEqual(addReadId([], "t1"), ["t1"]);
  assert.deepEqual(addReadId(["t1", "t2"], "t1"), ["t2", "t1"]);
  assert.deepEqual(addReadId(["t1"], "  t1  "), ["t1"], "ids are trimmed");
  assert.deepEqual(addReadId(["t1"], ""), ["t1"], "an empty id is never stored");
});

test("the data stays small and bounded: the newest ids win", () => {
  let ids: string[] = [];
  for (let index = 0; index < TOPIC_READ_MAX + 25; index += 1) ids = addReadId(ids, `t${index}`);
  assert.equal(ids.length, TOPIC_READ_MAX);
  assert.equal(ids[ids.length - 1], `t${TOPIC_READ_MAX + 24}`);
  assert.ok(!ids.includes("t0"), "the oldest fall off");
  assert.equal(parseReadIds(JSON.stringify(Array.from({ length: TOPIC_READ_MAX + 10 }, (_, i) => `t${i}`))).length, TOPIC_READ_MAX);
});

test("a learned/unread mapping: only ids in the set are learned", () => {
  const ids = new Set(["a", "b"]);
  assert.equal(isTopicRead(ids, "a"), true);
  assert.equal(isTopicRead(ids, "c"), false);
});

test("the store reads what it wrote, deduplicated, under the pinned key", async () => {
  const { storage, data } = memoryStorage();
  const store = createTopicReadStore(storage);
  assert.equal((await store.read()).size, 0);
  assert.equal(await store.mark("topic-1"), true);
  assert.equal(await store.mark("topic-2"), true);
  assert.equal(await store.mark("topic-1"), true);
  assert.deepEqual([...(await store.read())].sort(), ["topic-1", "topic-2"]);
  assert.deepEqual(JSON.parse(data.get(TOPIC_READ_STORAGE_KEY)!), ["topic-2", "topic-1"]);
});

test("an existing corrupt value is replaced by a clean list on the next mark (no crash)", async () => {
  const { storage, data } = memoryStorage({ [TOPIC_READ_STORAGE_KEY]: "}{ broken" });
  const store = createTopicReadStore(storage);
  assert.equal((await store.read()).size, 0);
  assert.equal(await store.mark("a"), true);
  assert.deepEqual(JSON.parse(data.get(TOPIC_READ_STORAGE_KEY)!), ["a"]);
});

test("overlapping marks (quick level switches) are serialized: none is lost", async () => {
  const { storage, data } = memoryStorage();
  const store = createTopicReadStore(storage);
  const results = await Promise.all([store.mark("a"), store.mark("b"), store.mark("c"), store.mark("a")]);
  assert.deepEqual(results, [true, true, true, true]);
  assert.deepEqual(JSON.parse(data.get(TOPIC_READ_STORAGE_KEY)!), ["b", "c", "a"]);
});

test("a failing write never throws: mark resolves false and the next mark still works", async () => {
  const failing = memoryStorage({}, { failSet: true });
  const store = createTopicReadStore(failing.storage);
  assert.equal(await store.mark("a"), false);
  assert.equal((await store.read()).size, 0);

  const failingRead = memoryStorage({}, { failGet: true });
  const readStore = createTopicReadStore(failingRead.storage);
  assert.equal((await readStore.read()).size, 0, "an unreadable store is empty, not an error");
  assert.equal(await readStore.mark("a"), true, "a failed read starts from an empty list and still writes");
});

test("the read-state module has no Supabase / network / RN dependency", async () => {
  const pure = await code("src/lib/topic-read.ts");
  assert.ok(!/supabase|fetch\(|XMLHttp|\.rpc\(|react-native|async-storage|from 'expo/i.test(pure));
  assert.ok(!/^import (?!type )/m.test(pure), "type-only imports");
  const binding = await code("src/lib/topic-read-storage.ts");
  const imports = binding.match(/from '[^']+'/g) ?? [];
  assert.deepEqual(imports.sort(), ["from '@/lib/topic-read'", "from '@react-native-async-storage/async-storage'"]);
  assert.ok(!/supabase|fetch\(/i.test(binding));
});

test("detail: a topic is marked read only once it is displayed (ok + topic), never on loading / error / mismatch / failed switch", async () => {
  const screen = await read("src/app/topic-detail.tsx");
  assert.ok(screen.includes("if (status === 'ok' && topic) void topicReadStore.mark(topic.id);"));
  assert.ok(screen.includes("[status, topic]"));
  assert.equal((screen.match(/topicReadStore\.mark\(/g) ?? []).length, 1, "one marking site");
  // The failure paths never set a topic or the ok status, so they cannot reach the marking effect.
  const failure = screen.slice(screen.indexOf("if (result.ok) {"), screen.indexOf("[cache, origin, pendingLevel, topic, viewDate]"));
  assert.ok(!failure.slice(failure.indexOf("} else {")).includes("setTopic(") && !failure.slice(failure.indexOf("} else {")).includes("setStatus('ok')"));
  const effect = screen.slice(screen.indexOf("useEffect(() => {"), screen.indexOf("Learning progress"));
  const mismatchBranch = effect.slice(effect.indexOf("if (!result || result.id !== id) {"), effect.indexOf("cache.set(jstDate, result);"));
  assert.ok(mismatchBranch.includes("setStatus('mismatch')") && !mismatchBranch.includes("setStatus('ok')"));
  // A successful in-screen switch shows the target through setTopic + setStatus('ok'), which triggers the effect.
  assert.ok(screen.includes("setTopic(next);\n        setStatus('ok');"));
});

test("the identity is topic.id: public.tips.id, stable for the same row on every date", async () => {
  const sql = await read("supabase/migrations/20260928123000_add_daily_kabumori_tip_rpc.sql");
  // The RPC returns the tips row id; the pick is hash(date:level) over the ids of that level, so the same row
  // (same id) comes back on different dates.
  assert.ok(sql.includes("t.id, t.title, t.category, t.base_text, t.difficulty") && sql.includes("hashtext(p_jst_date::text || ':' || p_level)"));
  const parse = await read("src/lib/home-topic.ts");
  assert.ok(parse.includes("const id = typeof candidate.id === 'string' ? candidate.id.trim() : '';"));
});
