/**
 * MOCKUP — lightweight, dependency-free icon set.
 *
 * The design (Component 9) specifies real vector icons via `@expo/vector-icons`.
 * That package is NOT currently a dependency of `apps/mobile` (checked
 * `apps/mobile/package.json`), and neither is `react-native-svg`. To keep this
 * visual demo runnable WITHOUT adding any native dependency, the icons below are
 * composed purely from React Native <View>s (borders, transforms, radii).
 *
 * >> PRODUCTION NOTE: the shipping implementation will replace this file with a
 * >> thin wrapper around `@expo/vector-icons` (ships with Expo SDK 51 — no new
 * >> native module / no APK-signing impact), exposing the same semantic names.
 *
 * Every icon is parameterised by `size` and `color` and is purely presentational.
 */

import React from 'react';
import { StyleSheet, View, type ViewStyle } from 'react-native';

export type IconName =
  | 'back' // header back chevron
  | 'chevron-right' // list row affordance
  | 'more-vert' // ⋮ overflow
  | 'timer' // disappearing messages
  | 'shield' // safety number
  | 'verified' // identity verified
  | 'hide' // hide chat (eye-off)
  | 'send' // composer send
  | 'chats' // tab: chats
  | 'calls' // tab: calls
  | 'settings' // tab: settings
  | 'search' // search field
  | 'compose' // new chat / FAB
  | 'avatar-placeholder'; // generic person glyph

export interface IconProps {
  name: IconName;
  size?: number;
  color?: string;
}

/** A tickless tick: a rotated corner used to draw checkmarks. */
function Check({ size, color }: { size: number; color: string }): React.JSX.Element {
  return (
    <View
      style={{
        width: size * 0.5,
        height: size * 0.78,
        borderRightWidth: Math.max(1.5, size * 0.1),
        borderBottomWidth: Math.max(1.5, size * 0.1),
        borderColor: color,
        transform: [{ rotate: '45deg' }],
      }}
    />
  );
}

/** A chevron drawn from two borders of a rotated square. */
function Chevron({
  size,
  color,
  rotate,
}: {
  size: number;
  color: string;
  rotate: string;
}): React.JSX.Element {
  return (
    <View
      style={{
        width: size * 0.5,
        height: size * 0.5,
        borderLeftWidth: Math.max(1.5, size * 0.1),
        borderBottomWidth: Math.max(1.5, size * 0.1),
        borderColor: color,
        transform: [{ rotate }],
      }}
    />
  );
}

