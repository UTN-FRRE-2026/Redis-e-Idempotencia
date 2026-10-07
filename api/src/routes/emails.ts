import { Router } from "express";
import { pool } from "../db";

const INSTANCE = process.env.INSTANCE ?? "api-local";

export const emailsRouter = Router();

/**
 * GET /emails?cliente=ana
 * Devuelve los comprobantes "enviados" por el worker a ese cliente.
 * El panel lo usa como "bandeja de entrada": si hay dos filas con el mismo evento_id,
 * el cliente recibió el comprobante duplicado.
 */
emailsRouter.get("/", async (req, res) => {
  const cliente = String(req.query.cliente ?? "");
  if (!cliente) return res.status(400).json({ error: "Falta ?cliente=" });
  try {
    const { rows } = await pool.query(
      `SELECT id, evento_id, pago_id, monto::float AS monto, enviado_en
         FROM emails WHERE cliente = $1 ORDER BY id`,
      [cliente]
    );
    return res.json({ cliente, cantidad: rows.length, emails: rows });
  } catch (err) {
    console.error(`[${INSTANCE}] error:`, (err as Error).message);
    return res.status(500).json({ error: "Error interno" });
  }
});
