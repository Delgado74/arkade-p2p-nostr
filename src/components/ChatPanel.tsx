import { useMemo, useState } from "react";
import "./ChatPanel.css";
import type { Identity } from "../lib/identity";
import type { NostrClient } from "../lib/nostr";
import { sendDm } from "../lib/dm";
import {
  encodeTradeMessage,
  TRADE_APP,
  TRADE_VERSION,
  type TradeDm,
  type TradeMessageOf,
  type TradeRole,
} from "../lib/trade";
import {
  pickDisputeTakeTaker,
  type DisputeAnnounce,
  type DisputeResolution,
  type DisputeTake,
} from "../lib/protocol";
import { isFinished, statusLabel, type OperationRecord } from "../lib/operations";
import {
  buildConversations,
  buildDisputeRooms,
  loadReadMarks,
  peerOf,
  previewOf,
  saveReadMarks,
  timeLabel,
  type ChatMessage,
  type Conversation,
  type DisputeRoom,
} from "../lib/chat";

interface Props {
  identity: Identity;
  client: NostrClient;
  feed: TradeDm[];
  disputeAnnounces: DisputeAnnounce[];
  disputeTakes: DisputeTake[];
  disputeResolutions: DisputeResolution[];
  operations: OperationRecord[];
}

type Segment = "mensajes" | "disputas";
type OpenRoom = { segment: Segment; key: string } | null;

