# Informe TP1 – Redis (datos y caché) + Idempotencia y deduplicación

**Integrantes:** Stabile Maximiliano, Jara Agostina, Sanchez Iván
**Estado:** en construcción completo. Guion del coloquio en `docs/GUION.md`

---

## 1. Idea general

En un sistema distribuido hay **varias copias de un mismo servicio** (réplicas) que no comparten memoria. Eso trae dos problemas:

1. **Lentitud:** si cada consulta va a la base de datos, todo se vuelve lento.
2. **Operaciones repetidas:** si un cliente reintenta (por ejemplo, un pago), otra réplica no sabe que la operación ya se hizo.

**Redis** resuelve ambos porque es una memoria **rápida y compartida** por todas las réplicas: sirve como **caché** (tema 1) y como registro de operaciones ya hechas para lograr **idempotencia** (tema 2).

**Escenario:** API de una tienda online con productos (se leen mucho) y pagos (no se pueden duplicar).

## 2. Arquitectura

```
cliente → nginx (:8080) → api-1 / api-2 → Redis (caché, claves) + Postgres (fuente de verdad)
```

- **nginx:** balanceador, reparte las peticiones entre las réplicas.
- **api-1 y api-2:** la misma API (Node + TypeScript). El header `X-Instance` dice cuál respondió.
- **Postgres:** donde vive el dato real ("fuente de verdad").
- **Redis:** memoria compartida y rápida. Con AOF activado guarda las escrituras en disco.

---

## 3. Fase 1 – Infraestructura

**Qué hicimos:** levantamos los 5 contenedores con Docker Compose. Las APIs esperan a que Redis y Postgres estén "sanos" (healthcheck) antes de arrancar. Solo nginx expone un puerto.

**Problema encontrado:** esperábamos que las peticiones se alternaran api-1, api-2, api-1..., pero salían **de a pares** (api-1, api-1, api-2, api-2).

**Causa:** nginx trabaja con varios procesos (*workers*) y cada uno llevaba **su propio contador** de a quién le tocaba.

**Solución:** la directiva `zone` en el `upstream`, que hace que los workers **compartan** ese estado en una memoria común.

**Lección:** es el mismo problema que resuelve el TP. **Estado local por proceso + varios procesos = cada uno toma decisiones sin saber lo que hizo el otro.** La solución siempre es compartir el estado.

---

## 4. Fase 2 – Caché con Redis

### Concepto (en simple)

La caché es como anotar una respuesta en un papelito para no tener que ir a buscarla de nuevo. Redis guarda una **copia** del dato en memoria RAM, que es mucho más rápida que la base de datos.

- **HIT:** el dato estaba en la caché → respuesta rápida.
- **MISS:** no estaba → se busca en la base y se guarda una copia.
- **TTL (*time to live*):** tiempo tras el cual Redis borra la copia sola, para no servir datos viejos para siempre.
- **Invalidación:** cuando el dato cambia, se borra la copia a mano.

### Patrón usado: cache-aside

1. La API busca en Redis (`GET producto:1`).
2. Si no está, consulta Postgres y guarda la copia con TTL (`SET producto:1 ... EX 20`).
3. Al modificar (`PUT`), primero actualiza Postgres y después **borra** la copia (`DEL producto:1`).

Se llama *cache-aside* ("caché al costado") porque la aplicación decide cuándo leer y escribir la caché; la base de datos no sabe que existe.

### Qué demostramos (`demo/01_cache.mjs`)

| Paso | Resultado obtenido |
|---|---|
| 1ª consulta | MISS, 1431 ms en api-1 (va a Postgres) |
| 2ª y 3ª consulta | HIT, 6 ms y 4 ms, **la 2ª atendida por api-2** (la caché es compartida) |
| PUT con precio nuevo | `EXISTS producto:1 → 0`: la copia se borró |
| Consulta siguiente | MISS (507 ms) con el precio nuevo, luego HIT (3 ms) |
| `--ttl` | Pasados 21 s, Redis borró la clave solo y la consulta volvió a ser MISS (577 ms) |

Evidencias:
- `evidencias/01_cache_primera_ejecucion.png`: primera corrida. El precio pasa de $45000 a $42095 (primer MISS: 660 ms).
- `evidencias/01_cache_con_ttl.png`: segunda corrida con `--ttl`. Arranca en $42095 porque **el cambio anterior quedó guardado en Postgres**, la fuente de verdad (primer MISS: 1431 ms).

**Observación 1, arranque en frío:** la primera consulta de cada corrida tardó más que los ~500 ms simulados (660 ms y 1431 ms). Cuando una réplica habla por primera vez con Postgres tiene que abrir y autenticar la conexión. Después el *pool* reutiliza esa conexión y los MISS tardan solo la demora simulada (~507 ms).

**Observación 2:** en ambas corridas el primer `DEL producto:1` devolvió `0` porque no había nada en caché (el TTL ya había vencido). Es correcto: la caché es temporal, el dato real sigue en Postgres.

