import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const admin = require("C:/Users/Admin/Dashboard/Dashboard/node_modules/firebase-admin");

const positionalArgs = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const catalogPath = positionalArgs[0] || "productos.json";
const serviceAccountPath =
  positionalArgs[1] ||
  "C:/Users/Admin/Dashboard/Dashboard/cuenta_servicio/ventasdashboard-e48b2-firebase-adminsdk-fbsvc-9dd379717f.json";
const collectionName = positionalArgs[2] || "catalogo_productos";

const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, "utf8"));

if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}

const db = admin.firestore();
const productsToWrite = catalog.filter((p) => String(p.sku || "").trim());

function docId(sku) {
  return String(sku).trim().replace(/\//g, "_");
}

if (process.argv.includes("--verify")) {
  const snap = await db.collection(collectionName).get();
  let priced = 0;
  const missing = [];
  for (const doc of snap.docs) {
    const data = doc.data();
    if (Number(data.precioBase) > 0) priced++;
  }
  for (const product of catalog) {
    if (!Number(product.precioBase)) missing.push(product.sku);
  }
  console.log(`Firestore ${collectionName}: ${priced}/${snap.size} documentos con precioBase > 0.`);
  console.log(`Sin precio en catálogo local: ${missing.join(", ") || "ninguno"}.`);
  process.exit(0);
}

let updated = 0;
let skipped = 0;
let batch = db.batch();
let batchSize = 0;

for (const product of productsToWrite) {
  const sku = String(product.sku).trim();
  const ref = db.collection(collectionName).doc(docId(sku));
  const precioBase = Math.max(0, Math.round(Number(product.precioBase) || 0));
  batch.set(ref, {
    sku,
    precioBase,
    precio: precioBase > 0 ? product.precio || "" : "",
    costoLlegada: Math.round(Number(product.costoLlegada) || 0),
    margenSugeridoPct: Number(product.margenSugeridoPct) || 30,
    imagenesCatalogo: [],
  }, { merge: true });
  updated++;
  batchSize++;

  if (batchSize === 400) {
    await batch.commit();
    batch = db.batch();
    batchSize = 0;
  }
}

if (batchSize) await batch.commit();

skipped = catalog.length - productsToWrite.length;
console.log(`Firestore ${collectionName}: productos actualizados ${updated}. Sin SKU local: ${skipped}.`);
