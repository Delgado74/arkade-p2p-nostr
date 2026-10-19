import { BookIcon, BoltIcon, ChatIcon } from "./icons";
import { navRoot, type Screen } from "./nav";

interface Props {
  active: Screen;
  chatUnread: number;
  activeOps: number;
  onNavigate: (screen: Screen) => void;
}

/** Mobile navigation, mirroring Mostro's Book / Trades / Chat bar. */
export function BottomNav({ active, chatUnread, activeOps, onNavigate }: Props) {
  const root = navRoot(active);

  return (
    <nav className="bottom-nav" aria-label="Navegación">
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
    </nav>
  );
}
