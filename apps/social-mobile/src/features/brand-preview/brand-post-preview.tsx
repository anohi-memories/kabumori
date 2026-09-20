import { useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { colors } from "@/constants/theme";
import { Card, Pill, SectionTitle, styles } from "@/components/ui";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/providers/auth-provider";

type PreviewState =
  | "not_configured"
  | "generating"
  | "preview_ready"
  | "generation_error";
type PreviewResponse = {
  success?: unknown;
  status?: unknown;
  workspace?: { display_name?: unknown };
  connected_account?: { handle?: unknown };
  draft?: { text?: unknown };
  error?: unknown;
};

export function BrandPostPreview({ brandId, workspaceName, handle }: {
  brandId?: string;
  workspaceName: string;
  handle?: string;
}) {
  const { session } = useAuth();
  const [state, setState] = useState<PreviewState | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [preview, setPreview] = useState<
    { workspace: string; handle: string; text: string } | null
  >(null);
  const configured = Boolean(
    supabase && session?.access_token && brandId && handle,
  );
  const notConfigured = state === "not_configured" || (!configured && state === null);

  async function generatePreview() {
    if (!supabase || !session?.access_token || !brandId || !handle) {
      setState("not_configured");
      setMessage("ログイン、ワークスペース、確認済みXアカウントが必要です。");
      return;
    }
    setState("generating");
    setMessage(null);
    setPreview(null);
    try {
      const { data, error } = await supabase.functions.invoke<PreviewResponse>(
        "social-mobile-brand-dry-run",
        {
          body: { brand_id: brandId },
          headers: { Authorization: `Bearer ${session.access_token}` },
        },
      );
      let responseData = data;
      if (error) {
        const context = (error as { context?: unknown }).context;
        if (context instanceof Response) {
          try {
            responseData = await context.clone().json() as PreviewResponse;
          } catch { /* keep generic error */ }
        }
        if (responseData?.status === "not_configured") {
          setState("not_configured");
          setMessage(
            "このワークスペースのプレビュー設定またはXアカウントを確認してください。",
          );
        } else {
          setState("generation_error");
          setMessage(
            "プレビューを生成できませんでした。時間をおいて再度お試しください。",
          );
        }
        return;
      }
      if (
        !responseData || responseData.success !== true ||
        typeof responseData.draft?.text !== "string"
      ) {
        if (responseData?.status === "not_configured") {
          setState("not_configured");
          setMessage(
            "このワークスペースのプレビュー設定またはXアカウントを確認してください。",
          );
        } else {
          setState("generation_error");
          setMessage(
            "プレビューを生成できませんでした。時間をおいて再度お試しください。",
          );
        }
        return;
      }
      setPreview({
        workspace: typeof responseData.workspace?.display_name === "string"
          ? responseData.workspace.display_name
          : workspaceName,
        handle: typeof responseData.connected_account?.handle === "string"
          ? responseData.connected_account.handle
          : handle,
        text: responseData.draft.text,
      });
      setState("preview_ready");
    } catch {
      setState("generation_error");
      setMessage(
        "プレビューを生成できませんでした。接続状態を確認してください。",
      );
    }
  }

  return (
    <Card>
      <SectionTitle detail="X投稿や投稿予定の作成は行いません。">
        投稿内容のプレビュー
      </SectionTitle>
      <Text style={styles.muted}>
        ワークスペース: {preview?.workspace ?? workspaceName}
      </Text>
      <Text style={styles.muted}>
        対象Xアカウント: {preview?.handle ?? handle ?? "未接続"}
      </Text>
      {state === "generating"
        ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <ActivityIndicator color={colors.primary} />
            <Text style={styles.muted}>文章を生成しています…</Text>
          </View>
        )
        : state === "preview_ready" && preview
        ? (
          <View style={{ gap: 8 }}>
            <Pill tone="success">プレビュー準備完了・投稿なし</Pill>
            <Text style={{ color: colors.ink, lineHeight: 22 }}>
              {preview.text}
            </Text>
          </View>
        )
        : notConfigured
        ? <Pill tone="warning">未設定</Pill>
        : state === "generation_error"
        ? <Pill tone="danger">生成エラー</Pill>
        : (
          <Text style={styles.muted}>
            {configured
              ? "プレビューはまだありません。"
              : "ログインと確認済みXアカウントの接続後に利用できます。"}
          </Text>
        )}
      {message ? <Text style={styles.muted}>{message}</Text> : null}
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: !configured || state === "generating" }}
        disabled={!configured || state === "generating"}
        onPress={() => void generatePreview()}
        style={(
          { pressed },
        ) => [
          styles.button,
          pressed && styles.buttonPressed,
          (!configured || state === "generating") && { opacity: 0.55 },
        ]}
      >
        <Text style={styles.buttonText}>
          {state === "generating"
            ? "生成中…"
            : state === "preview_ready"
            ? "もう一度プレビュー生成"
            : "プレビューを生成"}
        </Text>
      </Pressable>
      <Text style={styles.muted}>
        生成結果はこの画面だけに表示され、保存・投稿されません。
      </Text>
    </Card>
  );
}
