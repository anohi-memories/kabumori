import AsyncStorage from '@react-native-async-storage/async-storage';

import { readTopicLevelFrom, writeTopicLevelTo, type TopicLevel } from '@/lib/home-topic';

// Thin AsyncStorage bindings for the pure, fully-tested logic in
// home-topic.ts. Kept in its own file (like use-onboarding.ts) so
// home-topic.ts stays free of RN imports and importable under Deno.
export const readTopicLevel = (): Promise<TopicLevel> => readTopicLevelFrom(AsyncStorage);
export const writeTopicLevel = (level: TopicLevel): Promise<boolean> => writeTopicLevelTo(AsyncStorage, level);
