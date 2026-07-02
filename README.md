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

La vista debe exponer una columna `sku`. Recomendado:

```sql
create or replace view public.catalogo_productos_source as
select
  sku,
  nombre,
  marca,
  categoria,
  presentacion,
  descripcion,
  imagen_url as imagen,
  costo_llegada as "costoLlegada",
  precio_venta as "precioBase"
from public.tu_tabla_de_productos
where sku is not null;
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
