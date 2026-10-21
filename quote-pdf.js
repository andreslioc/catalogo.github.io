// PDF de cotización / orden de pedido (jsPDF UMD cargado por la página).
// Lo usan el carrito (cotización libre y pedido recién creado) y el historial
// de "Mis pedidos", así un pedido viejo se descarga igual que el día que se hizo.
import { money } from "./pricing.js";

// Miniatura JPEG (dataURL) de la portada para incrustar en el PDF, o null si
// no se pudo leer. Requiere que el host de la imagen envíe CORS (bucket R2).
// cache:"no-store" evita reutilizar la copia sin CORS que dejó el <img> del catálogo.
async function pdfThumb(url, px = 120) {
  if (!url) return null;
  try {
    const res = await fetch(url, { mode: "cors", cache: "no-store" });
    if (!res.ok) return null;
    const bmp = await createImageBitmap(await res.blob());
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = px;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, px, px);
    const s = Math.min(px / bmp.width, px / bmp.height);
    const w = bmp.width * s, h = bmp.height * s;
    ctx.drawImage(bmp, (px - w) / 2, (px - h) / 2, w, h);
    return canvas.toDataURL("image/jpeg", 0.8);
  } catch {
    return null;
  }
}

const QUOTE_NOTE =
  "Producto sujeto a disponibilidad de unidades. Precio del transporte corre por cuenta del comprador. Cotizacion referencial, no es factura.";
const ORDER_NOTE =
  "Pedido sujeto a confirmacion de disponibilidad y pago. Precio del transporte corre por cuenta del comprador. Este documento no es una factura.";

/**
 * Genera y descarga el PDF.
 * data = {
 *   numero?: "CAT-000123"  (si viene, es una orden de pedido; si no, cotización)
 *   fecha?: Date,
 *   cliente?: { nombre, tipoDocumento, documento, telefono },
 *   envio?: { direccion, ciudad:{nombre}, departamento:{nombre}, indicaciones },
 *   lineas: [{ sku, nombre, imagen, cantidad, precioUnit, subtotal }],
 *   totales: { subtotal, descuentoPct, descuento, total },
 * }
 * Devuelve false si jsPDF no está disponible.
 */
