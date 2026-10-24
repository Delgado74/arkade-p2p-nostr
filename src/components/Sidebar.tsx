import {
  BookIcon,
  BoltIcon,
  ChatIcon,
  CloseIcon,
  KeyIcon,
  ShieldIcon,
  ToolboxIcon,
} from "./icons";
import { navRoot, type Screen } from "./nav";

interface Props {
  open: boolean;
  active: Screen;
  chatUnread: number;
  activeOps: number;
  solverActive: number;
  isSolver: boolean;
  onNavigate: (screen: Screen) => void;
  onClose: () => void;
}

/** Mostro-style menu: navigation first, account and tools below it. */
export function Sidebar({
  open,
  active,
  chatUnread,
  activeOps,
  solverActive,
  isSolver,
  onNavigate,
  onClose,
}: Props) {
  const root = navRoot(active);

  return (
    <aside className="sidebar" data-open={open} aria-label="Menú principal">
      <div className="sidebar-inner">
        <div className="sidebar-brand">
          <span className="brand-mark" aria-hidden="true">
            a
          </span>
          <div className="brand-text">
            <span className="wordmark">arkade-p2p</span>
            <span className="tagline">P2P · MUTINYNET</span>
          </div>
          <button type="button" className="icon-button sidebar-close" onClick={onClose} aria-label="Cerrar menú">
            <CloseIcon />
          </button>
        </div>

        <nav className="sidebar-nav">
          <button
            type="button"
            className="nav-row"
            data-active={root === "book"}
            onClick={() => onNavigate("book")}
          >
            <BookIcon />
            <span>Libro de órdenes</span>
          </button>
          <button
            type="button"
            className="nav-row"
            data-active={root === "trades"}
            onClick={() => onNavigate("trades")}
          >
            <BoltIcon />
            <span>Mis operaciones</span>
            {activeOps > 0 && <span className="nav-badge">{activeOps}</span>}
          </button>
          <button
            type="button"
            className="nav-row"
            data-active={root === "chat"}
            onClick={() => onNavigate("chat")}
          >
            <ChatIcon />
            <span>Chat</span>
            {chatUnread > 0 && <span className="nav-badge">{chatUnread}</span>}
          </button>
          {isSolver && (
            <button
              type="button"
              className="nav-row"
              data-active={root === "disputes"}
              onClick={() => onNavigate("disputes")}
            >
              <ShieldIcon />
              <span>Disputas</span>
              {solverActive > 0 && <span className="nav-badge">{solverActive}</span>}
            </button>
          )}
        </nav>

        <div className="sidebar-separator" />
        <div className="sidebar-section">Cuenta</div>

        <nav className="sidebar-nav">
          <button
            type="button"
            className="nav-row"
            data-active={active === "account"}
            onClick={() => onNavigate("account")}
          >
            <KeyIcon />
            <span>Cuenta y claves</span>
          </button>
          <button
            type="button"
            className="nav-row"
            style={{ display: "none" }}
            data-active={active === "rates"}
            onClick={() => onNavigate("rates")}
          >
            <span className="nav-icon">💱</span>
            <span className="nav-label">Tasas</span>
          </button>
          <button
            type="button"
            className="nav-row"
            data-active={active === "escrow"}
            onClick={() => onNavigate("escrow")}
          >
            <ToolboxIcon />
            <span>Escrow (pruebas)</span>
          </button>
        </nav>

        <div className="sidebar-footer">
          <span>mutinynet</span>
          <span>solo fondos de prueba</span>
        </div>
      </div>
    </aside>
  );
}
