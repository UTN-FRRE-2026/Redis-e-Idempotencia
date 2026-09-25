import { Router } from "express";
import { redis } from "../redis";
import { pool } from "../db";

const INSTANCE = process.env.INSTANCE ?? "api-local";
const TTL_SEGUNDOS = Number(process.env.CACHE_TTL_SECONDS ?? 20);
const DEMORA_BD_MS = Number(process.env.DB_DELAY_MS ?? 500);

const claveProducto = (id: string) => `producto:${id}`;

/**
 * La caché es FAIL-OPEN: si Redis no responde, seguimos sin ella (más lento, pero funciona).
 * Nunca debe romper la lectura, porque el dato real está en Postgres.
 */
async function leerCache(clave: string): Promise<string | null> {
  try {
    return await redis.get(clave);
  } catch {
    console.warn(`[${INSTANCE}] Redis no disponible: consulto directo a Postgres`);
    return null;
  }
}
async function escribirCache(clave: string, valor: string): Promise<void> {
  try {
    await redis.set(clave, valor, { EX: TTL_SEGUNDOS });
  } catch {
    /* sin caché no pasa nada grave */
  }
}
async function invalidarCache(clave: string): Promise<void> {
  try {
    await redis.del(clave);
  } catch {
    // Limitación: si Redis vuelve con la copia vieja, se verá el dato viejo hasta que venza el TTL
    console.warn(`[${INSTANCE}] No se pudo invalidar ${clave}: se corregirá al vencer el TTL`);
  }
}

export const productosRouter = Router();

/**
 * GET /productos/:id  →  patrón CACHE-ASIDE
 * 1. Buscar en Redis.            Si está → HIT (rápido).
 * 2. Si no está → ir a Postgres  (lento, simulamos 500 ms).
 * 3. Guardar el resultado en Redis con TTL y responder → MISS.
 */
productosRouter.get("/:id", async (req, res) => {
  const { id } = req.params;
  if (!/^\d+$/.test(id)) return res.status(400).json({ error: "id inválido" });
  const clave = claveProducto(id);

  try {
    // 1. ¿Está en la caché?
    const enCache = await leerCache(clave);
    if (enCache) {
      console.log(`[${INSTANCE}] CACHE HIT  ${clave}`);
      res.setHeader("X-Cache", "HIT");
      return res.json({ origen: "cache", producto: JSON.parse(enCache) });
    }

    // 2. No está: consultamos la base de datos (simulamos que es lenta)
    console.log(`[${INSTANCE}] CACHE MISS ${clave} → consultando Postgres`);
    await pool.query("SELECT pg_sleep($1)", [DEMORA_BD_MS / 1000]);
    const { rows } = await pool.query(
      "SELECT id, nombre, precio::float AS precio, stock FROM productos WHERE id = $1",
      [id]
    );
    if (rows.length === 0) return res.status(404).json({ error: "Producto no encontrado" });

    // 3. Guardamos una copia en Redis que se borra sola después de TTL_SEGUNDOS
    await escribirCache(clave, JSON.stringify(rows[0]));
    res.setHeader("X-Cache", "MISS");
    return res.json({ origen: "base de datos", producto: rows[0] });
  } catch (err) {
    console.error(`[${INSTANCE}] error:`, (err as Error).message);
    return res.status(500).json({ error: "Error interno" });
  }
});

/**
 * PUT /productos/:id  →  INVALIDACIÓN
 * Primero se actualiza la fuente de verdad (Postgres) y después se BORRA la copia en Redis,
 * para que la próxima lectura traiga el dato nuevo.
 */
productosRouter.put("/:id", async (req, res) => {
  const { id } = req.params;
  if (!/^\d+$/.test(id)) return res.status(400).json({ error: "id inválido" });
  const { precio, stock } = req.body ?? {};

  try {
    const { rows } = await pool.query(
      `UPDATE productos
          SET precio = COALESCE($1, precio), stock = COALESCE($2, stock)
        WHERE id = $3
    RETURNING id, nombre, precio::float AS precio, stock`,
      [precio ?? null, stock ?? null, id]
    );
    if (rows.length === 0) return res.status(404).json({ error: "Producto no encontrado" });

    await invalidarCache(claveProducto(id));
    console.log(`[${INSTANCE}] CACHE INVALIDADA ${claveProducto(id)}`);
    res.setHeader("X-Cache", "INVALIDATED");
    return res.json({ mensaje: "Producto actualizado y caché invalidada", producto: rows[0] });
  } catch (err) {
    console.error(`[${INSTANCE}] error:`, (err as Error).message);
    return res.status(500).json({ error: "Error interno" });
  }
});
