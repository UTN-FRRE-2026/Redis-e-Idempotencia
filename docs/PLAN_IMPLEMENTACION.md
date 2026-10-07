# Plan de implementación

Proyecto: demo de **Redis (caché) + Idempotencia y deduplicación** en un sistema distribuido. TP universitario, se presenta el viernes en un coloquio de 30 minutos.

**Objetivo de este plan:** agregar al repo actual (que funciona y está probado) tres cosas:
1. Una **demo de deduplicación de mensajes** (cola con Redis Streams + worker).
2. **Rutas de administración** que necesita el panel.
3. Un **panel web visual** para hacer la demo en vivo.

**Regla principal: no reescribir lo que funciona.** Todos los cambios son agregados. Los scripts de `demo/` tienen que seguir funcionando al final.

Maqueta visual de referencia del panel: `docs/maqueta_panel.png`.

---

## 0. Estado actual del repo

| Pieza | Qué hace hoy |
|---|---|
| `docker-compose.yml` | nginx (único puerto expuesto, `8080:80`), `api-1` y `api-2` (misma imagen `tp1-api`, variable `INSTANCE`), Redis 7 con `--appendonly yes` y volumen, Postgres 16 con `db/init.sql`. Healthchecks en Redis y Postgres |
| `nginx/nginx.conf` | `upstream api_backend` con `zone` (estado compartido entre workers de nginx) y round-robin entre `api-1:3000` y `api-2:3000`. Hoy todo `/` va a la API |
| `api/` | Node 20 + TypeScript + Express 4, `redis` (node-redis v4), `pg`. Dockerfile multi-stage. Middleware que agrega `X-Instance` a cada respuesta y loguea `[instancia] MÉTODO url` |
| `api/src/redis.ts` | Cliente único con `disableOfflineQueue: true` (si Redis cae, los comandos fallan al instante) |
| `api/src/routes/productos.ts` | Cache-aside. `GET /productos/:id`: Redis → si no está, Postgres (`pg_sleep` de `DB_DELAY_MS`=500) → `SET producto:<id> EX CACHE_TTL_SECONDS`(20). Header `X-Cache: HIT\|MISS`. `PUT /productos/:id` actualiza `precio`/`stock` y hace `DEL` (`X-Cache: INVALIDATED`). La caché es **fail-open** |
| `api/src/idempotencia.ts` | Interfaz `AlmacenIdempotencia` (`reservar`, `obtener`, `guardar`, `liberar`). `AlmacenMemoria` (un `Map` por proceso) y `AlmacenRedis` (`SET idem:<clave> <json> NX EX 86400`) |
| `api/src/routes/pagos.ts` | `POST /pagos?modo=off\|memoria\|redis`, header `Idempotency-Key`, body `{cliente, monto}`. Cobro simulado: espera `PAGO_DELAY_MS`(1000) e inserta en `pagos`. Estados: procesando → 409; completado → misma respuesta (status 201) + header `Idempotent-Replayed: true`; otro hash del body → 422; si el cobro falla, libera la clave. Errores de Redis → 503 (**fail-closed**). `GET /pagos?cliente=` devuelve `{cliente, cantidad, total, pagos}` |
| `db/init.sql` | Tablas `productos` (3 filas de ejemplo) y `pagos (id, cliente, monto, atendido_por, creado_en)` |
| `demo/` | `lib.mjs` (helpers, `BASE_URL`, `REDIS_CLI`), scripts `00_health` a `04_redis_caido` |

No modificar `docs/INFORME.md`, `docs/GUION.md` ni `docs/PLAN.md`: el grupo los actualiza aparte.

---

## 1. Estructura final

