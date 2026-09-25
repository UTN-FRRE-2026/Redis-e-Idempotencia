import { Router } from "express";
import { createHash } from "node:crypto";
import { pool } from "../db";
import { AlmacenIdempotencia, AlmacenMemoria, AlmacenRedis } from "../idempotencia";

const INSTANCE = process.env.INSTANCE ?? "api-local";
const DEMORA_PAGO_MS = Number(process.env.PAGO_DELAY_MS ?? 1000);

// Modo elegido por query param (?modo=off|memoria|redis) para comparar en la demo sin reiniciar nada.
const almacenes: Record<string, AlmacenIdempotencia> = {
  memoria: new AlmacenMemoria(),
  redis: new AlmacenRedis(),
};

const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));
const huella = (datos: unknown) => createHash("sha256").update(JSON.stringify(datos)).digest("hex");

/** El "cobro" real: tarda (simula la pasarela de pago) y queda registrado en Postgres. */
async function procesarPago(cliente: string, monto: number) {
  await esperar(DEMORA_PAGO_MS);
  const { rows } = await pool.query(
    `INSERT INTO pagos (cliente, monto, atendido_por) VALUES ($1, $2, $3)
     RETURNING id, cliente, monto::float AS monto, atendido_por`,
    [cliente, monto, INSTANCE]
  );
  return rows[0];
}

export const pagosRouter = Router();

/**
 * POST /pagos?modo=off|memoria|redis
 * Header: Idempotency-Key: <uuid generado por el cliente, uno por cada pago>
 * Body:   { "cliente": "ana", "monto": 15000 }
 */
pagosRouter.post("/", async (req, res) => {
  const modo = String(req.query.modo ?? "redis");
  const { cliente, monto } = req.body ?? {};
  if (typeof cliente !== "string" || typeof monto !== "number" || monto <= 0) {
    return res.status(400).json({ error: "Se requiere cliente (texto) y monto (número > 0)" });
  }

  try {
    // ── MODO OFF: sin protección, cada petición cobra ─────────────────────────
    if (modo === "off") {
      const pago = await procesarPago(cliente, monto);
      console.log(`[${INSTANCE}] [off] PAGO PROCESADO id=${pago.id}`);
      return res.status(201).json({ mensaje: "Pago procesado (sin protección)", pago });
    }

    const almacen = almacenes[modo];
    if (!almacen) return res.status(400).json({ error: "modo debe ser off, memoria o redis" });

    const clave = req.header("Idempotency-Key");
    if (!clave) return res.status(400).json({ error: "Falta el header Idempotency-Key" });
    const hash = huella({ cliente, monto });

    // ── 1. Intentar reservar la clave ─────────────────────────────────────────
    const reservada = await almacen.reservar(clave, { estado: "procesando", hash });

    if (!reservada) {
      // ── 2. La clave ya existía: esto es un reintento ──────────────────────
      const previo = await almacen.obtener(clave);
      if (!previo || previo.estado === "procesando") {
        console.log(`[${INSTANCE}] [${modo}] RECHAZADO: pago en proceso (${clave})`);
        return res.status(409).json({ error: "Este pago se está procesando, reintente en unos segundos" });
      }
      if (previo.hash !== hash) {
        console.log(`[${INSTANCE}] [${modo}] RECHAZADO: misma clave con otros datos (${clave})`);
        return res.status(422).json({ error: "Idempotency-Key ya usada con datos distintos" });
      }
      console.log(`[${INSTANCE}] [${modo}] REPETIDO: devuelvo la respuesta guardada (${clave})`);
      res.setHeader("Idempotent-Replayed", "true");
      return res.status(previo.status ?? 200).json(previo.respuesta);
    }

    // ── 3. Primera vez que vemos esta clave: cobramos ────────────────────────
    try {
      const pago = await procesarPago(cliente, monto);
      const respuesta = { mensaje: "Pago procesado", pago };
      await almacen.guardar(clave, { estado: "completado", hash, status: 201, respuesta });
      console.log(`[${INSTANCE}] [${modo}] PAGO PROCESADO id=${pago.id} (${clave})`);
      return res.status(201).json(respuesta);
    } catch (err) {
      // Si el cobro falla, liberamos la clave para que el cliente pueda reintentar
      await almacen.liberar(clave);
      throw err;
    }
  } catch (err) {
    // Si no podemos verificar (ej: Redis caído), NO cobramos: preferimos fallar a duplicar
    console.error(`[${INSTANCE}] error:`, (err as Error).message);
    return res.status(503).json({ error: "No se pudo procesar el pago de forma segura" });
  }
});

/** GET /pagos?cliente=ana  →  cuántos cobros quedaron registrados en la base para ese cliente */
pagosRouter.get("/", async (req, res) => {
  const cliente = String(req.query.cliente ?? "");
  if (!cliente) return res.status(400).json({ error: "Falta ?cliente=" });
  try {
    const { rows } = await pool.query(
      "SELECT id, cliente, monto::float AS monto, atendido_por FROM pagos WHERE cliente = $1 ORDER BY id",
      [cliente]
    );
    const total = rows.reduce((s, p) => s + p.monto, 0);
    return res.json({ cliente, cantidad: rows.length, total, pagos: rows });
  } catch (err) {
    console.error(`[${INSTANCE}] error:`, (err as Error).message);
    return res.status(500).json({ error: "Error interno" });
  }
});
