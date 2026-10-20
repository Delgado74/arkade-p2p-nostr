import {
  pickDisputeTakeTaker,
  type DisputeResolution,
  type DisputeTake,
  type SolverRegistry,
} from "./protocol";
import type { TradeDm } from "./trade";

/**
 * True when the local key is published as a solver in the coordinator's
 * registry. This is the only source of truth: a solver cannot opt in from the
 * client, only the coordinator (signing the registry) can list a key.
 */
export function isListedSolver(registry: SolverRegistry | null, myPubKey: string): boolean {
  if (!registry) return false;
  const me = myPubKey.toLowerCase();
  return registry.solvers.some((s) => s.toLowerCase() === me);
}

export type SolverDisputeStatus = "pending" | "mine" | "taken" | "resolved";

/** One dispute addressed to a solver in the escrow's committed solver set. */
export interface SolverDispute {
  orderId: string;
  initiator: string;
  reason: string;
  createdAt: number;
  tradeSats: number;
  fiat: string;
  fiatAmount: number;
  status: SolverDisputeStatus;
  winner?: string;
  resolution?: string;
}

/**
 * Disputes this identity can resolve: only incoming `dispute` DMs whose
 * agreement commits our key to the solver set. DMs are the source of truth:
 * without one the solver lacks the agreement needed to rebuild the escrow.
 */
export function buildSolverDisputes(
  feed: TradeDm[],
  takes: DisputeTake[],
  resolutions: DisputeResolution[],
  myPubKey: string,
): SolverDispute[] {
  const me = myPubKey.toLowerCase();
  const incoming = new Map<
    string,
    {
      initiator: string;
      reason: string;
      createdAt: number;
      tradeSats: number;
      fiat: string;
      fiatAmount: number;
    }
  >();

  for (const entry of feed) {
    const msg = entry.msg;
    if (!msg || msg.type !== "dispute" || entry.dm.outgoing) continue;
    const solvers = msg.payload.agreement.arbiterPubKeys.map((p) => p.toLowerCase());
    if (!solvers.includes(me)) continue;
    const previous = incoming.get(msg.orderId);
    if (previous && previous.createdAt >= msg.ts) continue;
    incoming.set(msg.orderId, {
      initiator: msg.from,
      reason: msg.payload.reason,
      createdAt: msg.ts,
      tradeSats: msg.payload.agreement.tradeSats,
      fiat: msg.payload.agreement.fiat,
      fiatAmount: msg.payload.agreement.fiatAmount,
    });
  }

  const disputes: SolverDispute[] = [];
  for (const [orderId, base] of incoming) {
    const orderTakes = takes.filter((t) => t.orderId === orderId);
    const winner = pickDisputeTakeTaker(orderTakes);
    const resolution = resolutions
      .filter((r) => r.orderId === orderId)
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    const status: SolverDisputeStatus = resolution
      ? "resolved"
      : winner
        ? winner.solverPubKey.toLowerCase() === me
          ? "mine"
          : "taken"
        : "pending";
    disputes.push({
      orderId,
      ...base,
      status,
      winner: winner?.solverPubKey,
      resolution: resolution?.status,
    });
  }

  return disputes.sort((a, b) => b.createdAt - a.createdAt);
}

/** Disputes that still need this solver's attention or are being resolved. */
export function activeSolverDisputes(disputes: SolverDispute[]): number {
  return disputes.filter((d) => d.status === "pending" || d.status === "mine").length;
}