export function Icon({ name, size = 22, color = '#1F2430' }: IconProps): React.JSX.Element {
  const box: ViewStyle = {
    width: size,
    height: size,
    alignItems: 'center',
    justifyContent: 'center',
  };
  const stroke = Math.max(1.5, size * 0.09);

  switch (name) {
    case 'back':
      return (
        <View style={box}>
          <Chevron size={size} color={color} rotate="45deg" />
        </View>
      );

    case 'chevron-right':
      return (
        <View style={box}>
          <Chevron size={size} color={color} rotate="-135deg" />
        </View>
      );

    case 'more-vert':
      // Three stacked dots — the canonical overflow affordance.
      return (
        <View style={[box, { justifyContent: 'space-between', paddingVertical: size * 0.15 }]}>
          {[0, 1, 2].map((i) => (
            <View
              key={i}
              style={{
                width: size * 0.16,
                height: size * 0.16,
                borderRadius: size * 0.08,
                backgroundColor: color,
              }}
            />
          ))}
        </View>
      );

    case 'timer':
      // Outline circle with two "hands".
      return (
        <View style={box}>
          <View
            style={{
              width: size * 0.78,
              height: size * 0.78,
              borderRadius: size * 0.39,
              borderWidth: stroke,
              borderColor: color,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <View
              style={{
                position: 'absolute',
                width: stroke,
                height: size * 0.24,
                backgroundColor: color,
                top: size * 0.16,
              }}
            />
            <View
              style={{
                position: 'absolute',
                width: size * 0.2,
                height: stroke,
                backgroundColor: color,
              }}
            />
          </View>
        </View>
      );

    case 'shield':
      // Rounded-top crest with a check inside.
      return (
        <View style={box}>
          <View
            style={{
              width: size * 0.66,
              height: size * 0.78,
              borderWidth: stroke,
              borderColor: color,
              borderTopLeftRadius: size * 0.33,
              borderTopRightRadius: size * 0.33,
              borderBottomLeftRadius: size * 0.18,
              borderBottomRightRadius: size * 0.18,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <View style={{ transform: [{ scale: 0.55 }] }}>
              <Check size={size} color={color} />
            </View>
          </View>
        </View>
      );

    case 'verified':
      // Filled circle with a check punched out (uses contrast color via border).
      return (
        <View style={box}>
          <View
            style={{
              width: size * 0.82,
              height: size * 0.82,
              borderRadius: size * 0.41,
              borderWidth: stroke,
              borderColor: color,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <View style={{ transform: [{ scale: 0.5 }, { translateY: -size * 0.05 }] }}>
              <Check size={size} color={color} />
            </View>
          </View>
        </View>
      );

    case 'hide':
      // Eye outline with a diagonal strike (eye-off).
      return (
        <View style={box}>
          <View
            style={{
              width: size * 0.8,
              height: size * 0.5,
              borderWidth: stroke,
              borderColor: color,
              borderRadius: size * 0.25,
            }}
          />
          <View
            style={{
              position: 'absolute',
              width: size * 0.95,
              height: stroke,
              backgroundColor: color,
              transform: [{ rotate: '-45deg' }],
            }}
          />
        </View>
      );

    case 'send':
      // Right-pointing triangle via the transparent-border trick.
      return (
        <View style={box}>
          <View
            style={{
              width: 0,
              height: 0,
              borderTopWidth: size * 0.34,
              borderBottomWidth: size * 0.34,
              borderLeftWidth: size * 0.55,
              borderTopColor: 'transparent',
              borderBottomColor: 'transparent',
              borderLeftColor: color,
              marginLeft: size * 0.1,
            }}
          />
        </View>
      );

    case 'chats':
      // Rounded speech bubble with a small tail.
      return (
        <View style={box}>
          <View
            style={{
              width: size * 0.82,
              height: size * 0.64,
              borderWidth: stroke,
              borderColor: color,
              borderRadius: size * 0.2,
            }}
          />
          <View
            style={{
              position: 'absolute',
              bottom: size * 0.14,
              left: size * 0.22,
              width: size * 0.18,
              height: size * 0.18,
              borderBottomWidth: stroke,
              borderLeftWidth: stroke,
              borderColor: color,
              transform: [{ rotate: '45deg' }],
            }}
          />
        </View>
      );

    case 'calls':
      // Rounded handset approximated by a tilted rounded square.
      return (
        <View style={box}>
          <View
            style={{
              width: size * 0.6,
              height: size * 0.6,
              borderWidth: stroke,
              borderColor: color,
              borderTopLeftRadius: size * 0.3,
              borderBottomRightRadius: size * 0.3,
              borderTopRightRadius: size * 0.1,
              borderBottomLeftRadius: size * 0.1,
              transform: [{ rotate: '15deg' }],
            }}
          />
        </View>
      );

    case 'settings':
      // Concentric circle (gear approximation) with a center dot.
      return (
        <View style={box}>
          <View
            style={{
              width: size * 0.8,
              height: size * 0.8,
              borderRadius: size * 0.4,
              borderWidth: stroke,
              borderColor: color,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <View
              style={{
                width: size * 0.22,
                height: size * 0.22,
                borderRadius: size * 0.11,
                backgroundColor: color,
              }}
            />
          </View>
        </View>
      );

    case 'search':
      // Circle + handle.
      return (
        <View style={box}>
          <View
            style={{
              width: size * 0.6,
              height: size * 0.6,
              borderRadius: size * 0.3,
              borderWidth: stroke,
              borderColor: color,
              marginTop: -size * 0.08,
              marginLeft: -size * 0.08,
            }}
          />
          <View
            style={{
              position: 'absolute',
              width: size * 0.28,
              height: stroke,
              backgroundColor: color,
              bottom: size * 0.22,
              right: size * 0.18,
              transform: [{ rotate: '45deg' }],
            }}
          />
        </View>
      );

    case 'compose':
      // Pencil: a tilted thin rounded bar.
      return (
        <View style={box}>
          <View
            style={{
              width: size * 0.24,
              height: size * 0.8,
              borderRadius: size * 0.06,
              borderWidth: stroke,
              borderColor: color,
              transform: [{ rotate: '45deg' }],
            }}
          />
        </View>
      );

    case 'avatar-placeholder':
      // Head + shoulders silhouette.
      return (
        <View style={box}>
          <View
            style={{
              width: size * 0.34,
              height: size * 0.34,
              borderRadius: size * 0.17,
              borderWidth: stroke,
              borderColor: color,
              marginBottom: size * 0.05,
            }}
          />
          <View
            style={{
              width: size * 0.6,
              height: size * 0.3,
              borderTopLeftRadius: size * 0.3,
              borderTopRightRadius: size * 0.3,
              borderWidth: stroke,
              borderBottomWidth: 0,
              borderColor: color,
            }}
          />
        </View>
      );

    default:
      return <View style={box} />;
  }
}

// Keep StyleSheet import meaningful for consumers that want a baseline hit area.
export const iconStyles = StyleSheet.create({
  hitArea: { padding: 6 },
});
