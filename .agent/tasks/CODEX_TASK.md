# Codex Task

Codex（こでさん）専用の現在タスクです。`G` を受けたCodexは、`.agent/ORCHESTRATION.md` と既存のプロジェクトルールを確認したうえで、このファイルだけを自分の担当タスク正本として扱います。

- task_id: kabumori-important-news-history-align-and-e2e-prep
- owner: codex
- status: done
- purpose: 本番適用済みのKabumori「重要ニュース」RPCについて、ローカルmigration履歴とのversion差を安全に解消し、アプリ側実装を既存workstreamと混ぜずに整理して、認証ユーザー/iOS実画面E2Eへ進められる状態にする。本番DB定義は変更しない。
- result: Cレビュー承認済み。migration version差の整合、TypeScript/iOS bundle確認、安全なアプリ差分分離判断まで完了。本番DB追加変更なし。
- completed:
  - 本番migration version `20260905140638` にローカルmigrationファイル名を整合
  - 同SQLの将来の二重適用リスクを解消
  - migration整合commitをorigin/mainへ反映
  - Expo対象TypeScript PASS
  - iOS bundle PASS
  - 本番RPC定義をread-only再確認
  - 重要ニュースExpo差分は今回workstreamとして識別済み
- remaining:
  - 認証済みユーザーによる本番RPC E2E
  - iOS Simulator/実機での目視操作確認
  - Expo/Auth/MVP基盤がorigin/mainへ安全に反映された後、ニュース画面・取得コード・タブhunkを再baseして最小commit/push
- blocked_by:
  - origin/mainにExpo/Auth/MVP共通基盤がまだ揃っておらず、ニュース2ファイルだけをpushするとビルド不能
  - 共通ファイルは他workstreamと競合し得るため、このC処理では新規Codex実装タスクを開始しない
- next_owner: chatgpt

## C Review decision

承認。

確認事項:
- 本番DB / DDL / GRANT / migration historyへの追加変更なし
- 本番migration `20260905140638_get_my_important_stock_news` とローカル履歴のversion差を安全に解消
- `migration repair` / `db push` / `--include-all` 不使用
- Expo対象TypeScript PASS
- iOS bundle PASS
- 他workstreamの未コミット変更をstage / commit / pushしていない

今回のCodexタスクは完了とする。認証RPC/iOS E2EとニュースExpo実装の本線反映は、共通Expo/Auth/MVP基盤の競合状況を確認してから別タスクとして割り当てる。
