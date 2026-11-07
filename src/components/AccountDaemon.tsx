import { useState } from "react";
import { daemonClient } from "../lib/daemon/client";

export default function AccountDaemon() {
  const [passphrase, setPassphrase] = useState("");
  const [mnemonic, setMnemonic] = useState<string[] | null>(null);
  const [error, setError] = useState("");

  const reveal = async () => {
    try {
      setError("");
      const res = await daemonClient.call<{ mnemonic: string[] }>("wallet.revealMnemonic", { passphrase });
      setMnemonic(res.mnemonic);
    } catch (e: any) {
      setError(e.message);
    }
  };

  return (
    <section className="panel">
      <h3>Frase de recuperación</h3>
      <p className="panel-note">Pide la passphrase para mostrarla de nuevo.</p>
      <div className="inline-form">
        <input type="password" className="input" placeholder="Passphrase" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
        <button className="btn btn-ghost" onClick={reveal}>Mostrar</button>
      </div>
      {error && <p className="text-red-500">{error}</p>}
      {mnemonic && (
        <div className="grid grid-cols-3 gap-2 mt-3">
          {mnemonic.map((w, i) => (
            <div key={i} className="p-2 bg-gray-800 rounded">{i + 1}. {w}</div>
          ))}
        </div>
      )}
    </section>
  );
}
