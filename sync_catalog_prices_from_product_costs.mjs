import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const admin = require("C:/Users/Admin/Dashboard/Dashboard/node_modules/firebase-admin");

const positionalArgs = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const catalogPath = positionalArgs[0] || "productos.json";
const serviceAccountPath =
  positionalArgs[1] ||
  "C:/Users/Admin/Dashboard/Dashboard/cuenta_servicio/ventasdashboard-e48b2-firebase-adminsdk-fbsvc-9dd379717f.json";
const productCostsCollection = positionalArgs[2] || "product_costs";
const marginPct = Number(positionalArgs[3] ?? 30);
const reportOnly = process.argv.includes("--report");

const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, "utf8"));

if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}

const db = admin.firestore();

function money(n) {
  return "$" + Number(n || 0).toLocaleString("es-CO", { maximumFractionDigits: 0 });
}

function normalizeSkuKey(sku) {
  return String(sku || "").trim().toLowerCase().replace(/[\/\\]/g, "-");
}

function costRow(data) {
  const sku = String(data?.sku || "").trim();
  const cost = Number(data?.cost ?? 0);
  const initialQty = Number(data?.initialQty ?? 0);
  const availableQty = Number(data?.availableQty ?? 0);
  const qty = initialQty > 0 ? initialQty : availableQty;
  if (!sku || !Number.isFinite(cost) || cost <= 0 || !Number.isFinite(qty) || qty <= 0) return null;
  return { sku, cost, qty };
}

const snap = await db.collection(productCostsCollection).get();
const agg = new Map();
snap.docs.forEach((doc) => {
  const row = costRow(doc.data());
  if (!row) return;
  const key = normalizeSkuKey(row.sku);
  const current = agg.get(key) || { label: row.sku, sumQty: 0, sumValue: 0 };
  current.sumQty += row.qty;
  current.sumValue += row.qty * row.cost;
  agg.set(key, current);
});

const bySku = new Map();
agg.forEach((value, key) => {
  const costoLlegada = Math.round(value.sumValue / value.sumQty);
  const precioBase = Math.round(costoLlegada * (1 + marginPct / 100));
  bySku.set(key, { sku: value.label, costoLlegada, precioBase });
});

let updated = 0;
const missing = [];
const rows = [];

for (const product of catalog) {
  const key = normalizeSkuKey(product.sku);
  const match = bySku.get(key);
  if (!match) {
    missing.push(product.sku);
    rows.push({ sku: product.sku, costoLlegada: "", precioSugerido: "" });
    if (!reportOnly) {
      product.costoLlegada = 0;
      product.margenSugeridoPct = marginPct;
      product.precioBase = 0;
      product.precio = "";
      product.escalasUnidades = Array.isArray(product.escalasUnidades) ? product.escalasUnidades : [];
    }
    continue;
  }

  rows.push({
    sku: product.sku,
    costoLlegada: money(match.costoLlegada),
    precioSugerido: money(match.precioBase),
  });

  if (!reportOnly) {
    product.costoLlegada = match.costoLlegada;
    product.margenSugeridoPct = marginPct;
    product.precioBase = match.precioBase;
    product.precio = money(match.precioBase);
    product.escalasUnidades = Array.isArray(product.escalasUnidades) ? product.escalasUnidades : [];
  }
  updated++;
}

console.table(rows);
console.log(`${reportOnly ? "Encontrados" : "Actualizados"} ${updated}/${catalog.length}. Sin costo en ${productCostsCollection}: ${missing.length}`);
if (missing.length) console.log(`Sin costo: ${missing.join(", ")}`);

if (!reportOnly) {
  fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2) + "\n", "utf8");
}