**Resultado:** la caché es ~100 veces más rápida que ir a la base (≈5 ms contra ≈500 ms).

### Cuándo conviene

Datos que se **leen mucho y cambian poco** (catálogos, configuraciones, perfiles), o consultas costosas que se repiten.

### Limitaciones

- **Datos desactualizados:** si alguien cambia la base sin pasar por la API, la caché muestra el dato viejo hasta que venza el TTL.
- **Memoria limitada:** Redis vive en RAM; cuando se llena, descarta claves según una política (por ejemplo, las menos usadas).
- **Si Redis se cae:** la caché está programada como *fail-open*: las consultas van directo a Postgres (más lentas, pero funcionan). Si justo en ese momento se modifica un producto, no se puede borrar la copia vieja, que se corrige sola al vencer el TTL.
- **Cache stampede:** si vence una clave muy consultada, muchas peticiones van a la base al mismo tiempo.

---

## 5. Fase 3 – Idempotencia y deduplicación

### Concepto (en simple)

Una operación es **idempotente** si hacerla una vez o muchas veces deja el mismo resultado. Leer un producto lo es; **cobrar no**: cada cobro repetido le saca plata al cliente.

**¿Por qué llegan pedidos repetidos?** Por timeouts (el cliente no sabe si el pago se hizo y reintenta), doble clic, reintentos automáticos o colas de mensajes que entregan "al menos una vez".

**Idempotency-Key:** el cliente genera un identificador único (UUID) **por cada pago** y lo manda en el header. Todos los reintentos de ese pago llevan la misma clave. El servidor anota la clave y, si la vuelve a ver, **no cobra de nuevo**: devuelve la misma respuesta de la primera vez. Es el mismo mecanismo que usan pasarelas de pago reales, como Stripe.

**Deduplicación:** es la misma idea aplicada a mensajes. Se descartan los que tienen un ID ya procesado.

### Cómo funciona en nuestra API

1. Llega `POST /pagos` con `Idempotency-Key: abc`.
2. `SET idem:abc {"estado":"procesando"} NX EX 86400`. **NX** significa "guardar solo si No eXiste", y Redis lo hace en una sola operación atómica: si llegan 20 pedidos a la vez, **solo uno gana**.
3. Si ganó, cobra, guarda en Postgres y actualiza la clave a `completado` junto con la respuesta.
4. Si la clave ya existía:
   - Si está en **procesando**, responde `409`: "reintentá en unos segundos".
   - Si está **completado**, devuelve la respuesta guardada con el header `Idempotent-Replayed: true`, sin cobrar.
   - Si llegó la misma clave con **otros datos**, responde `422`: es un error del cliente.
5. Si el cobro falla, borra la clave para que se pueda reintentar.

El código tiene **dos almacenes con la misma interfaz** (`api/src/idempotencia.ts`): uno en memoria local (un `Map`) y otro en Redis. La lógica es idéntica; **solo cambia dónde se guarda la clave**. Eso aísla exactamente la variable que queremos demostrar.

### Qué demostramos

**Reintentos (`demo/02_idempotencia.mjs`):** el mismo pago enviado 3 veces.

| Modo | Qué pasa | Cobros |
|---|---|---|
| off | Cada intento cobra | 3 ❌ |
| memoria | api-1 cobra, api-2 **no sabe** y cobra de nuevo, el 3er intento vuelve a api-1, que sí lo recuerda | 2 ❌ |
| redis | api-1 cobra, api-2 **ve la clave en Redis** y devuelve la respuesta guardada | 1 ✅ |

**Concurrencia (`demo/03_concurrencia.mjs`):** 20 pedidos simultáneos con la misma clave.

| Modo | Resultado | Cobros |
|---|---|---|
| memoria | Cada réplica deja pasar uno y rechaza el resto (409) | 2 ❌ (uno por réplica) |
| redis | Solo 1 de los 20 gana el `SET NX`; los otros 19 reciben 409 | 1 ✅ |

Evidencias: `evidencias/02_idempotencia.txt` y `evidencias/03_concurrencia.txt` (salida real con Docker).

**Verificación cruzada:** el último pago tiene `id=9`, que coincide con la suma de todos los cobros de las dos corridas (3 + 2 + 1 + 2 + 1 = 9). La base registró **solo** los cobros que los scripts marcaron como procesados: ningún reintento generó un cobro oculto.

**Detalle de la concurrencia en Redis:** los 20 pedidos se repartieron 10 y 10 entre las réplicas, y el ganador fue un pedido de api-2. No importa qué réplica gane; importa que **gana uno solo**.

### Cuándo conviene

En toda operación que **no debe repetirse**: pagos, transferencias, crear pedidos, enviar emails o notificaciones, y consumidores de colas de mensajes.

### Limitaciones

