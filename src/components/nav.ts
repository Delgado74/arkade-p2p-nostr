/** Every screen the app can show. `book` is the landing one. */
export type Screen =
  | "book"
  | "create"
  | "trades"
  | "trade"
  | "chat"
  | "account"
  | "rates"
  | "escrow";

/** Bottom-nav / sidebar root a screen belongs to, when it has one. */
export function navRoot(screen: Screen): "book" | "trades" | "chat" | null {
  if (screen === "book" || screen === "create") return "book";
  if (screen === "trades" || screen === "trade") return "trades";
  if (screen === "chat") return "chat";
  return null;
}
