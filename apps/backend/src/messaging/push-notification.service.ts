/**
 * PushNotificationService — content-free wake pushes for offline recipients (Phase 2 Req 6.2).
 *
 * When a relayed envelope reaches no live connection of its recipient, this wakes the recipient's
 * devices with a CONTENT-FREE data push: it loads the recipient's stored push tokens and asks the
 * {@link PushSender} to deliver routing metadata only — no message text, no sender plaintext
 * (Req 6.2/6.3). The client wakes, connects, and receives the encrypted inbox replay, so plaintext
 * never traverses the push transport (cross-cutting invariant C1).
 *
 * Bounded: a burst of messages to the same offline user produces at most one wake per
 * {@link WAKE_DEBOUNCE_SECONDS} (the device reconnects and receives the whole inbox anyway), and
 * tokens the provider reports as permanently invalid are pruned so they stop costing a send on
 * every message.
 *
 * Best-effort: a recipient with no registered token is a silent no-op, and any failure is
 * swallowed so it can never break message relay.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';

import { DevicesService } from '../devices';
import { REDIS_COMMAND_CLIENT } from '../redis';
import { PUSH_SENDER, type PushSender } from './push-sender';

/**
 * The content-free payload sent to wake a device. Intentionally carries NO sender or message
 * data — just enough for the client to know it should connect and fetch (Req 6.3).
 */
const WAKE_PAYLOAD: Record<string, string> = { type: 'wake' };

/** Redis key prefix for the per-recipient wake debounce marker: `push-wake:{uid}`. */
const WAKE_DEBOUNCE_PREFIX = 'push-wake:';

/** Minimum spacing between two wake pushes to the same recipient. */
export const WAKE_DEBOUNCE_SECONDS = 5;

@Injectable()
export class PushNotificationService {
  private readonly logger = new Logger(PushNotificationService.name);

  constructor(
    private readonly devices: DevicesService,
    @Inject(PUSH_SENDER) private readonly sender: PushSender,
    @Inject(REDIS_COMMAND_CLIENT) private readonly redis: Redis,
  ) {}

  /**
   * Wake `recipientUid`'s devices with a content-free push. No-op when they have no registered
   * push tokens or were already woken within the debounce window. Never throws — push is an
   * optimization on top of the inbox.
   */
  async notify(recipientUid: string): Promise<void> {
    try {
      if (!(await this.claimWakeSlot(recipientUid))) {
        return;
      }
      const tokens = await this.devices.getPushTokens(recipientUid);
      if (tokens.length === 0) {
        return;
      }
      const result = await this.sender.send(tokens, WAKE_PAYLOAD);
      const invalid = result?.invalidTokens ?? [];
      if (invalid.length > 0) {
        await this.devices.removePushTokens(invalid);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Failed to send wake push: ${message}`);
    }
  }

  /**
   * `SET NX EX` a short-lived marker; only the caller that creates it may push. A Redis failure
   * fails OPEN (push anyway) — an extra wake is harmless, a missing one delays a message.
   */
  private async claimWakeSlot(recipientUid: string): Promise<boolean> {
    try {
      const created = await this.redis.set(
        `${WAKE_DEBOUNCE_PREFIX}${recipientUid}`,
        '1',
        'EX',
        WAKE_DEBOUNCE_SECONDS,
        'NX',
      );
      return created === 'OK';
    } catch {
      return true;
    }
  }
}
