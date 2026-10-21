import {
  ArkAddress,
  CLTVMultisigTapscript,
  CSVMultisigTapscript,
  MultisigTapscript,
  Transaction,
  VtxoScript,
  assertAllowedSighashTypes,
  assertSubmittedArkTxid,
  buildOffchainTx,
  canRecoverOnchain,
  canSpendOffchain,
  combineTapscriptSigs,
  matchServerCheckpoints,
  toXOnly,
} from "@arkade-os/sdk";
import type {
  ArkInfo,
  ArkTxInput,
  Network,
  OffchainTx,
  TapLeafScript,
  VirtualCoin,
} from "@arkade-os/sdk";
import type { RestArkProvider, RestIndexerProvider } from "@arkade-os/sdk";
import { base64, hex } from "@scure/base";
import type { Identity } from "./identity";

/**
 * Spending paths embedded in the escrow VTXO script.
 *
 * - `release`: buyer + seller + server (3-of-3) — cooperative settlement.
 * - `refund`: seller + server (2-of-2) with an absolute timelock
 *   (`refundLocktime`, a Unix-seconds CLTV value) — after maturity the seller
 *   can reclaim the escrow without any solver. This is the on-chain protection
 *   that mirrors Mostro's VHTLC refund: the buyer must release or open a dispute
 *   before the timelock matures, otherwise the seller (with the server) can
 *   refund alone.
 * - For each solver in the set, there is an `arbiter:<solver>` leaf:
 *   `solver + server` (2-of-2) — dispute resolution/refund through that solver.
 */
export const EscrowPath = {
  Release: "release",
  Refund: "refund",
  Arbiter: "arbiter",
} as const;
export type EscrowPath = (typeof EscrowPath)[keyof typeof EscrowPath];

/**
 * Default escrow timelock *duration* (~24h), in seconds.
 *
 * `OP_CHECKLOCKTIMEVERIFY` operands are **absolute**: values below
 * 500,000,000 are read as block heights, values at or above as Unix
 * timestamps (BIP-113). Mutinynet's height is already in the millions, so a
 * small block delta is unusable; we commit an absolute timestamp instead,
 * fixed when the escrow is created and carried in the agreement.
 */
export const DEFAULT_REFUND_LOCKTIME_SECONDS = 24 * 60 * 60;

/**
 * Absolute CLTV timestamp (Unix seconds) for a refund that matures one default
 * duration after `chainTimeSeconds` (the current chain median-time-past).
 */
export function refundLocktimeFrom(chainTimeSeconds: number): bigint {
  return BigInt(Math.floor(chainTimeSeconds) + DEFAULT_REFUND_LOCKTIME_SECONDS);
}

export interface EscrowConfig {
  /** x-only (32-byte) or compressed (33-byte) buyer public key. */
  buyerPubKey: Uint8Array;
  /** x-only (32-byte) or compressed (33-byte) seller public key. */
  sellerPubKey: Uint8Array;
  /**
   * List of solver x-only/compressed pubkeys that may resolve disputes.
   * Order is deterministic (sorted by hex) and committed into the script.
   */
  arbiterPubKeys: Uint8Array[];
  /** ASP server co-signer key (from `ArkInfo.signerPubkey`). */
  serverPubKey: Uint8Array;
  /**
   * Absolute CLTV timelock (Unix seconds, or a block height) after which the
   * seller may reclaim the escrow through the `refund` leaf. Committed into the
   * script, so both parties must agree on it. Defaults to ~24h after now.
   */
  refundLocktime?: bigint;
}

/** A solver leaf embedded in the escrow. */
export interface SolverLeaf {
  pubkey: string; // x-only hex
  script: Uint8Array;
  leaf: TapLeafScript;
}

export interface Escrow {
  config: EscrowConfig;
  /** The composed virtual output script (release + refund + one leaf per solver). */
  script: VtxoScript;
  /** Arkade bech32m address to fund the escrow (off-chain). */
  address: string;
  /** Taproot on-chain address (unilateral exit / boarding). */
  onchainAddress: string;
  /** Absolute CLTV timelock (Unix seconds) of the `refund` leaf. */
  refundLocktime: bigint;
  releaseScript: Uint8Array;
  releaseLeaf: TapLeafScript;
  refundScript: Uint8Array;
  refundLeaf: TapLeafScript;
  solverLeaves: SolverLeaf[];
}

