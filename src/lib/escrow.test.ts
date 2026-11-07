import { describe, expect, it } from "vitest";
import {
  CSVMultisigTapscript,
  getNetwork,
  type ArkInfo,
  type PathContext,
  type RestIndexerProvider,
  type VirtualCoin,
} from "@arkade-os/sdk";
import { base64, hex } from "@scure/base";
import {
  assertFunded,
  buildEscrow,
  buildSpend,
  classifyEscrowVtxo,
  escrowFromAgreement,
  ESCROW_VERSION,
  EscrowPath,
  listEscrowVtxos,
  outputToArkAddress,
  verifyReleaseSpend,
  type AgreementKeys,
  type EscrowConfig,
} from "./escrow";
import { escrowContractHandler } from "./escrowHandler";
import { contractFromEscrow } from "./escrowWallet";

const NETWORK_NAME = "mutinynet" as const;
const NETWORK = getNetwork(NETWORK_NAME);
const LOCKTIME = 1_700_000_000n;

const BUYER = hex.decode("11".repeat(32));
const SELLER = hex.decode("22".repeat(32));
const SERVER = hex.decode("33".repeat(32));
const SOLVER_A = hex.decode("44".repeat(32));
const SOLVER_B = hex.decode("55".repeat(32));

function config(overrides: Partial<EscrowConfig> = {}): EscrowConfig {
  return {
    buyerPubKey: BUYER,
    sellerPubKey: SELLER,
    arbiterPubKeys: [SOLVER_A, SOLVER_B],
    serverPubKey: SERVER,
    refundLocktime: LOCKTIME,
    ...overrides,
  };
}

function agreement(overrides: Partial<AgreementKeys> = {}): AgreementKeys {
  return {
    escrowVersion: ESCROW_VERSION,
    buyerPubKey: hex.encode(BUYER),
    sellerPubKey: hex.encode(SELLER),
    arbiterPubKeys: [hex.encode(SOLVER_A), hex.encode(SOLVER_B)],
    serverPubKey: hex.encode(SERVER),
    refundLocktime: LOCKTIME.toString(),
    ...overrides,
  };
}

function vtxo(overrides: Partial<VirtualCoin> = {}): VirtualCoin {
  return {
    txid: "aa".repeat(32),
    vout: 0,
    value: 10_000,
    script: "00",
    isSpent: false,
    isSwept: false,
    isPreconfirmed: false,
    isUnrolled: false,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    ...overrides,
  } as unknown as VirtualCoin;
}

function indexer(vtxos: VirtualCoin[]): RestIndexerProvider {
  return {
    getVtxos: async () => ({ vtxos }),
  } as unknown as RestIndexerProvider;
}

function pathContext(escrow: ReturnType<typeof buildEscrow>, chainTime: number): PathContext {
  return {
    collaborative: true,
    currentTime: chainTime * 1000,
    chainTime,
    walletPubKey: hex.encode(escrow.config.sellerPubKey),
  };
}

describe("escrow determinism and versioning", () => {
  it("derives the same escrow regardless of solver order", () => {
    const a = buildEscrow(config({ arbiterPubKeys: [SOLVER_A, SOLVER_B] }), NETWORK);
    const b = buildEscrow(config({ arbiterPubKeys: [SOLVER_B, SOLVER_A] }), NETWORK);

    expect(a.address).toBe(b.address);
    expect(a.onchainAddress).toBe(b.onchainAddress);
    expect(hex.encode(a.script.pkScript)).toBe(hex.encode(b.script.pkScript));
    expect(escrowFromAgreement(agreement(), NETWORK).address).toBe(a.address);
  });

  it("commits the refund locktime into the script", () => {
    const now = buildEscrow(config(), NETWORK);
    const later = buildEscrow(config({ refundLocktime: LOCKTIME + 1n }), NETWORK);
    expect(later.address).not.toBe(now.address);
  });

  it("refuses to build without an explicit positive refund locktime", () => {
    expect(() =>
      buildEscrow({ ...config(), refundLocktime: undefined as unknown as bigint }, NETWORK),
    ).toThrow(/refundLocktime/);
    expect(() => buildEscrow(config({ refundLocktime: 0n }), NETWORK)).toThrow(
      /refundLocktime/,
    );
  });

  it("refuses unknown versions and legacy agreements without a locktime", () => {
    expect(() =>
      escrowFromAgreement(agreement({ escrowVersion: ESCROW_VERSION + 1 }), NETWORK),
    ).toThrow(/unsupported escrow version/);
    expect(() => escrowFromAgreement(agreement({ refundLocktime: "" }), NETWORK)).toThrow(
      /refundLocktime/,
    );
  });
});

