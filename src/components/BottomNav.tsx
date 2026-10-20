import { BookIcon, BoltIcon, ChatIcon, ShieldIcon } from "./icons";
import { navRoot, type Screen } from "./nav";

interface Props {
  active: Screen;
  chatUnread: number;
  activeOps: number;
  solverActive: number;
  isSolver: boolean;
  onNavigate: (screen: Screen) => void;
}

/** Mobile navigation, mirroring Mostro's Book / Trades / Chat bar. */
export function BottomNav({
  active,
  chatUnread,
  activeOps,
  solverActive,
  isSolver,
  onNavigate,
}: Props) {
  const root = navRoot(active);

  return (
    <nav className="bottom-nav" data-columns={isSolver ? 4 : 3} aria-label="Navegación">
      <button
        type="button"
        className="nav-item"
        data-active={root === "book"}
        onClick={() => onNavigate("book")}
      >
        <span className="nav-item-icon">
          <BookIcon />
        </span>
        Libro
      </button>
      <button
        type="button"
        className="nav-item"
        data-active={root === "trades"}
        onClick={() => onNavigate("trades")}
      >
        <span className="nav-item-icon">
          <BoltIcon />
          {activeOps > 0 && <span className="nav-badge">{activeOps}</span>}
        </span>
        Operaciones
      </button>
      <button
        type="button"
        className="nav-item"
        data-active={root === "chat"}
        onClick={() => onNavigate("chat")}
      >
        <span className="nav-item-icon">
          <ChatIcon />
          {chatUnread > 0 && <span className="nav-badge">{chatUnread}</span>}
        </span>
        Chat
      </button>
      {isSolver && (
        <button
          type="button"
          className="nav-item"
          data-active={root === "disputes"}
          onClick={() => onNavigate("disputes")}
        >
          <span className="nav-item-icon">
            <ShieldIcon />
            {solverActive > 0 && <span className="nav-badge">{solverActive}</span>}
          </span>
          Disputas
        </button>
      )}
    </nav>
  );
}