/** A transaction output paid to an Arkade address, in satoshis. */
export interface EscrowOutput {
  script: Uint8Array;
  amount: bigint;
}

/** What a buyer expects to receive from a cooperative release. */
export interface ReleaseExpectation {
  /** Arkade address that must receive the released satoshis. */
  destination: string;
  /** Exact amount (sats) that must arrive at `destination`. */
  sats: number;
}

/** A partially/fully signed escrow spend, ready to travel over Nostr DMs. */
export interface SerializedSpend {
  /** Base64-encoded PSBT of the virtual (off-chain) transaction. */
  arkTx: string;
  /** Base64-encoded PSBTs of the checkpoint transactions, one per input. */
  checkpoints: string[];
}

/** Build an output paying `amount` sats to an Arkade address. */
export function outputToArkAddress(address: string, amount: bigint): EscrowOutput {
  return { script: ArkAddress.decode(address).pkScript, amount };
}

function toXOnlyArray(keys: Uint8Array[]): Uint8Array[] {
  return keys.map((k, i) => toXOnly(k, `solver[${i}]`));
}

/**
 * Compose the deterministic escrow virtual output script from its keys.
 *
 * Leaf order: [release, refund, solver_0, solver_1, ...] where solvers are
 * sorted by their x-only hex pubkey to ensure determinism across all
 * participants.
 */
export function buildEscrow(config: EscrowConfig, network: Network): Escrow {
  const buyer = toXOnly(config.buyerPubKey, "buyer");
  const seller = toXOnly(config.sellerPubKey, "seller");
  const server = toXOnly(config.serverPubKey, "server");
  const solverSet = toXOnlyArray(config.arbiterPubKeys);
  const refundLocktime = config.refundLocktime ?? refundLocktimeFrom(Date.now() / 1000);

  const release = MultisigTapscript.encode({ pubkeys: [buyer, seller, server] });
  const refund = CLTVMultisigTapscript.encode({
    absoluteTimelock: refundLocktime,
    pubkeys: [seller, server],
  });
  const solverLeaves = solverSet
    .map((p) => ({ p, raw: MultisigTapscript.encode({ pubkeys: [p, server] }) }))
    .sort((a, b) => {
      const ha = hex.encode(a.p);
      const hb = hex.encode(b.p);
      return ha < hb ? -1 : ha > hb ? 1 : 0;
    })
    .map(({ p, raw }) => ({
      pubkey: hex.encode(p),
      script: raw.script,
      leaf: { script: raw.script, version: 0xc0 as const },
    }));

  const leavesList = [release.script, refund.script, ...solverLeaves.map((s) => s.script)];
  const script = new VtxoScript(leavesList as any);
  const address = script.address(network.hrp, server).encode();
  const onchainAddress = script.onchainAddress(network);

  const releaseLeaf = script.findLeaf(hex.encode(release.script));
  const refundLeaf = script.findLeaf(hex.encode(refund.script));

  const solverLeavesOut = solverLeaves.map((s) => ({
    pubkey: s.pubkey,
    script: s.script,
    leaf: script.findLeaf(hex.encode(s.script)),
  }));

  return {
    config: {
      buyerPubKey: buyer,
      sellerPubKey: seller,
      arbiterPubKeys: solverSet,
      serverPubKey: server,
      refundLocktime,
    },
    script,
    address,
    onchainAddress,
    refundLocktime,
    releaseScript: release.script,
    releaseLeaf,
    refundScript: refund.script,
    refundLeaf,
    solverLeaves: solverLeavesOut,
  };
}

/**
 * The escrow-relevant fields of a trade agreement, as plain hex strings. Kept
 * structural (rather than importing `EscrowAgreement`) to avoid a circular
 * import between `escrow.ts` and `trade.ts`.
 */
export interface AgreementKeys {
  buyerPubKey: string;
  sellerPubKey: string;
  arbiterPubKeys: string[];
  serverPubKey: string;
  refundLocktime?: string;
}

/**
 * Decode an agreement into escrow config and build the escrow. Both parties
 * call this with the same agreement, so they derive an identical script.
 */
