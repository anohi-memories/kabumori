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
const FACTORY_PROPERTY = /\bvar reactNativeFactory: (?:Expo)?RCTReactNativeFactory\?/;
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
// didFinishLaunching up to its call into super: the factory must be created and kept there.
const DID_FINISH_LAUNCHING = /didFinishLaunchingWithOptions launchOptions:[\s\S]*?return super\.application\(application, didFinishLaunchingWithOptions: launchOptions\)/g;
const FACTORY_CREATED = /^[ \t]*let factory = ExpoReactNativeFactory\(delegate: delegate\)[ \t]*$/m;
const FACTORY_KEPT = /^[ \t]*reactNativeFactory = factory[ \t]*$/m;

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
 */
function verifyAdopted(source) {
  if (count(source, /\bclass AppDelegate\b/) !== 1 || !source.includes(ADOPTED_DECLARATION)) {
    refuse('the AppDelegate is not the Expo SDK 57 template this plugin was written for, or not adopted completely (declaration)');
  }
  if (count(source, FACTORY_PROPERTY) !== 1) refuse('the AppDelegate does not hold the React Native factory the scene delegate needs (property)');
  const launch = source.match(DID_FINISH_LAUNCHING) ?? [];
  if (launch.length !== 1 || count(launch[0], FACTORY_CREATED) !== 1 || count(launch[0], FACTORY_KEPT) !== 1) {
    refuse('the AppDelegate does not create and keep the React Native factory in didFinishLaunching (reactNativeFactory = factory)');
  }
  if (/\bUIWindow\s*\(/.test(source)) refuse('the AppDelegate still creates its own window (half adopted)');
  if (/\bstartReactNative\b/.test(source)) refuse('the AppDelegate still starts React Native itself (half adopted)');
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
