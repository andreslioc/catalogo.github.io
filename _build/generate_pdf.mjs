/**
 * Genera catalogo.pdf a partir de ../productos.json.
 * Descarga las imágenes (URLs remotas) y arma un PDF A4 agrupado por categoría.
 *
 * Uso:  node generate_pdf.mjs
 */
import PDFDocument from "pdfkit";
import sharp from "sharp";
import { createWriteStream, readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = resolve(process.cwd(), "..", "productos.json");
const OUT = resolve(process.cwd(), "..", "catalogo.pdf");

const productos = JSON.parse(readFileSync(SRC, "utf8"));

// ---- Descargar imágenes (concurrencia limitada) ----
async function fetchImage(url) {
  try {
    if (!url) return null;
    const res = await fetch(url);
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") || "";
    if (!/jpeg|jpg|png|webp/i.test(ct)) return null;
    const raw = Buffer.from(await res.arrayBuffer());
    // Redimensiona a máx 300 px y comprime a JPEG para reducir el peso del PDF
    // (se muestran a 120 px; 300 px da nitidez de sobra incluso al imprimir).
    return await sharp(raw)
      .resize({ width: 300, height: 300, fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: 72 })
      .toBuffer();
  } catch {
    return null;
  }
}

async function downloadAll(items, conc = 8) {
  const map = new Map();
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      const p = items[idx];
      map.set(p.sku, await fetchImage(p.imagen));
      process.stdout.write(`\r  imágenes: ${map.size}/${items.length}`);
    }
  }
  await Promise.all(Array.from({ length: conc }, worker));
  process.stdout.write("\n");
  return map;
}

// ---- Layout ----
const COLORS = { brand: "#0e7490", ink: "#1f2937", soft: "#6b7280", line: "#e5e7eb" };
const M = 50;
const IMG = 120;
const GAP = 16;

function run(images) {
  const doc = new PDFDocument({ size: "A4", margins: { top: M, bottom: M, left: M, right: M } });
  doc.pipe(createWriteStream(OUT));

  const pageW = doc.page.width;
  const pageH = doc.page.height;
  const right = pageW - M;
  const bottom = pageH - M;
  const textX = M + IMG + GAP;
  const textW = right - textX;

  // ----- Portada -----
  doc.rect(0, 0, pageW, pageH).fill("#0e7490");
  doc.fill("#ffffff").font("Helvetica-Bold").fontSize(34).text("Catálogo de Productos", M, 300, { width: pageW - M * 2, align: "center" });
  doc.font("Helvetica").fontSize(13).fillColor("#d8f3f9")
    .text("Suplementos · Salud · Belleza · Bebés · Alimentos · Mascotas", M, 350, { width: pageW - M * 2, align: "center" });
  doc.fontSize(11).fillColor("#bfeaf2")
    .text(`${productos.length} productos`, M, 390, { width: pageW - M * 2, align: "center" });
  const hoy = new Date().toLocaleDateString("es-CO", { year: "numeric", month: "long", day: "numeric" });
  doc.fontSize(10).fillColor("#a9dde8").text(hoy, M, 760, { width: pageW - M * 2, align: "center" });

  // ----- Productos por categoría -----
  const cats = [...new Set(productos.map((p) => p.categoria || "Otros"))];
  let firstCat = true;

  for (const cat of cats) {
    const items = productos.filter((p) => (p.categoria || "Otros") === cat);

    doc.addPage();
    if (!firstCat) { /* nueva página ya creada */ }
    firstCat = false;

    // Encabezado de categoría
    doc.rect(M, doc.y, right - M, 30).fill(COLORS.brand);
    doc.fill("#ffffff").font("Helvetica-Bold").fontSize(14)
      .text(cat.toUpperCase(), M + 12, doc.y + 8, { width: right - M - 24 });
    doc.y += 30 + 16;
    doc.fillColor(COLORS.ink);

    for (const p of items) {
      renderProduct(doc, p, images.get(p.sku), { textX, textW, bottom, right });
    }
  }

  doc.end();
  return new Promise((res) => doc.on("end", res) || doc.once("finish", res));
}

function seg(doc, text, { font = "Helvetica", size = 9, color = COLORS.ink }, textW) {
  doc.font(font).fontSize(size).fillColor(color);
  return doc.heightOfString(text, { width: textW });
}

