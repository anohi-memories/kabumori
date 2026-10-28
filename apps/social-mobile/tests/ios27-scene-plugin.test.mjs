// G1 TASK 23: the Expo config plugin that makes the SDK 57 prebuild adopt the UIScene life cycle the iOS 27 SDK requires
// (plugins/with-ios27-scene.plugin.js). Offline: the two transforms are run on the AppDelegate and Info.plist the standard
// `expo prebuild` of THIS app generates with Expo 57.0.23 (copied below verbatim), and the plugin is wired through app.json.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';

const require = createRequire(import.meta.url);
const plugin = require('../plugins/with-ios27-scene.plugin.js');

const NETWORK = ['fetch', 'XMLHttpRequest', 'WebSocket'];
const saved = new Map();
let trapped = 0;
test.before(() => {
  for (const name of NETWORK) {
    saved.set(name, globalThis[name]);
    globalThis[name] = function forbidden() { trapped += 1; throw new Error(`network entry point ${name} must not be used`); };
  }
});
test.after(() => {
  for (const name of NETWORK) {
    if (saved.get(name) === undefined) delete globalThis[name];
    else globalThis[name] = saved.get(name);
  }
  assert.equal(trapped, 0);
});

/** The AppDelegate.swift the standard SDK 57 prebuild generates for this app (no plugin). */
const SDK57_APP_DELEGATE = `internal import Expo
import React
import ReactAppDependencyProvider

@main
class AppDelegate: ExpoAppDelegate {
  var window: UIWindow?

  var reactNativeDelegate: ExpoReactNativeFactoryDelegate?
  var reactNativeFactory: RCTReactNativeFactory?

  public override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    let delegate = ReactNativeDelegate()
    let factory = ExpoReactNativeFactory(delegate: delegate)
    delegate.dependencyProvider = RCTAppDependencyProvider()

    reactNativeDelegate = delegate
    reactNativeFactory = factory

#if os(iOS) || os(tvOS)
    window = UIWindow(frame: UIScreen.main.bounds)
    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: launchOptions)
#endif

    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  // Linking API
  public override func application(
    _ app: UIApplication,
    open url: URL,
    options: [UIApplication.OpenURLOptionsKey: Any] = [:]
  ) -> Bool {
    return super.application(app, open: url, options: options) || RCTLinkingManager.application(app, open: url, options: options)
  }

  // Universal Links
  public override func application(
    _ application: UIApplication,
    continue userActivity: NSUserActivity,
    restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void
  ) -> Bool {
    let result = RCTLinkingManager.application(application, continue: userActivity, restorationHandler: restorationHandler)
    return super.application(application, continue: userActivity, restorationHandler: restorationHandler) || result
  }
}

class ReactNativeDelegate: ExpoReactNativeFactoryDelegate {
  // Extension point for config-plugins

  override func sourceURL(for bridge: RCTBridge) -> URL? {
    // needed to return the correct URL for expo-dev-client.
    bridge.bundleURL ?? bundleURL()
  }

  override func bundleURL() -> URL? {
#if DEBUG
    return RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: ".expo/.virtual-metro-entry")
#else
    return Bundle.main.url(forResource: "main", withExtension: "jsbundle")
#endif
  }
}
`;