export function escrowFromAgreement(agreement: AgreementKeys, network: Network): Escrow {
  return buildEscrow(
    {
      buyerPubKey: hex.decode(agreement.buyerPubKey),
      sellerPubKey: hex.decode(agreement.sellerPubKey),
      arbiterPubKeys: agreement.arbiterPubKeys.map((x) => hex.decode(x)),
      serverPubKey: hex.decode(agreement.serverPubKey),
      refundLocktime:
        agreement.refundLocktime !== undefined
          ? BigInt(agreement.refundLocktime)
          : refundLocktimeFrom(Date.now() / 1000),
    },
    network,
  );
}

/** Script hexes to query the indexer for VTXOs locked to this escrow. */
export function escrowScripts(escrow: Escrow): string[] {
  return [hex.encode(escrow.script.pkScript)];
}

/**
 * How a VTXO funded into the escrow is currently usable.
 *
 * - `spendable`: settled in a batch; a cooperative release/refund/arbiter
 *   spend can be built and submitted right now.
 * - `pending`: still `preconfirmed` (not yet finalized in a batch). It must be
 *   left to settle before it can be spent; operating on it now risks losing it
 *   to a batch sweep.
 * - `recoverable`: its batch was swept (`isSwept`), so it can no longer be
 *   spent off-chain as-is and needs recovery before it is usable.
 */
export type EscrowVtxoState = "spendable" | "pending" | "recoverable";

export interface EscrowVtxo {
  vtxo: VirtualCoin;
  state: EscrowVtxoState;
  /** `canSpendOffchain` on the coin — true only when it can be spent now. */
  spendable: boolean;
  /** `canRecoverOnchain` — true when it must be recovered into a fresh batch. */
  recoverable: boolean;
}

function classifyEscrowVtxo(vtxo: VirtualCoin): EscrowVtxo {
  const now = { timestamp: new Date() };
  const spendable = canSpendOffchain(vtxo, now);
  const recoverable = canRecoverOnchain(vtxo, now);
  const state: EscrowVtxoState = spendable
    ? "spendable"
    : recoverable
      ? "recoverable"
      : "pending";
  return { vtxo, state, spendable, recoverable };
}

/**
 * Every live (unspent) VTXO locked to this escrow, with its usability state.
 *
 * Deliberately does NOT pass `spendableOnly` and does NOT filter out `isSwept`:
 * right after funding the escrow output is still `preconfirmed` (not yet
 * finalized in a batch), and a swept output is still recoverable — dropping
 * either turned a real funding into an invisible one ("I funded but it never
 * shows up / the funds are gone"). We fetch everything for the escrow script and
 * classify locally, matching how the SDK's own contract poll reads VTXOs.
 */
export async function listEscrowVtxos(
  indexer: RestIndexerProvider,
  escrow: Escrow,
): Promise<EscrowVtxo[]> {
  const { vtxos } = await indexer.getVtxos({ scripts: escrowScripts(escrow) });
  return vtxos.filter((v) => !v.isSpent).map(classifyEscrowVtxo);
}

/**
 * The best live VTXO funded into the escrow: the first spendable one, else the
 * first recoverable, else the first pending. Returns `null` when the escrow has
 * no live VTXO at all.
 */
export async function findEscrowVtxo(
  indexer: RestIndexerProvider,
  escrow: Escrow,
): Promise<VirtualCoin | null> {
  const all = await listEscrowVtxos(indexer, escrow);
  const pick =
    all.find((e) => e.state === "spendable") ??
    all.find((e) => e.state === "recoverable") ??
    all[0];
  return pick?.vtxo ?? null;
}

/**
 * Confirm the escrow holds exactly `expectedSats` and is *spendable now*;
 * throws otherwise with an actionable message.
 *
 * The release spend pays the buyer `tradeSats` and has no change output back to
 * the escrow, so any excess funded above the agreed amount is absorbed as fees
 * and lost. Funding must therefore match the agreed amount exactly.
 *
 * Also enforces the production invariant that we never operate on a VTXO that
 * cannot be spent off-chain yet: a `preconfirmed` escrow is left to settle
 * (blocking actions instead of risking a batch sweep), and a `swept` one is
 * reported as recoverable rather than silently treated as missing.
 */