export async function downloadQuotePdf(data) {
  const { jsPDF } = window.jspdf || {};
  if (!jsPDF) return false;

  const lineas = data.lineas || [];
  const totales = data.totales || {};
  const isOrder = !!data.numero;
  const thumbs = await Promise.all(lineas.map((l) => pdfThumb(l.imagen)));

  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const M = 40;
  let y = M;

  // Encabezado
  doc.setFillColor(14, 116, 144);
  doc.rect(0, 0, W, 70, "F");
  doc.setTextColor(255).setFont("helvetica", "bold").setFontSize(20);
  doc.text(isOrder ? "Orden de pedido" : "Cotización", M, 44);
  doc.setFont("helvetica", "normal").setFontSize(10).setTextColor(220, 243, 249);
  const fecha = data.fecha instanceof Date ? data.fecha : new Date();
  const hoy = fecha.toLocaleDateString("es-CO", { year: "numeric", month: "long", day: "numeric" });
  if (isOrder) {
    doc.setFont("helvetica", "bold").setFontSize(12).setTextColor(255);
    doc.text(data.numero, W - M, 36, { align: "right" });
    doc.setFont("helvetica", "normal").setFontSize(10).setTextColor(220, 243, 249);
    doc.text(hoy, W - M, 52, { align: "right" });
  } else {
    doc.text(hoy, W - M, 44, { align: "right" });
  }
  y = 95;

  // Cliente y envío
  const c = data.cliente || {};
  doc.setTextColor(31, 41, 55).setFontSize(11);
  if (c.nombre) { doc.setFont("helvetica", "bold").text(`Cliente: ${c.nombre}`, M, y); y += 15; }
  const ident = [
    c.documento ? `${c.tipoDocumento || "Doc."} ${c.documento}` : "",
    c.telefono ? `Tel. ${c.telefono}` : "",
  ].filter(Boolean).join("   ·   ");
  if (ident) { doc.setFont("helvetica", "normal").setFontSize(10).text(ident, M, y); y += 15; }
  const e = data.envio;
  if (e?.direccion) {
    const place = [e.ciudad?.nombre, e.departamento?.nombre]
      .filter((v, i, arr) => v && arr.indexOf(v) === i).join(", ");
    const lines = doc.splitTextToSize(`Enviar a: ${e.direccion}${place ? ` — ${place}` : ""}`, W - M * 2);
    doc.setFont("helvetica", "normal").setFontSize(10).text(lines, M, y);
    y += lines.length * 13;
    if (e.indicaciones) {
      doc.setFontSize(9).setTextColor(107, 114, 128).text(e.indicaciones, M, y, { maxWidth: W - M * 2 });
      doc.setTextColor(31, 41, 55);
      y += 13;
    }
  }
  if (c.nombre || ident || e?.direccion) y += 10;

  // Cabecera tabla
  const colX = { prod: M, cant: 320, unit: 390, tot: W - M };
  doc.setFont("helvetica", "bold").setFontSize(10).setTextColor(107, 114, 128);
  doc.text("Producto", colX.prod, y);
  doc.text("Cant.", colX.cant, y, { align: "right" });
  doc.text("P. unit.", colX.unit, y, { align: "right" });
  doc.text("Subtotal", colX.tot, y, { align: "right" });
  y += 6;
  doc.setDrawColor(229, 231, 235).line(M, y, W - M, y);
  y += 16;

  // Filas
  const THUMB = 36;
  const textX = colX.prod + THUMB + 10;
  lineas.forEach((l, i) => {
    doc.setFont("helvetica", "normal").setFontSize(10).setTextColor(31, 41, 55);
    const name = doc.splitTextToSize(l.nombre || l.sku, colX.cant - textX - 16);
    const rowH = Math.max(THUMB, name.length * 12 + 12);
    if (y + rowH > H - 80) { doc.addPage(); y = M + 10; }

    const top = y - 10;
    if (thumbs[i]) {
      doc.addImage(thumbs[i], "JPEG", colX.prod, top, THUMB, THUMB);
    } else {
      doc.setDrawColor(229, 231, 235).rect(colX.prod, top, THUMB, THUMB);
    }

    doc.text(name, textX, y);
    doc.text(String(l.cantidad), colX.cant, y, { align: "right" });
    doc.text(money(l.precioUnit), colX.unit, y, { align: "right" });
    doc.text(money(l.subtotal), colX.tot, y, { align: "right" });
    doc.setFontSize(8).setTextColor(107, 114, 128);
    doc.text(`SKU: ${l.sku}`, textX, y + name.length * 12);
    y += rowH + 10;
  });

  // Totales
  if (y + 110 > H) { doc.addPage(); y = M + 10; }
  y += 4;
  doc.setDrawColor(229, 231, 235).line(M, y, W - M, y);
  y += 22;
  doc.setFont("helvetica", "bold").setFontSize(13).setTextColor(31, 41, 55);
  doc.text("Subtotal", colX.unit, y, { align: "right" });
  doc.text(money(totales.subtotal), colX.tot, y, { align: "right" });
  if (totales.descuento > 0) {
    y += 18;
    doc.setFont("helvetica", "bold").setFontSize(11).setTextColor(22, 101, 52);
    doc.text(`Descuento mayorista ${totales.descuentoPct}%`, colX.unit, y, { align: "right" });
    doc.text("-" + money(totales.descuento), colX.tot, y, { align: "right" });
  }
  y += 22;
  doc.setFont("helvetica", "bold").setFontSize(13).setTextColor(31, 41, 55);
  doc.text(isOrder ? "Total" : "Total estimado", colX.unit, y, { align: "right" });
  doc.setTextColor(14, 116, 144);
  doc.text(money(totales.total), colX.tot, y, { align: "right" });

  // Nota
  y += 26;
  doc.setFont("helvetica", "italic").setFontSize(8).setTextColor(107, 114, 128);
  doc.text(isOrder ? ORDER_NOTE : QUOTE_NOTE, M, y, { maxWidth: W - M * 2 });

  const stamp = fecha.toISOString().slice(0, 10);
  doc.save(isOrder ? `pedido-${data.numero}.pdf` : `cotizacion-${stamp}.pdf`);
  return true;
}
