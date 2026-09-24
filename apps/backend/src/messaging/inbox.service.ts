/**
 * InboxService — the per-recipient, server-side inbox behind reliable (at-least-once) delivery
 * (realtime protocol v2; supersedes the at-most-once `offline:{uid}` store-and-forward list).
 *
 * Every envelope the {@link MessageRelayService} accepts is appended here FIRST, under a
 * server-assigned id, before any live fan-out. The entry stays until the recipient's device
 * confirms it with a `delivered` frame, and the whole inbox is replayed on every (re)connect.
 * That closes the loss windows the old design had:
 *  - an envelope pushed to a socket that was already dead (mobile network switch, OS-frozen app,
 *    or a stale presence entry) was gone, while the sender saw "sent";
 *  - the offline queue was deleted on connect BEFORE the client processed it, so a connection
 *    that dropped mid-drain lost everything that was queued.
 *
 * Storage: one Redis Stream per recipient, `inbox:{uid}`. Stream ids are ordered, unique, and
 * double as the wire `id` the client acknowledges. Bounds (privacy + memory):
 *  - at most {@link MAX_INBOX_ENTRIES} entries (oldest trimmed first);
 *  - entries older than {@link INBOX_TTL_SECONDS} are trimmed on every append, and the whole key
 *    expires {@link INBOX_TTL_SECONDS} after the last append;
 *  - acknowledged entries are deleted, so the server keeps no delivered history.
 * Only the opaque {@link CiphertextEnvelope} is stored — the ciphertext body is never decoded,
 * inspected, or logged (Requirement 8.2).
 *
 * Legacy (protocol v1) clients never acknowledge, so they are served v1 semantics by the gateway:
 * {@link takeAll} drains destructively on connect, and a live delivery to a v1 socket deletes the
 * entry immediately ({@link ack}). Entries left in the pre-v2 `offline:{uid}` list by an older
 * backend are folded into the stream on the recipient's next connect ({@link migrateLegacy}).
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import type { CiphertextEnvelope } from '@chat-app/types';
import type Redis from 'ioredis';

import { REDIS_COMMAND_CLIENT } from '../redis';

/** Redis key prefix for a recipient's inbox stream: `inbox:{uid}`. */
const INBOX_PREFIX = 'inbox:';

/** Redis key prefix of the pre-v2 offline list (`offline:{uid}`), migrated on connect. */
const LEGACY_QUEUE_PREFIX = 'offline:';

/** Stream field holding the JSON-encoded envelope. */
const ENVELOPE_FIELD = 'e';

/** Maximum entries held per recipient; past this the OLDEST are trimmed (bounded memory). */
export const MAX_INBOX_ENTRIES = 1000;

/** How long an undelivered entry survives (7 days), and the idle expiry of the whole inbox. */
export const INBOX_TTL_SECONDS = 7 * 24 * 60 * 60;

/** Upper bound on ids accepted in a single `delivered` frame, so one frame can't do unbounded work. */
export const MAX_ACK_IDS_PER_FRAME = 500;

/** A Redis Stream entry id: `<ms>-<seq>`. Anything else is ignored on ack. */
const STREAM_ID_PATTERN = /^\d{1,20}-\d{1,20}$/;

/**
 * Atomically moves every entry of the legacy `offline:{uid}` list (KEYS[1]) into the inbox stream
 * (KEYS[2]) in FIFO order, then deletes the list. ARGV[1] = max stream length, ARGV[2] = TTL.
 * Returns the number of migrated entries.
 */
const MIGRATE_LEGACY_SCRIPT = `
local items = redis.call('LRANGE', KEYS[1], 0, -1)
for _, value in ipairs(items) do
  redis.call('XADD', KEYS[2], 'MAXLEN', ARGV[1], '*', '${ENVELOPE_FIELD}', value)
end
if #items > 0 then
  redis.call('DEL', KEYS[1])
  redis.call('EXPIRE', KEYS[2], ARGV[2])
end
return #items
`;

/** One inbox entry: the server-assigned id and the opaque envelope. */
export interface InboxEntry {
  id: string;
  envelope: CiphertextEnvelope;
}

/** Raw `XRANGE` reply shape: `[id, [field, value, ...]]` per entry. */
type StreamReply = Array<[string, string[]]>;

/** The minimal `exec()` result shape we read: an array of `[error, result]` tuples, or null. */
type MultiExecResult = Array<[Error | null, unknown]> | null;

@Injectable()
export class InboxService {
  private readonly logger = new Logger(InboxService.name);

  constructor(@Inject(REDIS_COMMAND_CLIENT) private readonly redis: Redis) {}