```
├── docker-compose.yml        MODIFICAR: + servicio worker, montar frontend en nginx
├── nginx/nginx.conf          MODIFICAR: panel en /, API en /api/
├── db/init.sql               MODIFICAR: + tabla emails
├── api/src/
│   ├── index.ts              MODIFICAR: registrar rutas nuevas
│   ├── redis.ts, db.ts, idempotencia.ts, routes/productos.ts   SIN CAMBIOS
│   ├── routes/pagos.ts       MODIFICAR: publicar evento al cobrar
│   ├── routes/admin.ts       NUEVO
│   ├── routes/emails.ts      NUEVO
│   ├── eventos.ts            NUEVO: publicar y buscar eventos del stream
│   └── worker.ts             NUEVO: consumidor con deduplicación
├── frontend/                 NUEVO: index.html, styles.css, app.js
├── demo/lib.mjs              MODIFICAR: BASE_URL por defecto con /api
├── demo/05_dedup.mjs         NUEVO: plan B por terminal de la deduplicación
└── README.md                 MODIFICAR: panel, rutas nuevas, worker
```

---

## 2. Paso 1: backend

### 2.1 Base de datos (`db/init.sql`)

Agregar al final:

```sql
-- Cada fila es un email "enviado" por el worker. Si aparece dos veces el mismo evento_id,
-- el cliente recibió el comprobante dos veces.
CREATE TABLE emails (
    id          SERIAL PRIMARY KEY,
    evento_id   TEXT           NOT NULL,
    pago_id     INTEGER        NOT NULL,
    cliente     TEXT           NOT NULL,
    monto       NUMERIC(10, 2) NOT NULL,
    enviado_en  TIMESTAMPTZ    NOT NULL DEFAULT now()
);
```

Sin restricción `UNIQUE` en `evento_id`, a propósito: hay que poder mostrar el duplicado con la deduplicación apagada.

### 2.2 Publicación de eventos (`api/src/eventos.ts`)

- Stream: `pagos:eventos`.
- `publicarEventoPago(pago): Promise<string>`: genera `eventoId` (`crypto.randomUUID()`) y ejecuta `XADD pagos:eventos * eventoId <id> pagoId <id> cliente <c> monto <m>`. Devuelve el `eventoId`.
- `reenviarEvento(eventoId): Promise<boolean>`: busca el evento con `XREVRANGE pagos:eventos + - COUNT 500` y vuelve a hacer `XADD` con **los mismos campos** (mismo `eventoId`). Simula que la cola entregó el mensaje dos veces. Devuelve `false` si no lo encuentra.

### 2.3 Cambio en `routes/pagos.ts`

Cuando un pago **se cobra de verdad** (respuesta 201 nueva, en cualquier modo), llamar a `publicarEventoPago` y agregar `eventoId` a la respuesta: `{ mensaje, pago, eventoId }`.

- En modo `redis`, guardar en el almacén la respuesta **con** el `eventoId`, así los reintentos devuelven exactamente la misma respuesta.
- Si `XADD` falla (por ejemplo, Redis caído en modo `off` o `memoria`), **el pago no falla**: se loguea una advertencia y `eventoId` va como `null`.

### 2.4 Worker (`api/src/worker.ts`)

Proceso aparte, compilado con la misma imagen. Comando: `node dist/worker.js`.

**Inicio:**
- Conectarse a Postgres y a Redis.
- **Usar un cliente de Redis dedicado para la lectura bloqueante** (`redis.duplicate()` o `createClient` aparte), porque `XREADGROUP ... BLOCK` bloquea la conexión.
- Crear el grupo de consumidores: `XGROUP CREATE pagos:eventos emails 0 MKSTREAM`. Ignorar el error `BUSYGROUP` (el grupo ya existe).

**Bucle principal:**
1. `XREADGROUP GROUP emails worker-1 COUNT 10 BLOCK 2000 STREAMS pagos:eventos >`.
2. Por cada mensaje:
   - Leer `config:dedup` en Redis. Si no existe, se toma como `"on"`.
   - Si está en `on`: `SET dedup:<eventoId> 1 NX EX 86400`.
     - Si devuelve `null` → **duplicado descartado**: no inserta nada.
     - Si devuelve `OK` → sigue.
   - Si sigue: esperar 300 ms (simula enviar el email) e insertar en `emails`.
   - Registrar el resultado en una lista para el panel: `LPUSH worker:log <json>` y `LTRIM worker:log 0 29`, con `{ eventoId, pagoId, cliente, resultado: "enviado" | "duplicado descartado", dedup: "on" | "off", ts }`.
   - `XACK pagos:eventos emails <id>`.
   - Loguear en consola: `[worker] EMAIL ENVIADO evento=... pago=...` o `[worker] DUPLICADO DESCARTADO evento=...`.
