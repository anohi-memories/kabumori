import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { colors } from "@/constants/theme";
import { ActionButton, Card, Pill, styles } from "@/components/ui";
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

export type AiPlanningInput = { frequencyTargetPerWeek: number; approvalMode: string; source: "saved" | "default" };

type Row = { text: string; date: string; time: string };

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
  const [rows, setRows] = useState<Row[]>([{ text: "", date: tomorrow, time: "09:00" }]);
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

  const usesTexts = mode !== "ai_flexible";
  const setRow = (index: number, patch: Partial<Row>) => setRows((current) => current.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  const moveRow = (index: number, direction: -1 | 1) => setRows((current) => {
    const target = index + direction;
    if (target < 0 || target >= current.length) return current;
    const copy = [...current];
    [copy[index], copy[target]] = [copy[target], copy[index]];
    return copy;
  });

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
          <Choice key={item.mode} label={item.label} selected={mode === item.mode} onPress={() => { setMode(item.mode); setIssues([]); }} />
        ))}
      </View>
      <Text style={styles.muted}>{MODES.find((item) => item.mode === mode)?.detail}</Text>

      {usesTexts ? (
        <View style={{ gap: 10 }}>
          {rows.map((row, index) => (
            <View key={index} style={{ gap: 6, borderTopWidth: index ? 1 : 0, borderColor: colors.border, paddingTop: index ? 10 : 0 }}>
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
                <SmallButton label="削除" disabled={rows.length === 1} onPress={() => setRows((current) => current.filter((_, i) => i !== index))} />
              </View>
            </View>
          ))}
          <SmallButton label="＋ 本文を追加" disabled={rows.length >= 50} onPress={() => setRows((current) => [...current, { text: "", date: current[current.length - 1]?.date ?? tomorrow, time: "09:00" }])} />
        </View>
      ) : (
        <View style={{ gap: 4 }}>
          <Text style={{ color: colors.ink }}>週あたりの投稿回数: {ai.frequencyTargetPerWeek}回（{ai.source === "saved" ? "AI相談で覚えた設定" : "初期設定"}）</Text>
          <Text style={styles.muted}>本文は投稿の直前にAIが作成します。ここでは投稿する枠だけを作ります。</Text>
          <Pill tone="warning">
            {ai.approvalMode === "auto_post_preference"
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

function Choice({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ selected }} onPress={onPress}
      style={{ borderWidth: 1, borderColor: selected ? colors.primary : colors.border, backgroundColor: selected ? colors.primarySoft : colors.surface, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6 }}>
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
