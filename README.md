# Pedidos Mozzarella Express

Portal para ver el inventario de todas las sucursales de Wansoft en una sola pantalla, registrar ajustes y dar seguimiento a órdenes de compra.

## Qué hace

- **Inventario consolidado**: tabla producto × sucursal con totales, valor a costo, ajustes pendientes y producto en camino. Se actualiza desde Wansoft (`GetInventory_Xml`) de forma automática y con un botón.
- **Ajustes de inventario**: conteos físicos, mermas, caducidades, etc. Calcula la diferencia contra Wansoft. Como la API de Wansoft **no permite escribir ajustes**, cada ajuste queda *pendiente* hasta que alguien lo captura en Wansoft y lo marca como *capturado*. El sistema avisa cuando Wansoft ya coincide con el conteo.
- **Órdenes de compra rastreables**: folio (`OC-00001`), estado (borrador → enviada → recibida parcial → recibida), historial de quién hizo qué, impresión, recepción manual y **confirmación contra Wansoft**: busca las entradas de compra (`GetInputInventory_Xml`, tipos 1 *Factura* y 13 *Orden de compra a proveedor*) desde que se envió la orden y las propone para aplicar, sin contar dos veces la misma entrada.
- **Usuarios y permisos**: Administrador, Compras y Sucursal (solo ve sus sucursales).
- **Diagnóstico de Wansoft**: consulta en vivo para ver qué columnas devuelve Wansoft y ajustar cuál es el código, la existencia, etc.
- **Bitácora** de todas las acciones.

## Cómo se instala (Railway + Supabase)

1. **Supabase**: crea un proyecto nuevo. En *Connect → Direct → Session pooler* copia la cadena (IPv4, puerto 5432). La *Direct connection* es solo IPv6 y no funciona desde Railway.
2. **GitHub**: sube este proyecto a un repositorio nuevo.
3. **Railway**: *New Project → Deploy from GitHub repo* → elige el repositorio.
4. En Railway → *Variables*, agrega las de `.env.example` (`SUPABASE_URL`, `JWT_SECRET`, `ENCRYPTION_KEY`, `ADMIN_PASSWORD`, `SYNC_MINUTES`).
5. En Railway → *Settings → Networking* genera el dominio público. Esa es la dirección del portal (el mismo servidor sirve las pantallas y la API; no se necesita GitHub Pages).
6. Entra con `admin` y la contraseña de `ADMIN_PASSWORD`. Cámbiala desde el menú.
7. Ve a **Sucursales y Wansoft**, captura el *subsidiaryId* y *pwdWebService* de cada sucursal y usa *Guardar y probar conexión*.

Las tablas se crean solas al arrancar. Las 26 sucursales vienen precargadas; los nombres se pueden editar.

## Pruebas locales

```bash
npm install
npm run mock            # Wansoft simulado en :4100 (claves: id 1001… / contraseña demo1001…)
DATABASE_URL=postgres://… JWT_SECRET=… ENCRYPTION_KEY=… \
WANSOFT_URL=http://localhost:4100/API/IntegrationService.asmx npm start
```

## Notas técnicas

- `src/wansoft.js`: cliente SOAP. Wansoft devuelve un texto con XML/JSON dentro y la documentación no detalla las columnas, así que el lector es genérico y detecta columnas por nombre; se corrigen en *Diagnóstico*.
- Las contraseñas de Wansoft se guardan cifradas (AES-256-GCM) con `ENCRYPTION_KEY`.
- Wansoft solo da información "a día vencido" para consultas por fecha; el inventario actual (`GetInventory_Xml`) sí es del momento.
