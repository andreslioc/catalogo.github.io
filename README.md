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
