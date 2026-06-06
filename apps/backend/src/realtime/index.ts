/**
 * Public surface of the backend RealtimeModule.
 */

export { RealtimeModule } from './realtime.module';
export { RealtimeGateway, type AuthenticatedSocket } from './realtime.gateway';
export {
  WS_CLOSE_UNAUTHORIZED,
  WS_CLOSE_VERIFICATION_UNAVAILABLE,
  WS_CLOSE_RATE_LIMITED,
  WS_HANDSHAKE_RATE_LIMIT,
  WS_HANDSHAKE_RATE_WINDOW_SECONDS,
  WS_HANDSHAKE_RATE_LIMIT_SCOPE,
  WS_HEARTBEAT_INTERVAL_MS,
  WS_PORT,
} from './realtime.constants';
export { extractHandshakeToken } from './handshake-token.util';
export { resolveNodeId, nodeChannel } from './node-identity.util';
