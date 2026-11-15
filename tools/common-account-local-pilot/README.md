# common-account-local-pilot（G5 Phase 3h）

ローカルの Supabase OSS スタックと Keycloak で、偽ユーザーだけを使って認証の挙動を小さく観測するための再現用ツールです。
手順、結果、限界、managed に引き継げない部分は `docs/common-account/phase3h-local-oss-pilot.md` にまとめています。

- ループバックの 2 つのエンドポイント（`127.0.0.1:55421` と、Keycloak の `keycloak:8080` → `127.0.0.1:55480`）にしか接続しません。
- `G5_LOCAL_PILOT_CONFIRM=G5_OWNED_PODMAN_MACHINE_g5-local-pilot` が無ければ起動を拒否します。ワークディレクトリ（秘密情報の生成先）は、リポジトリの外でなければ拒否します。
- 実プロジェクト、管理サービス、実プロバイダ、写真アプリには接続しません。`auth.users` への SQL 削除（E11）は含みません。
- オフラインのテスト: `python3 -m unittest -v tools/common-account-local-pilot/test_fail_closed.py`
- ファイル: `prepare.py`（設定とレルムの生成）、`core.py`（HTTP・DB の補助）、`cases.py`（Boot A / A9 / B / C のケース）、`extra.py`（C6 の詳細と E6 の細かい刻み）。