3. **Heartbeat:** cada 2 segundos, `SET worker:heartbeat <timestamp> EX 5` (el panel lo usa para mostrar si el worker está vivo).

**Robustez (mínima):**
- Si Redis no responde, loguear, esperar 2 s y reintentar el bucle, sin terminar el proceso.
- Si llega el error `NOGROUP` (alguien borró el stream), recrear el grupo y seguir.

**Comentarios en el código:** explicar que la deduplicación usa un ID propio del evento (`eventoId`) y no el ID del mensaje en el stream, porque un mensaje reenviado recibe un ID nuevo de la cola pero conserva el mismo `eventoId`.

### 2.5 Rutas nuevas

**`routes/emails.ts`:**

| Ruta | Respuesta |
|---|---|
| `GET /emails?cliente=` | `{ cliente, cantidad, emails: [{id, evento_id, pago_id, monto, enviado_en}] }` |

**`routes/admin.ts`:**

| Ruta | Comportamiento |
|---|---|
| `GET /admin/estado` | `{ instancia, redis: bool, postgres: bool, worker: bool }`. Cada chequeo en su propio try/catch: **tiene que responder 200 aunque Redis esté caído**. `worker` = existe `worker:heartbeat` |
| `GET /admin/redis` | Si Redis cae → 503 `{ disponible: false }`. Si no: `SCAN` con `COUNT 100` (sin `KEYS *`), máximo 50 claves, excluyendo `config:*`, `worker:*` y la lista del log. Por clave: `{ clave, tipo, ttl, detalle }`. `detalle`: para `idem:*`, el `estado` del JSON; para streams, la cantidad de mensajes (`XLEN`). Ordenar las `idem:*` y `dedup:*` por TTL descendente (las recién creadas primero) |
| `GET /admin/dedup` | `{ dedup: "on" \| "off" }` (si no existe la clave, `"on"`) |
| `POST /admin/dedup` | Body `{ dedup: "on" \| "off" }`. Guarda `config:dedup` |
| `POST /admin/reenviar` | Body `{ eventoId }`. Llama a `reenviarEvento`. 404 si no existe |
| `GET /admin/worker-log` | Los últimos 30 elementos de `worker:log`, ya parseados |
| `POST /admin/reset` | (1) `TRUNCATE pagos, emails RESTART IDENTITY`. (2) Restaurar los productos a los valores de `init.sql` (`UPDATE` por id). (3) Borrar con `SCAN` + `DEL` las claves `idem:*`, `producto:*`, `dedup:*` y `worker:log`. (4) `XTRIM pagos:eventos MAXLEN 0`. **No borrar el stream ni el grupo** (el worker los necesita). Devuelve `{ ok: true }` |

Registrar las rutas en `index.ts`: `/emails` y `/admin`.

Limitación conocida (no hace falta resolverla): el reset no puede limpiar el `Map` del modo `memoria` de la otra réplica. No afecta la demo, porque cada escenario usa claves nuevas.

### 2.6 Docker Compose

- Servicio `worker`: misma `build`/`image` que la API, `command: ["node", "dist/worker.js"]`, mismas variables `REDIS_URL` y `DATABASE_URL`, `depends_on` Redis y Postgres con `condition: service_healthy`.
- En `nginx`: montar `./frontend:/usr/share/nginx/html:ro`.

### 2.7 nginx

