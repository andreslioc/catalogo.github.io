# Catalogo

## Crear producto desde SKU de Neon

El admin ahora tiene una opcion **Crear desde SKU**. El flujo es:

1. El admin escribe un SKU.
2. `admin.js` llama a la Firebase Function `importCatalogProductFromSku`.
3. La Function valida el token de Firebase Auth y exige el claim `admin: true`.
4. La Function consulta Neon y devuelve el producto normalizado.
5. El producto queda editable en el admin y solo se publica al hacer **Guardar cambios**.

Firestore sigue siendo la base publicada del catalogo (`catalogo_productos`). Neon solo se usa como fuente de importacion.

## Configurar Neon

La Function busca por defecto en la vista:

```sql
public.catalogo_productos_source
```

La vista debe exponer una columna `sku`. En este proyecto la fuente real es
`public."Product"` y los costos vienen de `public."ProductCost"`, por eso la
vista compatible es:

```sql
create or replace view public.catalogo_productos_source as
with cost_rows as (
  select
    lower(trim(sku)) as sku_key,
    coalesce(nullif("initialQty", 0), "availableQty", 0)::numeric as qty,
    cost::numeric as cost
  from public."ProductCost"
  where sku is not null
    and trim(sku) <> ''
    and cost > 0
    and coalesce(nullif("initialQty", 0), "availableQty", 0) > 0
), cost_avg as (
  select
    sku_key,
    round(sum(qty * cost) / nullif(sum(qty), 0))::numeric as weighted_cost
  from cost_rows
  group by sku_key
), normalized as (
  select
    p.sku,
    p.name as nombre,
    p.brand as marca,
    p.category as categoria,
    p."imageUrl" as imagen,
    coalesce(ca.weighted_cost, nullif(round(p."lastCost"), 0), 0)::numeric as "costoLlegada"
  from public."Product" p
  left join cost_avg ca on ca.sku_key = lower(trim(p.sku))
  where p.sku is not null
    and trim(p.sku) <> ''
)
select
  sku,
  nombre,
  marca,
  categoria,
  ''::text as presentacion,
  ''::text as descripcion,
  imagen,
  "costoLlegada",
  30::numeric as "margenSugeridoPct",
  case
    when "costoLlegada" > 0 then round("costoLlegada" * 1.3)::numeric
    else 0::numeric
  end as "precioBase"
from normalized;
```

Campos reconocidos por alias: `sku`, `nombre`, `marca`, `categoria`, `presentacion`, `descripcion`, `imagen`, `beneficios`, `ingredientes`, `dosis`, `modoUso`, `advertencias`, `costoLlegada`, `precioBase`, `margenSugeridoPct`, `imagenesCatalogo`, `escalasUnidades`.

## Disponibilidad de inventario (stock en vivo)

El catálogo consulta las unidades disponibles para no vender lo que ya se vendió
por MercadoLibre. El flujo es:

1. `app.js` llama a la Firebase Function pública `getCatalogStock` con el lote
   de SKUs visibles (POST `{ skus: [...] }`).
2. La Function lee **Firestore `inventory_items`** y devuelve **solo** las
   unidades por SKU (`{ stock: { "SalCar-301": 25, ... } }`).
3. El frontend muestra badges ("Disponibles", "Últimas N", "Agotado"), topa la
   cantidad al stock, bloquea agregar productos agotados y marca en la
   cotización las líneas que exceden lo disponible.
4. Al abrir un producto se re-consulta su SKU para refrescar el número.
5. El panel de admin muestra un badge de disponibilidad por producto
   ("Disp: N", "Últimas N", "Agotado") usando el mismo endpoint.

### Fuente del dato: Firestore, NO Neon

`inventory_items` es el maestro de inventario vivo: el dashboard lo actualiza en
tiempo real y su canal `ML_SALE` descuenta cada venta de MercadoLibre al
momento.

