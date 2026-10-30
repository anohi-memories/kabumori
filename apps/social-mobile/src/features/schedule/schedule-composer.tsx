import { useEffect, useRef, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import * as Crypto from "expo-crypto";
import { colors } from "@/constants/theme";
import { ActionButton, Card, Pill, styles } from "@/components/ui";
import {
  ASSIST_BLOCK_TEXT,
  ASSIST_MODES,
  assistBlock,
  assistInputIssue,
  assistOutcomeView,
  assistScope,
  newAssistRequest,
  sendAssist,
  withHashtags,
  type AssistEnv,
  type AssistMode,
  type AssistRequest,
  type PostAssistUiState,
} from "@/features/schedule/post-assist";
import { usePostAssistEnv } from "@/features/schedule/use-post-assist-env";
import {
  jstDateOf,
  planBatch,
  type BatchRequest,
  type PlanContext,
  type PlanIssue,
  type PlanResult,
} from "@/domain/schedule-planner";

type Mode = BatchRequest["mode"];
const MODES: { mode: Mode; label: string; detail: string }[] = [
  { mode: "manual_exact", label: "指定日時", detail: "1件ずつ日時を決めます。決めた日時は動きません。" },
  { mode: "manual_random_batch", label: "まとめてランダム", detail: "複数の本文を、期間と時間帯の中に分散して並べます。" },
  { mode: "manual_interval", label: "間隔指定", detail: "開始日時から、決めた間隔で順番に並べます。" },
  { mode: "ai_flexible", label: "AI自動予約", detail: "AI相談で覚えた頻度をもとに、投稿する枠だけを作ります。" },
];
const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];
const DAY_MS = 24 * 60 * 60 * 1000;

export type AiPlanningInput = {
  frequencyTargetPerWeek: number;
  approvalMode: string;
  source: "saved" | "default";
  status: "unloaded" | "loading" | "ready" | "no_saved_settings" | "unavailable" | "blocked";
};

const AI_STATUS_TEXT: Record<AiPlanningInput["status"], string> = {
  unloaded: "AI相談で覚えた設定は、まだ読み込んでいません。初期設定（週3回）で枠を作ります。",
  loading: "AI相談で覚えた設定を読み込み中です。初期設定（週3回）で枠を作ります。",
  ready: "AI相談で覚えた設定",
  no_saved_settings: "AI相談で覚えた設定はまだありません。初期設定（週3回）で枠を作ります。",
  unavailable: "AI相談で覚えた設定を確認できませんでした。初期設定（週3回）で枠を作ります。",
  blocked: "AI相談で覚えた設定を読む権限が確認できませんでした。初期設定（週3回）で枠を作ります。",
};

type Row = { id: string; text: string; date: string; time: string };

/** The AI post assist opened under one row. Its answers are suggestions: a row's text changes only when the person adopts one. */
type AssistPanel = {
  rowId: string;
  mode: AssistMode;
  notes: string;
  instruction: string;
  phase: "idle" | "running" | "done";
  /** The request being awaited or answered; a same-key retry re-sends exactly this. */
  request: AssistRequest | null;
  outcome: PostAssistUiState | null;
  /** The candidates' texts as the person edits them. */
  edits: string[];
  issue: string | null;
};

