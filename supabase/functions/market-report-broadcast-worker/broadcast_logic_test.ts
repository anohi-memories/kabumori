// 一斉通知の worker を、DB の RPC と同じ規則の手元の模型（MemStore）・Expo の模型・仮想の時計で確かめる。
// 模型の規則は migration の enqueue / plan / claim / begin / finish と同じ。SQL そのものの同じ性質は
// supabase/tests/market_report_broadcast_run.sh（手元の PostgreSQL）で確かめている。
// 所要時間は「仮定した遅延」での模擬の値で、本番の実測ではない（Report に分けて記録する）。
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  batchByUser,
  messageFor,
  outcomesFromTickets,
  runBroadcastWorker,
  sendChunk,
  type BroadcastMessage,
  type BroadcastSettings,
  type BroadcastStore,
  type ClaimedChunk,
  type Clock,
  type SendResult,
  type Target,
  type UserResult,
} from "./broadcast_logic.ts";
import { expoSender } from "./expo_sender.ts";
import { rpcStore } from "./store.ts";

// ---------------------------------------------------------------------------
// 仮想の時計（sleep はすべて仮想の時間で進む）
// ---------------------------------------------------------------------------

class VirtualClock implements Clock {
  t = Date.parse("2026-10-12T00:00:00Z");
  timers: Array<{ at: number; resolve: () => void }> = [];
  now() { return this.t; }
  sleep(ms: number) {
    return new Promise<void>((resolve) => this.timers.push({ at: this.t + Math.max(0, ms), resolve }));
  }
}

/** 仮想の時計を進めながら task を最後まで走らせる。 */
async function drive<T>(clock: VirtualClock, task: Promise<T>): Promise<T> {
  let done = false;
  let value!: T;
  let failure: unknown = null;
  task.then((v) => { done = true; value = v; }, (e) => { done = true; failure = e; });
  for (let guard = 0; guard < 5_000_000; guard += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (done) break;
    if (clock.timers.length === 0) throw new Error("DEADLOCK");
    const at = Math.min(...clock.timers.map((timer) => timer.at));
    clock.t = Math.max(clock.t, at);
    const due = clock.timers.filter((timer) => timer.at <= clock.t);
    clock.timers = clock.timers.filter((timer) => timer.at > clock.t);
    for (const timer of due) timer.resolve();
  }
  if (failure) throw failure;
  return value;
}

// ---------------------------------------------------------------------------
// DB の模型
// ---------------------------------------------------------------------------

type User = { id: string; push: boolean; morning: boolean; close: boolean; devices: Array<{ id: string; token: string }> };
type Chunk = {
  id: string; broadcast: string; no: number; after: string | null; to: string; status: string; attempt: number; max: number;
  token: string | null; version: number; expires: number | null; available: number;
};
type Delivery = { status: string; chunk: string; attempts: number };

const userId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

class MemStore implements BroadcastStore {
  users: User[] = [];
  byId = new Map<string, User>();
  broadcasts: Array<{ id: string; type: "morning" | "close"; date: string; status: string; cursor: number; chunks: number }> = [];
  chunks: Chunk[] = [];
  deliveries = new Map<string, Delivery>();
  cycles: Array<{ type: "morning" | "close"; date: string }> = [];
  settings_ = { chunk_size: 500, plan_chunks_per_call: 40, max_parallel_chunks: 4, lease_ms: 180_000, max_attempts: 3, messages_per_second: 300 };
  active = 0;
  peakActive = 0;
  private seq = 0;
  constructor(public clock: VirtualClock, public dbMs = { claim: 20, begin: 60, finish: 40, plan: 30 }) {}

