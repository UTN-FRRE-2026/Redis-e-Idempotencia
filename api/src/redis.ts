import { createClient } from "redis";

// Un único cliente de Redis compartido por toda la aplicación.
export const redis = createClient({
  url: process.env.REDIS_URL ?? "redis://localhost:6379",
  // Si Redis se cae, los comandos fallan AL INSTANTE en lugar de quedar en cola esperando.
  // Así cada parte de la API decide qué hacer (la caché sigue sin Redis; los pagos se rechazan).
  disableOfflineQueue: true,
});

redis.on("error", (err: Error) => console.error("[redis] error:", err.message));

export async function connectRedis(): Promise<void> {
  await redis.connect();
  console.log("[redis] conectado");
}
