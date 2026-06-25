/**
 * Exporta un subconjunto de SKUs de la colección `products` (Firestore) a un
 * JSON listo para el catálogo web (carpeta catálogo/ del repo).
 *
 * Trae lo que SÍ existe en el dashboard (nombre, imagen, categoría, marca) y
 * deja vacíos los campos de marketing (descripción, beneficios, dosis) para que
 * se rellenen a mano en el JSON del catálogo.
 *
 * Uso (desde la raíz del repo):
 *   npx tsx --env-file=.env catálogo/export_catalogo_externo.ts
 *
 * Salida (ambas en catálogo/):
 *   - productos-base.json           (siempre)
 *   - productos.json                (si --write-catalogo)
 *
 * Usa el SDK cliente de Firebase con la config pública del .env
 * (VITE_FIREBASE_*). No requiere ADC; sí requiere que las reglas de Firestore
 * permitan leer la colección `products`.
 *
 * NOTA: este script solo regenera la SEMILLA (productos.json). Para subir esos
 * datos a Firestore (donde el catálogo realmente lee) corre después:
 *   npx tsx catálogo/seed_catalogo_firestore.ts
 */
import { initializeApp } from "firebase/app";
import { getFirestore, collection, getDocs, query, limit } from "firebase/firestore";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- SKUs solicitados (en el orden dado) ---
// Los duplicados se eliminan automáticamente por SKU normalizado (ver main()).
const SKUS_RAW: string[] = [
  // Bloque 1: Salud / Alimentos
  "SalCar-301", "Salpip-412", "Salpip-410", "Salnow-442", "Salnow-405",
  "SalWho-001", "SalVit-208", "SalSpr-389", "SalSpr-199", "SalPip-323",
  "SalPip-268", "SalNow-329", "SalNow-123", "SalNew-302", "SalNeo-321",
  "SalNat-441", "SalNat-436", "SalNat-207", "SalNOW-333", "SalLac-001",
  "SalEqu-385", "SalKir-84", "SalKir-367", "SalKir-366", "SalNOW-319",
  "SalKir-125", "SalHor-405", "SalHor-396", "SalHor-337", "Salhor-403",
  "SalHor-332", "SalHor-298", "SalHor-330", "SalHor-328", "SalHor-300",
  "SalHor-294", "SalHor-200", "SalDoc-398", "SalDoc-397", "SalDea-195",
  "SalCom-188", "SalCen-371", "SalCen-370", "SalCen-369", "SalCar-365",
  "SalCar-363", "SalCar-362", "SalKir-282", "SalCar-335", "SalCar-361",
  "SalCar-360", "SalKir-283", "SalCar-334", "SalCar-327", "SalCar-301",
  "SalCar-299", "SalBen-265", "BelPip-297", "SalNat-439", "Belnat-408",
  "Salpip-411", "SalHor-404", "AliCel-281", "Salpip-416", "SalPip-345",
  "SalPip-316", "AliCel-280",
  // Bloque 2: Bebés / Belleza
  "Bebdes-407", "BelOrd-58", "BelOrd-55", "BelOrd-217", "BelOrd-210",
  "BelOrd-194", "BelJus-001", "Beba+D-406", "BebEuc-388", "BebDrb-001",
  "BebAqu-163", "BelFix-001", "BelVic-457", "BelVic-459", "BelVic-461",
  "BelVic-458", "BelVic-462", "BelDif-001",
  // Bloque 3: Mascotas / Animales
  "AniMil-002", "AniMil-001", "AniPip-316", "AniVit-001", "AniCos-141",
];

// Deduplica por SKU normalizado conservando el primer orden de aparición.
const SKUS: string[] = (() => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of SKUS_RAW) {
    const n = String(s).toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!seen.has(n)) { seen.add(n); out.push(s); }
  }
  return out;
})();

// Mismo normalizador agresivo que usa el dashboard (services/firebaseService.ts):
const normalizeSku = (str: unknown) =>
  String(str || "").toLowerCase().replace(/[^a-z0-9]/g, "");

const WRITE_CATALOGO = process.argv.includes("--write-catalogo");
// El catálogo vive en la misma carpeta que este script.
const CATALOGO_DIR = __dirname;

interface CatalogoItem {
  sku: string;
  nombre: string;
  imagen: string;
  categoria: string;
  marca: string;
  // Campos editables desde admin.html (no existen en el dashboard):
  descripcion: string;
  beneficios: string[];
  dosis: string;
  presentacion: string;
  ingredientes: string[];
  modoUso: string;
  advertencias: string;
  precio: string;
}

/** Campos editables a mano; vacíos al extraer del dashboard. */
const EMPTY_EDITABLE = {
  descripcion: "",
  beneficios: [] as string[],
  dosis: "",
  presentacion: "",
  ingredientes: [] as string[],
  modoUso: "",
  advertencias: "",
  precio: "",
};

