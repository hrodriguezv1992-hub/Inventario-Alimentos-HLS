-- Pedidos Mozzarella Express — esquema de base de datos
-- Se ejecuta en cada arranque; todo es idempotente.

CREATE TABLE IF NOT EXISTS usuarios (
  id            SERIAL PRIMARY KEY,
  nombre        TEXT NOT NULL,
  usuario       TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  rol           TEXT NOT NULL DEFAULT 'sucursal' CHECK (rol IN ('admin','compras','sucursal')),
  sucursales    INTEGER[] NOT NULL DEFAULT '{}',   -- solo aplica al rol 'sucursal'
  activo        BOOLEAN NOT NULL DEFAULT TRUE,
  creado_en     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sucursales (
  id               SERIAL PRIMARY KEY,
  nombre           TEXT NOT NULL UNIQUE,
  wansoft_id       INTEGER,
  wansoft_pwd_enc  TEXT,
  activa           BOOLEAN NOT NULL DEFAULT TRUE,
  ultimo_sync      TIMESTAMPTZ,
  ultimo_error     TEXT
);

-- Foto del inventario de Wansoft por sucursal (se reemplaza en cada sincronización)
CREATE TABLE IF NOT EXISTS inventario (
  sucursal_id    INTEGER NOT NULL REFERENCES sucursales(id) ON DELETE CASCADE,
  codigo         TEXT NOT NULL,
  nombre         TEXT,
  unidad         TEXT,
  departamento   TEXT,
  existencia     NUMERIC NOT NULL DEFAULT 0,
  costo          NUMERIC,
  sincronizado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (sucursal_id, codigo)
);
CREATE INDEX IF NOT EXISTS idx_inventario_codigo ON inventario(codigo);

CREATE TABLE IF NOT EXISTS ajustes (
  id               SERIAL PRIMARY KEY,
  folio            TEXT UNIQUE,
  sucursal_id      INTEGER NOT NULL REFERENCES sucursales(id),
  codigo           TEXT NOT NULL,
  nombre           TEXT,
  unidad           TEXT,
  existencia_sistema NUMERIC NOT NULL,
  existencia_fisica  NUMERIC NOT NULL,
  diferencia       NUMERIC NOT NULL,
  costo            NUMERIC,
  motivo           TEXT NOT NULL,
  comentario       TEXT,
  estado           TEXT NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente','capturado','cancelado')),
  creado_por       INTEGER REFERENCES usuarios(id),
  creado_en        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resuelto_por     INTEGER REFERENCES usuarios(id),
  resuelto_en      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_ajustes_suc ON ajustes(sucursal_id, estado);

CREATE TABLE IF NOT EXISTS proveedores (
  id        SERIAL PRIMARY KEY,
  nombre    TEXT NOT NULL UNIQUE,
  contacto  TEXT,
  telefono  TEXT,
  email     TEXT,
  activo    BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS ordenes_compra (
  id              SERIAL PRIMARY KEY,
  folio           TEXT UNIQUE,
  sucursal_id     INTEGER NOT NULL REFERENCES sucursales(id),
  proveedor_id    INTEGER REFERENCES proveedores(id),
  estado          TEXT NOT NULL DEFAULT 'borrador'
                  CHECK (estado IN ('borrador','enviada','recibida_parcial','recibida','cancelada')),
  fecha_entrega   DATE,
  notas           TEXT,
  creado_por      INTEGER REFERENCES usuarios(id),
  creado_en       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  enviada_en      TIMESTAMPTZ,
  cerrada_en      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_oc_estado ON ordenes_compra(estado, sucursal_id);

CREATE TABLE IF NOT EXISTS oc_lineas (
  id                SERIAL PRIMARY KEY,
  oc_id             INTEGER NOT NULL REFERENCES ordenes_compra(id) ON DELETE CASCADE,
  codigo            TEXT NOT NULL,
  nombre            TEXT,
  unidad            TEXT,
  cantidad          NUMERIC NOT NULL CHECK (cantidad > 0),
  costo_unitario    NUMERIC NOT NULL DEFAULT 0,
  cantidad_recibida NUMERIC NOT NULL DEFAULT 0
);

-- Cada recepción (manual o detectada en Wansoft) queda registrada
CREATE TABLE IF NOT EXISTS recepciones (
  id          SERIAL PRIMARY KEY,
  oc_id       INTEGER NOT NULL REFERENCES ordenes_compra(id) ON DELETE CASCADE,
  linea_id    INTEGER NOT NULL REFERENCES oc_lineas(id) ON DELETE CASCADE,
  cantidad    NUMERIC NOT NULL,
  fuente      TEXT NOT NULL CHECK (fuente IN ('manual','wansoft')),
  referencia  TEXT,          -- id de la entrada en Wansoft, evita contarla dos veces
  usuario_id  INTEGER REFERENCES usuarios(id),
  creado_en   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_recepcion_ref ON recepciones(linea_id, referencia) WHERE referencia IS NOT NULL;

-- Historial de cada orden: quién hizo qué y cuándo
CREATE TABLE IF NOT EXISTS oc_eventos (
  id         SERIAL PRIMARY KEY,
  oc_id      INTEGER NOT NULL REFERENCES ordenes_compra(id) ON DELETE CASCADE,
  tipo       TEXT NOT NULL,
  detalle    TEXT,
  usuario_id INTEGER REFERENCES usuarios(id),
  creado_en  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bitacora (
  id         SERIAL PRIMARY KEY,
  usuario_id INTEGER REFERENCES usuarios(id),
  accion     TEXT NOT NULL,
  detalle    JSONB,
  creado_en  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ajustes_config (
  clave  TEXT PRIMARY KEY,
  valor  JSONB
);

CREATE SEQUENCE IF NOT EXISTS seq_folio_oc START 1;
CREATE SEQUENCE IF NOT EXISTS seq_folio_aj START 1;
