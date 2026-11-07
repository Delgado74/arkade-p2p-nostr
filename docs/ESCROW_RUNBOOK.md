# Runbook de escrow y recuperación (mutinynet)

Prueba manual de la Fase 2.2. Usa **solo fondos de prueba**: mutinynet es una
red alpha. No ejecutes este runbook con sats reales.

## 1. Preparación

Requisitos:

- Un daemon `arkade-p2pd` con wallet desbloqueada.
- Dos identidades distintas (dos perfiles de navegador o dos dispositivos).
- Un solver registrado por el coordinador, o el fallback `VITE_ARBITER`.
- Sats de prueba en la wallet de cada identidad.

Terminales:

```bash
# Terminal 1: daemon
cd /home/islabtc/arkadenostrp/arkade-p2pd
npm install
npm run dev

# Terminal 2: cliente
cd /home/islabtc/arkadenostrp/arkade-p2p-nostr
pnpm install
pnpm dev
```

Comprueba en `.env` local:

```dotenv
VITE_NETWORK=mutinynet
VITE_ARK_OPERATOR=https://mutinynet.arkade.sh
VITE_DAEMON_URL=ws://127.0.0.1:9100
VITE_ARBITER=npub...   # el mismo en ambos clientes
VITE_COORDINATOR=npub... # el que publica el registro de solvers
```

Abre `http://localhost:5173` en los dos perfiles. En cada uno:

1. Crea o importa la wallet del daemon y desbloquéala.
2. Verifica que la app muestra el ASP conectado y tu dirección Ark.
3. No compartas mnemónicos ni el contenido de `data/wallet.enc.json`.

## 2. Comprobaciones previas al fondeo

Antes de enviar sats, confirma en ambos lados:

- El acuerdo lleva `escrowVersion: 1`.
- `refundLocktime` es un Unix timestamp absoluto, no una duración ni una altura
  de bloque.
- El locktime está entre 5 minutos y 7 días en el futuro al crear el acuerdo.
- La clave `serverPubKey` coincide con el ASP conectado.
- Todos los solvers de `arbiterPubKeys` están en el registro del coordinador.
- `tradeSats`, `fiat`, `fiatAmount` y las claves de comprador/vendedor coinciden
  con la orden.
- La dirección Ark derivada es idéntica en comprador y vendedor.

Si cualquiera falla, **no fondees**.

## 3. Liberación cooperativa

1. El vendedor publica una orden de venta.
2. El comprador la toma y entrega su dirección Ark de cobro.
3. El vendedor construye el acuerdo y publica el escrow.
4. El vendedor fondea la dirección del escrow con **exactamente** `tradeSats`.
5. Ambos esperan a que el VTXO pase de `pending` (preconfirmado) a `spendable`.
6. El comprador paga el fiat por el canal acordado y marca `fiat_sent`.
7. El vendedor genera `release_request`.
8. El comprador verifica destino y monto, y co-firma.
9. El vendedor envía la transacción co-firmada y se muestra `release_done`.

Verifica:

- El comprador recibe exactamente `tradeSats`.
- El `arkTxid` es el mismo en ambos clientes.
- La operación queda `completed`.
- La orden pública queda en estado `success`.

## 4. Cancelación

Antes del fondeo:

1. Una parte envía `cancel_request`.
2. La otra responde `cancel_agree`.
3. La operación queda `canceled` y no se fondea nada.

Después del fondeo no existe cancelación unilateral: si no hay acuerdo, se usa
la liberación, la disputa o el reembolso tras el CLTV.

## 5. Disputa

1. El comprador paga fiat y no recibe liberación.
2. El comprador abre una disputa; se publica el anuncio y se envía el acuerdo
   cifrado a los solvers.
3. Un solver toma la disputa.
4. El solver pide las direcciones Ark autenticadas a ambas partes.
5. Cada parte responde con `ark_address` firmado por su propia clave.
6. El solver decide `release_to_buyer` o `refund_to_seller`.
7. El solver gasta por su hoja `arbiter:<solver>` y publica `arbiter_decision`.

Verifica:

- El solver pertenece al set comprometido en el escrow.
- La dirección de pago es la autenticada, no una enviada por la contraparte.
- El `arkTxid` coincide en ambos clientes.
- La operación queda `arbiter-release` o `arbiter-refund`.

## 6. Reembolso del vendedor

1. Espera a que `chainTime >= refundLocktime`.
2. El vendedor pulsa reembolso.
3. La app gasta por la hoja `refund` (vendedor + ASP) y envía `arkTxid`.

Verifica que el pago va a la dirección Ark del vendedor y que el comprador no
puede liberar después.

## 7. Recuperación de un VTXO barrido

Un VTXO barrido (`isSwept`) no se puede gastar por su hoja normal: hay que
recuperarlo con una liquidación usando la hoja `refund` como forfeit.

1. Confirma que la UI muestra el escrow como `recoverable`.
2. Confirma que el CLTV ya venció (`chainTime >= refundLocktime`).
3. Solo el vendedor (quien fondeó) pulsa recuperar.
4. La app crea una wallet temporal, registra el contrato y llama a
   `recoverVtxos`.
5. El escrow se asienta en la dirección personal del vendedor.
6. Anota el `txid` de recuperación.

Antes del CLTV la recuperación debe fallar o no ofrecer la hoja `refund`; nunca
debe gastar el escrow. Después del CLTV debe poder recuperarse sin depender de
`localStorage`.

### Si el ASP no responde

- No borres ni recrees la wallet: la recuperación necesita la misma identidad.
- Conserva el acuerdo completo (`escrowVersion`, claves, solver set y
  `refundLocktime`).
- Reintenta cuando el ASP vuelva; la liquidación es idempotente.
- Si el ASP no vuelve, documenta el outpoint y el acuerdo para una salida
  unilateral. No inventes un locktime nuevo.

## 8. Doble gasto, replay y orden

- Intenta reenviar el mismo `release_request` o `take`: la operación terminada
  no debe reabrirse.
- Intenta resolver dos veces la misma disputa: solo un `arkTxid` debe quedar
  como válido.
- Reordena o duplica DMs en la feed: el estado no debe cambiar dos veces.
- Comprueba que un DM de otra orden o de otro autor no altera la operación.
- Si el índice muestra un VTXO ya gastado, no se debe poder firmar otro gasto
  sobre él.

## 9. Checklist final

- [ ] Mismo acuerdo ⇒ misma dirección en ambos clientes.
- [ ] Locktime ausente, no numérico o fuera de rango ⇒ rechazo.
- [ ] Solver fuera del registro ⇒ rechazo.
- [ ] ASP distinto ⇒ rechazo.
- [ ] VTXO `pending` ⇒ no se gasta.
- [ ] VTXO `recoverable` ⇒ no se gasta; se recupera tras el CLTV.
- [ ] Monto fondeado distinto ⇒ no se libera.
- [ ] `release`, `refund` y `arbiter` pagan exactamente a la dirección prevista.
- [ ] Replay/duplicados no reabren una operación terminada.
- [ ] Txids anotados y verificables en el explorador de mutinynet.

## 10. Registro de la prueba

Anota por escenario:

```text
fecha:
red: mutinynet
orderId:
escrowVersion: 1
refundLocktime:
escrow address:
txid de fondeo:
txid de liberación/reembolso/disputa:
txid de recuperación:
resultado:
incidencias:
```
