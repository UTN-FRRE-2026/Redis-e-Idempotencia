# Guion del coloquio (15 minutos)

| Tramo | Minutos | Quién | Qué |
|---|---|---|---|
| Introducción | 0:00 a 3:00 | Iván, Agostina, Maximiliano | Problema, diagrama y los dos conceptos |
| Demo | 3:00 a 12:00 | Iván, Agostina, Maximiliano, Iván | Balanceo, caché, idempotencia, caída de Redis |
| Cierre | 12:00 a 15:00 | Iván + todos | Conclusión y preguntas |

Las frases entre comillas son una guía: **no hay que leerlas ni memorizarlas**, solo entender la idea y decirla con palabras propias.

---

## Antes de entrar (preparación)

1. Con wifi, ejecutar `docker compose build` para tener las imágenes listas.
2. Justo antes de empezar, arrancar limpio con `docker compose down -v` y después `docker compose up -d`.
3. Correr `node demo/00_health.mjs` una vez para confirmar que todo responde.
4. Dejar abiertas tres ventanas:
   - **Imagen:** `docs/arquitectura.png` en pantalla completa.
   - **Terminal A:** donde se ejecutan los scripts, con letra grande (Ctrl + `+`).
   - **Terminal B:** `docker compose logs -f --tail 0 api-1 api-2`, para ver en vivo qué hace cada réplica.
5. Tener a mano el video de respaldo y la carpeta `evidencias/`, por si algo falla.

---

## 1. Introducción (0:00 a 3:00)

### Iván: el problema (1:30) · muestra la imagen

> "Hoy las aplicaciones no corren en un solo servidor: corren varias copias del mismo servicio, llamadas réplicas, para aguantar más carga y no caerse. Armamos una tienda online con dos réplicas, api-1 y api-2, y un balanceador, nginx, que les reparte los pedidos en turnos."

Señalar en la imagen la línea roja entre las réplicas:

> "El problema es que cada réplica tiene su propia memoria y no comparten nada. Eso trae dos problemas: si cada consulta va a la base de datos, todo es lento; y si un cliente reintenta un pago, la otra réplica no sabe que ya se cobró. Los dos problemas se resuelven con lo mismo: Redis, una memoria rápida y compartida por todas las réplicas."

### Agostina: qué es una caché (0:45) · sigue la imagen, señala "Caché" en Redis

> "Una caché es guardar una copia de un dato en un lugar rápido para no ir a buscarlo cada vez. Redis guarda los datos en memoria RAM, que es mucho más rápida que la base. Si el dato está, es un HIT; si no está, es un MISS: se busca en la base y se guarda una copia. La copia tiene un TTL, un tiempo de vida, para que no quede vieja para siempre."

### Maximiliano: qué es la idempotencia (0:45) · señala "Idempotencia" en Redis

> "Una operación es idempotente si hacerla una o muchas veces da el mismo resultado. Consultar un producto lo es, pero cobrar no: cada cobro repetido le saca plata al cliente. La solución es que cada pago lleve un número único, la Idempotency-Key. El servidor lo anota en Redis y, si le vuelve a llegar, no cobra de nuevo: devuelve la misma respuesta de la primera vez."

---

## 2. Demo (3:00 a 12:00)

### Iván: todo funciona y hay dos réplicas (0:30)

```bash
node demo/00_health.mjs
```

> "Todo corre en contenedores con Docker Compose. Mandamos seis pedidos a la misma dirección y nginx los reparte: api-1, api-2, api-1... Dos servidores distintos atendiendo la misma tienda."

### Agostina: caché (2:30)

```bash
node demo/01_cache.mjs
```

Qué señalar en la salida, en orden:

1. **Consulta #1, MISS, unos 500 ms:** "La primera vez no está en caché, va a Postgres, que es lento."
2. **Consulta #2, HIT, unos 5 ms, en la otra réplica:** "La segunda sale de Redis, cien veces más rápido. Y fíjense que la atendió **la otra réplica**: encontró el dato que guardó la primera. Eso es porque la caché es compartida."
3. **Paso 3, TTL de 20 segundos:** "Redis borra la copia sola a los 20 segundos."
4. **Paso 4, PUT e INVALIDATED:** "Cuando cambia el precio, actualizamos la base y borramos la copia. Si no la borráramos, seguiríamos mostrando el precio viejo."
5. **Paso 5, MISS con precio nuevo y después HIT:** "La siguiente lectura trae el precio nuevo y lo vuelve a guardar."

