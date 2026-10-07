// ════════════════════════════════════════════════════════════════════════════
//  Panel de demo — Tienda distribuida (Redis + idempotencia + deduplicación)
//  HTML/CSS/JS puros, sin dependencias. Todas las llamadas van a /api/... (mismo origen).
//  Organizado por secciones para poder explicarlo en el coloquio.
// ════════════════════════════════════════════════════════════════════════════

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

/** Una Idempotency-Key nueva por cada pago (UUID del navegador; en localhost está disponible). */
const nuevaClave = () =>
  crypto.randomUUID ? crypto.randomUUID() : "k-" + Date.now() + "-" + Math.floor(Math.random() * 1e9);

/** $15.000 con separador de miles en español. */
const moneda = (n) => "$" + Math.round(n).toLocaleString("es-AR");

// ════════════════════════════════════════════════════════════════════════════
//  1. ESTADO GLOBAL
// ════════════════════════════════════════════════════════════════════════════
const estado = {
  modoIdem: "redis",              // modo elegido en la pestaña Idempotencia
  replicas: {},                   // 'api-1' | 'api-2' -> { ts, redis, postgres, worker }
  ultimoEstado: null,             // última respuesta de /admin/estado (vista más reciente)
  clavesRedisPrevias: new Set(),  // para resaltar las claves nuevas en "Redis por dentro"
  historialCache: [],             // últimas consultas { ms, tipo: 'HIT'|'MISS' }
  comparacionModos: {},           // modo -> { total, cobros } (último escenario de cada modo)
  dedup: { cliente: null, eventoId: null }, // pago actual de la pestaña Deduplicación
  ultimoPagoOk: null,             // último pago cobrado (para "reintentar el pago anterior")
};

// Catálogo base (los nombres no cambian; el precio se actualiza al consultar/guardar).
const PRODUCTOS = [
  { id: 1, nombre: "Teclado mecánico", precio: 45000 },
  { id: 2, nombre: "Mouse inalámbrico", precio: 18000 },
  { id: 3, nombre: 'Monitor 24"', precio: 210000 },
];
const MONTO = 15000;

/** Helper central: llama a la API y devuelve la respuesta + tiempo medido + réplica. */
async function llamarApi(ruta, opciones = {}) {
  const t0 = performance.now();
  const res = await fetch(`/api${ruta}`, opciones);
  const ms = Math.round(performance.now() - t0);
  return { res, ms, instancia: res.headers.get("x-instance") };
}

// ════════════════════════════════════════════════════════════════════════════
//  2. PESTAÑAS
// ════════════════════════════════════════════════════════════════════════════
$$(".tab").forEach((tab) =>
  tab.addEventListener("click", () => {
    $$(".tab").forEach((t) => t.classList.remove("activo"));
    $$(".panel").forEach((p) => p.classList.remove("activo"));
    tab.classList.add("activo");
    $(`#panel-${tab.dataset.tab}`).classList.add("activo");
    if (tab.dataset.tab === "dedup") sincronizarDedupSwitch();
  })
);

// ════════════════════════════════════════════════════════════════════════════
//  3. ARQUITECTURA EN VIVO (diagrama + animación del recorrido)
// ════════════════════════════════════════════════════════════════════════════
const punto = $("#punto");
const nodo = (id) => $(`#nodo-${id}`);
const cable = (a, b) => $(`#cable-${a}-${b}`);

function limpiarResaltados() {
  $$(".nodo").forEach((n) => n.classList.remove("activo", "resaltado"));
  $$(".cable").forEach((c) => c.classList.remove("activo"));
}

/** Mueve el punto a lo largo de un cable (usa getPointAtLength sobre el <path>). */
function moverPunto(cablePath, dur) {
  return new Promise((resolve) => {
    if (!cablePath) return resolve();
    const largo = cablePath.getTotalLength();
    const t0 = performance.now();
    function frame(t) {
      const p = Math.min((t - t0) / dur, 1);
      const pt = cablePath.getPointAtLength(largo * p);
      punto.setAttribute("cx", pt.x);
      punto.setAttribute("cy", pt.y);
      if (p < 1) requestAnimationFrame(frame);
      else resolve();
    }
    requestAnimationFrame(frame);
  });
}

