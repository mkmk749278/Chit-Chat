/**
 * OfflineQueueService — server-side store-and-forward for offline recipients
 * (Phase 1, design Backend Component B; Requirements 5.x, 8.2).
 *
 * The {@link MessageRelayService} fans an envelope out to the recipient's live node(s).
 * When the recipient has NO live connection (app closed/backgrounded), there is nowhere
 * to fan out to — previously the envelope was dropped while the sender was still ACKed,
 * so the message showed "sent" (✓✓) but never arrived. This queue closes that gap: the
 * opaque ciphertext envelope is held in Redis under `offline:{uid}` and delivered when
 * the recipient next connects ({@link RealtimeGateway} drains it on handshake).
 *
 * Privacy + safety bounds:
 *  - Only the opaque {@link CiphertextEnvelope} is stored — the libsignal ciphertext body
 *    is never decoded, inspected, or logged (Requirement 8.2). The queue holds end-to-end
 *    ciphertext, never plaintext.
 *  - The queue is bounded ({@link MAX_QUEUED_MESSAGES} per recipient, oldest dropped past
 *    the cap) and expires ({@link QUEUE_TTL_SECONDS}); it is drained (deleted) on delivery,
 *    so the server keeps no durable message history (design §"no server-side history").
 *
 * Delivery is at-most-once: the queue is drained atomically on connect and the envelopes
 * are pushed to the freshly-connected socket. A per-message client delivery-ACK (drain →
 * deliver → purge-on-ACK, for at-least-once) is the documented follow-up.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import type { CiphertextEnvelope } from '@chat-app/types';
import type Redis from 'ioredis';

import { REDIS_COMMAND_CLIENT } from '../redis';
import { PushNotificationService } from './push-notification.service';

/** Redis key prefix for a recipient's offline envelope queue: `offline:{uid}`. */
const OFFLINE_QUEUE_PREFIX = 'offline:';

/** Maximum envelopes held per recipient; past this the OLDEST are dropped (bounded memory). */
export const MAX_QUEUED_MESSAGES = 1000;

/** How long an undelivered queue survives before Redis expires it (7 days). */
export const QUEUE_TTL_SECONDS = 7 * 24 * 60 * 60;

/** The minimal `exec()` result shape we read: an array of `[error, result]` tuples, or null. */
type MultiExecResult = Array<[Error | null, unknown]> | null;

@Injectable()
export class OfflineQueueService {
  private readonly logger = new Logger(OfflineQueueService.name);

  constructor(
    @Inject(REDIS_COMMAND_CLIENT) private readonly redis: Redis,
    private readonly pushNotifications: PushNotificationService,
  ) {}

  /**
   * Queue an opaque envelope for a currently-offline recipient. Appends to the tail (FIFO),
   * trims to the most recent {@link MAX_QUEUED_MESSAGES}, and refreshes the TTL — all in one
   * Redis transaction so the bound and expiry are applied atomically with the write. The
   * ciphertext body is stored verbatim and never decoded (Requirement 8.2).
   *
   * After queuing, fires a CONTENT-FREE wake push to the recipient's devices (Req 6.2) so they
   * connect and drain the queue while backgrounded. The push is fire-and-forget — it must never
   * delay or fail the enqueue, and it carries no message content.
   */
  async enqueue(recipientUid: string, envelope: CiphertextEnvelope): Promise<void> {
    const key = OfflineQueueService.queueKey(recipientUid);
    await this.redis
      .multi()
      .rpush(key, JSON.stringify(envelope))
      .ltrim(key, -MAX_QUEUED_MESSAGES, -1)
      .expire(key, QUEUE_TTL_SECONDS)
      .exec();
    void this.pushNotifications.notify(recipientUid);
  }

  /**
   * Atomically read and remove every queued envelope for `recipientUid`, returning them in
   * arrival (FIFO) order. The `LRANGE` + `DEL` run in one transaction so a message can never
   * be drained twice (e.g. by two connections racing). Malformed entries are skipped rather
   * than aborting the whole flush. Returns an empty array when nothing is queued.
   */
  async drain(recipientUid: string): Promise<CiphertextEnvelope[]> {
    const key = OfflineQueueService.queueKey(recipientUid);
    const results = (await this.redis.multi().lrange(key, 0, -1).del(key).exec()) as MultiExecResult;
    if (results === null) {
      // Transaction aborted (e.g. WATCH conflict); treat as nothing drained.
      return [];
    }

    const [lrange] = results;
    const rawEntries = Array.isArray(lrange?.[1]) ? (lrange[1] as string[]) : [];
    const envelopes: CiphertextEnvelope[] = [];
    for (const entry of rawEntries) {
      try {
        envelopes.push(JSON.parse(entry) as CiphertextEnvelope);
      } catch {
        // A corrupt entry is dropped without logging its content (Requirement 8.2).
        this.logger.warn('Discarded a malformed queued envelope while draining');
      }
    }
    return envelopes;
  }

  /** Builds the queue key `offline:{uid}`. */
  private static queueKey(uid: string): string {
    return `${OFFLINE_QUEUE_PREFIX}${uid}`;
  }
}
