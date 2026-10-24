import { useEffect, useMemo, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { hex } from "@scure/base";
import type { VirtualCoin } from "@arkade-os/sdk";
import { chainTimeSeconds, type ArkContext } from "../lib/arkade";
import { pubkeyFromInput, type Identity } from "../lib/identity";
import { arbiterPubKey, coordinatorPubKey } from "../lib/config";
import type { NostrClient } from "../lib/nostr";
import type { OperationRecord } from "../lib/operations";
import type { PeerLabel } from "../lib/useNyms";
import {
  assertFunded,
  buildSpend,
  coSignSpend,
  EscrowPath,
  escrowFromAgreement,
  listEscrowVtxos,
  mergeSpends,
  outputToArkAddress,
  refundLocktimeFrom,
  signSpend,
  submitSpend,
  verifyArbiterSpend,
  verifyRefundSpend,
  verifyReleaseSpend,
  type Escrow,
  type EscrowVtxoState,
} from "../lib/escrow";
import { derivePersonalArkAddress } from "../lib/escrowWallet";
import { recoverEscrowVtxos } from "../lib/recovery";
import {
  encodeTradeMessage,
  TRADE_APP,
  TRADE_VERSION,
  type EscrowAgreement,
  type TradeDm,
  type TradeMessageOf,
  type TradeMessageType,
  type TradePayloads,
  type TradeRole,
} from "../lib/trade";
import { computeWindowState } from "../lib/windows";
import { sendDm } from "../lib/dm";
import { summarize } from "../lib/summary";
import {
  buildDisputeAnnounceTemplate,
  buildDisputeTakeTemplate,
  buildDisputeResolutionTemplate,
  buildOrderTemplate,
  pickDisputeTakeTaker,
  type DisputeAnnounce,
  type DisputeTake,
} from "../lib/protocol";

/** Prefill produced when a taker presses "Tomar" on an order. */
export interface TradeRequest {
  orderId: string;
  counterparty: string;
  role: TradeRole;
  fiat?: string;
  fiatAmount?: number;
  tradeSats?: number;
  paymentMethods?: string[];
  /**
   * Ark address published by the maker when it created the order: its payout
   * address when it is the buyer, its refund address when it is the seller.
   */
  arkAddress?: string;
  /** Ark address the taker stated when it took the order. */
  takerArkAddress?: string;
  /** Buyer's payout address, whoever stated it. */
  buyerArkAddress?: string;
  /** Seller's refund address, whoever stated it. */
  refundAddress?: string;
  /** True when the local identity published the order (maker), not took it. */
  maker?: boolean;
  /** The order's advertised side (`sell` offers BTC, `buy` wants BTC). */
  orderType?: "buy" | "sell";
  /** Opened from the solver inbox: no counterparty filter, resolution UI only. */
  solver?: boolean;
}

interface Props {
  identity: Identity | null;
  ctx: ArkContext | null;
  client: NostrClient;
  request?: TradeRequest | null;
  feed: TradeDm[];
  /** Public dispute announcements (kind 38390). */
  disputeAnnounces?: DisputeAnnounce[];
  /** Public dispute takes (kind 38387), including competing takes. */
  disputeTakes?: DisputeTake[];
  /** Local pseudonym reader for pubkeys shown in the panel. */
  label?: PeerLabel;
  /**
   * Persist a patch on the operation record (e.g. the Ark address the user
   * just typed). Addresses are asked for when the operation is opened, and
   * must survive a reload so the user is never asked twice.
   */
  onRecord?: (patch: Partial<OperationRecord>) => void;
  /** Opens the private chat with the counterparty of this operation. */
  onOpenChat?: (orderId: string) => void;
}

/**
 * Newest incoming `take` (a buyer took one of our sell orders). A take is only
 * ever sent to the maker, so as the seller it targets our order and lets us
 * prefill the order id and counterparty automatically. The taker's Ark address
 * arrives in a separate `taker_address` DM; we prefer it, but a legacy take may
 * still inline its address.
 */
function findActiveTake(
  feed: TradeDm[],
): { orderId: string; from: string; buyerArkAddress: string } | null {
  for (let i = feed.length - 1; i >= 0; i--) {
    const entry = feed[i];
    if (entry.msg && entry.msg.type === "take" && !entry.dm.outgoing) {
      const orderId = entry.msg.orderId;
      const from = entry.dm.sender;
      // Prefer the authenticated `taker_address` over the (legacy) inline one.
      let address = entry.msg.payload.buyerArkAddress ?? "";
      for (let j = feed.length - 1; j >= 0; j--) {
        const c = feed[j].msg;
        if (
          c &&
          c.type === "taker_address" &&
          c.orderId === orderId &&
          !feed[j].dm.outgoing &&
          feed[j].dm.sender === from
        ) {
          address = c.payload.arkAddress.trim();
          break;
        }
      }
      return { orderId, from, buyerArkAddress: address };
    }
  }
  return null;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** Compact countdown label, e.g. "23h 59m" or "4m 12s". */
function formatCountdown(seconds: number): string {
  if (seconds <= 0) return "0m";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  const s = Math.floor(seconds % 60);
  return `${m}m ${s}s`;
}

/** Newest incoming `dispute`: only solvers in the set receive these. */
function findActiveDispute(feed: TradeDm[]): TradeMessageOf<"dispute"> | null {
  for (let i = feed.length - 1; i >= 0; i--) {
    const entry = feed[i];
    if (entry.msg && entry.msg.type === "dispute" && !entry.dm.outgoing) {
      return entry.msg;
    }
  }
  return null;
}

export function TradePanel({
  identity,
  ctx,
  client,
  request,
  feed,
  disputeAnnounces = [],
  disputeTakes = [],
  label,
  onRecord,
  onOpenChat,
}: Props) {
  const [role, setRole] = useState<TradeRole>(request?.role ?? "seller");
  const [orderId, setOrderId] = useState(request?.orderId ?? "");
  const [counterparty, setCounterparty] = useState(request?.counterparty ?? "");

  // The alias is scoped to this operation, so the counterparty reads the same
  // everywhere inside it and differently in any other one.
  const peer = (key: string, scopeOrderId?: string) =>
    label?.(key, key ? `${key.slice(0, 12)}…` : "—", scopeOrderId ?? orderId) ??
    (key ? `${key.slice(0, 12)}…` : "—");

  const [tradeSats, setTradeSats] = useState(
    request?.tradeSats !== undefined ? String(request.tradeSats) : "",
  );
  const [fiatAmount, setFiatAmount] = useState(
    request?.fiatAmount !== undefined ? String(request.fiatAmount) : "",
  );
  const [fiat, setFiat] = useState(request?.fiat ?? "USD");
  // Payment methods are part of the offer's public advertisement (NIP-69 `pm`
  // tags). The concrete payment data (account, phone, e-mail) never enters
  // the app: the parties coordinate it in their private chat.
  const payMethods = (request?.paymentMethods ?? []).join(", ");

  const [myArk, setMyArk] = useState(
    request?.role === "seller"
      ? (request?.refundAddress ?? "")
      : (request?.buyerArkAddress ?? ""),
  );
  const [disputeReason, setDisputeReason] = useState("");

  const [localVtxo, setLocalVtxo] = useState<VirtualCoin | null>(null);
  // Usability of the locally-detected escrow VTXO: "spendable" once settled in
  // a batch, "pending" while still preconfirmed, "recoverable" if its batch was
  // swept. Actions that spend the escrow are gated on "spendable".
  const [localEscrowState, setLocalEscrowState] = useState<EscrowVtxoState | null>(null);
  // Coarse clock so timelock deadlines re-render without a per-second timer.
  const [nowSec, setNowSec] = useState(() => nowSeconds());
  // Chain median-time-past, seeded from the wall clock until the first fetch lands.
  const [chainSec, setChainSec] = useState(() => nowSeconds());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  // Guards the one-shot automatic "funded" notice the seller sends.
  const announcedRef = useRef(false);
  // Guards the one-shot `taker_address` DM the taker sends to the maker.
  const takerAddrSentRef = useRef(false);
  // Address requests already answered (keyed by the request DM id), so a solver
  // asking once is never answered twice.
  const addrRepliedRef = useRef<Set<string>>(new Set());
  // Optimistic: the take this solver published locally before the event
  // round-trips back from the relay. Kept with its orderId and solver key so it
  // never leaks into another dispute or another identity.
  const [localTake, setLocalTake] = useState<{ orderId: string; solverPubKey: string } | null>(
    null,
  );

  const arbiter = useMemo(() => {
    try {
      return arbiterPubKey();
    } catch {
      return null;
    }
  }, []);

  const solverView = Boolean(request?.solver);
  // Whether the local identity published the order (maker) or took it (taker).
  // Undefined on legacy records: treat as non-maker (conservative).
  const isMaker = request?.maker === true;
  const isTakerRole = request?.maker === false;
  const activeTake = !solverView && role === "seller" ? findActiveTake(feed) : null;
  // Only solvers receive dispute DMs, so an incoming one means we are a solver.
  const activeDispute = solverView ? null : findActiveDispute(feed);

  const effectiveOrderId = orderId.trim() || activeTake?.orderId || activeDispute?.orderId || "";
  const effectiveCounterparty = counterparty.trim() || activeTake?.from || "";
  // DMs of this order regardless of counterparty filtering: used both to
  // recover the counterparty when the request did not carry it and to rebuild
  // the parties' payout addresses without depending on `cpPub` (which itself
  // depends on the counterparty).
  const orderFeed = effectiveOrderId
    ? feed.filter((e) => e.msg?.orderId === effectiveOrderId)
    : [];
  const recoveredCounterparty =
    counterparty.trim() ||
    effectiveCounterparty ||
    orderFeed.find((e) => !e.dm.outgoing)?.dm.sender ||
    "";

  let cpPub: string | null = null;
  try {
    cpPub = pubkeyFromInput(recoveredCounterparty);
  } catch {
    cpPub = null;
  }

  // A solver must see both parties' messages for the order; filtering by a
  // single counterparty would hide the other side's authenticated address.
  const solverChat = Boolean(
    identity &&
      effectiveOrderId &&
      (solverView ||
        feed.some(
          (entry) =>
            !entry.dm.outgoing &&
            entry.msg?.type === "dispute" &&
            entry.msg.orderId === effectiveOrderId &&
            entry.msg.payload.agreement.arbiterPubKeys.some(
              (p) => p.toLowerCase() === identity.pubkeyHex.toLowerCase(),
            ),
        )),
  );

  const relevant = feed
    .filter(({ dm, msg }) => {
      if (!msg) return false;
      if (effectiveOrderId && msg.orderId !== effectiveOrderId) return false;
      if (cpPub && !solverChat) {
        const withCounterparty = dm.outgoing ? dm.recipients.includes(cpPub) : dm.sender === cpPub;
        if (!withCounterparty) return false;
      }
      return true;
    })
    .sort((a, b) => a.dm.createdAt - b.dm.createdAt);

  function lastOf<K extends TradeMessageType>(type: K): TradeMessageOf<K> | null {
    for (let i = relevant.length - 1; i >= 0; i--) {
      const msg = relevant[i].msg;
      if (msg && msg.type === type) return msg as TradeMessageOf<K>;
    }
    return null;
  }

  const escrowMsg = lastOf("escrow");
  const disputeMsg = lastOf("dispute");
  // The agreement normally comes from our counterparty's `escrow` DM; a solver
  // outside the trade only receives it inside an incoming `dispute` DM.
  const agreement = escrowMsg?.payload.agreement ?? disputeMsg?.payload.agreement ?? null;
  const agreedAddress = escrowMsg?.payload.address ?? "";
  const agreedRefundAddress = escrowMsg?.payload.refundAddress ?? "";
  const pendingRelease = lastOf("release_request");
  const fundedMsg = lastOf("funded");
  const arbiterDecision = lastOf("arbiter_decision");
  const disputeTakenMsg = lastOf("dispute_taken");
  const releaseDone = lastOf("release_done");
  const incomingArkRequest = useMemo(
    () => relevant.find((e) => e.msg?.type === "ark_address_request" && !e.dm.outgoing),
    [relevant],
  );

  // Recover both parties' Ark payout addresses from the persisted DMs, so
  // reopening an operation (or a panel opened from Operación/Historial) never
  // asks the user to type again an address they already provided when creating
  // or taking the order. Priority: explicit `escrow`/`take` payloads, then the
  // authenticated `ark_address` claims, then the dispute hints.
  const claimedAddressOf = (pub: string, partyRole?: TradeRole): string => {
    const target = pub.toLowerCase();
    for (let i = orderFeed.length - 1; i >= 0; i--) {
      const msg = orderFeed[i].msg;
      if (msg?.type !== "ark_address" || msg.from.toLowerCase() !== target) continue;
      if (partyRole && msg.role !== partyRole) continue;
      return msg.payload.arkAddress.trim();
    }
    return "";
  };
  // Both sides state an address: the maker published one with the order, the
  // taker stated one when taking it (legacy `take` inline, or the dedicated,
  // authenticated `taker_address` DM). The role carried by the message says
  // which one is which.
  const takeArk = lastOf("take")?.payload.buyerArkAddress ?? "";
  const takerAddressMsg = lastOf("taker_address")?.payload.arkAddress?.trim() ?? "";
  const takerDeliveredArk = takerAddressMsg || takeArk;
  const takerRole = lastOf("take")?.role;
  const makerArk = request?.arkAddress?.trim() ?? "";
  const buyerArkFromMessages =
    takerRole === "buyer" ? takerDeliveredArk : takerRole === "seller" ? makerArk : "";
  const sellerArkFromMessages =
    takerRole === "seller" ? takerDeliveredArk : takerRole === "buyer" ? makerArk : "";
  const disputeBuyerArk = disputeMsg?.payload.buyerArkAddress ?? "";
  const disputeSellerArk = disputeMsg?.payload.sellerArkAddress ?? "";
  const recoveredBuyerArk = (
    buyerArkFromMessages ||
    (cpPub ? claimedAddressOf(cpPub, "buyer") : "") ||
    disputeBuyerArk
  ).trim();
  const recoveredSellerArk = (
    agreedRefundAddress ||
    sellerArkFromMessages ||
    (cpPub ? claimedAddressOf(cpPub, "seller") : "") ||
    (identity ? claimedAddressOf(identity.pubkeyHex, "seller") : "") ||
    disputeSellerArk
  ).trim();
  // Our own already-known Ark address, whichever side we play.
  const ownRecoveredArk = (role === "seller" ? recoveredSellerArk : recoveredBuyerArk).trim();
  // The buyer's payout address, from the `take` or any of the recovered sources.
  const buyerArk = buyerArkFromMessages || request?.buyerArkAddress || recoveredBuyerArk;
  // The value in effect: whatever the user typed, else the address carried on
  // the request (order creation/take), else the one recovered from the feed.
  // Reading it on render (no effect) means reopening an operation never asks
  // again for an address already given at creation/take time, and a late
  // `fetchOrder` fill-in shows up without clobbering manual typing.
  const requestArk = (role === "seller" ? request?.refundAddress : request?.buyerArkAddress) ?? "";
  const effectiveMyArk = myArk.trim() || requestArk.trim() || ownRecoveredArk;

  // True when our key is part of the escrow's committed solver set. For a
  // party the agreement comes from our own escrow DM; for a solver it arrives
  // inside the dispute DM they are meant to resolve.
  const isSolver = Boolean(
    identity &&
      agreement &&
      agreement.arbiterPubKeys.some((p) => p.toLowerCase() === identity.pubkeyHex.toLowerCase()),
  );

  // Optimistic take: earliest created_at wins, ties broken by lowest event id,
  // so every client derives the same winner without a server.
  const takesForOrder = disputeTakes.filter((t) => t.orderId === effectiveOrderId);
  const takeTaker = pickDisputeTakeTaker(takesForOrder);
  const isTaker = Boolean(
    takeTaker &&
      identity &&
      takeTaker.solverPubKey.toLowerCase() === identity.pubkeyHex.toLowerCase(),
  );
  const takenByOther = Boolean(takeTaker && !isTaker);
  // We hold the dispute when we won the public race, or optimistically right
  // after publishing our own take (before the event round-trips from relays).
  const localTakeApplies = Boolean(
    localTake &&
      identity &&
      localTake.orderId === effectiveOrderId &&
      localTake.solverPubKey === identity.pubkeyHex,
  );
  // Winning by the public race, or optimistically via our own just-published
  // take while no other solver has won the race yet.
  const holdsTake =
    isTaker ||
    Boolean(
      localTakeApplies &&
        (!takeTaker ||
          (identity && takeTaker.solverPubKey.toLowerCase() === identity.pubkeyHex.toLowerCase())),
    );
  const canTakeDispute = isSolver && Boolean(disputeMsg) && !holdsTake && !takenByOther;
  const announceForOrder =
    disputeAnnounces.find((d) => d.orderId === effectiveOrderId) ?? null;

  // Escrow funding is a public on-chain fact: once either side has seen the
  // VTXO (detected locally or announced) there is nothing left to poll for.
  const fundingKnown = localVtxo !== null || fundedMsg !== null;

  // Cooperative cancellation: a cancel only takes effect once one side has
  // proposed it (cancel_request) and the other has accepted it (cancel_agree).
  // Neither peer can cancel alone — e.g. the seller cannot cancel after
  // receiving the fiat payment unless the buyer agrees too.
  const myCancelReq = relevant.find((e) => e.msg?.type === "cancel_request" && e.dm.outgoing);
  const theirCancelReq = relevant.find((e) => e.msg?.type === "cancel_request" && !e.dm.outgoing);
  const myCancelAgree = relevant.find((e) => e.msg?.type === "cancel_agree" && e.dm.outgoing);
  const theirCancelAgree = relevant.find((e) => e.msg?.type === "cancel_agree" && !e.dm.outgoing);
  // Agreed when a request and an agree exist and they come from different sides.
  const cancelAgreed = Boolean(
    (myCancelReq && theirCancelAgree) || (theirCancelReq && myCancelAgree),
  );
  // We still owe an agree: the counterparty proposed and we have not accepted.
  const cancelPendingFromThem = Boolean(theirCancelReq && !myCancelAgree);
  // We proposed but they have not accepted yet.
  const cancelWaitingOnThem = Boolean(myCancelReq && !theirCancelAgree);

  const vtxo: VirtualCoin | null =
    localVtxo ??
    (fundedMsg
      ? ({
          txid: fundedMsg.payload.txid,
          vout: fundedMsg.payload.vout,
          value: BigInt(fundedMsg.payload.amount),
        } as unknown as VirtualCoin)
      : null);

  // Whether the escrow can be spent right now. When we detected the VTXO
  // ourselves we trust the classified state; when we only have the seller's
  // `funded` announcement we cannot classify it, so we optimistically allow —
  // the actual `submitSpend`/`assertFunded` call still rejects a bad VTXO.
  const escrowSpendable = localEscrowState === null || localEscrowState === "spendable";
  const escrowPending = localEscrowState === "pending";
  const escrowRecoverable = localEscrowState === "recoverable";

  // Refuse to spend the escrow while it is not settled. Operating on a
  // preconfirmed VTXO risks losing it to a batch sweep; a swept one cannot be
  // spent off-chain at all.
  function requireSpendableEscrow(): void {
    if (escrowRecoverable) {
      throw new Error(
        "el escrow quedó barrido (swept): sus fondos deben recuperarse antes de liberarse, reembolsarse o disputarse",
      );
    }
    if (escrowPending) {
      throw new Error(
        "el escrow está fondeado pero aún no se asentó en un batch (preconfirmado); espera el asentamiento antes de liberar, reembolsar o disputar",
      );
    }
  }

  // The release spend pays the buyer exactly `tradeSats` and has no change back
  // to the escrow, so any excess funded is lost. Funding must match exactly.
  const expectedSats = agreement?.tradeSats ?? (Number(tradeSats) > 0 ? Number(tradeSats) : null);
  const fundedSats = vtxo ? Number(vtxo.value) : null;
  const fundingExact =
    fundedSats !== null && expectedSats !== null ? fundedSats === expectedSats : null;

  const escrow: Escrow | null =
    agreement && ctx ? escrowFromAgreement(agreement, ctx.network) : null;

  // Re-render roughly once a minute so the timelock state stays current.
  // `chainSec` tracks the chain's median-time-past (what the CLTV is actually
  // judged against) and falls back to the wall clock when Esplora is unreachable.
  useEffect(() => {
    const tick = () => {
      setNowSec(nowSeconds());
      if (ctx) chainTimeSeconds(ctx).then(setChainSec).catch(() => undefined);
    };
    const timer = setInterval(tick, 60000);
    tick();
    return () => clearInterval(timer);
  }, [ctx]);

  // The seller's timelocked refund opens once chain time reaches `refundLocktime`.
  const refundMature = Boolean(escrow && chainSec >= Number(escrow.refundLocktime));

  // --- Chained 15-minute windows -------------------------------------------------
  //
  // Every step of a trade has an owner who must act within the window, measured
  // from the *previous* step's relay-set timestamp (never a sender's own clock):
  // see `computeWindowState` for the full model. The party that blows its window
  // is the *culprit*; a maker at fault republishes manually, a taker at fault
  // lets the maker's order be republished automatically.
  const windowState = computeWindowState({
    feed: orderFeed,
    orderId: effectiveOrderId,
    role,
    isMaker,
    funded: fundingKnown,
    now: nowSec,
  });
  const anyWindowExpired = windowState.anyExpired;
  const windowCulprit = windowState.culprit;
  // Only the maker can cancel/republish; a taker at fault just waits while the
  // maker republishes. The maker at fault must do it manually.
  const canCancelAndRepublishByWindow = isMaker && anyWindowExpired;

  // Auto-check funding: poll the indexer for the escrow VTXO so neither side
  // has to press "Comprobar fondeo". The query is public (no keys involved).
  // We keep polling while the VTXO is not yet spendable (preconfirmed or swept)
  // so the state can flip to "spendable" once the batch settles.
  useEffect(() => {
    if (!ctx || !agreement || fundingKnown) return;
    let cancelled = false;
    const esc = escrowFromAgreement(agreement, ctx.network);
    const poll = () => {
      listEscrowVtxos(ctx.indexer, esc)
        .then((found) => {
          if (cancelled || found.length === 0) return;
          const best =
            found.find((e) => e.state === "spendable") ??
            found.find((e) => e.state === "recoverable") ??
            found[0];
          setLocalVtxo(best.vtxo);
          setLocalEscrowState(best.state);
        })
        .catch(() => undefined);
    };
    const timer = setInterval(poll, 12000);
    poll();
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [ctx, agreement, fundingKnown]);

  // Once the funding shows up, the seller announces it to the buyer (one shot).
  useEffect(() => {
    if (role !== "seller" || !localVtxo || announcedRef.current) return;
    if (!identity || !cpPub || !effectiveOrderId) return;
    announcedRef.current = true;
    const msg: TradeMessageOf<"funded"> = {
      app: TRADE_APP,
      v: TRADE_VERSION,
      type: "funded",
      orderId: effectiveOrderId,
      role,
      from: identity.pubkeyHex,
      ts: nowSeconds(),
      payload: { txid: localVtxo.txid, vout: localVtxo.vout, amount: Number(localVtxo.value) },
    };
    sendDm(client.pool, client.relays, identity, cpPub, encodeTradeMessage(msg))
      .then(() => setStatus(`Fondeado con ${localVtxo.value} sats (avisado al comprador).`))
      .catch(() => {
        announcedRef.current = false;
      });
  }, [role, localVtxo, identity, cpPub, effectiveOrderId, client]);

  // Deliver the taker's Ark address to the maker (once) via the authenticated
  // `taker_address` DM. This starts the taker's window: the maker can only
  // build the escrow once it knows where the taker receives/refunds. We send
  // only our own address, never the counterparty's.
  useEffect(() => {
    if (takerAddrSentRef.current) return;
    if (!isTakerRole || !identity || !effectiveOrderId || !cpPub) return;
    const addr = effectiveMyArk;
    if (!addr) return;
    takerAddrSentRef.current = true;
    const msg: TradeMessageOf<"taker_address"> = {
      app: TRADE_APP,
      v: TRADE_VERSION,
      type: "taker_address",
      orderId: effectiveOrderId,
      role,
      from: identity.pubkeyHex,
      ts: nowSeconds(),
      payload: { arkAddress: addr },
    };
    sendDm(client.pool, client.relays, identity, cpPub, encodeTradeMessage(msg)).catch(() => {
      takerAddrSentRef.current = false;
    });
  }, [isTakerRole, identity, effectiveOrderId, cpPub, effectiveMyArk, role, client]);

  // Answer a solver's address request with our own, authenticated `ark_address`.
  // Solvers never learn the parties' addresses before a dispute: they request
  // them here and each party states its own (the DM sender key authenticates
  // it), so a solver never pays an address a disputant typed on the other's
  // behalf.
  useEffect(() => {
    if (!identity || !effectiveOrderId || !effectiveMyArk) return;
    const request = relevant.find(
      (e) => e.msg?.type === "ark_address_request" && !e.dm.outgoing,
    );
    if (!request) return;
    const key = `${request.dm.id}`;
    if (addrRepliedRef.current.has(key)) return;
    addrRepliedRef.current.add(key);
    const agr = escrowMsg?.payload.agreement;
    const msg: TradeMessageOf<"ark_address"> = {
      app: TRADE_APP,
      v: TRADE_VERSION,
      type: "ark_address",
      orderId: effectiveOrderId,
      role,
      from: identity.pubkeyHex,
      ts: nowSeconds(),
      payload: { ...(agr ? { agreement: agr } : {}), arkAddress: effectiveMyArk },
    };
    sendDm(client.pool, client.relays, identity, request.dm.sender, encodeTradeMessage(msg)).catch(
      () => {
        addrRepliedRef.current.delete(key);
      },
    );
  }, [relevant, identity, effectiveOrderId, effectiveMyArk, role, client, escrowMsg]);

  function run<T>(fn: () => Promise<T>) {
    setBusy(true);
    setError("");
    setStatus("");
    fn()
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  }

  async function sendTo<K extends TradeMessageType>(
    recipient: string,
    kind: K,
    payload: TradePayloads[K],
  ) {
    if (!identity) throw new Error("sin identidad");
    const msg: TradeMessageOf<K> = {
      app: TRADE_APP,
      v: TRADE_VERSION,
      type: kind,
      orderId: effectiveOrderId,
      role,
      from: identity.pubkeyHex,
      ts: nowSeconds(),
      payload,
    };
    await sendDm(client.pool, client.relays, identity, recipient, encodeTradeMessage(msg));
  }

  async function send<K extends TradeMessageType>(kind: K, payload: TradePayloads[K]) {
    if (!cpPub) throw new Error("contraparte inválida (npub o hex)");
    await sendTo(cpPub, kind, payload);
  }

  function handleFiatSent() {
    run(async () => {
      await send("fiat_sent", {});
      setStatus("Aviso de pago fiat enviado.");
    });
  }

  /** Propose aborting the trade. Takes effect only if the counterparty agrees. */
  function handleCancelRequest() {
    if (!identity) throw new Error("sin identidad");
    if (!canSend) throw new Error("falta orderId o contraparte");
    run(async () => {
      await send("cancel_request", {});
      setStatus(
        "Cancelación propuesta. La operación solo se cancela si la contraparte también acepta.",
      );
    });
  }

  /** Accept the counterparty's pending cancel request (cooperative cancel). */
  function handleCancelAgree() {
    if (!identity) throw new Error("sin identidad");
    run(async () => {
      await send("cancel_agree", {});
      await client
        .setOrderStatus(identity, effectiveOrderId, "canceled")
        .catch(() => undefined);
      setStatus("Cancelación aceptada por ambas partes. Operación cancelada.");
    });
  }

  /**
   * Maker-only: cancel an order whose chained window expired and republish a
   * fresh, equivalent offer. Safe because nothing was funded (the escrow VTXO
   * does not exist), so it needs no counterparty agreement. The republished
   * listing preserves the original side (`sell`/`buy`) and payment methods.
   */
  function handleCancelAndRepublish() {
    if (!identity) throw new Error("sin identidad");
    if (!isMaker) throw new Error("solo el creador de la orden puede republicar");
    if (!canCancelAndRepublishByWindow) throw new Error("la operación aún está dentro del plazo");
    const fiat = agreement?.fiat ?? (request?.fiat ?? "USD");
    const fiatAmount = agreement?.fiatAmount ?? request?.fiatAmount;
    const tradeSats = agreement?.tradeSats ?? request?.tradeSats;
    if (fiatAmount === undefined || tradeSats === undefined) {
      throw new Error("faltan datos de la orden para republicar");
    }
    const methods = request?.paymentMethods ?? [];
    // The republished order keeps the maker's Ark address, which is mandatory
    // for every offer, and the original side it advertised.
    const arkAddress = effectiveMyArk;
    if (!arkAddress) throw new Error("indica tu dirección Ark para republicar la orden");
    const orderType = request?.orderType ?? "sell";
    run(async () => {
      // Best effort: retire the stalled listing. A new `d` is published below,
      // so relays without NIP-09 support still only surface the fresh order.
      await client.setOrderStatus(identity, effectiveOrderId, "canceled").catch(() => undefined);
      const template = buildOrderTemplate({
        type: orderType,
        fiat,
        fiatAmount,
        amountSats: tradeSats,
        premium: 0,
        paymentMethods: methods,
        expiresAt: nowSeconds() + 24 * 3600,
        name: identity.npub,
        arkAddress,
      });
      const event = await client.publish(template, identity);
      const id = event.tags.find((t) => t[0] === "d")?.[1] ?? event.id;
      setStatus(`Operación cancelada y republicada como ${id.slice(0, 8)}…`);
    });
  }

  function handleBuildAgreement() {
    if (!identity || !ctx) throw new Error("falta identidad o ASP");
    if (!cpPub) throw new Error("contraparte inválida (npub o hex)");
    if (!effectiveMyArk) throw new Error("indica tu dirección Ark para reembolsos");
    run(async () => {
      // Solver set comes from the coordinator's replaceable registry event;
      // fall back to VITE_ARBITER so the app still works without a registry.
      const registry = await client.fetchSolvers(coordinatorPubKey()).catch(() => null);
      const fromRegistry = (registry?.solvers ?? [])
        .map((p) => {
          try {
            return pubkeyFromInput(p);
          } catch {
            return null;
          }
        })
        .filter((p): p is string => p !== null);
      const solverSet = fromRegistry.length > 0 ? fromRegistry : arbiter ? [arbiter] : [];
      if (solverSet.length === 0) {
        throw new Error("no hay solvers: revisa el registro del coordinador o VITE_ARBITER");
      }
      // Anchor the refund timelock to *chain* time (median-time-past), not the
      // local clock: BIP-113 evaluates the escrow's seconds-typed CLTV against
      // MTP, and a skewed local clock would put the two peers' derived scripts
      // and the maturity check out of step with the network.
      const chainNow = await chainTimeSeconds(ctx);
      const agr: EscrowAgreement = {
        orderId: effectiveOrderId,
        fiat: fiat.trim().toUpperCase(),
        fiatAmount: Number(fiatAmount),
        tradeSats: Number(tradeSats),
        buyerPubKey: cpPub,
        sellerPubKey: identity.pubkeyHex,
        arbiterPubKeys: solverSet,
        serverPubKey: hex.encode(ctx.serverPubKey),
        refundLocktime: refundLocktimeFrom(chainNow).toString(),
      };
      const built = escrowFromAgreement(agr, ctx.network);
      await send("escrow", {
        agreement: agr,
        address: built.address,
        refundAddress: effectiveMyArk,
      });
      onRecord?.({ refundAddress: effectiveMyArk });
      // Solvers are *not* told our address here: they only learn a party's
      // payout address once a dispute is open, by requesting it (the party then
      // answers with an authenticated `ark_address`). This keeps the addresses
      // of undisputed trades private.
      setStatus(`Escrow acordado con ${solverSet.length} solver(s). Dirección a fondear: ${built.address}`);
    });
  }

  function checkFunding(announce: boolean) {
    if (!ctx || !escrow) throw new Error("aún no hay escrow acordado");
    run(async () => {
      const all = await listEscrowVtxos(ctx.indexer, escrow);
      const best =
        all.find((e) => e.state === "spendable") ??
        all.find((e) => e.state === "recoverable") ??
        all[0];
      const found = best?.vtxo ?? null;
      setLocalVtxo(found);
      setLocalEscrowState(best?.state ?? null);
      if (!found) throw new Error("el escrow aún no tiene fondos");
      const expected = agreement?.tradeSats ?? null;
      if (expected !== null && Number(found.value) !== expected) {
        throw new Error(
          `fondeo incorrecto: el escrow tiene ${found.value} sats pero el acuerdo es ${expected} sats; el vendedor debe enviar exactamente el monto acordado`,
        );
      }
      if (best.state === "recoverable") {
        setStatus(
          `El escrow quedó barrido (swept) con ${found.value} sats: sus fondos deben recuperarse antes de poder liberarse o reembolsarse.`,
        );
        return;
      }
      if (best.state === "pending") {
        setStatus(
          `Escrow fondeado con ${found.value} sats, esperando asentamiento del batch (aún preconfirmado). No liberes, reembolses ni disputes hasta que se asiente.`,
        );
        return;
      }
      if (announce) {
        announcedRef.current = true;
        await send("funded", { txid: found.txid, vout: found.vout, amount: Number(found.value) });
      }
      setStatus(`Fondeado con ${found.value} sats.`);
    });
  }

  function handleReleaseRequest() {
    if (!identity || !ctx) throw new Error("falta identidad o ASP");
    if (!escrow || !vtxo || !agreement) throw new Error("falta escrow fondeado o acuerdo");
    requireSpendableEscrow();
    if (fundingExact === false) {
      throw new Error(
        `el escrow está fondeado con ${fundedSats} sats pero el acuerdo es ${agreement.tradeSats} sats; debe enviarse exactamente el monto acordado`,
      );
    }
    const dest = buyerArk.trim();
    if (!dest) throw new Error("falta la dirección Ark del comprador (aún no envió 'take')");
    run(async () => {
      // Re-check against the indexer right before spending: a VTXO that looked
      // settled locally may have been swept since, and the server rejects a
      // recoverable input with "VTXO is recoverable".
      const spendable = await assertFunded(ctx.indexer, escrow, agreement.tradeSats);
      const outputs = [outputToArkAddress(dest, BigInt(agreement.tradeSats))];
      const partial = buildSpend(ctx.info, escrow, spendable, EscrowPath.Release, outputs);
      const signed = await signSpend(partial, identity);
      await send("release_request", { spend: signed, to: dest, sats: agreement.tradeSats });
      setStatus("Petición de liberación enviada; espera la co-firma del comprador.");
    });
  }

  function handleReleaseNow() {
    if (!identity || !ctx) throw new Error("falta identidad o ASP");
    if (!escrow || !vtxo || !agreement || !pendingRelease) throw new Error("faltan datos para liberar");
    requireSpendableEscrow();
    if (fundingExact === false) {
      throw new Error(
        `el escrow está fondeado con ${fundedSats} sats pero el acuerdo es ${agreement.tradeSats} sats; no se puede liberar hasta que el fondeo coincida exactamente`,
      );
    }
    const spend = pendingRelease.payload.spend;
    const dest = pendingRelease.payload.to;
    const myAddress = effectiveMyArk || recoveredBuyerArk;
    if (dest.trim() !== myAddress) {
      throw new Error("la liberación no paga a la dirección Ark indicada");
    }
    run(async () => {
      // Re-check against the indexer before co-signing: a VTXO that looked
      // settled may have been swept since, and the server rejects a recoverable
      // input with "VTXO is recoverable".
      const spendable = await assertFunded(ctx.indexer, escrow, agreement.tradeSats);
      verifyReleaseSpend(escrow, spendable, { destination: dest, sats: agreement.tradeSats }, spend);
      const coSigned = await coSignSpend(spend, identity);
      const both = mergeSpends(spend, coSigned);
      const arkTxid = await submitSpend(ctx.ark, both);
      await send("release_done", { arkTxid });
      setStatus(`Operación completada: liberación enviada al servidor (${arkTxid}).`);
    });
  }

  /**
   * Seller-only: after the timelock matures, reclaim the escrow through the
   * `refund` leaf (seller + server). No solver is involved. If the buyer has
   * paid and not been released, they must have opened a dispute before now.
   */
  function handleRefund() {
    if (!identity || !ctx) throw new Error("falta identidad o ASP");
    if (!escrow || !vtxo || !agreement) throw new Error("falta escrow fondeado o acuerdo");
    if (role !== "seller") throw new Error("solo el vendedor puede reclamar el reembolso");
    if (!refundMature) throw new Error("el reembolso aún no está disponible (plazo sin vencer)");
    requireSpendableEscrow();
    const dest = effectiveMyArk || recoveredSellerArk;
    if (!dest) throw new Error("falta tu dirección Ark de cobro");
    run(async () => {
      const spendable = await assertFunded(ctx.indexer, escrow, agreement.tradeSats);
      const outputs = [outputToArkAddress(dest, BigInt(agreement.tradeSats))];
      const partial = buildSpend(ctx.info, escrow, spendable, EscrowPath.Refund, outputs);
      const signed = await signSpend(partial, identity);
      verifyRefundSpend(escrow, spendable, { destination: dest, sats: agreement.tradeSats }, signed);
      const arkTxid = await submitSpend(ctx.ark, signed);
      await sendTo(agreement.buyerPubKey, "arbiter_decision", {
        outcome: "refund_to_seller",
        destination: dest,
        sats: agreement.tradeSats,
        arkTxid,
      }).catch(() => undefined);
      setStatus(`Reembolso enviado al servidor (${arkTxid}).`);
    });
  }

  /**
   * Seller-only: recover a swept escrow VTXO.
   *
   * A swept VTXO cannot be spent through its leaf (`SubmitOffchainTx` rejects
   * it); the only off-chain way back is a settlement, which the SDK's
   * `VtxoManager.recoverVtxos()` drives using the escrow's `refund` leaf as the
   * forfeit closure. That leaf is CLTV-gated on `refundLocktime`, so recovery
   * only succeeds once the timelock has matured.
   */
  function handleRecover() {
    if (!identity || !ctx) throw new Error("falta identidad o ASP");
    if (!escrow) throw new Error("falta el acuerdo de escrow");
    if (role !== "seller") throw new Error("solo el vendedor (quien fondea el escrow) puede recuperarlo");
    if (!refundMature)
      throw new Error("la recuperación aún no está disponible (plazo de reembolso sin vencer)");
    run(async () => {
      const dest = derivePersonalArkAddress(identity, ctx);
      const arkTxid = await recoverEscrowVtxos(ctx, identity, escrow, (event) => {
        setStatus(`Recuperando escrow: ${event.type}…`);
      });
      setStatus(`Escrow recuperado y asentado en ${dest} (tx ${arkTxid}).`);
    });
  }

  /** Buyer or seller escalates to every solver in the escrow's solver set. */
  function handleOpenDispute() {
    if (!identity) throw new Error("sin identidad");
    if (!agreement) throw new Error("aún no hay acuerdo de escrow");
    const buyerAddress =
      (role === "buyer" ? effectiveMyArk : buyerArk.trim()) || recoveredBuyerArk;
    const sellerAddress =
      (role === "seller" ? effectiveMyArk : agreedRefundAddress) || recoveredSellerArk;
    if (!buyerAddress) throw new Error("falta la dirección Ark del comprador");
    if (!sellerAddress) throw new Error("falta la dirección Ark del vendedor");
    const reason = disputeReason.trim() || "sin motivo especificado";
    const recipients = [
      ...new Set(agreement.arbiterPubKeys.map((p) => p.toLowerCase())),
    ].filter((p) => p !== identity.pubkeyHex.toLowerCase());
    if (recipients.length === 0) throw new Error("el acuerdo no tiene solvers configurados");
    run(async () => {
      // 1. Public announcement (tags only): every solver subscribed to the
      // dispute kind sees that this order entered a dispute.
      await client.publish(buildDisputeAnnounceTemplate(effectiveOrderId, identity.pubkeyHex, reason), identity);
      // 2. Encrypted DMs carrying the agreement to each solver (the agreement
      // never goes out in clear on the relay).
      const payload = { reason, agreement, buyerArkAddress: buyerAddress, sellerArkAddress: sellerAddress };
      await Promise.all(
        recipients.map((solver) => sendTo(solver, "dispute", payload)),
      );
      // 3. State *our own* payout address to the solver, signed by our key.
      //    Solvers never learn addresses before a dispute; the initiator gives
      //    its own up front, and the other party answers the solver's request.
      const mine = effectiveMyArk;
      if (mine) {
        await Promise.allSettled(
          recipients.map((solver) =>
            sendTo(solver, "ark_address", { agreement, arkAddress: mine }),
          ),
        );
      }
      setStatus(`Disputa publicada y enviada a ${recipients.length} solver(s).`);
    });
  }

  /**
   * A solver claims the dispute by publishing an optimistic take. The take is
   * not exclusive at publish time: every client picks the same winner from all
   * competing takes (earliest `created_at`, lowest event id on ties), and the
   * escrow itself only allows a single spend anyway.
   */
  function handleTakeDispute() {
    if (!identity) throw new Error("sin identidad");
    if (!agreement) throw new Error("aún no hay acuerdo de escrow");
    if (takenByOther) throw new Error("otro solver ya tomó esta disputa");
    run(async () => {
      setLocalTake({ orderId: effectiveOrderId, solverPubKey: identity.pubkeyHex });
      try {
        await client.publish(
          buildDisputeTakeTemplate(effectiveOrderId, identity.pubkeyHex),
          identity,
        );
        // Tell both parties who is resolving, so they can chat with us directly.
        const payload = { orderId: effectiveOrderId, solverPubKey: identity.pubkeyHex };
        const parties = [...new Set([agreement.buyerPubKey, agreement.sellerPubKey])];
        await Promise.all(parties.map((party) => sendTo(party, "dispute_taken", payload)));
        setStatus("Disputa tomada: pide pruebas a las partes y resuelve cuando tengas evidencias.");
      } catch (e) {
        setLocalTake(null);
        throw e;
      }
    });
  }

  /**
   * Solver-only: ask both parties for their authenticated Ark payout addresses.
   * Solvers learn no addresses before a dispute, so they must request them once
   * they own the dispute; each party answers with a signed `ark_address`.
   */
  function handleRequestAddresses() {
    if (!identity) throw new Error("sin identidad");
    if (!agreement) throw new Error("aún no hay acuerdo de escrow");
    if (!holdsTake) throw new Error("toma la disputa antes de pedir las direcciones");
    run(async () => {
      const parties = [...new Set([agreement.buyerPubKey, agreement.sellerPubKey])].filter(
        (p) => p.toLowerCase() !== identity.pubkeyHex.toLowerCase(),
      );
      await Promise.all(
        parties.map((party) =>
          sendTo(party, "ark_address_request", { reason: "disputa en curso" }),
        ),
      );
      setStatus(`Pedidas las direcciones Ark a ${parties.length} parte(s). Abre el chat para hablar con ellos.`);
    });
  }

  function handleSendArkAddressToSolver() {
    if (!identity) throw new Error("sin identidad");
    if (!agreement) throw new Error("sin acuerdo");
    const solver =
      disputeTakenMsg?.payload?.solverPubKey ||
      (disputeMsg?.payload as any)?.solverPubKey ||
      agreement.arbiterPubKeys?.[0];
    if (!solver) throw new Error("no hay solver");
    const addr = myArk.trim();
    if (!addr) throw new Error("indica tu dirección Ark");
    run(async () => {
      await sendTo(solver, "ark_address", {
        arkAddress: addr,
        agreement,
      });
      setStatus("Dirección Ark enviada al solver.");
      onOpenChat?.(solver);
    });
  }

  /**
   * The Ark payout address a party confirmed to the arbiter via an
   * authenticated `ark_address` DM. Returns null when no matching claim has
   * arrived, in which case the arbiter must not pay that party.
   */
  function authenticatedAddress(partyRole: TradeRole): string | null {
    const agr = disputeMsg?.payload.agreement ?? agreement;
    if (!agr) return null;
    const pub = (partyRole === "buyer" ? agr.buyerPubKey : agr.sellerPubKey).toLowerCase();
    const claim =
      relevant.find(
        (e) =>
          e.msg?.type === "ark_address" &&
          !e.dm.outgoing &&
          (e.msg.from?.toLowerCase() === pub || e.dm.sender?.toLowerCase() === pub),
      ) ||
      feed.find(
        (e) =>
          e.msg?.type === "ark_address" &&
          !e.dm.outgoing &&
          (e.msg.from?.toLowerCase() === pub || e.dm.sender?.toLowerCase() === pub),
      );
    if (!claim?.msg || claim.msg.type !== "ark_address") return null;
    // A claim may arrive without an agreement (the buyer states its address
    // to the seller before the escrow exists). The DM author is what
    // authenticates it, so the agreement is only checked when it is there.
    const a = claim.msg.payload.agreement;
    if (a && (a.buyerPubKey !== agr.buyerPubKey || a.sellerPubKey !== agr.sellerPubKey)) {
      return null;
    }
    const addr = claim.msg.payload.arkAddress;
    if (typeof addr !== "string") return null;
    return addr.trim() || null;
  }

  /**
   * A solver resolves the dispute by spending the escrow via their own
   * `arbiter` leaf (solver + server).
   *
   * Process (deliberately not "wait for the seller"):
   *
   *  1. A dispute is almost always opened by the **buyer**: it paid fiat and the
   *     seller is refusing (or unable) to co-sign the release. The seller has
   *     little incentive to dispute because the escrow's `refund` leaf already
   *     lets it reclaim the sats once the locktime matures.
   *  2. The escrow's `arbiter` leaf has **no CLTV**, so the solver can pay the
   *     authenticated buyer *at any time*, without waiting for the locktime.
   *  3. The solver must therefore act on the *evidence*, not on the seller's
   *     silence: if the buyer proves it paid, the solver releases to the buyer
   *     before the seller can execute `refund` at the locktime. Waiting for an
   *     unresponsive seller would hand the escrow back to the seller and rob a
   *     paying buyer.
   *  4. Conversely, absent buyer evidence, the solver must **not** release; the
   *     seller recovers via the timelocked refund and the buyer keeps nothing.
   *
   * The destination is the winner's *authenticated* `ark_address` (signed by
   * the party itself), never an address a disputant typed on the other's behalf.
   */
  function handleArbiterDecide(outcome: "release_to_buyer" | "refund_to_seller") {
    if (!identity || !ctx) throw new Error("falta identidad o ASP");
    if (!isSolver) throw new Error("no eres solver de esta disputa");
    if (!holdsTake) throw new Error("esta disputa la tomó otro solver");
    if (!disputeMsg) throw new Error("no hay una disputa para resolver");
    const p = disputeMsg.payload;
    const winner: TradeRole = outcome === "release_to_buyer" ? "buyer" : "seller";
    const destination = authenticatedAddress(winner);
    const sats = p.agreement.tradeSats;
    if (!destination) {
      throw new Error(
        `no tengo la dirección Ark autenticada del ${winner === "buyer" ? "comprador" : "vendedor"}; pídesela con "Pedir direcciones Ark a las partes"`,
      );
    }
    run(async () => {
      const esc = escrowFromAgreement(p.agreement, ctx.network);
      const held = await assertFunded(ctx.indexer, esc, sats);
      const outputs = [outputToArkAddress(destination, BigInt(sats))];
      const partial = buildSpend(ctx.info, esc, held, EscrowPath.Arbiter, outputs, identity.pubkeyHex);
      const signed = await signSpend(partial, identity);
      verifyArbiterSpend(esc, held, identity.pubkeyHex, { destination, sats }, signed);
      const arkTxid = await submitSpend(ctx.ark, signed);
      const payload: TradePayloads["arbiter_decision"] = {
        outcome,
        destination,
        sats,
        arkTxid,
        solverPubKey: identity.pubkeyHex,
      };
      await sendTo(p.agreement.buyerPubKey, "arbiter_decision", payload);
      await sendTo(p.agreement.sellerPubKey, "arbiter_decision", payload);
      // Public resolution so every client agrees the dispute is over.
      await client
        .publish(
          buildDisputeResolutionTemplate(
            p.agreement.orderId,
            identity.pubkeyHex,
            outcome === "release_to_buyer" ? "settled" : "refunded",
            arkTxid,
          ),
          identity,
        )
        .catch(() => undefined);
      setStatus(`Disputa resuelta (${outcome}): ${arkTxid}`);
    });
  }

  const canSend = Boolean(identity && cpPub && effectiveOrderId);

  // Authenticated payout addresses the arbiter will actually pay (null until
  // each party has sent its own `ark_address` claim).
  const authBuyerAddr = isSolver && disputeMsg ? authenticatedAddress("buyer") : null;
  const authSellerAddr = isSolver && disputeMsg ? authenticatedAddress("seller") : null;

  // The race the solver is running against: once chain time reaches the escrow's
  // `refundLocktime`, the seller can reclaim the escrow through the `refund`
  // leaf (seller + server), even without the solver. Before that, the solver's
  // `arbiter` leaf can pay the authenticated buyer at any time. So the solver
  // must act *before* this deadline when the evidence favours the buyer — it
  // must not wait for the seller to answer.
  const solverDeadline =
    disputeMsg !== null ? Number(disputeMsg.payload.agreement.refundLocktime ?? 0) : 0;
  const solverSecondsLeft = solverDeadline > 0 ? solverDeadline - chainSec : 0;
  // Window within which the deadline is close enough to escalate the warning.
  const deadlineNear = solverDeadline > 0 && solverSecondsLeft <= 6 * 3600;

  return (
    <section className="panel">
      <h2>Detalle de la operación</h2>
      <p style={{ fontSize: "0.85em" }}>
        Acuerdo de escrow, métodos de pago, firma cooperativa y disputa/arbitraje por mensajes
        privados cifrados (NIP-17). Todo en mutinynet, fondos de prueba.
      </p>
      {isSolver && (
        <p style={{ color: "#b45309", fontSize: "0.9em" }}>
          Esta clave está en el solver set de este escrow: aquí recibes disputas y las resuelves.
        </p>
      )}
      {solverView && (
        <p style={{ color: "#2563eb", fontSize: "0.9em" }}>
          Modo solver: ves los mensajes de ambas partes. Toma la disputa y resuélvela en la
          sección de abajo. Si el comprador prueba que pagó, paga al comprador por tu hoja de
          árbitro <strong>antes</strong> del locktime del escrow: no esperes al vendedor, porque
          al vencer el plazo el vendedor puede recuperar los sats.
        </p>
      )}

      {releaseDone && (
        <p style={{ color: "green", fontWeight: 700 }}>
          Operación completada: se liberaron {agreement?.tradeSats ?? "—"} sats al comprador (ark
          tx {releaseDone.payload.arkTxid.slice(0, 16)}…).
        </p>
      )}

      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        {!solverView && (
          <label>
            Rol{" "}
            <select value={role} onChange={(e) => setRole(e.target.value as TradeRole)}>
              <option value="seller">Vendedor</option>
              <option value="buyer">Comprador</option>
            </select>
          </label>
        )}
        <input
          placeholder="order id (d)"
          value={effectiveOrderId}
          onChange={(e) => setOrderId(e.target.value)}
        />
        {!solverView && (
          <input
            placeholder="contraparte npub o hex"
            value={recoveredCounterparty}
            onChange={(e) => setCounterparty(e.target.value)}
            style={{ width: 320 }}
          />
        )}
        {arbiter && (
          <span style={{ fontSize: "0.8em", opacity: 0.7 }}>
            árbitro configurado: {peer(arbiter)}…
          </span>
        )}
      </div>

      {activeTake && !counterparty.trim() && (
        <p style={{ fontSize: "0.85em", color: "#2563eb" }}>
          Orden tomada por {peer(activeTake.from)} — order id y contraparte prellenados.
          {activeTake.buyerArkAddress
            ? ` Comprador recibe en ${activeTake.buyerArkAddress.slice(0, 16)}…`
            : ""}
        </p>
      )}

      {anyWindowExpired && (
        <div style={{ padding: 8, border: "1px solid #f59e0b55", borderRadius: 8, marginTop: 8 }}>
          <p style={{ fontSize: "0.9em", color: "#b45309", margin: 0 }}>
            {windowCulprit === "taker" && isMaker && (
              <>
                El taker no completó su paso dentro de los 15 minutos (no entregó su dirección Ark
                o no fondeó el escrow siendo el vendedor). No se movió ningún fondo. Puedes
                republicar tu oferta; se hará automáticamente y también puedes hacerlo ahora.
              </>
            )}
            {windowCulprit === "maker" && isMaker && (
              <>
                No completaste tu paso dentro de los 15 minutos (construir el escrow o fondeado).
                No se movió ningún fondo. Cancela y republica tu oferta manualmente para
                responsabilizarte con la operación.
              </>
            )}
            {windowCulprit === "maker" && !isMaker && (
              <>
                La contraparte (maker) no completó su paso dentro de los 15 minutos. Puedes esperar
                a que republique su oferta; no se movió ningún fondo.
              </>
            )}
            {windowCulprit === "taker" && !isMaker && (
              <>
                No completaste tu paso dentro de los 15 minutos (entregar tu dirección Ark o
                fondear el escrow). La oferta del maker se republicará; no se movió ningún fondo.
              </>
            )}
          </p>
          {isMaker && (
            <button
              type="button"
              style={{ marginTop: 8 }}
              disabled={busy || !identity}
              onClick={handleCancelAndRepublish}
            >
              Cancelar y republicar orden
            </button>
          )}
        </div>
      )}

      {!solverView && role === "seller" && (
        <>
          <h3>Acuerdo de escrow</h3>
          <div style={{ display: "flex", flexDirection: "column", gap: 6, maxWidth: 520 }}>
            <input
              placeholder="sats netos para el comprador"
              value={tradeSats}
              onChange={(e) => setTradeSats(e.target.value)}
            />
            <input
              placeholder="monto fiat"
              value={fiatAmount}
              onChange={(e) => setFiatAmount(e.target.value)}
            />
            <input placeholder="fiat (USD, CUP…)" value={fiat} onChange={(e) => setFiat(e.target.value)} />
          </div>
          <p className="panel-note" style={{ fontSize: "0.85em" }}>
            Ya tienes todos los datos: el comprador recibe en{" "}
            <code>{buyerArk || "—"}</code> y tú reembolses en{" "}
            <code>{effectiveMyArk || "—"}</code>. Crea el escrow y fóndalo; los detalles del método
            de pago los coordináis por DM.
          </p>
          {!effectiveMyArk && (
            <input
              placeholder="mi dirección Ark (reembolsos)"
              value={myArk}
              onChange={(e) => setMyArk(e.target.value)}
            />
          )}
          <div style={{ marginTop: 8, display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              type="button"
              disabled={busy || !identity || !ctx || !canSend || !arbiter}
              onClick={handleBuildAgreement}
            >
              Acordar y enviar escrow
            </button>
            <button type="button" disabled={busy || !escrow} onClick={() => checkFunding(true)}>
              Comprobar fondeo y avisar
            </button>
            <button
              type="button"
              disabled={busy || !vtxo || !buyerArk || fundingExact === false || !escrowSpendable}
              onClick={handleReleaseRequest}
            >
              Solicitar liberación (firmar y enviar)
            </button>
            <button
              type="button"
              disabled={
                busy || !vtxo || !refundMature || releaseDone !== null || !escrowSpendable
              }
              title={
                refundMature
                  ? undefined
                  : escrow
                    ? `El reembolso se habilita el ${new Date(Number(escrow.refundLocktime) * 1000).toLocaleString()}`
                    : undefined
              }
              onClick={handleRefund}
            >
              Reclamar reembolso tras el plazo
            </button>
          </div>
          {vtxo && escrowPending && (
            <p className="panel-note" style={{ fontSize: "0.85em", opacity: 0.9 }}>
              Escrow fondeado pero aún <strong>no asentado</strong> en un batch (preconfirmado). Las
              acciones de liberación, reembolso y disputa se habilitan cuando se asiente.
            </p>
          )}
          {vtxo && escrowRecoverable && (
            <div className="panel-note" style={{ fontSize: "0.85em", opacity: 0.9 }}>
              <p style={{ margin: 0 }}>
                El escrow quedó <strong>barrido (swept)</strong>: sus fondos deben recuperarse antes de
                poder liberarse, reembolsarse o disputarse.
              </p>
              {role === "seller" && escrow && (
                <div style={{ marginTop: 6, display: "flex", gap: 8, alignItems: "center" }}>
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={busy || !refundMature}
                    title={
                      refundMature
                        ? undefined
                        : `La recuperación se habilita el ${new Date(Number(escrow.refundLocktime) * 1000).toLocaleString()}`
                    }
                    onClick={handleRecover}
                  >
                    Recuperar escrow
                  </button>
                  {!refundMature && (
                    <span style={{ opacity: 0.8 }}>
                      Disponible el {new Date(Number(escrow.refundLocktime) * 1000).toLocaleString()}
                    </span>
                  )}
                </div>
              )}
            </div>
          )}
          {vtxo && escrow && !refundMature && releaseDone === null && (
            <p className="panel-note" style={{ fontSize: "0.85em", opacity: 0.8 }}>
              Protección del vendedor: si el comprador no libera ni abre disputa, podrás reclamar el
              escrow el {new Date(Number(escrow.refundLocktime) * 1000).toLocaleString()}.
            </p>
          )}
        </>
      )}

      {!solverView && role === "buyer" && (
        <>
          <h3>Datos del comprador</h3>
          <p className="panel-note" style={{ fontSize: "0.85em" }}>
            Recibes en <code>{effectiveMyArk || "—"}</code>
            {effectiveMyArk ? "" : " (indícala para poder liberar el escrow)"}
          </p>
          {!effectiveMyArk && (
            <input
              placeholder="mi dirección Ark de cobro"
              value={myArk}
              onChange={(e) => setMyArk(e.target.value)}
            />
          )}
          {pendingRelease && (
            <div
              className="panel-note"
              style={{
                marginTop: 12,
                padding: "10px 12px",
                border: "1px solid rgba(245, 158, 11, 0.6)",
                borderRadius: 8,
                background: "rgba(245, 158, 11, 0.12)",
              }}
            >
              <div style={{ fontWeight: 600, marginBottom: 6 }}>
                Propuesta de liberación del vendedor
              </div>
              <div style={{ fontSize: "0.9em", display: "flex", flexDirection: "column", gap: 4 }}>
                <div>
                  <strong>Sats a recibir:</strong> {pendingRelease.payload.sats ?? agreement?.tradeSats ?? "—"} sats
                </div>
                <div>
                  <strong>Destino propuesto:</strong>{" "}
                  <code style={{ wordBreak: "break-all" }}>{pendingRelease.payload.to || "—"}</code>
                </div>
                <div>
                  <strong>Tu dirección Ark:</strong>{" "}
                  <code style={{ wordBreak: "break-all" }}>{effectiveMyArk || "—"}</code>
                </div>
                {pendingRelease.payload.to &&
                  effectiveMyArk &&
                  pendingRelease.payload.to.trim().toLowerCase() !== effectiveMyArk.trim().toLowerCase() && (
                    <div style={{ color: "#f59e0b", fontWeight: 600 }}>
                      ¡Atención! La dirección propuesta NO coincide con tu dirección Ark. Revisa antes de firmar.
                    </div>
                  )}
                {pendingRelease.payload.to &&
                  effectiveMyArk &&
                  pendingRelease.payload.to.trim().toLowerCase() === effectiveMyArk.trim().toLowerCase() && (
                    <div style={{ color: "#22c55e" }}>La dirección propuesta coincide con tu dirección Ark.</div>
                  )}
              </div>
            </div>
          )}
          <div style={{ marginTop: 8, display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button type="button" disabled={busy || !canSend} onClick={handleFiatSent}>
              Avisar pago fiat
            </button>
            <button type="button" disabled={busy || !escrow} onClick={() => checkFunding(false)}>
              Comprobar fondeo
            </button>
            <button
              type="button"
              disabled={
                busy ||
                !pendingRelease ||
                !escrow ||
                !vtxo ||
                fundingExact === false ||
                !escrowSpendable
              }
              onClick={handleReleaseNow}
            >
              Verificar, firmar y liberar
            </button>
          </div>
        </>
      )}

      {!solverView && (
        <>
          <h3>Métodos de pago</h3>
          <p className="panel-note" style={{ fontSize: "0.85em", opacity: 0.9 }}>
            {payMethods
              ? `Métodos anunciados en la oferta: ${payMethods}.`
              : "La oferta no anuncia métodos de pago."}{" "}
            Los datos concretos (cuenta, teléfono, correo) se coordinan en el{" "}
            <strong>chat privado</strong> con la contraparte: la app no los maneja ni los guarda.
          </p>
          {onOpenChat && effectiveOrderId && (
            <button
              type="button"
              style={{ marginTop: 8 }}
              disabled={busy}
              onClick={() => onOpenChat(effectiveOrderId)}
            >
              Abrir chat con la contraparte
            </button>
          )}
        </>
      )}

      <h3>Disputa y arbitraje</h3>
      {!isSolver && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, maxWidth: 520 }}>
          <input
            placeholder="motivo de la disputa"
            value={disputeReason}
            onChange={(e) => setDisputeReason(e.target.value)}
          />
          <div>
            <button
              type="button"
              disabled={
                busy ||
                !identity ||
                !agreement ||
                agreement.arbiterPubKeys.length === 0 ||
                !escrowSpendable
              }
              onClick={handleOpenDispute}
            >
              Abrir disputa (a los solvers)
            </button>
          </div>
        </div>
      )}
      {isSolver && disputeMsg && (
        <div style={{ padding: 8, border: "1px solid #8884", borderRadius: 8 }}>
          <div>
            <strong>Disputa</strong> de {peer(disputeMsg.from)}: {disputeMsg.payload.reason}
          </div>
          <div style={{ fontSize: "0.85em", opacity: 0.8 }}>
            {disputeMsg.payload.agreement.tradeSats.toLocaleString()} sats ·{" "}
            {disputeMsg.payload.agreement.fiatAmount.toLocaleString()}{" "}
            {disputeMsg.payload.agreement.fiat} · orden {effectiveOrderId.slice(0, 8)}…
          </div>
          {solverDeadline > 0 && (
            <div
              style={{
                margin: "6px 0",
                padding: "6px 8px",
                borderRadius: 6,
                fontSize: "0.9em",
                background: deadlineNear ? "#fef3c7" : "#eff6ff",
                color: deadlineNear ? "#92400e" : "#1e3a8a",
              }}
            >
              {solverSecondsLeft <= 0 ? (
                <>
                  El plazo de reembolso del escrow <strong>ya maduró</strong>: el vendedor puede
                  recuperar los sats por su hoja de refund. Si las pruebas favorecen al comprador,
                  actúa ya o el comprador perderá sus fondos.
                </>
              ) : (
                <>
                  Tiempo antes de que el vendedor pueda recuperar el escrow por su locktime:{" "}
                  <strong>{formatCountdown(solverSecondsLeft)}</strong>. Con pruebas suficientes de
                  que el comprador pagó, <strong>no esperes</strong> al vendedor: paga al comprador
                  por tu hoja de árbitro antes de que venza.
                </>
              )}
            </div>
          )}
          <div style={{ fontSize: "0.85em", opacity: 0.8 }}>
            anuncio público:{" "}
            {announceForOrder ? (
              <span style={{ color: "#15803d" }}>visto (abierto por {peer(announceForOrder.initiator)})</span>
            ) : (
              <span>esperando propagación…</span>
            )}
          </div>
          <div style={{ fontSize: "0.85em", margin: "4px 0" }}>
            {takenByOther && (
              <span style={{ color: "#b45309" }}>
                Tomada por otro solver ({takeTaker ? peer(takeTaker.solverPubKey) : "—"}); tú puedes observar
                pero no resolver.
              </span>
            )}
            {holdsTake && !takenByOther && (
              <span style={{ color: "#15803d", fontWeight: 700 }}>
                La estás resolviendo tú ({identity ? peer(identity.pubkeyHex) : "—"}).
              </span>
            )}
          </div>
          {canTakeDispute && (
            <button
              type="button"
              disabled={busy}
              onClick={handleTakeDispute}
              style={{ marginBottom: 8 }}
            >
              Tomar disputa (publicar take)
            </button>
          )}
          {holdsTake && !takenByOther && (!authBuyerAddr || !authSellerAddr) && (
            <button
              type="button"
              disabled={busy || !identity || !agreement}
              onClick={handleRequestAddresses}
              style={{ marginBottom: 8, marginLeft: 8 }}
              title="Pide a las partes su dirección Ark autenticada para poder pagarles"
            >
              Pedir direcciones Ark a las partes
            </button>
          )}
          <div style={{ fontSize: "0.85em", opacity: 0.8 }}>
            comprador →{" "}
            {authBuyerAddr ? (
              <span style={{ color: "#15803d", fontWeight: 700 }}>
                verificada {authBuyerAddr.slice(0, 16)}…
              </span>
            ) : (
              <span style={{ color: "crimson" }}>
                sin verificar (reclama {disputeMsg.payload.buyerArkAddress.slice(0, 16)}…)
              </span>
            )}
          </div>
          <div style={{ fontSize: "0.85em", opacity: 0.8 }}>
            vendedor →{" "}
            {authSellerAddr ? (
              <span style={{ color: "#15803d", fontWeight: 700 }}>
                verificada {authSellerAddr.slice(0, 16)}…
              </span>
            ) : (
              <span style={{ color: "crimson" }}>
                sin verificar (reclama {disputeMsg.payload.sellerArkAddress.slice(0, 16)}…)
              </span>
            )}
          </div>
          {holdsTake && !takenByOther ? (
            <div style={{ marginTop: 8, display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button
                type="button"
                className={deadlineNear && authBuyerAddr ? "btn btn-primary" : undefined}
                style={
                  deadlineNear && authBuyerAddr
                    ? { fontWeight: 700, outline: "2px solid #dc2626" }
                    : undefined
                }
                disabled={busy || !ctx || !authBuyerAddr}
                title={authBuyerAddr ? undefined : "Falta la dirección autenticada del comprador"}
                onClick={() => handleArbiterDecide("release_to_buyer")}
              >
                Resolver: pagar al comprador
              </button>
              <button
                type="button"
                disabled={busy || !ctx || !authSellerAddr}
                title={authSellerAddr ? undefined : "Falta la dirección autenticada del vendedor"}
                onClick={() => handleArbiterDecide("refund_to_seller")}
              >
                Resolver: reembolsar al vendedor
              </button>
            </div>
          ) : (
            <p style={{ fontSize: "0.85em", opacity: 0.7, marginTop: 8 }}>
              {takenByOther
                ? "La resolución está en manos del solver que tomó la disputa."
                : "Toma la disputa para poder resolverla."}
            </p>
          )}
        </div>
      )}
      {!isSolver && incomingArkRequest && agreement && (
        <section className="panel" style={{ border: "1px solid var(--accent)", background: "rgba(255,200,0,0.08)" }}>
          <h3>El solver solicita tu dirección Ark</h3>
          <p className="muted">Para poder resolver la disputa, envía tu dirección Ark autenticada al solver.</p>
          <div className="actions">
            <button className="btn btn-buy" onClick={handleSendArkAddressToSolver} disabled={busy || !myArk.trim()}>
              Enviar dirección Ark al solver
            </button>
            <button className="btn btn-ghost" onClick={() => onOpenChat?.(disputeTakenMsg?.payload?.solverPubKey || (disputeMsg?.payload as any)?.solverPubKey || agreement.arbiterPubKeys?.[0] || "")}>
              Abrir chat con el solver
            </button>
          </div>
        </section>
      )}
      {isSolver && !disputeMsg && <p>Sin disputas entrantes.</p>}
      {disputeTakenMsg && disputeTakenMsg.payload.solverPubKey.toLowerCase() !== (identity?.pubkeyHex.toLowerCase() ?? "") && (
        <p style={{ color: "#b45309", fontSize: "0.9em" }}>
          Disputa tomada por el solver {disputeTakenMsg.payload.solverPubKey.slice(0, 16)}… —
          escríbele por DM para aportar tus pruebas.
        </p>
      )}
      {arbiterDecision && (
        <p style={{ color: "#2563eb" }}>
          Resolución del solver:{" "}
          {arbiterDecision.payload.outcome === "release_to_buyer"
            ? "pagado al comprador"
            : "reembolsado al vendedor"}{" "}
          ({arbiterDecision.payload.arkTxid.slice(0, 16)}…)
        </p>
      )}

      <h3>Cancelar operación (cooperativa)</h3>
      <p style={{ fontSize: "0.85em" }}>
        La cancelación requiere el acuerdo de <strong>ambas partes</strong>: ninguno puede
        cancelar por su cuenta (por ejemplo, el vendedor no puede cancelar tras recibir el pago
        fiat si el comprador no acepta).
      </p>
      {cancelAgreed ? (
        <p style={{ color: "crimson", fontWeight: 700 }}>
          Operación cancelada por acuerdo mutuo. Si el escrow ya estaba fondeado, los sats siguen
          bloqueados: usa la disputa al árbitro para recuperarlos.
        </p>
      ) : (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button
            type="button"
            disabled={busy || !canSend || cancelWaitingOnThem}
            onClick={handleCancelRequest}
          >
            {cancelWaitingOnThem ? "Cancelación propuesta (esperando al otro)" : "Proponer cancelación"}
          </button>
          {cancelPendingFromThem && (
            <button
              type="button"
              style={{ color: "crimson", fontWeight: 700 }}
              disabled={busy || !canSend}
              onClick={handleCancelAgree}
            >
              Aceptar cancelación
            </button>
          )}
          {cancelPendingFromThem && (
            <p style={{ color: "#b45309", fontSize: "0.9em" }}>
              La contraparte propone cancelar. Si aceptas, la operación se cancela.
            </p>
          )}
        </div>
      )}

      {(agreement || escrow) && (
        <>
          <h3>Escrow</h3>
          <div style={{ display: "flex", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
            {role === "seller" && (escrow?.address ?? agreedAddress) && (
              <div style={{ background: "#fff", padding: 8, borderRadius: 8 }}>
                <QRCodeSVG
              value={escrow?.address ?? agreedAddress}
              size={148}
              level="M"
              bgColor="#ffffff"
              fgColor="#000000"
            />
              </div>
            )}
            <dl style={{ margin: 0 }}>
            <dt>Dirección</dt>
            <dd style={{ wordBreak: "break-all" }}>
              {escrow?.address ?? agreedAddress}
              {((agreement?.tradeSats ?? (Number(tradeSats) || 0)) > 0) && (
                <> (monto: {Math.round(agreement?.tradeSats ?? (Number(tradeSats) || 0))} sats)</>
              )}
            </dd>
            {agreement && (
              <>
                <dt>Acuerdo</dt>
                <dd>
                  {agreement.tradeSats} sats por {agreement.fiatAmount} {agreement.fiat}
                </dd>
              </>
            )}
            <dt>Fondeo</dt>
            <dd style={fundingExact === false ? { color: "crimson", fontWeight: 700 } : undefined}>
              {vtxo
                ? `${vtxo.value} sats (${vtxo.txid.slice(0, 12)}…:${vtxo.vout})`
                : agreement
                  ? "buscando el fondeo automáticamente…"
                  : "sin VTXO detectado"}
              {fundingExact === false && expectedSats !== null && (
                <> — ¡incorrecto! Debe ser exactamente {expectedSats} sats.</>
              )}
            </dd>
            </dl>
          </div>
          {agreement && escrow && agreedAddress && escrow.address !== agreedAddress && (
            <p style={{ color: "crimson" }}>
              ¡El escrow derivado no coincide con la dirección acordada!
            </p>
          )}
          {fundingExact === false && (
            <p style={{ color: "crimson", fontWeight: 700 }}>
              Fondeo incorrecto: el escrow tiene {fundedSats} sats pero el acuerdo es{" "}
              {expectedSats} sats. El vendedor debe enviar exactamente el monto acordado; enviar
              de más hace perder el exceso y enviar de menos impide liberar.
            </p>
          )}
          {role === "seller" && !vtxo && (
            <p style={{ fontSize: "0.85em", color: "#b45309" }}>
              Para fondear: abre tu billetera Ark (esta app no custodia fondos), envía{" "}
              <strong>exactamente</strong>{" "}
              {agreement ? agreement.tradeSats : tradeSats || "—"} sats a la dirección de arriba. El
              cliente <strong>detecta el fondeo solo</strong> y avisa al comprador; «Comprobar fondeo
              y avisar» queda como respaldo. Enviar otra cantidad hace perder los fondos: el exceso
              se pierde en comisiones y la falta impide liberar. El escrow son tus sats; el
              comprador no deposita, solo paga el fiat.
            </p>
          )}
        </>
      )}

      <h3>Mensajes</h3>
      {relevant.length === 0 && <p>Sin mensajes todavía.</p>}
      <ul style={{ paddingLeft: 16 }}>
        {relevant.map(({ dm, msg }) => (
          <li key={dm.id} style={{ color: dm.outgoing ? "#2563eb" : "inherit" }}>
            <small>
              {dm.outgoing ? "→" : "←"} {peer(dm.sender)}{" "}
              {new Date(dm.createdAt * 1000).toLocaleTimeString()}
            </small>{" "}
            {msg ? summarize(msg) : <em>texto libre</em>}
          </li>
        ))}
      </ul>

      {status && !releaseDone && <p style={{ color: "green" }}>{status}</p>}
      {error && <p style={{ color: "crimson" }}>Error: {error}</p>}
    </section>
  );
}
