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
  readTicket,
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
  settings_ = {
    chunk_size: 500, plan_chunks_per_call: 40, max_parallel_chunks: 4, lease_ms: 180_000, max_attempts: 3, messages_per_second: 300,
    max_devices: 20,
  };
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
      const chunkId = `c-${b.id}-${b.chunks}`;
      this.chunks.push({
        id: chunkId, broadcast: b.id, no: b.chunks, after, to: picked[picked.length - 1].id, status: "queued",
        attempt: 0, max: this.settings_.max_attempts, token: null, version: 0, expires: null, available: this.clock.now(),
      });
      // 区切りの対象者を固定する（送る直前には、この人たちだけを確かめ直す）。
      for (const user of picked) this.deliveries.set(`${b.id}|${user.id}`, { status: "planned", chunk: chunkId, attempts: 0 });
      b.cursor = this.users.indexOf(picked[picked.length - 1]) + 1;
    }
    return "planning";
  }
  async settings(): Promise<BroadcastSettings> {
    return { messages_per_second: this.settings_.messages_per_second, max_parallel_chunks: this.settings_.max_parallel_chunks };
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
        if (c.status === "failed") {
          for (const d of this.deliveries.values()) if (d.chunk === c.id && (d.status === "retry" || d.status === "planned")) d.status = "failed";
        }
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
    const out: Target[] = [];
    for (const [key, d] of this.deliveries) {
      if (d.chunk !== c.id || (d.status !== "planned" && d.status !== "retry")) continue;
      const user = this.byId.get(key.split("|")[1]);
      if (!this.eligible(user, b.type)) {
        d.status = "skipped";
        continue;
      }
      if (user!.devices.length > this.settings_.max_devices) {
        d.status = "failed";
        continue;
      }
      d.status = "sending";
      d.attempts += 1;
      for (const device of user!.devices) out.push({ user_id: user!.id, token_id: device.id, expo_push_token: device.token });
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
  ticketFor: (token: string) => unknown = (token) => ({ status: "ok", id: token });
  constructor(public clock: VirtualClock, public latencyMs = 400, public script: ExpoScript = () => "ok") {}
  sender = async (messages: BroadcastMessage[]): Promise<SendResult> => {
    this.calls += 1;
    // 送信の速さは、リクエストを送り始めた時刻で数える（worker が速さを決めるのはここ）。
    this.log.push({ at: this.clock.now(), count: messages.length });
    const action = this.script(this.calls, messages);
    await this.clock.sleep(this.latencyMs);
    const deliver = () => {
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

/** どの1秒の窓 [t, t+1000) でも数えた、送り始めた通知の数の最大（平均ではない）。 */
function peakPerSecond(log: ReadonlyArray<{ at: number; count: number }>): number {
  const sorted = [...log].sort((a, b) => a.at - b.at);
  let peak = 0;
  let sum = 0;
  let head = 0;
  for (const entry of sorted) {
    sum += entry.count;
    while (sorted[head].at <= entry.at - 1000) sum -= sorted[head++].count;
    peak = Math.max(peak, sum);
  }
  return peak;
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

for (const [users, rate, parallel, limitMinutes] of [[10_000, 300, 4, 2], [100_000, 300, 4, 8], [100_000, 400, 5, 6.5]] as const) {
  test(`${users.toLocaleString()}人（模擬）・${rate}通/秒・同時${parallel}区切り: 二重0件、どの1秒の窓でも上限以内。所要時間を記録する`, async () => {
    const { clock, store, expo } = setup(users, (n) => (n % 5 === 0 ? 2 : 1)); // 平均1.2台
    store.settings_.messages_per_second = rate;
    store.settings_.max_parallel_chunks = parallel;
    const minutes = await drive(clock, cronUntilDone(store, expo, clock));
    assertExactlyOnce(store, expo);
    assert.equal(store.broadcasts[0].status, "completed");
    const messages = expo.log.reduce((sum, entry) => sum + entry.count, 0);
    assert.equal(messages, Math.round(users * 1.2));
    const peak = peakPerSecond(expo.log);
    assert.ok(peak <= rate, `どの1秒の窓でも ${peak} 通 <= ${rate}`);
    assert.ok(store.peakActive <= parallel, `active chunks ${store.peakActive}`);
    const span = (Math.max(...expo.log.map((e) => e.at)) - Math.min(...expo.log.map((e) => e.at))) / 60_000;
    console.log(JSON.stringify({
      users, messages_per_second: rate, max_parallel_chunks: parallel, messages, chunks: store.chunks.length,
      expo_requests: expo.calls, send_span_minutes: Number(span.toFixed(2)), cron_minutes: minutes, peak_messages_in_any_second: peak,
    }));
    assert.ok(span < limitMinutes, `${span} 分（模擬）`);
  });
}

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
    assert.equal(unknown, 75, "2回目のリクエストの75人（1回は 300 ÷ 4 = 75 通まで）");
    const sent = [...store.deliveries.values()].filter((d) => d.status === "sent").length;
    assert.equal(sent, 225);
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
  assert.equal(calls, 4, "429 ×2 + 受け付け ×2（150人 = 75 + 75）");
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
  assert.equal(failed, 75);
  assert.equal(expo.received.size, 125);
});

test("ticket の数が合わない: そのリクエストの人は不明で、送り直さない", async () => {
  const { clock, store, expo } = setup(100);
  expo.script = (call) => (call === 1 ? "mismatch" : "ok");
  await drive(clock, cronUntilDone(store, expo, clock));
  assert.ok([...expo.received.values()].every((n) => n === 1));
  assert.equal([...store.deliveries.values()].filter((d) => d.status === "unknown").length, 75);
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
  store.settings_.messages_per_second = 120; // 区切りあたり 30通/秒 → 30通ずつ1秒ごと
  await drive(clock, cronUntilDone(store, expo, clock));
  assert.ok([...expo.received.values()].every((n) => n === 1), "二重なし");
  // 1回の試行で送れるのは、引き取りから2秒の間に送り始めた2回（60人）だけ。3回の試行で180人、残り320人は failed（黙って消えない）。
  const count = (status: string) => [...store.deliveries.values()].filter((d) => d.status === status).length;
  assert.equal(count("sent"), 180);
  assert.equal(count("failed"), 320);
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
  const { batches, overLimit } = batchByUser(targets);
  assert.deepEqual(batches.map((b) => b.length), [90, 2]);
  assert.deepEqual(overLimit, []);
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

// ---------------------------------------------------------------------------
// H2 の指摘 R3・R4・R6（修正前の worker では失敗する。修正前の値は H2 の Report に記録）
// ---------------------------------------------------------------------------

test("R3: 1つのリクエストに入りきらない数の端末を持つ人は、切り捨てずに failed（DEVICE_LIMIT_EXCEEDED）。90台は送る", async () => {
  const clock = new VirtualClock();
  const chunk = { lease_expires_at: new Date(clock.now() + 300_000).toISOString(), title: "t", body: "b", report_type: "morning", trading_date: "2026-10-12" } as ClaimedChunk;
  const many = (user: string, count: number): Target[] =>
    Array.from({ length: count }, (_, i) => ({ user_id: user, token_id: `${user}-${i}`, expo_push_token: `${user}-${i}` }));
  const seen: number[] = [];
  const sender = (messages: BroadcastMessage[]) => {
    seen.push(messages.length);
    return Promise.resolve({ kind: "tickets" as const, tickets: messages.map((m) => ({ status: "ok", id: m.to })) });
  };
  // 修正前: 91台 → 90通だけ送って sent（H2）。修正後: 送らずに failed。
  const over = await drive(clock, sendChunk(chunk, many("u91", 91), sender, clock, 100));
  assert.deepEqual(seen, []);
  assert.deepEqual(over.results, [{ user_id: "u91", outcome: "failed", error_code: "DEVICE_LIMIT_EXCEEDED" }]);
  const ok = await drive(clock, sendChunk(chunk, many("u90", 90), sender, clock, 100));
  assert.deepEqual(seen, [90]);
  assert.deepEqual(ok.results, [{ user_id: "u90", outcome: "sent" }]);
  // 1台・2台はそのまま。区切りの1秒あたりの上限（ここでは 30）を超える端末の数も、1つのリクエストに入らないので failed。
  const small = await drive(clock, sendChunk(chunk, [...many("a", 1), ...many("b", 2), ...many("c", 31)], sender, clock, 30));
  assert.deepEqual(small.results.map((r) => `${r.user_id}:${r.outcome}`).sort(), ["a:sent", "b:sent", "c:failed"]);
  // DB 側でも同じ人を先に除く（max_devices_per_user、既定 20）。模型でも 21台の人は failed で、送られない。
  const { clock: c2, store, expo } = setup(3, (n) => (n === 2 ? 21 : 1));
  await drive(c2, cronUntilDone(store, expo, c2));
  assert.equal(store.deliveries.get(`${store.broadcasts[0].id}|${userId(2)}`)!.status, "failed");
  assert.equal([...expo.received.keys()].filter((k) => k.startsWith("ExponentPushToken[2-")).length, 0);
});

test("R4: 同時16区切り × 40通（H2 の再現: 修正前は最初の1秒に640通）でも、どの1秒の窓でも全体の上限 300 以内", async () => {
  const clock = new VirtualClock();
  const log: Array<{ at: number; count: number }> = [];
  const sender = async (messages: BroadcastMessage[]) => {
    log.push({ at: clock.now(), count: messages.length });
    await clock.sleep(400);
    return { kind: "tickets" as const, tickets: messages.map((m) => ({ status: "ok", id: m.to })) };
  };
  const perChunk = Math.floor(300 / 16); // 18
  await drive(clock, Promise.all(Array.from({ length: 16 }, (_, k) => {
    const chunk = { lease_expires_at: new Date(clock.now() + 300_000).toISOString(), title: "t", body: "b", report_type: "morning", trading_date: "2026-10-12" } as ClaimedChunk;
    const targets = Array.from({ length: 40 }, (_, i) => ({ user_id: `k${k}-${i}`, token_id: `${k}-${i}`, expo_push_token: `${k}-${i}` }));
    return sendChunk(chunk, targets, sender, clock, perChunk);
  })));
  const peak = peakPerSecond(log);
  assert.equal(log.reduce((sum, e) => sum + e.count, 0), 640);
  assert.ok(peak <= 300, `どの1秒の窓でも ${peak} 通`);
  assert.ok(Math.max(...log.map((e) => e.count)) <= perChunk, "1回の送信は区切りの1秒あたりの上限以下");
  console.log(JSON.stringify({ case: "16 x 40 at 300/s", peak_messages_in_any_second: peak, h2_before_fix: 640 }));
});

test("R4: 区切りを続けて引き取っても、同じ枠で1秒の窓が重ならない（区切りの終わりに窓が空くまで待つ）", async () => {
  const clock = new VirtualClock();
  const log: Array<{ at: number; count: number }> = [];
  const sender = (messages: BroadcastMessage[]) => {
    log.push({ at: clock.now(), count: messages.length });
    return Promise.resolve({ kind: "tickets" as const, tickets: messages.map((m) => ({ status: "ok", id: m.to })) });
  };
  const chunk = { lease_expires_at: new Date(clock.now() + 300_000).toISOString(), title: "t", body: "b", report_type: "morning", trading_date: "2026-10-12" } as ClaimedChunk;
  await drive(clock, (async () => {
    for (let k = 0; k < 5; k += 1) {
      const targets = Array.from({ length: 70 }, (_, i) => ({ user_id: `s${k}-${i}`, token_id: `${k}-${i}`, expo_push_token: `${k}-${i}` }));
      await sendChunk(chunk, targets, sender, clock, 75);
    }
  })());
  assert.ok(peakPerSecond(log) <= 75, `${peakPerSecond(log)}`);
});

test("R6: ticket の形を厳しく読む。形の分からない ticket は unknown（送り直さない）。送り直すのは MessageRateExceeded だけ", () => {
  assert.equal(readTicket({ status: "ok", id: "x" }), "ok");
  assert.equal(readTicket({ status: "ok" }), "malformed");
  assert.equal(readTicket({ status: "ok", id: "" }), "malformed");
  assert.equal(readTicket({}), "malformed");
  assert.equal(readTicket(null), "malformed");
  assert.equal(readTicket([]), "malformed");
  assert.equal(readTicket({ status: "error" }), "malformed");
  assert.equal(readTicket({ status: "error", details: {} }), "malformed");
  assert.equal(readTicket({ status: "error", details: { error: "DeviceNotRegistered" } }), "dead");
  assert.equal(readTicket({ status: "error", details: { error: "MessageRateExceeded" } }), "rate_limited");
  assert.equal(readTicket({ status: "error", details: { error: "MessageTooBig" } }), "rejected");
  const one = (user: string, token: string): Target => ({ user_id: user, token_id: token, expo_push_token: token });
  // H2: HTTP 200 {"data":[{}]} の1台 → 修正前は retry（送り直し）。修正後は unknown。
  assert.deepEqual(outcomesFromTickets([one("u", "a")], [{}]), [{ user_id: "u", outcome: "unknown", error_code: "TICKET_MALFORMED" }]);
  // 数が合わない（一部だけ）→ unknown。
  assert.deepEqual(outcomesFromTickets([one("u", "a"), one("v", "b")], [{ status: "ok", id: "1" }]).map((r) => r.outcome), ["unknown", "unknown"]);
  // 1人の端末が混ざっている: 受け付けがあれば sent。分からない形と一時的な失敗なら unknown。一時的な失敗だけなら retry。
  const mixed = outcomesFromTickets(
    [one("p", "p1"), one("p", "p2"), one("q", "q1"), one("q", "q2"), one("r", "r1"), one("s", "s1")],
    [
      { status: "ok", id: "1" }, { status: "error", details: { error: "MessageRateExceeded" } },
      { status: "error", details: { error: "MessageRateExceeded" } }, { bogus: true },
      { status: "error", details: { error: "MessageRateExceeded" } },
      { status: "error", details: { error: "MessageTooBig" } },
    ],
  );
  assert.deepEqual(mixed.map((r) => `${r.user_id}:${r.outcome}`), ["p:sent", "q:unknown", "r:retry", "s:failed"]);
});

test("R6: HTTP 200 で中身の分からない応答・本文の壊れた応答は unknown のまま、次の試行でも送り直さない", async () => {
  for (const body of ['{"data":[{}]}', "{}", '{"data":{"status":"ok"}}', '{"errors":[{"code":"X"}]}', "not json", "null"]) {
    const { clock, store } = setup(1);
    let calls = 0;
    const fetchImpl = (() => {
      calls += 1;
      return Promise.resolve(new Response(body, { status: 200 }));
    }) as unknown as typeof fetch;
    await drive(clock, cronUntilDone(store, { sender: expoSender(clock, fetchImpl) } as unknown as MockExpo, clock, 5));
    assert.equal(calls, 1, `${body}: 1回だけ`);
    assert.equal(store.deliveries.get(`${store.broadcasts[0].id}|${userId(1)}`)!.status, "unknown", body);
  }
});

test("R6: 429 → 受け付けは同じリクエストの送り直しで1回、通信の例外は送り直さない（0回）", async () => {
  const { clock, store } = setup(1);
  let calls = 0;
  const fetchImpl = ((_url: string, init: RequestInit) => {
    calls += 1;
    if (calls === 1) return Promise.resolve(new Response("{}", { status: 429 }));
    const messages = JSON.parse(String(init.body)) as BroadcastMessage[];
    return Promise.resolve(new Response(JSON.stringify({ data: messages.map((m) => ({ status: "ok", id: m.to })) }), { status: 200 }));
  }) as unknown as typeof fetch;
  await drive(clock, cronUntilDone(store, { sender: expoSender(clock, fetchImpl) } as unknown as MockExpo, clock, 5));
  assert.equal(calls, 2);
  assert.equal(store.deliveries.get(`${store.broadcasts[0].id}|${userId(1)}`)!.status, "sent");
  const second = setup(1);
  let transport = 0;
  const failing = (() => { transport += 1; return Promise.reject(new TypeError("network")); }) as unknown as typeof fetch;
  await drive(second.clock, cronUntilDone(second.store, { sender: expoSender(second.clock, failing) } as unknown as MockExpo, second.clock, 5));
  assert.equal(transport, 1, "通信の例外は送り直さない");
  assert.equal(second.store.deliveries.get(`${second.store.broadcasts[0].id}|${userId(1)}`)!.status, "unknown");
});

test("重要ニュースの経路には触れない: notifications の表・既存の送信の RPC を使わない。送信の上限は Expo の上限より低い", () => {
  const dir = new URL("./", import.meta.url);
  for (const file of ["broadcast_logic.ts", "store.ts", "index.ts", "expo_sender.ts"]) {
    const source = readFileSync(new URL(file, dir), "utf8").replace(/^\s*\/\/.*$/gm, "");
    assert.ok(!/rest\/v1\/notifications|"notifications|claim_pending_push_notifications|send-push-notifications\/index/.test(source), file);
  }
  const migration = readFileSync(new URL("../../migrations/20261012100000_market_report_broadcast_push_v1.sql", import.meta.url), "utf8");
  assert.match(migration, /messages_per_second integer not null default 300 check \(messages_per_second between 10 and 400\)/);
  assert.match(migration, /max_parallel_chunks integer not null default 4 check \(max_parallel_chunks between 1 and 6\)/);
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
