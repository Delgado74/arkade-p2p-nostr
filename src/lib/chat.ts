import type { DirectMessage } from "./dm";
import type { TradeDm } from "./trade";
import {
  pickDisputeTakeTaker,
  type DisputeAnnounce,
  type DisputeResolution,
  type DisputeStatus,
  type DisputeTake,
} from "./protocol";
import { summarize } from "./summary";

/** One rendered line of a chat room (a DM or a synthesized system notice). */
export interface ChatMessage {
  id: string;
  ts: number;
  outgoing: boolean;
  sender: string;
  text: string;
  /** Centered notice (dispute opened/taken/resolved) instead of a bubble. */
  system?: boolean;
}

/** A 1:1 conversation, keyed by order + peer (or a bare peer for free DMs). */
export interface Conversation {
  key: string;
  orderId: string;
  /** Counterparty x-only hex pubkey. */
  peer: string;
  messages: ChatMessage[];
  unread: number;
  /** True when every message is dispute-scope (those live under Disputas). */
  disputeOnly: boolean;
}

/** A dispute room: its public lifecycle plus every DM of that order. */
export interface DisputeRoom {
  orderId: string;
  status: DisputeStatus;
  open: boolean;
  initiator: string;
  reason?: string;
  /** Winning solver of the optimistic take race, when one exists. */
  winner?: string;
  messages: ChatMessage[];
  unread: number;
}

/** `conversationKey -> last read timestamp` (unix seconds). */
export type ReadMarks = Record<string, number>;

const READ_PREFIX = "arkade-p2p-nostr:read";

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function readKey(pubkey: string): string {
  return `${READ_PREFIX}:${pubkey}`;
}

/** Last-read timestamps of an identity (empty when none are stored). */
export function loadReadMarks(pubkey: string): ReadMarks {
  if (!pubkey) return {};
  try {
    const raw = storage()?.getItem(readKey(pubkey));
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    const marks: ReadMarks = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "number") marks[key] = value;
    }
    return marks;
  } catch {
    return {};
  }
}

/** Persist every read mark of an identity in one write. */
export function saveReadMarks(pubkey: string, marks: ReadMarks): void {
  if (!pubkey) return;
  try {
    storage()?.setItem(readKey(pubkey), JSON.stringify(marks));
  } catch {
    // Storage unavailable: unread badges stay session-only.
  }
}

/** The counterparty of a DM: the other `p` tag on our own copies. */
export function peerOf(dm: DirectMessage, myPubKey: string): string {
  if (!dm.outgoing) return dm.sender;
  const other = dm.recipients.find((p) => p.toLowerCase() !== myPubKey.toLowerCase());
  return other ?? dm.sender;
}

/**
 * Message types whose rooms belong to the Disputas segment.
 *
 * `ark_address` is deliberately excluded: parties advertise their payout
 * addresses when the escrow is agreed, long before any dispute exists, so it
 * must not spawn a dispute room (nor mark the conversation as dispute-only).
 */
const DISPUTE_TYPES = new Set(["dispute", "dispute_taken", "arbiter_decision"]);

function toChatMessage({ dm, msg }: TradeDm): ChatMessage {
  return {
    id: dm.id,
    ts: dm.createdAt,
    outgoing: dm.outgoing,
    sender: dm.sender,
    text: msg ? summarize(msg) : dm.content,
  };
}

function unreadCount(messages: ChatMessage[], lastRead: number | undefined): number {
  const mark = lastRead ?? 0;
  return messages.filter((m) => !m.outgoing && !m.system && m.ts > mark).length;
}

function byTs(a: ChatMessage, b: ChatMessage): number {
  return a.ts - b.ts;
}

/**
 * Group the DM feed into conversations: one per (order, peer) pair, plus bare
 * peer rooms for DMs that carry no trade message.
 */
export function buildConversations(
  feed: TradeDm[],
  myPubKey: string,
  marks: ReadMarks,
): Conversation[] {
  const rooms = new Map<string, { orderId: string; peer: string; entries: TradeDm[] }>();
  for (const entry of feed) {
    const { dm, msg } = entry;
    const peer = peerOf(dm, myPubKey);
    const orderId = msg?.orderId ?? "";
    const key = orderId ? `order:${orderId}:${peer}` : `dm:${peer}`;
    const room = rooms.get(key) ?? { orderId, peer, entries: [] };
    room.entries.push(entry);
    rooms.set(key, room);
  }

  const conversations: Conversation[] = [];
  for (const [key, room] of rooms) {
    const messages = room.entries
      .map(toChatMessage)
      .sort(byTs);
    const disputeOnly = room.entries.every(
      (e) => e.msg !== null && DISPUTE_TYPES.has(e.msg.type),
    );
    conversations.push({
      key,
      orderId: room.orderId,
      peer: room.peer,
      messages,
      unread: unreadCount(messages, marks[key]),
      disputeOnly,
    });
  }
  return conversations.sort((a, b) => {
    const at = a.messages[a.messages.length - 1]?.ts ?? 0;
    const bt = b.messages[b.messages.length - 1]?.ts ?? 0;
    return bt - at;
  });
}

/**
 * A dispute is relevant when it is ours: we opened it, we exchanged DMs for
 * that order, or we took/resolved it as a solver.
 */
