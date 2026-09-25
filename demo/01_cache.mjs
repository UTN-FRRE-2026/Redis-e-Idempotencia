// Fase 2: demostración de caché con Redis (cache-aside, TTL e invalidación).
// Uso: node demo/01_cache.mjs          (demo normal, ~5 s)
//      node demo/01_cache.mjs --ttl    (además espera a que venza el TTL, ~25 s)
import { BASE, paso, redisCli } from "./lib.mjs";

const CLAVE = "producto:1";
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

async function consultar(n) {
  const t0 = performance.now();
  const res = await fetch(`${BASE}/productos/1`);
  const body = await res.json();
  const ms = Math.round(performance.now() - t0);
  console.log(
    `#${n} GET /productos/1 → ${res.headers.get("x-cache").padEnd(4)} | ${String(ms).padStart(4)} ms` +
      ` | ${res.headers.get("x-instance")} | precio: $${body.producto.precio}`
  );
}

paso("1. Limpiamos la caché para arrancar de cero");
console.log(`DEL ${CLAVE} →`, redisCli(`DEL ${CLAVE}`));

paso("2. Tres consultas seguidas al mismo producto");
for (let i = 1; i <= 3; i++) await consultar(i);
console.log("→ La 1ª va a Postgres (lenta). Las siguientes salen de Redis, aunque las atienda OTRA réplica.");

paso("3. ¿Qué quedó guardado en Redis?");
console.log(`GET ${CLAVE} →`, redisCli(`GET ${CLAVE}`));
console.log(`TTL ${CLAVE} →`, redisCli(`TTL ${CLAVE}`), "segundos hasta que se borre sola");

paso("4. Cambiamos el precio (PUT) → se invalida la caché");
const nuevoPrecio = 40000 + Math.floor(Math.random() * 10000);
const put = await fetch(`${BASE}/productos/1`, {
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ precio: nuevoPrecio }),
});
console.log(`PUT precio=$${nuevoPrecio} → ${put.headers.get("x-cache")}`);
console.log(`EXISTS ${CLAVE} →`, redisCli(`EXISTS ${CLAVE}`), "(0 = ya no está en caché)");

paso("5. Consultamos otra vez");
for (let i = 4; i <= 5; i++) await consultar(i);
console.log("→ MISS con el precio NUEVO, y después vuelve a salir de la caché.");

if (process.argv.includes("--ttl")) {
  const ttl = Number(redisCli(`TTL ${CLAVE}`));
  paso(`6. Esperamos ${ttl + 1} s a que venza el TTL`);
  await esperar((ttl + 1) * 1000);
  console.log(`EXISTS ${CLAVE} →`, redisCli(`EXISTS ${CLAVE}`));
  await consultar(6);
  console.log("→ Redis borró la copia sola: la consulta vuelve a ir a Postgres.");
}
