export type SocialPlatform = 'x' | 'instagram' | 'threads';
export type PlanTier = 'free' | 'standard' | 'pro';
export type AccountConnectionStatus = 'connected' | 'needs_attention' | 'not_connected';
export type PostingState = 'active' | 'paused';
export type PostOrigin = 'ai_generated' | 'user_authored' | 'fixed' | 'manual';
export type PostStatus = 'draft' | 'scheduled' | 'publishing' | 'published' | 'failed';

export type Workspace = { id: string; name: string; plan: PlanTier };
export type VoiceSettings = { tone: string; language: string; avoid: string[] };
export type AccountProfile = { displayName: string; handle: string; avatarColor: string; voice: VoiceSettings };
export type SocialAccount = { id: string; brandId?: string; platform: SocialPlatform; profile: AccountProfile; connectionStatus: AccountConnectionStatus; postingState: PostingState };
export type PlannedPost = { id: string; accountId: string; scheduledAt: string; origin: PostOrigin; status: PostStatus; text: string };
export type ConsultationMessage = { id: string; role: 'assistant' | 'user'; text: string; createdAt: string };
export type SettingsProposal = { id: string; title: string; summary: string; changes: { label: string; before: string; after: string }[]; status: 'pending' | 'applied' | 'cancelled' };
export type MediaAsset = { id: string; name: string; kind: 'image' | 'video'; sizeLabel: string };
export type UsageSummary = { plan: PlanTier; monthlyPostsUsed: number; monthlyPostsLimit: number; aiActionsUsed: number; aiActionsLimit: number };