  addUsers(count: number, devices: (n: number) => number = () => 1, from = 1) {
    for (let n = from; n < from + count; n += 1) {
      const id = userId(n);
      const user: User = {
        id, push: true, morning: true, close: true,
        devices: Array.from({ length: devices(n) }, (_, d) => ({ id: `${id}-d${d}`, token: `ExponentPushToken[${n}-${d}]` })),
      };
      this.users.push(user);
      this.byId.set(id, user);
    }
    this.users.sort((a, b) => a.id.localeCompare(b.id));
  }
  eligible(user: User | undefined, type: string) {
    return !!user && user.push && (type === "morning" ? user.morning : user.close) && user.devices.length > 0;
  }
  async enqueue() {
    for (const cycle of this.cycles) {
      if (!this.broadcasts.some((b) => b.type === cycle.type && b.date === cycle.date)) {
        this.broadcasts.push({ id: `b-${++this.seq}`, type: cycle.type, date: cycle.date, status: "planning", cursor: 0, chunks: 0 });
      }
    }
    return { status: "ok" };
  }
  async planningBroadcasts(limit: number) {
    return this.broadcasts.filter((b) => b.status === "planning").slice(0, limit).map((b) => b.id);
  }
  async plan(id: string) {
    await this.clock.sleep(this.dbMs.plan);
    const b = this.broadcasts.find((x) => x.id === id)!;
    if (b.status !== "planning") return b.status;
    for (let made = 0; made < this.settings_.plan_chunks_per_call; made += 1) {
      const picked: User[] = [];
      let i = b.cursor;
      for (; i < this.users.length && picked.length < this.settings_.chunk_size; i += 1) {
        if (this.eligible(this.users[i], b.type)) picked.push(this.users[i]);
      }
      if (picked.length === 0) {
        b.cursor = this.users.length;
        b.status = this.chunks.some((c) => c.broadcast === b.id && (c.status === "queued" || c.status === "processing"))
          ? "sending" : "completed";
        return "planned";
      }
      const after = b.cursor === 0 ? null : this.users[b.cursor - 1].id;
      b.chunks += 1;
      this.chunks.push({
        id: `c-${b.id}-${b.chunks}`, broadcast: b.id, no: b.chunks, after, to: picked[picked.length - 1].id, status: "queued",
        attempt: 0, max: this.settings_.max_attempts, token: null, version: 0, expires: null, available: this.clock.now(),
      });
      b.cursor = this.users.indexOf(picked[picked.length - 1]) + 1;
    }
    return "planning";
  }
  async settings(): Promise<BroadcastSettings> {
    return { messages_per_second: this.settings_.messages_per_second, max_parallel_chunks: this.settings_.max_parallel_chunks };
  }
  private range(c: Chunk) {
    const start = c.after === null ? 0 : this.users.findIndex((u) => u.id > c.after!);
    const out: User[] = [];
    for (let i = start; i >= 0 && i < this.users.length && this.users[i].id <= c.to; i += 1) out.push(this.users[i]);
    return out;
  }
  private completeBroadcasts() {
    for (const b of this.broadcasts) {
      if (b.status === "sending" && !this.chunks.some((c) => c.broadcast === b.id && (c.status === "queued" || c.status === "processing"))) {
        b.status = "completed";
      }
    }
  }
  async claim(limit: number): Promise<ClaimedChunk[]> {
    await this.clock.sleep(this.dbMs.claim);
    const now = this.clock.now();
    for (const c of this.chunks) {
      if (c.status === "processing" && c.expires! < now) {
        for (const d of this.deliveries.values()) if (d.chunk === c.id && d.status === "sending") d.status = "unknown";
        c.status = c.attempt >= c.max ? "failed" : "queued";
        c.token = null; c.expires = null; c.version += 1; c.available = now;
        if (c.status === "failed") for (const d of this.deliveries.values()) if (d.chunk === c.id && d.status === "retry") d.status = "failed";
      }
    }
    this.completeBroadcasts();
    const running = this.chunks.filter((c) => c.status === "processing").length;
    const slots = Math.min(limit, 16, Math.max(this.settings_.max_parallel_chunks - running, 0));
    const picked = this.chunks.filter((c) => c.status === "queued" && c.available <= now &&
      this.broadcasts.find((b) => b.id === c.broadcast)!.status !== "completed").slice(0, slots);
    return picked.map((c) => {
      c.status = "processing"; c.attempt += 1; c.token = crypto.randomUUID(); c.version += 1; c.expires = now + this.settings_.lease_ms;
      const b = this.broadcasts.find((x) => x.id === c.broadcast)!;
      return {
        chunk_id: c.id, broadcast_id: b.id, report_type: b.type, trading_date: b.date,
        title: "10月12日の朝刊ができました", body: "日経平均は反発", attempt_count: c.attempt, max_attempts: c.max,
        lease_token: c.token, lease_version: c.version, lease_expires_at: new Date(c.expires).toISOString(),
      };
    });
  }
  private fenced(chunk: ClaimedChunk) {
    const c = this.chunks.find((x) => x.id === chunk.chunk_id)!;
    const ok = c.status === "processing" && c.token === chunk.lease_token && c.version === chunk.lease_version && c.expires! >= this.clock.now();
    return { c, ok };
  }
  async begin(chunk: ClaimedChunk): Promise<Target[]> {
    await this.clock.sleep(this.dbMs.begin);
    const { c, ok } = this.fenced(chunk);
    if (!ok) throw new Error("MARKET_REPORT_BROADCAST_LEASE_LOST");
    this.active += 1;
    this.peakActive = Math.max(this.peakActive, this.active);
    const b = this.broadcasts.find((x) => x.id === c.broadcast)!;
    for (const [key, d] of this.deliveries) {
      if (d.chunk === c.id && d.status === "retry" && !this.eligible(this.byId.get(key.split("|")[1]), b.type)) d.status = "skipped";
    }
    const out: Target[] = [];
    for (const user of this.range(c)) {
      if (!this.eligible(user, b.type)) continue;
      const key = `${b.id}|${user.id}`;
      const d = this.deliveries.get(key);
      if (d && d.status !== "retry") continue;
      this.deliveries.set(key, { status: "sending", chunk: c.id, attempts: (d?.attempts ?? 0) + 1 });
      for (const device of user.devices) out.push({ user_id: user.id, token_id: device.id, expo_push_token: device.token });
    }
    return out;
  }
  async finish(chunk: ClaimedChunk, results: UserResult[]): Promise<string> {
    await this.clock.sleep(this.dbMs.finish);
    const { c, ok } = this.fenced(chunk);
    if (this.active > 0) this.active -= 1;
    if (!ok) return "lease_lost";
    const final = c.attempt >= c.max;
    const byUser = new Map(results.map((r) => [r.user_id, r.outcome]));
    let retry = 0;
    for (const [key, d] of this.deliveries) {
      if (d.chunk !== c.id || d.status !== "sending") continue;
      const outcome = byUser.get(key.split("|")[1]);
      d.status = outcome === "sent" ? "sent"
        : outcome === "retry" && !final ? "retry"
        : outcome === "retry" || outcome === "failed" ? "failed" : "unknown";
    }
    for (const d of this.deliveries.values()) if (d.chunk === c.id && d.status === "retry") retry += 1;
    c.status = retry > 0 ? "queued" : "done";
    if (retry > 0) c.available = this.clock.now() + 30_000 * c.attempt;
    c.token = null; c.expires = null; c.version += 1;
    this.completeBroadcasts();
    return retry > 0 ? "requeued" : "done";
  }
  async purge() { return { deliveries_deleted: 0 }; }
}

