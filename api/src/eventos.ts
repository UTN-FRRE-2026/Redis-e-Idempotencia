import { randomUUID } from "node:crypto";
import { redis } from "./redis";

// Stream (cola de Redis) donde la API publica un evento cada vez que cobra un pago.
// El worker lo consume para "enviar el email" del comprobante.
const STREAM = "pagos:eventos";

/** Datos mínimos del pago que viajan en el evento. */
export interface PagoEvento {
  id: number;
  cliente: string;
  monto: number;
}

/**
 * Publica un evento de "pago cobrado" en el stream.
 *
 * Genera un `eventoId` PROPIO del evento (independiente del id que asigna el stream),
 * porque la deduplicación del worker se basa en ESE id y no en el del mensaje de la cola:
 * un mensaje reenviado recibe un id de stream nuevo, pero conserva el mismo `eventoId`.
 *
 * Devuelve el `eventoId` para poder guardarlo en la respuesta del pago.
 */
export async function publicarEventoPago(pago: PagoEvento): Promise<string> {
  const eventoId = randomUUID();
  // XADD pagos:eventos * eventoId <id> pagoId <id> cliente <c> monto <m>
  await redis.xAdd(STREAM, "*", {
    eventoId,
    pagoId: String(pago.id),
    cliente: pago.cliente,
    monto: String(pago.monto),
  });
  return eventoId;
}

/**
 * Reenvía un evento ya publicado: busca sus campos en el stream y vuelve a hacer XADD
 * con los MISMOS campos (mismo `eventoId`). Simula que la cola entregó el mensaje dos veces.
 * Devuelve `false` si no encuentra el evento.
 */
export async function reenviarEvento(eventoId: string): Promise<boolean> {
  // XREVRANGE recorre el stream desde el más nuevo al más viejo.
  const mensajes = await redis.xRevRange(STREAM, "+", "-", { COUNT: 500 });
  const original = mensajes.find((m) => m.message.eventoId === eventoId);
  if (!original) return false;
  await redis.xAdd(STREAM, "*", original.message);
  return true;
}