function renderProduct(doc, p, imgBuf, { textX, textW, bottom, right }) {
  // ---- medir altura del bloque de texto ----
  let h = 0;
  h += seg(doc, p.nombre || p.sku, { font: "Helvetica-Bold", size: 12 }, textW) + 2;
  const meta = [p.marca, p.presentacion, "SKU " + p.sku].filter(Boolean).join("  ·  ");
  h += seg(doc, meta, { size: 8, color: COLORS.soft }, textW) + 4;
  if (p.precio) h += seg(doc, p.precio, { font: "Helvetica-Bold", size: 11, color: COLORS.brand }, textW) + 4;
  if (p.descripcion) h += seg(doc, p.descripcion, { size: 9 }, textW) + 6;
  if (p.beneficios?.length) { h += seg(doc, "Beneficios", { font: "Helvetica-Bold", size: 8 }, textW) + 2; h += seg(doc, p.beneficios.map((b) => "•  " + b).join("\n"), { size: 9 }, textW) + 6; }
  if (p.ingredientes?.length) { h += seg(doc, "Ingredientes", { font: "Helvetica-Bold", size: 8 }, textW) + 2; h += seg(doc, p.ingredientes.join(", "), { size: 9 }, textW) + 6; }
  const uso = p.dosis || p.modoUso;
  if (uso) { h += seg(doc, p.dosis ? "Dosis sugerida" : "Modo de uso", { font: "Helvetica-Bold", size: 8 }, textW) + 2; h += seg(doc, uso, { size: 9 }, textW) + 6; }
  if (p.advertencias) h += seg(doc, "⚠ " + p.advertencias, { size: 7, color: COLORS.soft }, textW) + 4;

  const blockH = Math.max(h, IMG) + 18;
  if (doc.y + blockH > bottom) doc.addPage();

  const startY = doc.y;

  // Imagen (o placeholder)
  if (imgBuf) {
    try { doc.image(imgBuf, M, startY, { fit: [IMG, IMG], align: "center", valign: "center" }); }
    catch { drawPlaceholder(doc, startY); }
  } else {
    drawPlaceholder(doc, startY);
  }

  // Texto en columna derecha
  doc.y = startY;
  const line = (text, opts) => { doc.font(opts.font || "Helvetica").fontSize(opts.size || 9).fillColor(opts.color || COLORS.ink).text(text, textX, doc.y, { width: textW }); };

  line(p.nombre || p.sku, { font: "Helvetica-Bold", size: 12 });
  doc.moveDown(0.1);
  line(meta, { size: 8, color: COLORS.soft });
  if (p.precio) { doc.moveDown(0.2); line(p.precio, { font: "Helvetica-Bold", size: 11, color: COLORS.brand }); }
  if (p.descripcion) { doc.moveDown(0.3); line(p.descripcion, { size: 9 }); }
  if (p.beneficios?.length) { doc.moveDown(0.3); line("Beneficios", { font: "Helvetica-Bold", size: 8, color: COLORS.brand }); line(p.beneficios.map((b) => "•  " + b).join("\n"), { size: 9 }); }
  if (p.ingredientes?.length) { doc.moveDown(0.3); line("Ingredientes", { font: "Helvetica-Bold", size: 8, color: COLORS.brand }); line(p.ingredientes.join(", "), { size: 9 }); }
  if (uso) { doc.moveDown(0.3); line(p.dosis ? "Dosis sugerida" : "Modo de uso", { font: "Helvetica-Bold", size: 8, color: COLORS.brand }); line(uso, { size: 9 }); }
  if (p.advertencias) { doc.moveDown(0.3); line("⚠ " + p.advertencias, { size: 7, color: COLORS.soft }); }

  const blockBottom = Math.max(doc.y, startY + IMG) + 12;
  // separador
  doc.moveTo(M, blockBottom).lineTo(right, blockBottom).lineWidth(0.5).strokeColor(COLORS.line).stroke();
  doc.y = blockBottom + 12;
  doc.fillColor(COLORS.ink);
}

function drawPlaceholder(doc, y) {
  doc.rect(M, y, IMG, IMG).fillAndStroke("#f1f3f5", COLORS.line);
  doc.font("Helvetica").fontSize(8).fillColor(COLORS.soft).text("Sin imagen", M, y + IMG / 2 - 4, { width: IMG, align: "center" });
  doc.fillColor(COLORS.ink);
}

console.log(`→ Descargando ${productos.length} imágenes…`);
const images = await downloadAll(productos);
const ok = [...images.values()].filter(Boolean).length;
console.log(`  ${ok}/${productos.length} imágenes OK.`);
console.log(`→ Generando PDF…`);
await run(images);
console.log(`✔ PDF generado: ${OUT}`);