```nginx
upstream api_backend {
    zone api_backend 64k;
    server api-1:3000;
    server api-2:3000;
}

server {
    listen 80;

    # Panel de la demo (archivos estáticos)
    location / {
        root /usr/share/nginx/html;
        index index.html;
    }

    # API: /api/productos/1 → http://api-x:3000/productos/1
    location /api/ {
        proxy_pass http://api_backend/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

### 2.8 Scripts de demo

- `demo/lib.mjs`: `BASE` por defecto pasa a ser `http://localhost:8080/api`.
- `demo/05_dedup.mjs` (nuevo, plan B por terminal):
  1. Con dedup en `off`: hace un pago, espera a que se envíe el email, reenvía el evento y muestra **2 emails**.
  2. Con dedup en `on`: lo mismo, pero muestra **1 email** y el log "duplicado descartado".
  3. Deja la dedup en `on` al terminar.
  Mismo estilo de salida que los otros scripts (secciones `=== ... ===`, ✅ / ❌).

### Criterios de aceptación del paso 1

- `docker compose down -v` y `docker compose up --build -d` levantan 6 servicios sin errores.
- `node demo/00_health.mjs` a `04_redis_caido.mjs` funcionan igual que antes.
- `node demo/05_dedup.mjs`: 2 emails con dedup en `off` y 1 con dedup en `on`.
- `GET /api/admin/estado` responde 200 con Redis apagado (`redis: false`).
- `docker compose logs -f worker` muestra los envíos y los duplicados descartados.

**Parar acá y esperar a que el grupo lo pruebe.**

---

## 3. Paso 2: panel web (estructura, caché e idempotencia)

### Reglas técnicas

- **HTML, CSS y JavaScript puros.** Sin React, sin npm, sin compilación. Tres archivos: `frontend/index.html`, `frontend/styles.css`, `frontend/app.js`.
- **Nada de internet:** ni CDNs ni Google Fonts ni imágenes remotas. Fuentes del sistema:
  - Texto: `system-ui, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`
  - Código: `ui-monospace, Consolas, "Cascadia Mono", monospace`
- Gráficos e íconos en **SVG inline**, dibujados a mano.
- Todas las llamadas a `/api/...` (mismo origen, sin CORS).
- `app.js` organizado por secciones con comentarios de bloque (Estado, Arquitectura, Redis por dentro, Caché, Idempotencia, Deduplicación, Fallas). Funciones cortas y nombres en español, para que el grupo pueda explicarlo.
- Pensado para proyectar: **1920×1080** sin scroll en la vista principal, y que también se vea bien en 1366×768 (puede haber scroll).

### Tokens de diseño (iguales al diagrama `docs/arquitectura.png`)

| Uso | Color |
|---|---|
| Fondo | `#EEF1F5` |
| Tarjetas | `#FFFFFF`, borde `#DCE2EA` |
| Texto principal | `#16233A` |
| Texto secundario | `#5B6B82` |
| Redis | `#D82C20` (fondo `#FCEBE9`, texto `#A61E15`) |
| Postgres | `#336791` (fondo `#E7EFF7`, texto `#234B6C`) |
| nginx / OK / HIT / COBRÓ correcto | `#1E8A4C` (fondo `#E5F3EA`, texto `#146B39`) |
| MISS / procesando / RECHAZADO | `#B76E00` (fondo `#FFF4E0`) |
| Cables inactivos | `#C8D0DB` |

Radios de 10 a 16 px, sin sombras pesadas. Seguir la maqueta `docs/maqueta_panel.png`.

### Layout

1. **Barra superior:** título "Tienda distribuida · panel de demo", luces de estado para api-1, api-2, Redis, Postgres y Worker, y botón **"Reiniciar demo"** (`POST /api/admin/reset` + limpiar el estado del panel).
   - Estado: consultar `GET /api/admin/estado` cada 1 s. Como nginx alterna, cada respuesta trae una réplica distinta: guardar el último estado de cada réplica. Si una réplica no responde en 3 s, se pone en rojo.
