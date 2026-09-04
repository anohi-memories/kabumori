"use server";

import { revalidatePath } from "next/cache";
import { createAdminServerClient } from "@/lib/supabase/server";

// Fixed allowlist of what a client is allowed to flip, and exactly which
// table/column (or posting_windows post_type) each one maps to server-side.
// The client only ever sends one of these keys plus a boolean — never a
// table, column, or post_type — so there is no way to point an update at
// anything outside this list.
export const SYSTEM_TOGGLE_KEYS = [
  "important_news_monitor",
  "important_news_auto_publish",
  "morning_report",
  "close_report",
  "us_premarket",
  "useful_tip",
  "morning_greeting",
  "tip",
] as const;

export type SystemToggleKey = (typeof SYSTEM_TOGGLE_KEYS)[number];

type SingleRowToggleConfig = {
  mode: "single";
  table:
    | "important_news_monitor_settings"
    | "morning_report_settings"
    | "close_report_settings"
    | "us_premarket_report_settings"
    | "useful_tip_schedule_settings";
  column: "is_active" | "auto_publish";
};

// posting_windows has one row per (post_type, slot_no). "morning_greeting"
// has a single slot, but "tip" has three independent slots that this mode
// always updates together — there is no per-slot control in V1.1.
type PostingWindowToggleConfig = {
  mode: "posting_window";
  postType: "morning_greeting" | "tip";
};

type ToggleConfig = SingleRowToggleConfig | PostingWindowToggleConfig;

const TOGGLE_CONFIG: Readonly<Record<SystemToggleKey, ToggleConfig>> = {
  important_news_monitor: {
    mode: "single",
    table: "important_news_monitor_settings",
    column: "is_active",
  },
  important_news_auto_publish: {
    mode: "single",
    table: "important_news_monitor_settings",
    column: "auto_publish",
  },
  morning_report: { mode: "single", table: "morning_report_settings", column: "is_active" },
  close_report: { mode: "single", table: "close_report_settings", column: "is_active" },
  us_premarket: { mode: "single", table: "us_premarket_report_settings", column: "is_active" },
  useful_tip: { mode: "single", table: "useful_tip_schedule_settings", column: "is_active" },
  morning_greeting: { mode: "posting_window", postType: "morning_greeting" },
  tip: { mode: "posting_window", postType: "tip" },
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

async function setSingleRowFlag(
  supabase: Awaited<ReturnType<typeof createAdminServerClient>>,
  systemKey: SystemToggleKey,
  config: SingleRowToggleConfig,
  enabled: boolean,
): Promise<ToggleResult> {
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

  return { ok: true, value: Boolean((updatedRow as Record<string, unknown>)[config.column]) };
}

async function setPostingWindowFlag(
  supabase: Awaited<ReturnType<typeof createAdminServerClient>>,
  systemKey: SystemToggleKey,
  config: PostingWindowToggleConfig,
  enabled: boolean,
): Promise<ToggleResult> {
  const { data: currentRows, error: readError } = await supabase
    .from("posting_windows")
    .select("is_active")
    .eq("post_type", config.postType);
  if (readError) {
    logToggleEvent("pre-update read failed", { systemKey, code: readError.code });
    return { ok: false, error: "update_failed" };
  }
  if (!currentRows || currentRows.length === 0) {
    logToggleEvent("no posting_windows rows found", { systemKey, postType: config.postType });
    return { ok: false, error: "update_failed" };
  }
  const alreadyUniform = (currentRows as { is_active: boolean }[]).every(
    (row) => row.is_active === enabled,
  );
  if (alreadyUniform) {
    return { ok: true, value: enabled };
  }

  // Every row for this post_type is updated together — a client never picks
  // one row out of several.
  const { data: updatedRows, error: updateError } = await supabase
    .from("posting_windows")
    .update({ is_active: enabled })
    .eq("post_type", config.postType)
    .select("is_active");

  if (updateError || !updatedRows || updatedRows.length === 0) {
    logToggleEvent("update failed", { systemKey, code: updateError?.code });
    return { ok: false, error: "update_failed" };
  }

  return { ok: true, value: enabled };
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

  const result =
    config.mode === "single"
      ? await setSingleRowFlag(supabase, systemKey, config, enabled)
      : await setPostingWindowFlag(supabase, systemKey, config, enabled);

  if (result.ok) {
    revalidatePath("/");
  }

  return result;
}
