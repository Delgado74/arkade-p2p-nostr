import { pubkeyFromInput } from "./identity";

/**
 * Default arbiter when `VITE_ARBITER` is not set.
 *
 * Both peers MUST agree on the arbiter before trading: it is baked into the
 * escrow script, so a mismatch produces a different escrow address. Operators
 * should set `VITE_ARBITER` to their own arbiter npub; this placeholder keeps
 * the app runnable out of the box.
 */
export const DEFAULT_ARBITER_NPUB =
  "npub1wr9hjdry05jnu7alfym5yv5ygpnkae0a7hxpv496vw8v4mrgddwsa6rq70";

/** Default coordinator npub for solver registry (replaceable event). */
export const DEFAULT_COORDINATOR_NPUB = DEFAULT_ARBITER_NPUB;

/** Resolve the arbiter x-only hex pubkey from config (npub or hex). */
export function arbiterPubKey(): string {
  const raw = import.meta.env.VITE_ARBITER?.trim();
  return pubkeyFromInput(raw && raw.length > 0 ? raw : DEFAULT_ARBITER_NPUB);
}

/** Resolve the coordinator x-only hex pubkey from config (npub or hex). */
export function coordinatorPubKey(): string {
  const raw = import.meta.env.VITE_COORDINATOR?.trim();
  return pubkeyFromInput(raw && raw.length > 0 ? raw : DEFAULT_COORDINATOR_NPUB);
}
