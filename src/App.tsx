import { useCallback, useEffect, useState } from "react";
import "./App.css";
import { connectArkade, type ArkContext } from "./lib/arkade";
import { generateIdentity, identityFromInput, type Identity } from "./lib/identity";
import { loadOrCreateIdentity, saveIdentity } from "./lib/storage";
import { NostrClient } from "./lib/nostr";
import { sendDm, subscribeDms } from "./lib/dm";
import {
  decodeTradeMessage,
  encodeTradeMessage,
  TRADE_APP,
  TRADE_VERSION,
  type TradeDm,
  type TradeMessageOf,
  type TradeRole,
} from "./lib/trade";
import type { Order } from "./lib/protocol";
import { isFinished, loadOperations, recordOperation, type OperationRecord } from "./lib/operations";
import { RatesPanel } from "./components/RatesPanel";
import { OrderForm } from "./components/OrderForm";
import { OrderBook } from "./components/OrderBook";
import { EscrowHarness } from "./components/EscrowHarness";
import { HistoryPanel } from "./components/HistoryPanel";
import { TradePanel, type TradeRequest } from "./components/TradePanel";

type Tab = "account" | "rates" | "orders" | "trade" | "history" | "escrow";
type AspStatus = "connecting" | "ready" | "error";

let sharedClient: NostrClient | null = null;
function nostrClient(): NostrClient {
  if (sharedClient === null) sharedClient = new NostrClient();
  return sharedClient;
}

function takerRole(order: Order): TradeRole {
  return order.type === "sell" ? "buyer" : "seller";
}

