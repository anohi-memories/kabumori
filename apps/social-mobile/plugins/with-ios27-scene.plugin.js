// iOS 27 scene life cycle for the SDK 57 prebuild (G1 TASK 23, G2 standard-build QA #540).
//
// The iOS 27 SDK stops an app at launch (`_UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption`) unless it adopts the
// UIScene life cycle. The Expo SDK 57 prebuild template does not: its Info.plist has no `UIApplicationSceneManifest` and its
// AppDelegate creates its own `UIWindow(frame:)` and starts React Native in didFinishLaunching. Expo SDK 57 already ships the
// pieces for the scene life cycle (`ExpoAppSceneDelegate`, `ExpoReactNativeFactoryProvider`); this plugin wires them in:
//   1. Info.plist: one window scene whose delegate is the app's `SceneDelegate`;
//   2. AppDelegate: conforms to `ExpoReactNativeFactoryProvider` (it already holds the factory) and no longer creates the window
//      or starts React Native itself -- `ExpoAppSceneDelegate` does both when the scene connects (it also hands cold-start URLs
//      and user activities to React Native and forwards later URL / activity / quick-action events to the app delegate);
//   3. a `SceneDelegate` class that is Expo's scene delegate.
// The generated native project is never edited by hand: `expo prebuild` applies this every time. Applying it twice changes
// nothing. If the AppDelegate is not the SDK 57 template this was written for, or is only partly adopted, prebuild FAILS -- a
// template change or a partial adoption is never patched or accepted silently.
const { withAppDelegate, withInfoPlist } = require('expo/config-plugins');

const SCENE_DELEGATE_CLASS = '$(PRODUCT_MODULE_NAME).SceneDelegate';

const SCENE_MANIFEST = Object.freeze({
  UIApplicationSupportsMultipleScenes: false,
  UISceneConfigurations: {
    UIWindowSceneSessionRoleApplication: [
      { UISceneConfigurationName: 'Default Configuration', UISceneDelegateClassName: SCENE_DELEGATE_CLASS },
    ],
  },
});

const DECLARATION = 'class AppDelegate: ExpoAppDelegate {';
const ADOPTED_DECLARATION = 'class AppDelegate: ExpoAppDelegate, ExpoReactNativeFactoryProvider {';
// The SDK 57 template creates its own window and starts React Native (module "main") in didFinishLaunching.
const OWN_WINDOW = /#if os\(iOS\) \|\| os\(tvOS\)\n\s*window = UIWindow\(frame: UIScreen\.main\.bounds\)\n\s*factory\.startReactNative\(\n\s*withModuleName: "main",\n[\s\S]*?\)\n#endif\n/;
const SCENE_DELEGATE = `
// The window and React Native are started by the scene: the iOS 27 SDK requires the scene life cycle
// (plugins/with-ios27-scene.plugin.js).
@objc(SceneDelegate)
class SceneDelegate: ExpoAppSceneDelegate {}
`;

/** Info.plist with exactly one window scene whose delegate is the app's SceneDelegate. Throws on a different existing manifest. */
function applySceneManifest(infoPlist) {
  const existing = infoPlist.UIApplicationSceneManifest;
  if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(SCENE_MANIFEST)) {
    throw new Error('with-ios27-scene: Info.plist already has a different UIApplicationSceneManifest; refusing to overwrite it');
  }
  return { ...infoPlist, UIApplicationSceneManifest: JSON.parse(JSON.stringify(SCENE_MANIFEST)) };
}