> **No usar Neon para stock.** Neon tiene un espejo de estas tablas
> (`InventoryItem`, `ProductCost`, `ProductCostLayer`), pero **dejó de
> sincronizarse el 2026-06-23** y sobreestima el stock ~80 %. Además
> `ProductCost` / `ProductCostLayer` **no son inventario**: son capas de
> *costeo* (COGS) y su `availableQty` dejó de consumirse al migrar a promedio
> ponderado. Neon sigue siendo válido solo para importar productos.

### Fórmula de disponibilidad

```txt
disponible = onHandLocalQty + onHandFullQty + onHandMarketQty
           − reservedQty − defectiveQty
```

- **Excluye** `inboundLocalQty` / `inboundFullQty`: mercancía **en tránsito**,
  que no está disponible para vender.
- **Pisa en 0** los negativos. Hay ~21 SKUs con deriva de inventario real
  (marcados por el dashboard con `negativeStockFlag`); se muestran "Agotado".
- Cuidado: `onHandQty` **no** es un total — es un alias de `onHandLocalQty`.
  Usarlo dejaría fuera lo que está en FULL.
- Un SKU sin registro en `inventory_items` se **omite** de la respuesta, y el
  frontend lo trata como *desconocido* (sin badge, sin bloquear la venta), no
  como agotado.

La Function cachea un snapshot de la colección ~60 s. Eso mantiene las lecturas
de Firestore planas ante ráfagas de visitantes y permite resolver los SKUs sin
distinguir mayúsculas (catálogo e inventario difieren en el caso de algún SKU,
p. ej. `Salpip-412` vs `SalPip-412`).

Los costos (`avgCostCop`, `totalValueCop`) viven en esa misma colección, por eso
el catálogo **no** la lee directo: la Function actúa de filtro y solo expone
unidades.

Desplegar la función:

```powershell
firebase deploy --only functions:getCatalogStock
```

Si Firebase entrega una URL distinta a la configurada, actualiza
`CATALOG_STOCK_ENDPOINT` en `firebase-config.js`.

## Espejo de inventario Firestore → Neon

El catálogo NO necesita esto (lee Firestore directo). Existe porque el mirror
del dashboard (`neonMirrorSync`, en el repo Dashboard) tiene rota su rama de
inventario desde el 2026-06-23: reporta `inventoryItemsMirrored: N` pero no
escribe ninguna fila, y `inventoryMovementsMirrored` es `0` siempre. Mientras
eso se arregla allá, estas functions mantienen Neon al día:

- `mirrorInventoryToNeon` — programada cada 5 min.
- `mirrorInventoryToNeonRun` — disparo manual, **admin-only**
  (`?full=1` reprocesa todo).

```powershell
firebase deploy --only functions:mirrorInventoryToNeon,functions:mirrorInventoryToNeonRun
```

### Detalle que importa

> **`updatedAt` y `createdAt` de `inventory_items` / `inventory_movements` son
> STRINGS ISO-8601, no `Timestamp` de Firestore** (verificado: 580/580 y
> 15.036/15.036). Un filtro contra `Timestamp.fromDate(...)` no coincide bien,
> porque Firestore ordena por tipo antes que por valor. Aquí se comparan como
> strings, que para ISO en UTC ordenan igual que cronológicamente. Es la causa
> más probable del bug del mirror del dashboard.

Otras decisiones:

- **Watermark leído de Neon** (`max(updatedAt)` / `max(createdAt)`), sin estado
  propio que se desincronice: la primera corrida arrastra sola todo el atraso.
  Se reprocesa una ventana de 5 min previa por si hay timestamps empatados.
- **Idempotente**: `InventoryItem` va por `on conflict (id) do update`;
  `InventoryMovement` por `on conflict (id) do nothing` (libro inmutable). Puede
  convivir con el mirror del dashboard si algún día lo reparan.
- **Solo se escriben las columnas que Firestore provee.** Las demás (`category`,
  `master*`, overrides de lead/safety, `flags`) se dejan intactas para no
  pisarlas con `null`.
- `effectiveAt` no existe en Firestore; se deriva de `occurredAt` y, si falta,
  de `createdAt`.

