import { useEffect, useState } from "react";
import type { OrderType } from "../lib/protocol";
import { ArrowDownIcon, ArrowUpIcon, CloseIcon, PlusIcon } from "./icons";

interface Props {
  onCreate: (type: OrderType) => void;
}

/**
 * Create-order FAB (Mostro handoff 4d): a lime "+" that opens a scrim with
 * Buy and Sell as equal full-width buttons and turns into a grey ✕.
 */
export function AddOrderButton({ onCreate }: Props) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  function choose(type: OrderType) {
    setOpen(false);
    onCreate(type);
  }

  return (
    <>
      <button
        type="button"
        className="fab"
        aria-label="Crear orden"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <PlusIcon width={26} height={26} />
      </button>

      {open && (
        <div className="fab-menu" role="dialog" aria-modal="true" aria-label="Nueva oferta">
          <button
            type="button"
            className="fab-scrim"
            aria-label="Cerrar"
            onClick={() => setOpen(false)}
          />
          <div className="fab-stack">
            <button type="button" className="fab-action" data-side="buy" onClick={() => choose("buy")}>
              <ArrowDownIcon width={19} height={19} />
              Comprar BTC
            </button>
            <button
              type="button"
              className="fab-action"
              data-side="sell"
              onClick={() => choose("sell")}
            >
              <ArrowUpIcon width={19} height={19} />
              Vender BTC
            </button>
            <p className="fab-hint">Toca fuera para cerrar</p>
          </div>
          <button
            type="button"
            className="fab fab-close"
            aria-label="Cerrar"
            onClick={() => setOpen(false)}
          >
            <CloseIcon width={22} height={22} />
          </button>
        </div>
      )}
    </>
  );
}