function isRelevantDispute(
  orderId: string,
  initiator: string,
  feed: TradeDm[],
  takes: DisputeTake[],
  resolutions: DisputeResolution[],
  myPubKey: string,
): boolean {
  const me = myPubKey.toLowerCase();
  if (initiator.toLowerCase() === me) return true;
  if (feed.some((e) => e.msg?.orderId === orderId)) return true;
  if (takes.some((t) => t.orderId === orderId && t.solverPubKey.toLowerCase() === me)) {
    return true;
  }
  return resolutions.some((r) => r.orderId === orderId && r.solverPubKey.toLowerCase() === me);
}

function systemLine(text: string, ts: number, id: string): ChatMessage {
  return { id, ts, outgoing: false, sender: "", text, system: true };
}

function short(key: string): string {
  return key ? `${key.slice(0, 12)}…` : "—";
}

/** Build every dispute room the local identity can see, newest activity first. */
export function buildDisputeRooms(
  feed: TradeDm[],
  announces: DisputeAnnounce[],
  takes: DisputeTake[],
  resolutions: DisputeResolution[],
  myPubKey: string,
  marks: ReadMarks,
): DisputeRoom[] {
  const announceByOrder = new Map<string, DisputeAnnounce>();
  for (const a of announces) {
    const prev = announceByOrder.get(a.orderId);
    if (!prev || a.createdAt > prev.createdAt) announceByOrder.set(a.orderId, a);
  }

  const orderIds = new Set<string>(announceByOrder.keys());
  for (const e of feed) {
    if (e.msg && DISPUTE_TYPES.has(e.msg.type)) orderIds.add(e.msg.orderId);
  }
  for (const t of takes) orderIds.add(t.orderId);
  for (const r of resolutions) orderIds.add(r.orderId);

  const rooms: DisputeRoom[] = [];
  for (const orderId of orderIds) {
    const announce = announceByOrder.get(orderId);
    const takesForOrder = takes.filter((t) => t.orderId === orderId);
    const winner = pickDisputeTakeTaker(takesForOrder);
    const resolution =
      [...resolutions.filter((r) => r.orderId === orderId)].sort(
        (a, b) => b.createdAt - a.createdAt,
      )[0] ?? null;
    const initiator = announce?.initiator ?? "";

    if (
      announce &&
      !isRelevantDispute(orderId, initiator, feed, takes, resolutions, myPubKey)
    ) {
      continue;
    }

    const messages: ChatMessage[] = [];
    if (announce) {
      const byMe = announce.initiator.toLowerCase() === myPubKey.toLowerCase();
      messages.push(
        systemLine(
          `Disputa abierta${byMe ? " por ti" : ` por ${short(announce.initiator)}`}${
            announce.reason ? `: ${announce.reason}` : ""
          }`,
          announce.createdAt,
          `system:announce:${announce.event.id}`,
        ),
      );
    }
    if (winner) {
      const mine = winner.solverPubKey.toLowerCase() === myPubKey.toLowerCase();
      messages.push(
        systemLine(
          `Tomada por el solver ${mine ? "(tú)" : short(winner.solverPubKey)}`,
          winner.createdAt,
          `system:take:${winner.event.id}`,
        ),
      );
    }
    if (resolution) {
      const label =
        resolution.status === "settled"
          ? "pagada al comprador"
          : resolution.status === "refunded"
            ? "reembolsada al vendedor"
            : resolution.status;
      messages.push(
        systemLine(
          `Disputa resuelta: ${label}${resolution.arkTxid ? ` (${short(resolution.arkTxid)})` : ""}`,
          resolution.createdAt,
          `system:resolution:${resolution.event.id}`,
        ),
      );
    }
    for (const entry of feed) {
      if (entry.msg?.orderId === orderId) messages.push(toChatMessage(entry));
    }
    messages.sort(byTs);

    const key = `dispute:${orderId}`;
    const status: DisputeStatus =
      resolution?.status ?? (winner ? "in-progress" : (announce?.status ?? "initiated"));
    rooms.push({
      orderId,
      status,
      open: resolution === null,
      initiator,
      reason: announce?.reason,
      winner: winner?.solverPubKey,
      messages,
      unread: unreadCount(messages, marks[key]),
    });
  }

  return rooms.sort((a, b) => {
    const at = a.messages[a.messages.length - 1]?.ts ?? 0;
    const bt = b.messages[b.messages.length - 1]?.ts ?? 0;
    return bt - at;
  });
}

/** `14:32` today, `ayer`, then a short date. */
export function timeLabel(ts: number): string {
  const at = new Date(ts * 1000);
  const now = new Date();
  if (at.toDateString() === now.toDateString()) {
    return at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (at.toDateString() === yesterday.toDateString()) return "ayer";
  return at.toLocaleDateString([], { day: "numeric", month: "short" });
}

/** Last message of a room, prefixed with `Tú:` for our own lines. */
export function previewOf(messages: ChatMessage[]): { text: string; own: boolean } | null {
  const last = messages[messages.length - 1];
  if (!last) return null;
  return { text: last.system ? last.text : `${last.outgoing ? "Tú: " : ""}${last.text}`, own: last.outgoing };
}
