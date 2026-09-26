// Pins how onboarding sits in the startup sequence (src/app/_layout.tsx), preserving the existing
// startup/auth precedence from PR #36 per this task's constraint G: a recovery link still wins over
// everything, auth loading is still checked, and onboarding sits between "loading resolved" and the
// normal session branch -- never replacing or reordering them.
import assert from "node:assert/strict";
import test from "node:test";

async function layoutSource() {
  return Deno.readTextFile(new URL("../../src/app/_layout.tsx", import.meta.url));
}

test("a password-reset link still takes precedence over onboarding, not just over the normal session branch", async () => {
  const source = await layoutSource();
  const linkCheck = source.indexOf("if (link) return <PasswordResetScreen");
  const onboardingRender = source.indexOf("<OnboardingScreens");
  assert.ok(linkCheck > -1 && onboardingRender > -1);
  assert.ok(linkCheck < onboardingRender, "the recovery-link early return must come before onboarding is ever rendered");
});

test("onboarding is decided from a local hook, not read directly from AsyncStorage in the layout", async () => {
  const source = await layoutSource();
  assert.match(source, /useOnboardingV1\(\)/);
  const imports = [...source.matchAll(/^import .* from '([^']+)';?$/gm)].map((m) => m[1]);
  assert.ok(
    !imports.includes('@react-native-async-storage/async-storage'),
    "_layout.tsx should not import AsyncStorage directly; that belongs to the hook",
  );
});

test("the onboarding branch is evaluated before the session/profile branches, and only replaces them, not AppTabs itself", async () => {
  const source = await layoutSource();
  const onboardingBranch = source.indexOf("onboardingCompleted === false");
  const profileBranch = source.indexOf("session && profileError");
  const appTabsBranch = source.indexOf("<AppTabs");
  const authScreenBranch = source.indexOf("<AuthScreen");
  assert.ok(onboardingBranch > -1 && profileBranch > -1 && appTabsBranch > -1 && authScreenBranch > -1);
  assert.ok(onboardingBranch < profileBranch, "onboarding must be checked before the profile-recovery branch");
  assert.ok(profileBranch < appTabsBranch, "profile-recovery must still be checked before AppTabs, unchanged from PR #36");
  assert.ok(appTabsBranch < authScreenBranch, "AppTabs vs AuthScreen ordering is unchanged from PR #36");
});

test("auth loading is still an explicit early gate; onboarding does not replace it, only extends the same gate", async () => {
  const source = await layoutSource();
  assert.match(source, /if \(loading \|\| onboardingCompleted === null\)/);
});

test("AnimatedSplashOverlay is still rendered unconditionally alongside whatever branch is chosen, unchanged from PR #36", async () => {
  const source = await layoutSource();
  const overlayIndex = source.indexOf("<AnimatedSplashOverlay");
  const onboardingBranch = source.indexOf("onboardingCompleted === false");
  assert.ok(overlayIndex > -1 && overlayIndex < onboardingBranch, "the overlay must still sit above the whole branch chain, not inside one branch");
});

test("onboarding completion is wired to the hook's complete(), not a bespoke inline handler", async () => {
  const source = await layoutSource();
  assert.match(source, /onComplete=\{completeOnboarding\}/);
});
