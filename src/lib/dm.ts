import type { Event } from "nostr-tools/pure";
import type { Filter } from "nostr-tools/filter";
import type { Identity } from "./identity";
import type { DaemonPool } from "./daemon/pool";
import { daemonClient } from "./daemon/client";

/** Gift-wrap kind used by NIP-17 private direct messages. */
export const GIFT_WRAP_KIND = 1059;

/** An unwrapped private direct message. */
export interface DirectMessage {
  /** Rumor id (stable across relays and self-copies). */
  id: string;
  /** Author pubkey (hex). */
  sender: string;
  /** Recipient pubkeys (hex) from the rumor `p` tags. */
  recipients: string[];
  /** Decrypted plaintext. */
  content: string;
  /** Rumor `created_at` (seconds). */
  createdAt: number;
  /** True when the author is the local identity. */
  outgoing: boolean;
  /**
   * The outer gift-wrap event (for relay bookkeeping). Absent when the message
   * was rebuilt from the daemon database, which only stores the decrypted
   * rumor.
   */
  wrap?: Event;
}

/** Handle for an active DM subscription. */
export interface DmSubscription {
  close(): void;
}

interface DaemonRumor {
  id: string;
  sender: string;
  recipients: string[];
  content: string;
  createdAt: number;
}

/**
 * Send a NIP-17 private message. The daemon builds and signs the seal and gift
 * wraps (including the self-copy) without ever exposing its secret key.
 *
 * @returns The gift-wrapped event destined to the recipient.
 */
export async function sendDm(
  pool: DaemonPool,
  relays: string[],
  _identity: Identity,
  recipientPubKey: string,
  content: string,
): Promise<Event> {
  const wraps = await daemonClient.call<Event[]>("nostr.wrapDm", {
    recipient: recipientPubKey,
    content,
  });
  if (!wraps || wraps.length === 0) {
    throw new Error("daemon returned no gift wraps");
  }
  const results = await Promise.allSettled(wraps.flatMap((wrap) => pool.publish(relays, wrap)));
  const accepted = results.filter((r) => r.status === "fulfilled").length;
  if (accepted === 0) {
    throw new Error(`no relay accepted the DM (${relays.join(", ")})`);
  }
  return wraps[wraps.length - 1];
}

/** Turn a received gift wrap into a {@link DirectMessage}, or `null` if unreadable. */
export async function openDm(wrap: Event, identity: Identity): Promise<DirectMessage | null> {
  if (wrap.kind !== GIFT_WRAP_KIND) return null;
  try {
    const rumor = await daemonClient.call<DaemonRumor>("nostr.unwrapDm", { wrap });
    return {
      id: rumor.id,
      sender: rumor.sender,
      recipients: rumor.recipients,
      content: rumor.content,
      createdAt: rumor.createdAt,
      outgoing: rumor.sender === identity.pubkeyHex,
      wrap,
    };
  } catch {
    return null;
  }
}

/** Options for {@link subscribeDms}. */
export interface SubscribeDmOptions {
  /** Unix seconds; defaults to 7 days back so history loads on first run. */
  since?: number;
  /** Called for each readable, de-duplicated message. */
  onMessage: (message: DirectMessage) => void;
  /** Called when a relay closes the subscription unexpectedly. */
  onError?: (error: unknown) => void;
}

/**
 * Open a live subscription to gift-wrapped DMs addressed to the identity.
 *
 * Self-copies are delivered too, so outbound messages appear in the same stream
 * (with `outgoing: true`); duplicates across relays are de-duplicated by rumor id.
 */
export function subscribeDms(
  pool: DaemonPool,
  relays: string[],
  identity: Identity,
  options: SubscribeDmOptions,
): DmSubscription {
  const seenWraps = new Set<string>();
  const seenMessages = new Set<string>();
  const filter: Filter = {
    kinds: [GIFT_WRAP_KIND],
    "#p": [identity.pubkeyHex],
    since: options.since ?? Math.floor(Date.now() / 1000) - 30 * 24 * 60 * 60,
  };
  return pool.subscribeMany(relays, filter, {
    onevent(wrap) {
      if (seenWraps.has(wrap.id)) return;
      seenWraps.add(wrap.id);
      void openDm(wrap, identity).then((message) => {
        if (!message || seenMessages.has(message.id)) return;
        seenMessages.add(message.id);
        options.onMessage(message);
      });
    },
    onclose(reasons: { url: string; reason: string }[]) {
      if (options.onError && reasons.length > 0) options.onError(reasons);
    },
  });
}
