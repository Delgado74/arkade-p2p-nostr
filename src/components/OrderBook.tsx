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

function shortNpub(pubkey: string): string {
  try {
    return `${nip19.npubEncode(pubkey).slice(0, 14)}…`;
  } catch {
    return `${pubkey.slice(0, 10)}…`;
  }
}

/** The taker takes the opposite side of the maker's order. */
function takerIsBuyer(order: Order): boolean {
  return order.type === "sell";
}

function orderKey(order: Order): string {
  return `${order.maker}:${order.id}`;
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
  const [type, setType] = useState<OrderType>("sell");
  const [orders, setOrders] = useState<Order[]>([]);
  const [takingKey, setTakingKey] = useState<string | null>(null);
  const [arkInput, setArkInput] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  // Newest `created_at` seen per addressable order, so a late/duplicate event
  // cannot resurrect an order that has since been taken or deleted.
  const latestRef = useRef<Map<string, number>>(new Map());

  function selectType(next: OrderType) {
    if (next === type) return;
    latestRef.current.clear();
    setOrders([]);
    setType(next);
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
        type,
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
      { type },
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
  }, [client, type, refreshSignal]);

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
    if (takerIsBuyer(order)) {
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
    <section>
      <h2>Libro de órdenes</h2>
      <div style={{ display: "flex", gap: 8 }}>
        <button
          type="button"
          onClick={() => selectType("sell")}
          style={{ fontWeight: type === "sell" ? "bold" : "normal" }}
        >
          Venta
        </button>
        <button
          type="button"
          onClick={() => selectType("buy")}
          style={{ fontWeight: type === "buy" ? "bold" : "normal" }}
        >
          Compra
        </button>
      </div>

      <p style={{ fontSize: "0.85em" }}>
        Solo órdenes en Arkade · muestran todas las monedas fiat
      </p>

      <p style={{ fontSize: "0.85em" }}>Relays: {client.relays.join(", ")}</p>

      {error && <p style={{ color: "crimson" }}>{error}</p>}
      {loaded && orders.length === 0 && !error && <p>Sin órdenes.</p>}

      <ul style={{ listStyle: "none", padding: 0 }}>
        {orders.map((order) => {
          const key = orderKey(order);
          const isOwn = order.maker === identity?.pubkeyHex;
          const buyerTakes = takerIsBuyer(order);
          return (
            <li
              key={key}
              style={{ border: "1px solid #8884", borderRadius: 8, padding: 12, marginBottom: 8 }}
            >
              <strong style={{ textTransform: "uppercase" }}>{order.type}</strong>{" "}
              {order.amountSats > 0 ? `${order.amountSats.toLocaleString()} sats` : "mercado"}{" "}
              · {order.fiatAmount} {order.fiat} · prima {order.premium}%
              <div style={{ fontSize: "0.85em", opacity: 0.8 }}>
                {order.platform} · {order.layer}/{order.network} · {order.paymentMethods.join(", ")}
              </div>
              <div style={{ fontSize: "0.85em", opacity: 0.8 }}>
                maker {shortNpub(order.maker)}
                {order.expiresAt
                  ? ` · expira ${new Date(order.expiresAt * 1000).toLocaleString()}`
                  : ""}
                {isExpired(order) ? " · EXPIRADA" : ""}
              </div>

              {isOwn && order.status === "pending" && (
                <div style={{ marginTop: 6 }}>
                  <button type="button" disabled={busy} onClick={() => handleDelete(order)}>
                    Eliminar mi orden
                  </button>
                </div>
              )}

              {onTake && !isOwn && !isExpired(order) && (
                <div style={{ marginTop: 6 }}>
                  {!buyerTakes && (
                    <button type="button" onClick={() => confirmTake(order)}>
                      Tomar (vender BTC)
                    </button>
                  )}
                  {buyerTakes && takingKey !== key && (
                    <button type="button" onClick={() => setTakingKey(key)}>
                      Tomar
                    </button>
                  )}
                  {buyerTakes && takingKey === key && (
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                      <input
                        placeholder="tu dirección Ark para recibir los sats"
                        value={arkInput}
                        onChange={(e) => setArkInput(e.target.value)}
                        style={{ width: 340 }}
                      />
                      <button type="button" onClick={() => confirmTake(order)}>
                        Confirmar toma
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setTakingKey(null);
                          setArkInput("");
                        }}
                      >
                        Cancelar
                      </button>
                    </div>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
