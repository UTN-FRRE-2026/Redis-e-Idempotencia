// Fase 4: deduplicación de mensajes (plan B por terminal, por si falla el panel).
// La cola (Redis Streams) puede entregar el MISMO evento dos veces. El worker usa el
// `eventoId` para no mandar el comprobante duplicado.
//   - dedup OFF: el reenvío genera 2 emails (el cliente recibe el comprobante dos veces).
//   - dedup ON:  el reenvío se descarta → 1 solo email.
// Uso: node demo/05_dedup.mjs
import { randomUUID } from "node:crypto";
import { BASE, paso, pagar, esperar } from "./lib.mjs";

const MONTO = 15000;

/** Prende o apaga la deduplicación (config:dedup en Redis, vía el panel/API). */
async function setDedup(valor) {
  await fetch(`${BASE}/admin/dedup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dedup: valor }),
  });
}

/** Simula que la cola reentrega el mismo mensaje (mismo eventoId). */
async function reenviar(eventoId) {
  const res = await fetch(`${BASE}/admin/reenviar`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ eventoId }),
  });
  return res.ok;
}

/** Bandeja de entrada del cliente: cuántos comprobantes recibió. */
async function emailsDe(cliente) {
  const res = await fetch(`${BASE}/emails?cliente=${encodeURIComponent(cliente)}`);
  return res.json();
}

async function escenario(dedup, esperado) {
  paso(`Deduplicación ${dedup.toUpperCase()} → esperamos ${esperado} email(s)`);
  await setDedup(dedup);

  const cliente = `cliente-dedup-${dedup}-${Date.now()}`;
  const clave = randomUUID();

  // 1. Pago real en modo redis: la API publica el evento y nos devuelve su eventoId.
  const r = await pagar({ modo: "redis", clave, cliente, monto: MONTO });
  const eventoId = r.body.eventoId;
  console.log(`Pago cobrado → id=${r.body.pago?.id} | eventoId=${eventoId}`);

  // 2. Esperamos a que el worker envíe el primer comprobante.
  await esperar(1200);

  // 3. La cola entrega el mismo mensaje otra vez.
  console.log("La cola entrega el mensaje de nuevo (reenviamos el evento)...");
  await reenviar(eventoId);
  await esperar(1200);

  // 4. ¿Cuántos emails recibió el cliente?
  const { cantidad } = await emailsDe(cliente);
  const ok = cantidad === esperado;
  console.log(`Emails recibidos: ${cantidad} (esperado ${esperado}) → ${ok ? "✅ correcto" : "❌ revisar"}`);
  if (dedup === "on") {
    console.log("El worker descartó el reenvío: ver 'DUPLICADO DESCARTADO' en docker compose logs -f worker");
  } else {
    console.log("Sin deduplicación, el cliente recibió el comprobante DOS veces.");
  }
}

await escenario("off", 2);
await escenario("on", 1);

paso("Dejamos la deduplicación en ON");
await setDedup("on");
console.log("Listo.");