// The file was adopted before (by this plugin or by hand). Anything else is taken as the template and the result is checked anyway.
const ADOPTED = /\bExpoReactNativeFactoryProvider\b/;
// The head of the adopted SDK 57 AppDelegate, line by line (empty lines aside): the factory property, and a
// didFinishLaunching that creates the factory and keeps it as plain top-level statements -- nothing around or between them.
const ADOPTED_HEAD = [
  ADOPTED_DECLARATION,
  '  var window: UIWindow?',
  '  var reactNativeDelegate: ExpoReactNativeFactoryDelegate?',
  '  var reactNativeFactory: RCTReactNativeFactory?',
  '  public override func application(',
  '    _ application: UIApplication,',
  '    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil',
  '  ) -> Bool {',
  '    let delegate = ReactNativeDelegate()',
  '    let factory = ExpoReactNativeFactory(delegate: delegate)',
  '    delegate.dependencyProvider = RCTAppDependencyProvider()',
  '    reactNativeDelegate = delegate',
  '    reactNativeFactory = factory',
  '    return super.application(application, didFinishLaunchingWithOptions: launchOptions)',
  '  }',
];
// Swift text that can hide a whole line from the compiler: a block comment or a multi-line string. Neither is in the template, so any
// of them is refused -- every other comment or string ends on its line, and the head above is matched as whole lines.
const HIDES_LINES = /\/\*|"""/;

function count(source, pattern) {
  return (source.match(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`)) ?? []).length;
}

function refuse(reason) {
  throw new Error(`with-ios27-scene: ${reason}`);
}

/**
 * Throws unless `source` is a complete scene adoption: the provider conformance, a factory the scene delegate can read (ExpoAppSceneDelegate
 * stops the app with fatalError when `reactNativeFactory` is nil), nothing left that creates a window or starts React Native itself --
 * in any spelling or #if block, not only the template's -- and exactly this plugin's SceneDelegate.
 * What must be there is matched as the SDK 57 head, whole lines outside any #if, so a line the compiler never runs (a comment, a string,
 * a branch, a closure) cannot stand in for it; what must not be there is searched for in the raw text, comments and strings included.
 */
function verifyAdopted(source) {
  const lines = source.split('\n').filter((line) => line !== '');
  const head = lines.indexOf(ADOPTED_DECLARATION);
  if (count(source, /\bclass AppDelegate\b/) !== 1 || head === -1) {
    refuse('the AppDelegate is not the Expo SDK 57 template this plugin was written for, or not adopted completely (declaration)');
  }
  if (/\bUIWindow\s*\(/.test(source)) refuse('the AppDelegate still creates its own window (half adopted)');
  if (/\bstartReactNative\b/.test(source)) refuse('the AppDelegate still starts React Native itself (half adopted)');
  if (HIDES_LINES.test(source)) refuse('the AppDelegate has a block comment or a multi-line string (not in the SDK 57 template)');
  const conditional = lines.slice(0, head).reduce((depth, line) => depth + (/^\s*#if\b/.test(line) ? 1 : 0) - (/^\s*#endif\b/.test(line) ? 1 : 0), 0);
  if (conditional !== 0 || ADOPTED_HEAD.some((line, i) => lines[head + i] !== line)) {
    refuse('the AppDelegate does not create and keep the React Native factory in didFinishLaunching (reactNativeFactory = factory) the way the SDK 57 template does');
  }
  if (count(source, /\breactNativeFactory\s*=/) !== 1) refuse('the AppDelegate assigns the factory somewhere else as well (a second time)');
  if (count(source, /\bSceneDelegate\b/) !== 2 || !source.endsWith(SCENE_DELEGATE)) {
    refuse('the SceneDelegate is not exactly the one this plugin adds');
  }
  return source;
}

/** The SDK 57 Swift AppDelegate adopted to the scene life cycle. Idempotent; throws on any other template or a partial adoption. */
function adoptSceneLifecycle(source) {
  if (ADOPTED.test(source)) return verifyAdopted(source); // applied before: only a complete adoption is kept
  if (count(source, OWN_WINDOW) !== 1) {
    refuse('the AppDelegate is not the Expo SDK 57 template this plugin was written for (window start)');
  }
  // The result is checked as a whole: another declaration, a factory that is not kept, a window / start the template block did not
  // cover or a SceneDelegate of the file's own all fail here.
  return verifyAdopted(source.replace(DECLARATION, ADOPTED_DECLARATION).replace(OWN_WINDOW, '') + SCENE_DELEGATE);
}

function withIos27Scene(config) {
  config = withInfoPlist(config, (cfg) => {
    cfg.modResults = applySceneManifest(cfg.modResults);
    return cfg;
  });
  config = withAppDelegate(config, (cfg) => {
    if (cfg.modResults.language !== 'swift') throw new Error('with-ios27-scene: expected a Swift AppDelegate');
    cfg.modResults.contents = adoptSceneLifecycle(cfg.modResults.contents);
    return cfg;
  });
  return config;
}

module.exports = withIos27Scene;
module.exports.applySceneManifest = applySceneManifest;
module.exports.adoptSceneLifecycle = adoptSceneLifecycle;
module.exports.SCENE_MANIFEST = SCENE_MANIFEST;
