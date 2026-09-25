// Limitación: ¿qué pasa si Redis se cae?
// - La caché es FAIL-OPEN: sigue funcionando desde Postgres (más lenta).
// - Los pagos son FAIL-CLOSED: se rechazan para no arriesgar un cobro doble.
// - Al volver, las claves de idempotencia siguen ahí gracias al AOF (persistencia en disco).
// Uso: node demo/04_redis_caido.mjs
import { randomUUID } from "node:crypto";
import { BASE, paso, pagar, cobros, describir, ejecutar, esperar } from "./lib.mjs";

const DETENER = process.env.REDIS_STOP ?? "docker compose stop redis";
const INICIAR = process.env.REDIS_START ?? "docker compose start redis";

async function leerProducto() {
  const t0 = performance.now();
  const res = await fetch(`${BASE}/productos/2`);
  const ms = Math.round(performance.now() - t0);
  const origen = res.ok ? (await res.json()).origen : "error";
  console.log(`GET /productos/2 → ${res.status} | ${String(ms).padStart(4)} ms | desde: ${origen}`);
}

const cliente = `cliente-caida-${Date.now()}`;
const claveVieja = randomUUID();

paso("1. Con Redis funcionando: hacemos un pago");
let r = await pagar({ modo: "redis", clave: claveVieja, cliente, monto: 15000 });
console.log(`Pago A → ${r.status} | ${describir(r)} | id=${r.body.pago?.id}`);

paso("2. Apagamos Redis");
ejecutar(DETENER);
console.log("Redis detenido.");

paso("3. Leer un producto (la caché no está)");
await leerProducto();
console.log("→ FAIL-OPEN: funciona igual, directo desde Postgres. Solo perdimos velocidad.");

paso("4. Intentar un pago nuevo (no podemos verificar si es repetido)");
r = await pagar({ modo: "redis", clave: randomUUID(), cliente, monto: 15000 });
console.log(`Pago B → ${r.status} | ${r.body.error}`);
console.log("→ FAIL-CLOSED: preferimos rechazar a arriesgar un cobro doble.");

paso("5. Volvemos a levantar Redis");
ejecutar(INICIAR);
for (let i = 0; i < 30; i++) {
  await esperar(1000);
  const [a, b] = await Promise.all([fetch(`${BASE}/health`), fetch(`${BASE}/health`)]);
  if (a.ok && b.ok) break;
}
console.log("Redis disponible otra vez.");

paso("6. Reintentamos el pago A (el de antes de la caída)");
r = await pagar({ modo: "redis", clave: claveVieja, cliente, monto: 15000 });
console.log(`Pago A → ${r.status} | ${describir(r)} | id=${r.body.pago?.id}`);
console.log("→ La clave sobrevivió al reinicio gracias al AOF: Redis la guardó en disco.");

const { cantidad } = await cobros(cliente);
console.log(`\nCobros en la base: ${cantidad} → ${cantidad === 1 ? "✅ correcto" : "❌ revisar"}`);
