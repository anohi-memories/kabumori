// オンデマンド分析のゲート（personalized_ondemand_settings.ondemand_requests_enabled）を、定時の個別レポートが読む。
//
// - 表が無い（migration が未適用で PostgREST が 404）→ OFF（従来どおり定時の生成を続ける）
// - true → ON（定時の生成を丸ごと飛ばす。生成と通知は worker だけが行う）
// - それ以外の読み取りの失敗 → 1回だけ読み直し、それでも失敗なら例外（その回は何も生成しない）。
//   ON のときに読み違えて定時の生成を走らせると、同じ利用者に二重の生成と二重の通知が起きうるため、安全側に倒す。

export async function ondemandModeEnabled(db: { get<T>(path: string): Promise<T> }): Promise<boolean> {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const rows = await db.get<Array<{ ondemand_requests_enabled?: unknown }>>(
        "personalized_ondemand_settings?id=eq.true&select=ondemand_requests_enabled",
      );
      return Array.isArray(rows) && rows[0]?.ondemand_requests_enabled === true;
    } catch (error) {
      if (error instanceof Error && error.message.endsWith(":404")) return false;
      if (attempt === 2) throw new Error("ONDEMAND_MODE_READ_FAILED");
    }
  }
  throw new Error("ONDEMAND_MODE_READ_FAILED");
}
