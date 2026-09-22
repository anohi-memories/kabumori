import { useState } from 'react';
import { ScrollView, Text, TextInput, View } from 'react-native';
import { colors } from '@/constants/theme';
import { ActionButton, Card, Pill, Screen, SectionTitle, styles } from '@/components/ui';
import { mockRepository } from '@/data/mock-repository';
import { SOCIAL_MOBILE_CONTENT_DEFAULTS } from '@/domain/content-settings';
import { parsePastPostLearningRequest, proposeContentSettingsFromConversation, type ConversationalSettingsProposal } from '@/domain/content-settings-conversation';

export default function ConsultScreen() {
  const { messages } = mockRepository.getConsultation();
  const [message, setMessage] = useState('');
  const [proposal, setProposal] = useState<ConversationalSettingsProposal | null>(null);
  const [pastPostConsent, setPastPostConsent] = useState(false);
  function propose() {
    const request = parsePastPostLearningRequest(message);
    setPastPostConsent(request.explicitConsent);
    setProposal(proposeContentSettingsFromConversation(message, SOCIAL_MOBILE_CONTENT_DEFAULTS));
  }
  return <Screen><ScrollView contentContainerStyle={{ gap: 16 }}><SectionTitle detail="あなたの代打AIと相談し、理解した内容を確認してから保存します。">あなたの投稿AI</SectionTitle><View style={{ gap: 10 }}>{messages.map((item) => <Card key={item.id} style={{ alignSelf: item.role === 'user' ? 'flex-end' : 'stretch', backgroundColor: item.role === 'user' ? colors.primarySoft : colors.surface, maxWidth: '92%' }}><Text style={{ color: colors.ink }}>{item.text}</Text></Card>)}</View><Card><Text style={{ color: colors.ink, fontWeight: '800' }}>自然な言葉で伝える</Text><Text style={styles.muted}>例：「週3回、専門的すぎない文章で」「過去の自分の投稿を読んで」</Text><TextInput value={message} onChangeText={setMessage} placeholder="AIに希望を伝える" style={inputStyle} multiline /><ActionButton label="理解した内容を確認" onPress={propose} /></Card>{proposal ? <Card><Text style={{ color: colors.primary, fontWeight: '800' }}>変更案（保存前の確認）</Text>{proposal.changes.preferredTone ? <Text style={styles.muted}>トーン: {proposal.changes.preferredTone}</Text> : null}{proposal.changes.frequencyTargetPerWeek !== undefined ? <Text style={styles.muted}>週あたり: {proposal.changes.frequencyTargetPerWeek}回</Text> : null}{proposal.questions.map((question) => <Text key={question} style={styles.muted}>{question}</Text>)}{pastPostConsent ? <Pill tone="warning">過去投稿の分析は明示同意後に実行します。今回はAPIを呼びません。</Pill> : null}<Text style={styles.muted}>内容を修正する場合は、自然な言葉で言い直してください。保存は設定画面で確認してから行います。</Text></Card> : null}<Card><Text style={{ color: colors.ink, fontWeight: '800' }}>投稿権限は別管理</Text><Text style={styles.muted}>この会話やペルソナ更新から、自動投稿ON・X投稿・投稿予定作成は行いません。</Text></Card></ScrollView></Screen>;
}

const inputStyle = { borderColor: colors.border, borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 9, color: colors.ink, backgroundColor: '#FFFFFF', minHeight: 72, textAlignVertical: 'top' as const };
