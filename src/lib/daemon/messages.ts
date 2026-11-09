import type { DirectMessage } from "../dm";
import { daemonClient } from "./client";

/**
 * A decrypted DM as persisted by the daemon.
 *
 * The daemon owns the relay subscription, so it stores every readable NIP-17
 * rumor. The browser only keeps a live in-memory feed; on reload it rebuilds
 * history from here instead of depending on the relays' retention window.
 */
export interface StoredDmMessage {
  id: string;
  orderId?: string;
  type: string;
  peer?: string;
  outgoing: boolean;
  createdAt: number;
  receivedAt: number;
  payloadJson?: string;
}

interface RumorPayload {
  sender: string;
  recipients: string[];
  content: string;
  createdAt: number;
}

/** RPC surface needed to read persisted messages (injectable for tests). */
export interface MessagesRpc {
  call<T = any>(method: string, params?: any): Promise<T>;
}

function parsePayload(payloadJson: string | undefined): RumorPayload | null {
  if (!payloadJson) return null;
  try {
    const parsed: unknown = JSON.parse(payloadJson);
    if (typeof parsed !== "object" || parsed === null) return null;
    const value = parsed as Record<string, unknown>;
    if (typeof value.sender !== "string" || typeof value.content !== "string") return null;
    if (typeof value.createdAt !== "number") return null;
    if (!Array.isArray(value.recipients)) return null;
    const recipients = value.recipients.filter(
      (recipient): recipient is string => typeof recipient === "string",
    );
    if (recipients.length !== value.recipients.length) return null;
    return {
      sender: value.sender,
      recipients,
      content: value.content,
      createdAt: value.createdAt,
    };
  } catch {
    return null;
  }
}

/**
 * Rebuild {@link DirectMessage}s from daemon rows.
 *
 * Only rows the daemon classified as DMs (`type === "dm"`) carry the decrypted
 * rumor; malformed payloads are dropped rather than exposed to the UI.
 */
export function storedMessagesToDms(messages: StoredDmMessage[]): DirectMessage[] {
  const dms: DirectMessage[] = [];
  for (const message of messages) {
    if (message.type !== "dm") continue;
    const payload = parsePayload(message.payloadJson);
    if (!payload) continue;
    dms.push({
      id: message.id,
      sender: payload.sender,
      recipients: payload.recipients,
      content: payload.content,
      createdAt: payload.createdAt,
      outgoing: message.outgoing,
    });
  }
  return dms.sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * Load persisted DMs for the local identity.
 *
 * The daemon belongs to one identity, so no author filter is needed. A failure
 * (daemon down) returns an empty list: the live relay subscription still feeds
 * the UI.
 */
export async function loadStoredDms(
  rpc: MessagesRpc = daemonClient,
  limit = 2000,
): Promise<DirectMessage[]> {
  try {
    const messages = await rpc.call<StoredDmMessage[]>("messages.list", { limit });
    return storedMessagesToDms(messages);
  } catch {
    return [];
  }
}
