import { redis } from "./redis";

const TTL_SEGUNDOS = Number(process.env.IDEMPOTENCY_TTL_SECONDS ?? 86400);

/** Lo que recordamos de cada operación, identificada por su Idempotency-Key. */
export interface RegistroIdempotencia {
  estado: "procesando" | "completado";
  hash: string;          // "huella" del body, para detectar misma clave con otro contenido
  status?: number;       // código HTTP de la respuesta original
  respuesta?: unknown;   // respuesta original, para devolverla igual en los reintentos
}

/**
 * Interfaz común: la lógica de idempotencia es la MISMA en los dos casos.
 * Lo único que cambia es DÓNDE se guarda el registro.
 */
export interface AlmacenIdempotencia {
  /** Guarda el registro SOLO si la clave no existe. Devuelve true si la pudo reservar. */
  reservar(clave: string, registro: RegistroIdempotencia): Promise<boolean>;
  obtener(clave: string): Promise<RegistroIdempotencia | null>;
  guardar(clave: string, registro: RegistroIdempotencia): Promise<void>;
  liberar(clave: string): Promise<void>;
}

/**
 * MEMORIA LOCAL: un Map dentro del proceso.
 * Funciona si hay una sola réplica, pero cada réplica tiene SU PROPIO Map:
 * api-2 no se entera de lo que procesó api-1.
 */
export class AlmacenMemoria implements AlmacenIdempotencia {
  private registros = new Map<string, RegistroIdempotencia>();

  async reservar(clave: string, registro: RegistroIdempotencia): Promise<boolean> {
    if (this.registros.has(clave)) return false;
    this.registros.set(clave, registro);
    return true;
  }
  async obtener(clave: string) {
    return this.registros.get(clave) ?? null;
  }
  async guardar(clave: string, registro: RegistroIdempotencia) {
    this.registros.set(clave, registro);
  }
  async liberar(clave: string) {
    this.registros.delete(clave);
  }
}

/**
 * REDIS: un almacén COMPARTIDO por todas las réplicas.
 * La clave está en SET ... NX: "guardar solo si No eXiste", en una única operación atómica.
 * Si llegan 20 pedidos a la vez con la misma clave, Redis garantiza que solo UNO gana.
 */
export class AlmacenRedis implements AlmacenIdempotencia {
  private k = (clave: string) => `idem:${clave}`;

  async reservar(clave: string, registro: RegistroIdempotencia): Promise<boolean> {
    const r = await redis.set(this.k(clave), JSON.stringify(registro), { NX: true, EX: TTL_SEGUNDOS });
    return r === "OK"; // null = la clave ya existía
  }
  async obtener(clave: string) {
    const v = await redis.get(this.k(clave));
    return v ? (JSON.parse(v) as RegistroIdempotencia) : null;
  }
  async guardar(clave: string, registro: RegistroIdempotencia) {
    await redis.set(this.k(clave), JSON.stringify(registro), { EX: TTL_SEGUNDOS });
  }
  async liberar(clave: string) {
    await redis.del(this.k(clave));
  }
}
