import { Pool } from "pg";

// Pool de conexiones a Postgres (reutiliza conexiones en lugar de abrir una por consulta).
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL ?? "postgres://tp1:tp1@localhost:5432/tienda",
});
