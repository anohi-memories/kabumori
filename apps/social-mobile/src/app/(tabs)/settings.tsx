import { useEffect, useMemo, useState } from 'react';
import { ScrollView, Text, TextInput } from 'react-native';
import { Link } from 'expo-router';
import { supabase } from '@/lib/supabase';
import { SupabaseContentSettingsRepository } from '@/data/content-settings-repository';
import { SOCIAL_MOBILE_CONTENT_DEFAULTS, type SocialMobileContentSettings, validateSocialMobileContentSettings } from '@/domain/content-settings';
import { colors } from '@/constants/theme';
import { ActionButton, Card, Pill, Screen, SectionTitle, styles } from '@/components/ui';
import { SignOutButton } from '@/components/sign-out-button';
import { useDataStatus } from '@/providers/data-provider';

function fieldValue(settings: SocialMobileContentSettings) {
  return { tone: settings.preferredTone, themes: settings.themes.join('、'), objective: settings.objective, frequency: String(settings.frequencyTargetPerWeek), generationTime: settings.generationWindow.defaultGenerationLocal, ngWords: settings.optionalNgWords.join('、'), notes: settings.notes };
}

export default function SettingsScreen() {
  const { status, snapshot } = useDataStatus();
  const brandId = snapshot?.workspace?.id;
  const repository = useMemo(() => supabase ? new SupabaseContentSettingsRepository(supabase) : null, []);
  const [settings, setSettings] = useState<SocialMobileContentSettings>(SOCIAL_MOBILE_CONTENT_DEFAULTS);
  const [fields, setFields] = useState(() => fieldValue(SOCIAL_MOBILE_CONTENT_DEFAULTS));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (status !== 'ready' || !brandId || !repository) return;
    let cancelled = false;
    void repository.read(brandId).then((result) => {
      if (cancelled) return;
      if (result.state === 'ready') { setSettings(result.data); setFields(fieldValue(result.data)); setMessage(null); } else setMessage(result.reason);
    });
    return () => { cancelled = true; };
  }, [brandId, repository, status]);

  function updateField(key: keyof ReturnType<typeof fieldValue>, value: string) { setFields((current) => ({ ...current, [key]: value })); setMessage(null); }

  async function save() {
    const next = { ...settings, preferredTone: fields.tone, themes: fields.themes.split(/[、,]/u).map((item) => item.trim()).filter(Boolean), objective: fields.objective, frequencyTargetPerWeek: Number(fields.frequency), generationWindow: { ...settings.generationWindow, defaultGenerationLocal: fields.generationTime }, optionalNgWords: fields.ngWords.split(/[、,]/u).map((item) => item.trim()).filter(Boolean), notes: fields.notes };
    const parsed = validateSocialMobileContentSettings(next);
    if (!parsed.ok) { setMessage(parsed.reason); return; }
    setSaving(true);
    if (!repository || !brandId) { setSettings(parsed.value); setMessage('ローカルプレビューとして保存しました。実データへはまだ保存していません。'); setSaving(false); return; }
    const result = await repository.upsert(brandId, parsed.value);
    setSaving(false);
    if (!result.ok) { setMessage(result.reason); return; }
    setSettings(parsed.value); setMessage('設定を保存しました。投稿権限や投稿実行は変更していません。');
  }

  return <Screen><ScrollView contentContainerStyle={{ gap: 16 }}><SectionTitle detail="投稿内容の好みを整えます。投稿の実行権限は別管理です。">あなたの投稿AI</SectionTitle><Link href="/(tabs)/consult" asChild><Card><Text style={{ color: colors.ink, fontWeight: '800' }}>会話で相談する</Text><Text style={styles.muted}>自然な言葉で希望を伝え、AIの理解を確認してから設定できます。</Text></Card></Link><Card><Text style={{ color: colors.ink, fontWeight: '800' }}>コンテンツ設定</Text><Text style={styles.muted}>トーン</Text><TextInput value={fields.tone} onChangeText={(value) => updateField('tone', value)} style={inputStyle} maxLength={120} /><Text style={styles.muted}>テーマ（読点区切り）</Text><TextInput value={fields.themes} onChangeText={(value) => updateField('themes', value)} style={inputStyle} maxLength={800} /><Text style={styles.muted}>投稿の目的</Text><TextInput value={fields.objective} onChangeText={(value) => updateField('objective', value)} style={inputStyle} maxLength={160} /><Text style={styles.muted}>週あたりの投稿目安（0〜14）</Text><TextInput value={fields.frequency} onChangeText={(value) => updateField('frequency', value)} keyboardType="number-pad" style={inputStyle} maxLength={2} /><Text style={styles.muted}>タイムゾーン</Text><Text style={{ color: colors.ink }}>Asia/Tokyo（固定）</Text><Text style={styles.muted}>生成希望時刻（JST）</Text><TextInput value={fields.generationTime} onChangeText={(value) => updateField('generationTime', value)} style={inputStyle} maxLength={5} /><Text style={styles.muted}>避けたい語句（読点区切り）</Text><TextInput value={fields.ngWords} onChangeText={(value) => updateField('ngWords', value)} style={inputStyle} maxLength={1200} /><Text style={styles.muted}>AIへの補足メモ</Text><TextInput value={fields.notes} onChangeText={(value) => updateField('notes', value)} style={[inputStyle, { minHeight: 84, textAlignVertical: 'top' }]} multiline maxLength={1000} /><ActionButton label={saving ? '保存中…' : '設定を保存'} onPress={() => void save()} />{message ? <Pill tone={message.includes('保存しました') ? 'success' : 'warning'}>{message}</Pill> : null}</Card><Card><Text style={{ color: colors.ink, fontWeight: '800' }}>投稿権限</Text><Text style={styles.muted}>自動投稿のON/OFFや「今すぐ投稿」は、この設定画面から変更できません。</Text></Card><SignOutButton /></ScrollView></Screen>;
}

const inputStyle = { borderColor: colors.border, borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 9, color: colors.ink, backgroundColor: '#FFFFFF' };