// ---------------------------------------------------------------------------
// Expo の模型: 端末ごとに受け取った数を数える
// ---------------------------------------------------------------------------

type ExpoScript = (call: number, messages: BroadcastMessage[]) => "ok" | "transport_lost" | "transport_delivered" | number | "mismatch";

class MockExpo {
  received = new Map<string, number>();
  calls = 0;
  log: Array<{ at: number; count: number }> = [];
  ticketFor: (token: string) => { status: "ok"; id: string } | { status: "error"; message: string; details: { error: string } } =
    (token) => ({ status: "ok", id: token });
  constructor(public clock: VirtualClock, public latencyMs = 400, public script: ExpoScript = () => "ok") {}
  sender = async (messages: BroadcastMessage[]): Promise<SendResult> => {
    this.calls += 1;
    const action = this.script(this.calls, messages);
    await this.clock.sleep(this.latencyMs);
    const deliver = () => {
      this.log.push({ at: this.clock.now(), count: messages.length });
      for (const m of messages) this.received.set(m.to, (this.received.get(m.to) ?? 0) + 1);
    };
    if (action === "transport_lost") throw new Error("TypeError: network");
    if (action === "transport_delivered") { deliver(); throw new Error("TypeError: connection reset"); }
    if (typeof action === "number") return { kind: "rejected", status: action };
    deliver();
    if (action === "mismatch") return { kind: "tickets", tickets: [] };
    return { kind: "tickets", tickets: messages.map((m) => this.ticketFor(m.to)) };
  };
}

