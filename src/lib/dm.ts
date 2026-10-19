import type { SimplePool } from "nostr-tools/pool";
import { unwrapEvent } from "nostr-tools/nip17";
import { wrapManyEvents } from "nostr-tools/nip59";
import type { Event, UnsignedEvent } from "nostr-tools/pure";
import type { Filter } from "nostr-tools/filter";
import type { Identity } from "./identity";

/** Gift-wrap kind used by NIP-17 private direct messages. */
export const GIFT_WRAP_KIND = 1059;

/** Inner rumor kind for NIP-17 private direct messages. */
const PRIVATE_DM_KIND = 14;

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
  /** The outer gift-wrap event (for relay bookkeeping). */
  wrap: Event;
}

/** Handle for an active DM subscription. */
export interface DmSubscription {
  close(): void;
}

/**
 * Send a NIP-17 private message: seal + gift-wrap to the recipient and keep a
 * copy wrapped to self so the sender can reload their own history.
 *
 * @returns The gift-wrapped event destined to the recipient.
 */
export async function sendDm(
  pool: SimplePool,
  relays: string[],
  identity: Identity,
  recipientPubKey: string,
  content: string,
): Promise<Event> {
  // One shared rumor whose `p` tags list BOTH parties. The self-copy keeps the
  // recipient in the tags, so the sender can still recover the counterparty of
  // their own outgoing messages when reloading history.
  const rumor: Partial<UnsignedEvent> = {
    kind: PRIVATE_DM_KIND,
    content,
    tags: [
      ["p", recipientPubKey],
      ["p", identity.pubkeyHex],
    ],
  };
  const wraps = wrapManyEvents(rumor, identity.secretKey, [recipientPubKey]);
  const results = await Promise.allSettled(wraps.flatMap((wrap) => pool.publish(relays, wrap)));
  const accepted = results.filter((r) => r.status === "fulfilled").length;
  if (accepted === 0) {
    throw new Error(`no relay accepted the DM (${relays.join(", ")})`);
  }
  return wraps[wraps.length - 1];
}

/** Turn a received gift wrap into a {@link DirectMessage}, or `null` if unreadable. */
export function openDm(wrap: Event, identity: Identity): DirectMessage | null {
  if (wrap.kind !== GIFT_WRAP_KIND) return null;
  let rumor;
  try {
    rumor = unwrapEvent(wrap, identity.secretKey);
  } catch {
    return null;
  }
  const recipients = rumor.tags.filter((t) => t[0] === "p").map((t) => t[1]);
  return {
    id: rumor.id,
    sender: rumor.pubkey,
    recipients,
    content: rumor.content,
    createdAt: rumor.created_at,
    outgoing: rumor.pubkey === identity.pubkeyHex,
    wrap,
  };
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
  pool: SimplePool,
  relays: string[],
  identity: Identity,
  options: SubscribeDmOptions,
): DmSubscription {
  const seen = new Set<string>();
  const filter: Filter = {
    kinds: [GIFT_WRAP_KIND],
    "#p": [identity.pubkeyHex],
    since: options.since ?? Math.floor(Date.now() / 1000) - 30 * 24 * 60 * 60,
  };
  return pool.subscribeMany(relays, filter, {
    onevent(wrap) {
      const message = openDm(wrap, identity);
      if (!message) return;
      if (seen.has(message.id)) return;
      seen.add(message.id);
      options.onMessage(message);
    },
    onclose(reasons: { url: string; reason: string }[]) {
      if (options.onError && reasons.length > 0) options.onError(reasons);
    },
  });
}