export async function assertFunded(
  indexer: RestIndexerProvider,
  escrow: Escrow,
  expectedSats: number,
): Promise<VirtualCoin> {
  const all = await listEscrowVtxos(indexer, escrow);
  if (all.length === 0) throw new Error("escrow has no live VTXO");
  const funded = all.find((e) => e.vtxo.value === expectedSats) ?? all[0];
  if (funded.vtxo.value !== expectedSats) {
    throw new Error(
      `escrow funded with ${funded.vtxo.value} sats but the agreement is ${expectedSats} sats; send exactly the agreed amount`,
    );
  }
  if (funded.state === "recoverable") {
    throw new Error(
      "the escrow VTXO was swept (its batch expired) and must be recovered before it can be spent",
    );
  }
  if (!funded.spendable) {
    throw new Error(
      "the escrow is funded but not settled yet; wait for the batch to finalize before releasing, refunding or disputing",
    );
  }
  return funded.vtxo;
}

function buildInput(escrow: Escrow, vtxo: VirtualCoin, path: EscrowPath): ArkTxInput {
  if (path !== EscrowPath.Release && path !== EscrowPath.Refund) {
    throw new Error("buildInput for arbiter requires solverPubKey");
  }
  return {
    txid: vtxo.txid,
    vout: vtxo.vout,
    value: vtxo.value,
    tapLeafScript: path === EscrowPath.Refund ? escrow.refundLeaf : escrow.releaseLeaf,
    tapTree: escrow.script.encode(),
  };
}

export function buildInputForSolver(
  escrow: Escrow,
  vtxo: VirtualCoin,
  solverPubKey: string,
): ArkTxInput {
  const s = escrow.solverLeaves.find(
    (x) => x.pubkey.toLowerCase() === solverPubKey.toLowerCase(),
  );
  if (!s) {
    throw new Error("solver not in escrow solver set");
  }
  return {
    txid: vtxo.txid,
    vout: vtxo.vout,
    value: vtxo.value,
    tapLeafScript: s.leaf,
    tapTree: escrow.script.encode(),
  };
}

function serverUnrollScript(info: ArkInfo) {
  return CSVMultisigTapscript.decode(hex.decode(info.checkpointTapscript));
}

/**
 * Build an unsigned off-chain spend of the escrow VTXO along `path`.
 *
 * The virtual transaction and its checkpoint transactions are left unsigned;
 * every required signer must call {@link signSpend} and the results merged with
 * {@link mergeSpends} before {@link submitSpend}.
 */
export function buildSpend(
  info: ArkInfo,
  escrow: Escrow,
  vtxo: VirtualCoin,
  path: EscrowPath,
  outputs: EscrowOutput[],
  solverPubKey?: string,
): OffchainTx {
  const input =
    path === EscrowPath.Arbiter && solverPubKey
      ? buildInputForSolver(escrow, vtxo, solverPubKey)
      : buildInput(escrow, vtxo, path);
  return buildOffchainTx([input], outputs, serverUnrollScript(info));
}

/** Sign the virtual transaction and every checkpoint with one identity. */
export async function signSpend(
  offchainTx: OffchainTx,
  identity: Identity,
): Promise<SerializedSpend> {
  const arkTx = await identity.ark.sign(offchainTx.arkTx);
  const checkpoints = await Promise.all(
    offchainTx.checkpoints.map((checkpoint) => identity.ark.sign(checkpoint)),
  );
  return {
    arkTx: base64.encode(arkTx.toPSBT()),
    checkpoints: checkpoints.map((checkpoint) => base64.encode(checkpoint.toPSBT())),
  };
}

/**
 * Add one identity's signatures onto an already-partially-signed spend sent by
 * a counterparty, keeping their signatures intact.
 */
export async function coSignSpend(
  spend: SerializedSpend,
  identity: Identity,
): Promise<SerializedSpend> {
  const arkTx = await identity.ark.sign(Transaction.fromPSBT(base64.decode(spend.arkTx)));
  const checkpoints = await Promise.all(
    spend.checkpoints.map(async (encoded) =>
      identity.ark.sign(Transaction.fromPSBT(base64.decode(encoded))),
    ),
  );
  return {
    arkTx: base64.encode(arkTx.toPSBT()),
    checkpoints: checkpoints.map((checkpoint) => base64.encode(checkpoint.toPSBT())),
  };
}