/** Cron を毎分起動する（各回は時間の予算の範囲で動く）。一斉通知が終わるまで。 */
async function cronUntilDone(store: MemStore, expo: MockExpo, clock: VirtualClock, maxMinutes = 120) {
  const start = clock.now();
  const runs: Promise<unknown>[] = [];
  for (let minute = 0; minute < maxMinutes; minute += 1) {
    runs.push(runBroadcastWorker(store, expo.sender, clock));
    await clock.sleep(60_000);
    if (store.broadcasts.length > 0 && store.broadcasts.every((b) => b.status === "completed")) break;
  }
  await Promise.all(runs);
  return (clock.now() - start) / 60_000;
}

function setup(users: number, devices: (n: number) => number = () => 1) {
  const clock = new VirtualClock();
  const store = new MemStore(clock);
  store.addUsers(users, devices);
  store.cycles.push({ type: "morning", date: "2026-10-12" });
  const expo = new MockExpo(clock);
  return { clock, store, expo };
}

function assertExactlyOnce(store: MemStore, expo: MockExpo, type: "morning" | "close" = "morning") {
  for (const user of store.users) {
    for (const device of user.devices) {
      const got = expo.received.get(device.token) ?? 0;
      assert.equal(got, store.eligible(user, type) ? 1 : 0, `${device.token}`);
    }
  }
}

// ---------------------------------------------------------------------------
// テスト
// ---------------------------------------------------------------------------

for (const users of [0, 1, 199, 200, 201]) {
  test(`${users}人: 対象の全端末にちょうど1回ずつ届き、一斉通知は完了する`, async () => {
    const { clock, store, expo } = setup(users, (n) => 1 + (n % 2));
    await drive(clock, cronUntilDone(store, expo, clock));
    assertExactlyOnce(store, expo);
    assert.equal(store.broadcasts[0].status, "completed");
    assert.equal([...store.deliveries.values()].filter((d) => d.status === "sent").length, users);
  });
}

test("対象外の人には送らない（通知 OFF・朝刊 OFF・端末なし）。大引けは大引けの設定を見る", async () => {
  const { clock, store, expo } = setup(10);
  store.byId.get(userId(2))!.push = false;
  store.byId.get(userId(3))!.morning = false;
  store.byId.get(userId(4))!.devices = [];
  store.byId.get(userId(5))!.close = false;
  store.cycles.push({ type: "close", date: "2026-10-12" });
  await drive(clock, cronUntilDone(store, expo, clock));
  const got = (n: number) => expo.received.get(`ExponentPushToken[${n}-0]`) ?? 0;
  assert.equal(got(1), 2, "朝刊と大引けで1回ずつ");
  assert.equal(got(2), 0);
  assert.equal(got(3), 1, "大引けだけ");
  assert.equal(got(5), 1, "朝刊だけ");
});

