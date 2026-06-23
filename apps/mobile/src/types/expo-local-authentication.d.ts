/**
 * Minimal ambient declarations for `expo-local-authentication` so TypeScript resolves the module
 * in environments where the Expo SDK is not npm-installed (CI sandbox, type-checking only).
 * The real package ships its own types when installed via Expo's managed workflow.
 */
declare module 'expo-local-authentication' {
  export type LocalAuthenticationResult =
    | { success: true }
    | { success: false; error: string; warning?: string };

  export interface LocalAuthenticationOptions {
    promptMessage?: string;
    cancelLabel?: string;
    disableDeviceFallback?: boolean;
    requireConfirmation?: boolean;
    /** 'weak' | 'strong' — 'strong' refuses passcode fallback on Android. */
    biometricsSecurityLevel?: 'weak' | 'strong';
  }

  export function hasHardwareAsync(): Promise<boolean>;
  export function isEnrolledAsync(): Promise<boolean>;
  export function supportedAuthenticationTypesAsync(): Promise<number[]>;
  export function authenticateAsync(
    options?: LocalAuthenticationOptions,
  ): Promise<LocalAuthenticationResult>;
}
