import type { Event } from "nostr-tools/pure";
import type { Filter } from "nostr-tools/filter";
import { daemonClient } from "./client";

interface DaemonSubscriptionParams {
  onevent?: (event: Event) => void;
  oneose?: () => void;
  onclose?: (reasons: { url: string; reason: string }[]) => void;
}

interface Subscription {
  close(): void;
}

interface ActiveSubscription {
  filters: Filter[];
  params: DaemonSubscriptionParams;
  active: boolean;
}

/**
 * Drop-in replacement for the subset of `SimplePool` this client uses.
 *
 * Relay sockets live in the daemon: publishing, queries and subscriptions are
 * forwarded over JSON-RPC, and relay events arrive as `nostr.event`
 * notifications. Re-registering after a daemon reconnect keeps the component
 * API (`publish`, `querySync`, `subscribeMany`, `close`) unchanged.
 */
export class DaemonPool {
  private subscriptions = new Map<string, ActiveSubscription>();
  private seq = 0;
  private listening = false;

  private ensureListener(): void {
    if (this.listening) return;
    this.listening = true;
    daemonClient.onNotification((method, params) => {
      if (method === "hello") {
        for (const [id, sub] of this.subscriptions) {
          if (sub.active) this.register(id, sub);
        }
        return;
      }
      if (method === "nostr.event") {
        const sub = this.subscriptions.get(params?.subscriptionId);
        if (sub && params?.event) sub.params.onevent?.(params.event as Event);
        return;
      }
      if (method === "nostr.eose") {
        const sub = this.subscriptions.get(params?.subscriptionId);
        sub?.params.oneose?.();
      }
    });
  }

  private register(id: string, sub: ActiveSubscription): void {
    daemonClient
      .call("nostr.subscribe", { subscriptionId: id, filters: sub.filters })
      .then(() => {
        sub.active = true;
      })
      .catch((error) => {
        if (!this.subscriptions.delete(id)) return;
        sub.params.onclose?.([
          { url: "daemon", reason: error instanceof Error ? error.message : String(error) },
        ]);
      });
  }

  publish(_relays: string[], event: Event): Promise<string>[] {
    return [
      daemonClient.call<{ id: string }>("nostr.publish", { event }).then(() => event.id),
    ];
  }

  querySync(_relays: string[], filter: Filter): Promise<Event[]> {
    return daemonClient.call<Event[]>("nostr.query", { filters: [filter] });
  }

  subscribeMany(
    _relays: string[],
    filter: Filter,
    params: DaemonSubscriptionParams,
  ): Subscription {
    this.ensureListener();
    const id = `c${++this.seq}`;
    const sub: ActiveSubscription = { filters: [filter], params, active: false };
    this.subscriptions.set(id, sub);
    this.register(id, sub);
    return {
      close: () => {
        if (!this.subscriptions.delete(id)) return;
        void daemonClient
          .call("nostr.unsubscribe", { subscriptionId: id })
          .catch(() => undefined);
      },
    };
  }

  close(_relays?: string[]): void {
    for (const id of [...this.subscriptions.keys()]) {
      this.subscriptions.delete(id);
      void daemonClient
        .call("nostr.unsubscribe", { subscriptionId: id })
        .catch(() => undefined);
    }
  }
}