for (const users of [10_000, 100_000]) {
  test(`${users.toLocaleString()}人（模擬）: 二重送信0件で完了し、送信の速さは上限以内。所要時間を記録する`, async () => {
    const { clock, store, expo } = setup(users, (n) => (n % 5 === 0 ? 2 : 1)); // 平均1.2台
    const minutes = await drive(clock, cronUntilDone(store, expo, clock));
    assertExactlyOnce(store, expo);
    assert.equal(store.broadcasts[0].status, "completed");
    const messages = expo.log.reduce((sum, entry) => sum + entry.count, 0);
    assert.equal(messages, Math.round(users * 1.2));
    // 10秒ごとの送信数が、上限（300/秒）の15%増し以内。枠ごとの間隔は 1.2 秒（90通 ÷ 75通/秒）なので、10秒の窓の
    // 端にリクエストが1つ余分に入ると見かけの値は最大で約12%上がる（長い目で見た平均は上限以内）。
    const buckets = new Map<number, number>();
    for (const entry of expo.log) buckets.set(Math.floor(entry.at / 10_000), (buckets.get(Math.floor(entry.at / 10_000)) ?? 0) + entry.count);
    const peak = Math.max(...buckets.values()) / 10;
    assert.ok(peak <= 345, `peak ${peak}/s`);
    const spanSeconds = (Math.max(...expo.log.map((e) => e.at)) - Math.min(...expo.log.map((e) => e.at))) / 1000;
    // 最初と最後のリクエストの間には、間隔が1つ少なく入る（植木算）。1つ分（1.2秒）を足して平均を見る。
    assert.ok(messages / (spanSeconds + 1.2) <= 300, `平均 ${messages / (spanSeconds + 1.2)}/s は上限以内`);
    assert.ok(store.peakActive <= 4, `active chunks ${store.peakActive}`);
    const firstSend = Math.min(...expo.log.map((entry) => entry.at));
    const lastSend = Math.max(...expo.log.map((entry) => entry.at));
    console.log(JSON.stringify({
      users, messages, chunks: store.chunks.length, expo_requests: expo.calls,
      send_span_minutes: Number(((lastSend - firstSend) / 60_000).toFixed(2)), cron_minutes: minutes, peak_messages_per_second: peak,
    }));
    if (users === 10_000) assert.ok((lastSend - firstSend) / 60_000 < 2, "1万人は2分以内（模擬）");
    else assert.ok((lastSend - firstSend) / 60_000 < 8, "10万人は8分以内（模擬、300/秒）");
  });
}

test("10万人（模擬）・上限 450/秒: 約5分（5.5分以内）で送り終え、10秒ごとの送信数も Expo の上限（600/秒）より低い", async () => {
  const { clock, store, expo } = setup(100_000, (n) => (n % 5 === 0 ? 2 : 1));
  store.settings_.messages_per_second = 450;
  await drive(clock, cronUntilDone(store, expo, clock));
  assertExactlyOnce(store, expo);
  const span = (Math.max(...expo.log.map((e) => e.at)) - Math.min(...expo.log.map((e) => e.at))) / 60_000;
  const buckets = new Map<number, number>();
  for (const entry of expo.log) buckets.set(Math.floor(entry.at / 10_000), (buckets.get(Math.floor(entry.at / 10_000)) ?? 0) + entry.count);
  const peak = Math.max(...buckets.values()) / 10;
  console.log(JSON.stringify({ users: 100_000, messages_per_second: 450, send_span_minutes: Number(span.toFixed(2)), peak_messages_per_second: peak }));
  assert.ok(span < 5.5, `${span} 分`);
  assert.ok(peak < 600, `peak ${peak}/s`);
});

test("送る直前に確かめ直す: 分割のあとに通知を OFF にした人には送らず、入れ替えた端末には新しいほうへ送る", async () => {
  const { clock, store, expo } = setup(50);
  await store.enqueue();
  await drive(clock, store.plan(store.broadcasts[0].id));
  store.byId.get(userId(7))!.push = false;
  store.byId.get(userId(8))!.devices = [{ id: "new", token: "ExponentPushToken[8-new]" }];
  await drive(clock, cronUntilDone(store, expo, clock));
  assert.equal(expo.received.get("ExponentPushToken[7-0]") ?? 0, 0);
  assert.equal(expo.received.get("ExponentPushToken[8-0]") ?? 0, 0);
  assert.equal(expo.received.get("ExponentPushToken[8-new]"), 1);
});

