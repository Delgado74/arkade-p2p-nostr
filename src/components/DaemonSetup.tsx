import { useState } from "react";
import { daemonClient } from "../lib/daemon/client";

type Props = {
  onReady: () => void;
};

export default function DaemonSetup({ onReady }: Props) {
  const [status, setStatus] = useState<"loading" | "uninitialized" | "locked" | "ready" | "error">("loading");
  const [passphrase, setPassphrase] = useState("");
  const [mnemonic, setMnemonic] = useState<string[]>([]);
  const [showMnemonic, setShowMnemonic] = useState(false);
  const [error, setError] = useState("");

  const check = async () => {
    try {
      await daemonClient.connect();
      const s = await daemonClient.call<{ status: string }>("wallet.status");
      setStatus(s.status as any);
    } catch (e: any) {
      setError(e.message);
      setStatus("error");
    }
  };

  useState(() => {
    check();
  });

  const create = async () => {
    try {
      setError("");
      const res = await daemonClient.call<{ mnemonic: string[]; npub: string }>("wallet.create", { passphrase });
      setMnemonic(res.mnemonic);
      setShowMnemonic(true);
    } catch (e: any) {
      setError(e.message);
    }
  };

  const unlock = async () => {
    try {
      setError("");
      await daemonClient.call("wallet.unlock", { passphrase });
      onReady();
    } catch (e: any) {
      setError(e.message);
    }
  };

  const doneBackup = async () => {
    try {
      setError("");
      await daemonClient.call("nostr.getIdentity");
      onReady();
    } catch (e: any) {
      setError(e.message);
    }
  };

  if (status === "loading") return <div className="panel" style={{ margin: 40 }}>Conectando al daemon...</div>;
  if (status === "error") return <div className="panel" style={{ margin: 40, color: "red" }}>Error: {error}</div>;
  if (status === "uninitialized") {
    if (showMnemonic) {
      return (
        <div className="panel" style={{ margin: 40, maxWidth: 700 }}>
          <h2>Guarda tu frase de recuperación</h2>
          <p style={{ color: "#f59e0b" }}>Solo se muestra esta vez. Guárdala en un lugar seguro.</p>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8, marginBottom: 16 }}>
            {mnemonic.map((w, i) => (
              <div key={i} style={{ padding: 8, background: "#1f2937", borderRadius: 6 }}>{i + 1}. {w}</div>
            ))}
          </div>
          <button className="btn btn-primary" onClick={doneBackup}>Ya la he guardado</button>
          {error && <p style={{ color: "red" }}>{error}</p>}
        </div>
      );
    }
    return (
      <div className="panel" style={{ margin: 40, maxWidth: 400 }}>
        <h2>Crear cuenta</h2>
        <input type="password" className="input" placeholder="Passphrase" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} style={{ width: "100%", marginBottom: 8 }} />
        <button className="btn btn-primary" onClick={create}>Crear</button>
        {error && <p style={{ color: "red" }}>{error}</p>}
      </div>
    );
  }
  if (status === "locked") {
    return (
      <div className="panel" style={{ margin: 40, maxWidth: 400 }}>
        <h2>Desbloquear wallet</h2>
        <input type="password" className="input" placeholder="Passphrase" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} style={{ width: "100%", marginBottom: 8 }} />
        <button className="btn btn-primary" onClick={unlock}>Desbloquear</button>
        {error && <p style={{ color: "red" }}>{error}</p>}
      </div>
    );
  }
  onReady();
  return <div className="panel" style={{ margin: 40 }}>Listo</div>;
}
