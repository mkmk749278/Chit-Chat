/**
 * PushNotificationService — content-free wake pushes for offline recipients (Phase 2 Req 6.2).
 *
 * When a message is queued for an offline recipient ({@link OfflineQueueService.enqueue}), this
 * wakes the recipient's devices with a CONTENT-FREE data push: it loads the recipient's stored
 * push tokens and asks the {@link PushSender} to deliver routing metadata only — no message text,
 * no sender plaintext (Req 6.2/6.3). The client wakes, connects, and drains the encrypted queue,
 * so plaintext never traverses the push transport (cross-cutting invariant C1).
 *
 * Best-effort: a recipient with no registered token is a silent no-op, and any send failure is
 * swallowed so it can never break message relay/enqueue.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';

import { DevicesService } from '../devices';
import { PUSH_SENDER, type PushSender } from './push-sender';

/**
 * The content-free payload sent to wake a device. Intentionally carries NO sender or message
 * data — just enough for the client to know it should connect and fetch (Req 6.3).
 */
const WAKE_PAYLOAD: Record<string, string> = { type: 'wake' };

@Injectable()
export class PushNotificationService {
  private readonly logger = new Logger(PushNotificationService.name);

  constructor(
    private readonly devices: DevicesService,
    @Inject(PUSH_SENDER) private readonly sender: PushSender,
  ) {}

  /**
   * Wake `recipientUid`'s devices with a content-free push. No-op when they have no registered
   * push tokens. Never throws — push is an optimization on top of store-and-forward.
   */
  async notify(recipientUid: string): Promise<void> {
    try {
      const tokens = await this.devices.getPushTokens(recipientUid);
      if (tokens.length === 0) {
        return;
      }
      await this.sender.send(tokens, WAKE_PAYLOAD);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Failed to send wake push: ${message}`);
    }
  }
}