test("worker が送る直前に止まった（begin のあと何もしない）: 期限切れのあと、その人たちには二度と送らない", async () => {
  const { clock, store, expo } = setup(30);
  await store.enqueue();
  await drive(clock, store.plan(store.broadcasts[0].id));
  const [chunk] = await drive(clock, store.claim(1));
  const targets = await drive(clock, store.begin(chunk));
  assert.equal(targets.length, 30);
  await drive(clock, clock.sleep(181_000));
  await drive(clock, cronUntilDone(store, expo, clock));
  assert.equal(expo.calls, 0, "送ったかもしれない人には送り直さない");
  assert.equal([...store.deliveries.values()].every((d) => d.status === "unknown"), true);
  assert.equal(store.broadcasts[0].status, "completed");
});

test("通信が途中で切れた: そのリクエストの人は不明（実は届いていても二重にならない）。後ろの人は次の試行で送る", async () => {
  for (const lost of ["transport_lost", "transport_delivered"] as const) {
    const { clock, store, expo } = setup(300);
    expo.script = (call) => (call === 2 ? lost : "ok");
    await drive(clock, cronUntilDone(store, expo, clock));
    for (const user of store.users) assert.ok((expo.received.get(user.devices[0].token) ?? 0) <= 1, user.id);
    const unknown = [...store.deliveries.values()].filter((d) => d.status === "unknown").length;
    assert.equal(unknown, 90, "2回目のリクエストの90人");
    const sent = [...store.deliveries.values()].filter((d) => d.status === "sent").length;
    assert.equal(sent, 210);
    assert.equal(store.broadcasts[0].status, "completed");
  }
});

test("429 が2回続いてから受け付け: 同じリクエストを送り直し、全員1回ずつ", async () => {
  const { clock, store } = setup(150);
  let calls = 0;
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    calls += 1;
    if (calls <= 2) return new Response("{}", { status: 429 });
    const messages = JSON.parse(String(init.body)) as BroadcastMessage[];
    return new Response(JSON.stringify({ data: messages.map((m) => ({ status: "ok", id: m.to })) }), { status: 200 });
  }) as typeof fetch;
  const counts = new Map<string, number>();
  const sender = expoSender(clock, ((url: string, init: RequestInit) => {
    return fetchImpl(url, init).then((response) => {
      if (response.status === 200) for (const m of JSON.parse(String(init.body)) as BroadcastMessage[]) counts.set(m.to, (counts.get(m.to) ?? 0) + 1);
      return response;
    });
  }) as typeof fetch);
  await store.enqueue();
  await drive(clock, (async () => {
    for (let i = 0; i < 3; i += 1) await runBroadcastWorker(store, sender, clock);
  })());
  assert.equal(counts.size, 150);
  assert.ok([...counts.values()].every((n) => n === 1));
  assert.equal(calls, 4, "429 ×2 + 受け付け ×2（150人 = 90 + 60）");
});

test("500 が続く: 区切りの回数（3回）まで試して failed。届いたものは0、リクエストの数も有限", async () => {
  const { clock, store, expo } = setup(100);
  expo.script = () => 500;
  await drive(clock, cronUntilDone(store, expo, clock));
  assert.equal(expo.received.size, 0);
  assert.equal(expo.calls, 3, "区切り1つ × 3回（区切りの中では、断られたら後ろを送らない）");
  assert.ok([...store.deliveries.values()].every((d) => d.status === "failed"));
  assert.equal(store.broadcasts[0].status, "completed");
});

test("400（内容の問題）は送り直さず failed。ほかのリクエストは続ける", async () => {
  const { clock, store, expo } = setup(200);
  expo.script = (call) => (call === 1 ? 400 : "ok");
  await drive(clock, cronUntilDone(store, expo, clock));
  const failed = [...store.deliveries.values()].filter((d) => d.status === "failed").length;
  assert.equal(failed, 90);
  assert.equal(expo.received.size, 110);
});