2. **Arquitectura en vivo:** SVG con Cliente → nginx → api-1/api-2 → Redis/Postgres, y Worker conectado a Redis (stream) y Postgres. Al lado, una caja "Último pedido" (método, ruta, réplica, resultado, tiempo).
   - **Animación:** después de cada respuesta, un punto recorre el camino real: Cliente → nginx → la réplica de `X-Instance` → destino. Destinos: HIT → Redis; MISS → Redis y después Postgres; pago cobrado → Redis y Postgres; pago repetido o rechazado → Redis. La réplica que atendió se resalta 1 s.
   - Implementarlo con `<animateMotion>` o con JS sobre `getPointAtLength`. Si se complica, alcanza con resaltar los nodos y cables del recorrido.
3. **Pestañas:** Caché · Idempotencia · Deduplicación · Fallas.
4. **Columna derecha fija, "Redis por dentro":** consultar `GET /api/admin/redis` cada 1 s. Una tarjeta por clave con el nombre (monospace), un chip de tipo o estado y una barra de TTL que se vacía. Las claves nuevas se resaltan 2 s. Si responde 503, mostrar "Redis no disponible" en rojo.

### Pestaña Caché

- Tres tarjetas de producto (ids 1 a 3) con nombre, precio y botón **Consultar** → `GET /api/productos/:id`. Medir el tiempo con `performance.now()`.
- Después de cada consulta, un sello grande **HIT** (verde) o **MISS** (naranja), con el tiempo y la réplica.
- **Gráfico de barras** (SVG) de las últimas 10 consultas: la altura es el tiempo en ms y el color depende de HIT o MISS. Mostrar el promedio de cada uno.
- **Anillo de TTL** por producto cacheado, a partir del `ttl` de `/api/admin/redis`.
- Campo **"Nuevo precio"** y botón Guardar → `PUT /api/productos/:id`. Mostrar un aviso "Caché invalidada".

### Pestaña Idempotencia

- **Selector de modo:** Sin protección (`off`) / Memoria local (`memoria`) / Redis (`redis`).
- **Botones de escenario.** Cada ejecución usa un `cliente` nuevo (`cliente-<modo>-<timestamp>`) y un monto de 15000:
  - **"Pagar $15.000":** 1 pedido con una clave nueva.
  - **"Se cortó la conexión: reintentar ×3":** 3 pedidos **secuenciales** con la misma clave.
  - **"Doble clic: 20 a la vez":** 20 pedidos simultáneos (`Promise.all`) con la misma clave.
- **Línea de tiempo:** una fila por intento con número, réplica, resultado y tiempo. Resultados:
  - **COBRÓ:** status 201 sin el header `Idempotent-Replayed`.
  - **REPETIDO:** con `Idempotent-Replayed: true` (**mirar el header antes que el status**, porque un repetido también devuelve 201).
  - **RECHAZADO:** status 409.
  - Para 20 pedidos, mostrar un resumen agrupado ("1 cobró, 19 rechazados") con la aclaración "agrupado, no en orden de llegada".
- **Billetera del cliente:** al terminar el escenario, `GET /api/pagos?cliente=`. Monto total grande, en verde si hubo 1 cobro y en rojo si hubo más ("Te cobraron $45.000 por una compra de $15.000").
- **Comparación de modos:** guardar en memoria del navegador el último total de cada modo para el último escenario usado, y mostrar barras horizontales (rojas si es más de un cobro, verde si es uno).

**Verificar la concurrencia desde el navegador:** los navegadores abren pocas conexiones simultáneas por host, así que los 20 pedidos pueden salir en tandas. Comprobar que en modo `memoria` sigan dando 2 cobros y en `redis` 1. Si no se reproduce, agregar `POST /admin/simular-concurrencia` `{modo, n}`, que lance los N pedidos desde el backend contra `http://nginx/` y devuelva los resultados.

### Criterios de aceptación del paso 2

- `http://localhost:8080` abre el panel, sin errores en la consola del navegador y sin pedidos a internet (verificar en la pestaña Network).
- Caché: el primer Consultar da MISS (~500 ms) y el segundo HIT (pocos ms); la clave aparece en "Redis por dentro" con su TTL bajando; Guardar la hace desaparecer.
- Idempotencia: el escenario ×3 da 3, 2 y 1 cobros según el modo; el ×20 da 2 en memoria y 1 en Redis.
- El diagrama resalta la réplica correcta en cada pedido.

