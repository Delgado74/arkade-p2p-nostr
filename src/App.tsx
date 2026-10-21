import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import type {
  DisputeAnnounce,
  DisputeResolution,
  DisputeTake,
  Order,
  OrderType,
  SolverRegistry,
} from "./lib/protocol";
import { coordinatorPubKey } from "./lib/config";
import { isFinished, loadOperations, recordOperation, type OperationRecord } from "./lib/operations";
import {
  buildConversations,
  buildDisputeRooms,
  isOurTradeConversation,
  loadReadMarks,
  saveReadMarks,
  type ReadMarks,
} from "./lib/chat";
import { RatesPanel } from "./components/RatesPanel";
import { OrderForm } from "./components/OrderForm";
import { OrderBook } from "./components/OrderBook";
import { EscrowHarness } from "./components/EscrowHarness";
import { OperationsPanel } from "./components/OperationsPanel";
import { TradePanel, type TradeRequest } from "./components/TradePanel";
import { ChatPanel } from "./components/ChatPanel";
import { SolverInbox } from "./components/SolverInbox";
import { activeSolverDisputes, buildSolverDisputes, isListedSolver } from "./lib/solver";
import { usePeerLabels } from "./lib/useNyms";
import { Sidebar } from "./components/Sidebar";
import { BottomNav } from "./components/BottomNav";
import { AddOrderButton } from "./components/AddOrderButton";
import { BackIcon, MenuIcon } from "./components/icons";
import type { Screen } from "./components/nav";

type AspStatus = "connecting" | "ready" | "error";

let sharedClient: NostrClient | null = null;
function nostrClient(): NostrClient {
  if (sharedClient === null) sharedClient = new NostrClient();
  return sharedClient;
}

function takerRole(order: Order): TradeRole {
  return order.type === "sell" ? "buyer" : "seller";
}

const SCREEN_META: Record<Screen, { title: string; sub: string }> = {
  book: { title: "Libro de órdenes", sub: "Compra y vende BTC con escrow en Arkade" },
  create: { title: "Nueva oferta", sub: "Elige el lado y publica tu orden" },
  trades: { title: "Mis operaciones", sub: "Operaciones en curso y terminadas" },
  trade: { title: "Operación", sub: "Escrow, pago fiat y mensajes" },
  chat: { title: "Chat", sub: "Mensajes y disputas" },
  disputes: { title: "Disputas", sub: "Solicitudes donde tu clave es solver" },
  account: { title: "Cuenta y claves", sub: "Identidad Nostr/Arkade y conexión con el ASP" },
  rates: { title: "Tasas", sub: "Precio de referencia y prima" },
  escrow: { title: "Escrow (pruebas)", sub: "Banco de pruebas del escrow Arkade" },
};

const BACK_TARGET: Partial<Record<Screen, Screen>> = {
  create: "book",
  trade: "trades",
};

