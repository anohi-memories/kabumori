import type { ConsultationMessage, MediaAsset, PlannedPost, SettingsProposal, SocialAccount, UsageSummary, Workspace } from '@/domain/types';

export interface SocialOperationsRepository {
  getWorkspace(): Workspace;
  getAccounts(): SocialAccount[];
  getPlannedPosts(): PlannedPost[];
  getHistory(): PlannedPost[];
  getConsultation(): { messages: ConsultationMessage[]; proposal: SettingsProposal };
  getMediaAssets(): MediaAsset[];
  getUsage(): UsageSummary;
}
