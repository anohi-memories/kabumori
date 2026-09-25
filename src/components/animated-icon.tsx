import { Image } from 'expo-image';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Dimensions, StyleSheet, View } from 'react-native';
import Animated, { Easing, Keyframe } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

const INITIAL_SCALE_FACTOR = Dimensions.get('screen').height / 90;
const DURATION = 600;

// The Kabumori-branded launch screen. Two phases, both showing the same approved icon on the same
// background so the handoff between them is seamless:
//   1. the native splash (expo-splash-screen's own config in app.json: same image, same
//      backgroundColor) is already on screen before any JS runs;
//   2. this component mounts underneath it, renders an identical-looking static View, then calls
//      SplashScreen.hideAsync() once laid out -- dismissing the native splash reveals this View,
//      which looks the same, so there is no visible jump;
//   3. it then re-renders as an Animated.View whose `entering` keyframe fades and gently scales the
//      icon out, unmounting itself (via the animation's finished callback) once done. The real app
//      content underneath was already mounted the whole time; this overlay is just hiding it.
//
// SPLASH_ICON_SIZE matches app.json's expo-splash-screen `imageWidth`, so phase 1 and phase 2 render
// the icon at the same size -- no size jump alongside the (already seamless) background/image match.
export const SPLASH_BACKGROUND = '#eef3ed'; // KABUMORI_COLORS.light.soft / accentSoft; also src/components/auth-screen.tsx's safeArea. Not imported directly to avoid a cycle; kept identical on purpose.
export const SPLASH_ICON_SIZE = 200;

export function AnimatedSplashOverlay() {
  const [animate, setAnimate] = useState(false);
  const [visible, setVisible] = useState(true);
  // A ref, not state: it only needs to be read once, at the moment the native splash is dismissed,
  // and a ref guarantees that read sees whatever value the effect below has fetched by then,
  // regardless of render/closure timing -- unlike a plain state value captured in onLayout's closure.
  const reduceMotionRef = useRef(false);

  useEffect(() => {
    let active = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((enabled) => {
        if (active) reduceMotionRef.current = enabled;
      })
      .catch(() => {
        // Leave the default (animate normally) if the platform can't answer.
      });
    return () => {
      active = false;
    };
  }, []);

  if (!visible) return null;

  const splashKeyframe = new Keyframe({
    0: {
      transform: [{ scale: 1 }],
      opacity: 1,
    },
    20: {
      opacity: 1,
      transform: [{ scale: 1 }],
    },
    100: {
      opacity: 0,
      transform: [{ scale: 0.94 }],
      easing: Easing.out(Easing.cubic),
    },
  });

  const image = <Image style={styles.splashImage} source={require('@/assets/images/icon.png')} />;

  return animate ? (
    <Animated.View
      entering={splashKeyframe.duration(DURATION).withCallback((finished) => {
        'worklet';
        if (finished) {
          scheduleOnRN(setVisible, false);
        }
      })}
      style={styles.splashOverlay}>
      {image}
    </Animated.View>
  ) : (
    <View
      onLayout={() => {
        SplashScreen.hideAsync().finally(() => {
          if (reduceMotionRef.current) {
            // Reduce Motion is on: skip the animated exit and hide instantly, rather than relying
            // on Reanimated's own reduce-motion handling to still fire the finished-callback this
            // overlay's removal depends on -- an overlay that fails to disappear would be worse
            // than one that disappears without a fade.
            setVisible(false);
          } else {
            setAnimate(true);
          }
        });
      }}
      style={styles.splashOverlay}>
      {image}
    </View>
  );
}

const keyframe = new Keyframe({
  0: {
    transform: [{ scale: INITIAL_SCALE_FACTOR }],
  },
  100: {
    transform: [{ scale: 1 }],
    easing: Easing.elastic(0.7),
  },
});

const logoKeyframe = new Keyframe({
  0: {
    transform: [{ scale: 1.3 }],
    opacity: 0,
  },
  40: {
    transform: [{ scale: 1.3 }],
    opacity: 0,
    easing: Easing.elastic(0.7),
  },
  100: {
    opacity: 1,
    transform: [{ scale: 1 }],
    easing: Easing.elastic(0.7),
  },
});

const glowKeyframe = new Keyframe({
  0: {
    transform: [{ rotateZ: '0deg' }],
  },
  100: {
    transform: [{ rotateZ: '7200deg' }],
  },
});

// Unused anywhere in the app (no import of `AnimatedIcon` exists in src/). Left as-is: it is not
// part of the normal launch this task covers, and assets/images/expo-logo.png staying referenced
// here is exactly why that file is not removed (see the release-readiness doc, finding A6).
export function AnimatedIcon() {
  return (
    <View style={styles.iconContainer}>
      <Animated.View entering={glowKeyframe.duration(60 * 1000 * 4)} style={styles.glow}>
        <Image style={styles.glow} source={require('@/assets/images/logo-glow.png')} />
      </Animated.View>

      <Animated.View entering={keyframe.duration(DURATION)} style={styles.background} />
      <Animated.View style={styles.imageContainer} entering={logoKeyframe.duration(DURATION)}>
        <Image style={styles.image} source={require('@/assets/images/expo-logo.png')} />
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  imageContainer: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  glow: {
    width: 201,
    height: 201,
    position: 'absolute',
  },
  iconContainer: {
    justifyContent: 'center',
    alignItems: 'center',
    width: 128,
    height: 128,
    zIndex: 100,
  },
  image: {
    width: 76,
    height: 71,
  },
  splashImage: {
    width: SPLASH_ICON_SIZE,
    height: SPLASH_ICON_SIZE,
  },
  background: {
    borderRadius: 40,
    experimental_backgroundImage: `linear-gradient(180deg, #3C9FFE, #0274DF)`,
    width: 128,
    height: 128,
    position: 'absolute',
  },
  splashOverlay: {
    ...StyleSheet.absoluteFill,
    backgroundColor: SPLASH_BACKGROUND,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
  },
});