test("ticket の数が合わない: そのリクエストの人は不明で、送り直さない", async () => {
  const { clock, store, expo } = setup(100);
  expo.script = (call) => (call === 1 ? "mismatch" : "ok");
  await drive(clock, cronUntilDone(store, expo, clock));
  assert.ok([...expo.received.values()].every((n) => n === 1));
  assert.equal([...store.deliveries.values()].filter((d) => d.status === "unknown").length, 90);
});

test("端末ごとの ticket: 1台でも受け付ければ送信済み。全部無効なら failed。一時的な失敗はその人だけ次の試行で送る", async () => {
  const { clock, store, expo } = setup(3, () => 2);
  expo.ticketFor = (token) => {
    if (token === "ExponentPushToken[1-0]") return { status: "error", message: "x", details: { error: "DeviceNotRegistered" } };
    if (token.startsWith("ExponentPushToken[2-")) return { status: "error", message: "x", details: { error: "DeviceNotRegistered" } };
    if (token.startsWith("ExponentPushToken[3-") && expo.calls === 1) return { status: "error", message: "x", details: { error: "MessageRateExceeded" } };
    return { status: "ok", id: token };
  };
  await drive(clock, cronUntilDone(store, expo, clock));
  const status = (n: number) => store.deliveries.get(`${store.broadcasts[0].id}|${userId(n)}`)!.status;
  assert.equal(status(1), "sent", "1台は無効でも、もう1台が受け付けた");
  assert.equal(status(2), "failed");
  assert.equal(status(3), "sent");
  assert.equal(expo.received.get("ExponentPushToken[1-1]"), 1, "受け付けた人には送り直さない");
  assert.equal(expo.received.get("ExponentPushToken[3-0]"), 2, "一時的な失敗の人だけ、次の試行でもう一度");
});

test("貸し出しの残りが少なければ、新しいリクエストを送らずに止め、残りは次の試行へ。回数を使い切った人は failed（二重なし）", async () => {
  const { clock, store, expo } = setup(500);
  store.settings_.lease_ms = 22_000; // 安全の余白 20秒 → 引き取りから2秒の間だけ送り始められる
  store.settings_.messages_per_second = 120; // 区切りあたり 30/秒 → 90通ごとに3秒の間隔
  await drive(clock, cronUntilDone(store, expo, clock));
  assert.ok([...expo.received.values()].every((n) => n === 1), "二重なし");
  // 1回の試行で送れるのは最初の90人だけ。3回の試行で270人、残り230人は failed（黙って消えない）。
  const count = (status: string) => [...store.deliveries.values()].filter((d) => d.status === status).length;
  assert.equal(count("sent"), 270);
  assert.equal(count("failed"), 230);
  assert.equal(store.chunks[0].attempt, 3);
  assert.equal(store.broadcasts[0].status, "completed");
});

test("Cron が重なっても（2つの実行が同時）、同時に送る区切りは上限まで、二重送信なし", async () => {
  const { clock, store, expo } = setup(5_000);
  store.settings_.max_parallel_chunks = 3;
  await drive(clock, Promise.all([cronUntilDone(store, expo, clock, 30), runBroadcastWorker(store, expo.sender, clock)]));
  assertExactlyOnce(store, expo);
  assert.ok(store.peakActive <= 3);
});

test("区切りの詰め方: 1人の端末は同じリクエストに入る。通知の中身は日付と種類つきでアプリの共通の市況を開ける", () => {
  const targets: Target[] = [];
  for (let n = 1; n <= 46; n += 1) for (let d = 0; d < 2; d += 1) targets.push({ user_id: userId(n), token_id: `${n}-${d}`, expo_push_token: `t${n}-${d}` });
  const batches = batchByUser(targets);
  assert.deepEqual(batches.map((b) => b.length), [90, 2]);
  for (const batch of batches) {
    for (const user of new Set(batch.map((t) => t.user_id))) assert.equal(batch.filter((t) => t.user_id === user).length, 2);
  }
  const chunk = { report_type: "close", trading_date: "2026-10-12", title: "t", body: "b" } as ClaimedChunk;
  assert.deepEqual(messageFor(chunk, "tok").data, {
    source_type: "market_report", source_id: "close:2026-10-12", report_type: "close", trading_date: "2026-10-12",
  });
  assert.deepEqual(outcomesFromTickets([{ user_id: "u", token_id: "a", expo_push_token: "a" }], []), [
    { user_id: "u", outcome: "unknown", error_code: "TICKET_COUNT_MISMATCH" },
  ]);
});

