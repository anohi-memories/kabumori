import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { ActivityIndicator, ScrollView, Text, TextInput, View } from "react-native";
import { colors } from "@/constants/theme";
import { ActionButton, Card, Pill, Screen, SectionTitle, styles } from "@/components/ui";
import { mockRepository } from "@/data/mock-repository";
import { requestConsult } from "@/data/consult-client";
import { SupabaseContentSettingsRepository } from "@/data/content-settings-repository";
import { supabase } from "@/lib/supabase";
import { SOCIAL_MOBILE_CONTENT_DEFAULTS } from "@/domain/content-settings";
import { applyConfirmedConversationProposal, createConversationalAssistantProposal, validateConversationalAssistantResult } from "@/domain/content-settings-conversation";
import {
  CONSULT_LIMITS,
  consultFailure,
  consultInputProblem,
  consultReducer,
  initialConsultState,
  planConfirmedSave,
  priorTurns,
  proposalRows,
  type ConsultOutcome,
  type SavedSnapshot,
} from "@/domain/consult-session";
import { useAuth } from "@/providers/auth-provider";
import { useDataStatus } from "@/providers/data-provider";

const GREETING = [{ role: "assistant" as const, text: "こんにちは。投稿のことなら、なんでも気軽に話しかけてください。どんな発信にしたいか、一緒に整理していきます。" }];
const SAVED_TEXT = "確認した内容を保存しました。投稿権限や投稿実行は変更していません。";
const REBASE_TEXT = "保存されている設定が、この提案のあとに変わっていました。内容を確認して、もう一度「これで覚えて」を押してください。";

/** `epoch` is the consultation session the snapshot was read in; it is never used across sessions. */
type Saved = SavedSnapshot & { updatedAt: string | null; epoch: number };
const emptySaved = (epoch: number): Saved => ({ settings: SOCIAL_MOBILE_CONTENT_DEFAULTS, persona: null, updatedAt: null, epoch });

/** Captured when async work starts; `isCurrent` is true only while that same workspace session is shown. */
function captureSession(sessionBrand: { current: string | undefined }, sessionEpoch: { current: number }, brandId: string | undefined) {
  const epoch = sessionEpoch.current;
  return { epoch, isCurrent: () => sessionBrand.current === brandId && sessionEpoch.current === epoch };
}

