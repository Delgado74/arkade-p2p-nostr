import type { DirectMessage } from "./dm";
import type { TradeDm } from "./trade";
import type { OperationRecord } from "./operations";
import {
  pickDisputeTakeTaker,
  validDisputeResolutions,
  validDisputeTakes,
  type DisputeAnnounce,
  type DisputeResolution,
  type DisputeStatus,
  type DisputeTake,
} from "./protocol";
import { summarize } from "./summary";
import { daemonClient } from "./daemon/client";

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

/** RPC surface needed to persist read marks (injectable for tests). */
export interface ReadMarksRpc {
  call<T = any>(method: string, params?: any): Promise<T>;
}

function readMarksSettingKey(pubkey: string): string {
  return `readMarks:${pubkey}`;
}

/** Parse the JSON stored in the daemon; ignore malformed or foreign values. */
function parseReadMarks(raw: string | null): ReadMarks {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    const marks: ReadMarks = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "number" && Number.isFinite(value)) marks[key] = value;
    }
    return marks;
  } catch {
    return {};
  }
}

/** Per-conversation max, so merging never moves a read mark backwards. */
export function mergeReadMarks(a: ReadMarks, b: ReadMarks): ReadMarks {
  const merged: ReadMarks = { ...a };
  for (const [key, value] of Object.entries(b)) {
    merged[key] = Math.max(merged[key] ?? 0, value);
  }
  return merged;
}

/**
 * Load read marks from the daemon, importing the local cache first so nothing
 * marked before this migration is lost.
 *
 * The daemon copy wins on a tie (it is shared across devices); the local copy
 * only advances a mark. A daemon failure returns the local cache unchanged.
 */
export async function loadReadMarksFromDaemon(
  pubkey: string,
  rpc: ReadMarksRpc = daemonClient,
): Promise<ReadMarks> {
  const local = loadReadMarks(pubkey);
  if (!pubkey) return local;
  try {
    const key = readMarksSettingKey(pubkey);
    const raw = await rpc.call<string | null>("settings.get", { key });
    const remote = parseReadMarks(raw);
    const merged = mergeReadMarks(remote, local);
    saveReadMarks(pubkey, merged);
    if (raw === null || JSON.stringify(remote) !== JSON.stringify(merged)) {
      await rpc.call("settings.set", { key, value: JSON.stringify(merged) });
    }
    return merged;
  } catch {
    return local;
  }
}

/**
 * Persist read marks to the local cache synchronously and mirror them to the
 * daemon. A daemon failure is swallowed: the local cache still drives the UI
 * and the next load retries the migration.
 */
export function saveReadMarksToDaemon(
  pubkey: string,
  marks: ReadMarks,
  rpc: ReadMarksRpc = daemonClient,
): Promise<void> {
  saveReadMarks(pubkey, marks);
  if (!pubkey) return Promise.resolve();
  return rpc
    .call("settings.set", {
      key: readMarksSettingKey(pubkey),
      value: JSON.stringify(marks),
    })
    .then(() => undefined)
    .catch(() => undefined);
}

/** The counterparty of a DM: the other `p` tag on our own copies. */
export function peerOf(dm: DirectMessage, myPubKey: string): string {
  if (!dm.outgoing) return dm.sender;
  const other = dm.recipients.find((p) => p.toLowerCase() !== myPubKey.toLowerCase());
  return other ?? dm.sender;
}

/**
 * Message types that represent actual peer-to-peer chat between humans.
 * Everything else is a protocol/state message handled by the trade flow and
 * must not pollute the "Mensajes" peer conversation list.
 */
const PEER_CHAT_TYPES = new Set(["chat"]);

