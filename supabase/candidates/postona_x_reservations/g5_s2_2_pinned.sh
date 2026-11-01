# Sourced by the X / Threads reservation runners (G3-34). Writes G5's person-session gate S2-2 -- the candidate
# 004_s2_2_personal_session.sql read at G5 PR #510's head with its blob checked (G5-36 accepted the integrated offline
# contract) -- to the file named by $1. caller() asks it first, so every world that calls a person-facing function needs
# it installed by the schema owner. RESV_S22_SQL=<file> uses another copy (mutation runs). Read-only: nothing of G5 changes.
s22_pinned() {
  local commit=6d59f3b6690e237c203ba4ee8a8afbf42e7a5e11 path=supabase/candidates/postona_personal_auth/004_s2_2_personal_session.sql
  local blob=0790ad69e99f10bc57965aad88831b4baa143895 root
  if [ -n "${RESV_S22_SQL:-}" ]; then cp "$RESV_S22_SQL" "$1"; return 0; fi
  root="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
  git -C "$root" cat-file -e "$commit^{commit}" 2>/dev/null \
    || { echo "RUN_NOT_AVAILABLE: G5 PR #510 head $commit is missing (git fetch origin pull/510/head)" >&2; exit 3; }
  [ "$(git -C "$root" rev-parse "$commit:$path")" = "$blob" ] || { echo "Refusing: the S2-2 blob at $commit differs" >&2; exit 2; }
  git -C "$root" show "$commit:$path" >"$1"
}
