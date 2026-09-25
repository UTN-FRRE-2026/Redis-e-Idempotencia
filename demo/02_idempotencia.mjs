// Fase 3a: el cliente reintenta el MISMO pago 3 veces (ej: se le cortó la conexión).
// Comparamos los tres modos: sin protección, memoria local y Redis.
// Uso: node demo/02_idempotencia.mjs
import { randomUUID } from "node:crypto";
import { paso, pagar, cobros, describir, redisCli } from "./lib.mjs";

const MONTO = 15000;
const modos = [
  ["off", "SIN protección"],
  ["memoria", "Idempotencia en MEMORIA LOCAL de cada réplica"],
  ["redis", "Idempotencia en REDIS (compartido)"],
];

let claveRedis;
for (const [modo, titulo] of modos) {
  paso(`Modo "${modo}": ${titulo}`);
  const cliente = `cliente-${modo}-${Date.now()}`;
  const clave = randomUUID(); // la MISMA clave en los 3 intentos: es el mismo pago
  if (modo === "redis") claveRedis = clave;
  console.log(`Idempotency-Key: ${clave}`);

  for (let i = 1; i <= 3; i++) {
    const r = await pagar({ modo, clave, cliente, monto: MONTO });
    console.log(`Intento ${i} → ${r.status} | ${r.instancia} | ${describir(r)}`);
  }

  const { cantidad, total } = await cobros(cliente);
  const veredicto = cantidad === 1 ? "✅ correcto" : "❌ ¡COBRO DUPLICADO!";
  console.log(`Cobros en la base: ${cantidad} (total $${total}) → ${veredicto}`);
}

paso("¿Qué guardó Redis para esa clave?");
console.log(redisCli(`GET idem:${claveRedis}`));
console.log(`TTL: ${redisCli(`TTL idem:${claveRedis}`)} segundos (se recuerda 24 h)`);