/** The same file after the plugin (what `expo prebuild` with the plugin generated, twice, identically). */
const ADOPTED_APP_DELEGATE = `internal import Expo
import React
import ReactAppDependencyProvider

@main
class AppDelegate: ExpoAppDelegate, ExpoReactNativeFactoryProvider {
  var window: UIWindow?

  var reactNativeDelegate: ExpoReactNativeFactoryDelegate?
  var reactNativeFactory: RCTReactNativeFactory?

  public override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    let delegate = ReactNativeDelegate()
    let factory = ExpoReactNativeFactory(delegate: delegate)
    delegate.dependencyProvider = RCTAppDependencyProvider()

    reactNativeDelegate = delegate
    reactNativeFactory = factory


    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  // Linking API
  public override func application(
    _ app: UIApplication,
    open url: URL,
    options: [UIApplication.OpenURLOptionsKey: Any] = [:]
  ) -> Bool {
    return super.application(app, open: url, options: options) || RCTLinkingManager.application(app, open: url, options: options)
  }

  // Universal Links
  public override func application(
    _ application: UIApplication,
    continue userActivity: NSUserActivity,
    restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void
  ) -> Bool {
    let result = RCTLinkingManager.application(application, continue: userActivity, restorationHandler: restorationHandler)
    return super.application(application, continue: userActivity, restorationHandler: restorationHandler) || result
  }
}

class ReactNativeDelegate: ExpoReactNativeFactoryDelegate {
  // Extension point for config-plugins

  override func sourceURL(for bridge: RCTBridge) -> URL? {
    // needed to return the correct URL for expo-dev-client.
    bridge.bundleURL ?? bundleURL()
  }

  override func bundleURL() -> URL? {
#if DEBUG
    return RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: ".expo/.virtual-metro-entry")
#else
    return Bundle.main.url(forResource: "main", withExtension: "jsbundle")
#endif
  }
}

// The window and React Native are started by the scene: the iOS 27 SDK requires the scene life cycle
// (plugins/with-ios27-scene.plugin.js).
@objc(SceneDelegate)
class SceneDelegate: ExpoAppSceneDelegate {}
`;

test('AppDelegate: the SDK 57 template is adopted exactly -- provider conformance, no own window / start, a SceneDelegate', () => {
  const out = plugin.adoptSceneLifecycle(SDK57_APP_DELEGATE);
  assert.equal(out, ADOPTED_APP_DELEGATE, 'the same text the real prebuild produced');
  assert.ok(out.includes('class AppDelegate: ExpoAppDelegate, ExpoReactNativeFactoryProvider {'));
  assert.ok(!out.includes('UIWindow(frame:'), 'the app delegate no longer creates its own window');
  assert.ok(!out.includes('factory.startReactNative('), 'React Native is started by the scene');
  assert.ok(out.includes('@objc(SceneDelegate)\nclass SceneDelegate: ExpoAppSceneDelegate {}'));
  assert.ok(out.includes('reactNativeFactory = factory'), 'the factory is still created and kept for the scene delegate');
  assert.ok(out.includes('RCTLinkingManager.application(app, open: url, options: options)'), 'deep links are still handed to React Native');
  assert.ok(out.includes('continue userActivity'), 'universal links too');
});

test('AppDelegate: applying it again changes nothing (idempotent)', () => {
  const once = plugin.adoptSceneLifecycle(SDK57_APP_DELEGATE);
  assert.equal(plugin.adoptSceneLifecycle(once), once);
});

test('AppDelegate: any other template makes prebuild FAIL instead of being patched silently', () => {
  const cases = [
    ['another declaration', SDK57_APP_DELEGATE.replace('class AppDelegate: ExpoAppDelegate {', 'class AppDelegate: UIResponder, UIApplicationDelegate {')],
    ['no factory property', SDK57_APP_DELEGATE.replace('  var reactNativeFactory: RCTReactNativeFactory?\n', '')],
    ['no own window start (e.g. a template that already uses scenes)', SDK57_APP_DELEGATE.replace('    window = UIWindow(frame: UIScreen.main.bounds)\n', '')],
    ['another module name', SDK57_APP_DELEGATE.replace('withModuleName: "main"', 'withModuleName: "other"')],
    ['a SceneDelegate of its own', SDK57_APP_DELEGATE + '\nclass SceneDelegate: UIResponder, UIWindowSceneDelegate {}\n'],
    ['half adopted (declaration and delegate but still its own window)', SDK57_APP_DELEGATE.replace('class AppDelegate: ExpoAppDelegate {', 'class AppDelegate: ExpoAppDelegate, ExpoReactNativeFactoryProvider {') + '\n@objc(SceneDelegate)\nclass SceneDelegate: ExpoAppSceneDelegate {}\n'],
  ];
  for (const [label, source] of cases) {
    assert.throws(() => plugin.adoptSceneLifecycle(source), /with-ios27-scene/u, label);
  }
});

