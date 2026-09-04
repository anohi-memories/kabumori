import { PostHistoryList } from "@/app/post-history-list";
import { getPostHistory } from "@/lib/post-history";
import { createAdminServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function PostsPage() {
  const supabase = await createAdminServerClient();
  const result = await getPostHistory(supabase, 30);

  return (
    <main className="dashboard-shell">
      <header className="page-header">
        <h1>投稿履歴</h1>
        <p className="page-description">直近30件の投稿結果を新しい順に表示しています。</p>
      </header>

      <section className="dashboard-card post-history-card" aria-labelledby="post-history-title">
        <h2 id="post-history-title">最近の投稿履歴</h2>
        {result.error ? (
          <div className="empty-state" role="alert">投稿履歴を取得できませんでした。</div>
        ) : result.posts.length === 0 ? (
          <div className="empty-state">投稿履歴はまだありません。</div>
        ) : (
          <PostHistoryList posts={result.posts} />
        )}
      </section>
    </main>
  );
}
