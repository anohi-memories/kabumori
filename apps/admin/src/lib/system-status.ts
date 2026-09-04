import type { SupabaseClient } from "@supabase/supabase-js";
import type { SystemToggleKey } from "@/lib/actions/system-toggle";

export type SystemStatusState = "active" | "inactive" | "unavailable";
export type SystemStatusTone = "success" | "unknown" | "pending";

export type SystemStatusDetail = {
  label: string;
  value: string;
};

export type SystemToggleControl = {
  key: SystemToggleKey;
  label: string;
  enabled: boolean;
  // "danger" gets an extra warning and a stronger confirmation in the UI —
  // used for important_news_auto_publish, where turning it on starts real
  // automatic X posting.
  kind: "normal" | "danger";
};

export type SystemStatusItem = {
  key: string;
  name: string;
  state: SystemStatusState;
  stateLabel: string;
  tone: SystemStatusTone;
  details: SystemStatusDetail[];
  note: string | null;
  unavailableReason: string | null;
  toggles: SystemToggleControl[];
};

export type SystemStatusResult = {
  systems: SystemStatusItem[];
};

const STATE_LABELS: Readonly<Record<SystemStatusState, string>> = {
  active: "稼働中",
  inactive: "停止中",
  unavailable: "状態確認不可",
};

const STATE_TONES: Readonly<Record<SystemStatusState, SystemStatusTone>> = {
  active: "success",
  inactive: "unknown",
  unavailable: "pending",
};

function formatTime(time: string | null) {
  if (!time) return "-";
  return time.length >= 5 ? time.slice(0, 5) : time;
}

function onOffLabel(value: boolean | null) {
  if (value === null) return "-";
  return value ? "ON" : "OFF";
}

function logQueryError(source: string, code: string) {
  console.error(`[admin/system-status] ${source} query failed`, { code });
}

function buildItem(
  key: string,
  name: string,
  isActive: boolean | null,
  details: SystemStatusDetail[],
  options?: {
    note?: string | null;
    unavailableReason?: string | null;
    toggles?: SystemToggleControl[];
  },
): SystemStatusItem {
  const state: SystemStatusState = options?.unavailableReason
    ? "unavailable"
    : isActive
      ? "active"
      : "inactive";

  return {
    key,
    name,
    state,
    stateLabel: STATE_LABELS[state],
    tone: STATE_TONES[state],
    details: state === "unavailable" ? [] : details,
    note: options?.note ?? null,
    unavailableReason: state === "unavailable" ? (options?.unavailableReason ?? null) : null,
    toggles: state === "unavailable" ? [] : (options?.toggles ?? []),
  };
}

type ImportantNewsSettingsRow = {
  is_active: boolean;
  interval_minutes: number;
  auto_publish: boolean;
  luna_enabled: boolean;
  sol_escalation_enabled: boolean;
};

async function getImportantNewsStatus(supabase: SupabaseClient): Promise<SystemStatusItem> {
  const { data, error } = await supabase
    .from("important_news_monitor_settings")
    .select("is_active,interval_minutes,auto_publish,luna_enabled,sol_escalation_enabled")
    .eq("id", true)
    .maybeSingle();

  if (error) {
    logQueryError("important_news_monitor_settings", error.code);
    return buildItem("important_news", "重要ニュース", null, [], {
      unavailableReason: "設定を取得できませんでした。",
    });
  }
  if (!data) {
    return buildItem("important_news", "重要ニュース", null, [], {
      unavailableReason: "設定が見つかりません。",
    });
  }

  const row = data as ImportantNewsSettingsRow;
  return buildItem(
    "important_news",
    "重要ニュース",
    row.is_active,
    [
      { label: "監視間隔", value: `${row.interval_minutes}分` },
      { label: "X自動投稿", value: onOffLabel(row.auto_publish) },
      { label: "Luna", value: onOffLabel(row.luna_enabled) },
      { label: "Sol escalation", value: onOffLabel(row.sol_escalation_enabled) },
    ],
    {
      toggles: [
        { key: "important_news_monitor", label: "監視", enabled: row.is_active, kind: "normal" },
        {
          key: "important_news_auto_publish",
          label: "X自動投稿",
          enabled: row.auto_publish,
          kind: "danger",
        },
      ],
    },
  );
}

