import { LoginForm } from "./login-form";

const REASON_MESSAGES: Readonly<Record<string, string>> = {
  session:
    "ログインには成功しましたが、セッションを保存できませんでした。もう一度お試しください。",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string }>;
}) {
  const { reason } = await searchParams;
  const initialErrorMessage = reason ? (REASON_MESSAGES[reason] ?? null) : null;

  return (
    <main className="login-page">
      <section className="login-card" aria-labelledby="login-title">
        <div className="brand-mark" aria-hidden="true">株</div>
        <h1 id="login-title">かぶモリ Admin</h1>
        <p className="login-description">管理者アカウントでログインしてください。</p>
        <LoginForm initialErrorMessage={initialErrorMessage} />
      </section>
    </main>
  );
}
