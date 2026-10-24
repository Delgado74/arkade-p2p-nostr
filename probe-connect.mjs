import * as sdk from "@arkade-os/sdk";
const { arkade, RestArkProvider, RestIndexerProvider, RestEmulatorProvider, getNetwork, defaultEmulatorPubkey } = sdk;
const { Arkade } = arkade;

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
console.log("connected.");
console.log("serverKey :", Buffer.from(client.serverKey).toString("hex"));
console.log("emulatorKey:", Buffer.from(client.emulatorKey).toString("hex"));
console.log("userKey   :", client.userKey);
