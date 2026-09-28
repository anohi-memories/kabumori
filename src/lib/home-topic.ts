// Type contract for the home "今日のトピック" card. There is no daily-topic
// backend/source in this repo yet (confirmed: no table, RPC, or Edge Function
// produces one), so this file defines only the shape a future source must
// satisfy -- it does not fetch or fabricate a topic. The card renders its own
// future-ready empty state when no topic is supplied.

export type TopicLevel = 'beginner' | 'intermediate' | 'advanced';

export const TOPIC_LEVEL_LABEL: Record<TopicLevel, string> = {
  beginner: '初心者向け',
  intermediate: '中級者向け',
  advanced: '上級者向け',
};

export type HomeTopic = {
  level: TopicLevel;
  title: string;
  body: string;
};
