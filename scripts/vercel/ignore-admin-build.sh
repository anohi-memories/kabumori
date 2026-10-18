#!/usr/bin/env bash
# Vercel Ignored Build Step: 0 = skip, 1 = build. Run with bash, never sh.
# No fetch: missing shallow history must build, never fall back to HEAD^.
set -u
export LC_ALL=C GIT_NO_REPLACE_OBJECTS=1

build() {
  printf 'Build required: %s\n' "$1"
  exit 1
}

root=$(git rev-parse --show-toplevel 2>/dev/null) || build 'not a Git checkout'
cd "$root" || build 'repository root unavailable'
previous=${VERCEL_GIT_PREVIOUS_SHA:-}
current=${VERCEL_GIT_COMMIT_SHA:-}
# Require full GitHub commit IDs, not options, revision expressions or refs.
[[ $previous =~ ^[0-9a-f]{40}$ && $current =~ ^[0-9a-f]{40}$ ]] ||
  build 'missing or malformed commit SHA'
previous_type=$(git cat-file -t "$previous" 2>/dev/null) || build 'previous object unavailable'
current_type=$(git cat-file -t "$current" 2>/dev/null) || build 'current object unavailable'
[[ $previous_type == commit && $current_type == commit ]] || build 'object is not a commit'
head_sha=$(git rev-parse --verify HEAD 2>/dev/null) || build 'HEAD unavailable'
[[ $current == "$head_sha" ]] || build 'current SHA differs from checkout'
git merge-base --is-ancestor "$previous" "$current" 2>/dev/null ||
  build 'ancestry cannot be proved'

# A file preserves NULs and lets us check diff's exit status before reading.
# Process substitution would hide diff failures; a shell variable drops NULs.
changes=$(mktemp "${TMPDIR:-/tmp}/ignore-admin-build.XXXXXX") || build 'temporary file unavailable'
trap 'rm -f -- "$changes"' EXIT
git diff --no-ext-diff --no-textconv --no-renames --ignore-submodules=none \
  --name-only -z "$previous" "$current" -- > "$changes" || build 'Git diff failed'
[[ -s $changes ]] || build 'empty diff'

count=0
while :; do
  file=
  if IFS= read -r -d '' file; then
    case "$file" in
      .agent/*|.agent_v2/*|.agent_v3/*|.agent_v3_gh/*) ;;
      *) build 'change outside orchestration directories' ;;
    esac
    count=$((count + 1))
  else
    [[ -z $file ]] || build 'incomplete diff record'
    break
  fi
done < "$changes"
[[ $count -gt 0 ]] || build 'no complete diff records'
printf 'Skip: orchestration files only (%s paths)\n' "$count"
exit 0
