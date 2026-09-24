/**
 * Backend node identity (Requirement 3.4; design Component 5 + Redis key model §12.3).
 *
 * Every live WebSocket connection is registered in `presence:{uid}` as
 * `{connId -> nodeId}`, and each backend node subscribes to its own
 * `node:{nodeId}` Redis pub/sub channel so Phase 1 cross-node routing can publish to
 * the exact node holding a connection. The `nodeId` must therefore be **stable for
 * the lifetime of the process** and **distinct per running backend instance — and per process
 * incarnation**.
 *
 * Resolution: a base name, suffixed with a random per-boot id:
 *   1. The base is the explicit `NODE_ID` environment variable when set (operators name a
 *      replica, which keeps logs/`CLIENT LIST` readable), otherwise `"{hostname}:{pid}"`.
 *   2. The boot suffix makes every process start a NEW node id. Presence entries written by a
 *      previous incarnation (a crash or redeploy skips disconnect cleanup) then belong to a node
 *      whose liveness marker is gone, so they are ignored and pruned instead of being mistaken for
 *      this process's live connections — in a container the pid is usually 1 and a pinned
 *      `NODE_ID` survives restarts, so without the suffix old and new incarnations collide.
 */

import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';

/** Environment variable an operator can set to name a replica (the base of its node id). */
const NODE_ID_ENV_VAR = 'NODE_ID';

/**
 * Resolves the identifier for this backend node (process incarnation).
 *
 * @param env    - the environment to read `NODE_ID` from (defaults to `process.env`).
 * @param host   - the host name to fall back to (defaults to the OS host name).
 * @param pid    - the process id to fall back to (defaults to this process's pid).
 * @param bootId - the per-incarnation suffix (defaults to 8 random hex chars).
 * @returns `"{NODE_ID}:{bootId}"` when `NODE_ID` is set and non-blank, otherwise
 *   `"{host}:{pid}:{bootId}"`.
 */
export function resolveNodeId(
  env: NodeJS.ProcessEnv = process.env,
  host: string = hostname(),
  pid: number = process.pid,
  bootId: string = randomBytes(4).toString('hex'),
): string {
  const explicit = env[NODE_ID_ENV_VAR];
  const base =
    typeof explicit === 'string' && explicit.trim().length > 0 ? explicit.trim() : `${host}:${pid}`;
  return `${base}:${bootId}`;
}

/** Builds the per-node pub/sub channel name `node:{nodeId}` (design §12.3). */
export function nodeChannel(nodeId: string): string {
  return `node:${nodeId}`;
}
