/**
 * Backend node identity (Requirement 3.4; design Component 5 + Redis key model §12.3).
 *
 * Every live WebSocket connection is registered in `presence:{uid}` as
 * `{connId -> nodeId}`, and each backend node subscribes to its own
 * `node:{nodeId}` Redis pub/sub channel so Phase 1 cross-node routing can publish to
 * the exact node holding a connection. The `nodeId` must therefore be **stable for
 * the lifetime of the process** and **distinct per running backend instance**.
 *
 * Resolution order:
 *   1. The explicit `NODE_ID` environment variable when set (operators pin a stable
 *      id per replica, e.g. in the orchestrator's deployment spec).
 *   2. Otherwise `"{hostname}:{pid}"`, which is unique enough to disambiguate
 *      co-located processes and survives for the life of the process.
 */

import { hostname } from 'node:os';

/** Environment variable an operator can set to pin a stable node id per replica. */
const NODE_ID_ENV_VAR = 'NODE_ID';

/**
 * Resolves the stable identifier for this backend node.
 *
 * @param env  - the environment to read `NODE_ID` from (defaults to `process.env`).
 * @param host - the host name to fall back to (defaults to the OS host name).
 * @param pid  - the process id to fall back to (defaults to this process's pid).
 * @returns the explicit `NODE_ID` when set and non-blank, otherwise `"{host}:{pid}"`.
 */
export function resolveNodeId(
  env: NodeJS.ProcessEnv = process.env,
  host: string = hostname(),
  pid: number = process.pid,
): string {
  const explicit = env[NODE_ID_ENV_VAR];
  if (typeof explicit === 'string' && explicit.trim().length > 0) {
    return explicit.trim();
  }
  return `${host}:${pid}`;
}

/** Builds the per-node pub/sub channel name `node:{nodeId}` (design §12.3). */
export function nodeChannel(nodeId: string): string {
  return `node:${nodeId}`;
}