type ReportSettingsRow = {
  is_active: boolean;
  center_time: string;
  timezone: string;
};

async function getReportStatus(
  supabase: SupabaseClient,
  table: "morning_report_settings" | "close_report_settings",
  key: string,
  name: string,
  toggleKey: Extract<SystemToggleKey, "morning_report" | "close_report">,
): Promise<SystemStatusItem> {
  const { data, error } = await supabase
    .from(table)
    .select("is_active,center_time,timezone")
    .eq("id", true)
    .maybeSingle();

  if (error) {
    logQueryError(table, error.code);
    return buildItem(key, name, null, [], { unavailableReason: "設定を取得できませんでした。" });
  }
  if (!data) {
    return buildItem(key, name, null, [], { unavailableReason: "設定が見つかりません。" });
  }

  const row = data as ReportSettingsRow;
  return buildItem(
    key,
    name,
    row.is_active,
    [
      { label: "投稿時間", value: `${formatTime(row.center_time)}前後` },
      { label: "タイムゾーン", value: row.timezone },
    ],
    { toggles: [{ key: toggleKey, label: name, enabled: row.is_active, kind: "normal" }] },
  );
}

type PostingWindowRow = {
  is_active: boolean;
  start_time: string;
  end_time: string;
  timezone: string;
};

async function getMorningGreetingStatus(supabase: SupabaseClient): Promise<SystemStatusItem> {
  const { data, error } = await supabase
    .from("posting_windows")
    .select("is_active,start_time,end_time,timezone")
    .eq("post_type", "morning_greeting")
    .order("slot_no", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) {
    logQueryError("posting_windows(morning_greeting)", error.code);
    return buildItem("morning_greeting", "朝の挨拶", null, [], {
      unavailableReason: "設定を取得できませんでした。",
    });
  }
  if (!data) {
    return buildItem("morning_greeting", "朝の挨拶", null, [], {
      unavailableReason: "スケジュール設定が見つかりません。",
    });
  }

  const row = data as PostingWindowRow;
  return buildItem(
    "morning_greeting",
    "朝の挨拶",
    row.is_active,
    [
      { label: "投稿時間帯", value: `${formatTime(row.start_time)}〜${formatTime(row.end_time)}` },
      { label: "タイムゾーン", value: row.timezone },
    ],
    {
      note:
        "投稿ウィンドウ設定のON/OFFです。Cron実行自体とは別です。" +
        "実行トリガー（Cron）自体の稼働状況はDBから確認できません。",
      toggles: [
        { key: "morning_greeting", label: "投稿設定", enabled: row.is_active, kind: "normal" },
      ],
    },
  );
}

type TipPostingWindowRow = {
  is_active: boolean;
};

async function getTipStatus(supabase: SupabaseClient): Promise<SystemStatusItem> {
  const { data, error } = await supabase
    .from("posting_windows")
    .select("is_active")
    .eq("post_type", "tip")
    .order("slot_no", { ascending: true });

  if (error) {
    logQueryError("posting_windows(tip)", error.code);
    return buildItem("tip", "株の小ネタ", null, [], {
      unavailableReason: "設定を取得できませんでした。",
    });
  }
  if (!data || data.length === 0) {
    return buildItem("tip", "株の小ネタ", null, [], {
      unavailableReason: "投稿枠が見つかりません。",
    });
  }

  const rows = data as TipPostingWindowRow[];
  const activeCount = rows.filter((row) => row.is_active).length;
  const allActive = activeCount === rows.length;
  const noneActive = activeCount === 0;

  return buildItem(
    "tip",
    "株の小ネタ",
    !noneActive,
    [
      { label: "投稿枠", value: `${rows.length}件` },
      { label: "有効な投稿枠", value: `${activeCount}/${rows.length}件` },
    ],
    {
      note:
        allActive || noneActive
          ? "3つの投稿枠をまとめてON/OFFします。個別の時間帯だけを操作することはできません。"
          : "投稿枠ごとに有効・無効が揃っていません。ON/OFF操作で3枠すべてを同じ状態に揃えられます。",
      toggles: [{ key: "tip", label: "株の小ネタ", enabled: allActive, kind: "normal" }],
    },
  );
}