- **Ventana de tiempo:** la clave se recuerda 24 h (TTL). Un reintento posterior se trataría como un pago nuevo.
- **Depende del cliente:** si el cliente genera una clave nueva en cada reintento, no hay protección posible.
- **Si Redis se cae:** los pagos están programados como *fail-closed*: se rechazan con 503 en lugar de arriesgar un cobro doble. Lo demuestra `demo/04_redis_caido.mjs`: el pago se rechazó al instante sin cobrar, y un pago hecho **antes** de la caída no se volvió a cobrar al reintentarlo después, porque la clave sobrevivió al reinicio gracias al **AOF** (Redis la había guardado en disco).
- **Si el proceso muere a mitad del cobro:** la clave queda en "procesando" hasta que vence el TTL. En producción se usa un TTL corto para ese estado.
- **Segunda barrera:** en producción se agregaría una restricción `UNIQUE` en la base sobre la clave. No la pusimos para poder mostrar el problema en los modos sin protección.

### Detalles que aparecieron al programar

- **Un reintento devuelve el mismo código (201) que el original**, no un 200. Es a propósito: el cliente recibe exactamente la misma respuesta. Para distinguirlo se usa el header `Idempotent-Replayed`. Al principio nuestro script miraba solo el código y mostraba "cobrado" en los reintentos, aunque la base tenía un solo cobro.
- **Con Redis caído, la API se quedaba colgada 60 s** hasta que nginx cortaba (504), porque la librería de Redis guardaba los comandos en una cola esperando reconectar. Lo solucionamos con `disableOfflineQueue: true`: ahora falla al instante y cada parte decide qué hacer (la caché sigue sin Redis y los pagos se rechazan).

---

## 6. Relación entre los dos temas

| | Caché | Idempotencia |
|---|---|---|
| Para qué usa Redis | Guardar copias de datos para leer rápido | Recordar qué operaciones ya se hicieron |
| Por qué Redis y no memoria local | Para que todas las réplicas aprovechen la misma copia | Para que todas las réplicas sepan qué se cobró |
| Operación clave | `GET` / `SET ... EX` / `DEL` | `SET ... NX EX` (atómico) |
| Si Redis se cae | *Fail-open*: sigue funcionando, más lento | *Fail-closed*: rechaza, para no duplicar |
| Si se pierde un dato | No pasa nada, está en Postgres | Riesgo de duplicado → por eso usamos AOF |

**Idea común:** en un sistema distribuido, el estado que guarda cada proceso en su memoria no alcanza. Lo vimos tres veces: en el balanceo de nginx, en la caché y en la idempotencia.

---

## 7. Conclusión técnica

En un sistema distribuido, el estado que cada proceso guarda en su propia memoria no alcanza: lo comprobamos en el balanceo de nginx, en la caché y en la idempotencia. Redis resuelve ambos temas porque es una memoria **compartida, rápida y con operaciones atómicas** (`SET NX`).

Pero no es gratis: es una pieza más que se puede caer, vive en RAM y sus copias pueden quedar desactualizadas. Por eso cada uso tiene que decidir qué pasa cuando falla. La caché sigue sin Redis porque perderla solo cuesta velocidad; los pagos se frenan porque un error cuesta plata. La idempotencia, además, no evita que lleguen pedidos repetidos: evita que **tengan efecto**.

---

## 8. Posibles preguntas de la cátedra

**¿Por qué no guardar la caché en una variable dentro de la API?**
Porque cada réplica tendría su propia copia: api-2 no aprovecharía lo que cacheó api-1, y al invalidar en una la otra seguiría con el dato viejo.

**¿Por qué se borra la clave en el PUT en vez de actualizarla?**
Es más simple y seguro: la próxima lectura trae el dato fresco de la fuente de verdad. Actualizar la caché a mano arriesga guardar un valor distinto al de la base.

**¿Qué pasa si se reinicia Redis?**
La caché se puede perder sin problema, porque el dato real está en Postgres. Tenemos AOF activado, que será más importante para las claves de idempotencia.

**¿Cómo elegir el TTL?**
Depende de cuánto tiempo es aceptable mostrar un dato viejo. En la demo usamos 20 s para poder mostrarlo; en producción podrían ser minutos u horas.

**¿Por qué el `SET NX` y no primero un `GET` y después un `SET`?**
Porque entre el `GET` y el `SET` otro pedido puede hacer lo mismo: ambos ven "no existe" y ambos cobran. `SET NX` verifica y guarda en un solo paso atómico.

**¿Quién genera la Idempotency-Key?**
El cliente, una por cada operación que quiere hacer. Si la generara el servidor, no podría reconocer los reintentos.

**¿Por qué la memoria local dio exactamente 2 cobros en la concurrencia?**
Porque dentro de una misma réplica sí funciona (Node ejecuta el código de a un pedido por vez), pero hay dos réplicas con dos `Map` distintos: cada una dejó pasar un pago.

**¿Por qué con Redis caído la caché sigue y los pagos no?**
Porque perder la caché solo cuesta velocidad, mientras que perder la idempotencia cuesta plata. Cada caso decide qué error es más aceptable.
