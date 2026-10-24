import * as sdk from "@arkade-os/sdk";
import { readFileSync } from "fs";
import { createRequire } from "module";
const require = createRequire("/home/islabtc/arkade-p2p-nostr/node_modules/.pnpm/@arkade-os+sdk@0.4.79/node_modules/@arkade-os/sdk/dist/index.js");
const { secp256k1 } = require("@noble/curves/secp256k1.js");
const { sha256 } = require("@noble/hashes/sha2.js");

const { arkade } = sdk;
const { Arkade, ArkadeContract, programFromArtifact } = arkade;
const { RestArkProvider, RestIndexerProvider, RestEmulatorProvider, getNetwork, defaultEmulatorPubkey } = sdk;

const ARK = "https://mutinynet.arkade.sh";
const EMU = "https://emulator.mutinynet.arkade.sh";
const net = getNetwork("mutinynet");

const client = await Arkade.connect({
  arkade: new RestArkProvider(ARK),
  indexer: new RestIndexerProvider(ARK),
  emulator: new RestEmulatorProvider(EMU),
  network: net,
  emulatorPubkey: defaultEmulatorPubkey(net),
});

const buyerPriv  = "01".padEnd(64, "1");
const sellerPriv = "02".padEnd(64, "2");
const xonly = (p) => Buffer.from(secp256k1.getPublicKey(Buffer.from(p, "hex")).slice(1, 33)).toString("hex");
const buyerPk  = xonly(buyerPriv);
const sellerPk = xonly(sellerPriv);

const artifact = JSON.parse(readFileSync("/tmp/opencode/mostro-ark/mostro_escrow.json", "utf8"));
const program = programFromArtifact(artifact);
console.log("program OK, functions:", Object.keys(program.functions ?? {}));

const scriptOf = (pkHex) => sha256(Buffer.concat([Buffer.from([0x50]), Buffer.from(pkHex, "hex")]));
const args = {
  buyerPk, sellerPk,
  releaseMsgHash: Buffer.from(sha256(Buffer.from("mostro-release-v1"))).toString("hex"),
  buyerScript:  Buffer.from(scriptOf(buyerPk)).toString("hex"),
  sellerScript: Buffer.from(scriptOf(sellerPk)).toString("hex"),
  server: Buffer.from(client.serverKey).toString("hex"),
  amount: "100000",
  timeoutAt: String(Math.floor(Date.now()/1000) + 86400),
};

const contract = new ArkadeContract(client, program, args, {
  serverKey: client.serverKey,
  userKey: Buffer.from(buyerPk, "hex"),
  emulatorKey: client.emulatorKey,
});
console.log("contract built OK");
console.log("tapTree bytes:", contract.tapTree.length);
const enc = contract.vtxoScript.encode ? contract.vtxoScript.encode() : null;
console.log("vtxoScript.encode():", enc);
