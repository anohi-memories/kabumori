# Codex Task

- task_id: x-multibrand-phase3b-auth-connection-prep-20260910
- owner: codex
- slot: codex-1
- status: done
- next_owner: chatgpt
- priority: high
- recommended_model: terra
- purpose: 複垢化Phase 3Bとして、会社員AIラボの実Xアカウントを安全に接続できるよう、Supabase Vaultを使う認証情報管理・OAuth接続・検証手順の実装準備を行う。ただし今回のtaskではX実投稿・live有効化・本番自動投稿開始は行わない。

## Completion

2026-09-10、C1レビューでPhase 3Bを承認。

実装は `feature/multibrand-foundation` の commit `d04d36d` としてpush済み。

確認済み:
- `social_accounts` にVault access/refresh secretのopaque UUID参照、connection status、verified identity metadataをexpand-onlyで追加
- Secret本体は通常テーブル/Git/Reportへ保存していない
- OAuth stateはhash、brand/account、PKCE verifierのVault secret ID、redirect URI、expires/consumedのみを保持
- tamper / unknown / expired / consumed / brand-account mismatchをtoken exchange前にfail-closed
- read-only identity verificationは `GET https://api.x.com/2/users/me` のみで、write/post APIは未実装
- Kabumori legacy `oauth_token_store` は未変更
- 会社員AIラボはdry_run / publish disabledのまま、mioはdisabledのまま
- local `supabase db reset --local --no-seed` pass
- Deno tests 688 passed / 0 failed
- `check-safe-env.sh` SAFE、local cron.job=0
- 本番Supabase/Vault書込み/OAuth認可/X投稿/deploy/Cron/live化/main mergeはすべて未実施

次段階は実OAuth接続・Vault secret登録の実施準備。ユーザー本人のXログインと明示承認が必要なため、実施前にredirect URI、X App scopes、対象social account、Vault作成手順を再確認する。
