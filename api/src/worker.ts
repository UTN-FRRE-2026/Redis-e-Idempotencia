import { createClient } from "redis";
import { Pool } from "pg";
import { SQL_TABLA_EMAILS } from "./db";

// ─────────────────────────────────────────────────────────────────────────────
// Worker: consume el stream "pagos:eventos" y "envía el email" del comprobante.
// Es un proceso aparte (misma imagen que la API, pero arranca con node dist/worker.js).
//
// DEDUPLICACIÓN: puede llegar el MISMO evento dos veces (la cola reentrega el mensaje).
// Para no mandar el comprobante duplicado usamos `eventoId`, un id PROPIO del evento:
// un mensaje reenviado trae un id de stream NUEVO, pero conserva el mismo `eventoId`.
// ─────────────────────────────────────────────────────────────────────────────

const STREAM = "pagos:eventos";
const GRUPO = "emails";          // grupo de consumidores
const CONSUMIDOR = "worker-1";   // nombre de este consumidor dentro del grupo
const DEDUP_TTL = Number(process.env.DEDUP_TTL_SECONDS ?? 86400);
const EMAIL_DELAY_MS = Number(process.env.EMAIL_DELAY_MS ?? 300);

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://tp1:tp1@localhost:5432/tienda";

const esperar = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Cliente normal para comandos sueltos y otro DEDICADO para la lectura bloqueante,
// porque XREADGROUP ... BLOCK ocupa la conexión mientras espera que lleguen mensajes.
const redis = createClient({ url: REDIS_URL });
const bloqueante = redis.duplicate();
const pool = new Pool({ connectionString: DATABASE_URL });

redis.on("error", (err: Error) => console.error("[worker] redis error:", err.message));
bloqueante.on("error", (err: Error) => console.error("[worker] redis(bloqueante) error:", err.message));

/** Lo que guardamos por cada evento procesado, para que el panel lo muestre. */
interface EntradaLog {
  eventoId: string;
  pagoId: string;
  cliente: string;
  resultado: "enviado" | "duplicado descartado" | "error";
  dedup: string;
  ts: number;
}

/** Deja el resultado en una lista corta (máx. 30) que el panel lee por /admin/worker-log. */
async function registrarLog(entrada: EntradaLog): Promise<void> {
  await redis.lPush("worker:log", JSON.stringify(entrada));
  await redis.lTrim("worker:log", 0, 29);
}

/** Crea el grupo de consumidores. Si ya existe (BUSYGROUP), lo ignora. */
async function crearGrupo(): Promise<void> {
  try {
    await redis.xGroupCreate(STREAM, GRUPO, "0", { MKSTREAM: true });
    console.log(`[worker] grupo de consumidores "${GRUPO}" creado`);
  } catch (err) {
    if ((err as Error).message.includes("BUSYGROUP")) return; // el grupo ya existía
    throw err;
  }
}

/** Procesa un mensaje del stream: deduplica, "envía" el email e inserta en la base. */
async function procesarMensaje(id: string, message: Record<string, string>): Promise<void> {
  const { eventoId, pagoId, cliente, monto } = message;

  // El interruptor de deduplicación lo controla el panel (config:dedup). Por defecto, "on".
  const dedup = (await redis.get("config:dedup")) ?? "on";

  let marcado = false; // true si anotamos dedup:<eventoId> en este intento
  if (dedup === "on") {
    // SET dedup:<eventoId> 1 NX EX 86400
    // NX = "solo si NO existe". Si devuelve null, ya procesamos este eventoId → es un duplicado.
    const ok = await redis.set(`dedup:${eventoId}`, "1", { NX: true, EX: DEDUP_TTL });
    if (ok === null) {
      await registrarLog({ eventoId, pagoId, cliente, resultado: "duplicado descartado", dedup, ts: Date.now() });
      console.log(`[worker] DUPLICADO DESCARTADO evento=${eventoId}`);
      await redis.xAck(STREAM, GRUPO, id); // igual confirmamos el mensaje: ya lo manejamos
      return;
    }
    marcado = true;
  }

  // "Enviar el email": simulamos la demora y lo registramos en Postgres.
  try {
    await esperar(EMAIL_DELAY_MS);
    await pool.query(
      "INSERT INTO emails (evento_id, pago_id, cliente, monto) VALUES ($1, $2, $3, $4)",
      [eventoId, Number(pagoId), cliente, Number(monto)]
    );
  } catch (err) {
    // El email NO salió. Si ya habíamos anotado el evento como procesado, lo borramos:
    // si no, un reenvío se descartaría como "duplicado" aunque el cliente nunca recibió nada.
    if (marcado) await redis.del(`dedup:${eventoId}`).catch(() => {});
    await registrarLog({ eventoId, pagoId, cliente, resultado: "error", dedup, ts: Date.now() }).catch(() => {});
    console.error(`[worker] NO SE PUDO ENVIAR evento=${eventoId}: ${(err as Error).message}`);
    throw err;
  }
  await registrarLog({ eventoId, pagoId, cliente, resultado: "enviado", dedup, ts: Date.now() });
  console.log(`[worker] EMAIL ENVIADO evento=${eventoId} pago=${pagoId}`);
  await redis.xAck(STREAM, GRUPO, id);
}

/** Bucle principal: lee del stream en bloque y procesa los mensajes nuevos. */
async function bucle(): Promise<void> {
  for (;;) {
    try {
      // XREADGROUP GROUP emails worker-1 COUNT 10 BLOCK 2000 STREAMS pagos:eventos >
      // ">" = "solo mensajes nuevos, todavía no entregados a este grupo".
      const respuesta = await bloqueante.xReadGroup(
        GRUPO,
        CONSUMIDOR,
        { key: STREAM, id: ">" },
        { COUNT: 10, BLOCK: 2000 }
      );
      if (!respuesta) continue; // venció el BLOCK sin mensajes: volvemos a esperar
      for (const stream of respuesta) {
        for (const { id, message } of stream.messages) {
          await procesarMensaje(id, message);
        }
      }
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes("NOGROUP")) {
        // Alguien borró el stream o el grupo: lo recreamos y seguimos.
        console.warn("[worker] NOGROUP: recreo el grupo de consumidores");
        await crearGrupo();
        continue;
      }
      // Si Redis no responde, no terminamos el proceso: esperamos y reintentamos.
      console.error("[worker] error en el bucle:", msg);
      await esperar(2000);
    }
  }
}

async function main(): Promise<void> {
  await redis.connect();
  await bloqueante.connect();
  console.log("[worker] conectado a Redis y Postgres");
  await pool.query(SQL_TABLA_EMAILS).catch((e) => console.warn("[worker] tabla emails:", e.message));
  await crearGrupo();

  // Heartbeat: cada 2 s refrescamos worker:heartbeat con TTL de 5 s.
  // El panel lo usa para saber si el worker está vivo (/admin/estado).
  setInterval(() => {
    redis.set("worker:heartbeat", String(Date.now()), { EX: 5 }).catch(() => {
      /* si Redis está caído, el latido se pierde: no pasa nada grave */
    });
  }, 2000);

  await bucle();
}

main().catch((err) => {
  console.error("[worker] fatal:", err);
  process.exit(1);
});