export default function App() {
  const [tab, setTab] = useState<Tab>("account");
  const [identity, setIdentity] = useState<Identity>(loadOrCreateIdentity);
  const [keyInput, setKeyInput] = useState("");
  const [ctx, setCtx] = useState<ArkContext | null>(null);
  const [aspStatus, setAspStatus] = useState<AspStatus>("connecting");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [feed, setFeed] = useState<TradeDm[]>([]);
  const [tradeRequest, setTradeRequest] = useState<TradeRequest | null>(null);
  const [operations, setOperations] = useState<OperationRecord[]>(() =>
    loadOperations(identity.pubkeyHex),
  );
  // Bumped after publishing an order so the book refetches immediately instead
  // of waiting for a relay push.
  const [ordersVersion, setOrdersVersion] = useState(0);

  const client = nostrClient();

  const record = useCallback(
    (orderId: string, patch: Partial<OperationRecord>) => {
      setOperations(recordOperation(identity.pubkeyHex, orderId, patch));
    },
    [identity.pubkeyHex],
  );

  // Auto-connect to the ASP on load. State is only updated from the promise
  // callbacks (never synchronously in the effect body) to keep renders sane.
  useEffect(() => {
    let cancelled = false;
    connectArkade()
      .then((context) => {
        if (cancelled) return;
        setCtx(context);
        setAspStatus("ready");
      })
      .catch(() => {
        if (!cancelled) setAspStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!identity) return;
    const subscription = subscribeDms(client.pool, client.relays, identity, {
      onMessage: (dm) => {
        const msg = decodeTradeMessage(dm.content);
        setFeed((prev) =>
          prev.some((entry) => entry.dm.id === dm.id) ? prev : [...prev, { dm, msg }],
        );
        if (!msg) return;
        // A `take` is only meaningful to its recipient (the maker); the taker
        // already opened their panel when they pressed "Tomar".
        if (msg.type === "take" && !dm.outgoing) {
          void client.setOrderStatus(identity, msg.orderId, "in-progress").catch(() => undefined);
          // We are the maker. The taker's role is in the message, so the maker
          // plays the opposite side without needing to fetch the order first.
          const makerRole: TradeRole = msg.role === "buyer" ? "seller" : "buyer";
          setTradeRequest({
            orderId: msg.orderId,
            counterparty: dm.sender,
            role: makerRole,
            buyerArkAddress: msg.payload.buyerArkAddress,
          });
          record(msg.orderId, {
            role: makerRole,
            counterparty: dm.sender,
            status: "in-progress",
          });
          // Best effort: enrich the panel and history with the order details.
          void client
            .fetchOrder(msg.orderId, identity.pubkeyHex)
            .then((order) => {
              if (!order) return;
              setTradeRequest((prev) =>
                prev && prev.orderId === msg.orderId
                  ? {
                      ...prev,
                      fiat: order.fiat,
                      fiatAmount: order.fiatAmount,
                      tradeSats: order.amountSats,
                      paymentMethods: order.paymentMethods,
                      refundAddress: order.arkRefundAddress,
                    }
                  : prev,
              );
              record(msg.orderId, {
                role: makerRole,
                counterparty: dm.sender,
                fiat: order.fiat,
                fiatAmount: order.fiatAmount,
                tradeSats: order.amountSats,
                status: "in-progress",
              });
            })
            .catch(() => undefined);
        }
        // Terminal states are recorded whichever side sends them, so both the
        // maker and the taker move the trade from Operación to Historial.
        if (msg.type === "release_done") {
          void client.setOrderStatus(identity, msg.orderId, "success").catch(() => undefined);
          record(msg.orderId, { status: "completed" });
        }
        if (msg.type === "cancel_agree") {
          // Cooperative cancellation: the counterparty accepted our request (or
          // we accepted theirs and this is the echo). Both sides have agreed, so
          // the order can finally be marked as canceled.
          void client.setOrderStatus(identity, msg.orderId, "canceled").catch(() => undefined);
          record(msg.orderId, { status: "canceled" });
        }
        if (msg.type === "arbiter_decision") {
          const status = msg.payload.outcome === "release_to_buyer" ? "success" : "canceled";
          void client.setOrderStatus(identity, msg.orderId, status).catch(() => undefined);
          record(msg.orderId, {
            status:
              msg.payload.outcome === "release_to_buyer" ? "arbiter-release" : "arbiter-refund",
          });
        }
      },
    });
    return () => subscription.close();
  }, [identity, client, record]);

  function run<T>(fn: () => Promise<T>) {
    setBusy(true);
    setError("");
    fn()
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  }

  function reconnectAsp() {
    setAspStatus("connecting");
    setCtx(null);
    setError("");
    connectArkade()
      .then((context) => {
        setCtx(context);
        setAspStatus("ready");
      })
      .catch((e: unknown) => {
        setAspStatus("error");
        setError(e instanceof Error ? e.message : String(e));
      });
  }

  function applyIdentity(next: Identity) {
    saveIdentity(next);
    setIdentity(next);
    setOperations(loadOperations(next.pubkeyHex));
  }

  async function handleTake(order: Order, buyerArkAddress?: string) {
    if (!identity) {
      setError("Genera o importa una identidad antes de tomar una orden.");
      return;
    }
    const role = takerRole(order);
    // For a buy order the taker is the seller, so the buyer's receive address
    // comes from the order itself; for a sell order the taker (buyer) provides
    // it directly.
    const receiveAddr =
      role === "buyer" ? (buyerArkAddress ?? "") : (order.arkReceiveAddress ?? "");
    setError("");
    try {
      const msg: TradeMessageOf<"take"> = {
        app: TRADE_APP,
        v: TRADE_VERSION,
        type: "take",
        orderId: order.id,
        role,
        from: identity.pubkeyHex,
        ts: Math.floor(Date.now() / 1000),
        payload: { buyerArkAddress: receiveAddr },
      };
      await sendDm(client.pool, client.relays, identity, order.maker, encodeTradeMessage(msg));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setTradeRequest({
      orderId: order.id,
      counterparty: order.maker,
      role,
      fiat: order.fiat,
      fiatAmount: order.fiatAmount,
      tradeSats: order.amountSats,
      paymentMethods: order.paymentMethods,
      refundAddress: order.arkRefundAddress,
      buyerArkAddress: receiveAddr,
    });
    record(order.id, {
      role,
      counterparty: order.maker,
      fiat: order.fiat,
      fiatAmount: order.fiatAmount,
      tradeSats: order.amountSats,
      status: "in-progress",
    });
    setTab("trade");
  }

  // A finished trade leaves the Operación screen and lives in Historial.
  const activeOperation = tradeRequest
    ? operations.find((op) => op.orderId === tradeRequest.orderId)
    : undefined;
  const tradeFinished = activeOperation !== undefined && isFinished(activeOperation.status);

  const tabs: { id: Tab; label: string }[] = [
    { id: "account", label: "Cuenta" },
    { id: "rates", label: "Tasas" },
    { id: "orders", label: "Órdenes" },
    { id: "trade", label: "Operación" },
    { id: "history", label: "Historial" },
    { id: "escrow", label: "Escrow" },
  ];

  return (
    <main style={{ maxWidth: 760, margin: "2rem auto", textAlign: "left" }}>
      <h1>arkade-p2p-nostr</h1>
      <p>Cliente P2P Nostr con escrow en Arkade — mutinynet, solo fondos de prueba.</p>

      <nav style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            style={{ fontWeight: tab === t.id ? "bold" : "normal" }}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {error && <p style={{ color: "crimson" }}>Error: {error}</p>}

      {tab === "account" && (
        <section>
          <h2>Cuenta</h2>
          <p style={{ fontSize: "0.85em", opacity: 0.8 }}>
            Tu clave se genera automáticamente y se guarda en esta pestaña. Cada pestaña o
            ventana tiene su propia identidad (abre otra para actuar como comprador, vendedor o
            árbitro). La misma clave sirve para Nostr y para Arkade.
          </p>

          <dl>
            <dt>npub</dt>
            <dd style={{ wordBreak: "break-all" }}>{identity.npub}</dd>
            <dt>nsec</dt>
            <dd style={{ wordBreak: "break-all" }}>{identity.nsec}</dd>
          </dl>

          <div>
            <button
              type="button"
              disabled={busy}
              onClick={() => run(async () => applyIdentity(generateIdentity()))}
            >
              Generar otra
            </button>{" "}
            <input
              placeholder="nsec1... o hex"
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
            />
            <button
              type="button"
              disabled={busy || !keyInput}
              onClick={() =>
                run(async () => {
                  applyIdentity(identityFromInput(keyInput));
                  setKeyInput("");
                })
              }
            >
              Importar
            </button>
          </div>

          <h3>ASP</h3>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button type="button" disabled={busy} onClick={reconnectAsp}>
              {aspStatus === "connecting" ? "Conectando…" : "Reconectar"}
            </button>
            <span>
              {aspStatus === "connecting" && "conectando a mutinynet…"}
              {aspStatus === "ready" && "conectado"}
              {aspStatus === "error" && "error de conexión"}
            </span>
          </div>
          {ctx && (
            <dl>
              <dt>operador</dt>
              <dd>{ctx.operatorUrl}</dd>
              <dt>red</dt>
              <dd>{ctx.info.network}</dd>
            </dl>
          )}
        </section>
      )}

      {tab === "rates" && <RatesPanel />}
      {tab === "orders" && (
        <>
          <OrderForm
            client={client}
            identity={identity}
            onPublished={() => setOrdersVersion((v) => v + 1)}
          />
          <hr />
          <OrderBook
            client={client}
            identity={identity}
            onTake={handleTake}
            refreshSignal={ordersVersion}
          />
        </>
      )}
      {tab === "trade" &&
        (tradeFinished ? (
          <section>
            <h2>Operación</h2>
            <p>
              No hay operaciones en curso. Las operaciones terminadas están en{" "}
              <strong>Historial</strong>.
            </p>
          </section>
        ) : (
          <TradePanel
            key={tradeRequest ? `${tradeRequest.orderId}:${tradeRequest.counterparty}` : "manual"}
            identity={identity}
            ctx={ctx}
            client={client}
            request={tradeRequest}
            feed={feed}
          />
        ))}
      {tab === "history" && <HistoryPanel operations={operations} />}
      {tab === "escrow" && <EscrowHarness identity={identity} ctx={ctx} />}
    </main>
  );
}
