// かぶモリ休止の停止候補（2026-10-15, F2）。x-test-post の中の、かぶモリ専用の入口だけに効く。
//
// 既存のブランドの X ゲート（_shared/brand/publish_guard.ts、変更しない）を、2か所で追加に使う:
//   1. 送信の直前の再確認: claim の直後の判定（index.ts の assertBrandPublishAllowed）を通ったあと、数分の生成の
//      間にブランドが停止されても、その投稿は送られていた（in-flight）。かぶモリの旧来の X 認証で X に作成の
//      リクエストを出す直前ごとに、ブランドを読み直して判定する（Vault アカウントの経路が既に持つ beforeCreate と同じ
//      考え方）。読み直しに失敗したら送らない（fail closed）。
//   2. 生成だけの入口（dry-run / テスト、X には送らないが AI を呼ぶ）: かぶモリの publish_mode が disabled か
//      is_active=false なら、AI を呼ぶ前に断る。dry_run と live では今までどおり動く（assertBrandDryRunAllowed）。
//
// 他のブランド（POSTONA・会社員AIラボ）の経路、共通の Dispatcher、トークンの更新、共通 AI には触れない。

import { type BrandContext, LEGACY_KABUMORI_BRAND_ID } from "../_shared/brand/brand_context.ts";
import { assertBrandDryRunAllowed, assertBrandPublishAllowed } from "../_shared/brand/publish_guard.ts";
import { MORNING_GREETING_IMAGE_TEST_MODE } from "./morning_greeting_image_logic.ts";
import { MORNING_GREETING_PAYLOAD_TEST_MODE } from "./morning_greeting_payload_logic.ts";

/** x-test-post の、X に送らず AI（文章・画像）だけを呼ぶ、かぶモリ専用の mode（index.ts の mode 判定と同じ値）。 */
export const KABUMORI_GENERATION_ONLY_MODES: readonly string[] = [
  "useful_tip_dry_run",
  "kabumori_voice_dry_run",
  "morning_report_dry_run",
  "close_report_dry_run",
  "us_premarket_report_dry_run",
  MORNING_GREETING_IMAGE_TEST_MODE,
  MORNING_GREETING_PAYLOAD_TEST_MODE,
];

export function isKabumoriGenerationOnlyMode(mode: unknown): boolean {
  return typeof mode === "string" && KABUMORI_GENERATION_ONLY_MODES.includes(mode);
}

export type KabumoriBrandLoader = () => Promise<BrandContext>;

/**
 * The check to run immediately before each X create request on Kabumori's legacy auth. A fresh read every call:
 * a pause applied while the post was being generated stops it here. Any read error is thrown (no send).
 */
export function kabumoriSendRecheck(load: KabumoriBrandLoader): () => Promise<void> {
  return async () => {
    const context = await load();
    if (context.brand.id !== LEGACY_KABUMORI_BRAND_ID) throw new Error("KABUMORI_SEND_RECHECK_BRAND_MISMATCH");
    assertBrandPublishAllowed(context);
  };
}

/** Generation-only modes: refuse before any model call when Kabumori is paused (disabled / inactive). */
export async function assertKabumoriGenerationAllowed(load: KabumoriBrandLoader): Promise<void> {
  const context = await load();
  if (context.brand.id !== LEGACY_KABUMORI_BRAND_ID) throw new Error("KABUMORI_SEND_RECHECK_BRAND_MISMATCH");
  assertBrandDryRunAllowed(context);
}

export type GenerationIngressDecision =
  | { allowed: true }
  | { allowed: false; status: 401 | 423; error: string };

/**
 * The generation-only ingress (2026-10-16, J2-R2): who is calling first, then whether Kabumori allows it. These modes
 * reach paid models (text / image) without posting, and before this they had no caller check at all. A caller must be a
 * registered admin (Supabase Auth user in admin_users, the same check the manual greeting publish uses); anything else is
 * 401 before the brand is even read. An authorized caller is then refused with 423 while Kabumori is paused. Every
 * error on either step is fail closed. Nothing here is reached by the scheduled dispatcher path or by other brands.
 */
export async function authorizeKabumoriGenerationIngress(args: {
  /** Resolves the caller (fail closed): false for a missing / invalid / non-admin credential or any lookup error. */
  isAdminCaller: () => Promise<boolean>;
  loadBrand: KabumoriBrandLoader;
  safeCode: (error: unknown) => string;
}): Promise<GenerationIngressDecision> {
  let admin = false;
  try {
    admin = await args.isAdminCaller();
  } catch {
    admin = false;
  }
  if (!admin) return { allowed: false, status: 401, error: "GENERATION_INGRESS_UNAUTHORIZED" };
  try {
    await assertKabumoriGenerationAllowed(args.loadBrand);
  } catch (error) {
    return { allowed: false, status: 423, error: args.safeCode(error) };
  }
  return { allowed: true };
}
