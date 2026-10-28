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
// nothing. If the AppDelegate is not the SDK 57 template this was written for, prebuild FAILS -- a template change is never
// patched silently.
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

/** The SDK 57 Swift AppDelegate adopted to the scene life cycle. Idempotent; throws on any other template. */
function adoptSceneLifecycle(source) {
  if (source.includes(ADOPTED_DECLARATION) && source.includes('class SceneDelegate: ExpoAppSceneDelegate')) {
    if (OWN_WINDOW.test(source)) throw new Error('with-ios27-scene: AppDelegate is half adopted (it still creates its own window)');
    return source; // already applied
  }
  if (!source.includes(DECLARATION)) {
    throw new Error('with-ios27-scene: the AppDelegate is not the Expo SDK 57 template this plugin was written for (declaration)');
  }
  if (!FACTORY_PROPERTY.test(source)) {
    throw new Error('with-ios27-scene: the AppDelegate does not hold the React Native factory the scene delegate needs');
  }
  if (!OWN_WINDOW.test(source)) {
    throw new Error('with-ios27-scene: the AppDelegate is not the Expo SDK 57 template this plugin was written for (window start)');
  }
  if (source.includes('class SceneDelegate')) {
    throw new Error('with-ios27-scene: the AppDelegate already declares another SceneDelegate');
  }
  return source.replace(DECLARATION, ADOPTED_DECLARATION).replace(OWN_WINDOW, '') + SCENE_DELEGATE;
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
