import { useEffect, useMemo, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { hex } from "@scure/base";
import type { VirtualCoin } from "@arkade-os/sdk";
import type { ArkContext } from "../lib/arkade";
import { pubkeyFromInput, type Identity } from "../lib/identity";
import { arbiterPubKey, coordinatorPubKey } from "../lib/config";
import type { NostrClient } from "../lib/nostr";
import {
  assertFunded,
  buildEscrow,
  buildSpend,
  coSignSpend,
  EscrowPath,
  findEscrowVtxo,
  mergeSpends,
  outputToArkAddress,
  signSpend,
  submitSpend,
  verifyArbiterSpend,
  verifyReleaseSpend,
  type Escrow,
} from "../lib/escrow";
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
import { sendDm } from "../lib/dm";
import { summarize } from "../lib/summary";
import {
  buildDisputeAnnounceTemplate,
  buildDisputeTakeTemplate,
  buildDisputeResolutionTemplate,
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
  /** Buyer's receive address (set when a buyer takes a sell order). */
  buyerArkAddress?: string;
  /** Seller's refund address, taken from the maker's order (sell orders). */
  refundAddress?: string;
}

interface Props {
  identity: Identity | null;
  ctx: ArkContext | null;
  client: NostrClient;
  request?: TradeRequest | null;
  feed: TradeDm[];
  /** Public dispute announcements (kind 38386). */
  disputeAnnounces?: DisputeAnnounce[];
  /** Public dispute takes (kind 38387), including competing takes. */
  disputeTakes?: DisputeTake[];
}

/**
 * Newest incoming `take` (a buyer took one of our sell orders). A take is only
 * ever sent to the maker, so as the seller it targets our order and lets us
 * prefill the order id and counterparty automatically.
 */
function findActiveTake(
  feed: TradeDm[],
): { orderId: string; from: string; buyerArkAddress: string } | null {
  for (let i = feed.length - 1; i >= 0; i--) {
    const entry = feed[i];
    if (entry.msg && entry.msg.type === "take" && !entry.dm.outgoing) {
      return {
        orderId: entry.msg.orderId,
        from: entry.dm.sender,
        buyerArkAddress: entry.msg.payload.buyerArkAddress,
      };
    }
  }
  return null;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
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
}: Props) {
  const [role, setRole] = useState<TradeRole>(request?.role ?? "seller");
  const [orderId, setOrderId] = useState(request?.orderId ?? "");
  const [counterparty, setCounterparty] = useState(request?.counterparty ?? "");

  const [tradeSats, setTradeSats] = useState(
    request?.tradeSats !== undefined ? String(request.tradeSats) : "",
  );
  const [fiatAmount, setFiatAmount] = useState(
    request?.fiatAmount !== undefined ? String(request.fiatAmount) : "",
  );
  const [fiat, setFiat] = useState(request?.fiat ?? "USD");

  const [myArk, setMyArk] = useState(
    request?.role === "seller"
      ? (request?.refundAddress ?? "")
      : (request?.buyerArkAddress ?? ""),
  );
  const [payMethods, setPayMethods] = useState((request?.paymentMethods ?? []).join(", "));
  const [payDetails, setPayDetails] = useState("");
  const [disputeReason, setDisputeReason] = useState("");

  const [localVtxo, setLocalVtxo] = useState<VirtualCoin | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  // Guards the one-shot automatic "funded" notice the seller sends.
  const announcedRef = useRef(false);
  // Guards the one-shot "ark_address" claim each party sends to the solvers.
  const claimedRef = useRef(false);
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

  const activeTake = role === "seller" ? findActiveTake(feed) : null;
  // Only solvers receive dispute DMs, so an incoming one means we are a solver.
  const activeDispute = findActiveDispute(feed);

  const effectiveOrderId = orderId.trim() || activeTake?.orderId || activeDispute?.orderId || "";
  const effectiveCounterparty = counterparty.trim() || activeTake?.from || "";

  let cpPub: string | null = null;
  try {
    cpPub = pubkeyFromInput(effectiveCounterparty);
  } catch {
    cpPub = null;
  }

  const relevant = feed
    .filter(({ dm, msg }) => {
      if (!msg) return false;
      if (effectiveOrderId && msg.orderId !== effectiveOrderId) return false;
      if (cpPub) {
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

  const takeMsg = lastOf("take");
  // A take is already on the wire if we (as buyer) already had an address when
  // the panel opened (book-initiated) or it appears in the feed. Prevents the
  // double-take where both the order book and this button publish one.
  const takeSent = !!takeMsg || !!request?.buyerArkAddress;
  const escrowMsg = lastOf("escrow");
  const disputeMsg = lastOf("dispute");
  // The agreement normally comes from our counterparty's `escrow` DM; a solver
  // outside the trade only receives it inside an incoming `dispute` DM.
  const agreement = escrowMsg?.payload.agreement ?? disputeMsg?.payload.agreement ?? null;
  const agreedAddress = escrowMsg?.payload.address ?? "";
  const agreedRefundAddress = escrowMsg?.payload.refundAddress ?? "";
  const buyerArk = lastOf("take")?.payload.buyerArkAddress ?? request?.buyerArkAddress ?? "";
  const pendingRelease = lastOf("release_request");
  const paymentDetails = lastOf("payment_details");
  const fundedMsg = lastOf("funded");
  const arbiterDecision = lastOf("arbiter_decision");
  const disputeTakenMsg = lastOf("dispute_taken");
  const releaseDone = lastOf("release_done");

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

  // The release spend pays the buyer exactly `tradeSats` and has no change back
  // to the escrow, so any excess funded is lost. Funding must match exactly.
  const expectedSats = agreement?.tradeSats ?? (Number(tradeSats) > 0 ? Number(tradeSats) : null);
  const fundedSats = vtxo ? Number(vtxo.value) : null;
  const fundingExact =
    fundedSats !== null && expectedSats !== null ? fundedSats === expectedSats : null;

  const escrow: Escrow | null =
    agreement && ctx
      ? buildEscrow(
          {
            buyerPubKey: hex.decode(agreement.buyerPubKey),
            sellerPubKey: hex.decode(agreement.sellerPubKey),
            arbiterPubKeys: agreement.arbiterPubKeys.map((x: string) => hex.decode(x)),
            serverPubKey: hex.decode(agreement.serverPubKey),
          },
          ctx.network,
        )
      : null;

  // Auto-check funding: poll the indexer for the escrow VTXO so neither side
  // has to press "Comprobar fondeo". The query is public (no keys involved).
  useEffect(() => {
    if (!ctx || !agreement || fundingKnown) return;
    let cancelled = false;
    const esc = buildEscrow(
      {
        buyerPubKey: hex.decode(agreement.buyerPubKey),
        sellerPubKey: hex.decode(agreement.sellerPubKey),
        arbiterPubKeys: agreement.arbiterPubKeys.map((x: string) => hex.decode(x)),
        serverPubKey: hex.decode(agreement.serverPubKey),
      },
      ctx.network,
    );
    const poll = () => {
      findEscrowVtxo(ctx.indexer, esc)
        .then((found) => {
          if (cancelled || !found) return;
          setLocalVtxo(found);
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

  // Advertise our own Ark payout address to every solver in the escrow's
  // solver set (once), so arbitration never depends on the addresses embedded
  // in a dispute payload. Each solver authenticates the claim by the sender key.
  useEffect(() => {
    if (claimedRef.current || !escrowMsg || !identity || !effectiveOrderId) return;
    const addr = myArk.trim();
    if (!addr) return;
    const agr = escrowMsg.payload.agreement;
    const recipients = new Set(agr.arbiterPubKeys.map((p) => p.toLowerCase()));
    if (arbiter) recipients.add(arbiter.toLowerCase());
    recipients.delete(identity.pubkeyHex.toLowerCase());
    if (recipients.size === 0) return;
    claimedRef.current = true;
    const msg: TradeMessageOf<"ark_address"> = {
      app: TRADE_APP,
      v: TRADE_VERSION,
      type: "ark_address",
      orderId: effectiveOrderId,
      role,
      from: identity.pubkeyHex,
      ts: nowSeconds(),
      payload: { agreement: agr, arkAddress: addr },
    };
    const encoded = encodeTradeMessage(msg);
    Promise.all(
      [...recipients].map((r) => sendDm(client.pool, client.relays, identity, r, encoded)),
    ).catch(() => {
      claimedRef.current = false;
    });
  }, [escrowMsg, arbiter, identity, effectiveOrderId, myArk, role, client]);

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

  function handleSendTake() {
    if (!myArk.trim()) throw new Error("indica tu dirección Ark de cobro");
    run(async () => {
      await send("take", { buyerArkAddress: myArk.trim() });
      setStatus("Toma enviada al vendedor.");
    });
  }

  function handleSendPaymentDetails() {
    run(async () => {
      await send("payment_details", {
        methods: payMethods.split(",").map((m) => m.trim()).filter(Boolean),
        details: payDetails.trim(),
      });
      setStatus("Datos de pago enviados al comprador.");
    });
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

  function handleBuildAgreement() {
    if (!identity || !ctx) throw new Error("falta identidad o ASP");
    if (!cpPub) throw new Error("contraparte inválida (npub o hex)");
    if (!myArk.trim()) throw new Error("indica tu dirección Ark para reembolsos");
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
      const agr: EscrowAgreement = {
        orderId: effectiveOrderId,
        fiat: fiat.trim().toUpperCase(),
        fiatAmount: Number(fiatAmount),
        tradeSats: Number(tradeSats),
        buyerPubKey: cpPub,
        sellerPubKey: identity.pubkeyHex,
        arbiterPubKeys: solverSet,
        serverPubKey: hex.encode(ctx.serverPubKey),
      };
      const built = buildEscrow(
        {
          buyerPubKey: hex.decode(agr.buyerPubKey),
          sellerPubKey: hex.decode(agr.sellerPubKey),
          arbiterPubKeys: agr.arbiterPubKeys.map((x: string) => hex.decode(x)),
          serverPubKey: hex.decode(agr.serverPubKey),
        },
        ctx.network,
      );
      await send("escrow", {
        agreement: agr,
        address: built.address,
        refundAddress: myArk.trim(),
      });
      // Advertise our payout address to every solver so disputes never rely on
      // the addresses a disputant claims on the counterparty's behalf.
      claimedRef.current = true;
      void Promise.allSettled(
        solverSet.map((solver) => sendTo(solver, "ark_address", { agreement: agr, arkAddress: myArk.trim() })),
      ).catch(() => undefined);
      setStatus(`Escrow acordado con ${solverSet.length} solver(s). Dirección a fondear: ${built.address}`);
    });
  }

  function checkFunding(announce: boolean) {
    if (!ctx || !escrow) throw new Error("aún no hay escrow acordado");
    run(async () => {
      const found = await findEscrowVtxo(ctx.indexer, escrow);
      setLocalVtxo(found);
      if (!found) throw new Error("el escrow aún no tiene fondos");
      const expected = agreement?.tradeSats ?? null;
      if (expected !== null && Number(found.value) !== expected) {
        throw new Error(
          `fondeo incorrecto: el escrow tiene ${found.value} sats pero el acuerdo es ${expected} sats; el vendedor debe enviar exactamente el monto acordado`,
        );
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
    if (fundingExact === false) {
      throw new Error(
        `el escrow está fondeado con ${fundedSats} sats pero el acuerdo es ${agreement.tradeSats} sats; debe enviarse exactamente el monto acordado`,
      );
    }
    const dest = buyerArk.trim();
    if (!dest) throw new Error("falta la dirección Ark del comprador (aún no envió 'take')");
    run(async () => {
      const outputs = [outputToArkAddress(dest, BigInt(agreement.tradeSats))];
      const partial = buildSpend(ctx.info, escrow, vtxo, EscrowPath.Release, outputs);
      const signed = await signSpend(partial, identity);
      await send("release_request", { spend: signed, to: dest, sats: agreement.tradeSats });
      setStatus("Petición de liberación enviada; espera la co-firma del comprador.");
    });
  }

  function handleReleaseNow() {
    if (!identity || !ctx) throw new Error("falta identidad o ASP");
    if (!escrow || !vtxo || !agreement || !pendingRelease) throw new Error("faltan datos para liberar");
    if (fundingExact === false) {
      throw new Error(
        `el escrow está fondeado con ${fundedSats} sats pero el acuerdo es ${agreement.tradeSats} sats; no se puede liberar hasta que el fondeo coincida exactamente`,
      );
    }
    const spend = pendingRelease.payload.spend;
    const dest = pendingRelease.payload.to;
    if (dest !== myArk.trim()) {
      throw new Error("la liberación no paga a la dirección Ark indicada");
    }
    run(async () => {
      verifyReleaseSpend(escrow, vtxo, { destination: dest, sats: agreement.tradeSats }, spend);
      const coSigned = await coSignSpend(spend, identity);
      const both = mergeSpends(spend, coSigned);
      const arkTxid = await submitSpend(ctx.ark, both);
      await send("release_done", { arkTxid });
      setStatus(`Operación completada: liberación enviada al servidor (${arkTxid}).`);
    });
  }

  /** Buyer or seller escalates to every solver in the escrow's solver set. */
  function handleOpenDispute() {
    if (!identity) throw new Error("sin identidad");
    if (!agreement) throw new Error("aún no hay acuerdo de escrow");
    const buyerAddress = role === "buyer" ? myArk.trim() : buyerArk.trim();
    const sellerAddress = role === "seller" ? myArk.trim() : agreedRefundAddress;
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
   * The Ark payout address a party confirmed to the arbiter via an
   * authenticated `ark_address` DM. Returns null when no matching claim has
   * arrived, in which case the arbiter must not pay that party.
   */
  function authenticatedAddress(partyRole: TradeRole): string | null {
    const agr = disputeMsg?.payload.agreement;
    if (!agr) return null;
    const pub = (partyRole === "buyer" ? agr.buyerPubKey : agr.sellerPubKey).toLowerCase();
    const claim = relevant.find(
      (e) =>
        e.msg?.type === "ark_address" &&
        !e.dm.outgoing &&
        e.msg.from.toLowerCase() === pub,
    );
    if (!claim || !claim.msg || claim.msg.type !== "ark_address") return null;
    const a = claim.msg.payload.agreement;
    if (a.buyerPubKey !== agr.buyerPubKey || a.sellerPubKey !== agr.sellerPubKey) return null;
    return claim.msg.payload.arkAddress.trim() || null;
  }

  /** A solver resolves the dispute by spending the escrow via their leaf. */
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
        `no tengo la dirección Ark autenticada del ${winner === "buyer" ? "comprador" : "vendedor"}; debe enviarla al solver (se envía sola al acordar el escrow)`,
      );
    }
    run(async () => {
      const esc = buildEscrow(
        {
          buyerPubKey: hex.decode(p.agreement.buyerPubKey),
          sellerPubKey: hex.decode(p.agreement.sellerPubKey),
          arbiterPubKeys: p.agreement.arbiterPubKeys.map((x: string) => hex.decode(x)),
          serverPubKey: hex.decode(p.agreement.serverPubKey),
        },
        ctx.network,
      );
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

      {releaseDone && (
        <p style={{ color: "green", fontWeight: 700 }}>
          Operación completada: se liberaron {agreement?.tradeSats ?? "—"} sats al comprador (ark
          tx {releaseDone.payload.arkTxid.slice(0, 16)}…).
        </p>
      )}

      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <label>
          Rol{" "}
          <select value={role} onChange={(e) => setRole(e.target.value as TradeRole)}>
            <option value="seller">Vendedor</option>
            <option value="buyer">Comprador</option>
          </select>
        </label>
        <input
          placeholder="order id (d)"
          value={effectiveOrderId}
          onChange={(e) => setOrderId(e.target.value)}
        />
        <input
          placeholder="contraparte npub o hex"
          value={effectiveCounterparty}
          onChange={(e) => setCounterparty(e.target.value)}
          style={{ width: 320 }}
        />
        {arbiter && (
          <span style={{ fontSize: "0.8em", opacity: 0.7 }}>
            árbitro configurado: {arbiter.slice(0, 12)}…
          </span>
        )}
      </div>

      {activeTake && !counterparty.trim() && (
        <p style={{ fontSize: "0.85em", color: "#2563eb" }}>
          Orden tomada por {activeTake.from.slice(0, 12)}… — order id y contraparte prellenados.
          {activeTake.buyerArkAddress
            ? ` Comprador recibe en ${activeTake.buyerArkAddress.slice(0, 16)}…`
            : ""}
        </p>
      )}

      {role === "seller" && (
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
            <input
              placeholder="mi dirección Ark (reembolsos)"
              value={myArk}
              onChange={(e) => setMyArk(e.target.value)}
            />
          </div>
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
              disabled={busy || !vtxo || !buyerArk || fundingExact === false}
              onClick={handleReleaseRequest}
            >
              Solicitar liberación (firmar y enviar)
            </button>
          </div>

          <h3>Datos de pago (los recibe el comprador)</h3>
          <div style={{ display: "flex", flexDirection: "column", gap: 6, maxWidth: 520 }}>
            <input
              placeholder="métodos de pago (coma-separados)"
              value={payMethods}
              onChange={(e) => setPayMethods(e.target.value)}
            />
            <input
              placeholder="datos concretos (teléfono, cuenta, titular…)"
              value={payDetails}
              onChange={(e) => setPayDetails(e.target.value)}
            />
          </div>
          <button
            type="button"
            style={{ marginTop: 8 }}
            disabled={busy || !canSend}
            onClick={handleSendPaymentDetails}
          >
            Enviar datos de pago
          </button>
        </>
      )}

      {role === "buyer" && (
        <>
          <h3>Datos del comprador</h3>
          <div style={{ display: "flex", flexDirection: "column", gap: 6, maxWidth: 520 }}>
            <input
              placeholder="mi dirección Ark de cobro"
              value={myArk}
              onChange={(e) => setMyArk(e.target.value)}
            />
          </div>
          <div style={{ marginTop: 8, display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              type="button"
              disabled={busy || !canSend || !myArk.trim() || takeSent}
              onClick={handleSendTake}
            >
              {takeSent ? "Toma enviada" : "Enviar toma (take)"}
            </button>
            <button type="button" disabled={busy || !canSend} onClick={handleFiatSent}>
              Avisar pago fiat
            </button>
            <button type="button" disabled={busy || !escrow} onClick={() => checkFunding(false)}>
              Comprobar fondeo
            </button>
            <button
              type="button"
              disabled={busy || !pendingRelease || !escrow || !vtxo || fundingExact === false}
              onClick={handleReleaseNow}
            >
              Verificar, firmar y liberar
            </button>
          </div>
          {paymentDetails && (
            <div style={{ marginTop: 8, padding: 8, border: "1px solid #8884", borderRadius: 8 }}>
              <strong>Datos de pago del vendedor</strong>
              <div>{paymentDetails.payload.methods.join(", ")}</div>
              <div style={{ whiteSpace: "pre-wrap" }}>{paymentDetails.payload.details}</div>
            </div>
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
              disabled={busy || !identity || !agreement || agreement.arbiterPubKeys.length === 0}
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
            <strong>Disputa</strong> de {disputeMsg.from.slice(0, 12)}…: {disputeMsg.payload.reason}
          </div>
          <div style={{ fontSize: "0.85em", opacity: 0.8 }}>
            anuncio público:{" "}
            {announceForOrder ? (
              <span style={{ color: "#15803d" }}>visto (abierto por {announceForOrder.initiator.slice(0, 12)}…)</span>
            ) : (
              <span>esperando propagación…</span>
            )}
          </div>
          <div style={{ fontSize: "0.85em", margin: "4px 0" }}>
            {takenByOther && (
              <span style={{ color: "#b45309" }}>
                Tomada por otro solver ({takeTaker?.solverPubKey.slice(0, 12)}…); tú puedes observar
                pero no resolver.
              </span>
            )}
            {holdsTake && !takenByOther && (
              <span style={{ color: "#15803d", fontWeight: 700 }}>
                La estás resolviendo tú ({identity?.pubkeyHex.slice(0, 12)}…).
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
              {dm.outgoing ? "→" : "←"} {dm.sender.slice(0, 10)}…{" "}
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