function shortKey(key: string): string {
  return key ? `${key.slice(0, 12)}…` : "—";
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** Our role on an order, from the local operation or our own outbound DMs. */
function roleForOrder(
  orderId: string,
  feed: TradeDm[],
  operations: OperationRecord[],
): TradeRole {
  const op = operations.find((o) => o.orderId === orderId);
  if (op) return op.role;
  for (let i = feed.length - 1; i >= 0; i--) {
    const entry = feed[i];
    if (entry.dm.outgoing && entry.msg?.orderId === orderId) return entry.msg.role;
  }
  return "seller";
}

/** Context line of a conversation row: what trade it is and where it stands. */
function conversationContext(conv: Conversation, operations: OperationRecord[]): string {
  const op = conv.orderId ? operations.find((o) => o.orderId === conv.orderId) : undefined;
  if (op) {
    const amount =
      op.fiatAmount !== undefined && op.fiat ? `${op.fiatAmount} ${op.fiat}` : null;
    const sats = op.tradeSats !== undefined ? `${op.tradeSats.toLocaleString()} sats` : null;
    return [sats, amount, statusLabel(op.status)].filter(Boolean).join(" · ");
  }
  if (conv.orderId) return `orden ${conv.orderId.slice(0, 10)}…`;
  return "mensaje directo";
}

function disputeStatusLine(room: DisputeRoom): string {
  if (room.status === "settled") return "resuelta · pagada al comprador";
  if (room.status === "refunded") return "resuelta · reembolsada al vendedor";
  if (room.status === "canceled") return "cancelada";
  if (room.status === "in-progress") {
    return room.winner ? `en curso · solver ${shortKey(room.winner)}` : "en curso";
  }
  return room.reason ? `abierta · ${room.reason}` : "abierta";
}

/** Every peer we have exchanged order DMs with, minus ourselves. */
function orderPeers(orderId: string, feed: TradeDm[], myPubKey: string): string[] {
  const peers = new Set<string>();
  for (const entry of feed) {
    if (entry.msg?.orderId !== orderId) continue;
    const peer = peerOf(entry.dm, myPubKey);
    if (peer.toLowerCase() !== myPubKey.toLowerCase()) peers.add(peer);
  }
  return [...peers];
}

/** Last escrow/dispute agreement seen for an order (carries the solver set). */
function agreementFor(orderId: string, feed: TradeDm[]) {
  for (let i = feed.length - 1; i >= 0; i--) {
    const msg = feed[i].msg;
    if (!msg || msg.orderId !== orderId) continue;
    if (msg.type === "escrow" || msg.type === "dispute") return msg.payload.agreement;
  }
  return null;
}

/**
 * Who hears our chat in a dispute: a solver writes to both parties, a party
 * writes to the solver that took the race (or to the other party meanwhile).
 */
function disputeRecipients(
  orderId: string,
  feed: TradeDm[],
  takes: DisputeTake[],
  myPubKey: string,
): string[] {
  const me = myPubKey.toLowerCase();
  const agreement = agreementFor(orderId, feed);
  if (agreement) {
    const parties = [agreement.buyerPubKey, agreement.sellerPubKey].filter(
      (p) => p.toLowerCase() !== me,
    );
    const isSolver = agreement.arbiterPubKeys.some((p) => p.toLowerCase() === me);
    if (isSolver) return parties;
    const winner = pickDisputeTakeTaker(takes.filter((t) => t.orderId === orderId));
    if (winner && winner.solverPubKey.toLowerCase() !== me) return [winner.solverPubKey];
    return parties;
  }
  return orderPeers(orderId, feed, myPubKey);
}

export function ChatPanel({
  identity,
  client,
  feed,
  disputeAnnounces,
  disputeTakes,
  disputeResolutions,
  operations,
}: Props) {
  const [segment, setSegment] = useState<Segment>("mensajes");
  const [openRoom, setOpenRoom] = useState<OpenRoom>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [readMarks, setReadMarks] = useState(() => loadReadMarks(identity.pubkeyHex));

  const conversations = useMemo(
    () => buildConversations(feed, identity.pubkeyHex, readMarks),
    [feed, identity.pubkeyHex, readMarks],
  );
  const disputes = useMemo(
    () =>
      buildDisputeRooms(
        feed,
        disputeAnnounces,
        disputeTakes,
        disputeResolutions,
        identity.pubkeyHex,
        readMarks,
      ),
    [feed, disputeAnnounces, disputeTakes, disputeResolutions, identity.pubkeyHex, readMarks],
  );

  const messageConvs = conversations.filter((c) => !c.disputeOnly);

  // While a room is open its own badge stays at zero without touching storage.
  const unreadOf = (key: string, unread: number) =>
    openRoom?.key === key ? 0 : unread;
  const mensajesUnread = messageConvs.reduce(
    (sum, c) => sum + unreadOf(c.key, c.unread),
    0,
  );
  const disputasUnread = disputes.reduce((sum, d) => sum + unreadOf(`dispute:${d.orderId}`, d.unread), 0);

  const openConv = openRoom?.segment === "mensajes"
    ? conversations.find((c) => c.key === openRoom.key) ?? null
    : null;
  const openDispute = openRoom?.segment === "disputas"
    ? disputes.find((d) => `dispute:${d.orderId}` === openRoom.key) ?? null
    : null;

  function markRead(key: string, messages: ChatMessage[]) {
    const last = messages[messages.length - 1];
    if (!last) return;
    const current = readMarks[key] ?? 0;
    if (last.ts <= current) return;
    const next = { ...readMarks, [key]: last.ts };
    setReadMarks(next);
    saveReadMarks(identity.pubkeyHex, next);
  }

  function openChat(conv: Conversation) {
    markRead(conv.key, conv.messages);
    setOpenRoom({ segment: "mensajes", key: conv.key });
    setError("");
  }

  function openDisputeRoom(room: DisputeRoom) {
    const key = `dispute:${room.orderId}`;
    markRead(key, room.messages);
    setOpenRoom({ segment: "disputas", key });
    setError("");
  }

  function goBack() {
    setOpenRoom(null);
    setDraft("");
    setError("");
  }

  async function handleSend() {
    const text = draft.trim();
    if (!text || busy) return;
    let orderId = "";
    let recipients: string[] = [];
    if (openConv) {
      orderId = openConv.orderId;
      recipients = [openConv.peer];
    } else if (openDispute) {
      orderId = openDispute.orderId;
      recipients = disputeRecipients(orderId, feed, disputeTakes, identity.pubkeyHex);
    }
    if (recipients.length === 0) {
      setError("no hay destinatarios conocidos para esta conversación");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const msg: TradeMessageOf<"chat"> = {
        app: TRADE_APP,
        v: TRADE_VERSION,
        type: "chat",
        orderId,
        role: roleForOrder(orderId, feed, operations),
        from: identity.pubkeyHex,
        ts: nowSeconds(),
        payload: { text },
      };
      const encoded = encodeTradeMessage(msg);
      await Promise.all(
        recipients.map((r) => sendDm(client.pool, client.relays, identity, r, encoded)),
      );
      setDraft("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function renderList(rows: { key: string; node: React.ReactNode }[], empty: string) {
    if (rows.length === 0) return <p className="chat-empty">{empty}</p>;
    return (
      <div className="chat-card">
        {rows.map((row, i) => (
          <div key={row.key} data-last={i === rows.length - 1}>
            {row.node}
          </div>
        ))}
      </div>
    );
  }

  function conversationRow(conv: Conversation) {
    const op = conv.orderId ? operations.find((o) => o.orderId === conv.orderId) : undefined;
    const closed = op ? isFinished(op.status) : false;
    const unread = unreadOf(conv.key, conv.unread);
    const preview = previewOf(conv.messages);
    return (
      <button
        type="button"
        className="chat-row"
        data-unread={unread > 0}
        data-closed={closed}
        onClick={() => openChat(conv)}
      >
        <span className="chat-avatar">{conv.peer.slice(0, 2).toUpperCase()}</span>
        <span className="chat-row-main">
          <span className="chat-row-top">
            <span className="chat-row-title">{shortKey(conv.peer)}</span>
            <span className="chat-row-time">
              {preview ? timeLabel(conv.messages[conv.messages.length - 1].ts) : ""}
            </span>
          </span>
          <span className="chat-row-context">{conversationContext(conv, operations)}</span>
          <span className="chat-row-preview">
            <span>{preview?.text ?? ""}</span>
            {unread > 0 && <span className="chat-badge">{unread}</span>}
          </span>
        </span>
      </button>
    );
  }

  function disputeRow(room: DisputeRoom) {
    const key = `dispute:${room.orderId}`;
    const unread = unreadOf(key, room.unread);
    const preview = previewOf(room.messages);
    const byMe = room.initiator.toLowerCase() === identity.pubkeyHex.toLowerCase();
    return (
      <button
        type="button"
        className="chat-row"
        data-unread={unread > 0}
        data-closed={!room.open}
        onClick={() => openDisputeRoom(room)}
      >
        <span className="chat-avatar" data-dispute>
          {room.orderId.slice(0, 2).toUpperCase()}
        </span>
        <span className="chat-row-main">
          <span className="chat-row-top">
            <span className="chat-row-title">Orden {room.orderId.slice(0, 10)}…</span>
            <span className="chat-row-time">
              {preview ? timeLabel(room.messages[room.messages.length - 1].ts) : ""}
            </span>
          </span>
          <span className="chat-row-context">
            {disputeStatusLine(room)}
            {room.initiator ? ` · ${byMe ? "abierta por ti" : `por ${shortKey(room.initiator)}`}` : ""}
          </span>
          <span className="chat-row-preview">
            <span>{preview?.text ?? ""}</span>
            {unread > 0 && <span className="chat-badge">{unread}</span>}
          </span>
          {room.open && <span className="chat-chip">En disputa</span>}
        </span>
      </button>
    );
  }

  function roomMessages(): ChatMessage[] {
    if (openConv) return openConv.messages;
    if (openDispute) return openDispute.messages;
    return [];
  }

  function roomTitle(): { title: string; sub: string; chip: boolean } {
    if (openConv) {
      return {
        title: shortKey(openConv.peer),
        sub: conversationContext(openConv, operations),
        chip: false,
      };
    }
    if (openDispute) {
      return {
        title: `Orden ${openDispute.orderId.slice(0, 10)}…`,
        sub: disputeStatusLine(openDispute),
        chip: openDispute.open,
      };
    }
    return { title: "", sub: "", chip: false };
  }

  const grouped = (() => {
    if (segment === "disputas") {
      const open = disputes.filter((d) => d.open);
      const closed = disputes.filter((d) => !d.open);
      const rows = (list: DisputeRoom[]) =>
        list.map((room) => ({ key: room.orderId, node: disputeRow(room) }));
      return [
        { title: "En disputa", rows: rows(open) },
        { title: "Resueltas", rows: rows(closed) },
      ].filter((g) => g.rows.length > 0);
    }
    const open = messageConvs.filter(
      (c) => !(c.orderId && operations.some((o) => o.orderId === c.orderId && isFinished(o.status))),
    );
    const closed = messageConvs.filter(
      (c) => c.orderId && operations.some((o) => o.orderId === c.orderId && isFinished(o.status)),
    );
    const rows = (list: Conversation[]) =>
      list.map((conv) => ({ key: conv.key, node: conversationRow(conv) }));
    return [
      { title: "En curso", rows: rows(open) },
      { title: "Cerradas", rows: rows(closed) },
    ].filter((g) => g.rows.length > 0);
  })();

  const title = roomTitle();
  const messages = roomMessages();

  return (
    <section className="chat">
      <h2>Chat</h2>

      <div className="chat-segments">
        <button
          type="button"
          className="chat-segment"
          data-active={segment === "mensajes" && openRoom === null}
          onClick={() => {
            setSegment("mensajes");
            goBack();
          }}
        >
          Mensajes
          {mensajesUnread > 0 && <span className="chat-badge">{mensajesUnread}</span>}
        </button>
        <button
          type="button"
          className="chat-segment"
          data-active={segment === "disputas" && openRoom === null}
          onClick={() => {
            setSegment("disputas");
            goBack();
          }}
        >
          Disputas
          {disputasUnread > 0 && <span className="chat-badge">{disputasUnread}</span>}
        </button>
      </div>

      {openRoom ? (
        <div className="chat-room">
          <div className="chat-room-header">
            <button type="button" className="chat-back" onClick={goBack} aria-label="Volver">
              ←
            </button>
            <div>
              <div className="chat-room-title">{title.title}</div>
              <div className="chat-room-sub">{title.sub}</div>
            </div>
            {title.chip && <span className="chat-chip">En disputa</span>}
          </div>

          <div className="chat-messages">
            {messages.length === 0 && <p className="chat-system">Sin mensajes todavía.</p>}
            {messages.map((m) =>
              m.system ? (
                <p key={m.id} className="chat-system">
                  {m.text}
                </p>
              ) : (
                <div key={m.id} className="chat-bubble" data-own={m.outgoing}>
                  {m.text}
                  <time>{timeLabel(m.ts)}</time>
                </div>
              ),
            )}
          </div>

          <div className="chat-input">
            <input
              placeholder="Escribe un mensaje…"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleSend();
              }}
            />
            <button type="button" disabled={busy || !draft.trim()} onClick={() => void handleSend()}>
              {busy ? "…" : "Enviar"}
            </button>
          </div>
          {error && <p className="chat-error">Error: {error}</p>}
        </div>
      ) : (
        <>
          {grouped.length === 0 && (
            <p className="chat-empty">
              {segment === "mensajes"
                ? "Sin conversaciones todavía."
                : "Sin disputas todavía."}
            </p>
          )}
          {grouped.map((group) => (
            <div key={group.title}>
              <div className="chat-group-header">
                <span>{group.title}</span>
                <span>{group.rows.length}</span>
              </div>
              {renderList(group.rows, "")}
            </div>
          ))}
        </>
      )}
    </section>
  );
}
