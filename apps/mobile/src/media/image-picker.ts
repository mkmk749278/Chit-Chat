/**
 * `apps/mobile` — native image-picker adapter for end-to-end encrypted attachments (Req 7).
 *
 * Isolates the one `react-native-image-picker` dependency behind a tiny, platform-agnostic
 * function so the rest of the app (controller, screens) deals only in the shared
 * {@link OutgoingAttachment} shape and never imports the native module directly. The decrypted
 * bytes returned here are handed to `Messaging.sendAttachment`, which encrypts them locally under a
 * fresh per-attachment key and uploads only the ciphertext (Req 7.1/7.2) — nothing here touches the
 * network or any key material.
 *
 * The library is asked for base64 so the bytes are available in-process without a second file read;
 * we decode them to a `Uint8Array` (via the polyfilled `Buffer`) for the crypto core.
 */

import { Buffer } from 'buffer';
import { launchImageLibrary } from 'react-native-image-picker';

import type { OutgoingAttachment } from '@chat-app/crypto';

/**
 * Launch the system photo library and return the chosen image as an {@link OutgoingAttachment}, or
 * `null` when the user cancels, the pick fails, or the asset carries no readable bytes. Never throws
 * for an expected outcome (cancellation, permission denial) so callers can treat `null` as "nothing
 * to send".
 */
export async function pickImageAttachment(): Promise<OutgoingAttachment | null> {
  const result = await launchImageLibrary({
    mediaType: 'photo',
    includeBase64: true,
    selectionLimit: 1,
    quality: 0.8,
  });

  if (result.didCancel === true || result.errorCode !== undefined) {
    return null;
  }
  const asset = result.assets?.[0];
  if (asset?.base64 === undefined || asset.base64 === null || asset.base64.length === 0) {
    return null;
  }

  return {
    data: new Uint8Array(Buffer.from(asset.base64, 'base64')),
    mediaType: asset.type ?? 'image/jpeg',
    ...(asset.fileName !== undefined && asset.fileName !== null ? { name: asset.fileName } : {}),
  };
}
