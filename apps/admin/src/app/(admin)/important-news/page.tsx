import { ImportantNewsCandidateList } from "@/app/important-news-list";
import { requireActiveBrand } from "@/lib/active-brand";
import { KABUMORI_BRAND_ID } from "@/lib/brand-boundary";
import { getImportantNewsCandidates } from "@/lib/important-news";
import { createAdminServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function ImportantNewsPage() {
  const brand = await requireActiveBrand();
  // Important News is a Kabumori-only system (important_news_candidates has no brand_id column), so it
  // is only read while Kabumori is the active brand.
  if (brand.id !== KABUMORI_BRAND_ID) {
    return (
      <main className="dashboard-shell">
        <header className="page-header">
          <h1>重要ニュース候補</h1>
          <p className="page-description">重要ニュースはかぶモリ専用の機能です。</p>
        </header>
        <section className="dashboard-card important-news-card">
          <div className="empty-state">
            {brand.label}では重要ニュースを利用していません。表示するには対象ブランドをかぶモリに切り替えてください。
          </div>
        </section>
      </main>
    );
  }

  const supabase = await createAdminServerClient();
  const result = await getImportantNewsCandidates(supabase, 30);

  return (
    <main className="dashboard-shell">
      <header className="page-header">
        <h1>重要ニュース候補</h1>
        <p className="page-description">かぶモリ専用：直近30件の重要ニュース候補を新しい順に表示しています。</p>
      </header>

      <section
        className="dashboard-card important-news-card"
        aria-labelledby="important-news-title"
      >
        <h2 id="important-news-title">重要ニュース候補一覧</h2>
        {result.error ? (
          <div className="empty-state" role="alert">
            重要ニュース候補を取得できませんでした。
          </div>
        ) : result.candidates.length === 0 ? (
          <div className="empty-state">重要ニュース候補はありません。</div>
        ) : (
          <ImportantNewsCandidateList candidates={result.candidates} />
        )}
      </section>
    </main>
  );
}