export default function App() {
  const [tab, setTab] = useState<Screen>("book");
  const [createType, setCreateType] = useState<OrderType>("sell");
  const [sidebarOpen, setSidebarOpen] = useState(false);
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
  const [readMarks, setReadMarks] = useState<ReadMarks>(() => loadReadMarks(identity.pubkeyHex));
  // Bumped after publishing an order so the book refetches immediately instead
  // of waiting for a relay push.
  const [ordersVersion, setOrdersVersion] = useState(0);
  // Public dispute notifications: every solver subscribed sees these; takes
  // stay in a list (not deduped by order) so the optimistic winner can be
  // computed deterministically from all competing takes.
  const [disputeAnnounces, setDisputeAnnounces] = useState<DisputeAnnounce[]>([]);
  const [disputeTakes, setDisputeTakes] = useState<DisputeTake[]>([]);
  const [disputeResolutions, setDisputeResolutions] = useState<DisputeResolution[]>([]);
  // Coordinator-published solver registry. Read-only: only the coordinator
  // (signing the 38389 event) can list a key, so a client can never opt in.
  const [solverRegistry, setSolverRegistry] = useState<SolverRegistry | null>(null);

  const client = nostrClient();

  // DM ids already fed through the side-effect handlers. A reload refetches up
  // to 30 days of history, so without this every old `take` would re-run and
  // drag a finished trade back to `in-progress`.
  const processedDms = useRef<Set<string>>(new Set());

  const record = useCallback(
    (orderId: string, patch: Partial<OperationRecord>) => {
      setOperations(recordOperation(identity.pubkeyHex, orderId, patch));
    },
    [identity.pubkeyHex],
  );

  // Like `record`, but refuses to reopen a trade that already finished: a
  // re-delivered `take` (or any late "in-progress" signal) must never drag a
  // completed/canceled operation back onto the Operación screen.
  const recordActive = useCallback(
    (orderId: string, patch: Partial<OperationRecord>) => {
      const existing = loadOperations(identity.pubkeyHex).find((op) => op.orderId === orderId);
      if (existing && isFinished(existing.status)) return;
      record(orderId, patch);
    },
    [identity.pubkeyHex, record],
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
        // Side effects run once per DM. Re-delivered history (reloads refetch
        // weeks of messages) must not re-fire them.
        if (processedDms.current.has(dm.id)) return;
        processedDms.current.add(dm.id);
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
          recordActive(msg.orderId, {
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
              recordActive(msg.orderId, {
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
  }, [identity, client, record, recordActive]);

  // Live public dispute feed: announcements (who opened) and takes (who is
  // resolving). Both are needed to show dispute state without a manual reload.
  useEffect(() => {
    const announcements = client.subscribeDisputes({
      onDispute: (d) => {
        setDisputeAnnounces((prev) =>
          prev.some((e) => e.event.id === d.event.id) ? prev : [...prev, d],
        );
      },
    });
    const takes = client.subscribeDisputeTakes({
      onTake: (t) => {
        setDisputeTakes((prev) =>
          prev.some((e) => e.event.id === t.event.id) ? prev : [...prev, t],
        );
      },
    });
    const resolutions = client.subscribeDisputeResolutions({
      onRes: (r) => {
        setDisputeResolutions((prev) =>
          prev.some((e) => e.event.id === r.event.id) ? prev : [...prev, r],
        );
      },
    });
    return () => {
      announcements.close();
      takes.close();
      resolutions.close();
    };
  }, [client]);

  // Solver registry: read-only fetch plus live updates, so the Disputas screen
  // appears/disappears as soon as the coordinator changes the published list.
  useEffect(() => {
    const coordinator = coordinatorPubKey();
    let cancelled = false;
    client
      .fetchSolvers(coordinator)
      .then((reg) => {
        if (!cancelled && reg) setSolverRegistry(reg);
      })
      .catch(() => undefined);
    const subscription = client.subscribeSolvers(coordinator, {
      onRegistry: (reg) => setSolverRegistry(reg),
    });
    return () => {
      cancelled = true;
      subscription.close();
    };
  }, [client]);

  // Badges for the menu and the bottom bar. Read marks live here so both
  // surfaces stay in sync with the chat screen.
  const conversations = useMemo(
    () => buildConversations(feed, identity.pubkeyHex, readMarks),
    [feed, identity.pubkeyHex, readMarks],
  );
  const disputeRooms = useMemo(
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
  // Mirror exactly what the Chat screen lists: our own trades (not a solver's
  // broadcast traffic) plus every dispute room, so the badge never shows a
  // count with no visible room behind it.
  const chatUnread =
    conversations.reduce(
      (sum, c) =>
        !c.disputeOnly && isOurTradeConversation(c, feed, operations, identity.pubkeyHex)
          ? sum + c.unread
          : sum,
      0,
    ) + disputeRooms.reduce((sum, d) => sum + d.unread, 0);
  const activeOps = operations.filter((op) => !isFinished(op.status)).length;
  // Only keys published in the coordinator's registry may act as solvers. The
  // Disputas screen is hidden for everyone else; there is no self opt-in.
  const isSolver = isListedSolver(solverRegistry, identity.pubkeyHex);
  const solverDisputes = useMemo(
    () =>
      isSolver
        ? buildSolverDisputes(feed, disputeTakes, disputeResolutions, identity.pubkeyHex)
        : [],
    [isSolver, feed, disputeTakes, disputeResolutions, identity.pubkeyHex],
  );
  const solverActive = activeSolverDisputes(solverDisputes);

  // Every pubkey the UI may render, so their deterministic pseudonyms can be
  // derived locally and shown instead of raw keys.
  const peerKeys = useMemo(() => {
    const keys: string[] = [];
    for (const entry of feed) {
      keys.push(entry.dm.sender, ...entry.dm.recipients);
    }
    for (const d of disputeAnnounces) keys.push(d.initiator);
    for (const t of disputeTakes) keys.push(t.solverPubKey);
    for (const r of disputeResolutions) keys.push(r.solverPubKey);
    for (const op of operations) keys.push(op.counterparty);
    if (solverRegistry) keys.push(...solverRegistry.solvers);
    return keys;
  }, [feed, disputeAnnounces, disputeTakes, disputeResolutions, operations, solverRegistry]);
  const label = usePeerLabels(peerKeys);

  function navigate(screen: Screen) {
    setSidebarOpen(false);
    setTab(screen);
  }

  function openCreate(type: OrderType) {
    setCreateType(type);
    navigate("create");
  }

  function applyReadMarks(next: ReadMarks) {
    setReadMarks(next);
    saveReadMarks(identity.pubkeyHex, next);
  }

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
    setReadMarks(loadReadMarks(next.pubkeyHex));
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
    navigate("trade");
  }

  function openOperation(orderId: string) {
    const op = operations.find((entry) => entry.orderId === orderId);
    if (!op) return;
    setTradeRequest({
      orderId: op.orderId,
      counterparty: op.counterparty,
      role: op.role,
      fiat: op.fiat,
      fiatAmount: op.fiatAmount,
      tradeSats: op.tradeSats,
    });
    navigate("trade");
  }

  function openSolverDispute(orderId: string) {
    setTradeRequest({
      orderId,
      counterparty: "",
      role: "seller",
      solver: true,
    });
    navigate("trade");
  }

  // A finished trade leaves the Operación screen and lives in Mis operaciones.
  const activeOperation = tradeRequest
    ? operations.find((op) => op.orderId === tradeRequest.orderId)
    : undefined;
  const tradeFinished = activeOperation !== undefined && isFinished(activeOperation.status);

  // A non-solver can never land on the Disputas screen (e.g. after switching
  // identity): derive the effective screen instead of mutating state.
  const screen: Screen = !isSolver && tab === "disputes" ? "book" : tab;

  const meta = SCREEN_META[screen];
  const backTarget = screen === "trade" && tradeRequest?.solver ? "disputes" : BACK_TARGET[screen];

  return (
    <div className="app">
      {sidebarOpen && (
        <button
          type="button"
          className="sidebar-scrim"
          aria-label="Cerrar menú"
          onClick={() => setSidebarOpen(false)}
        />
      )}
      <Sidebar
        open={sidebarOpen}
        active={screen}
        chatUnread={chatUnread}
        activeOps={activeOps}
        solverActive={solverActive}
        isSolver={isSolver}
        onNavigate={navigate}
        onClose={() => setSidebarOpen(false)}
      />

      <div className="app-main">
        <header className="topbar">
          {backTarget ? (
            <button
              type="button"
              className="icon-button"
              aria-label="Volver"
              onClick={() => navigate(backTarget)}
            >
              <BackIcon />
            </button>
          ) : (
            <button
              type="button"
              className="icon-button menu-button"
              aria-label="Abrir menú"
              onClick={() => setSidebarOpen(true)}
            >
              <MenuIcon />
            </button>
          )}
          <div className="topbar-title">
            <h1>{meta.title}</h1>
            <p>{meta.sub}</p>
          </div>
          <span className="status-chip" data-status={aspStatus} title="Estado del ASP de Arkade">
            <span className="status-dot" />
            {aspStatus === "ready"
              ? "ASP listo"
              : aspStatus === "connecting"
                ? "Conectando"
                : "ASP sin conexión"}
          </span>
        </header>

        <div className="content">
          {error && <p className="alert">Error: {error}</p>}

          {screen === "book" && (
            <OrderBook
              client={client}
              identity={identity}
              onTake={handleTake}
              refreshSignal={ordersVersion}
            />
          )}

          {screen === "create" && (
            <OrderForm
              key={createType}
              client={client}
              identity={identity}
              initialType={createType}
              onPublished={() => {
                setOrdersVersion((v) => v + 1);
                navigate("book");
              }}
              onCancel={() => navigate("book")}
            />
          )}

          {screen === "trades" && (
            <OperationsPanel operations={operations} onOpen={openOperation} label={label} />
          )}

          {screen === "trade" &&
            (tradeFinished ? (
              <section className="panel">
                <h2>Operación finalizada</h2>
                <p className="panel-note">
                  Esta operación ya terminó; su detalle está en Mis operaciones.
                </p>
                <div className="form-actions">
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => navigate("trades")}
                  >
                    Ver mis operaciones
                  </button>
                </div>
              </section>
            ) : (
              <TradePanel
                key={
                  tradeRequest
                    ? `${tradeRequest.orderId}:${tradeRequest.counterparty}`
                    : "manual"
                }
                identity={identity}
                ctx={ctx}
                client={client}
                request={tradeRequest}
                feed={feed}
                disputeAnnounces={disputeAnnounces}
                disputeTakes={disputeTakes}
                label={label}
              />
            ))}

          {screen === "disputes" &&
            (isSolver ? (
              <SolverInbox disputes={solverDisputes} onOpen={openSolverDispute} label={label} />
            ) : (
              <p className="empty">Esta clave no figura como solver de esta comunidad.</p>
            ))}

          {screen === "chat" && (
            <ChatPanel
              identity={identity}
              client={client}
              feed={feed}
              disputeAnnounces={disputeAnnounces}
              disputeTakes={disputeTakes}
              disputeResolutions={disputeResolutions}
              operations={operations}
              readMarks={readMarks}
              onReadMarksChange={applyReadMarks}
              label={label}
            />
          )}

          {screen === "account" && (
            <section className="panel">
              <p className="panel-note">
                Tu clave se genera automáticamente y se guarda en esta pestaña. Cada pestaña o
                ventana tiene su propia identidad (abre otra para actuar como comprador, vendedor
                o árbitro). La misma clave sirve para Nostr y para Arkade.
              </p>

              <dl className="kv">
                <dt>npub</dt>
                <dd>{identity.npub}</dd>
                <dt>nsec</dt>
                <dd>{identity.nsec}</dd>
              </dl>

              <div className="inline-form">
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={busy}
                  onClick={() => run(async () => applyIdentity(generateIdentity()))}
                >
                  Generar otra
                </button>
                <input
                  className="input"
                  placeholder="nsec1... o hex"
                  value={keyInput}
                  onChange={(e) => setKeyInput(e.target.value)}
                />
                <button
                  type="button"
                  className="btn btn-primary"
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
              <div className="inline-form">
                <button type="button" className="btn btn-ghost" disabled={busy} onClick={reconnectAsp}>
                  {aspStatus === "connecting" ? "Conectando…" : "Reconectar"}
                </button>
                <span className="panel-note">
                  {aspStatus === "connecting" && "conectando a mutinynet…"}
                  {aspStatus === "ready" && "conectado"}
                  {aspStatus === "error" && "error de conexión"}
                </span>
              </div>
              {ctx && (
                <dl className="kv">
                  <dt>operador</dt>
                  <dd>{ctx.operatorUrl}</dd>
                  <dt>red</dt>
                  <dd>{ctx.info.network}</dd>
                </dl>
              )}
            </section>
          )}

          {screen === "rates" && <RatesPanel />}
          {screen === "escrow" && <EscrowHarness identity={identity} ctx={ctx} />}
        </div>

        <BottomNav
          active={screen}
          chatUnread={chatUnread}
          activeOps={activeOps}
          solverActive={solverActive}
          isSolver={isSolver}
          onNavigate={navigate}
        />
      </div>

      {screen === "book" && <AddOrderButton onCreate={openCreate} />}
    </div>
  );
}