type UsefulTipScheduleSettingsRow = {
  is_active: boolean;
  posts_per_week: number;
  window_a_start: string;
  window_a_end: string;
  window_b_start: string;
  window_b_end: string;
  timezone: string;
};

async function getUsefulTipStatus(supabase: SupabaseClient): Promise<SystemStatusItem> {
  const { data, error } = await supabase
    .from("useful_tip_schedule_settings")
    .select("is_active,posts_per_week,window_a_start,window_a_end,window_b_start,window_b_end,timezone")
    .eq("id", true)
    .maybeSingle();

  if (error) {
    logQueryError("useful_tip_schedule_settings", error.code);
    return buildItem("useful_tip", "お役立ち情報", null, [], {
      unavailableReason: "設定を取得できませんでした。",
    });
  }
  if (!data) {
    return buildItem("useful_tip", "お役立ち情報", null, [], {
      unavailableReason: "設定が見つかりません。",
    });
  }

  const row = data as UsefulTipScheduleSettingsRow;
  return buildItem(
    "useful_tip",
    "お役立ち情報",
    row.is_active,
    [
      { label: "投稿頻度", value: `週${row.posts_per_week}回` },
      {
        label: "投稿時間帯A",
        value: `${formatTime(row.window_a_start)}〜${formatTime(row.window_a_end)}`,
      },
      {
        label: "投稿時間帯B",
        value: `${formatTime(row.window_b_start)}〜${formatTime(row.window_b_end)}`,
      },
      { label: "タイムゾーン", value: row.timezone },
    ],
    {
      toggles: [{ key: "useful_tip", label: "お役立ち情報", enabled: row.is_active, kind: "normal" }],
    },
  );
}

type UsPremarketSettingsRow = {
  is_active: boolean;
  summer_window_start: string;
  summer_window_end: string;
  winter_window_start: string;
  winter_window_end: string;
  timezone: string;
};

async function getUsPremarketStatus(supabase: SupabaseClient): Promise<SystemStatusItem> {
  const { data, error } = await supabase
    .from("us_premarket_report_settings")
    .select(
      "is_active,summer_window_start,summer_window_end,winter_window_start,winter_window_end,timezone",
    )
    .eq("id", true)
    .maybeSingle();

  if (error) {
    logQueryError("us_premarket_report_settings", error.code);
    return buildItem("us_premarket", "米国プレマーケット", null, [], {
      unavailableReason: "設定を取得できませんでした。",
    });
  }
  if (!data) {
    return buildItem("us_premarket", "米国プレマーケット", null, [], {
      unavailableReason: "設定が見つかりません。",
    });
  }

  const row = data as UsPremarketSettingsRow;
  return buildItem(
    "us_premarket",
    "米国プレマーケット",
    row.is_active,
    [
      {
        label: "投稿時間帯（夏時間）",
        value: `${formatTime(row.summer_window_start)}〜${formatTime(row.summer_window_end)}`,
      },
      {
        label: "投稿時間帯（冬時間）",
        value: `${formatTime(row.winter_window_start)}〜${formatTime(row.winter_window_end)}`,
      },
      { label: "タイムゾーン", value: row.timezone },
    ],
    {
      toggles: [
        { key: "us_premarket", label: "米国プレマーケット", enabled: row.is_active, kind: "normal" },
      ],
    },
  );
}

export async function getSystemStatus(supabase: SupabaseClient): Promise<SystemStatusResult> {
  const systems = await Promise.all([
    getImportantNewsStatus(supabase),
    getReportStatus(supabase, "morning_report_settings", "morning_report", "朝刊", "morning_report"),
    getMorningGreetingStatus(supabase),
    getReportStatus(supabase, "close_report_settings", "close_report", "大引けレポート", "close_report"),
    getUsPremarketStatus(supabase),
    getUsefulTipStatus(supabase),
    getTipStatus(supabase),
  ]);

  return { systems };
}
