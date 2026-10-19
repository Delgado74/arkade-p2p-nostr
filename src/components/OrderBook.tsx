import { useEffect, useRef, useState } from "react";
import { nip19 } from "nostr-tools";
import { isExpired, type Order, type OrderType } from "../lib/protocol";
import type { NostrClient } from "../lib/nostr";
import type { Identity } from "../lib/identity";

interface Props {
  client: NostrClient;
  identity?: Identity | null;
  onTake?: (order: Order, buyerArkAddress?: string) => void;
  /** Bumped by the parent after publishing so the book refetches right away. */
  refreshSignal?: number;
}

/** The side the taker plays: buying lists sell orders and vice versa. */
type Side = "buy" | "sell";

function shortNpub(pubkey: string): string {
  try {
    return `${nip19.npubEncode(pubkey).slice(0, 14)}…`;
  } catch {
    return `${pubkey.slice(0, 10)}…`;
  }
}

function orderKey(order: Order): string {
  return `${order.maker}:${order.id}`;
}

/** Which maker orders the given taker side should see. */
function orderTypeForSide(side: Side): OrderType {
  return side === "buy" ? "sell" : "buy";
}

function expiryLabel(order: Order): string {
  if (!order.expiresAt) return "sin caducidad";
  return `expira ${new Date(order.expiresAt * 1000).toLocaleString()}`;
}

/**
 * Merge an incoming order into the book, keeping only the newest version of
 * each addressable order and only orders that are still tradeable (pending, on
 * Arkade, not past `expires_at`). A newer non-pending version therefore removes
 * the order — that is how a taken order disappears live.
 */
function mergeOrder(prev: Order[], order: Order, now: number): Order[] {
  const key = orderKey(order);
  const rest = prev.filter((o) => orderKey(o) !== key);
  if (order.status !== "pending" || order.layer !== "arkade" || isExpired(order, now)) {
    return rest;
  }
  return [...rest, order].sort((a, b) => b.createdAt - a.createdAt);
}

