/**
 * WS hub public surface — the only import site other modules should need.
 */
export { initWsHub } from './hub.js';
export {
  CLOSE_BAD_FRAME,
  CLOSE_KICKED,
  CLOSE_ROOM_CLOSED,
  CLOSE_SUPERSEDED,
  HEARTBEAT_STALE_MS,
} from './types.js';
export type { PushFrame, WsHub, WsHubDeps, WsViewer } from './types.js';
