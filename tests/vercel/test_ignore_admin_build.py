"""Offline contract tests: 0 skips; every uncertainty must return exactly 1."""
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts/vercel/ignore-admin-build.sh"
README = ROOT / "scripts/vercel/README.md"
COMMAND = re.search(r"```sh\n(sh -c [^\n]+)\n```", README.read_text())[1]
BASH = shutil.which("bash")
GIT = shutil.which("git")


class IgnoreAdminBuild(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="vercel-ignore-")
        self.addCleanup(self.tmp.cleanup)
        self.repo = Path(self.tmp.name) / "repo with spaces"
        self.repo.mkdir()
        self.env = {k: v for k, v in os.environ.items()
                    if not k.startswith(("GIT_", "VERCEL_"))}
        self.env.update(GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull,
                        GIT_AUTHOR_NAME="Offline test", GIT_AUTHOR_EMAIL="test@example.invalid",
                        GIT_COMMITTER_NAME="Offline test", GIT_COMMITTER_EMAIL="test@example.invalid",
                        LC_ALL="C")
        self.git("init", "-q")
        self.git("config", "core.hooksPath", "/dev/null")
        self.git("config", "commit.gpgsign", "false")
        self.write("apps/admin/page.tsx")
        self.write(".agent/task.md")
        self.write("scripts/vercel/ignore-admin-build.sh", SCRIPT.read_bytes())
        self.base = self.commit()

    def git(self, *args, repo=None):
        return subprocess.check_output([GIT, "-C", str(repo or self.repo), *args],
                                       env=self.env, stderr=subprocess.PIPE).decode().strip()

    def write(self, path, data=b"initial\n"):
        target = self.repo / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)

    def commit(self):
        self.git("add", "-A")
        self.git("commit", "-qm", "fixture", "--allow-empty")
        return self.git("rev-parse", "HEAD")

    def change(self, path=".agent/task.md"):
        self.write(path, b"changed\n")
        return self.commit()

    def run_step(self, expected, previous=None, current=None, cwd=None, extra=None,
                 command=False):
        env = dict(self.env, VERCEL_GIT_PREVIOUS_SHA=self.base if previous is None else previous,
                   VERCEL_GIT_COMMIT_SHA=self.git("rev-parse", "HEAD") if current is None else current)
        env.update(extra or {})
        args = ["/bin/sh", "-c", COMMAND] if command else [BASH, str(SCRIPT)]
        result = subprocess.run(args, cwd=cwd or self.repo, env=env,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.assertEqual(result.returncode, expected,
                         (result.stdout + result.stderr).decode(errors="replace"))
        return result

    def shim(self, program, body):
        directory = Path(self.tmp.name) / "bin"
        directory.mkdir(exist_ok=True)
        target = directory / program
        target.write_text("#!/bin/sh\n" + body + "\n")
        target.chmod(0o755)
        return {"PATH": str(directory) + os.pathsep + self.env["PATH"]}

    def diff_shim(self, body):
        # The script runs Git from repo root; only diff is intercepted.
        return self.shim("git", 'if [ "$1" = diff ]; then\n' + body +
                         '\nfi\nexec "' + GIT + '" "$@"')

    def test_allowlisted_directories(self):
        for directory in (".agent", ".agent_v2", ".agent_v3", ".agent_v3_gh"):
            with self.subTest(directory=directory):
                self.change(directory + "/nested/task.md")
                self.run_step(0)

    def test_other_paths_and_prefix_lookalikes_build(self):
        for path in ("apps/admin/page.tsx", "apps/social-mobile/test.txt", "package.json",
                     "supabase/shared.txt", ".github/workflows/test.yml", ".agent_v20/task",
                     "nested/.agent/task", "ordinary.txt", ".agent-suffix/task"):
            with self.subTest(path=path):
                previous = self.git("rev-parse", "HEAD")
                self.change(path)
                self.run_step(1, previous=previous)

    def test_file_named_like_directory_builds(self):
        self.write(".agent_v3_gh")
        self.commit()
        self.run_step(1)

    def test_mixed_paths_build(self):
        self.change()
        self.change("apps/admin/new.tsx")
        self.run_step(1)

    def test_all_commits_since_success_are_compared(self):
        self.change("apps/admin/new.tsx")
        self.change(".agent_v2/next.md")
        self.run_step(1)  # HEAD^ alone would incorrectly skip.

    def test_deleted_management_file_skips(self):
        (self.repo / ".agent/task.md").unlink()
        self.commit()
        self.run_step(0)

    def test_deleted_application_file_builds(self):
        (self.repo / "apps/admin/page.tsx").unlink()
        self.commit()
        self.run_step(1)

    def test_rename_within_management_skips(self):
        self.git("mv", ".agent/task.md", ".agent/renamed.md")
        self.commit()
        self.run_step(0)

    def test_rename_from_application_into_management_builds(self):
        self.git("mv", "apps/admin/page.tsx", ".agent/renamed.md")
        self.commit()
        self.run_step(1)

    def test_rename_out_of_management_builds(self):
        self.git("mv", ".agent/task.md", "apps/admin/renamed.tsx")
        self.commit()
        self.run_step(1)

    def test_mode_only_changes(self):
        self.git("update-index", "--chmod=+x", ".agent/task.md")
        self.git("commit", "-qm", "mode")
        self.run_step(0)
        previous = self.git("rev-parse", "HEAD")
        self.git("update-index", "--chmod=+x", "apps/admin/page.tsx")
        self.git("commit", "-qm", "mode")
        self.run_step(1, previous=previous)

    def test_management_unusual_filenames_skip(self):
        for name in ("space name", "line\nbreak", "tab\tname", 'quote"name',
                     "back\\slash", "日本語", "-option", "trailing\n"):
            self.write(".agent/" + name)
        self.commit()
        self.run_step(0, extra={"GIT_CONFIG_COUNT": "1", "GIT_CONFIG_KEY_0": "core.quotePath",
                                "GIT_CONFIG_VALUE_0": "true"})

    def test_application_newline_cannot_spoof_management_path(self):
        self.write(".agent/okay\napps/admin/spoof")
        self.write("apps/admin/real\n.agent/spoof")
        self.commit()
        self.run_step(1)

    def test_missing_and_malformed_shas(self):
        self.change()
        for bad in ("", "HEAD", "--all", "f" * 39, "g" * 40, "f" * 40 + "\n", self.base.upper()):
            with self.subTest(bad=bad):
                self.run_step(1, previous=bad)
                self.run_step(1, current=bad)

    def test_absent_environment_variables(self):
        self.change()
        result = subprocess.run([BASH, str(SCRIPT)], cwd=self.repo, env=self.env,
                                stdout=subprocess.PIPE)
        self.assertEqual(result.returncode, 1)

    def test_missing_commit_objects(self):
        self.change()
        self.run_step(1, previous="f" * 40)
        self.run_step(1, current="f" * 40)

    def test_noncommit_object(self):
        blob = self.git("rev-parse", "HEAD:.agent/task.md")
        self.change()
        self.run_step(1, previous=blob)
        self.run_step(1, current=blob)

    def test_current_must_match_checkout(self):
        earlier = self.change()
        self.change(".agent/next")
        self.run_step(1, current=earlier)

    def test_same_commit_and_empty_commit_build(self):
        self.run_step(1)
        self.commit()
        self.run_step(1)

    def test_reverted_tree_diff_builds(self):
        self.change()
        self.write(".agent/task.md")
        self.commit()
        self.run_step(1)

    def test_diverged_history_builds(self):
        other = self.change()
        self.git("checkout", "-q", "--detach", self.base)
        self.change(".agent/other")
        self.run_step(1, previous=other)

    def test_unrelated_history_builds(self):
        self.git("checkout", "--orphan", "unrelated")
        self.commit()
        self.run_step(1)

    def test_previous_newer_than_current_builds(self):
        later = self.change()
        self.git("checkout", "-q", "--detach", self.base)
        self.run_step(1, previous=later)

    def test_merge_includes_all_parents_changes(self):
        self.git("checkout", "-qb", "side")
        self.change("apps/admin/side.tsx")
        self.git("checkout", "-qb", "mainline", self.base)
        self.change(".agent/mainline")
        self.git("merge", "--no-ff", "-m", "merge", "side")
        self.run_step(1)

    def test_shallow_missing_previous_builds_but_available_ancestry_skips(self):
        previous = self.change()
        self.change(".agent_v2/next")
        for depth, sha, expected in ((1, previous, 1), (2, previous, 0), (2, self.base, 1)):
            with self.subTest(depth=depth, sha=sha):
                clone = Path(self.tmp.name) / ("shallow-" + str(depth) + sha)
                self.git("clone", "-q", "--depth=" + str(depth), self.repo.as_uri(), str(clone))
                self.run_step(expected, previous=sha, cwd=clone)

    def test_no_automatic_fetch_or_head_parent_fallback(self):
        self.change()
        env = self.shim("git", 'if [ "$1" = fetch ]; then touch "' + self.tmp.name +
                        '/fetch-called"; exit 88; fi\nexec "' + GIT + '" "$@"')
        self.run_step(1, previous="f" * 40, extra=env)
        self.assertFalse((Path(self.tmp.name) / "fetch-called").exists())

    def test_shallow_disconnected_objects_do_not_prove_ancestry(self):
        self.change()
        self.change(".agent/next")
        clone = Path(self.tmp.name) / "disconnected"
        self.git("clone", "-q", "--depth=1", self.repo.as_uri(), str(clone))
        # Fixture preparation only: load base without the connecting parent.
        self.git("fetch", "-q", "--depth=1", self.repo.as_uri(), self.base, repo=clone)
        self.assertEqual(self.git("cat-file", "-t", self.base, repo=clone), "commit")
        self.run_step(1, cwd=clone)

    def test_diff_failure_even_after_allowlisted_output_builds(self):
        self.change()
        for output in ("", "printf '.agent/task.md\\000'\n"):
            self.run_step(1, extra=self.diff_shim(output + "exit 2"))

    def test_truncated_diff_record_builds(self):
        self.change()
        self.run_step(1, extra=self.diff_shim("printf '.agent/ok\\000.agent/truncated'; exit 0"))

    def test_empty_diff_output_builds(self):
        self.change()
        self.run_step(1, extra=self.diff_shim("exit 0"))

    def test_temporary_file_failure_builds(self):
        self.change()
        self.run_step(1, extra={"TMPDIR": str(Path(self.tmp.name) / "nonexistent")})
        self.run_step(1, extra=self.shim("mktemp", "exit 9"))

    def test_temp_file_is_cleaned(self):
        self.change()
        temp = Path(self.tmp.name) / "temp"
        temp.mkdir()
        self.run_step(0, extra={"TMPDIR": str(temp)})
        self.assertEqual(list(temp.glob("ignore-admin-build.*")), [])
        self.change("apps/admin/new.tsx")
        self.run_step(1, extra={"TMPDIR": str(temp)})
        self.assertEqual(list(temp.glob("ignore-admin-build.*")), [])

    def test_outside_git_checkout_builds(self):
        self.run_step(1, cwd=self.tmp.name)

    def test_git_failure_builds(self):
        self.change()
        self.run_step(1, extra=self.shim("git", "exit 127"))
        self.run_step(1, command=True, extra=self.shim("git", "exit 127"))

    def test_script_change_itself_builds(self):
        self.write("scripts/vercel/ignore-admin-build.sh", SCRIPT.read_bytes() + b"\n# changed\n")
        self.commit()
        self.run_step(1)

    def test_documented_command_from_root_and_admin(self):
        self.change()
        self.run_step(0, command=True)
        self.run_step(0, command=True, cwd=self.repo / "apps/admin")
        self.change("apps/admin/new.tsx")
        self.run_step(1, command=True, cwd=self.repo / "apps/admin")

    def test_documented_command_startup_failures_build(self):
        self.change()
        self.run_step(1, command=True, cwd=self.tmp.name)
        self.run_step(1, command=True, extra=self.shim("bash", "exit 127"))
        (self.repo / "scripts/vercel/ignore-admin-build.sh").unlink()
        self.run_step(1, command=True)
        self.write("scripts/vercel/ignore-admin-build.sh", b"if\n")
        self.run_step(1, command=True)

    def test_git_replace_cannot_disguise_current_tree(self):
        other = self.change("apps/admin/new.tsx")
        self.git("checkout", "-q", "--detach", self.base)
        management = self.change()
        self.git("replace", other, management)
        self.git("checkout", "-q", "--detach", other)
        self.run_step(1)

    def test_submodule_pointer_change_builds_even_if_config_ignores_it(self):
        self.git("update-index", "--add", "--cacheinfo", "160000," + self.base + ",vendor")
        self.git("commit", "-qm", "gitlink")
        previous = self.git("rev-parse", "HEAD")
        self.git("update-index", "--cacheinfo", "160000," + previous + ",vendor")
        self.git("commit", "-qm", "gitlink changed")
        self.run_step(1, previous=previous,
                      extra={"GIT_CONFIG_COUNT": "1", "GIT_CONFIG_KEY_0": "diff.ignoreSubmodules",
                             "GIT_CONFIG_VALUE_0": "all"})


if __name__ == "__main__":
    unittest.main()