/**
 * Anima el camino REAL de un pedido: Cliente → nginx → la réplica que atendió → destino(s).
 * destinos: ['redis'] (HIT/repetido), ['redis','postgres'] (MISS / pago cobrado).
 */
async function animarArquitectura(instancia, destinos) {
  const replica = instancia === "api-1" || instancia === "api-2" ? instancia : null;
  if (!replica) return;
  limpiarResaltados();

  // Resaltar nodos del recorrido.
  nodo("cliente").classList.add("activo");
  nodo("nginx").classList.add("activo");
  nodo(replica).classList.add("resaltado");
  destinos.forEach((d) => nodo(d).classList.add("activo"));

  // Resaltar cables del recorrido.
  cable("cliente", "nginx").classList.add("activo");
  cable("nginx", replica).classList.add("activo");
  destinos.forEach((d) => cable(replica, d).classList.add("activo"));

  // Mover el punto por el camino principal.
  punto.style.opacity = 1;
  await moverPunto(cable("cliente", "nginx"), 220);
  await moverPunto(cable("nginx", replica), 220);
  const destinoFinal = destinos[destinos.length - 1];
  if (destinoFinal) await moverPunto(cable(replica, destinoFinal), 220);
  punto.style.opacity = 0;

  setTimeout(limpiarResaltados, 700);
}

/** Pinta Redis en rojo con cables punteados cuando está caído. */
function actualizarDiagramaRedis(disponible) {
  nodo("redis").classList.toggle("caido", !disponible);
  ["cable-api-1-redis", "cable-api-2-redis", "cable-redis-worker"].forEach((id) =>
    $(`#${id}`).classList.toggle("caido", !disponible)
  );
}

/** Caja "Último pedido". */
function registrarUltimoPedido({ ruta, replica, resultado, ms }) {
  $("#up-ruta").textContent = ruta;
  $("#up-replica").textContent = replica ?? "—";
  $("#up-resultado").textContent = resultado;
  $("#up-tiempo").textContent = `${ms} ms`;
}

// ════════════════════════════════════════════════════════════════════════════
//  4. ESTADO / SEMÁFORO (barra superior) — GET /admin/estado cada 1 s
//     nginx alterna, así que cada respuesta viene de una réplica distinta:
//     guardamos el último estado de cada una y marcamos en rojo la que no responde.
// ════════════════════════════════════════════════════════════════════════════
async function pollEstado() {
  try {
    const { res } = await llamarApi("/admin/estado");
    const e = await res.json();
    estado.replicas[e.instancia] = { ts: Date.now(), ...e };
    estado.ultimoEstado = e;
  } catch {
    /* si falla, las luces de las réplicas se apagarán solas por antigüedad */
  }
  actualizarLuces();
}

function luz(nombre, ok) {
  const el = $(`.luz[data-luz="${nombre}"]`);
  el.classList.toggle("ok", ok);
  el.classList.toggle("mal", !ok);
}

function actualizarLuces() {
  const ahora = Date.now();
  // Réplicas: verdes si respondieron hace menos de 3 s.
  for (const r of ["api-1", "api-2"]) {
    const info = estado.replicas[r];
    luz(r, !!info && ahora - info.ts < 3000);
  }
  // Redis / Postgres / Worker: según la respuesta más reciente.
  const e = estado.ultimoEstado;
  luz("redis", !!e && e.redis);
  luz("postgres", !!e && e.postgres);
  luz("worker", !!e && e.worker);

  actualizarDiagramaRedis(!!e && e.redis);
  actualizarIndicadoresFallas(e);
}