function mergeTapScriptSigs(base: Transaction, extra: Transaction): Transaction {
  return combineTapscriptSigs(extra, base);
}

/**
 * Merge two partial spends (e.g. seller + buyer) into a single one carrying
 * every signature collected so far.
 */
export function mergeSpends(a: SerializedSpend, b: SerializedSpend): SerializedSpend {
  if (a.checkpoints.length !== b.checkpoints.length) {
    throw new Error("cannot merge spends with different checkpoint counts");
  }
  const arkTx = mergeTapScriptSigs(
    Transaction.fromPSBT(base64.decode(a.arkTx)),
    Transaction.fromPSBT(base64.decode(b.arkTx)),
  );
  const checkpoints = a.checkpoints.map((encoded, index) =>
    mergeTapScriptSigs(
      Transaction.fromPSBT(base64.decode(encoded)),
      Transaction.fromPSBT(base64.decode(b.checkpoints[index])),
    ),
  );
  return {
    arkTx: base64.encode(arkTx.toPSBT()),
    checkpoints: checkpoints.map((checkpoint) => base64.encode(checkpoint.toPSBT())),
  };
}

/**
 * Rebuild a signed checkpoint without its tapscript signatures.
 *
 * The SDK's own send path submits the *unsigned* checkpoint templates to
 * `submitTx` and only folds user signatures in at `finalizeTx`. Submitting
 * already-signed checkpoints lets the server settle the tx during `submitTx`,
 * after which our explicit `finalizeTx` fails with "not in a valid stage to
 * finalize offchain tx". Rebuild each checkpoint without `tapScriptSig` so
 * `submitTx` receives the same unsigned template the SDK would send: same txid,
 * with witness UTXO, tap leaf and tap tree metadata preserved.
 */
function unsignedCheckpoint(checkpoint: Transaction): Transaction {
  const inputs = [];
  for (let i = 0; i < checkpoint.inputsLength; i++) {
    const { tapScriptSig: _sig, ...rest } = checkpoint.getInput(i);
    inputs.push(rest);
  }
  const fresh = new Transaction({
    version: checkpoint.version,
    lockTime: checkpoint.lockTime,
  });
  for (const input of inputs) fresh.addInput(input);
  for (let i = 0; i < checkpoint.outputsLength; i++) {
    fresh.addOutput(checkpoint.getOutput(i));
  }
  return fresh;
}

/**
 * Submit a fully co-signed escrow spend: the server adds its own signature,
 * we merge it with ours on every checkpoint, then finalize.
 *
 * @returns The off-chain ark transaction id.
 */