Cuando el mirror del dashboard quede arreglado, **retirar estas dos functions**
para no tener dos sistemas replicando lo mismo.

## Configurar Firebase Functions

Instalar dependencias:

```powershell
cd functions
npm.cmd install
```

Configurar el secreto de Neon:

```powershell
firebase functions:secrets:set NEON_DATABASE_URL
```

Opcionalmente crea `functions/.env` para ajustar la vista y origenes permitidos:

```env
NEON_PRODUCT_SOURCE=public.catalogo_productos_source
ALLOWED_ORIGINS=https://catalogo.github.io,http://localhost:8080
```

Desplegar:

```powershell
firebase deploy --only functions:importCatalogProductFromSku
```

Si Firebase entrega una URL distinta a la configurada, actualiza `NEON_IMPORT_ENDPOINT` en `firebase-config.js`.

## Completar campos con IA

El admin incluye un flujo de borrador con IA para prerrellenar campos faltantes
del producto (`presentacion`, `descripcion`, `beneficios`, `ingredientes`,
`dosis`, `modoUso`, `advertencias`). La Function usa Gemini con salida JSON
estructurada. La informacion queda marcada como pendiente y el admin no permite
guardar el catalogo hasta aprobar o descartar el borrador IA.

La Function usa el secreto `GEMINI_API_KEY`, compartido con las demas funciones
de IA del dashboard. Para desplegarla:

```powershell
firebase deploy --only functions:generateCatalogProductDraft
```

Opcionalmente se puede fijar un modelo distinto al predeterminado
`gemini-3.1-flash-lite` usando `GEMINI_MODEL` en el entorno de Functions.
Si ese modelo responde 404 (descontinuado) o satura cuota/demanda (429/503),
la Function prueba en orden otros modelos free-tier:
`gemini-3.5-flash` y `gemini-flash-latest`.

## Subcatalogos por cliente

El catalogo maestro sigue viviendo en:

```txt
catalogo_productos/{sku}
```

Cada cliente tiene su propio subcatalogo en:

```txt
catalogo_clientes/{slug}
catalogo_clientes/{slug}/precios/{sku}
```

El documento del cliente guarda datos de acceso/publicacion:

```js
{
  nombre: "Distribuidor Norte",
  slug: "distribuidor-norte",
  email: "cliente@correo.com",
  uid: "firebase-auth-uid",
  whatsapp: "opcional",
  activo: true
}
```

Cada precio personalizado guarda:

```js
{
  sku: "SalCar-301",
  precioBase: 89900,
  visible: true
}
```

El link publico de un cliente es:

```txt
index.html?cliente=distribuidor-norte
```

Ese link usa los productos, fotos y textos del catalogo maestro, pero aplica los precios y visibilidad del cliente.

## Portal de cliente

Los clientes entran por:

```txt
cliente.html
```

Desde alli pueden:

- Editar precio publico por producto.
- Ocultar/mostrar productos.
- Aplicar un margen global sobre el precio maestro.
- Copiar su link publico.

El acceso de cliente es separado del administrador. Los usuarios cliente deben tener custom claims:

```js
{
  catalogClient: true,
  clientId: "distribuidor-norte"
}
```

## Gestion de clientes desde admin

El admin ahora incluye **Clientes y subcatalogos**. Al guardar un cliente llama a la Function:

```txt
upsertCatalogClientUser
```

Esa Function:

- Valida que quien llama tenga `admin: true`.
- Crea o actualiza el usuario en Firebase Auth.
- Asigna `catalogClient: true` y `clientId`.
- Crea/actualiza `catalogo_clientes/{slug}`.

Desplegar Functions:

```powershell
cd functions
npm.cmd install
cd ..
firebase deploy --only functions
```

Desplegar reglas Firestore:

```powershell
firebase deploy --only firestore:rules
```

Las reglas incluidas permiten:

- Lectura publica de `catalogo_productos`.
- Lectura publica de clientes activos y sus precios.
- Escritura de precios solo por admin o por el cliente dueño.
- Gestion de clientes solo por admin.