// ════════════════════════════════════════════════════════════════════════════
//  5. REDIS POR DENTRO — GET /admin/redis cada 1 s
// ════════════════════════════════════════════════════════════════════════════
const cont = (s) => (s < 0 ? "sin TTL" : s < 60 ? `${s} s` : [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((x) => String(x).padStart(2, "0")).join(":"));

function fraccionTTL(clave, ttl) {
  if (ttl < 0) return 1;
  const max = clave.startsWith("producto:") ? 20 : 86400;
  return Math.max(0.02, Math.min(1, ttl / max));
}
function chipRedis(clave, tipo, detalle) {
  if (clave.startsWith("idem:")) return detalle || "idempotencia";
  if (clave.startsWith("producto:")) return "caché";
  if (clave.startsWith("dedup:")) return "mensaje";
  if (tipo === "stream") return "cola";
  return tipo;
}
function detalleRedis(clave, tipo, ttl, detalle) {
  if (tipo === "stream") return `${detalle || "0 mensajes"} en la cola, sin TTL`;
  return `TTL ${cont(ttl)}`;
}

async function pollRedis() {
  const caja = $("#claves-redis");
  try {
    const { res } = await llamarApi("/admin/redis");
    if (res.status === 503) throw new Error("503");
    const { claves } = await res.json();

    const actuales = new Set(claves.map((c) => c.clave));
    caja.innerHTML = "";
    for (const c of claves) {
      const nueva = !estado.clavesRedisPrevias.has(c.clave);
      const div = document.createElement("div");
      div.className = "clave-redis" + (nueva ? " nueva" : "");
      div.innerHTML = `
        <div class="clave-cabecera">
          <span class="clave-nombre" title="${c.clave}">${c.clave}</span>
          <span class="clave-chip">${chipRedis(c.clave, c.tipo, c.detalle)}</span>
        </div>
        <div class="clave-ttl-barra"><i style="width:${(fraccionTTL(c.clave, c.ttl) * 100).toFixed(0)}%"></i></div>
        <div class="clave-detalle">${detalleRedis(c.clave, c.tipo, c.ttl, c.detalle)}${nueva ? '<span class="clave-nueva-tag">recién creada</span>' : ""}</div>`;
      caja.appendChild(div);
      // Quitar el resaltado de "nueva" a los 2 s.
      if (nueva) setTimeout(() => div.classList.remove("nueva"), 2000);
    }
    estado.clavesRedisPrevias = actuales;
    $("#redis-pie").textContent = "Se actualiza cada 1 segundo";
  } catch {
    caja.innerHTML = '<div class="redis-no-disp">Redis no disponible</div>';
    estado.clavesRedisPrevias = new Set();
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  6. PESTAÑA CACHÉ
// ════════════════════════════════════════════════════════════════════════════
function pintarProductos() {
  const grilla = $("#grilla-productos");
  grilla.innerHTML = "";
  for (const p of PRODUCTOS) {
    const div = document.createElement("div");
    div.className = "producto";
    div.dataset.id = p.id;
    div.innerHTML = `
      <div>
        <div class="prod-nombre">${p.nombre}</div>
        <div class="prod-precio" data-precio>${moneda(p.precio)}</div>
      </div>
      <button class="btn consultar">Consultar</button>
      <div class="prod-fila">
        <input type="number" placeholder="Nuevo precio" min="1" />
        <button class="btn guardar">Guardar</button>
      </div>
      <div class="prod-sello" data-sello></div>
      <div class="prod-aviso" data-aviso></div>`;
    grilla.appendChild(div);
    div.querySelector(".consultar").addEventListener("click", () => consultarProducto(p.id, div));
    div.querySelector(".guardar").addEventListener("click", () => guardarPrecio(p.id, div));
  }
}

/** GET /productos/:id — mide el tiempo y muestra HIT/MISS. */
async function consultarProducto(id, div) {
  const { res, ms, instancia } = await llamarApi(`/productos/${id}`);
  const body = await res.json();
  const tipo = res.headers.get("x-cache"); // HIT | MISS
  const esHit = tipo === "HIT";

  // Actualizar precio mostrado.
  div.querySelector("[data-precio]").textContent = moneda(body.producto.precio);
  const sello = div.querySelector("[data-sello]");
  sello.textContent = `${tipo} · ${ms} ms · ${instancia}`;
  sello.className = "prod-sello " + (esHit ? "hit" : "miss");

  // Sello grande + gráfico + animación del diagrama.
  const grande = $("#sello-cache");
  grande.className = "sello-grande " + (esHit ? "hit" : "miss");
  grande.innerHTML = `${tipo} · ${ms} ms · ${instancia}`;

  estado.historialCache.push({ ms, tipo });
  if (estado.historialCache.length > 10) estado.historialCache.shift();
  dibujarGraficoCache();

  registrarUltimoPedido({ ruta: `GET /productos/${id}`, replica: instancia, resultado: tipo, ms });
  // HIT sale de Redis; MISS va a Redis (no está) y después a Postgres.
  animarArquitectura(instancia, esHit ? ["redis"] : ["redis", "postgres"]);
}

/** PUT /productos/:id — cambia el precio e invalida la caché. */
async function guardarPrecio(id, div) {
  const input = div.querySelector("input");
  const precio = Number(input.value);
  const aviso = div.querySelector("[data-aviso]");
  if (!precio || precio <= 0) { aviso.textContent = "Ingresá un precio válido."; return; }

  const { res, ms, instancia } = await llamarApi(`/productos/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ precio }),
  });
  const body = await res.json();
  div.querySelector("[data-precio]").textContent = moneda(body.producto.precio);
  input.value = "";
  aviso.textContent = "Caché invalidada: la próxima consulta irá a Postgres.";
  setTimeout(() => (aviso.textContent = ""), 3000);
  registrarUltimoPedido({ ruta: `PUT /productos/${id}`, replica: instancia, resultado: "INVALIDADA", ms });
  animarArquitectura(instancia, ["redis", "postgres"]);
}

/** Gráfico de barras SVG de las últimas 10 consultas (alto = ms, color = HIT/MISS). */
function dibujarGraficoCache() {
  const svg = $("#grafico-cache");
  const datos = estado.historialCache;
  svg.innerHTML = "";
  if (!datos.length) return;
  const maxMs = Math.max(...datos.map((d) => d.ms), 100);
  const ancho = 340, alto = 150, hueco = 6;
  const bw = (ancho - hueco * (datos.length - 1)) / datos.length;

  datos.forEach((d, i) => {
    const h = Math.max(4, (d.ms / maxMs) * (alto - 24));
    const x = i * (bw + hueco);
    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rect.setAttribute("x", x);
    rect.setAttribute("y", alto - h - 16);
    rect.setAttribute("width", bw);
    rect.setAttribute("height", h);
    rect.setAttribute("rx", 4);
    rect.setAttribute("class", "barra-cache");
    rect.setAttribute("fill", d.tipo === "HIT" ? "#1e8a4c" : "#b76e00");
    svg.appendChild(rect);

    const t = document.createElementNS("http://www.w3.org/2000/svg", "text");
    t.setAttribute("x", x + bw / 2);
    t.setAttribute("y", alto - 3);
    t.setAttribute("text-anchor", "middle");
    t.setAttribute("font-size", "9");
    t.setAttribute("fill", "#5b6b82");
    t.textContent = d.ms;
    svg.appendChild(t);
  });

  // Promedios de HIT y MISS.
  const prom = (tipo) => {
    const xs = datos.filter((d) => d.tipo === tipo);
    return xs.length ? Math.round(xs.reduce((s, d) => s + d.ms, 0) / xs.length) : null;
  };
  const hit = prom("HIT"), miss = prom("MISS");
  $("#promedios-cache").innerHTML =
    `<span class="p-hit">HIT promedio: ${hit !== null ? hit + " ms" : "—"}</span>` +
    `<span class="p-miss">MISS promedio: ${miss !== null ? miss + " ms" : "—"}</span>`;
}

// ════════════════════════════════════════════════════════════════════════════
//  7. PESTAÑA IDEMPOTENCIA
// ════════════════════════════════════════════════════════════════════════════
// Selector de modo (off / memoria / redis).
$$("#modo-idem button").forEach((b) =>
  b.addEventListener("click", () => {
    $$("#modo-idem button").forEach((x) => x.classList.remove("activo"));
    b.classList.add("activo");
    estado.modoIdem = b.dataset.modo;
  })
);

/** Envía un pago. Lee el header ANTES que el status (un repetido también devuelve 201). */
async function pagar(modo, clave, cliente) {
  const { res, ms, instancia } = await llamarApi(`/pagos?modo=${modo}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": clave },
    body: JSON.stringify({ cliente, monto: MONTO }),
  });
  const body = await res.json().catch(() => ({}));
  const repetido = res.headers.get("idempotent-replayed") === "true";
  let resultado;
  if (repetido) resultado = "REPETIDO";
  else if (res.status === 201) resultado = "COBRÓ";
  else if (res.status === 409) resultado = "RECHAZADO";
  else resultado = `ERROR ${res.status}`;
  return { resultado, instancia, ms, body, status: res.status, repetido };
}

const DESCRIPCION = {
  "COBRÓ": "Se registró el pago de $15.000",
  REPETIDO: "Devolvió la respuesta guardada",
  RECHAZADO: "El pago ya se estaba procesando",
};

function filaTimeline(n, r) {
  const div = document.createElement("div");
  div.className = "timeline";
  const clase = r.resultado === "COBRÓ" ? "cobro" : r.resultado === "REPETIDO" ? "repetido" : "rechazado";
  div.innerHTML = `
    <span class="num">${n}</span>
    <span class="replica">${r.instancia ?? "—"}</span>
    <span><span class="chip ${clase}">${r.resultado}</span> <span class="desc">${DESCRIPCION[r.resultado] ?? ""}</span></span>
    <span class="der">${r.ms} ms</span>`;
  return div;
}

/** Al terminar un escenario: billetera del cliente + comparación de modos. */
async function actualizarBilletera(modo, cliente) {
  const { res } = await llamarApi(`/pagos?cliente=${encodeURIComponent(cliente)}`);
  const { cantidad, total } = await res.json();
  const esOk = cantidad <= 1;

  $("#billetera-total").textContent = moneda(total);
  $("#billetera-total").className = "billetera-total " + (esOk ? "ok" : "mal");
  $("#billetera-chip").innerHTML = `<span class="chip ${esOk ? "cobro" : "rechazado"}">${cantidad === 1 ? "1 solo cobro" : cantidad + " cobros"}</span>`;
  $("#billetera-detalle").textContent = esOk
    ? `por una compra de ${moneda(MONTO)}`
    : `Te cobraron ${moneda(total)} por una compra de ${moneda(MONTO)}`;

  // Guardar el resultado de este modo y redibujar la comparación.
  estado.comparacionModos[modo] = { total, cobros: cantidad };
  dibujarComparacion();
}

function dibujarComparacion() {
  const nombres = { off: "Sin protección", memoria: "Memoria local", redis: "Redis" };
  const maxTotal = Math.max(MONTO, ...Object.values(estado.comparacionModos).map((m) => m.total));
  const cont = $("#comparacion-modos");
  cont.innerHTML = "";
  for (const modo of ["off", "memoria", "redis"]) {
    const m = estado.comparacionModos[modo];
    const fila = document.createElement("div");
    fila.className = "comp-fila";
    if (m) {
      const malo = m.cobros > 1;
      fila.innerHTML = `<span>${nombres[modo]}</span>
        <span class="comp-barra ${malo ? "mal" : ""}" style="width:${(m.total / maxTotal) * 100}%"></span>
        <strong>${moneda(m.total)}</strong>`;
    } else {
      fila.innerHTML = `<span>${nombres[modo]}</span><span class="comp-barra" style="width:0"></span><span class="sub">—</span>`;
    }
    cont.appendChild(fila);
  }
}

/** Dispara el escenario elegido en el modo actual. */
async function correrEscenario(tipo) {
  const modo = estado.modoIdem;
  const cliente = `cliente-${modo}-${Date.now()}`;
  const clave = nuevaClave();
  const tl = $("#idem-timeline");
  tl.innerHTML = "";
  $("#idem-clave").innerHTML = `Idempotency-Key<code>${clave}</code>`;

  if (tipo === "uno") {
    $("#idem-sub").textContent = "Un pago con una clave nueva.";
    const r = await pagar(modo, clave, cliente);
    tl.appendChild(filaTimeline(1, r));
    animarArquitectura(r.instancia, r.resultado === "COBRÓ" ? ["redis", "postgres"] : ["redis"]);
  } else if (tipo === "tres") {
    $("#idem-sub").textContent = "El mismo pago enviado 3 veces, con la misma Idempotency-Key.";
    // Secuenciales: se ve cómo el 1º cobra y los otros se repiten/rechazan.
    for (let i = 1; i <= 3; i++) {
      const r = await pagar(modo, clave, cliente);
      tl.appendChild(filaTimeline(i, r));
      animarArquitectura(r.instancia, r.resultado === "COBRÓ" ? ["redis", "postgres"] : ["redis"]);
      await esperar(200);
    }
  } else if (tipo === "veinte") {
    $("#idem-sub").textContent = "20 pedidos a la vez con la misma clave (doble clic + reintentos).";
    // Simultáneos: Promise.all. El resultado se muestra AGRUPADO (no en orden de llegada).
    const resultados = await Promise.all(Array.from({ length: 20 }, () => pagar(modo, clave, cliente)));
    const resumen = {};
    for (const r of resultados) resumen[r.resultado] = (resumen[r.resultado] ?? 0) + 1;
    const partes = Object.entries(resumen).map(([k, n]) => `${n} ${k.toLowerCase()}`).join(", ");
    const fila = document.createElement("div");
    fila.className = "timeline";
    fila.innerHTML = `<span class="num">20</span><span class="replica">varias</span>
      <span><span class="chip repetido">AGRUPADO</span> <span class="desc">${partes} · agrupado, no en orden de llegada</span></span>
      <span class="der"></span>`;
    tl.appendChild(fila);
    const cobro = resultados.find((r) => r.resultado === "COBRÓ");
    if (cobro) animarArquitectura(cobro.instancia, ["redis", "postgres"]);
  }

  await actualizarBilletera(modo, cliente);
}
$$('.botones-escenario [data-escenario]').forEach((b) =>
  b.addEventListener("click", () => correrEscenario(b.dataset.escenario))
);

// ════════════════════════════════════════════════════════════════════════════
//  8. PESTAÑA DEDUPLICACIÓN
// ════════════════════════════════════════════════════════════════════════════
async function sincronizarDedupSwitch() {
  try {
    const { res } = await llamarApi("/admin/dedup");
    const { dedup } = await res.json();
    $("#dedup-switch").checked = dedup === "on";
    $("#dedup-estado").textContent = dedup === "on" ? "ON" : "OFF";
  } catch { /* Redis caído */ }
}
$("#dedup-switch").addEventListener("change", async (e) => {
  const dedup = e.target.checked ? "on" : "off";
  $("#dedup-estado").textContent = dedup.toUpperCase();
  await llamarApi("/admin/dedup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dedup }),
  });
});

$("#dedup-pagar").addEventListener("click", async () => {
  const cliente = `cliente-dedup-${Date.now()}`;
  const r = await pagar("redis", nuevaClave(), cliente);
  estado.dedup = { cliente, eventoId: r.body.eventoId };
  $("#dedup-cliente").textContent = `Pago de ${cliente} — esperando el comprobante del worker...`;
  $("#dedup-reenviar").disabled = !r.body.eventoId;
  animarArquitectura(r.instancia, ["redis", "postgres"]);
});

$("#dedup-reenviar").addEventListener("click", async () => {
  if (!estado.dedup.eventoId) return;
  await llamarApi("/admin/reenviar", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ eventoId: estado.dedup.eventoId }),
  });
});

