# arkade-p2p-nostr

Cliente web de Arkade P2P: libro de órdenes, chat NIP-17, escrow Ark y disputas
sobre Nostr. El navegador es una vista; la wallet, las claves y la persistencia
viven en [`arkade-p2pd`](https://github.com/Delgado74/arkade-p2pd).

## Requisitos

- Node.js 20 o superior y `pnpm`.
- Un daemon `arkade-p2pd` accesible en `ws://127.0.0.1:9100`.
- Sats **de prueba**: la configuración por defecto usa `mutinynet`, una red
  alpha. No uses fondos reales sin auditar el escrow.

## Arranque rápido

```bash
# 1. Daemon (otra terminal)
cd ../arkade-p2pd
npm install
cp settings.tpl.toml settings.toml
npm run dev

# 2. Cliente
cd ../arkade-p2p-nostr
pnpm install
cp .env.example .env
pnpm dev
```

Abre `http://localhost:5173`, crea o importa la wallet del daemon y
desbloquéala. El daemon debe permitir el origen del cliente en
`DAEMON_ALLOWED_ORIGINS` (por defecto `http://localhost:5173` ya está incluido).

## Configuración

Las variables se leen en tiempo de build (Vite). Reinicia `pnpm dev` o vuelve a
compilar tras cambiarlas.

| Variable | Por defecto | Descripción |
| --- | --- | --- |
| `VITE_ARK_OPERATOR` | `https://mutinynet.arkade.sh` | ASP de Arkade (indexer/servidor). |
| `VITE_NETWORK` | `mutinynet` | `bitcoin`, `testnet`, `signet`, `mutinynet` o `regtest`. |
| `VITE_ARBITER` | npub incorporado | Árbitro/solver por defecto; **debe coincidir en ambos peers**. |
| `VITE_RELAYS` | relays públicos | Relays separados por comas. Deben solaparse con el coordinador. |
| `VITE_COORDINATOR` | igual a `VITE_ARBITER` | Autor del registro de solvers (kind `38389`). |
| `VITE_DAEMON_URL` | `ws://127.0.0.1:9100` | RPC WebSocket del daemon. |

## Scripts

```bash
pnpm dev        # servidor de desarrollo
pnpm build      # tsc -b + vite build
pnpm preview    # sirve dist/
pnpm test       # vitest
pnpm lint       # oxlint
```

`vite.config.ts` publica con `base = "/arkade-p2p-nostr/"` en producción. Si
sirves el cliente en otra ruta, ajusta `base` y añade ese origen a
`DAEMON_ALLOWED_ORIGINS` del daemon.

## Arquitectura

- **Daemon-first**: `DaemonPool` reenvía publicaciones, consultas y
  suscripciones de relays al daemon; el navegador ya no abre sockets Nostr.
- **Persistencia**: operaciones, mensajes, escrows, disputas, ratings y marcas
  de lectura se escriben en la DB del daemon. `localStorage` queda como caché
  síncrona y fallback offline para operaciones.
- **Claves**: el daemon firma eventos, NIP-17, PSBT y mensajes Ark. El navegador
  nunca ve el mnemónico.
- **Escrow**: el acuerdo se valida antes de fondear o gastar; el estado del
  VTXO (`pending`, `spendable`, `recoverable`) bloquea operaciones inseguras.

## Seguridad

- No compartas el mnemónico ni `data/wallet.enc.json`.
- Mantén el RPC en `127.0.0.1` y una allowlist de orígenes estricta; cualquier
  origen permitido puede solicitar firmas.
- Los relays y el coordinador son límites de confianza: el registro de solvers
  decide quién puede resolver disputas de escrows nuevos.
- Prueba el flujo completo en `docs/ESCROW_RUNBOOK.md` antes de operar.

## Problemas comunes

| Síntoma | Causa probable | Solución |
| --- | --- | --- |
| `daemon unavailable` | `arkade-p2pd` apagado o URL incorrecta | Arráncalo y revisa `VITE_DAEMON_URL`. |
| El RPC rechaza el origen | Origen no permitido | Añádelo a `DAEMON_ALLOWED_ORIGINS` y reinicia. |
| No llegan DMs | Relays sin solape o daemon bloqueado | Revisa `relays.list`/`session.state` y desbloquea la wallet. |
| Escrow `pending`/`recoverable` | VTXO preconfirmado o barrido | Espera el batch o ejecuta la recuperación del runbook. |
| Wallet `locked` tras reiniciar | El daemon no guarda la passphrase | Desbloquea desde la UI. |

Runbook de escrow: [`docs/ESCROW_RUNBOOK.md`](docs/ESCROW_RUNBOOK.md).
Runbook de incidentes del daemon:
[`arkade-p2pd/docs/RUNBOOK.md`](https://github.com/Delgado74/arkade-p2pd/blob/main/docs/RUNBOOK.md).