function toChatMessage({ dm, msg }: TradeDm): ChatMessage {
  // Only real human chat appears as a peer message. Protocol messages (take,
  // taker_address, escrow, funded, release_*, cancel_*, dispute_*, arbiter_decision,
  // ark_address_request, etc.) are handled by the trade UI and must not be
  // rendered as conversation bubbles between peers.
  if (msg && !PEER_CHAT_TYPES.has(msg.type)) {
    return {
      id: dm.id,
      ts: dm.createdAt,
      outgoing: dm.outgoing,
      sender: dm.sender,
      text: summarize(msg),
      system: true,
    };
  }
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

/** Message types whose rooms belong to the Disputas segment. */
const DISPUTE_TYPES = new Set(["dispute", "dispute_taken", "arbiter_decision"]);
export function buildConversations(
  feed: TradeDm[],
  myPubKey: string,
  marks: ReadMarks,
): Conversation[] {
  const rooms = new Map<string, { orderId: string; peer: string; entries: TradeDm[] }>();
  for (const entry of feed) {
    const { dm, msg } = entry;
    // Only human chat DMs between peers belong to the "Mensajes" list.
    // Protocol messages are handled inside the trade/dispute UI and must not
    // create peer-to-peer conversation rows.
    if (msg && !PEER_CHAT_TYPES.has(msg.type)) continue;
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
    // After filtering to only human chat, nothing can be dispute-only.
    const disputeOnly = false;
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
 * The latest escrow/dispute agreement seen for an order in the feed.
 *
 * Carries the buyer/seller/arbiter keys, which tell parties apart from solvers
 * who merely received a copy of the agreement.
 */
export function agreementFor(orderId: string, feed: TradeDm[]) {
  for (let i = feed.length - 1; i >= 0; i--) {
    const msg = feed[i].msg;
    if (!msg || msg.orderId !== orderId) continue;
    if (msg.type === "escrow" || msg.type === "dispute") return msg.payload.agreement;
  }
  return null;
}

/**
 * True when a conversation is one of OUR OWN trades: either we hold an
 * operation record for its order, or the latest agreement for that order lists
 * us as the buyer or seller. A solver who merely received a broadcast
 * (`ark_address`/`escrow`) is not in the agreement's party keys, so those rooms
 * are excluded. Free DMs (no order) are always ours.
 */
export function isOurTradeConversation(
  conv: Conversation,
  feed: TradeDm[],
  operations: OperationRecord[],
  myPubKey: string,
): boolean {
  if (!conv.orderId) return true;
  if (operations.some((o) => o.orderId === conv.orderId)) return true;
  const me = myPubKey.toLowerCase();
  const agreement = agreementFor(conv.orderId, feed);
  if (agreement) {
    return (
      agreement.buyerPubKey.toLowerCase() === me || agreement.sellerPubKey.toLowerCase() === me
    );
  }
  // No agreement seen yet (e.g. just after a `take`): treat it as ours if we
  // have spoken on that order, or we received a `take`/`escrow` addressed to us.
  for (let i = feed.length - 1; i >= 0; i--) {
    const entry = feed[i];
    if (entry.msg?.orderId !== conv.orderId) continue;
    if (entry.dm.outgoing) return true;
    if (entry.msg.type === "take" || entry.msg.type === "escrow") return true;
  }
  return false;
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
  registrySolvers?: readonly string[] | null,
): DisputeRoom[] {
  const announcesForOrder = (orderId: string): DisputeAnnounce[] => {
    const agreement = agreementFor(orderId, feed);
    return announces.filter((announce) => {
      if (announce.orderId !== orderId) return false;
      if (!agreement) return true;
      const initiator = announce.initiator.toLowerCase();
      return (
        initiator === agreement.buyerPubKey.toLowerCase() ||
        initiator === agreement.sellerPubKey.toLowerCase()
      );
    });
  };

  const announceByOrder = new Map<string, DisputeAnnounce>();
  for (const orderId of new Set(announces.map((announce) => announce.orderId))) {
    for (const announce of announcesForOrder(orderId)) {
      const prev = announceByOrder.get(orderId);
      if (!prev || announce.createdAt > prev.createdAt) {
        announceByOrder.set(orderId, announce);
      }
    }
  }

  const trustedTakes = (orderId: string): DisputeTake[] => {
    const agreement = agreementFor(orderId, feed);
    const allowed = agreement?.arbiterPubKeys ?? registrySolvers;
    return validDisputeTakes(takes, announcesForOrder(orderId), allowed).filter(
      (t) => t.orderId === orderId,
    );
  };
  const trustedResolutions = (orderId: string): DisputeResolution[] => {
    const agreement = agreementFor(orderId, feed);
    const allowed = agreement?.arbiterPubKeys ?? registrySolvers;
    const orderAnnounces = announcesForOrder(orderId);
    return validDisputeResolutions(
      resolutions,
      orderAnnounces,
      validDisputeTakes(takes, orderAnnounces, allowed),
      allowed,
    ).filter((r) => r.orderId === orderId);
  };

  const orderIds = new Set<string>(announceByOrder.keys());
  for (const e of feed) {
    if (e.msg && DISPUTE_TYPES.has(e.msg.type)) orderIds.add(e.msg.orderId);
  }
  for (const orderId of announceByOrder.keys()) {
    for (const take of trustedTakes(orderId)) orderIds.add(take.orderId);
    for (const resolution of trustedResolutions(orderId)) orderIds.add(resolution.orderId);
  }

  const rooms: DisputeRoom[] = [];
  for (const orderId of orderIds) {
    const announce = announceByOrder.get(orderId);
    const takesForOrder = trustedTakes(orderId);
    const validResolutions = trustedResolutions(orderId);
    const winner = pickDisputeTakeTaker(takesForOrder);
    const resolution =
      [...validResolutions].sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
    const initiator = announce?.initiator ?? "";

    if (
      announce &&
      !isRelevantDispute(
        orderId,
        initiator,
        feed,
        takesForOrder,
        validResolutions,
        myPubKey,
      )
    ) {
      continue;
    }

    // A resolved dispute leaves no room behind: like a finished operation, its
    // private thread is wiped once the outcome is published.
    if (resolution) continue;

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
    for (const entry of feed) {
      if (entry.msg?.orderId === orderId) messages.push(toChatMessage(entry));
    }
    messages.sort(byTs);

    const key = `dispute:${orderId}`;
    // A room only exists while the dispute is open: resolved ones are dropped
    // above, so the status is always one of the live ones.
    const status: DisputeStatus = winner ? "in-progress" : (announce?.status ?? "initiated");
    rooms.push({
      orderId,
      status,
      open: true,
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