/** Bandeja del cliente: GET /emails?cliente= cada 1 s. Resalta duplicados por evento_id. */
async function pollBandeja() {
  if (!estado.dedup.cliente) return;
  try {
    const { res } = await llamarApi(`/emails?cliente=${encodeURIComponent(estado.dedup.cliente)}`);
    const { emails } = await res.json();
    // Contar cuántas veces aparece cada evento_id para marcar los duplicados.
    const conteo = {};
    emails.forEach((e) => (conteo[e.evento_id] = (conteo[e.evento_id] ?? 0) + 1));

    const caja = $("#bandeja");
    caja.innerHTML = emails.length ? "" : '<p class="sub">Todavía no llegó ningún comprobante.</p>';
    if (emails.length) {
      $("#dedup-cliente").textContent = `Bandeja de ${estado.dedup.cliente}`;
    }
    emails.forEach((e) => {
      const dup = conteo[e.evento_id] > 1;
      const div = document.createElement("div");
      div.className = "email" + (dup ? " duplicado" : "");
      div.innerHTML = `
        <div class="email-asunto">Comprobante de pago #${e.pago_id} · ${moneda(e.monto)}</div>
        <div class="email-meta">evento ${e.evento_id.slice(0, 12)}…</div>
        ${dup ? '<div class="email-alerta">⚠ Comprobante duplicado</div>' : ""}`;
      caja.appendChild(div);
    });
  } catch { /* Redis/DB caído */ }
}

