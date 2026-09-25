// Fase 3b: 20 peticiones AL MISMO TIEMPO con la misma Idempotency-Key (ej: doble clic + reintentos).
// Uso: node demo/03_concurrencia.mjs
import { randomUUID } from "node:crypto";
import { paso, pagar, cobros, describir } from "./lib.mjs";

const N = 20;
const MONTO = 15000;

for (const modo of ["memoria", "redis"]) {
  paso(`Modo "${modo}": ${N} peticiones simultáneas con la misma clave`);
  const cliente = `cliente-conc-${modo}-${Date.now()}`;
  const clave = randomUUID();

  const resultados = await Promise.all(
    Array.from({ length: N }, () => pagar({ modo, clave, cliente, monto: MONTO }))
  );

  // Agrupamos: cuántas respuestas de cada tipo dio cada réplica
  const resumen = {};
  for (const r of resultados) {
    const k = `${r.instancia} → ${describir(r)}`;
    resumen[k] = (resumen[k] ?? 0) + 1;
  }
    console.log(`Resumen de las ${N} respuestas (agrupadas por tipo, no en orden de llegada):`);
  for (const [k, n] of Object.entries(resumen).sort(([a], [b]) => b.includes("PROCESADO") - a.includes("PROCESADO") || a.localeCompare(b))) console.log(`${String(n).padStart(2)} x ${k}`);
  const { cantidad, pagos } = await cobros(cliente);
  const veredicto = cantidad === 1 ? "✅ correcto" : "❌ ¡COBRO DUPLICADO!";
  console.log(`Cobros en la base: ${cantidad} (${pagos.map((p) => p.atendido_por).join(", ")}) → ${veredicto}`);

  if (modo === "redis") {
    paso("Un reintento más, cuando el pago ya terminó");
    const r = await pagar({ modo, clave, cliente, monto: MONTO });
    console.log(`${r.status} | ${r.instancia} | ${describir(r)} | pago id=${r.body.pago?.id}`);
  }
}
