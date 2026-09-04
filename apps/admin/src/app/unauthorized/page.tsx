import { LogoutButton } from "@/app/logout-button";

export default function UnauthorizedPage() {
  return (
    <main className="login-page">
      <section className="login-card" aria-labelledby="unauthorized-title">
        <div className="brand-mark" aria-hidden="true">株</div>
        <h1 id="unauthorized-title">管理者権限がありません</h1>
        <p className="login-description">
          このアカウントでは、かぶモリ Adminを表示できません。
        </p>
        <LogoutButton />
      </section>
    </main>
  );
}
