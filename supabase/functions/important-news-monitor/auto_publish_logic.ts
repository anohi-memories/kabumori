export const AUTO_PUBLISH_DISABLED_REASON = "NEWS_AUTO_PUBLISH_DISABLED";

export type AutoPublishExecution<T> =
  | { executed: false; result: null; blockReason: typeof AUTO_PUBLISH_DISABLED_REASON }
  | { executed: true; result: T; blockReason: null };

export async function executeWhenAutoPublishEnabled<T>(
  autoPublishEnabled: boolean,
  operation: () => Promise<T>,
): Promise<AutoPublishExecution<T>> {
  if (!autoPublishEnabled) {
    return { executed: false, result: null, blockReason: AUTO_PUBLISH_DISABLED_REASON };
  }
  return { executed: true, result: await operation(), blockReason: null };
}