export async function submitSpend(
  ark: RestArkProvider,
  spend: SerializedSpend,
): Promise<string> {
  const signedArkTx = Transaction.fromPSBT(base64.decode(spend.arkTx));
  const localCheckpoints = spend.checkpoints.map((encoded) =>
    Transaction.fromPSBT(base64.decode(encoded)),
  );

  const unsignedSpendCheckpoints = localCheckpoints.map((checkpoint) =>
    base64.encode(unsignedCheckpoint(checkpoint).toPSBT()),
  );
  const response = await ark.submitTx(spend.arkTx, unsignedSpendCheckpoints);
  assertSubmittedArkTxid(response, signedArkTx, "submitTx");

  const matched = matchServerCheckpoints(
    response.signedCheckpointTxs,
    localCheckpoints,
    "submitTx",
  );
  matched.forEach(({ server }) => assertAllowedSighashTypes(server));

  const byId = new Map(localCheckpoints.map((checkpoint) => [checkpoint.id, checkpoint]));
  const finalCheckpoints = matched.map(({ server, local }) => {
    combineTapscriptSigs(byId.get(local.id) ?? local, server);
    return base64.encode(server.toPSBT());
  });

  await ark.finalizeTx(response.arkTxid, finalCheckpoints);
  return response.arkTxid;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Guard against signing a spend that does not do what it claims.
 *
 * Asserts that
 * - the ark tx has exactly one input and exactly one checkpoint;
 * - both inputs commit to the given `path` leaf;
 * - the checkpoint actually spends the agreed escrow VTXO (`txid`/`vout`);
 * - the expected output is present, exact, and no output overdraws the VTXO.
 *
 * @throws if any check fails. On success it is safe to {@link signSpend}.
 */
function findSolverLeaf(escrow: Escrow, solverPubKey: string): Uint8Array {
  const s = escrow.solverLeaves.find(
    (x) => x.pubkey.toLowerCase() === solverPubKey.toLowerCase(),
  );
  if (!s) {
    throw new Error("solver not in escrow solver set");
  }
  return s.leaf[1];
}

export function verifySpend(
  _escrow: Escrow,
  vtxo: VirtualCoin,
  pathLeafScript: Uint8Array,
  expected: ReleaseExpectation,
  spend: SerializedSpend,
): void {
  const arkTx = Transaction.fromPSBT(base64.decode(spend.arkTx));
  const checkpoints = spend.checkpoints.map((encoded) =>
    Transaction.fromPSBT(base64.decode(encoded)),
  );

  if (arkTx.inputsLength !== 1) {
    throw new Error(`ark tx must have 1 input, got ${arkTx.inputsLength}`);
  }
  if (checkpoints.length !== 1) {
    throw new Error(`spend must carry 1 checkpoint, got ${checkpoints.length}`);
  }

  const arkLeaf = arkTx.getInput(0).tapLeafScript?.[0]?.[1];
  if (!arkLeaf || !sameBytes(arkLeaf, pathLeafScript)) {
    throw new Error(`ark tx does not sign the required leaf`);
  }

  const checkpoint = checkpoints[0];
  if (checkpoint.inputsLength !== 1) {
    throw new Error(`checkpoint must have 1 input`);
  }
  const checkpointInput = checkpoint.getInput(0);
  const spendsTxid = checkpointInput.txid ? hex.encode(checkpointInput.txid) : "";
  if (spendsTxid !== vtxo.txid.toLowerCase() || checkpointInput.index !== vtxo.vout) {
    throw new Error(`does not spend the agreed escrow VTXO`);
  }
  const checkpointLeaf = checkpointInput.tapLeafScript?.[0]?.[1];
  if (!checkpointLeaf || !sameBytes(checkpointLeaf, pathLeafScript)) {
    throw new Error(`checkpoint does not sign the required leaf`);
  }

  const wantedScript = ArkAddress.decode(expected.destination).pkScript;
  let total = 0n;
  let paysDestination = false;
  for (let i = 0; i < arkTx.outputsLength; i++) {
    const output = arkTx.getOutput(i);
    const amount = output.amount ?? 0n;
    total += amount;
    if (output.script && sameBytes(output.script, wantedScript) && amount === BigInt(expected.sats)) {
      paysDestination = true;
    }
  }
  if (!paysDestination) {
    throw new Error(`spend does not pay ${expected.sats} sats to ${expected.destination}`);
  }
  if (total > vtxo.value) {
    throw new Error(`outputs exceed the escrow value`);
  }
}

/**
 * Buyer-side guard: refuse to co-sign a release unless it provably pays them
 * the agreed amount from the agreed VTXO, before a single signature is produced.
 */
export function verifyReleaseSpend(
  escrow: Escrow,
  vtxo: VirtualCoin,
  expected: ReleaseExpectation,
  spend: SerializedSpend,
): void {
  verifySpend(escrow, vtxo, escrow.releaseLeaf[1], expected, spend);
}

/** Guard for a timelocked refund: must pay the seller via the `refund` leaf. */
export function verifyRefundSpend(
  escrow: Escrow,
  vtxo: VirtualCoin,
  expected: ReleaseExpectation,
  spend: SerializedSpend,
): void {
  verifySpend(escrow, vtxo, escrow.refundLeaf[1], expected, spend);
}

/** Guard for an arbiter dispute spend: must pay the winner via the solver leaf. */
export function verifyArbiterSpend(
  escrow: Escrow,
  vtxo: VirtualCoin,
  solverPubKey: string,
  expected: ReleaseExpectation,
  spend: SerializedSpend,
): void {
  const leaf = findSolverLeaf(escrow, solverPubKey);
  verifySpend(escrow, vtxo, leaf, expected, spend);
}