// G1 TASK 24 (H1 review of PR #544, P2 F1): an incomplete AppDelegate must never be taken as adopted -- neither on the first run nor
// when the file already looks applied. ExpoAppSceneDelegate stops the app (fatalError) when `reactNativeFactory` is nil, and an
// own window / start left in any #if spelling would start React Native a second time next to the scene.
const KEPT = '    reactNativeFactory = factory\n';
const SCENE_BLOCK = ADOPTED_APP_DELEGATE.slice(ADOPTED_APP_DELEGATE.indexOf('\n// The window and React Native are started by the scene'));
const DID_FINISH_LAUNCHING_FN = ADOPTED_APP_DELEGATE.match(/  public override func application\(\n    _ application: UIApplication,\n    didFinishLaunchingWithOptions[\s\S]*?\n  \}\n/u)[0];
const OWN_START_IOS_ONLY = '#if os(iOS)\n    window = UIWindow(frame: UIScreen.main.bounds)\n    factory.startReactNative(\n      withModuleName: "main",\n      in: window,\n      launchOptions: launchOptions)\n#endif\n';

const NOT_KEPT = /create and keep the React Native factory in didFinishLaunching/u;
const OWN_WINDOW_LEFT = /still creates its own window/u;
const OWN_START_LEFT = /still starts React Native itself/u;
const NOT_THIS_SCENE_DELEGATE = /SceneDelegate is not exactly the one this plugin adds/u;
const NOT_ADOPTED = /or not adopted completely \(declaration\)/u;
const NO_PROPERTY = /does not hold the React Native factory the scene delegate needs/u;

/** The three inputs H1 reproduced (the real prebuild accepted 2 and 3 with exit 0). */
const H1_NEGATIVES = [
  ['first run: the template does not keep the factory (reactNativeFactory = factory removed)', SDK57_APP_DELEGATE.replace(KEPT, ''), NOT_KEPT],
  ['already applied: the factory is no longer kept', ADOPTED_APP_DELEGATE.replace(KEPT, ''), NOT_KEPT],
  [
    'half applied: provider + SceneDelegate, but its own window / start is still there under #if os(iOS)',
    SDK57_APP_DELEGATE.replace('class AppDelegate: ExpoAppDelegate {', 'class AppDelegate: ExpoAppDelegate, ExpoReactNativeFactoryProvider {')
      .replace('#if os(iOS) || os(tvOS)\n', '#if os(iOS)\n') + SCENE_BLOCK,
    OWN_WINDOW_LEFT,
  ],
];

test('F1: the three H1 reproductions make prebuild FAIL -- through the helper and through the registered AppDelegate mod', async () => {
  const config = plugin({ name: 'social-mobile', slug: 'social-mobile' });
  for (const [label, source, reason] of H1_NEGATIVES) {
    assert.ok(source !== SDK57_APP_DELEGATE && source !== ADOPTED_APP_DELEGATE, `${label}: the input really differs`);
    assert.throws(() => plugin.adoptSceneLifecycle(source), reason, label);
    await assert.rejects(
      Promise.resolve().then(() => config.mods.ios.appDelegate({ modResults: { language: 'swift', contents: source }, modRequest: { platform: 'ios', introspect: false }, modRawConfig: {} })),
      reason,
      `${label} (mod)`,
    );
  }
});

