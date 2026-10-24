import { getNetwork, isCltvSatisfied, type ContractHandler } from "@arkade-os/sdk";
import type {
  Contract,
  Network,
  NetworkName,
  PathContext,
  PathSelection,
  TapLeafScript,
} from "@arkade-os/sdk";
import { hex } from "@scure/base";
import { buildEscrow, type Escrow, type EscrowConfig } from "./escrow";

/**
 * The forfeit/intent annotation capability a handler may implement so the
 * contract manager can annotate funded VTXOs. Not exported by the SDK's public
 * entry point, so it is mirrored structurally here (`deriveTapscripts` must be
 * pure in `(type, script, params)` — the manager memoizes it).
 */
interface TapscriptDeriving {
  deriveTapscripts(
    script: Escrow["script"],
    contract: Contract,
  ): {
    forfeitTapLeafScript: TapLeafScript;
    intentTapLeafScript: TapLeafScript;
    tapTree: Uint8Array;
  };
}

/**
 * Contract type identifier for the P2P escrow.
 *
 * The escrow is a plain multisig+CLTV {@link VtxoScript} (release 3-of-3,
 * timelocked refund 2-of-2, one arbiter leaf per solver). Registering it as a
 * contract makes the SDK's contract machinery aware of it: the `VtxoManager`
 * can see it, the watcher keeps it fresh, and — crucially — a `settle` can fold
 * a preconfirmed or swept escrow VTXO back into a batch at the *same* escrow
 * script. Without this registration the escrow is an opaque script the SDK
 * neither annotates nor renews, which is how a funded VTXO becomes invisible
 * and then swept.
 */
export const ESCROW_CONTRACT_TYPE = "arkade-escrow";

/**
 * Serialized escrow contract parameters. Every value is a string (hex for
 * bytes, decimal for the bigint timelock, comma-separated for the key list),
 * matching {@link Contract.params}.
 */
export interface EscrowContractParams extends Record<string, string> {
  buyerPubKey: string;
  sellerPubKey: string;
  /** Solver x-only pubkeys, comma-separated (empty when there are none). */
  arbiterPubKeys: string;
  serverPubKey: string;
  /** Absolute CLTV timelock in Unix seconds, as a decimal string. */
  refundLocktime: string;
  /** Arkade network name, needed to derive the address deterministically. */
  network: string;
}

function networkNameFrom(name: string | undefined): NetworkName {
  return (name ?? "mutinynet") as NetworkName;
}

function networkFrom(name: string | undefined): Network {
  return getNetwork(networkNameFrom(name));
}

/** Build an {@link Escrow} from serialized contract parameters. */
export function escrowFromParams(params: Record<string, string>): Escrow {
  const config: EscrowConfig = {
    buyerPubKey: hex.decode(params.buyerPubKey),
    sellerPubKey: hex.decode(params.sellerPubKey),
    arbiterPubKeys: (params.arbiterPubKeys ?? "")
      .split(",")
      .map((k) => k.trim())
      .filter((k) => k.length > 0)
      .map((k) => hex.decode(k)),
    serverPubKey: hex.decode(params.serverPubKey),
    refundLocktime: BigInt(params.refundLocktime),
  };
  return buildEscrow(config, networkFrom(params.network));
}

/** Serialize an {@link Escrow} into its contract parameters. */
export function escrowToParams(escrow: Escrow, network: NetworkName): EscrowContractParams {
  return {
    buyerPubKey: hex.encode(escrow.config.buyerPubKey),
    sellerPubKey: hex.encode(escrow.config.sellerPubKey),
    arbiterPubKeys: escrow.config.arbiterPubKeys.map((k) => hex.encode(k)).join(","),
    serverPubKey: hex.encode(escrow.config.serverPubKey),
    refundLocktime: escrow.refundLocktime.toString(),
    network,
  };
}

/** Rebuild an {@link Escrow} from a contract row. */
export function escrowFromContract(contract: Contract): Escrow {
  return escrowFromParams(contract.params);
}

/**
 * Which party the wallet plays in the escrow, derived from its x-only public
 * key. Returns `null` when the wallet is not a party (no spend path).
 */
export function escrowRole(escrow: Escrow, walletPubKey?: string): string | null {
  if (!walletPubKey) return null;
  const key = walletPubKey.toLowerCase();
  if (key === hex.encode(escrow.config.buyerPubKey).toLowerCase()) return "buyer";
  if (key === hex.encode(escrow.config.sellerPubKey).toLowerCase()) return "seller";
  if (key === hex.encode(escrow.config.serverPubKey).toLowerCase()) return "server";
  const solver = escrow.solverLeaves.find((s) => s.pubkey.toLowerCase() === key);
  if (solver) return `arbiter:${solver.pubkey.toLowerCase()}`;
  return null;
}

function selection(leaf: TapLeafScript): PathSelection {
  return { leaf };
}

/** The `release` leaf (buyer + seller + server, 3-of-3). */
function releasePath(escrow: Escrow): PathSelection {
  return selection(escrow.releaseLeaf);
}

