import { Pool } from "pg";

// Pool de conexiones a Postgres (reutiliza conexiones en lugar de abrir una por consulta).
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL ?? "postgres://tp1:tp1@localhost:5432/tienda",
});

/**
 * init.sql solo corre la PRIMERA vez que se crea el volumen de Postgres.
 * Si el volumen viene de una versión anterior del TP, la tabla emails no existe
 * y el worker falla en silencio. Por eso la creamos al arrancar si hace falta.
 */
export const SQL_TABLA_EMAILS = `
  CREATE TABLE IF NOT EXISTS emails (
    id          SERIAL PRIMARY KEY,
    evento_id   TEXT           NOT NULL,
    pago_id     INTEGER        NOT NULL,
    cliente     TEXT           NOT NULL,
    monto       NUMERIC(10, 2) NOT NULL,
    enviado_en  TIMESTAMPTZ    NOT NULL DEFAULT now()
  )`;