function initDb() {
  const projectId = process.env.VITE_FIREBASE_PROJECT_ID || process.env.GCLOUD_PROJECT;
  const apiKey = process.env.VITE_FIREBASE_API_KEY;
  if (!projectId || !apiKey) {
    console.error("✖ Faltan VITE_FIREBASE_PROJECT_ID / VITE_FIREBASE_API_KEY en .env");
    process.exit(1);
  }
  const app = initializeApp({
    apiKey,
    authDomain: process.env.VITE_FIREBASE_AUTH_DOMAIN,
    projectId,
    storageBucket: process.env.VITE_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.VITE_FIREBASE_MESSAGIN_SENDER_ID,
    appId: process.env.VITE_FIREBASE_APP_ID,
  });
  return getFirestore(app);
}

async function main() {
  const db = initDb();

  console.log(`→ Leyendo colección "products"…`);
  const snap = await getDocs(query(collection(db, "products"), limit(10000)));

  // Indexa por SKU normalizado.
  const byNorm = new Map<string, Record<string, unknown> & { _id: string }>();
  snap.forEach((doc) => {
    const d = doc.data();
    const norm = normalizeSku((d as { sku?: unknown }).sku ?? doc.id);
    if (norm) byNorm.set(norm, { ...d, _id: doc.id });
  });
  console.log(`  ${snap.size} productos en la colección.`);

  // MERGE: preserva los campos editables (descripción, beneficios, etc.) ya
  // cargados en el productos.json existente, para no borrar tu trabajo al
  // regenerar. Se indexa por SKU normalizado.
  const existingByNorm = new Map<string, Partial<CatalogoItem>>();
  const existingPath = resolve(CATALOGO_DIR, "productos.json");
  if (existsSync(existingPath)) {
    try {
      const prev = JSON.parse(readFileSync(existingPath, "utf8")) as CatalogoItem[];
      prev.forEach((p) => existingByNorm.set(normalizeSku(p.sku), p));
      console.log(`  (merge) ${prev.length} productos previos en productos.json`);
    } catch {
      console.warn(`  ⚠ No se pudo leer el productos.json previo; se ignora.`);
    }
  }

  const keepEditable = (sku: string): typeof EMPTY_EDITABLE => {
    const prev = existingByNorm.get(normalizeSku(sku));
    if (!prev) return { ...EMPTY_EDITABLE };
    return {
      descripcion: prev.descripcion ?? "",
      beneficios: prev.beneficios ?? [],
      dosis: prev.dosis ?? "",
      presentacion: prev.presentacion ?? "",
      ingredientes: prev.ingredientes ?? [],
      modoUso: prev.modoUso ?? "",
      advertencias: prev.advertencias ?? "",
      precio: prev.precio ?? "",
    };
  };

  const items: CatalogoItem[] = [];
  const missing: string[] = [];
  const noImage: string[] = [];

  for (const sku of SKUS) {
    const match = byNorm.get(normalizeSku(sku));
    if (!match) {
      missing.push(sku);
      // Igual lo incluimos como placeholder para que aparezca en el catálogo.
      items.push({ sku, nombre: "", imagen: "", categoria: "", marca: "", ...keepEditable(sku) });
      continue;
    }
    const imagen = String(match.imageUrl ?? "").trim();
    if (!imagen) noImage.push(sku);
    items.push({
      sku: String(match.sku ?? sku),
      nombre: String(match.name ?? "").trim() || sku,
      imagen,
      categoria: String(match.category ?? "").trim(),
      marca: String(match.brand ?? "").trim(),
      ...keepEditable(sku),
    });
  }

  const outBase = join(CATALOGO_DIR, "productos-base.json");
  writeFileSync(outBase, JSON.stringify(items, null, 2), "utf8");
  console.log(`\n✔ Escrito ${items.length} productos → ${outBase}`);

  if (WRITE_CATALOGO) {
    const outCat = join(CATALOGO_DIR, "productos.json");
    writeFileSync(outCat, JSON.stringify(items, null, 2), "utf8");
    console.log(`✔ Copiado también a → ${outCat}`);
  }

  console.log(`\n── Reporte ──`);
  console.log(`  Encontrados con datos: ${items.length - missing.length}/${SKUS.length}`);
  if (missing.length) {
    console.log(`  ⚠ No encontrados en "products" (${missing.length}): ${missing.join(", ")}`);
  }
  if (noImage.length) {
    console.log(`  ⚠ Sin imagen (${noImage.length}): ${noImage.join(", ")}`);
  }

  process.exit(0);
}

main().catch((e) => {
  console.error("✖ Error:", e);
  process.exit(1);
});