  /**
   * Append an envelope to `recipientUid`'s inbox and return its id. Applies the length cap, the
   * age trim, and the idle TTL in the same transaction as the write, so the bounds hold even if
   * the recipient never connects again.
   *
   * @throws when Redis rejects the write — the relay must then NOT acknowledge the sender, so the
   *   sender's retry path governs instead of a silently lost message.
   */
  async append(recipientUid: string, envelope: CiphertextEnvelope): Promise<string> {
    const key = InboxService.inboxKey(recipientUid);
    const oldestKeptMs = Date.now() - INBOX_TTL_SECONDS * 1000;
    const results = (await this.redis
      .multi()
      .xadd(key, 'MAXLEN', MAX_INBOX_ENTRIES, '*', ENVELOPE_FIELD, JSON.stringify(envelope))
      .xtrim(key, 'MINID', String(oldestKeptMs))
      .expire(key, INBOX_TTL_SECONDS)
      .exec()) as MultiExecResult;
    const [xadd] = results ?? [];
    if (xadd === undefined || xadd[0] !== null || typeof xadd[1] !== 'string') {
      throw new Error('inbox append failed');
    }
    return xadd[1];
  }

  /**
   * Read (without removing) up to {@link MAX_INBOX_ENTRIES} pending entries in arrival order —
   * the replay a protocol-v2 client receives on every connect. Corrupt entries are skipped.
   */
  async list(recipientUid: string): Promise<InboxEntry[]> {
    const reply = (await this.redis.xrange(
      InboxService.inboxKey(recipientUid),
      '-',
      '+',
      'COUNT',
      MAX_INBOX_ENTRIES,
    )) as StreamReply;
    return this.parseEntries(reply);
  }

  /**
   * Remove acknowledged entries from `recipientUid`'s OWN inbox. Ids that are not well-formed
   * stream ids are ignored, and at most {@link MAX_ACK_IDS_PER_FRAME} are processed per call.
   * Deleting an id that is already gone is a no-op, so duplicate acks are harmless.
   *
   * @returns the number of entries actually removed.
   */
  async ack(recipientUid: string, ids: readonly unknown[]): Promise<number> {
    const valid = ids
      .slice(0, MAX_ACK_IDS_PER_FRAME)
      .filter((id): id is string => typeof id === 'string' && STREAM_ID_PATTERN.test(id));
    if (valid.length === 0) {
      return 0;
    }
    return this.redis.xdel(InboxService.inboxKey(recipientUid), ...valid);
  }

  /**
   * Legacy (protocol v1) connect: atomically read AND delete every pending entry, so a client that
   * never acknowledges is not replayed the same envelopes on every reconnect (it would fail to
   * decrypt them the second time). Preserves the pre-v2 at-most-once behaviour for old app builds.
   */
  async takeAll(recipientUid: string): Promise<InboxEntry[]> {
    const key = InboxService.inboxKey(recipientUid);
    const results = (await this.redis
      .multi()
      .xrange(key, '-', '+')
      .del(key)
      .exec()) as MultiExecResult;
    const [xrange] = results ?? [];
    const reply = Array.isArray(xrange?.[1]) ? (xrange[1] as StreamReply) : [];
    return this.parseEntries(reply);
  }

  /**
   * Fold anything a pre-v2 backend left in the legacy `offline:{uid}` list into the inbox stream
   * (atomic, FIFO-preserving), so an upgrade never strands queued messages. Cheap no-op once the
   * list is gone.
   */
  async migrateLegacy(recipientUid: string): Promise<number> {
    const migrated = (await this.redis.eval(
      MIGRATE_LEGACY_SCRIPT,
      2,
      `${LEGACY_QUEUE_PREFIX}${recipientUid}`,
      InboxService.inboxKey(recipientUid),
      MAX_INBOX_ENTRIES,
      INBOX_TTL_SECONDS,
    )) as number;
    return typeof migrated === 'number' ? migrated : 0;
  }

  /** Decode an `XRANGE` reply, dropping corrupt entries without logging their content (8.2). */
  private parseEntries(reply: StreamReply): InboxEntry[] {
    const entries: InboxEntry[] = [];
    for (const item of reply) {
      if (!Array.isArray(item) || typeof item[0] !== 'string' || !Array.isArray(item[1])) {
        continue;
      }
      const [id, fields] = item;
      let raw: string | undefined;
      for (let i = 0; i + 1 < fields.length; i += 2) {
        if (fields[i] === ENVELOPE_FIELD) {
          raw = fields[i + 1];
          break;
        }
      }
      if (typeof raw !== 'string') {
        continue;
      }
      try {
        entries.push({ id, envelope: JSON.parse(raw) as CiphertextEnvelope });
      } catch {
        this.logger.warn('Discarded a malformed inbox entry');
      }
    }
    return entries;
  }

  /** Builds the inbox key `inbox:{uid}`. */
  private static inboxKey(uid: string): string {
    return `${INBOX_PREFIX}${uid}`;
  }
}
