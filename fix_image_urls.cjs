// Corrige las URLs de imagenes rotas del catalogo (2026-07-21).
//
// La app vieja de Nexus (product-master--nexus.replit.app) ya no existe: sus
// /objects/uploads/<id> devuelven 404 y por eso 66 productos salen "Sin
// imagen". Las mismas imagenes viven ahora en el bucket R2 publico del Nexus
// nuevo (pub-...r2.dev/uploads/<id>) — verificado con HEAD 200 para 40 de las
// 41 URLs unicas antes de escribir este script.
//
// Reescribe `imagen` e `imagenesCatalogo` en catalogo_productos y guarda las
// URLs originales en image_urls_backup.json por si hay que revertir.
//
// Uso:  node fix_image_urls.cjs
const fs = require("fs");
const admin = require("C:/Users/Admin/Dashboard/Dashboard/node_modules/firebase-admin");
const sa = JSON.parse(fs.readFileSync(
  "C:/Users/Admin/Dashboard/Dashboard/cuenta_servicio/ventasdashboard-e48b2-firebase-adminsdk-fbsvc-9dd379717f.json", "utf8"));
admin.initializeApp({ credential: admin.credential.cert(sa) });

// Dos patrones viejos, mismo bucket R2 destino:
//   /objects/uploads/<id>            -> r2.dev/uploads/<id>
//   /objects/.private/<ruta>         -> r2.dev/<ruta>
// (25 URLs unicas del segundo patron verificadas HEAD 200 el 2026-07-21.)
const OLD_UPLOADS = /^https:\/\/product-master--nexus\.replit\.app\/objects\/uploads\//;
const OLD_PRIVATE = /^https:\/\/product-master--nexus\.replit\.app\/objects\/\.private\//;
const R2 = "https://pub-74be3f08e8ab44c490fe4d652d79a419.r2.dev/";
// Unica imagen que tampoco existe en R2 (404 en ambos hosts): se deja igual.
const MISSING = "ac3f2a8c-c597-40b3-be66-e34e56e111dc";

const map = (u) => {
  const s = String(u || "").trim();
  if (s.includes(MISSING)) return s;
  if (OLD_UPLOADS.test(s)) return s.replace(OLD_UPLOADS, R2 + "uploads/");
  if (OLD_PRIVATE.test(s)) return s.replace(OLD_PRIVATE, R2);
  return s;
};

(async () => {
  const db = admin.firestore();
  const snap = await db.collection("catalogo_productos").get();
  let updated = 0;
  const missingSkus = [];
  const backup = [];
  for (const d of snap.docs) {
    const x = d.data() || {};
    const newImagen = map(x.imagen);
    const oldGallery = Array.isArray(x.imagenesCatalogo) ? x.imagenesCatalogo : null;
    const newGallery = oldGallery ? oldGallery.map(map) : null;
    if (String(x.imagen || "").includes(MISSING)) missingSkus.push(x.sku || d.id);

    const changed = newImagen !== String(x.imagen || "").trim() ||
      (oldGallery && JSON.stringify(newGallery) !== JSON.stringify(oldGallery));
    if (!changed) continue;

    backup.push({ id: d.id, imagen: x.imagen, imagenesCatalogo: oldGallery });
    const patch = { imagen: newImagen };
    if (oldGallery) patch.imagenesCatalogo = newGallery;
    await d.ref.update(patch);
    updated++;
  }
  // Acumula sobre el respaldo de corridas anteriores (no lo pisa).
  const backupPath = __dirname + "/image_urls_backup.json";
  let prev = [];
  try { prev = JSON.parse(fs.readFileSync(backupPath, "utf8")); } catch {}
  fs.writeFileSync(backupPath, JSON.stringify(prev.concat(backup), null, 1));
  console.log("docs actualizados:", updated);
  console.log("SKU con imagen perdida (404 en ambos hosts):", missingSkus.join(", ") || "ninguno");
  console.log("backup de URLs viejas: image_urls_backup.json");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
