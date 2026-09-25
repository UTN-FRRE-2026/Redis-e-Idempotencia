# TP1 – Redis (datos y caché) + Idempotencia y deduplicación

**Integrantes:** Stabile Maximiliano, Jara Agostina, Sanchez Iván

## Arquitectura

```
cliente → nginx (:8080) → api-1 / api-2 (Node + TypeScript) → Redis + Postgres
```

| Servicio | Rol |
|---|---|
| `nginx` | Balanceador round-robin; único puerto expuesto (8080) |
| `api-1`, `api-2` | Dos réplicas de la misma API; header `X-Instance` indica cuál respondió |
| `redis` | Caché y almacén de claves de idempotencia (con AOF activado) |
| `postgres` | Fuente de verdad (productos y pagos) |

## Requisitos

- Docker y Docker Compose
- Node.js 18 o superior (solo para correr los scripts de `demo/`)

## Cómo levantar

```bash
docker compose up --build -d
docker compose ps          # todos los servicios deben estar "running" / "healthy"
node demo/00_health.mjs    # verifica balanceo y conexión a Redis/Postgres
```

## Endpoints

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/health` | Estado de la réplica y conexiones |
| GET | `/productos/:id` | Lee un producto (cache-aside). Header `X-Cache: HIT/MISS` |
| PUT | `/productos/:id` | Actualiza `precio`/`stock` e invalida la caché |
| POST | `/pagos?modo=off\|memoria\|redis` | Crea un pago. Header `Idempotency-Key` (obligatorio salvo en `off`). Body `{"cliente": "ana", "monto": 15000}` |
| GET | `/pagos?cliente=ana` | Cuántos cobros quedaron registrados para ese cliente |

> Los scripts usan `docker compose exec redis redis-cli`. Si Redis corre de otra forma, se puede cambiar con la variable `REDIS_CLI`.

## Comandos útiles

```bash
docker compose logs -f api-1 api-2                      # ver logs de las réplicas
docker compose exec redis redis-cli                     # consola de Redis
docker compose exec postgres psql -U tp1 -d tienda      # consola de Postgres
docker compose down -v                                  # apagar y BORRAR datos (reinicia la BD)
```

> **Al pasar de la Fase 2 a la 3** hay que ejecutar `docker compose down -v` y después `docker compose up --build -d`, porque se agregó la tabla `pagos`.
>
> Si se modifica `db/init.sql`, hay que ejecutar `docker compose down -v` para que Postgres lo vuelva a aplicar.

## Escenarios de la demo

| Script | Qué demuestra |
|---|---|
| `demo/00_health.mjs` | Infraestructura y balanceo entre réplicas |
| `demo/01_cache.mjs` | Caché: MISS vs HIT, caché compartida entre réplicas, TTL e invalidación (`--ttl` para ver el vencimiento) |
| `demo/02_idempotencia.mjs` | Un cliente reintenta el mismo pago 3 veces: sin protección (3 cobros), memoria local (2 cobros) y Redis (1 cobro) |
| `demo/03_concurrencia.mjs` | 20 peticiones simultáneas con la misma clave: memoria local (2 cobros) vs Redis (1 cobro) |
