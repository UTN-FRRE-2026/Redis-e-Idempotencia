// Fase 1: verifica que todo esté levantado y que nginx reparta entre las dos réplicas.
// Uso: node demo/00_health.mjs
const BASE = process.env.BASE_URL ?? "http://localhost:8080";

console.log(`Enviando 6 peticiones a ${BASE}/health\n`);

for (let i = 1; i <= 6; i++) {
  const res = await fetch(`${BASE}/health`);
  const body = await res.json();
  console.log(`#${i} → atendió ${res.headers.get("x-instance")} | redis: ${body.redis} | postgres: ${body.postgres}`);
}

console.log("\nSi ves api-1 y api-2 alternándose, el balanceo funciona.");