/** Registro del worker: GET /admin/worker-log cada 1 s. */
async function pollWorkerLog() {
  try {
    const { res } = await llamarApi("/admin/worker-log");
    if (!res.ok) return;
    const { log } = await res.json();
    const caja = $("#worker-log");
    caja.innerHTML = log.length ? "" : '<p class="sub">El worker todavía no procesó nada.</p>';
    log.forEach((l) => {
      const enviado = l.resultado === "enviado";
      const div = document.createElement("div");
      div.className = "log-fila";
      div.innerHTML = `
        <span class="chip ${enviado ? "enviado" : "descartado"}">${enviado ? "ENVIADO" : "DUPLICADO DESCARTADO"}</span>
        <span class="log-detalle">evento ${String(l.eventoId).slice(0, 10)}… · pago ${l.pagoId}</span>`;
      caja.appendChild(div);
    });
  } catch { /* Redis caído */ }
}

// ════════════════════════════════════════════════════════════════════════════
//  9. PESTAÑA FALLAS
// ════════════════════════════════════════════════════════════════════════════
function actualizarIndicadoresFallas(e) {
  const redisOk = !!e && e.redis;
  const ind = (id, clase, titulo) => {
    const el = $(`#ind-${id}`);
    el.className = "indicador " + clase;
    $(`#ind-${id}-valor`).textContent = titulo;
  };
  if (!e) {
    ind("redis", "", "—"); ind("cache", "", "—"); ind("pagos", "", "—");
    return;
  }
  ind("redis", redisOk ? "ok" : "mal", redisOk ? "disponible" : "caído");
  // Caché: fail-open (sigue, más lenta).
  ind("cache", redisOk ? "ok" : "warn", redisOk ? "rápida (desde Redis)" : "funciona sin Redis (más lenta)");
  // Pagos: fail-closed (se rechazan para no cobrar dos veces).
  ind("pagos", redisOk ? "ok" : "mal", redisOk ? "protegidos" : "rechazados para no cobrar dos veces");
}

