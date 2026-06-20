/**
 * `@chat-app/crypto` — `RowThreadAssociation` (Shadow Chat Invites, design Component C).
 *
 * Source of truth: `.kiro/specs/shadow-chat-invites/design.md` → Component C, the
 * "History purge — row↔thread association (device-local, additive)" note, and
 * `.kiro/specs/shadow-chat-invites/requirements.md` → Requirement 14.
 *
 * ## Why this module exists
 *
 * "Clear shadow chat" (Req 6) and "Revoke shadow chat" (Req 7) must purge **one shadow thread's**
 * local message history through the existing `KeyStore.purgeMessages(ids: string[])` primitive
 * (`ports.ts`) — exactly the primitive the app's "Clear chat" already uses. That primitive is keyed
 * by **row id**, but the persisted `MessageRow` (`ports.ts`) carries **no `threadId`** today: shadow
 * rows are distinguished only by their `+1e9` sequence space per `remoteUid`, which is not enough to
 * resolve "all rows for THIS `threadId`". This module supplies the missing, **device-local**
 * row→thread mapping so Clear/Revoke can enumerate a thread's row ids and hand them to
 * `KeyStore.purgeMessages`.
 *
 * ## Hard invariants (Requirement 14.3, 14.4)
 *
 * - **Device-local & additive.** This is purely an on-device persistence addition. It adds **no**
 *   wire field, **no** envelope field, and **no** codec field.
 * - **Never touches the wire representation.** It does **not** alter the existing `MessageRow` shape
 *   and does **not** change the frozen backend contract at `api.luminchat.app`. The `threadId` lives
 *   only in this side mapping, never on the wire (the `threadId` is never transmitted — only the
 *   shared `threadKey` is, inside the E2E ciphertext of the invite).
 *
 * ## Contract
 *
 * The association is a narrow injected **port** ({@link RowThreadAssociation}) with an in-memory
 * reference implementation ({@link InMemoryRowThreadAssociation}) suitable for tests and the web
 * in-memory store. The mobile/web platform adapters will later back the same port with the encrypted
 * store (mirroring how `ShadowSecretPersistence` is bound to the encrypted `KeyStore`); the port shape
 * is what the pure core depends on, so swapping the backing store does not touch this contract.
 *
 * All operations are **total** — they never throw on normal inputs — and the resolver is order-
 * unspecified (callers that need ordering sort the resolved rows themselves, exactly as
 * `KeyStore.loadMessages` already documents).
 *
 * This module performs no I/O of its own and holds no cryptography; the in-memory reference
 * implementation is small, total, and dependency-free.
 */

/**
 * A device-local, additive association from persisted message rows to the shadow `threadId` they
 * belong to. It exists solely so "Clear shadow chat" / "Revoke shadow chat" can resolve every row id
 * for a `threadId` and pass them to `KeyStore.purgeMessages` (Requirement 14).
 *
 * It adds **no** wire/envelope/codec field and never alters the `MessageRow` wire representation or
 * the frozen backend contract (Requirement 14.3, 14.4) — the `threadId` is held only on-device.
 */
export interface RowThreadAssociation {
  /**
   * Tag a persisted shadow row with its `threadId` (Requirement 14.1). Called from the shadow
   * message persist path each time a shadow row is appended, so the row becomes resolvable by its
   * thread.
   *
   * Idempotent: recording the same `rowId` again keeps/updates its `threadId` rather than creating a
   * duplicate, so a re-persisted or re-tagged row never appears twice in {@link rowIdsForThread}.
   *
   * @param rowId - the persisted `MessageRow.id` (the key `KeyStore.purgeMessages` uses).
   * @param threadId - the shadow thread this row belongs to.
   */
  record(rowId: string, threadId: string): Promise<void>;

  /**
   * Resolve **all** row ids belonging to `threadId` (Requirement 14.2), for the Clear/Revoke history
   * purge to hand to `KeyStore.purgeMessages`. Returns an empty array for an unknown, never-recorded,
   * or already-forgotten/closed thread. Order is unspecified.
   *
   * @param threadId - the shadow thread whose rows to resolve.
   */
  rowIdsForThread(threadId: string): Promise<string[]>;

  /**
   * Drop the association for `threadId` entirely (used after Revoke/close so a reopened id never
   * resurrects the old thread's row ids). Idempotent: forgetting an unknown/already-forgotten thread
   * is a no-op. After this, {@link rowIdsForThread} for the same `threadId` resolves to `[]`.
   *
   * @param threadId - the shadow thread whose association to drop.
   */
  forgetThread(threadId: string): Promise<void>;
}

/**
 * An in-memory reference {@link RowThreadAssociation}, mirroring the repo's other in-memory fakes
 * (e.g. the in-memory `KeyStore`/persistence stubs). Suitable for tests and the web in-memory store;
 * the mobile/web adapters will later back the same port with the encrypted store.
 *
 * Small, total, and dependency-free. It keeps a forward `rowId → threadId` map (so re-recording a row
 * under a new thread is a clean update with no stale membership) and a `threadId → Set<rowId>` index
 * (so resolution and forgetting are direct lookups), keeping the two views consistent on every write.
 */
export class InMemoryRowThreadAssociation implements RowThreadAssociation {
  /** Forward map: each row id's current thread. Lets a re-record cleanly move a row between threads. */
  private readonly threadByRow = new Map<string, string>();
  /** Reverse index: each thread's row ids, for direct resolution and forgetting. */
  private readonly rowsByThread = new Map<string, Set<string>>();

  async record(rowId: string, threadId: string): Promise<void> {
    const previous = this.threadByRow.get(rowId);
    if (previous === threadId) {
      return; // already tagged to this thread — idempotent no-op
    }
    if (previous !== undefined) {
      // The row was previously tagged to a different thread; remove the stale membership first so the
      // old thread never resolves a row that has moved (keeps the two views consistent).
      const previousRows = this.rowsByThread.get(previous);
      if (previousRows !== undefined) {
        previousRows.delete(rowId);
        if (previousRows.size === 0) {
          this.rowsByThread.delete(previous);
        }
      }
    }
    this.threadByRow.set(rowId, threadId);
    let rows = this.rowsByThread.get(threadId);
    if (rows === undefined) {
      rows = new Set<string>();
      this.rowsByThread.set(threadId, rows);
    }
    rows.add(rowId);
  }

  async rowIdsForThread(threadId: string): Promise<string[]> {
    const rows = this.rowsByThread.get(threadId);
    return rows === undefined ? [] : Array.from(rows);
  }

  async forgetThread(threadId: string): Promise<void> {
    const rows = this.rowsByThread.get(threadId);
    if (rows === undefined) {
      return; // unknown/already-forgotten thread — idempotent no-op
    }
    for (const rowId of rows) {
      this.threadByRow.delete(rowId);
    }
    this.rowsByThread.delete(threadId);
  }
}
