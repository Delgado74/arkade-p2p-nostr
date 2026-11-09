export interface DaemonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: any;
}

export interface DaemonRpcResponse<T = any> {
  jsonrpc: "2.0";
  id: number | string;
  result?: T;
  error?: { code: number; message: string };
}

export type DaemonNotificationHandler = (method: string, params: any) => void;

export class DaemonClient {
  private ws: WebSocket | null = null;
  private url: string;
  private id = 0;
  private pending = new Map<number | string, (res: DaemonRpcResponse) => void>();
  private notificationHandlers = new Set<DaemonNotificationHandler>();
  private connecting: Promise<void> | null = null;

  constructor(url = import.meta.env.VITE_DAEMON_URL?.trim() || "ws://127.0.0.1:9100") {
    this.url = url;
  }

  /** Listen to server-initiated notifications (subscription events, `hello`). */
  onNotification(handler: DaemonNotificationHandler): () => void {
    this.notificationHandlers.add(handler);
    return () => {
      this.notificationHandlers.delete(handler);
    };
  }

  connect(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) return Promise.resolve();
    if (this.connecting) return this.connecting;

    this.connecting = new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;

      ws.onopen = () => {
        this.connecting = null;
        resolve();
      };
      ws.onerror = (event) => {
        this.connecting = null;
        reject(event);
      };
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data) as DaemonRpcResponse & { method?: string; params?: any };
          if (msg.id !== undefined && this.pending.has(msg.id)) {
            const fn = this.pending.get(msg.id)!;
            this.pending.delete(msg.id);
            fn(msg);
            return;
          }
          if (typeof msg.method === "string") {
            for (const handler of this.notificationHandlers) handler(msg.method, msg.params);
          }
        } catch {}
      };
      ws.onclose = () => {
        this.connecting = null;
        for (const fn of this.pending.values()) {
          fn({
            jsonrpc: "2.0",
            id: -1,
            error: { code: -32000, message: "daemon disconnected" },
          });
        }
        this.pending.clear();
        if (this.ws === ws) this.ws = null;
      };
    });

    return this.connecting;
  }

  call<T = any>(method: string, params?: any): Promise<T> {
    return this.connect().then(
      () =>
        new Promise<T>((resolve, reject) => {
          if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            reject(new Error("daemon not connected"));
            return;
          }
          const id = ++this.id;
          const req: DaemonRpcRequest = { jsonrpc: "2.0", id, method, params };
          this.pending.set(id, (res) => {
            if (res.error) reject(new Error(res.error.message));
            else resolve(res.result as T);
          });
          this.ws.send(JSON.stringify(req));
        }),
    );
  }
}

export const daemonClient = new DaemonClient();