export default function ConsultScreen() {
  const { status, snapshot } = useDataStatus();
  const { session } = useAuth();
  const brandId = snapshot?.workspace?.id;
  const accessToken = session?.access_token;
  const repository = useMemo(() => (supabase ? new SupabaseContentSettingsRepository(supabase) : null), []);
  // Sample-data preview has no backend: it keeps the deterministic local stand-in and saves nothing.
  const preview = status === "mock_preview";

  const [state, dispatch] = useReducer(consultReducer, undefined, () =>
    initialConsultState(status === "mock_preview" ? mockRepository.getConsultation().messages : GREETING));
  const [message, setMessage] = useState("");
  const [historyConfirmation, setHistoryConfirmation] = useState(false);
  const [saving, setSaving] = useState(false);
  // What is saved right now, as far as this screen knows. A proposal is always
  // applied onto a fresh re-read of this, never onto hardcoded defaults.
  const [saved, setSaved] = useState<Saved>(() => emptySaved(0));
  const savedRef = useRef(saved);
  useEffect(() => {
    savedRef.current = saved;
  }, [saved]);
  // A consultation belongs to one workspace session. Every workspace change starts a new session
  // with a new epoch -- also a return to a workspace shown before (A -> B -> A) -- and drops the old
  // conversation and proposal. An async task captures the workspace and the epoch it started in and
  // checks both after every await, so an answer, a read or a save completion from an earlier session
  // never changes this one. Ignoring a completion does not cancel a request already sent: a save that
  // reached the server stays saved; only its result is not shown.
  const sessionBrand = useRef(brandId);
  const sessionEpoch = useRef(0);
  const savingRef = useRef(false);
  useEffect(() => {
    if (sessionBrand.current === brandId) return;
    sessionBrand.current = brandId;
    sessionEpoch.current += 1;
    savingRef.current = false;
    dispatch({ type: "reset", greeting: GREETING });
    setMessage("");
    setHistoryConfirmation(false);
    setSaving(false);
    setSaved(emptySaved(sessionEpoch.current));
  }, [brandId]);

  useEffect(() => {
    if (status !== "ready" || !brandId || !repository) return;
    let cancelled = false;
    const session = captureSession(sessionBrand, sessionEpoch, brandId);
    void repository.read(brandId).then((result) => {
      if (!cancelled && session.isCurrent() && result.state === "ready") setSaved({ settings: result.data, persona: result.persona, updatedAt: result.updatedAt, epoch: session.epoch });
    });
    return () => {
      cancelled = true;
    };
  }, [brandId, repository, status]);

  /** One model call per send. The answer is only shown; saving needs the confirmation below. */
  async function ask(text: string, prior: ReturnType<typeof priorTurns>) {
    if (preview) {
      const local = validateConversationalAssistantResult(createConversationalAssistantProposal({ currentSettings: savedRef.current.settings, currentPersona: savedRef.current.persona, userUtterance: text }));
      if (local) dispatch({ type: "reply", result: local, shownAgainst: savedRef.current });
      else dispatch({ type: "failed", error: consultFailure("CONSULT_RESPONSE_INVALID") });
      return;
    }
    if (!supabase || !repository || !brandId || !accessToken || status !== "ready") {
      dispatch({ type: "failed", error: consultFailure("CONSULT_CONFIGURATION_UNAVAILABLE") });
      return;
    }
    const session = captureSession(sessionBrand, sessionEpoch, brandId);
    const [outcome, fresh]: [ConsultOutcome, Awaited<ReturnType<typeof repository.read>>] = await Promise.all([
      requestConsult(supabase, accessToken, { brandId, message: text, priorTurns: prior }),
      repository.read(brandId),
    ]);
    if (!session.isCurrent()) return;
    // If this workspace could not be re-read, fall back only to what was read in this same session;
    // never to another session's (possibly another workspace's) saved settings.
    const known = savedRef.current.epoch === session.epoch ? savedRef.current : emptySaved(session.epoch);
    const base: Saved = fresh.state === "ready" ? { settings: fresh.data, persona: fresh.persona, updatedAt: fresh.updatedAt, epoch: session.epoch } : known;
    if (fresh.state === "ready") setSaved(base);
    if (outcome.ok) dispatch({ type: "reply", result: outcome.result, shownAgainst: { settings: base.settings, persona: base.persona } });
    else dispatch({ type: "failed", error: outcome.error });
  }

  function send() {
    const text = message.trim();
    if (state.sending || consultInputProblem(text)) return;
    const prior = priorTurns(state);
    dispatch({ type: "send", text });
    setMessage("");
    void ask(text, prior);
  }

  function retry() {
    if (!state.failed || state.sending) return;
    const prior = priorTurns(state, true);
    const text = state.failed.text;
    dispatch({ type: "retry" });
    void ask(text, prior);
  }

  /** The only path that saves: the user pressed 「これで覚えて」 on a visible proposal. */
  async function confirmProposal() {
    const pending = state.pending;
    // Single flight: a second press before the first save finishes does nothing.
    if (!pending || savingRef.current) return;
    if (preview) {
      const applied = applyConfirmedConversationProposal(saved.settings, saved.persona, pending.result);
      setSaved({ settings: applied.settings, persona: applied.persona, updatedAt: null, epoch: sessionEpoch.current });
      dispatch({ type: "saved", text: "ローカルプレビューとして確認しました。実データへはまだ保存していません。" });
      return;
    }
    // A signed-in workspace that cannot be reached right now is not a preview: nothing is saved, and the
    // screen must not suggest that it was.
    if (!repository || !brandId || status !== "ready") {
      dispatch({ type: "save_failed", text: "いまは保存できません。時間をおいて、もう一度お試しください。" });
      return;
    }
    const session = captureSession(sessionBrand, sessionEpoch, brandId);
    const stillSameWorkspace = session.isCurrent;
    savingRef.current = true;
    setSaving(true);
    try {
      const latest = await repository.read(brandId);
      if (!stillSameWorkspace()) return;
      if (latest.state !== "ready") {
        dispatch({ type: "save_failed", text: latest.reason });
        return;
      }
      const latestSnapshot = { settings: latest.data, persona: latest.persona };
      setSaved({ ...latestSnapshot, updatedAt: latest.updatedAt, epoch: session.epoch });
      const plan = planConfirmedSave({ shownAgainst: pending.shownAgainst, latest: latestSnapshot, proposal: pending.result });
      if (plan.kind === "nothing") {
        dispatch({ type: "save_failed", text: "保存できる変更がありませんでした。" });
        return;
      }
      if (plan.kind === "reconfirm") {
        dispatch({ type: "rebase_proposal", shownAgainst: latestSnapshot, text: REBASE_TEXT });
        return;
      }
      const result = await repository.saveConfirmedIfUnchanged(brandId, plan.settings, plan.personaChanged ? plan.persona : null, latest.updatedAt);
      if (!stillSameWorkspace()) return;
      if (result.ok) {
        const after = await repository.read(brandId);
        if (!stillSameWorkspace()) return;
        setSaved(after.state === "ready" ? { settings: after.data, persona: after.persona, updatedAt: after.updatedAt, epoch: session.epoch } : { settings: plan.settings, persona: plan.persona, updatedAt: null, epoch: session.epoch });
        dispatch({ type: "saved", text: SAVED_TEXT });
      } else if (result.stale) {
        const again = await repository.read(brandId);
        if (!stillSameWorkspace()) return;
        if (again.state === "ready") {
          setSaved({ settings: again.data, persona: again.persona, updatedAt: again.updatedAt, epoch: session.epoch });
          dispatch({ type: "rebase_proposal", shownAgainst: { settings: again.data, persona: again.persona }, text: REBASE_TEXT });
        } else dispatch({ type: "save_failed", text: result.reason });
      } else {
        dispatch({ type: "save_failed", text: result.reason });
      }
    } finally {
      if (stillSameWorkspace()) {
        savingRef.current = false;
        setSaving(false);
      }
    }
  }

  const problem = consultInputProblem(message);
  const rows = state.pending ? proposalRows(state.pending.result) : [];

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ gap: 16 }} keyboardShouldPersistTaps="handled">
        <SectionTitle detail="あなたの代打AIと相談し、理解した内容を確認してから覚えさせます。">
          あなたの投稿AI
        </SectionTitle>
        <View style={{ gap: 10 }}>
          {state.messages.map((item) => (
            <Card key={item.id} style={{ alignSelf: item.role === "user" ? "flex-end" : "stretch", backgroundColor: item.role === "user" ? colors.primarySoft : colors.surface, maxWidth: "92%" }}>
              <Text style={{ color: colors.ink }}>{item.text}</Text>
            </Card>
          ))}
          {state.sending ? (
            <Card>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <ActivityIndicator color={colors.primary} />
                <Text style={styles.muted}>AIが考えています…</Text>
              </View>
            </Card>
          ) : null}
          {state.failed ? (
            <Card>
              <Pill tone="warning">{state.failed.error.message}</Pill>
              {state.failed.error.retryable ? <ActionButton label="もう一度送る" onPress={retry} disabled={state.sending} /> : null}
            </Card>
          ) : null}
        </View>
        <Card>
          <Text style={{ color: colors.ink, fontWeight: "800" }}>自然な言葉で伝える</Text>
          <Text style={styles.muted}>例：「今日なにを投稿しよう」「週3回、専門的すぎない文章で」「今どういう設定？」「過去の自分の投稿を読んで」</Text>
          <TextInput value={message} onChangeText={setMessage} placeholder="AIに話しかける" style={inputStyle} multiline maxLength={CONSULT_LIMITS.messageChars + 200} editable={!state.sending} />
          {problem === "too_long" ? <Text style={styles.muted}>{CONSULT_LIMITS.messageChars}文字以内で入力してください。</Text> : null}
          <ActionButton label={state.sending ? "送信中…" : "送信"} onPress={send} disabled={state.sending || problem !== null} />
        </Card>
        {state.pending ? (
          <Card>
            <Text style={{ color: colors.primary, fontWeight: "800" }}>AIが理解した内容（保存前の確認）</Text>
            <Text style={styles.muted}>まだ保存していません。変わるのは次の項目だけです。</Text>
            {rows.map((row) => <Text key={row.key} style={{ color: colors.ink }}>{row.label}: {row.value}</Text>)}
            <ActionButton label={saving ? "保存中…" : "これで覚えて"} onPress={() => void confirmProposal()} disabled={saving} />
            <ActionButton label="この提案をやめる" onPress={() => dispatch({ type: "dismiss_proposal" })} disabled={saving} />
            <Text style={styles.muted}>違う場合は、自然な言葉で言い直すと最新の提案が優先されます。</Text>
          </Card>
        ) : null}
        {state.notice ? <Pill tone={state.notice.tone}>{state.notice.text}</Pill> : null}
        {state.historyIntent ? (
          <Card>
            <Pill tone="warning">対象アカウント: 接続済みで本人確認済みのXアカウント / 最大50件・2ページ</Pill>
            <Text style={styles.muted}>学習するのは文体・語彙・記号の傾向です。投稿本文は保存せず、この操作でX投稿も行いません。</Text>
            <ActionButton label={historyConfirmation ? "過去投稿の取得同意を確認済み" : "過去の投稿を読み込む前に確認"} onPress={() => setHistoryConfirmation(true)} />
            {historyConfirmation ? <Text style={styles.muted}>この候補画面では外部取得を実行しません。次の確認画面で明示同意後に、上限付きの取得処理へ進みます。</Text> : null}
          </Card>
        ) : null}
        <Card>
          <Text style={{ color: colors.ink, fontWeight: "800" }}>投稿権限は別管理</Text>
          <Text style={styles.muted}>この会話やペルソナ更新から、自動投稿ON・X投稿・投稿予定作成は行いません。</Text>
        </Card>
      </ScrollView>
    </Screen>
  );
}

const inputStyle = { borderColor: colors.border, borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 9, color: colors.ink, backgroundColor: "#FFFFFF", minHeight: 72, textAlignVertical: "top" as const };
