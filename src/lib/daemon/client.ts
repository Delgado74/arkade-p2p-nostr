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

export class DaemonClient {
  private ws: WebSocket | null = null;
  private url: string;
  private id = 0;
  private pending = new Map<number | string, (res: DaemonRpcResponse) => void>();

  constructor(url = "ws://127.0.0.1:9100") {
    this.url = url;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.onopen = () => resolve();
      this.ws.onerror = (e) => reject(e);
      this.ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data) as DaemonRpcResponse;
          if (msg.id !== undefined && this.pending.has(msg.id)) {
            const fn = this.pending.get(msg.id)!;
            this.pending.delete(msg.id);
            fn(msg);
          }
        } catch {}
      };
    });
  }

  call<T = any>(method: string, params?: any): Promise<T> {
    return new Promise((resolve, reject) => {
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
    });
  }
}

export const daemonClient = new DaemonClient();
