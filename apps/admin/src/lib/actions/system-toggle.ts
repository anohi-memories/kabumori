"use server";

import { revalidatePath } from "next/cache";
import { createAdminServerClient } from "@/lib/supabase/server";

// Fixed allowlist of what a client is allowed to flip, and exactly which
// table/column each one maps to server-side. The client only ever sends one
// of these keys plus a boolean — never a table or column name — so there is
// no way to point an update at anything outside this list.
export const SYSTEM_TOGGLE_KEYS = [
  "important_news_monitor",
  "important_news_auto_publish",
  "morning_report",
  "close_report",
  "us_premarket",
  "useful_tip",
] as const;

export type SystemToggleKey = (typeof SYSTEM_TOGGLE_KEYS)[number];

type ToggleConfig = {
  table:
    | "important_news_monitor_settings"
    | "morning_report_settings"
    | "close_report_settings"
    | "us_premarket_report_settings"
    | "useful_tip_schedule_settings";
  column: "is_active" | "auto_publish";
};

const TOGGLE_CONFIG: Readonly<Record<SystemToggleKey, ToggleConfig>> = {
  important_news_monitor: { table: "important_news_monitor_settings", column: "is_active" },
  important_news_auto_publish: { table: "important_news_monitor_settings", column: "auto_publish" },
  morning_report: { table: "morning_report_settings", column: "is_active" },
  close_report: { table: "close_report_settings", column: "is_active" },
  us_premarket: { table: "us_premarket_report_settings", column: "is_active" },
  useful_tip: { table: "useful_tip_schedule_settings", column: "is_active" },
};

export type ToggleResult =
  | { ok: true; value: boolean }
  | {
      ok: false;
      error: "invalid_system" | "not_authenticated" | "not_admin" | "update_failed";
    };

function isToggleKey(value: string): value is SystemToggleKey {
  return (SYSTEM_TOGGLE_KEYS as readonly string[]).includes(value);
}

function logToggleEvent(message: string, detail: Record<string, unknown>) {
  console.error(`[admin/system-toggle] ${message}`, detail);
}

/**
 * Flips one allowlisted settings flag on or off. Re-checks the caller's
 * session and admin_users membership itself rather than trusting that the
 * page that rendered the button already did so — RLS enforces the same
 * admin-only policy independently as a second layer.
 */
export async function setSystemEnabled(systemKey: string, enabled: boolean): Promise<ToggleResult> {
  if (!isToggleKey(systemKey)) {
    logToggleEvent("rejected unknown system key", { systemKey });
    return { ok: false, error: "invalid_system" };
  }
  const config = TOGGLE_CONFIG[systemKey];

  const supabase = await createAdminServerClient();

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();
  if (userError || !user) {
    logToggleEvent("no authenticated session", { systemKey });
    return { ok: false, error: "not_authenticated" };
  }

  const { data: admin, error: adminError } = await supabase
    .from("admin_users")
    .select("user_id")
    .eq("user_id", user.id)
    .maybeSingle();
  if (adminError || !admin) {
    logToggleEvent("caller is not an admin", { systemKey });
    return { ok: false, error: "not_admin" };
  }

  // Re-read the current value first so a redundant click (or a click that
  // raced with another admin's change) that already matches the desired
  // state doesn't issue a pointless write.
  const { data: currentRow, error: readError } = await supabase
    .from(config.table)
    .select(config.column)
    .eq("id", true)
    .maybeSingle();
  if (readError) {
    logToggleEvent("pre-update read failed", { systemKey, code: readError.code });
    return { ok: false, error: "update_failed" };
  }
  const currentValue = (currentRow as Record<string, unknown> | null)?.[config.column];
  if (currentValue === enabled) {
    return { ok: true, value: enabled };
  }

  const { data: updatedRow, error: updateError } = await supabase
    .from(config.table)
    .update({ [config.column]: enabled })
    .eq("id", true)
    .select(config.column)
    .maybeSingle();

  if (updateError || !updatedRow) {
    logToggleEvent("update failed", { systemKey, code: updateError?.code });
    return { ok: false, error: "update_failed" };
  }

  revalidatePath("/");

  return { ok: true, value: Boolean((updatedRow as Record<string, unknown>)[config.column]) };
}
