import {
  RestArkProvider,
  RestIndexerProvider,
  EsploraProvider,
  ESPLORA_URL,
  getNetwork,
  toXOnly,
} from "@arkade-os/sdk";
import type { ArkInfo, Network, NetworkName } from "@arkade-os/sdk";
import { hex } from "@scure/base";

/** Default ASP operator (mutinynet, alpha — test funds only). */
export const DEFAULT_OPERATOR = "https://mutinynet.arkade.sh";

/** Default Arkade network for this app. */
export const DEFAULT_NETWORK: NetworkName = "mutinynet";

export function operatorUrl(): string {
  return import.meta.env.VITE_ARK_OPERATOR?.trim() || DEFAULT_OPERATOR;
}

export function networkName(): NetworkName {
  return (import.meta.env.VITE_NETWORK?.trim() as NetworkName) || DEFAULT_NETWORK;
}

export interface ArkContext {
  /** ASP operator base URL. */
  operatorUrl: string;
  /** Arkade network descriptor. */
  network: Network;
  /** Ark RPC provider (info, tx submission). */
  ark: RestArkProvider;
  /** Indexer provider (vtxo lookups, subscriptions). */
  indexer: RestIndexerProvider;
  /** Onchain provider (Esplora): chain tip / median-time-past for CLTV. */
  onchain: EsploraProvider;
  /** Server metadata fetched on connect. */
  info: ArkInfo;
  /** Server co-signer pubkey (x-only hex) required on every escrow path. */
  serverPubKey: Uint8Array;
}

/**
 * Connect to the ASP: build REST providers and fetch server info.
 *
 * This performs no key handling and holds no funds — it is the read/metadata
 * layer used by the escrow module.
 */
export async function connectArkade(url: string = operatorUrl()): Promise<ArkContext> {
  const ark = new RestArkProvider(url);
  const indexer = new RestIndexerProvider(url);
  const info = await ark.getInfo();
  const serverPubKey = toXOnly(hex.decode(info.signerPubkey), "server signer");
  const network = getNetwork(networkName());
  const onchain = new EsploraProvider(ESPLORA_URL[networkName()]);
  return { operatorUrl: url, network, ark, indexer, onchain, info, serverPubKey };
}

/**
 * Current chain time (median-time-past) in Unix seconds.
 *
 * `OP_CHECKLOCKTIMEVERIFY` with a seconds operand is evaluated by BIP-113
 * against the tip's median-time-past, *not* the tip header's `nTime` and not
 * the local wall clock. Anchoring the escrow refund timelock to this value
 * keeps both peers' derived scripts (and the maturity check) aligned with what
 * the network will actually enforce.
 *
 * Falls back to the local clock only when the chain tip is unreachable, so a
 * transient Esplora outage does not brick agreement construction.
 */
export async function chainTimeSeconds(ctx: ArkContext): Promise<number> {
  try {
    const tip = await ctx.onchain.getChainTip();
    return tip.time;
  } catch {
    return Math.floor(Date.now() / 1000);
  }
}