// Copiar comandos.
$$(".btn-copiar").forEach((b) =>
  b.addEventListener("click", () => {
    navigator.clipboard?.writeText(b.dataset.copiar);
    const t = b.textContent; b.textContent = "¡Copiado!";
    setTimeout(() => (b.textContent = t), 1200);
  })
);

const mostrarFalla = (txt) => ($("#falla-resultado").textContent = txt);

$("#falla-producto").addEventListener("click", async () => {
  const { res, ms, instancia } = await llamarApi("/productos/2");
  const body = await res.json();
  const origen = res.headers.get("x-cache") === "HIT" ? "Redis (caché)" : "Postgres";
  mostrarFalla(`GET /productos/2 → ${res.status} · ${ms} ms · ${instancia}\nDato leído desde: ${origen} (precio ${moneda(body.producto?.precio ?? 0)})`);
  animarArquitectura(instancia, res.headers.get("x-cache") === "HIT" ? ["redis"] : ["redis", "postgres"]);
});

$("#falla-pago").addEventListener("click", async () => {
  const cliente = `cliente-falla-${Date.now()}`;
  const clave = nuevaClave();
  const r = await pagar("redis", clave, cliente);
  if (r.resultado === "COBRÓ") estado.ultimoPagoOk = { clave, cliente };
  $("#falla-reintento").disabled = !estado.ultimoPagoOk;
  mostrarFalla(`POST /pagos?modo=redis → ${r.status} · ${r.instancia}\n${r.resultado === "COBRÓ" ? "Pago cobrado (Redis disponible)" : "503: pago rechazado (Redis caído, fail-closed)"}`);
  if (r.resultado === "COBRÓ") animarArquitectura(r.instancia, ["redis", "postgres"]);
});

