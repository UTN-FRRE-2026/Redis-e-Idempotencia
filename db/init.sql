-- Se ejecuta automáticamente la PRIMERA vez que se crea el contenedor de Postgres.
-- Postgres es la "fuente de verdad": el dato real vive acá, Redis solo guarda copias.

CREATE TABLE productos (
    id      SERIAL PRIMARY KEY,
    nombre  TEXT           NOT NULL,
    precio  NUMERIC(10, 2) NOT NULL,
    stock   INTEGER        NOT NULL
);

INSERT INTO productos (nombre, precio, stock) VALUES
    ('Teclado mecánico', 45000.00, 12),
    ('Mouse inalámbrico', 18000.00, 30),
    ('Monitor 24"',      210000.00, 5);

-- Cada fila es un COBRO real. Si aparece dos veces el mismo pago, el cliente pagó dos veces.
-- (En producción se agregaría UNIQUE sobre la Idempotency-Key como segunda barrera;
--  acá no la ponemos para poder MOSTRAR el problema en los modos off y memoria.)
CREATE TABLE pagos (
    id            SERIAL PRIMARY KEY,
    cliente       TEXT           NOT NULL,
    monto         NUMERIC(10, 2) NOT NULL,
    atendido_por  TEXT           NOT NULL,
    creado_en     TIMESTAMPTZ    NOT NULL DEFAULT now()
);