/** Local form: produces a preview plan through the pure planner. It has no way to save or publish. */
export function ScheduleComposer({
  context,
  ai,
  onPlanned,
  onClose,
}: {
  context: Omit<PlanContext, "batchId" | "seed">;
  ai: AiPlanningInput;
  onPlanned: (result: Extract<PlanResult, { ok: true }>) => void;
  onClose: () => void;
}) {
  const tomorrow = jstDateOf(context.now.getTime() + DAY_MS);
  const inAWeek = jstDateOf(context.now.getTime() + 7 * DAY_MS);
  const [mode, setMode] = useState<Mode>("manual_exact");
  const nextRowId = useRef(1);
  const [rows, setRows] = useState<Row[]>([{ id: "r0", text: "", date: tomorrow, time: "09:00" }]);
  const [dateFrom, setDateFrom] = useState(tomorrow);
  const [dateTo, setDateTo] = useState(inAWeek);
  const [windowStart, setWindowStart] = useState("09:00");
  const [windowEnd, setWindowEnd] = useState("21:00");
  const [weekdays, setWeekdays] = useState<number[]>([]);
  const [shuffle, setShuffle] = useState(false);
  const [startDate, setStartDate] = useState(tomorrow);
  const [startTime, setStartTime] = useState("12:00");
  const [everyValue, setEveryValue] = useState("1");
  const [everyUnit, setEveryUnit] = useState<"days" | "hours">("days");
  const [issues, setIssues] = useState<PlanIssue[]>([]);

  // AI post assist: asked with the person's own session for their own workspace only; see post-assist.ts.
  // The access token a 401 answered (Supabase's gateway or the endpoint): AI requests stay off until the person signs in again.
  const [refusedToken, setRefusedToken] = useState<string | null>(null);
  const env: AssistEnv = usePostAssistEnv(context.owner, refusedToken);
  const block = assistBlock(env);
  const scope = assistScope(env);
  const [assistState, setAssist] = useState<AssistPanel | null>(null);
  // A request made for another session or workspace is as good as never made: its answer is never shown or adopted.
  const assist: AssistPanel | null = assistState?.request && assistState.request.scope !== scope
    ? { ...assistState, phase: "idle", request: null, outcome: null, edits: [] }
    : assistState;
  const [undo, setUndo] = useState<{ rowId: string; before: string; after: string } | null>(null);
  // The one request still awaited (null once it is cancelled, closed or replaced), and the latest committed
  // session/workspace and rows, for handlers of a button from an earlier frame.
  const live = useRef<{ env: AssistEnv; rows: Row[]; awaiting: AssistRequest | null }>({ env, rows, awaiting: null });
  useEffect(() => {
    live.current.env = env;
    live.current.rows = rows;
  });

  const usesTexts = mode !== "ai_flexible";
  const setRow = (index: number, patch: Partial<Row>) => setRows((current) => current.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  const setRowById = (id: string, patch: Partial<Row>) => setRows((current) => current.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  const moveRow = (index: number, direction: -1 | 1) => setRows((current) => {
    const target = index + direction;
    if (target < 0 || target >= current.length) return current;
    const copy = [...current];
    [copy[index], copy[target]] = [copy[target], copy[index]];
    return copy;
  });
  const addRow = () => setRows((current) => {
    const id = `r${nextRowId.current}`;
    nextRowId.current += 1;
    return [...current, { id, text: "", date: current[current.length - 1]?.date ?? tomorrow, time: "09:00" }];
  });
  const removeRow = (id: string) => {
    if (assist?.rowId === id) closeAssist();
    setRows((current) => current.filter((row) => row.id !== id));
  };

  function openAssist(rowId: string) {
    live.current.awaiting = null;
    setAssist({ rowId, mode: "draft", notes: "", instruction: "", phase: "idle", request: null, outcome: null, edits: [], issue: null });
  }
  function closeAssist() {
    live.current.awaiting = null;
    setAssist(null);
  }
  function cancelAssist() {
    // The answer of the request already sent is dropped when it arrives; nothing changes in the rows.
    live.current.awaiting = null;
    setAssist((current) => current && { ...current, phase: "idle", request: null, outcome: null, edits: [] });
  }
  /** One press: a new request (new Idempotency-Key), or -- only after retry_same_key -- the very same request again. */
  function askAssist(sameKey: boolean) {
    // One request at a time (also against a double tap before the next render); one for an earlier session never blocks.
    if (!assist || assist.phase === "running" || (live.current.awaiting && live.current.awaiting.scope === scope)) return;
    const row = rows.find((item) => item.id === assist.rowId);
    if (!row) return closeAssist();
    const request = sameKey
      ? assist.request // offered only after retry_same_key: the stored request, same key and body
      : newAssistRequest(env, Crypto.randomUUID, row.id, assist.mode, row.text, assist);
    const answer = request ? sendAssist(env, request) : null;
    if (!request || !answer) {
      const issue = block ? ASSIST_BLOCK_TEXT[block] : assistInputIssue(assist.mode, row.text, assist) ?? "もう一度依頼してください。";
      setAssist({ ...assist, phase: "idle", request: null, outcome: null, edits: [], issue });
      return;
    }
    live.current.awaiting = request;
    setAssist({ ...assist, phase: "running", request, outcome: null, edits: [], issue: null });
    void answer.then((outcome) => {
      if (outcome.kind === "relogin") setRefusedToken(env.accessToken); // the token this request was sent with (this render)
      // Shown only if this request is still the panel's own: not after a cancel, close (also by removing the row or
      // switching to AI自動予約) or a newer request; one of another session / workspace is hidden above.
      if (live.current.awaiting === request) live.current.awaiting = null;
      setAssist((current) => (current && current.request === request
        ? { ...current, phase: "done", outcome, edits: outcome.kind === "candidates" ? outcome.candidates.map((candidate) => candidate.text) : [] }
        : current));
    });
  }
  /** The person adopts a candidate (as edited): only now does it become the row's text. It can be undone. */
  function adopt(index: number, withTags: boolean) {
    // Checked against the latest render (a button from an earlier frame keeps that frame's values).
    if (!assist || assist.phase !== "done" || assist.outcome?.kind !== "candidates" || assist.request?.scope !== assistScope(live.current.env)) return;
    const candidate = assist.outcome.candidates[index];
    const row = live.current.rows.find((item) => item.id === assist.rowId);
    if (!candidate || !row) return;
    const base = assist.mode === "hashtags" ? row.text : assist.edits[index] ?? "";
    const next = withTags ? withHashtags(base, candidate.hashtags) : base;
    setRowById(row.id, { text: next });
    setUndo({ rowId: row.id, before: row.text, after: next });
    closeAssist();
  }

  function renderAssist(row: Row) {
    if (!assist || assist.rowId !== row.id) return null;
    const running = assist.phase === "running";
    const outcome = assist.phase === "done" ? assist.outcome : null;
    const view = outcome ? assistOutcomeView(outcome) : null;
    return (
      <View style={{ gap: 6, borderWidth: 1, borderColor: colors.border, borderRadius: 8, padding: 8 }}>
        <Text style={{ color: colors.ink, fontWeight: "700" }}>AI投稿アシスト</Text>
        <Text style={styles.muted}>AIの案は、あなたが確認して「本文に使う」を押すまで本文に入りません。ここから予約や投稿はされません。</Text>
        {block ? (
          <View style={{ gap: 6 }}>
            <Pill tone="warning">{ASSIST_BLOCK_TEXT[block]}</Pill>
            {block === "workspace_unavailable" && env.retryWorkspaceSetup ? <SmallButton label="個人ワークスペースを再確認" onPress={env.retryWorkspaceSetup} /> : null}
          </View>
        ) : (
          <View style={{ gap: 6 }}>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
              {ASSIST_MODES.map((item) => (
                <Choice key={item.mode} label={item.label} selected={assist.mode === item.mode} disabled={running}
                  onPress={() => setAssist({ ...assist, mode: item.mode, phase: "idle", request: null, outcome: null, edits: [], issue: null })} />
              ))}
            </View>
            <Text style={styles.muted}>{ASSIST_MODES.find((item) => item.mode === assist.mode)?.detail}</Text>
            {assist.mode === "draft" ? (
              <TextInput accessibilityLabel="AIへのメモ" value={assist.notes} editable={!running} onChangeText={(notes) => setAssist({ ...assist, notes, issue: null })}
                placeholder="伝えたいこと・話題・トーンなど" multiline style={[inputStyle, { minHeight: 48 }]} />
            ) : null}
            {assist.mode === "refine" ? (
              <TextInput accessibilityLabel="書き直しの指示" value={assist.instruction} editable={!running} onChangeText={(instruction) => setAssist({ ...assist, instruction, issue: null })}
                placeholder="例: もっと短く、やわらかく" style={inputStyle} />
            ) : null}
            {running ? (
              <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
                <Text style={styles.muted}>AIが考えています…</Text>
                <SmallButton label="キャンセル" onPress={cancelAssist} />
              </View>
            ) : <SmallButton label="AIに依頼する" onPress={() => askAssist(false)} />}
            {assist.issue ? <Pill tone="danger">{assist.issue}</Pill> : null}
            {view ? (
              <View style={{ gap: 6 }}>
                <Pill tone={view.tone}>{view.text}</Pill>
                {view.retry === "same_key" ? <SmallButton label="再試行" onPress={() => askAssist(true)} /> : null}
                {view.retry === "new_key" ? <SmallButton label="もう一度依頼" onPress={() => askAssist(false)} /> : null}
              </View>
            ) : null}
            {outcome?.kind === "candidates" ? (
              <View style={{ gap: 8 }}>
                <Text style={styles.muted}>{outcome.notice}</Text>
                {outcome.candidates.map((candidate, index) => (
                  <View key={index} style={{ gap: 4, borderTopWidth: 1, borderColor: colors.border, paddingTop: 6 }}>
                    <Text style={{ color: colors.ink, fontWeight: "700" }}>案{index + 1}</Text>
                    {assist.mode === "hashtags" ? null : (
                      <TextInput accessibilityLabel={`案${index + 1}の本文`} value={assist.edits[index] ?? ""} multiline style={[inputStyle, { minHeight: 64 }]}
                        onChangeText={(text) => setAssist({ ...assist, edits: assist.edits.map((edit, i) => (i === index ? text : edit)) })} />
                    )}
                    {candidate.hashtags.length ? <Text style={styles.muted}>ハッシュタグ: {candidate.hashtags.join(" ")}</Text> : null}
                    {assist.mode === "hashtags" ? null : <Text style={styles.muted}>AIの案の長さ: {candidate.length}/{candidate.limit}（編集したら、プレビューで長さを確認してください）</Text>}
                    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                      {assist.mode === "hashtags" ? null : <SmallButton label="本文に使う" disabled={!(assist.edits[index] ?? "").trim()} onPress={() => adopt(index, false)} />}
                      {candidate.hashtags.length ? (
                        <SmallButton label={assist.mode === "hashtags" ? "タグを本文に追加" : "タグ付きで本文に使う"} disabled={assist.mode !== "hashtags" && !(assist.edits[index] ?? "").trim()} onPress={() => adopt(index, true)} />
                      ) : null}
                    </View>
                  </View>
                ))}
              </View>
            ) : null}
          </View>
        )}
        <SmallButton label="AIアシストを閉じる" onPress={closeAssist} />
      </View>
    );
  }

  function request(): BatchRequest {
    const texts = rows.map((row) => row.text);
    switch (mode) {
      case "manual_exact":
        return { mode, posts: rows.map((row) => ({ text: row.text, date: row.date, time: row.time })) };
      case "manual_random_batch":
        return { mode, texts, dateFrom, dateTo, window: { start: windowStart, end: windowEnd }, weekdays, shuffleContent: shuffle };
      case "manual_interval":
        return { mode, texts, startDate, startTime, every: { unit: everyUnit, value: Number(everyValue) } };
      case "ai_flexible":
        return { mode, frequencyTargetPerWeek: ai.frequencyTargetPerWeek, publishWindow: { start: windowStart, end: windowEnd }, dateFrom, dateTo, approvalMode: ai.approvalMode };
    }
  }

  function preview() {
    const result = planBatch(request(), { ...context, batchId: `local-${Date.now().toString(36)}` });
    if (!result.ok) {
      setIssues(result.issues);
      return;
    }
    setIssues([]);
    onPlanned(result);
  }

  return (
    <Card>
      <Text style={{ color: colors.ink, fontWeight: "800" }}>投稿を作成（プレビュー）</Text>
      <Text style={styles.muted}>ここで作るのは、この画面だけのプレビューです。保存も投稿もされません。</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {MODES.map((item) => (
          <Choice key={item.mode} label={item.label} selected={mode === item.mode} onPress={() => {
            if (item.mode === "ai_flexible") closeAssist();
            setMode(item.mode);
            setIssues([]);
          }} />
        ))}
      </View>
      <Text style={styles.muted}>{MODES.find((item) => item.mode === mode)?.detail}</Text>

      {usesTexts ? (
        <View style={{ gap: 10 }}>
          {rows.map((row, index) => (
            <View key={row.id} style={{ gap: 6, borderTopWidth: index ? 1 : 0, borderColor: colors.border, paddingTop: index ? 10 : 0 }}>
              <Text style={{ color: colors.ink, fontWeight: "700" }}>{index + 1}件目</Text>
              <TextInput accessibilityLabel={`${index + 1}件目の本文`} value={row.text} onChangeText={(text) => setRow(index, { text })} placeholder="投稿する本文" multiline style={[inputStyle, { minHeight: 64 }]} />
              {mode === "manual_exact" ? (
                <View style={{ flexDirection: "row", gap: 8 }}>
                  <Field label="日付" value={row.date} onChange={(date) => setRow(index, { date })} placeholder="2026-10-15" />
                  <Field label="時刻" value={row.time} onChange={(time) => setRow(index, { time })} placeholder="09:00" />
                </View>
              ) : null}
              <View style={{ flexDirection: "row", gap: 8 }}>
                <SmallButton label="↑" disabled={index === 0} onPress={() => moveRow(index, -1)} />
                <SmallButton label="↓" disabled={index === rows.length - 1} onPress={() => moveRow(index, 1)} />
                <SmallButton label="削除" disabled={rows.length === 1} onPress={() => removeRow(row.id)} />
                <SmallButton label="AIアシスト" disabled={assist?.phase === "running"} onPress={() => openAssist(row.id)} />
              </View>
              {undo?.rowId === row.id && row.text === undo.after ? (
                <View style={{ flexDirection: "row", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <Text style={styles.muted}>AIの案を本文に入れました。確認・編集してから「プレビューを作成」を押してください。</Text>
                  <SmallButton label="元に戻す" onPress={() => { setRowById(row.id, { text: undo.before }); setUndo(null); }} />
                </View>
              ) : null}
              {renderAssist(row)}
            </View>
          ))}
          <SmallButton label="＋ 本文を追加" disabled={rows.length >= 50} onPress={addRow} />
        </View>
      ) : (
        <View style={{ gap: 4 }}>
          <Text style={{ color: colors.ink }}>週あたりの投稿回数: {ai.frequencyTargetPerWeek}回</Text>
          <Text style={styles.muted}>{AI_STATUS_TEXT[ai.status]}</Text>
          <Text style={styles.muted}>本文は投稿の直前にAIが作成します。ここでは投稿する枠だけを作ります。</Text>
          <Pill tone="warning">
            {ai.source === "saved" && ai.approvalMode === "auto_post_preference"
              ? "自動投稿の同意: 設定画面で選択済み（それでも、このプレビューからは投稿されません）"
              : "自動投稿の同意: なし。AI相談の「これで覚えて」は自動投稿の同意になりません"}
          </Pill>
        </View>
      )}

      {mode === "manual_random_batch" || mode === "ai_flexible" ? (
        <View style={{ gap: 8 }}>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Field label="開始日" value={dateFrom} onChange={setDateFrom} placeholder="2026-10-15" />
            <Field label="終了日" value={dateTo} onChange={setDateTo} placeholder="2026-10-25" />
          </View>
          <Text style={styles.muted}>{mode === "ai_flexible" ? "投稿する時間帯（AIが本文を作る時刻とは別です）" : "投稿してよい時間帯"}</Text>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Field label="から" value={windowStart} onChange={setWindowStart} placeholder="09:00" />
            <Field label="まで" value={windowEnd} onChange={setWindowEnd} placeholder="21:00" />
          </View>
        </View>
      ) : null}

      {mode === "manual_random_batch" ? (
        <View style={{ gap: 8 }}>
          <Text style={styles.muted}>曜日（選ばなければ毎日）</Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
            {WEEKDAYS.map((label, day) => (
              <Choice key={label} label={label} selected={weekdays.includes(day)} onPress={() => setWeekdays((current) => (current.includes(day) ? current.filter((d) => d !== day) : [...current, day].sort()))} />
            ))}
          </View>
          <Choice label={shuffle ? "本文の順番: ランダム" : "本文の順番: 入力した順"} selected={shuffle} onPress={() => setShuffle((value) => !value)} />
        </View>
      ) : null}

      {mode === "manual_interval" ? (
        <View style={{ gap: 8 }}>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Field label="開始日" value={startDate} onChange={setStartDate} placeholder="2026-10-15" />
            <Field label="開始時刻" value={startTime} onChange={setStartTime} placeholder="12:00" />
          </View>
          <View style={{ flexDirection: "row", gap: 8, alignItems: "flex-end" }}>
            <Field label="間隔" value={everyValue} onChange={setEveryValue} placeholder="1" />
            <Choice label="日ごと" selected={everyUnit === "days"} onPress={() => setEveryUnit("days")} />
            <Choice label="時間ごと" selected={everyUnit === "hours"} onPress={() => setEveryUnit("hours")} />
          </View>
        </View>
      ) : null}

      {issues.length ? (
        <View style={{ gap: 4 }}>
          {issues.map((issue, index) => <Pill key={index} tone="danger">{issue.message}</Pill>)}
        </View>
      ) : null}
      <ActionButton label="プレビューを作成" onPress={preview} />
      <ActionButton label="閉じる" onPress={onClose} />
    </Card>
  );
}

function Field({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (value: string) => void; placeholder: string }) {
  return (
    <View style={{ flex: 1, gap: 2 }}>
      <Text style={styles.muted}>{label}</Text>
      <TextInput accessibilityLabel={label} value={value} onChangeText={onChange} placeholder={placeholder} autoCapitalize="none" style={inputStyle} />
    </View>
  );
}

function Choice({ label, selected, onPress, disabled = false }: { label: string; selected: boolean; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ selected, disabled }} disabled={disabled} onPress={onPress}
      style={{ borderWidth: 1, borderColor: selected ? colors.primary : colors.border, backgroundColor: selected ? colors.primarySoft : colors.surface, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6, opacity: disabled ? 0.4 : 1 }}>
      <Text style={{ color: selected ? colors.primary : colors.ink, fontWeight: selected ? "800" : "500" }}>{label}</Text>
    </Pressable>
  );
}

export function SmallButton({ label, onPress, disabled = false }: { label: string; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
      style={{ borderWidth: 1, borderColor: colors.border, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4, opacity: disabled ? 0.4 : 1 }}>
      <Text style={{ color: colors.ink }}>{label}</Text>
    </Pressable>
  );
}

const inputStyle = { borderColor: colors.border, borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, color: colors.ink, backgroundColor: "#FFFFFF" };