**Parar acá y esperar a que el grupo lo pruebe.**

---

## 4. Paso 3: panel web (deduplicación y fallas)

### Pestaña Deduplicación

- **Interruptor ON/OFF** sincronizado con `GET` y `POST /api/admin/dedup`.
- Botón **"Pagar $15.000"**: un pago en modo `redis` con un cliente nuevo; guardar el `eventoId` de la respuesta.
- Botón **"La cola entrega el mensaje de nuevo"** (deshabilitado hasta que haya un `eventoId`): `POST /api/admin/reenviar`.
- **Bandeja de entrada del cliente:** consultar `GET /api/emails?cliente=` cada 1 s. Cada email como una tarjeta tipo correo ("Comprobante de pago #6 · $15.000"). Si hay más de un email del mismo `evento_id`, marcarlos en rojo: "Comprobante duplicado".
- **Registro del worker:** `GET /api/admin/worker-log` cada 1 s. Lista con chips "ENVIADO" (verde) y "DUPLICADO DESCARTADO" (azul).
- Un pequeño esquema arriba: API → cola `pagos:eventos` → Worker → Email.

### Pestaña Fallas

Sin botones que apaguen nada: Redis se apaga desde la terminal (`docker compose stop redis`).

- Texto guía con los comandos `docker compose stop redis` y `docker compose start redis`, con un botón para copiar.
- Tres indicadores grandes que se actualizan solos con `/api/admin/estado`:
  - **Redis:** disponible / caído.
  - **Caché:** "funciona sin Redis (más lenta)" en naranja cuando Redis cae (**fail-open**).
  - **Pagos:** "rechazados para no cobrar dos veces" en rojo cuando Redis cae (**fail-closed**).
- Botones de prueba en la misma pestaña: **"Consultar producto"** y **"Intentar pago"**, que muestran el resultado real (200 desde Postgres / 503).
- Botón **"Reintentar el pago anterior"**: reintenta, con la misma clave, el último pago cobrado **antes** de la caída. Al volver Redis debe dar REPETIDO (la clave sobrevivió gracias al AOF).
- Cuando Redis cae, el diagrama de arquitectura muestra Redis en rojo con sus cables punteados, y el estado global de la barra superior lo refleja.

### Criterios de aceptación del paso 3

- Deduplicación: con OFF, reenviar genera 2 emails (marcados en rojo); con ON, 1 email y el registro dice "duplicado descartado".
- Fallas: con Redis apagado, la consulta de producto responde desde Postgres, el pago da 503 y el panel no se cuelga ni deja de actualizarse. Al prender Redis, todo vuelve a verde solo y el reintento del pago anterior da REPETIDO.
- "Reiniciar demo" deja el panel y los datos como al principio.

**Parar acá y esperar a que el grupo lo pruebe.**

---

## 5. Paso 4: README

Actualizar `README.md`:
- Una sección **"Panel de demo"** al principio: `docker compose up --build -d` y abrir `http://localhost:8080`.
- La tabla de servicios con el worker.
- La tabla de endpoints con las rutas nuevas y el prefijo `/api`.
- La tabla de scripts con `05_dedup.mjs`.
- Comandos útiles: `docker compose logs -f worker`.

---

## 6. Restricciones generales

- No cambiar el comportamiento de lo que ya existe (caché, idempotencia, fail-open/closed, scripts 00 a 04).
- TypeScript estricto (`strict: true`), sin `any` innecesarios.
- Comentarios en español en las partes clave (cache-aside, `SET NX`, deduplicación por `eventoId`, fail-open/closed).
- Nada de dependencias nuevas en la API salvo que sea imprescindible (node-redis v4 ya soporta streams: `xAdd`, `xReadGroup`, `xGroupCreate`, `xAck`, `xRevRange`, `xTrim`).
- Todo tiene que funcionar en Windows con Docker Desktop (los scripts usan Node, no bash).
- No usar `KEYS *` en Redis: usar `SCAN`.
