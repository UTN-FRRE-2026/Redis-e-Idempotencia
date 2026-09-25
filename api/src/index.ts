import express from "express";
import { redis, connectRedis } from "./redis";
import { pool } from "./db";
import { productosRouter } from "./routes/productos";
import { pagosRouter } from "./routes/pagos";

const INSTANCE = process.env.INSTANCE ?? "api-local";
const PORT = Number(process.env.PORT ?? 3000);

const app = express();
app.use(express.json());

// Cada respuesta indica qué réplica la atendió. Clave para mostrar el balanceo en la demo.
app.use((req, res, next) => {
  res.setHeader("X-Instance", INSTANCE);
  console.log(`[${INSTANCE}] ${req.method} ${req.url}`);
  next();
});

// Verifica que la réplica puede hablar con Redis y con Postgres.
app.get("/health", async (_req, res) => {
  try {
    const redisPing = await redis.ping();
    const db = await pool.query("SELECT 1 AS ok");
    res.json({
      instancia: INSTANCE,
      redis: redisPing,
      postgres: db.rows[0].ok === 1 ? "OK" : "ERROR",
    });
  } catch (err) {
    res.status(503).json({ instancia: INSTANCE, error: (err as Error).message });
  }
});

app.use("/productos", productosRouter);
app.use("/pagos", pagosRouter);

async function main(): Promise<void> {
  await connectRedis();
  app.listen(PORT, () => console.log(`[${INSTANCE}] escuchando en el puerto ${PORT}`));
}

main().catch((err) => {
  console.error("Error al iniciar:", err);
  process.exit(1);
});
