# かぶモリ A/B/C 安全停止 実行報告 — 2026-10-17

- 推薦モデル: **GPT-6（高）**
- 実行owner: G1から継続した本Codex実行（新旧slotの再割当なし）
- 承認: ユーザーが本チャットで本番A/B/Cすべてを明示承認。
- 正本計画: PR #246 HEAD `4627b366a1241a2250871f0ef4d56533f10dfa6b` の [SAFE_STOP_PLAN](SAFE_STOP_PLAN_2026-10-17.md)。
- 計画SHA256: `b2f74b9651b38b2a96641289e1da8033ef69ff4ceb89b7011615413558c4b0da`
- 対象本番: Supabase `stock-x-autopost / wsmznyzcvmuitkglfeuj`。
- 証跡: [evidence/2026-10-17-stop-execution/](evidence/2026-10-17-stop-execution/)
- 判定: **A/B/C実行・直後read-back PASS。境界越え検証 CONDITIONAL。システム全体の完全休止 BLOCKED。**
- 全production mutation window: **CLOSED**。観測待ちで保持しない。自動監視は登録していない。

## 結果（時刻はJST）

| 操作 | 実行とread-back | 結果 |
|---|---|---|
| A | 19:50:29 更新・同transaction内検証、19:50:41 別read-only transaction | 9行のみ `is_active=true→false`、COMMIT確認 |
| B | 19:50:58–59 / workflow 347498805 | PUT HTTP204、GET `disabled_manually` |
| C | 19:51:12–13 / workflow 376087886 | PUT HTTP204、GET `disabled_manually` |

A: txid `1198597`。posting_windowsのmorning_greeting slot1、tip slot1/2/3、interaction slot1/2の6行と、useful_tip_schedule_settings / morning_report_settings / close_report_settingsのid=true各1行。合計9行をロックし、全expected-beforeと行数を検証した単一transactionで更新した。RETURNING 6+1+1+1、全expected-after一致をCOMMIT前に検証。更新列はis_activeのみで、updated_atを含め他列は不変。元からOFFの3windowと米国専用設定はOFFのまま。COMMITの厳密な瞬間は取得していないが、19:50:29.277のCOMMIT前検証から19:50:41.902の別transaction read-backまでに確定している。

B/C: IDとpathとactive状態を操作直前に再確認。非終端queued/in_progress/waiting/pending/requestedはすべて0。Bのread-back成功後にCへ進んだ。runキャンセルは0件。

## fresh preflightと競合

19:47:52と直前19:49:54にread-only観測。計画証跡の対象行全列、全19window、4設定テーブル、5planner+claim_due_post、queue writer集合、table構造、brand default、参照元・trigger指紋、Cron active/command指紋が一致。全brandの安全な設定投影、全window、Cron scheduleもbefore/after比較に含めた。変更transactionでも同じexpected-before/afterを再比較した。

Edge x-test-postはv145、配備bundle SHA256 `804467c5f9b3887a7937001da70c74d0dc1bf2153dc806a5362eb450d1c29895` で計画と一致。Edge呼出し・再配備はしていない。

独立checkoutを新設。fresh main `8c047dd6f51c7bebfe751186488a602a077742ab`、直前main `7d32b6acf78766d671902b876f99daa0ca86fde6` を確認。計画後のmain変更は.agent_v2の管理文書のみで、停止対象runtime/settings/workflowとの重複なし。新旧30枠のACTIVE_TASK/CURRENT_STATEとF2/F8/F5/F6 TASKの現在指示を確認し、競合する本番write区間なし。F2/F8/共通Auth/AIはsource-only・本番NO_GO。索引とTASKには一部status差があるが、同task_id・本番禁止の境界は一致しており、当実行で再割当・上書きしていない。

最初のread-only観測SQLはbrands.enabled_post_types列が存在せず失敗し、writeは0件。任意JSONキーとして安全に投影するよう修正し、全preflightを再実行した。計画の比較対象に構造・値の差異はなかった。このエラーは停止transactionのエラーではない。

## 保護と自然稼働の観測

19:52:50のfresh read-only再確認で、変更後の全設定・他brand windows/brands・全Cron・planner/claim/trigger指紋がexpected-afterと一致。対象in-flightなし。

- 既存pending2件はID・status・scheduled_for・created_at不変。
  - interaction `56751f31-6884-4f67-be22-c962be313e04` — 10/17 20:41:36 JST
  - useful_tip `155d870b-4c3f-4201-a222-620e1c3fdced` — 10/18 19:27:47 JST
- 19:51 / 19:52の通常Dispatcher #1とPush #9は各2回、Cron記録succeeded。これはCronのHTTP送出statement成功を示し、全下流サービスの成功保証ではない。
- 19:52:55まで、停止後作成のかぶモリ予約0件、停止後post_execution_logs追加0件。manual planner/claim/送信/再試行は実行していない。
- 朝画像Storage `morning-greeting-assets` は36件のまま。最新created_at/updated_atは10/17 03:51:04 JSTで不変。
- B/C無効化後の新run0、非終端run0。最終GitHub観測はgithub-final.json参照。
- 会社員AIラボworkflow `371309016 / ai-lab-diary-snapshot.yml` はactive維持。
- Dispatcher #1、Push #9、株価同期 #5/#6はactive/schedule/command指紋不変。POSTONA・共通Auth/AI・Secrets、他Actions、既存queue/log、Storage画像を変更していない。
- DB関数/schema/RLS/Auth/Edge/Cron/Secretsの変更、deploy、main merge、人工的なSNS/AI実行は0件。

GitHub監査コメント: [区間開始](https://github.com/anohi-memories/kabumori/pull/246#issuecomment-6233020296)、[各区間CLOSED](https://github.com/anohi-memories/kabumori/pull/246#issuecomment-6233031685)。このPRへの追加は実行報告と証跡のみ。計画文書は元の内容を保持する。

## 残件と最終判定

1. **10/18 00:00 JST以降**: 通常Cronの自然起動を挟み、新規かぶモリ予約0・設定OFF維持・他brand設定/通常処理維持をread-only確認。
2. **10/19 00:00 JST以降**: JST月曜の週境界後、週間useful_tipを含む新規予約0を確認。本番関数のdefault週開始はJST date_trunc('week', ...)である。
3. **10/19の営業日処理後**: 朝刊/大引けの専用経路についても自然起動後の予約新規作成0を確認。土曜・短時間の観測だけでは営業日動作を証明しない。
4. 承認済み既存2予約は自然実行を許可。status変化は許容するが監査者が再送・削除・取消を起こさない。停止後に新規行が見つかった場合、時刻・ID・件数を保存し、勝手に取り除かずG1へ報告。
5. 本停止がカバーするのは通常plannerの新規予約と朝画像workflow起動。手動の直接X/AI呼出し、ニュース・Pushの全入口を含めた全システム完全休止PASSではない。F2/F8候補の本番承認は本件で代替しない。

**実行部分は完了。上記観測は未実施で、今後の承認済み停止状態を維持したread-only確認として残す。自動監視・予約ジョブは作らない。復旧・runキャンセルは別途明示承認が必要。**

