# AGENTS.md — arkade-p2p-nostr

## Descripción

Cliente web (React + TypeScript + Vite) para un mercado P2P sobre Nostr con
escrow en Arkade. La UI no custodia claves: toda firma Nostr/Ark y el manejo de
la wallet se delegan al daemon local `arkade-p2pd` vía RPC WebSocket.

## Arquitectura

- `src/App.tsx`: composición principal, feed de DMs, operaciones y navegación.
- `src/components/`: UI por dominio (`TradePanel`, `ChatPanel`, `OrderBook`,
  `SolverInbox`, `EscrowHarness`, etc.).
- `src/lib/protocol.ts`: contrato Nostr. Define kinds, plantillas de eventos,
  parsers y validadores runtime.
- `src/lib/nostr.ts`: `NostrClient`: consulta, publicación, suscripciones y
  aplicación de borrados NIP-09.
- `src/lib/identity.ts`: identidad pública + signer Ark respaldado por el daemon.
- `src/lib/daemon/client.ts`: cliente JSON-RPC del daemon.
- `src/lib/escrow.ts` / `escrowHandler.ts` / `escrowWallet.ts`: construcción,
  fondeo y gasto del escrow Arkade.
- `src/lib/trade.ts`: mensajes de trade (DMs NIP-17), tipos y validación runtime.
- `src/lib/chat.ts` / `solver.ts` / `reputation.ts`: salas de chat y disputas,
  bandeja del solver y reputación verificable.
- `src/lib/operations.ts`: registros locales de operaciones.

## Comandos

```bash
pnpm install
pnpm dev          # Vite en desarrollo
pnpm build        # tsc -b + vite build
pnpm lint         # oxlint
pnpm test         # vitest run
pnpm test:watch   # vitest en watch
```

Antes de cerrar un cambio ejecutar, como mínimo:

```bash
npx tsc -b && pnpm test && pnpm build && pnpm lint
```

Los warnings de `react(preserve-manual-memoization)` son conocidos; no introducir
nuevos errores de lint ni warnings de `exhaustive-deps`.

## Convenciones

- TypeScript estricto, módulos ESM, comillas dobles y punto y coma.
- Componentes funcionales con hooks; no añadir clases ni estado global nuevo sin
  necesidad.
- Nombres de archivos en kebab-case; componentes en PascalCase.
- Mantener los comentarios existentes cuando explican decisiones de seguridad o
  protocolo; no añadir comentarios obvios.
- Preferir utilidades ya existentes (`protocol.ts`, `escrow.ts`, `trade.ts`) antes
  de duplicar lógica.
- Los parsers deben ser tolerantes a datos de relays solo en lo que el protocolo
  permita: validar tipos, longitudes, hex64, estados y límites antes de exponer
  datos a la UI.

## Protocolo y contrato entre repos

- Plataforma: `y = "arkade-p2p"`.
- Orden: kind `38383`, addressable con `d`.
- Rating: kind `38384`, `d = "<orderId>:<ratee>"`, requiere `e`, `p`, `rating`,
  `role`, `y`, `z`.
- Take de disputa: kind `38387`, `e` apunta al **event id del anuncio**, no al
  order id; `solver` debe ser igual al autor del evento.
- Resolución de disputa: kind `38388`, también ligada al anuncio y al solver
  ganador.
- Registro de solvers: kind `38389`, `d = "solvers"` (o `solvers:<comunidad>` en
  etapa 2), autorizado por el coordinador configurado.
- Anuncio de disputa: kind `38390`.
- Los mensajes de trade viajan como DMs NIP-17; el campo `from` del payload debe
  coincidir con el autor real de la DM.

Si cambia el formato del registro de solvers, actualizar en conjunto:
`arkade-p2p-coordinator/src/schema.ts` y `src/lib/protocol.ts` de este repo.

## Seguridad

- El navegador nunca debe recibir mnemónico, `nsec` ni claves privadas.
- No registrar secretos, macaroons, payloads privados ni direcciones completas
  en logs.
- El RPC del daemon se protege por allowlist de `Origin`; no asumir autenticación
  adicional.
- Una UI servida por HTTPS no puede abrir `ws://127.0.0.1:9100` por mixed
  content. Para despliegues reales usar un origen/transporte compatible.
- Filtrar siempre takes/resoluciones por anuncio y solver autorizado; un take
  sin anuncio o de un solver fuera del set del escrow no es válido.
- Los ratings solo cuentan para órdenes `success`, sin self-rating y con rol
  coherente con el lado del rater.
- NIP-09: un borrado solo aplica si lo firma el mismo autor del evento
  referenciado; no confiar en el `kind 5` de terceros.
- Validar runtime todo dato que venga de relays o DMs antes de usarlo.

## Testing

- Tests unitarios junto al código: `src/lib/*.test.ts`.
- Cubrir parsers/validadores con casos malformados, límites y eventos firmados
  por claves no autorizadas.
- Para cambios de escrow o firmas, añadir tests puros cuando sea posible y
  documentar lo que requiere prueba manual en mutinynet.

## Git

- Commits convencionales: `feat(...)`, `fix(...)`, `test(...)`, `chore(...)`.
- No commitear `.env`, secretos, `dist/` ni artefactos de build.
- No hacer `push` ni `force-push` sin que el usuario lo pida explícitamente.