export function OrderBook({ client, identity, onTake, refreshSignal }: Props) {
  const [side, setSide] = useState<Side>("buy");
  const [orders, setOrders] = useState<Order[]>([]);
  const [takingKey, setTakingKey] = useState<string | null>(null);
  const [arkInput, setArkInput] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  // Newest `created_at` seen per addressable order, so a late/duplicate event
  // cannot resurrect an order that has since been taken or deleted.
  const latestRef = useRef<Map<string, number>>(new Map());

  const orderType = orderTypeForSide(side);

  function selectSide(next: Side) {
    if (next === side) return;
    latestRef.current.clear();
    setOrders([]);
    setLoaded(false);
    setError("");
    setTakingKey(null);
    setArkInput("");
    setSide(next);
  }

  // Initial load plus a live subscription: new orders appear without reloading
  // and taken orders leave the book as soon as their status changes.
  useEffect(() => {
    let cancelled = false;
    const ingest = (order: Order) => {
      const key = orderKey(order);
      const seen = latestRef.current.get(key);
      if (seen !== undefined && seen >= order.createdAt) return;
      latestRef.current.set(key, order.createdAt);
      const now = Date.now() / 1000;
      setOrders((prev) => mergeOrder(prev, order, now));
    };

    client
      .fetchOrders({
        type: orderType,
        status: "pending",
        layer: "arkade",
        limit: 100,
      })
      .then((found) => {
        if (cancelled) return;
        for (const order of found) ingest(order);
        setLoaded(true);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      });

    const subscription = client.subscribeOrders(
      { type: orderType },
      {
        onOrder: (order) => {
          if (!cancelled) ingest(order);
        },
      },
    );

    return () => {
      cancelled = true;
      subscription.close();
    };
  }, [client, orderType, refreshSignal]);

  function hideOrder(order: Order) {
    setOrders((prev) => prev.filter((o) => orderKey(o) !== orderKey(order)));
    setTakingKey(null);
    setArkInput("");
  }

  async function handleDelete(order: Order) {
    if (!identity) {
      setError("Genera o importa una identidad primero.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      // Re-check the current status: once a taker takes the order it becomes
      // `in-progress` and must no longer be deletable.
      const current = await client.fetchOrder(order.id, identity.pubkeyHex);
      if (current && current.status !== "pending") {
        setError("La orden ya fue tomada; no se puede eliminar.");
        hideOrder(order);
        return;
      }
      await client.deleteOrder(identity, order.id);
      hideOrder(order);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function confirmTake(order: Order) {
    if (side === "buy") {
      const address = arkInput.trim();
      if (!address) {
        setError("Indica la dirección Ark donde recibirás los fondos.");
        return;
      }
      setError("");
      onTake?.(order, address);
    } else {
      onTake?.(order);
    }
    hideOrder(order);
  }

  return (
    <section className="book">
      <div className="segmented" role="tablist" aria-label="Lado de la orden">
        <button
          type="button"
          role="tab"
          data-side="buy"
          data-active={side === "buy"}
          aria-selected={side === "buy"}
          onClick={() => selectSide("buy")}
        >
          Comprar BTC
        </button>
        <button
          type="button"
          role="tab"
          data-side="sell"
          data-active={side === "sell"}
          aria-selected={side === "sell"}
          onClick={() => selectSide("sell")}
        >
          Vender BTC
        </button>
      </div>

      <p className="book-hint">
        {side === "buy"
          ? "Ofertas de venta: al tomarlas compras BTC y pagas en fiat."
          : "Ofertas de compra: al tomarlas vendes BTC y recibes fiat."}
      </p>

      {error && <p className="alert">Error: {error}</p>}
      {loaded && orders.length === 0 && !error && (
        <p className="empty">Sin órdenes {side === "buy" ? "de venta" : "de compra"} ahora mismo.</p>
      )}

      <div className="order-grid">
        {orders.map((order) => {
          const key = orderKey(order);
          const isOwn = order.maker === identity?.pubkeyHex;
          const buyerTakes = side === "buy";
          return (
            <article className="order-card" key={key}>
              <div className="order-card-head">
                <div>
                  <div className="order-amount">
                    {order.amountSats > 0 ? `${order.amountSats.toLocaleString()} sats` : "Mercado"}
                  </div>
                  <div className="order-price">
                    {order.fiatAmount} {order.fiat}
                    <span className="order-premium">prima {order.premium}%</span>
                  </div>
                </div>
                <span className="order-tag" data-side={order.type}>
                  {order.type === "sell" ? "En venta" : "En compra"}
                </span>
              </div>

              <div className="order-tags">
                {order.paymentMethods.map((method) => (
                  <span className="tag" key={method}>
                    {method}
                  </span>
                ))}
              </div>

              <div className="order-foot">
                <span>maker {shortNpub(order.maker)}</span>
                <span>{expiryLabel(order)}</span>
              </div>

              {isOwn && order.status === "pending" && (
                <div className="order-actions">
                  <button
                    type="button"
                    className="btn btn-ghost-danger"
                    disabled={busy}
                    onClick={() => void handleDelete(order)}
                  >
                    Eliminar mi orden
                  </button>
                </div>
              )}

              {onTake && !isOwn && (
                <div className="order-actions">
                  {!buyerTakes && (
                    <button type="button" className="btn btn-sell" onClick={() => confirmTake(order)}>
                      Vender BTC
                    </button>
                  )}
                  {buyerTakes && takingKey !== key && (
                    <button type="button" className="btn btn-buy" onClick={() => setTakingKey(key)}>
                      Comprar BTC
                    </button>
                  )}
                  {buyerTakes && takingKey === key && (
                    <div className="take-form">
                      <input
                        className="input"
                        placeholder="tu dirección Ark para recibir los sats"
                        value={arkInput}
                        onChange={(e) => setArkInput(e.target.value)}
                      />
                      <div className="take-actions">
                        <button type="button" className="btn btn-buy" onClick={() => confirmTake(order)}>
                          Confirmar
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost"
                          onClick={() => {
                            setTakingKey(null);
                            setArkInput("");
                          }}
                        >
                          Cancelar
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </article>
          );
        })}
      </div>

      <p className="book-relays">Relays: {client.relays.join(", ")}</p>
    </section>
  );
}
