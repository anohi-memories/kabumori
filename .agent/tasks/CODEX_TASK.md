# Codex Task

- task_id: x-multibrand-phase3a-second-brand-dryrun-20260910
- owner: codex
- slot: codex-1
- status: done
- next_owner: chatgpt
- priority: high
- recommended_model: terra
- purpose: 複垢化Phase 3Aとして、Phase 2で完成したbrand-aware基盤の上に2ブランド目 `ai_salaryman_lab` を「未接続・dry-run専用」で安全に通せる配管を実装する。今回は実OAuth・実Token・X実投稿・本番反映を行わない。

## Completion

2026-09-10、C1レビューでPhase 3Aを承認。

実装は `feature/multibrand-foundation` の commit `34cb78c` としてpush済み。

確認済み:
- `ai_salaryman_lab` はKabumoriとは独立した `BrandCodeProfile` を持つ
- Kabumoriのvoice / hashtags / promptを暗黙継承しない
- `brand_context_dry_run` で2ブランド目のbrand context / profile previewを安全に検証可能
- dry-runではX token loader / Vault secret / X APIへ到達しない
- disabled / unknownはdry-run入口でもfail-closed
- live publish boundaryではdry_runを拒否し、未接続ブランドは投稿不能
- Vault resolver境界はopaque secret reference + mock readerのみ。実Secretは未作成・未読出し
- `mio` は未実装・disabledのまま
- Deno tests 686 passed / 0 failed
- 新規Brand moduleのdeno check pass
- `git diff --check` pass
- `check-safe-env.sh` SAFE、local cron.job=0
- 本番Supabase / deploy / Cron / Secret/Vault書込み / OAuth / X投稿 / main mergeはすべて未実施

既知の未完了:
- Podman DB-only環境のためPostgREST経由HTTP統合テストは未実施
- `profile_preview` は接続前preflightであり公開用コンテンツ生成器ではない
- 実OAuth・実アカウント・Vault secret・live/X投稿はPhase 3B以降