describe("escrow VTXO classification", () => {
  it("classifies settled, preconfirmed and swept VTXOs", () => {
    expect(classifyEscrowVtxo(vtxo()).state).toBe("spendable");
    expect(classifyEscrowVtxo(vtxo({ isPreconfirmed: true })).state).toBe("pending");
    expect(classifyEscrowVtxo(vtxo({ isSwept: true })).state).toBe("recoverable");
    expect(
      classifyEscrowVtxo(vtxo({ expiresAt: new Date(Date.now() - 1000) })).state,
    ).toBe("recoverable");
  });

  it("lists only live VTXOs for the escrow script", async () => {
    const escrow = buildEscrow(config(), NETWORK);
    const live = await listEscrowVtxos(
      indexer([vtxo({ txid: "aa".repeat(32) }), vtxo({ txid: "bb".repeat(32), isSpent: true })]),
      escrow,
    );
    expect(live).toHaveLength(1);
    expect(live[0].vtxo.txid).toBe("aa".repeat(32));
  });

  it("requires exact funding and a spendable VTXO", async () => {
    const escrow = buildEscrow(config(), NETWORK);

    await expect(
      assertFunded(indexer([vtxo({ value: 10_000 })]), escrow, 10_000),
    ).resolves.toMatchObject({ value: 10_000 });
    await expect(
      assertFunded(indexer([vtxo({ value: 9_000 })]), escrow, 10_000),
    ).rejects.toThrow(/funded with 9000 sats/);
    await expect(
      assertFunded(indexer([vtxo({ isPreconfirmed: true })]), escrow, 10_000),
    ).rejects.toThrow(/not settled yet/);
    await expect(
      assertFunded(indexer([vtxo({ isSwept: true })]), escrow, 10_000),
    ).rejects.toThrow(/swept/);
  });
});

describe("escrow recovery path", () => {
  it("exposes the seller refund leaf only after the locktime matures", () => {
    const escrow = buildEscrow(config(), NETWORK);
    const contract = contractFromEscrow(escrow, NETWORK_NAME);
    const refundLeaf = hex.encode(escrow.refundLeaf[1]);

    const before = escrowContractHandler
      .getSpendablePaths(escrow.script, contract, pathContext(escrow, Number(LOCKTIME) - 1))
      .map((path) => hex.encode(path.leaf[1]));
    const after = escrowContractHandler
      .getSpendablePaths(escrow.script, contract, pathContext(escrow, Number(LOCKTIME)))
      .map((path) => hex.encode(path.leaf[1]));

    expect(before).not.toContain(refundLeaf);
    expect(after).toContain(refundLeaf);
  });

  it("keeps the refund leaf recoverable before maturity but not spendable", () => {
    const escrow = buildEscrow(config(), NETWORK);
    const contract = contractFromEscrow(escrow, NETWORK_NAME);
    const refundLeaf = hex.encode(escrow.refundLeaf[1]);

    const all = escrowContractHandler
      .getAllSpendingPaths(escrow.script, contract, pathContext(escrow, Number(LOCKTIME) - 1))
      .map((path) => hex.encode(path.leaf[1]));

    expect(all).toContain(refundLeaf);
  });
});

describe("escrow spend guards", () => {
  function spendFor(escrow: ReturnType<typeof buildEscrow>, destination: string, sats: number) {
    const checkpoint = CSVMultisigTapscript.encode({
      timelock: { type: "seconds", value: 1024n },
      pubkeys: [escrow.config.serverPubKey, escrow.config.serverPubKey],
    });
    const info = { checkpointTapscript: hex.encode(checkpoint.script) } as ArkInfo;
    const coin = vtxo({ value: sats });
    const spend = buildSpend(info, escrow, coin, EscrowPath.Release, [
      outputToArkAddress(destination, BigInt(sats)),
    ]);
    return {
      coin,
      spend: {
        arkTx: base64.encode(spend.arkTx.toPSBT()),
        checkpoints: spend.checkpoints.map((tx) => base64.encode(tx.toPSBT())),
      },
    };
  }

  it("accepts exactly the agreed destination and amount", () => {
    const escrow = buildEscrow(config(), NETWORK);
    const { coin, spend } = spendFor(escrow, escrow.address, 10_000);
    expect(() =>
      verifyReleaseSpend(escrow, coin, { destination: escrow.address, sats: 10_000 }, spend),
    ).not.toThrow();
  });

  it("rejects a release that pays another address or amount", () => {
    const escrow = buildEscrow(config(), NETWORK);
    const other = buildEscrow(config({ refundLocktime: LOCKTIME + 1n }), NETWORK);
    const { coin, spend } = spendFor(escrow, escrow.address, 10_000);
    expect(() =>
      verifyReleaseSpend(escrow, coin, { destination: other.address, sats: 10_000 }, spend),
    ).toThrow(/does not pay/);
    expect(() =>
      verifyReleaseSpend(escrow, coin, { destination: escrow.address, sats: 9_000 }, spend),
    ).toThrow(/does not pay/);
  });
});
