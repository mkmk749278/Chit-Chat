/**
 * `apps/mobile` — durable, encrypted-at-rest {@link RowThreadAssociation} (Shadow Chat Invites,
 * design "Component C → row↔thread association"; Requirement 14).
 *
 * The persisted `MessageRow` carries no `threadId` on the wire (shadow rows are distinguished only by
 * their `+1e9` seq space). To purge "all rows for this `threadId`" on "Clear / Revoke shadow chat",
 * this device-local association records, per shadow `threadId`, the row ids that belong to it. It is
 * an ADDITIVE local-persistence concern bound to the SAME encrypted {@link PersistentVault} the rest
 * of the shadow state uses — it adds no wire/envelope/codec field and never touches the frozen
 * backend. Pure orchestration over the injected vault; no cryptography or RN imports, so it
 * round-trips identically under Node (tests) and on-device.
 */

import type { RowThreadAssociation } from '@chat-app/crypto';

import type { PersistentVault } from '../crypto/persistent-store';

/**
 * Build the durable {@link RowThreadAssociation} over the encrypted {@link PersistentVault}. Each
 * mutation is a single atomic encrypted-blob write (the vault serialises its write chain), so a
 * partially-applied association can never be observed.
 */
export function createVaultRowThreadAssociation(vault: PersistentVault): RowThreadAssociation {
  return {
    async record(rowId: string, threadId: string): Promise<void> {
      await vault.mutate((doc) => {
        const map = doc.shadowRowThreads ?? {};
        // Remove this row from any other thread it might have been tagged under (a row belongs to
        // exactly one thread), then add it to `threadId` without duplicating.
        for (const [tid, ids] of Object.entries(map)) {
          if (tid !== threadId && ids.includes(rowId)) {
            map[tid] = ids.filter((id) => id !== rowId);
          }
        }
        const current = map[threadId] ?? [];
        if (!current.includes(rowId)) {
          map[threadId] = [...current, rowId];
        }
        doc.shadowRowThreads = map;
      });
    },

    async rowIdsForThread(threadId: string): Promise<string[]> {
      return vault.read((doc) => [...(doc.shadowRowThreads?.[threadId] ?? [])]);
    },

    async forgetThread(threadId: string): Promise<void> {
      await vault.mutate((doc) => {
        if (doc.shadowRowThreads !== undefined) {
          delete doc.shadowRowThreads[threadId];
        }
      });
    },
  };
}
