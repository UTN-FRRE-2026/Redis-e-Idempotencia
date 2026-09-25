// Funciones compartidas por los scripts de demo.
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const BASE = process.env.BASE_URL ?? "http://localhost:8080";
const RAIZ = fileURLToPath(new URL("..", import.meta.url));
const REDIS_CLI = process.env.REDIS_CLI ?? "docker compose exec -T redis redis-cli";

export const redisCli = (cmd) => execSync(`${REDIS_CLI} ${cmd}`, { cwd: RAIZ }).toString().trim();
export const paso = (titulo) => console.log(`\n=== ${titulo} ===`);

/** Envía un pago. Devuelve status, réplica que atendió y si fue una respuesta repetida. */
export async function pagar({ modo, clave, cliente, monto }) {
  const res = await fetch(`${BASE}/pagos?modo=${modo}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": clave },
    body: JSON.stringify({ cliente, monto }),
  });
  return {
    status: res.status,
    instancia: res.headers.get("x-instance"),
    repetido: res.headers.get("idempotent-replayed") === "true",
    body: await res.json(),
  };
}

/** Cuántos cobros quedaron registrados en Postgres para un cliente. */
export async function cobros(cliente) {
  const res = await fetch(`${BASE}/pagos?cliente=${encodeURIComponent(cliente)}`);
  return res.json();
}

export function describir(r) {
  // Primero el header: un reintento devuelve el MISMO status (201) que la respuesta original
  if (r.repetido) return "↩  respuesta repetida (NO se cobró)";
  if (r.status === 201) return "💰 PAGO PROCESADO (se cobró)";
  if (r.status === 409) return "⏳ rechazado: el pago ya se está procesando";
  return `status ${r.status}: ${JSON.stringify(r.body)}`;
}
