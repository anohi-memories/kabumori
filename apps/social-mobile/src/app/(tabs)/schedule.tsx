import { Link } from 'expo-router';
import { ScrollView, Text, View } from 'react-native';
import { mockRepository } from '@/data/mock-repository';
import { colors } from '@/constants/theme';
import { Card, EmptyState, Pill, Screen, SectionTitle, styles } from '@/components/ui';
import type { PostOrigin, PostStatus } from '@/domain/types';
import { useActiveAccount } from '@/providers/active-account-provider';
import { useDataStatus } from '@/providers/data-provider';

const originLabels: Record<PostOrigin, string> = { ai_generated: 'AI生成', user_authored: 'ユーザー作成', fixed: '固定', manual: '手動' };
const statusLabels: Record<PostStatus, { label: string; tone: 'neutral' | 'success' | 'warning' | 'danger' }> = { draft: { label: '下書き', tone: 'neutral' }, scheduled: { label: '投稿待ち', tone: 'warning' }, publishing: { label: '投稿中', tone: 'warning' }, published: { label: '投稿済み', tone: 'success' }, failed: { label: '失敗', tone: 'danger' } };
export default function ScheduleScreen() { const { activeAccount } = useActiveAccount(); const { snapshot } = useDataStatus(); const posts = (snapshot?.plannedPosts ?? mockRepository.getPlannedPosts()).filter((post) => post.accountId === activeAccount?.id); return <Screen><ScrollView contentContainerStyle={{ gap: 16 }}><SectionTitle detail="2026年9月17日">投稿予定</SectionTitle><Text style={styles.muted}>日付を切り替えて、各アカウントの予定を確認できます。</Text>{posts.length ? posts.map((post) => { const status = statusLabels[post.status]; return <Link key={post.id} href={{ pathname: '/posts/[id]', params: { id: post.id } }} asChild><Card><View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}><Text style={{ color: colors.ink, fontWeight: '800' }}>{new Date(post.scheduledAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}</Text><Pill tone={status.tone}>{status.label}</Pill></View><Text style={{ color: colors.ink }}>{post.text}</Text><Text style={styles.muted}>{originLabels[post.origin]} ・ 実投稿は次フェーズ</Text></Card></Link>; }) : <EmptyState title="投稿予定はありません" detail="予定が作成されるとここに表示されます。" />}</ScrollView></Screen>; }