En la **terminal B** se ven los mensajes `CACHE MISS` y `CACHE HIT`.

### Maximiliano: idempotencia con reintentos (3:00)

```bash
node demo/02_idempotencia.mjs
```

> "Simulamos un cliente al que se le cortó la conexión y reintenta el mismo pago tres veces, con la misma clave. Lo probamos en tres modos."

1. **Modo off, 3 cobros:** "Sin protección, le cobramos tres veces."
2. **Modo memoria, 2 cobros:** "Cada réplica anota los pagos en su propia memoria. api-1 cobra; el reintento cae en api-2, que no sabe nada y cobra de nuevo. El tercero vuelve a api-1, que sí se acuerda. Funciona a medias: con varias réplicas, la memoria local no alcanza."
3. **Modo redis, 1 cobro:** "Con Redis, api-2 encuentra la clave que anotó api-1 y devuelve la misma respuesta sin cobrar. Un solo cobro."
4. **Lo que guardó Redis:** "Esto es lo que quedó anotado: el estado completado y la respuesta original, por 24 horas."

### Maximiliano: idempotencia con pedidos simultáneos (1:30)

```bash
node demo/03_concurrencia.mjs
```

> "Ahora el caso más difícil: veinte pedidos exactamente al mismo tiempo, como un doble clic con reintentos. En memoria, cada réplica deja pasar uno: dos cobros. Con Redis, de los veinte gana uno solo."

Si preguntan cómo:

> "Usamos `SET` con la opción `NX`, que significa 'guardar solo si no existe'. Redis lo hace en un solo paso, así que es imposible que dos pedidos ganen a la vez."

### Iván: limitaciones, ¿y si Redis se cae? (1:30)

```bash
node demo/04_redis_caido.mjs
```

1. **Paso 3, el producto se lee igual:** "La caché falla abierta: sin Redis seguimos leyendo de Postgres, más lento pero funciona."
2. **Paso 4, pago rechazado con 503:** "Los pagos fallan cerrados: si no podemos verificar si es un pago repetido, preferimos no cobrar a cobrar dos veces."
3. **Paso 6, el pago A no se cobra de nuevo:** "Cuando Redis vuelve, la clave del pago anterior sigue ahí, porque Redis la guardó en disco (AOF). El reintento no cobra."

---

## 3. Cierre (12:00 a 15:00)

### Iván: conclusión técnica (1:00)

> "En un sistema distribuido, lo que cada servidor guarda en su propia memoria no alcanza. Lo vimos tres veces: en el balanceo de nginx, en la caché y en la idempotencia. Redis resuelve los dos temas porque es una memoria compartida, rápida y con operaciones atómicas. Pero tiene un costo: es otra pieza que se puede caer, vive en RAM y sus copias pueden quedar desactualizadas. Por eso cada uso decide qué pasa cuando falla: la caché sigue sin Redis porque perderla solo cuesta velocidad; los pagos se frenan porque un error cuesta plata."

### Todos: preguntas (2:00)

Responde quien sepa más de ese tema, pero **cualquiera tiene que poder contestar**. Las respuestas a las preguntas más probables están en `docs/INFORME.md`, sección 8.

---

## Plan B, si algo falla

| Problema | Qué hacer |
|---|---|
| Docker no levanta o no hay internet | Mostrar el video de respaldo |
| Un script da error en medio | Mostrar la salida guardada en `evidencias/` y seguir con el próximo |
| Se pasan de tiempo | Saltear `00_health.mjs` y la parte de concurrencia; nunca saltear el `02` |
| Datos raros de corridas anteriores | `docker compose down -v` y `docker compose up -d` (tarda unos 15 segundos) |

## Video de respaldo

Grabar la pantalla (con OBS o la grabadora de Windows, `Win + Alt + R`) mientras se corren los scripts del `01` al `04` en orden, con la terminal de logs visible. No hace falta hablar; con 3 a 5 minutos alcanza. Guardarlo en `evidencias/` o subirlo a YouTube como "no listado" y poner el link en el README si pesa demasiado para GitHub.
