"""G1 TASK 49: turn a THROW-AWAY copy of apps/social-mobile into the iOS rig build for the Threads native check.

Usage: python3 -I build-threads-native-rig.py <copy of apps/social-mobile> <seed.json written by the held rig>

Only the copy changes (the product source keeps every gate OFF). Edits, each asserted to apply exactly once:
  - the Threads connect / manual publish / disconnect UI gates ON;
  - plain http allowed for the loopback gateway (src/lib/supabase.ts's https check);
  - the connect runtime: the registered callback is the rig world's (H5's offline fixture), the system auth browser opens the
    gateway's LOCAL consent page instead of threads.com (same query), and its kabumori-social:// return is handed back to the flow
    as that registered callback URL (the app still validates and forwards it unchanged; the server still checks it);
  - a visible "ローカル検証ビルド" line on the Threads cards;
  - .env.local pointing at the gateway (http://127.0.0.1:<port>), the rig's public key, the Supabase data source.
"""
import json
import pathlib
import sys

app = pathlib.Path(sys.argv[1])
seed = json.loads(pathlib.Path(sys.argv[2]).read_text())
assert seed["api"].startswith("http://127.0.0.1:"), "the gateway must be loopback"
assert (app / "package.json").exists() and not (app / ".git").exists(), "a throw-away copy, not a checkout"


def sub(rel, pairs):
    p = app / rel
    text = p.read_text(encoding="utf-8")
    for a, b in pairs:
        assert text.count(a) == 1, (rel, a)
        text = text.replace(a, b)
    p.write_text(text, encoding="utf-8")


sub("src/domain/threads-connect.ts", [("export const THREADS_CONNECT_UI_ENABLED = false;", "export const THREADS_CONNECT_UI_ENABLED = true;")])
sub("src/domain/threads-manual-publish.ts", [("export const THREADS_MANUAL_PUBLISH_UI_ENABLED = false;", "export const THREADS_MANUAL_PUBLISH_UI_ENABLED = true;")])
sub("src/domain/threads-disconnect.ts", [("export const THREADS_DISCONNECT_UI_ENABLED = false;", "export const THREADS_DISCONNECT_UI_ENABLED = true;")])
sub("src/lib/supabase.ts", [("if (!/^https:\\/\\//u.test(url))", "if (!/^https?:\\/\\//u.test(url))")])
sub("src/features/threads-connect/threads-connect-runtime.ts", [
    ("  const delivery = threadsCallbackDeliveryHere();\n  return {\n    registeredCallback: delivery.ok ? delivery.callback : null,\n    unavailableCode: delivery.ok ? undefined : delivery.code,",
     "  const delivery = threadsCallbackDeliveryHere();\n  // G1 TASK 49 RIG ONLY: the rig world's registered callback.\n  const rigCallback = process.env.EXPO_PUBLIC_G1_RIG_THREADS_CALLBACK ?? null;\n  return {\n    registeredCallback: rigCallback,\n    unavailableCode: undefined,"),
    ("    openAuthSession: (url, redirectUrl) =>\n      WebBrowser.openAuthSessionAsync(url, redirectUrl, delivery.ok ? delivery.authSessionOptions : undefined),",
     "    // G1 TASK 49 RIG ONLY: the gateway's local consent page (same query) and its custom-scheme return, handed back as the callback.\n"
     "    openAuthSession: async (url, redirectUrl) => {\n"
     "      const rigReturn = 'kabumori-social://threads-rig-callback';\n"
     "      const query = url.includes('?') ? url.slice(url.indexOf('?')) : '';\n"
     "      const result = await WebBrowser.openAuthSessionAsync(`${process.env.EXPO_PUBLIC_G1_RIG_GATEWAY}/rig/fake-threads/authorize${query}`, rigReturn, { preferEphemeralSession: true });\n"
     "      if (result.type === 'success' && typeof result.url === 'string' && result.url.startsWith(rigReturn)) return { type: 'success', url: redirectUrl + result.url.slice(rigReturn.length) };\n"
     "      return result;\n"
     "    },"),
])
sub("src/features/threads-connect/threads-connect-card.tsx", [
    ("      <Text style={styles.muted}>{view.note}</Text>\n",
     "      <Text style={styles.muted}>{view.note}</Text>\n      <Text style={{ color: colors.danger }}>ローカル検証ビルド：接続先は本物のThreadsではなく、検証用の偽の画面です。</Text>\n"),
])
sub("src/features/threads-publish/threads-publish-card.tsx", [
    ("      <Text style={styles.muted}>投稿先: {account.profile.displayName}（{account.profile.handle}）</Text>\n",
     "      <Text style={styles.muted}>投稿先: {account.profile.displayName}（{account.profile.handle}）</Text>\n      <Text style={{ color: colors.danger }}>ローカル検証ビルド：投稿先は本物のThreadsではなく、検証用の偽のThreadsです。</Text>\n"),
])
(app / ".env.local").write_text(
    f"EXPO_PUBLIC_SUPABASE_URL={seed['api']}\nEXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY={seed['publishable']}\nEXPO_PUBLIC_DATA_SOURCE=supabase\n"
    f"EXPO_PUBLIC_G1_RIG_GATEWAY={seed['api']}\nEXPO_PUBLIC_G1_RIG_THREADS_CALLBACK={seed['callback']}\n",
    encoding="utf-8",
)
print("rig edits applied")
