-- Pedidos Mozzarella Express — esquema de base de datos
-- Se ejecuta en cada arranque; todo es idempotente.

CREATE TABLE IF NOT EXISTS usuarios (
  id            SERIAL PRIMARY KEY,
  nombre        TEXT NOT NULL,
  usuario       TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  rol           TEXT NOT NULL DEFAULT 'sucursal',
  sucursales    INTEGER[] NOT NULL DEFAULT '{}',   -- aplica a sucursal, supervisor y empleado
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

-- Catálogo de productos de Wansoft (incluye productos sin existencia)
CREATE TABLE IF NOT EXISTS catalogo (
  codigo        TEXT PRIMARY KEY,
  nombre        TEXT,
  unidad        TEXT,
  departamento  TEXT,
  tipo          TEXT,
  costo_ideal   NUMERIC,
  actualizado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

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

-- ── Roles ────────────────────────────────────────────────────────
-- admin: todo · compras: órdenes y ajustes de todas · supervisor: revisa conteos de sus sucursales
-- sucursal: gerente de tienda · empleado: solo captura conteos (a ciegas)
ALTER TABLE usuarios DROP CONSTRAINT IF EXISTS usuarios_rol_check;
ALTER TABLE usuarios ADD CONSTRAINT usuarios_rol_check CHECK (rol IN ('admin','compras','supervisor','sucursal','empleado'));

-- ── Conteos físicos desde el teléfono ────────────────────────────
CREATE TABLE IF NOT EXISTS conteo_programas (
  id            SERIAL PRIMARY KEY,
  nombre        TEXT NOT NULL,
  departamentos TEXT[] NOT NULL DEFAULT '{}',   -- vacío = todos los productos
  dias          INTEGER[] NOT NULL DEFAULT '{}', -- 0=domingo … 6=sábado; vacío = todos los días
  sucursales    INTEGER[] NOT NULL DEFAULT '{}', -- vacío = todas
  activo        BOOLEAN NOT NULL DEFAULT TRUE,
  creado_en     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS conteos (
  id              SERIAL PRIMARY KEY,
  folio           TEXT UNIQUE,
  cliente_id      TEXT UNIQUE,            -- evita duplicados si el teléfono reintenta el envío
  sucursal_id     INTEGER NOT NULL REFERENCES sucursales(id),
  programa_id     INTEGER REFERENCES conteo_programas(id) ON DELETE SET NULL,
  nombre          TEXT,
  estado          TEXT NOT NULL DEFAULT 'enviado' CHECK (estado IN ('enviado','devuelto','aprobado','cancelado')),
  creado_por      INTEGER REFERENCES usuarios(id),
  contado_en      TIMESTAMPTZ,            -- cuándo empezó a contar (según el teléfono)
  enviado_en      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sistema_en      TIMESTAMPTZ,            -- de cuándo es la existencia de Wansoft comparada
  revisado_por    INTEGER REFERENCES usuarios(id),
  revisado_en     TIMESTAMPTZ,
  comentario      TEXT
);
CREATE INDEX IF NOT EXISTS idx_conteos_estado ON conteos(estado, sucursal_id);

CREATE TABLE IF NOT EXISTS conteo_lineas (
  id                 SERIAL PRIMARY KEY,
  conteo_id          INTEGER NOT NULL REFERENCES conteos(id) ON DELETE CASCADE,
  codigo             TEXT NOT NULL,
  nombre             TEXT,
  unidad             TEXT,
  departamento       TEXT,
  cantidad           NUMERIC NOT NULL CHECK (cantidad >= 0),
  existencia_sistema NUMERIC,
  costo              NUMERIC,
  recontar           BOOLEAN NOT NULL DEFAULT FALSE,
  UNIQUE (conteo_id, codigo)
);

CREATE TABLE IF NOT EXISTS conteo_eventos (
  id         SERIAL PRIMARY KEY,
  conteo_id  INTEGER NOT NULL REFERENCES conteos(id) ON DELETE CASCADE,
  tipo       TEXT NOT NULL,
  detalle    TEXT,
  usuario_id INTEGER REFERENCES usuarios(id),
  creado_en  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE ajustes ADD COLUMN IF NOT EXISTS conteo_id INTEGER REFERENCES conteos(id);
CREATE SEQUENCE IF NOT EXISTS seq_folio_ct START 1;

-- Supabase: bloquear el acceso por la Data API pública (roles anon/authenticated).
-- El portal se conecta directo como dueño de las tablas, así que esto no le afecta.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['usuarios','sucursales','inventario','catalogo','ajustes','proveedores','ordenes_compra',
                           'oc_lineas','recepciones','oc_eventos','bitacora','ajustes_config',
                           'conteo_programas','conteos','conteo_lineas','conteo_eventos'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
      EXECUTE format('REVOKE ALL ON TABLE %I FROM anon', t);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
      EXECUTE format('REVOKE ALL ON TABLE %I FROM authenticated', t);
    END IF;
  END LOOP;
END $$;