test("sendChunk は例外を投げず、送らなかった人は retry", async () => {
  const clock = new VirtualClock();
  const chunk = { lease_expires_at: new Date(clock.now() + 300_000).toISOString() } as ClaimedChunk;
  const targets: Target[] = Array.from({ length: 200 }, (_, i) => ({ user_id: `u${i}`, token_id: `${i}`, expo_push_token: `t${i}` }));
  const out = await drive(clock, sendChunk(chunk, targets, () => Promise.resolve({ kind: "rejected", status: 503 }), clock, 100));
  assert.equal(out.requests, 1);
  assert.equal(out.results.filter((r) => r.outcome === "retry").length, 200);
});

test("重要ニュースの経路には触れない: notifications の表・既存の送信の RPC を使わない。送信の上限は Expo の上限より低い", () => {
  const dir = new URL("./", import.meta.url);
  for (const file of ["broadcast_logic.ts", "store.ts", "index.ts", "expo_sender.ts"]) {
    const source = readFileSync(new URL(file, dir), "utf8").replace(/^\s*\/\/.*$/gm, "");
    assert.ok(!/rest\/v1\/notifications|"notifications|claim_pending_push_notifications|send-push-notifications\/index/.test(source), file);
  }
  const migration = readFileSync(new URL("../../migrations/20261012100000_market_report_broadcast_push_v1.sql", import.meta.url), "utf8");
  assert.match(migration, /messages_per_second integer not null default 300 check \(messages_per_second between 10 and 550\)/);
  assert.ok(!/(insert into|update|delete from) public\.notifications/.test(migration), "notifications の表は書き換えない");
});

test("DB との境界: 状態の変更はすべて RPC に token と版を添えて渡す", async () => {
  const calls: Array<[string, unknown]> = [];
  const store = rpcStore({
    get<T>(path: string) {
      calls.push(["get", path]);
      return Promise.resolve((path.startsWith("market_report_broadcast_settings")
        ? [{ enabled: true, messages_per_second: 300, max_parallel_chunks: 4 }] : [{ id: "b1" }]) as T);
    },
    rpc<T>(name: string, args: Record<string, unknown>) {
      calls.push([name, args]);
      return Promise.resolve((name === "claim_market_report_broadcast_chunks" || name === "begin_market_report_broadcast_chunk" ? [] : { status: "done" }) as T);
    },
  });
  const chunk = { chunk_id: "c1", lease_token: "tok", lease_version: 7 } as ClaimedChunk;
  assert.deepEqual(await store.settings(), { messages_per_second: 300, max_parallel_chunks: 4 });
  assert.deepEqual(await store.planningBroadcasts(5), ["b1"]);
  await store.begin(chunk);
  assert.equal(await store.finish(chunk, [{ user_id: "u", outcome: "sent" }], null), "done");
  assert.deepEqual(calls.find(([name]) => name === "begin_market_report_broadcast_chunk")![1], { p_chunk_id: "c1", p_lease_token: "tok", p_lease_version: 7 });
  assert.deepEqual(calls.find(([name]) => name === "finish_market_report_broadcast_chunk")![1], {
    p_chunk_id: "c1", p_lease_token: "tok", p_lease_version: 7, p_results: [{ user_id: "u", outcome: "sent" }], p_error_code: null,
  });
  const off = rpcStore({ get: <T>() => Promise.resolve([{ enabled: false, messages_per_second: 300, max_parallel_chunks: 4 }] as T), rpc: <T>() => Promise.resolve(null as T) });
  assert.equal(await off.settings(), null, "ゲートが OFF なら送らない");
});
