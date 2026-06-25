/**
 * Sube el catálogo (productos.json) a Firestore -> colección
 * `catalogo_productos`. Doc id = SKU.
 *
 * Merge inteligente: si el documento ya existe, SOLO refresca los campos de
 * contenido (nombre, imagen, descripción, etc.) y CONSERVA los de precio
 * (precioBase, escalasUnidades) que editaste en el admin. Si es nuevo, los crea
 * con valores por defecto (precioBase tomado del antiguo `precio` si se puede).
 *
 * Uso (desde la raíz del repo):
 *   npx tsx catálogo/seed_catalogo_firestore.ts
 *   CATALOGO_JSON="C:/ruta/productos.json" npx tsx catálogo/seed_catalogo_firestore.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAdminFirestore } from '../scripts/lib/firebaseAdmin';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const COLLECTION = 'catalogo_productos';
// Por defecto, el productos.json que vive junto a este script (carpeta catálogo/).
const DEFAULT_JSON = path.join(__dirname, 'productos.json');

const CONTENT_FIELDS = [
  'nombre', 'imagen', 'categoria', 'marca',
  'presentacion', 'descripcion', 'beneficios', 'ingredientes',
  'dosis', 'modoUso', 'advertencias',
] as const;

type Producto = Record<string, unknown> & { sku?: string };

/** SKU -> id válido de documento (Firestore no admite '/'). */
function docId(sku: string): string {
  return sku.trim().replace(/\//g, '_');
}

/** Convierte un texto de precio ("$45.000", "45,000") a número, o 0. */
function parsePrecio(raw: unknown): number {
  if (typeof raw === 'number') return raw;
  if (typeof raw !== 'string') return 0;
  const digits = raw.replace(/[^\d]/g, '');
  return digits ? Number(digits) : 0;
}

async function main() {
  const jsonPath = path.resolve(process.env.CATALOGO_JSON?.trim() || DEFAULT_JSON);
  if (!fs.existsSync(jsonPath)) {
    throw new Error(`No se encontró productos.json en:\n  ${jsonPath}`);
  }

  const productos: Producto[] = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  console.log(`→ ${productos.length} productos leídos de ${jsonPath}`);

  const db = getAdminFirestore();
  const col = db.collection(COLLECTION);

  let creados = 0;
  let actualizados = 0;
  let saltados = 0;

  // Lote (máx 500 por batch; aquí son ~89, un solo batch basta).
  const batch = db.batch();

  for (let i = 0; i < productos.length; i++) {
    const p = productos[i];
    const sku = (p.sku ?? '').toString().trim();
    if (!sku) { saltados++; continue; }

    const ref = col.doc(docId(sku));
    const snap = await ref.get();

    // Campos de contenido siempre se refrescan desde el JSON.
    const payload: Record<string, unknown> = { sku, orden: i };
    for (const f of CONTENT_FIELDS) {
      if (p[f] !== undefined) payload[f] = p[f];
    }

    if (snap.exists) {
      // Conserva precioBase / escalasUnidades editados: NO los tocamos.
      batch.set(ref, payload, { merge: true });
      actualizados++;
    } else {
      // Nuevo: inicializa precios (precioBase desde el viejo `precio` si existe).
      payload.precioBase = parsePrecio(p.precio);
      payload.escalasUnidades = [];
      batch.set(ref, payload, { merge: true });
      creados++;
    }
  }

  await batch.commit();

  console.log(`✔ Catálogo sincronizado en Firestore/${COLLECTION}`);
  console.log(`   nuevos:        ${creados}`);
  console.log(`   actualizados:  ${actualizados} (precios conservados)`);
  if (saltados) console.log(`   saltados (sin SKU): ${saltados}`);
}

main().catch((err) => {
  console.error('✖ Error sembrando catálogo:', err);
  process.exit(1);
});