$("#falla-reintento").addEventListener("click", async () => {
  if (!estado.ultimoPagoOk) return;
  const { clave, cliente } = estado.ultimoPagoOk;
  const r = await pagar("redis", clave, cliente);
  mostrarFalla(`Reintento del pago anterior → ${r.status} · ${r.instancia}\n${r.resultado === "REPETIDO" ? "REPETIDO: la clave sobrevivió a la caída gracias al AOF. NO se cobró de nuevo." : r.resultado}`);
  animarArquitectura(r.instancia, ["redis"]);
});

// ════════════════════════════════════════════════════════════════════════════
//  10. REINICIAR DEMO
// ════════════════════════════════════════════════════════════════════════════
$("#btn-reiniciar").addEventListener("click", async () => {
  await llamarApi("/admin/reset", { method: "POST" });
  // Limpiar el estado del panel.
  estado.historialCache = [];
  estado.comparacionModos = {};
  estado.dedup = { cliente: null, eventoId: null };
  estado.ultimoPagoOk = null;
  dibujarGraficoCache();
  dibujarComparacion();
  pintarProductos();
  $("#idem-timeline").innerHTML = "";
  $("#idem-clave").innerHTML = "";
  $("#idem-sub").textContent = "Elegí un escenario para empezar.";
  $("#billetera-total").textContent = "—";
  $("#billetera-total").className = "billetera-total";
  $("#billetera-chip").innerHTML = "";
  $("#billetera-detalle").textContent = "";
  $("#bandeja").innerHTML = "";
  $("#dedup-cliente").textContent = "Todavía no hay pagos.";
  $("#dedup-reenviar").disabled = true;
  $("#falla-reintento").disabled = true;
  $("#falla-resultado").textContent = "";
  $("#sello-cache").className = "sello-grande";
  $("#sello-cache").innerHTML = "<span>Consultá un producto</span>";
  registrarUltimoPedido({ ruta: "—", replica: "—", resultado: "demo reiniciada", ms: 0 });
});

// ════════════════════════════════════════════════════════════════════════════
//  11. ARRANQUE
// ════════════════════════════════════════════════════════════════════════════
pintarProductos();
dibujarComparacion();
dibujarGraficoCache();
sincronizarDedupSwitch();

// Pollers cada 1 s (el estado y Redis siempre; bandeja y worker-log para la pestaña dedup).
pollEstado(); setInterval(pollEstado, 1000);
pollRedis(); setInterval(pollRedis, 1000);
setInterval(pollBandeja, 1000);
setInterval(pollWorkerLog, 1000);
