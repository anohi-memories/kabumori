import type { PostStatus } from './types';

/** Map the scheduler's persisted statuses to the mobile display contract. */
export function mapScheduledPostStatus(status: unknown): PostStatus {
  switch (status) {
    case 'succeeded':
    case 'published':
      return 'published';
    case 'failed':
      return 'failed';
    case 'running':
    case 'publishing':
      return 'publishing';
    case 'draft':
      return 'draft';
    case 'pending':
    case 'scheduled':
    default:
      return 'scheduled';
  }
}