test('F1: an already-applied file is checked as a whole, not by the template block or the class names alone', () => {
  const adoptedDeclaration = (source) => source.replace('class AppDelegate: ExpoAppDelegate {', 'class AppDelegate: ExpoAppDelegate, ExpoReactNativeFactoryProvider {');
  const cases = [
    ['the kept factory only in a comment', ADOPTED_APP_DELEGATE.replace(KEPT, '    // reactNativeFactory = factory\n'), NOT_KEPT],
    ['the factory kept somewhere other than didFinishLaunching', ADOPTED_APP_DELEGATE.replace(KEPT, '').replace('  // Linking API\n', '  func keep(_ factory: RCTReactNativeFactory) {\n    reactNativeFactory = factory\n  }\n\n  // Linking API\n'), NOT_KEPT],
    ['the factory not created', ADOPTED_APP_DELEGATE.replace('    let factory = ExpoReactNativeFactory(delegate: delegate)\n', '    let factory = makeFactory()\n'), NOT_KEPT],
    ['the factory kept twice', ADOPTED_APP_DELEGATE.replace(KEPT, KEPT + KEPT), NOT_KEPT],
    ['no factory property', ADOPTED_APP_DELEGATE.replace('  var reactNativeFactory: RCTReactNativeFactory?\n', ''), NO_PROPERTY],
    ['the template block still there', adoptedDeclaration(SDK57_APP_DELEGATE) + SCENE_BLOCK, OWN_WINDOW_LEFT],
    ['a window without #if', ADOPTED_APP_DELEGATE.replace(KEPT, `${KEPT}    window = UIWindow(windowScene: scene)\n`), OWN_WINDOW_LEFT],
    ['a start without a window', ADOPTED_APP_DELEGATE.replace(KEPT, `${KEPT}#if os(tvOS)\n    factory.startReactNative(withModuleName: "main", in: window, launchOptions: launchOptions)\n#endif\n`), OWN_START_LEFT],
    ['provider conformance but no SceneDelegate', ADOPTED_APP_DELEGATE.replace(SCENE_BLOCK, ''), NOT_THIS_SCENE_DELEGATE],
    ['a SceneDelegate of another kind', ADOPTED_APP_DELEGATE.replace('class SceneDelegate: ExpoAppSceneDelegate {}', 'class SceneDelegate: UIResponder, UIWindowSceneDelegate {}'), NOT_THIS_SCENE_DELEGATE],
    ['a second SceneDelegate', ADOPTED_APP_DELEGATE.replace('class ReactNativeDelegate:', 'class SceneDelegate: UIResponder {}\n\nclass ReactNativeDelegate:'), NOT_THIS_SCENE_DELEGATE],
    ['the SceneDelegate but not the provider conformance', SDK57_APP_DELEGATE.replace(/#if os\(iOS\) \|\| os\(tvOS\)\n[\s\S]*?#endif\n/u, '') + SCENE_BLOCK, /\(window start\)/u],
    ['a second didFinishLaunching under #if', ADOPTED_APP_DELEGATE.replace('  // Linking API\n', `#if os(tvOS)\n${DID_FINISH_LAUNCHING_FN}#endif\n\n  // Linking API\n`), NOT_KEPT],
    ['the provider conformance on a second AppDelegate', ADOPTED_APP_DELEGATE + '\nclass AppDelegate: ExpoAppDelegate {}\n', NOT_ADOPTED],
  ];
  for (const [label, source, reason] of cases) {
    assert.ok(source !== ADOPTED_APP_DELEGATE, `${label}: the input really differs`);
    assert.throws(() => plugin.adoptSceneLifecycle(source), reason, label);
  }
});

test('F1: on the first run the whole result is checked -- a second own start the template block does not cover is refused', () => {
  const cases = [
    ['a second window / start under #if os(iOS)', SDK57_APP_DELEGATE.replace('#endif\n\n    return super', `#endif\n${OWN_START_IOS_ONLY}\n    return super`), OWN_WINDOW_LEFT],
    ['the template block twice', SDK57_APP_DELEGATE.replace(/(#if os\(iOS\) \|\| os\(tvOS\)\n[\s\S]*?#endif\n)/u, '$1$1'), /\(window start\)/u],
    ['two AppDelegate classes', SDK57_APP_DELEGATE + '\nclass AppDelegate: ExpoAppDelegate {}\n', NOT_ADOPTED],
    ['the template with a SceneDelegate of its own', SDK57_APP_DELEGATE + SCENE_BLOCK, NOT_THIS_SCENE_DELEGATE],
    ['the factory property twice', SDK57_APP_DELEGATE.replace('  var reactNativeFactory: RCTReactNativeFactory?\n', '  var reactNativeFactory: RCTReactNativeFactory?\n  var reactNativeFactory: RCTReactNativeFactory?\n'), NO_PROPERTY],
  ];
  for (const [label, source, reason] of cases) {
    assert.throws(() => plugin.adoptSceneLifecycle(source), reason, label);
  }
});

test('F1: the AppDelegate and Info.plist name the same SceneDelegate; quick actions / URLs / activities stay with ExpoAppDelegate', () => {
  const out = plugin.adoptSceneLifecycle(SDK57_APP_DELEGATE);
  const objcName = out.match(/@objc\((\w+)\)\nclass (\w+): ExpoAppSceneDelegate \{\}/u);
  assert.ok(objcName, 'one Expo scene delegate');
  assert.equal(objcName[1], objcName[2]);
  const [scene] = plugin.SCENE_MANIFEST.UISceneConfigurations.UIWindowSceneSessionRoleApplication;
  assert.equal(scene.UISceneDelegateClassName, `$(PRODUCT_MODULE_NAME).${objcName[2]}`);
  for (const kept of ['open url: URL', 'continue userActivity: NSUserActivity', 'class AppDelegate: ExpoAppDelegate,']) {
    assert.ok(out.includes(kept), `${kept} is kept`);
  }
  assert.ok(!/performActionFor|shortcutItem/u.test(out), 'quick actions: no override of its own -- ExpoAppDelegate and the scene forwarder handle them');
});

test('Info.plist: one window scene whose delegate is the app\'s SceneDelegate; other keys untouched; idempotent; never overwrites another manifest', () => {
  const plist = { CFBundleName: 'SocialOperations', UILaunchStoryboardName: 'SplashScreen', CFBundleURLTypes: [{ CFBundleURLSchemes: ['socialmobile'] }] };
  const out = plugin.applySceneManifest(plist);
  assert.deepEqual(out.UIApplicationSceneManifest, {
    UIApplicationSupportsMultipleScenes: false,
    UISceneConfigurations: {
      UIWindowSceneSessionRoleApplication: [
        { UISceneConfigurationName: 'Default Configuration', UISceneDelegateClassName: '$(PRODUCT_MODULE_NAME).SceneDelegate' },
      ],
    },
  });
  for (const key of Object.keys(plist)) assert.deepEqual(out[key], plist[key], `${key} is kept`);
  assert.equal(plist.UIApplicationSceneManifest, undefined, 'the input is not changed in place');
  assert.deepEqual(plugin.applySceneManifest(out), out, 'idempotent');
  out.UIApplicationSceneManifest.UIApplicationSupportsMultipleScenes = true;
  assert.equal(plugin.SCENE_MANIFEST.UIApplicationSupportsMultipleScenes, false, 'the shared manifest cannot be changed through a result');
  assert.throws(() => plugin.applySceneManifest({ UIApplicationSceneManifest: { UIApplicationSupportsMultipleScenes: true } }), /different UIApplicationSceneManifest/u);
});

test('wiring: app.json runs the plugin once, after the other plugins, and the plugin registers exactly the Info.plist and AppDelegate mods', async () => {
  const appJson = JSON.parse(await readFile(new URL('../app.json', import.meta.url), 'utf8'));
  const plugins = appJson.expo.plugins;
  assert.equal(plugins.filter((p) => p === './plugins/with-ios27-scene.plugin.js').length, 1);
  assert.equal(plugins[plugins.length - 1], './plugins/with-ios27-scene.plugin.js');
  assert.equal(appJson.expo.ios.bundleIdentifier, undefined, 'the app identity is not changed by this TASK');
  const config = plugin({ name: 'social-mobile', slug: 'social-mobile' });
  assert.deepEqual(Object.keys(config.mods ?? {}), ['ios']);
  assert.deepEqual(Object.keys(config.mods.ios).sort(), ['appDelegate', 'infoPlist']);
});

test('the AppDelegate mod refuses an Objective-C AppDelegate (only the Swift template is known)', async () => {
  const config = plugin({ name: 'social-mobile', slug: 'social-mobile' });
  const run = (modResults) => config.mods.ios.appDelegate({ modResults, modRequest: { platform: 'ios', introspect: false }, modRawConfig: {} });
  await assert.rejects(Promise.resolve().then(() => run({ language: 'objc', contents: '@implementation AppDelegate' })), /expected a Swift AppDelegate/u);
  const swift = await run({ language: 'swift', contents: SDK57_APP_DELEGATE });
  assert.equal(swift.modResults.contents, ADOPTED_APP_DELEGATE);
});
