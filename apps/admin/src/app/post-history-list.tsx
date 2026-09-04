import type { PostHistoryItem } from "@/lib/post-history";

const PREVIEW_LENGTH = 180;

export function PostHistoryList({ posts }: { posts: PostHistoryItem[] }) {
  return (
    <ol className="post-history-list">
      {posts.map((post) => {
        const isLongText = Boolean(post.generatedText && post.generatedText.length > PREVIEW_LENGTH);
        const preview = isLongText
          ? `${post.generatedText?.slice(0, PREVIEW_LENGTH).trim()}…`
          : post.generatedText;

        return (
          <li className={`post-history-item post-history-${post.statusTone}`} key={post.id}>
            <div className="post-history-heading">
              <div>
                <strong>{post.postTypeLabel}</strong>
                <p className="post-history-time">{post.occurredAtLabel} JST</p>
              </div>
              <span className={`status status-${post.statusTone}`}>{post.statusLabel}</span>
            </div>

            {post.scheduledAtLabel ? (
              <p className="post-history-meta">予定：{post.scheduledAtLabel} JST</p>
            ) : null}

            {preview ? (
              <div className="post-history-text">
                <p>{preview}</p>
                {isLongText ? (
                  <details>
                    <summary>全文を見る</summary>
                    <p>{post.generatedText}</p>
                  </details>
                ) : null}
              </div>
            ) : (
              <p className="post-history-no-text">本文はこの履歴から取得できません。</p>
            )}

            {post.xPostId ? (
              <p className="post-history-meta">
                X post ID：
                {post.xPostUrl ? (
                  <a href={post.xPostUrl} target="_blank" rel="noreferrer">
                    {post.xPostId}
                  </a>
                ) : (
                  <code>{post.xPostId}</code>
                )}
              </p>
            ) : null}

            {post.attemptCount && post.attemptCount > 1 ? (
              <p className="post-history-meta">実行回数：{post.attemptCount}回</p>
            ) : null}

            {post.status === "failed" ? (
              <div className="post-history-error">
                {post.errorCode ? <code>{post.errorCode}</code> : null}
                {post.message ? <p>{post.message}</p> : null}
                {!post.errorCode && !post.message ? <p>詳細な失敗理由は記録されていません。</p> : null}
              </div>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
