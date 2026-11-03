// What `isows` resolves to in the bundle (tsup.config.ts): on Node 22+ isows
// returns this global, so its `ws` fallback is dead weight here.
export const WebSocket = globalThis.WebSocket;
