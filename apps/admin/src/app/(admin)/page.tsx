import Link from "next/link";
import { ImportantNewsCandidateList } from "@/app/important-news-list";
import { PostHistoryList } from "@/app/post-history-list";
import { SystemStatusList } from "@/app/system-status-list";
import { getImportantNewsCandidates } from "@/lib/important-news";
import { getPostHistory } from "@/lib/post-history";
import { getRecentFailures } from "@/lib/recent-failures";
import { createAdminServerClient } from "@/lib/supabase/server";
import { getSystemStatus } from "@/lib/system-status";
import { getTodayScheduledPosts } from "@/lib/today-scheduled-posts";

export const dynamic = "force-dynamic";

export default async function AdminHomePage() {
  const supabase = await createAdminServerClient();
  const [scheduleResult, failureResult, historyResult, importantNewsResult, systemStatusResult] =
    await Promise.all([
      getTodayScheduledPosts(supabase),
      getRecentFailures(supabase),
      getPostHistory(supabase, 5),
      getImportantNewsCandidates(supabase, 5),
      getSystemStatus(supabase),
    ]);

  return (
    <main className="dashboard-shell">
      <header className="dashboard-header">
        <div>
          <h1>ダッシュボード</h1>
          <p className="page-description">投稿システムの今日の状況</p>
        </div>
      </header>

      <section className="dashboard-grid" aria-label="管理状況">
        <article className="dashboard-card schedule-card">
          <div className="card-heading">
            <h2>今日の投稿予定</h2>
            <span className="schedule-date">{scheduleResult.dateJst} JST</span>
          </div>

          {scheduleResult.error ? (
            <div className="empty-state schedule-state" role="alert">
              投稿予定を取得できませんでした。
            </div>
          ) : scheduleResult.posts.length === 0 ? (
            <div className="empty-state schedule-state">今日の投稿予定はありません。</div>
          ) : (
            <ol className="schedule-list">
              {scheduleResult.posts.map((post) => (
                <li className="schedule-item" key={post.id}>
                  <div className="schedule-time" aria-label={`${post.timeJst}予定`}>
                    {post.timeJst}
                  </div>
                  <div className="schedule-content">
                    <div className="schedule-summary">
                      <strong>{post.postTypeLabel}</strong>
                      <span className={`status status-${post.statusTone}`}>
                        {post.statusLabel}
                      </span>
                    </div>
                    {post.xPostId ? (
                      <p className="schedule-detail">
                        <span>X post ID</span>
                        <code>{post.xPostId}</code>
                      </p>
                    ) : null}
                    {post.failureReason ? (
                      <p className="schedule-detail schedule-error">
                        <span>失敗理由</span>
                        {post.failureReason}
                      </p>
                    ) : null}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </article>

        <article className="dashboard-card system-status-card">
          <h2>システム状態</h2>
          <SystemStatusList systems={systemStatusResult.systems} />
        </article>

        <article className="dashboard-card recent-posts-card">
          <div className="card-heading">
            <h2>最近の投稿</h2>
            <Link className="text-link" href="/posts">投稿履歴を見る</Link>
          </div>
          {historyResult.error ? (
            <div className="empty-state history-state" role="alert">
              投稿履歴を取得できませんでした。
            </div>
          ) : historyResult.posts.length === 0 ? (
            <div className="empty-state history-state">投稿履歴はまだありません。</div>
          ) : (
            <PostHistoryList posts={historyResult.posts} />
          )}
        </article>

        <article className="dashboard-card recent-failures-card">
          <h2>最近の失敗</h2>
          {failureResult.error ? (
            <div className="empty-state failure-state" role="alert">
              失敗履歴を取得できませんでした。
            </div>
          ) : failureResult.failures.length === 0 ? (
            <div className="empty-state failure-state">最近の失敗はありません。</div>
          ) : (
            <ol className="failure-list">
              {failureResult.failures.map((failure) => (
                <li className="failure-item" key={failure.id}>
                  <div className="failure-heading">
                    <div>
                      <strong>{failure.postTypeLabel}</strong>
                      <p className="failure-time">
                        {failure.occurredAtLabel}
                        {failure.scheduledAtLabel
                          ? `（予定 ${failure.scheduledAtLabel}）`
                          : ""}
                      </p>
                    </div>
                    <span className="status status-failed">失敗</span>
                  </div>

                  {failure.companyName ? (
                    <p className="failure-company">{failure.companyName}</p>
                  ) : null}
                  {failure.title ? <p className="failure-title">{failure.title}</p> : null}
                  <p className="failure-summary">{failure.summary}</p>
                  {failure.errorCode ? (
                    <p className="failure-code">
                      <span>エラー</span>
                      <code>{failure.errorCode}</code>
                    </p>
                  ) : null}
                  {failure.message ? <p className="failure-message">{failure.message}</p> : null}

                  {failure.factStatusLabel ? (
                    <FailureCheckDetails
                      label="Fact"
                      status={failure.factStatusLabel}
                      issues={failure.factIssues}
                    />
                  ) : null}
                  {failure.voiceStatusLabel ? (
                    <FailureCheckDetails
                      label="Voice"
                      status={failure.voiceStatusLabel}
                      issues={failure.voiceIssues}
                    />
                  ) : null}
                </li>
              ))}
            </ol>
          )}
        </article>

        <article className="dashboard-card important-news-card">
          <div className="card-heading">
            <h2>重要ニュース候補</h2>
            <Link className="text-link" href="/important-news">重要ニュース候補を見る</Link>
          </div>
          {importantNewsResult.error ? (
            <div className="empty-state" role="alert">
              重要ニュース候補を取得できませんでした。
            </div>
          ) : importantNewsResult.candidates.length === 0 ? (
            <div className="empty-state">重要ニュース候補はありません。</div>
          ) : (
            <ImportantNewsCandidateList candidates={importantNewsResult.candidates} />
          )}
        </article>
      </section>
    </main>
  );
}

function FailureCheckDetails({
  label,
  status,
  issues,
}: {
  label: string;
  status: string;
  issues: string[];
}) {
  return (
    <div className="failure-check">
      <p>
        <strong>{label}</strong>
        <span>{status}</span>
      </p>
      {issues.length > 0 ? (
        <ul>
          {issues.map((issue, index) => (
            <li key={`${label}-${index}`}>{issue}</li>
          ))}
        </ul>
      ) : status !== "問題なし" ? (
        <p className="failure-no-issues">詳細な指摘は記録されていません。</p>
      ) : null}
    </div>
  );
}