/** The timelocked `refund` leaf (seller + server, 2-of-2), after maturity. */
function refundPath(escrow: Escrow, context: PathContext): PathSelection | null {
  if (!isCltvSatisfied(context, escrow.refundLocktime)) return null;
  return selection(escrow.refundLeaf);
}

/** The arbiter leaf for the wallet's solver identity. */
function arbiterPath(escrow: Escrow, role: string): PathSelection | null {
  const pubkey = role.slice("arbiter:".length);
  const solver = escrow.solverLeaves.find((s) => s.pubkey.toLowerCase() === pubkey);
  return solver ? selection(solver.leaf) : null;
}

/** Preferred path for the wallet's role, ignoring timelocks. */
function preferredPath(escrow: Escrow, role: string): PathSelection | null {
  if (role === "buyer" || role === "seller") return releasePath(escrow);
  if (role.startsWith("arbiter:")) return arbiterPath(escrow, role);
  return null;
}

/** All declared paths for the wallet's role, regardless of current usability. */
function allPaths(escrow: Escrow, role: string): PathSelection[] {
  const paths: PathSelection[] = [];
  if (role === "buyer" || role === "seller") paths.push(releasePath(escrow));
  if (role === "seller") paths.push(selection(escrow.refundLeaf));
  if (role.startsWith("arbiter:")) {
    const p = arbiterPath(escrow, role);
    if (p) paths.push(p);
  }
  return paths;
}

/** Paths the wallet can actually use right now. */
function spendablePaths(escrow: Escrow, role: string, context: PathContext): PathSelection[] {
  const paths: PathSelection[] = [];
  if (role === "buyer" || role === "seller") paths.push(releasePath(escrow));
  if (role === "seller") {
    const refund = refundPath(escrow, context);
    if (refund) paths.push(refund);
  }
  if (role.startsWith("arbiter:")) {
    const p = arbiterPath(escrow, role);
    if (p) paths.push(p);
  }
  return paths;
}

/**
 * Contract handler for the P2P escrow.
 *
 * Registered once at app start via `contractHandlers.register(...)`. It lets the
 * SDK build the escrow script from stored params, choose the right spending leaf
 * per wallet role, and — through {@link deriveTapscripts} — annotate funded
 * escrow VTXOs so they can be forfeited/renewed during batch settlement.
 *
 * `isGenericallySpendable` is deliberately `false`: the escrow must never be
 * swept into a generic `settle()`/send. Only explicit-input operations (a
 * renewal or recovery that names the escrow outpoint) may touch it.
 */
export const escrowContractHandler: ContractHandler<EscrowContractParams> &
  TapscriptDeriving = {
  type: ESCROW_CONTRACT_TYPE,
  createScript(params) {
    return escrowFromParams(params).script;
  },
  serializeParams(params) {
    return { ...params };
  },
  deserializeParams(params) {
    return escrowToParams(escrowFromParams(params), networkNameFrom(params.network));
  },
  selectPath(_script, contract, context) {
    const escrow = escrowFromContract(contract);
    return preferredPath(escrow, escrowRole(escrow, context.walletPubKey) ?? "");
  },
  getAllSpendingPaths(_script, contract, context) {
    const escrow = escrowFromContract(contract);
    return allPaths(escrow, escrowRole(escrow, context.walletPubKey) ?? "");
  },
  getSpendablePaths(_script, contract, context) {
    const escrow = escrowFromContract(contract);
    return spendablePaths(escrow, escrowRole(escrow, context.walletPubKey) ?? "", context);
  },
  isGenericallySpendable() {
    return false;
  },
  assertSpendableNow(_script, contract, context) {
    const escrow = escrowFromContract(contract);
    const role = escrowRole(escrow, context.walletPubKey);
    if (!role) {
      throw new Error("wallet is not a party to this escrow");
    }
    if (spendablePaths(escrow, role, context).length === 0) {
      throw new Error(
        "the escrow has no spendable path for this wallet right now (refund timelock not mature, or not a party)",
      );
    }
  },
  deriveTapscripts(_script, contract) {
    const escrow = escrowFromContract(contract);
    // Stamp the `refund` leaf (seller + server, CLTV-gated), NOT the 3-of-3
    // `release` leaf. A VTXO swept out of its batch can only be recovered by a
    // settlement, and arkd's `ForfeitTxReadyToBroadcast` requires a signature
    // for every pubkey of the forfeit leaf. With `release` the forfeit would
    // demand buyer + seller + server, trapping the sats whenever the buyer is
    // unresponsive. `refund` needs only seller + server and is CLTV-gated, so
    // the seller — the party that funded the escrow — can recover alone with
    // the ASP, and only after `refundLocktime`, keeping the buyer's guarantee
    // intact. Callers must respect the CLTV: a recovery round before maturity
    // is rejected by the server, which is why `assertSpendableNow` gates on it.
    return {
      forfeitTapLeafScript: escrow.refundLeaf,
      intentTapLeafScript: escrow.refundLeaf,
      tapTree: escrow.script.encode(),
    };
  },
};
