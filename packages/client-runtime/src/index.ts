export { RemoteClient } from "./client.ts";
export type { Message, SessionMeta, ApprovalDecision } from "@plume/core/client-types";
export { normalizeConnection, pairingCode, parsePairingCode } from "./connection.ts";
export { relayRoom, relaySocketUrl } from "./relay.ts";
export type { Bootstrap, ClientState, Connection, PromptImage, SessionSnapshot, RemoteEvent } from "./types.ts";
