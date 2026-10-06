import AsyncStorage from '@react-native-async-storage/async-storage';

import { createTopicReadStore } from '@/lib/topic-read';

// Thin AsyncStorage binding for the pure, tested logic in topic-read.ts (same split as topic-level-storage.ts).
// This is the learning progress of this device only; it is unrelated to the Home level preference.
export const topicReadStore = createTopicReadStore(AsyncStorage);
