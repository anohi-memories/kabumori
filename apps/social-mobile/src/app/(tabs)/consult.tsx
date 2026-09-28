import { useEffect, useMemo, useState } from "react";
import { ScrollView, Text, TextInput, View } from "react-native";
import { colors } from "@/constants/theme";
import { ActionButton, Card, Pill, Screen, SectionTitle, styles } from "@/components/ui";
import { mockRepository } from "@/data/mock-repository";
import { SupabaseContentSettingsRepository } from "@/data/content-settings-repository";
import { supabase } from "@/lib/supabase";
import { SOCIAL_MOBILE_CONTENT_DEFAULTS, type PersonaProfile, type SocialMobileContentSettings } from "@/domain/content-settings";
import {
  applyConfirmedConversationProposal,
  createConversationalAssistantProposal,
  type ConversationalAssistantResult,
} from "@/domain/content-settings-conversation";
import { useDataStatus } from "@/providers/data-provider";

type ChatMessage = { id: string; role: "assistant" | "user"; text: string };

export default function ConsultScreen() {
  const { status, snapshot } = useDataStatus();
  const brandId = snapshot?.workspace?.id;
  const repository = useMemo(() => (supabase ? new SupabaseContentSettingsRepository(supabase) : null), []);

  const initial = mockRepository.getConsultation().messages;
  const [messages, setMessages] = useState<ChatMessage[]>(initial);
  const [message, setMessage] = useState("");
  const [proposal, setProposal] = useState<ConversationalAssistantResult | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [historyConfirmation, setHistoryConfirmation] = useState(false);
  // The base to propose/apply changes onto. Starting from the hardcoded
  // defaults instead of the actually-saved settings would silently reset any
  // unrelated field (e.g. frequency) back to default the moment a proposal is
  // confirmed, so this is loaded the same way the settings screen loads it.
  const [baseSettings, setBaseSettings] = useState<SocialMobileContentSettings>(SOCIAL_MOBILE_CONTENT_DEFAULTS);
  const [persona, setPersona] = useState<PersonaProfile | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  useEffect(() => {
    if (status !== "ready" || !brandId || !repository) return;
    let cancelled = false;
    void repository.read(brandId).then((result) => {
      if (cancelled) return;
      if (result.state === "ready") {
        setBaseSettings(result.data);
        setPersona(result.persona);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [brandId, repository, status]);

  function propose() {
    const text = message.trim();
    if (!text) return;
    const next = createConversationalAssistantProposal({
      currentSettings: baseSettings,
      currentPersona: persona,
      userUtterance: text,
    });
    setMessages((current) => [
      ...current,
      { id: `user-${Date.now()}`, role: "user", text },
      { id: `assistant-${Date.now()}`, role: "assistant", text: next.assistantReply },
    ]);
    setProposal(next);
    setConfirmed(false);
    setHistoryConfirmation(false);
    setSaveMessage(null);
  }

  async function confirmProposal() {
    if (!proposal || saving) return;
    const applied = applyConfirmedConversationProposal(baseSettings, persona, proposal);
    setBaseSettings(applied.settings);
    setPersona(applied.persona);
    setConfirmed(true);

    const hasSettingsChange = Object.keys(proposal.proposedSettingsDelta).length > 0;
    if (!hasSettingsChange && !applied.persona) {
      // Nothing settings- or persona-shaped to confirm this turn (e.g. only a
      // follow-up question was asked); there is nothing to save yet.
      setSaveMessage("確認しましたが、保存する内容がまだありません。");
      return;
    }
    if (!repository || !brandId || status !== "ready") {
      setSaveMessage("ローカルプレビューとして確認しました。実データへはまだ保存していません。");
      return;
    }
    setSaving(true);
    // A persona-bearing confirmation saves both together (persona must not be
    // erased by a settings-only save); otherwise it is a settings-only save,
    // the same call the settings screen uses.
    const result = applied.persona
      ? await repository.saveConfirmedProposal(brandId, applied.settings, applied.persona)
      : await repository.upsert(brandId, applied.settings);
    setSaving(false);
    setSaveMessage(result.ok ? "確認した内容を保存しました。投稿権限や投稿実行は変更していません。" : result.reason);
  }

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ gap: 16 }}>
        <SectionTitle detail="あなたの代打AIと相談し、理解した内容を確認してから覚えさせます。">
          あなたの投稿AI
        </SectionTitle>
        <View style={{ gap: 10 }}>
          {messages.map((item) => (
            <Card key={item.id} style={{ alignSelf: item.role === "user" ? "flex-end" : "stretch", backgroundColor: item.role === "user" ? colors.primarySoft : colors.surface, maxWidth: "92%" }}>
              <Text style={{ color: colors.ink }}>{item.text}</Text>
            </Card>
          ))}
        </View>
        <Card>
          <Text style={{ color: colors.ink, fontWeight: "800" }}>自然な言葉で伝える</Text>
          <Text style={styles.muted}>例：「週3回、専門的すぎない文章で」「過去の自分の投稿を読んで」</Text>
          <TextInput value={message} onChangeText={setMessage} placeholder="AIに希望を伝える" style={inputStyle} multiline />
          <ActionButton label="理解した内容を確認" onPress={propose} />
        </Card>
        {proposal ? (
          <Card>
            <Text style={{ color: colors.primary, fontWeight: "800" }}>理解した内容（保存前の確認）</Text>
            {proposal.proposedSettingsDelta.preferredTone ? <Text style={styles.muted}>トーン: {proposal.proposedSettingsDelta.preferredTone}</Text> : null}
            {proposal.proposedSettingsDelta.frequencyTargetPerWeek !== undefined ? <Text style={styles.muted}>週あたり: {proposal.proposedSettingsDelta.frequencyTargetPerWeek}回</Text> : null}
            {proposal.proposedPersonaDelta.punctuationEmoji ? <Text style={styles.muted}>記号・絵文字: {proposal.proposedPersonaDelta.punctuationEmoji}</Text> : null}
            {proposal.followUpQuestions.map((question) => <Text key={question} style={styles.muted}>{question}</Text>)}
            <ActionButton label={saving ? "保存中…" : confirmed ? "覚えた内容を確認済み" : "これで覚えて"} onPress={() => void confirmProposal()} />
            {saveMessage ? <Pill tone={saveMessage.includes("保存しました") ? "success" : "warning"}>{saveMessage}</Pill> : null}
            {proposal.historyLearningIntent.explicitConsent ? (
              <View style={{ gap: 8 }}>
                <Pill tone="warning">対象アカウント: 接続済みで本人確認済みのXアカウント / 最大50件・2ページ</Pill>
                <Text style={styles.muted}>学習するのは文体・語彙・記号の傾向です。投稿本文は保存せず、この操作でX投稿も行いません。</Text>
                <ActionButton label={historyConfirmation ? "過去投稿の取得同意を確認済み" : "過去の投稿を読み込む前に確認"} onPress={() => setHistoryConfirmation(true)} />
                {historyConfirmation ? <Text style={styles.muted}>この候補画面では外部取得を実行しません。次の確認画面で明示同意後に、上限付きの取得処理へ進みます。</Text> : null}
              </View>
            ) : null}
            <Text style={styles.muted}>違う場合は、自然な言葉で言い直すと最新の提案が優先されます。</Text>
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
