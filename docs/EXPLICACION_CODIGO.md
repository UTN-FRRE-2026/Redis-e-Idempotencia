# Explicación del código: Redis, caché, idempotencia y deduplicación

TP1 · UTN FRRE 2026 · Guía para el coloquio

Este documento explica qué partes del código implementan cada tema de la exposición, con fragmentos reales del repositorio y el razonamiento detrás de cada decisión.

## Índice

1. [Mapa rápido: qué archivo hace qué](#mapa-rápido-qué-archivo-hace-qué)
2. [Infraestructura y balanceo](#1-infraestructura-y-balanceo)
3. [La conexión a Redis](#2-la-conexión-a-redis-apisrcredists)
4. [Caché](#3-caché-apisrcroutesproductosts)
5. [Idempotencia](#4-idempotencia-idempotenciats--pagosts)
6. [Deduplicación](#5-deduplicación-eventosts--workerts)
7. [Fallas](#6-fallas-qué-pasa-cuando-redis-se-cae)
8. [Rutas del panel](#7-rutas-del-panel-admints-y-emailsts)
9. [Detalles finos que nos pueden preguntar](#8-detalles-finos-que-nos-pueden-preguntar)

---

## Mapa rápido: qué archivo hace qué

| Tema | Archivos | Pieza clave |
|---|---|---|
| Balanceo entre réplicas | `nginx/nginx.conf`, `docker-compose.yml`, `api/src/index.ts` | `upstream` round-robin + header `X-Instance` |
| Conexión a Redis | `api/src/redis.ts` | `disableOfflineQueue: true` |
| Caché | `api/src/routes/productos.ts` | cache-aside: `GET` → si no está, Postgres → `SET ... EX 20` |
| Idempotencia | `api/src/idempotencia.ts`, `api/src/routes/pagos.ts` | `SET idem:<clave> ... NX EX 86400` |
| Deduplicación | `api/src/eventos.ts`, `api/src/worker.ts` | `XADD` / `XREADGROUP` + `SET dedup:<eventoId> 1 NX` |
| Fallas | `redis.ts`, `productos.ts`, `pagos.ts`, `worker.ts`, `docker-compose.yml` | fail-open, fail-closed, reintento del worker, AOF |
| Panel | `api/src/routes/admin.ts`, `api/src/routes/emails.ts` | estado, claves de Redis, interruptor de dedup, reset |

---

## 1. Infraestructura y balanceo

### `docker-compose.yml`: una imagen, tres procesos

```yaml
x-api: &api
  build: ./api
  image: tp1-api
  environment: &api-env
    REDIS_URL: redis://redis:6379
    CACHE_TTL_SECONDS: "20"
    DB_DELAY_MS: "500"
    PAGO_DELAY_MS: "1000"
    IDEMPOTENCY_TTL_SECONDS: "86400"
  ...
api-1:
  <<: *api
  environment: { <<: *api-env, INSTANCE: api-1 }
api-2:
  <<: *api
  environment: { <<: *api-env, INSTANCE: api-2 }
worker:
  <<: *api
  command: ["node", "dist/worker.js"]
```

El bloque `x-api` con el ancla `&api` es una plantilla YAML: `api-1`, `api-2` y `worker` la heredan con `<<: *api`. Las tres usan **la misma imagen**. Lo único que cambia es la variable `INSTANCE` (para saber quién respondió) y, en el worker, el `command`: en vez de levantar Express arranca `worker.js`. Esto muestra que una réplica es literalmente "el mismo código corriendo dos veces".

Redis arranca con `--appendonly yes` y un volumen `redis-data:/data`. Eso es lo que hace que las claves sobrevivan a un `docker compose stop redis` (ver la sección de Fallas).

### `nginx/nginx.conf`: el balanceador

```nginx
upstream api_backend {
    zone api_backend 64k;
    server api-1:3000;
    server api-2:3000;
}
server {
    location / { root /usr/share/nginx/html; }          # el panel
    location /api/ { proxy_pass http://api_backend/; }  # la API
}
```

`upstream` define el grupo de réplicas. Si no se indica otra política, nginx usa **round-robin**: un pedido a cada una, en turnos. `zone` crea memoria compartida entre los procesos internos de nginx, para que todos respeten el mismo turno; sin eso, cada proceso de nginx llevaría su propio contador y la alternancia no sería tan prolija.

La **barra final** en `proxy_pass http://api_backend/;` es la que quita el prefijo: `/api/productos/1` llega a la API como `/productos/1`. Sin la barra, llegaría `/api/productos/1` y Express devolvería 404.

### `api/src/index.ts`: cómo se ve qué réplica atendió

```ts
app.use((req, res, next) => {
  res.setHeader("X-Instance", INSTANCE);
  console.log(`[${INSTANCE}] ${req.method} ${req.url}`);
  next();
});
```

Es un middleware que corre antes de todas las rutas y estampa el nombre de la réplica en cada respuesta. El panel y los scripts leen ese header para mostrar "atendió api-2" y para animar el diagrama.

---

## 2. La conexión a Redis (`api/src/redis.ts`)

```ts
export const redis = createClient({
  url: process.env.REDIS_URL ?? "redis://localhost:6379",
  disableOfflineQueue: true,
});
```

Parece un detalle, pero sostiene toda la parte de fallas. Por defecto, node-redis guarda en una cola los comandos que se mandan mientras está desconectado y los ejecuta cuando vuelve la conexión. Con Redis caído, un pedido HTTP quedaría **colgado** esperando. Con `disableOfflineQueue: true`, cada comando falla **al instante** con una excepción, y cada parte del código decide qué hacer con ese error: la caché lo ignora y los pagos lo convierten en 503.

---

## 3. Caché (`api/src/routes/productos.ts`)

### Las funciones envoltorio: acá está el fail-open

```ts
async function leerCache(clave: string): Promise<string | null> {
  try {
    return await redis.get(clave);
  } catch {
    console.warn(`[${INSTANCE}] Redis no disponible: consulto directo a Postgres`);
    return null;   // ← si Redis falla, se comporta como un MISS
  }
}
async function escribirCache(clave: string, valor: string) {
  try { await redis.set(clave, valor, { EX: TTL_SEGUNDOS }); } catch { }
}
```

Cada acceso a Redis está envuelto en `try/catch`. Si Redis cae, `leerCache` devuelve `null`, que el resto del código interpreta igual que "no estaba en caché". Por eso la ruta **nunca se rompe**: solo se vuelve lenta.

### `GET /productos/:id`: cache-aside en tres pasos

```ts
const enCache = await leerCache(clave);                           // 1. ¿Está en Redis?
if (enCache) {
  res.setHeader("X-Cache", "HIT");
  return res.json({ origen: "cache", producto: JSON.parse(enCache) });
}
await pool.query("SELECT pg_sleep($1)", [DEMORA_BD_MS / 1000]);   // 2. Postgres "lento"
const { rows } = await pool.query("SELECT ... FROM productos WHERE id = $1", [id]);
await escribirCache(clave, JSON.stringify(rows[0]));              // 3. Guardar copia con TTL
res.setHeader("X-Cache", "MISS");
```

Redis guarda el producto como un **String** con JSON adentro (`producto:1 → '{"id":1,"nombre":...}'`). `pg_sleep(0.5)` simula una base lenta para que la diferencia HIT/MISS sea visible (~500 ms contra unos pocos ms). El `EX 20` es el TTL: a los 20 segundos Redis borra la clave sola y la próxima lectura vuelve a ser MISS.

La caché es **compartida**: si api-1 hace el MISS y guarda `producto:1`, el siguiente pedido cae en api-2 (round-robin) y da HIT, porque las dos leen el mismo Redis. Es el mejor argumento de la demo para mostrar que una variable en memoria no alcanzaría.

### `PUT /productos/:id`: invalidación

```ts
const { rows } = await pool.query(`UPDATE productos SET precio = COALESCE($1, precio) ...`);
await invalidarCache(claveProducto(id));   // DEL producto:<id>
res.setHeader("X-Cache", "INVALIDATED");
```

El orden importa: **primero** se actualiza la fuente de verdad (Postgres) y **después** se borra la copia. Se borra en lugar de actualizarla porque es más simple y evita guardar en caché un valor distinto al de la base. `COALESCE` permite mandar solo `precio` o solo `stock`.

---

## 4. Idempotencia (`idempotencia.ts` + `pagos.ts`)

### `idempotencia.ts`: misma lógica, dos lugares donde guardar

```ts
export interface AlmacenIdempotencia {
  reservar(clave, registro): Promise<boolean>;  // guarda SOLO si no existe
  obtener(clave): Promise<RegistroIdempotencia | null>;
  guardar(clave, registro): Promise<void>;
  liberar(clave): Promise<void>;
}
```

La lógica de `pagos.ts` es **idéntica** en modo `memoria` y en modo `redis`. Lo único que cambia es la implementación del almacén. Así, la diferencia de resultados (2 cobros contra 1) se debe exclusivamente a **dónde** se guarda la clave.

El registro que se guarda es:

```ts
{ estado: "procesando" | "completado", hash, status?, respuesta? }
```

**`AlmacenMemoria`**, un `Map` por proceso:

```ts
async reservar(clave, registro) {
  if (this.registros.has(clave)) return false;
  this.registros.set(clave, registro);
  return true;
}
```

**`AlmacenRedis`**, compartido y atómico:

```ts
async reservar(clave, registro) {
  const r = await redis.set(`idem:${clave}`, JSON.stringify(registro), { NX: true, EX: TTL_SEGUNDOS });
  return r === "OK";   // null = la clave ya existía
}
```

`NX` significa "guardar solo si no existe" y `EX 86400` le da 24 h de vida. Como Redis ejecuta los comandos de a uno, si llegan 20 `SET NX` con la misma clave, exactamente uno recibe `"OK"` y los otros 19 reciben `null`.

### Por qué memoria da 2 cobros en la concurrencia y no 20

Dentro de un solo proceso de Node, `has` y `set` se ejecutan seguidos sin ningún `await` en el medio. Como Node tiene un solo hilo para JavaScript, ningún otro pedido puede meterse entre esas dos líneas. Entonces **dentro de cada réplica** el `Map` funciona bien: gana uno. El problema es que hay **dos** réplicas con dos `Map` distintos, así que gana uno en api-1 y otro en api-2: **2 cobros**. Con Redis hay un solo lugar compartido: **1 cobro**.

### `pagos.ts`: el flujo completo

**Modo `off`**, sin protección:

```ts
if (modo === "off") {
  const pago = await procesarPago(cliente, monto);
  const eventoId = await publicarEventoSeguro(pago);
  return res.status(201).json({ mensaje: "Pago procesado (sin protección)", pago, eventoId });
}
```

Ignora la `Idempotency-Key`: cada pedido cobra. `procesarPago` espera 1 s (la "pasarela") e inserta una fila en `pagos` con `atendido_por` = la réplica.

**Paso 1: reservar.**

```ts
const hash = huella({ cliente, monto });   // SHA-256 del body
const reservada = await almacen.reservar(clave, { estado: "procesando", hash });
```

El registro nace en estado `procesando`. El `hash` es una huella del body para detectar que alguien reusó la clave con otros datos.

**Paso 2: si no pudo reservar, es un reintento.**

```ts
if (!reservada) {
  const previo = await almacen.obtener(clave);
  if (!previo || previo.estado === "procesando") return res.status(409)...;  // otro está cobrando
  if (previo.hash !== hash)                       return res.status(422)...;  // misma clave, otros datos
  res.setHeader("Idempotent-Replayed", "true");
  return res.status(previo.status ?? 200).json(previo.respuesta);              // la misma respuesta
}
```

Estas son las cuatro cajas del diagrama de la diapositiva 16. El caso `!previo` cubre una situación borde: la clave existía en el `SET NX` pero desapareció antes del `GET` (venció o se liberó). Se responde 409 para que el cliente reintente.

**Paso 3: primera vez, se cobra.**

```ts
try {
  const pago = await procesarPago(cliente, monto);
  const eventoId = await publicarEventoSeguro(pago);
  const respuesta = { mensaje: "Pago procesado", pago, eventoId };
  await almacen.guardar(clave, { estado: "completado", hash, status: 201, respuesta });
  return res.status(201).json(respuesta);
} catch (err) {
  await almacen.liberar(clave);   // si el cobro falló, se libera la clave
  throw err;
}
```

Se guarda la respuesta **completa**, incluido el `eventoId`, para que un reintento reciba exactamente lo mismo que la primera vez (por eso devuelve 201 y no 200). Si el cobro falla, se borra la clave para que el cliente pueda reintentar sin quedar bloqueado 24 h.

### Los números de la demo, explicados con el round-robin

Escenario "reintentar ×3" (secuencial, misma clave):

| Modo | Intento 1 | Intento 2 | Intento 3 | Cobros |
|---|---|---|---|---|
| `off` | api-1 cobra | api-2 cobra | api-1 cobra | **3** |
| `memoria` | api-1 cobra | api-2 cobra (su `Map` está vacío) | api-1 REPETIDO | **2** |
| `redis` | api-1 cobra | api-2 REPETIDO | api-1 REPETIDO | **1** |

En el escenario de 20 simultáneos, los 409 vuelven antes que el 201 porque el ganador tarda 1 s en cobrar y los otros encuentran la clave en `procesando` al instante.

---

## 5. Deduplicación (`eventos.ts` + `worker.ts`)

### `eventos.ts`: el productor

```ts
export async function publicarEventoPago(pago: PagoEvento): Promise<string> {
  const eventoId = randomUUID();
  await redis.xAdd("pagos:eventos", "*", {
    eventoId, pagoId: String(pago.id), cliente: pago.cliente, monto: String(pago.monto),
  });
  return eventoId;
}
```

`XADD` agrega un mensaje al final del Stream. El `*` le pide a Redis que genere el ID del mensaje (algo como `1728321000000-0`, basado en el timestamp). Además, el código genera su **propio** `eventoId` con un UUID. Esa es la idea central de la deduplicación.

```ts
export async function reenviarEvento(eventoId: string): Promise<boolean> {
  const mensajes = await redis.xRevRange("pagos:eventos", "+", "-", { COUNT: 500 });
  const original = mensajes.find((m) => m.message.eventoId === eventoId);
  if (!original) return false;
  await redis.xAdd("pagos:eventos", "*", original.message);  // mismos campos, ID de stream NUEVO
  return true;
}
```

Esto simula la entrega repetida: busca el mensaje original (de más nuevo a más viejo) y lo publica de nuevo con los **mismos campos**. El mensaje reenviado recibe un ID de stream distinto, pero conserva el mismo `eventoId`. Si el worker deduplicara por el ID de stream, no detectaría nada.

En `pagos.ts`, la publicación va envuelta en `publicarEventoSeguro`: si el `XADD` falla, se loguea y `eventoId` queda en `null`, pero **el pago no falla**. El cobro ya ocurrió y no tiene sentido devolver error por no poder mandar el email.

### `worker.ts`: el consumidor

**Dos conexiones a Redis:**

```ts
const redis = createClient({ url: REDIS_URL });
const bloqueante = redis.duplicate();
```

`XREADGROUP ... BLOCK 2000` deja la conexión esperando hasta 2 s a que lleguen mensajes. Mientras tanto, esa conexión no puede ejecutar otros comandos. Por eso hay una conexión dedicada a la espera y otra para el `SET NX`, el `XACK`, el log y el heartbeat.

**El grupo de consumidores:**

```ts
await redis.xGroupCreate("pagos:eventos", "emails", "0", { MKSTREAM: true });
// si ya existe → error BUSYGROUP, que se ignora
```

Un grupo de consumidores permite que varios workers se repartan los mensajes y que Redis lleve la cuenta de cuáles se entregaron y cuáles se confirmaron. `MKSTREAM` crea el stream si todavía no existe, y el `"0"` hace que el grupo arranque desde el principio.

**El bucle de lectura:**

```ts
const respuesta = await bloqueante.xReadGroup(
  "emails", "worker-1", { key: "pagos:eventos", id: ">" }, { COUNT: 10, BLOCK: 2000 }
);
if (!respuesta) continue;   // pasaron 2 s sin mensajes
```

El `">"` significa "dame solo mensajes que todavía no se entregaron a este grupo".

**La deduplicación propiamente dicha:**

```ts
const dedup = (await redis.get("config:dedup")) ?? "on";
if (dedup === "on") {
  const ok = await redis.set(`dedup:${eventoId}`, "1", { NX: true, EX: DEDUP_TTL });
  if (ok === null) {
    // DUPLICADO DESCARTADO
    await redis.xAck(STREAM, GRUPO, id);   // igual se confirma: ya se manejó
    return;
  }
}
await esperar(300);                                     // "enviar el email"
await pool.query("INSERT INTO emails ...", [...]);
await redis.xAck(STREAM, GRUPO, id);
```

Es **el mismo mecanismo que la idempotencia**: `SET NX` sobre un identificador estable. La primera vez que aparece un `eventoId` el `SET` devuelve `"OK"` y se envía el email; la segunda devuelve `null` y se descarta. El duplicado también se confirma con `XACK`, porque ya se procesó (se decidió descartarlo).

El interruptor `config:dedup` se lee **por cada mensaje**, así que el cambio desde el panel tiene efecto inmediato sin reiniciar el worker. Cuando está en `off`, se saltea el `SET NX` y aparecen dos filas en `emails` con el mismo `evento_id`. Por eso la tabla `emails` en `init.sql` no tiene `UNIQUE`.

**Robustez:**

```ts
catch (err) {
  if (msg.includes("NOGROUP")) { await crearGrupo(); continue; }  // alguien borró el stream
  console.error("[worker] error en el bucle:", msg);
  await esperar(2000);                                            // Redis caído: esperar y seguir
}
```

**Heartbeat:**

```ts
setInterval(() => redis.set("worker:heartbeat", String(Date.now()), { EX: 5 }), 2000);
```

Se renueva cada 2 s con un TTL de 5 s. Si el worker muere, la clave vence sola en 5 s y `/admin/estado` lo reporta como caído. Es otro uso del TTL que vale la pena mencionar.

---

## 6. Fallas: qué pasa cuando Redis se cae

Este tema no está en un solo archivo: es el resultado de cómo cada parte maneja el error que produce `disableOfflineQueue`.

| Parte | Código responsable | Comportamiento |
|---|---|---|
| Caché | `leerCache` / `escribirCache` con `try/catch` que devuelve `null` | **Fail-open**: responde 200 desde Postgres, más lento |
| Pagos (modo `redis`) | el `catch` externo de `pagosRouter.post` | **Fail-closed**: el `SET NX` de `reservar` lanza error → 503, no se cobra |
| Worker | `catch` del `bucle` con `esperar(2000)` | Reintenta cada 2 s; los mensajes siguen en el stream |
| Panel | `/admin/estado` con un `try/catch` por chequeo | Responde 200 con `redis: false` |

El `catch` de los pagos:

```ts
} catch (err) {
  // Si no podemos verificar (ej: Redis caído), NO cobramos: preferimos fallar a duplicar
  return res.status(503).json({ error: "No se pudo procesar el pago de forma segura" });
}
```

La clave es que `reservar` se ejecuta **antes** de `procesarPago`. Si Redis no responde, la excepción salta antes de llegar al cobro.

Al volver Redis, la clave del pago anterior sigue ahí gracias al **AOF** (`--appendonly yes` + volumen). Es lo que prueba `demo/04_redis_caido.mjs`: el pago A se reintenta después del reinicio y da REPETIDO.

> **Ojo:** `docker compose stop` y `down` conservan el volumen; `docker compose down -v` lo borra, y con él el AOF.

---

## 7. Rutas del panel (`admin.ts` y `emails.ts`)

No son parte de la teoría, pero conviene saber qué hacen por si alguien pregunta.

**`GET /admin/estado`** responde `{ instancia, redis, postgres, worker }`. Cada chequeo tiene su propio `try/catch`, así la ruta responde 200 aunque Redis esté caído. `worker` es `true` si existe la clave `worker:heartbeat`.

**`GET /admin/redis`** recorre las claves con `SCAN` en tandas de 100 (nunca `KEYS *`, que bloquea Redis mientras recorre todo), oculta las internas (`config:*`, `worker:*`) y devuelve por cada clave el tipo, el TTL y un detalle: el `estado` del JSON para las `idem:*` y la cantidad de mensajes (`XLEN`) para el stream. Ordena por TTL descendente para que las recién creadas aparezcan arriba.

**`GET` / `POST /admin/dedup`** leen y escriben el interruptor `config:dedup`.

**`POST /admin/reenviar`** llama a `reenviarEvento`; devuelve 404 si el evento no está en la cola.

**`GET /admin/worker-log`** devuelve los últimos 30 resultados del worker (lista `worker:log`, que el worker mantiene con `LPUSH` + `LTRIM`).

**`POST /admin/reset`** vacía las tablas (`TRUNCATE ... RESTART IDENTITY`, así los ids vuelven a 1), restaura los precios, borra las claves de la demo con `SCAN` + `DEL` y vacía el stream con `XTRIM MAXLEN 0`. **No borra** el stream ni el grupo, porque el worker los necesita (aunque igual lo recrearía gracias al manejo de `NOGROUP`).

**`GET /emails?cliente=`** es la "bandeja de entrada": lee la tabla `emails` de Postgres.

---

## 8. Detalles finos que nos pueden preguntar

**¿La cola reentrega sola los mensajes?**
En Redis Streams, un mensaje entregado pero sin `XACK` queda en la *Pending Entries List* del grupo. Para reprocesarlo hay que reclamarlo con `XCLAIM`/`XAUTOCLAIM` o leer con id `0` en lugar de `>`. El worker solo lee `>`, así que en la demo la reentrega **se simula** con `reenviarEvento` (un nuevo `XADD` con los mismos campos). Es válido porque representa el otro caso real de duplicado (el productor publica dos veces por un reintento), pero conviene decirlo antes de que lo pregunten.

**¿Qué pasa si el worker se cae a mitad?**
Si cae después del `SET NX` y antes del `INSERT`, la clave `dedup:` ya está marcada y el email no sale nunca (es la limitación de la tabla de la diapositiva 21). Si cae después del `INSERT` y antes del `XACK`, el mensaje queda pendiente; si se reprocesara, la dedup lo descartaría, que es justamente para lo que sirve.

**¿Y si Redis cae justo después de cobrar?**
En modo `redis`, si `procesarPago` termina pero `almacen.guardar` falla, se ejecuta `liberar`, que probablemente también falle, y el cliente recibe 503 aunque se le cobró. Al volver Redis, la clave sigue en `procesando` y los reintentos dan 409 hasta que vence. Es la fila "La clave queda en procesando hasta que vence" de las limitaciones, y la razón de la "segunda barrera" con `UNIQUE` en la base que se usa en producción.

**¿Por qué el pago no falla si no se puede publicar el evento?**
Porque el cobro ya ocurrió: devolver error haría que el cliente reintente y, en los modos sin protección, se cobre dos veces. Es preferible perder el email.

**¿Cache-aside puede dejar un dato viejo aunque invalidemos?**
Sí, en una carrera: un lector lee el precio viejo de Postgres, el `PUT` actualiza y borra la clave, y después el lector guarda el valor viejo en caché. El TTL de 20 s acota ese problema.

**¿Por qué `SET NX` y no `GET` + `SET`?**
Porque entre los dos pasos se puede meter otro pedido: los dos ven "no existe" y los dos cobran. `SET NX` verifica y guarda en un solo comando atómico, y Redis ejecuta los comandos de a uno.

**¿Por qué el worker usa dos conexiones a Redis?**
Porque `XREADGROUP ... BLOCK` ocupa la conexión mientras espera mensajes. Si se usara la misma para el `SET NX` o el heartbeat, esos comandos quedarían trabados detrás de la espera.

**¿Por qué con Redis caído la caché sigue y los pagos no?**
Perder la caché solo cuesta velocidad, porque el dato real está en Postgres. Perder la idempotencia puede costar plata. Cada uso decide qué error es más aceptable.