import { Router } from "express";
import { redis } from "../redis";
import { pool } from "../db";
import { reenviarEvento } from "../eventos";

const INSTANCE = process.env.INSTANCE ?? "api-local";

export const adminRouter = Router();

/**
 * GET /admin/estado  →  semáforo de salud para la barra superior del panel.
 * Cada chequeo va en su propio try/catch: la ruta DEBE responder 200 aunque
 * Redis esté caído (sino el panel no podría mostrar "Redis: caído").
 */
adminRouter.get("/estado", async (_req, res) => {
  let redisOk = false;
  let postgresOk = false;
  let workerOk = false;
  try {
    redisOk = (await redis.ping()) === "PONG";
  } catch {
    /* Redis caído */
  }
  try {
    await pool.query("SELECT 1");
    postgresOk = true;
  } catch {
    /* Postgres caído */
  }
  try {
    // El worker refresca worker:heartbeat con TTL de 5 s. Si la clave existe, está vivo.
    workerOk = (await redis.exists("worker:heartbeat")) === 1;
  } catch {
    /* sin Redis no sabemos del worker */
  }
  res.json({ instancia: INSTANCE, redis: redisOk, postgres: postgresOk, worker: workerOk });
});

/**
 * GET /admin/redis  →  "Redis por dentro": las claves guardadas en este momento.
 * Usa SCAN (nunca KEYS *). Si Redis cae, responde 503 { disponible: false }.
 */
adminRouter.get("/redis", async (_req, res) => {
  try {
    // 1. Recorremos el keyspace con SCAN en tandas de 100.
    const todas: string[] = [];
    let cursor = 0;
    do {
      const r = await redis.scan(cursor, { COUNT: 100 });
      cursor = r.cursor;
      todas.push(...r.keys);
    } while (cursor !== 0 && todas.length < 500);

    // 2. Ocultamos las claves internas (config, worker/heartbeat/log) y limitamos a 50.
    const visibles = todas
      .filter((k) => !k.startsWith("config:") && !k.startsWith("worker:"))
      .slice(0, 50);

    // 3. Por cada clave: tipo, TTL y un "detalle" según de qué clave se trate.
    const claves = await Promise.all(
      visibles.map(async (clave) => {
        const tipo = await redis.type(clave);
        const ttl = await redis.ttl(clave);
        let detalle: string | null = null;
        if (clave.startsWith("idem:")) {
          // Para una clave de idempotencia mostramos el estado guardado (procesando/completado).
          const v = await redis.get(clave);
          if (v) {
            try {
              detalle = (JSON.parse(v) as { estado?: string }).estado ?? null;
            } catch {
              /* valor no-JSON */
            }
          }
        } else if (tipo === "stream") {
          // Para la cola mostramos cuántos mensajes tiene.
          detalle = `${await redis.xLen(clave)} mensajes`;
        }
        return { clave, tipo, ttl, detalle };
      })
    );

    // 4. Las recién creadas primero: ordenamos por TTL descendente.
    //    Las claves sin TTL (-1, como el stream) quedan al final.
    claves.sort((a, b) => {
      const ta = a.ttl < 0 ? -1 : a.ttl;
      const tb = b.ttl < 0 ? -1 : b.ttl;
      return tb - ta;
    });

    res.json({ disponible: true, claves });
  } catch {
    res.status(503).json({ disponible: false });
  }
});

/** GET /admin/dedup  →  estado del interruptor de deduplicación (por defecto "on"). */
adminRouter.get("/dedup", async (_req, res) => {
  try {
    const dedup = (await redis.get("config:dedup")) ?? "on";
    res.json({ dedup });
  } catch {
    res.status(503).json({ error: "Redis no disponible" });
  }
});

/** POST /admin/dedup  { dedup: "on" | "off" }  →  guarda el interruptor en config:dedup. */
adminRouter.post("/dedup", async (req, res) => {
  const dedup = req.body?.dedup;
  if (dedup !== "on" && dedup !== "off") {
    return res.status(400).json({ error: "dedup debe ser 'on' u 'off'" });
  }
  try {
    await redis.set("config:dedup", dedup);
    res.json({ dedup });
  } catch {
    res.status(503).json({ error: "Redis no disponible" });
  }
});

/** POST /admin/reenviar  { eventoId }  →  simula que la cola reentrega el mensaje. 404 si no existe. */
adminRouter.post("/reenviar", async (req, res) => {
  const eventoId = req.body?.eventoId;
  if (typeof eventoId !== "string" || !eventoId) {
    return res.status(400).json({ error: "Falta eventoId" });
  }
  try {
    const ok = await reenviarEvento(eventoId);
    if (!ok) return res.status(404).json({ error: "No se encontró el evento en la cola" });
    res.json({ ok: true });
  } catch {
    res.status(503).json({ error: "Redis no disponible" });
  }
});

/** GET /admin/worker-log  →  los últimos 30 resultados del worker, ya parseados. */
adminRouter.get("/worker-log", async (_req, res) => {
  try {
    const crudo = await redis.lRange("worker:log", 0, 29);
    const log = crudo
      .map((s) => {
        try {
          return JSON.parse(s);
        } catch {
          return null;
        }
      })
      .filter((x) => x !== null);
    res.json({ log });
  } catch {
    res.status(503).json({ error: "Redis no disponible" });
  }
});

/**
 * POST /admin/reset  →  deja la demo como al principio.
 * (1) vacía pagos y emails, (2) restaura los productos, (3) borra las claves de la demo,
 * (4) vacía la cola. NO borra el stream ni el grupo, porque el worker los necesita.
 */
adminRouter.post("/reset", async (_req, res) => {
  try {
    await pool.query("TRUNCATE pagos, emails RESTART IDENTITY");

    // Restauramos los productos a los valores de init.sql (UPDATE por id).
    await pool.query("UPDATE productos SET precio = $1, stock = $2 WHERE id = 1", [45000, 12]);
    await pool.query("UPDATE productos SET precio = $1, stock = $2 WHERE id = 2", [18000, 30]);
    await pool.query("UPDATE productos SET precio = $1, stock = $2 WHERE id = 3", [210000, 5]);

    // Borramos con SCAN + DEL (nunca KEYS *) las claves que genera la demo.
    for (const patron of ["idem:*", "producto:*", "dedup:*"]) {
      let cursor = 0;
      do {
        const r = await redis.scan(cursor, { MATCH: patron, COUNT: 100 });
        cursor = r.cursor;
        if (r.keys.length) await redis.del(r.keys);
      } while (cursor !== 0);
    }
    await redis.del("worker:log");

    // Vaciamos el stream pero SIN borrarlo (el worker y su grupo siguen vivos).
    await redis.xTrim("pagos:eventos", "MAXLEN", 0);

    res.json({ ok: true });
  } catch (err) {
    console.error(`[${INSTANCE}] error en reset:`, (err as Error).message);
    res.status(500).json({ error: "No se pudo reiniciar la demo" });
  }
});
