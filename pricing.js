// Logica de precios compartida por el catalogo publico, el cotizador y el admin.

export const DEFAULT_MARGIN_PCT = 30;

export const DEFAULT_WHOLESALE_RULES = [
  { desdeMonto: 1000000, minUnidadesPorReferencia: 2, descuentoPct: 10, activo: true },
  { desdeMonto: 2000000, minUnidadesPorReferencia: 2, descuentoPct: 15, activo: true },
];

/**
 * Precio unitario de un producto segun la cantidad pedida.
 * Recorre las escalas por unidad y aplica la mayor que cumpla `cantidad >= desde`.
 */
export function precioUnitario(producto, cantidad, descuentoPct = 0) {
  const base = Number(producto?.precioBase) || 0;
  const escalas = Array.isArray(producto?.escalasUnidades) ? producto.escalasUnidades : [];
  let precio = base;
  escalas
    .filter((e) => Number.isFinite(Number(e?.desde)) && Number.isFinite(Number(e?.precio)))
    .slice()
    .sort((a, b) => Number(a.desde) - Number(b.desde))
    .forEach((e) => {
      if (cantidad >= Number(e.desde)) precio = Number(e.precio);
    });

  const discount = Math.min(100, Math.max(0, Number(descuentoPct) || 0));
  return Math.round(precio * (1 - discount / 100));
}

export function precioSugeridoDesdeCosto(costoLlegada, margenPct = DEFAULT_MARGIN_PCT) {
  const costo = Number(costoLlegada) || 0;
  const margen = Number.isFinite(Number(margenPct)) ? Number(margenPct) : DEFAULT_MARGIN_PCT;
  if (costo <= 0) return 0;
  return Math.round(costo * (1 + margen / 100));
}

/** El producto tiene algun precio configurado. */
export function tienePrecio(producto) {
  return (Number(producto?.precioBase) || 0) > 0;
}

export function normalizeWholesaleRules(rules) {
  const source = Array.isArray(rules) && rules.length ? rules : DEFAULT_WHOLESALE_RULES;
  return source
    .map((rule) => ({
      desdeMonto: Number(rule?.desdeMonto) || 0,
      minUnidadesPorReferencia: Math.max(1, Number(rule?.minUnidadesPorReferencia) || 1),
      descuentoPct: Math.min(100, Math.max(0, Number(rule?.descuentoPct) || 0)),
      activo: rule?.activo !== false,
    }))
    .filter((rule) => rule.activo && rule.desdeMonto > 0 && rule.descuentoPct > 0)
    .sort((a, b) => Number(a.desdeMonto) - Number(b.desdeMonto));
}

export function descuentoMayorista(subtotal, lines, rules) {
  const normalized = normalizeWholesaleRules(rules);
  let selected = null;
  normalized.forEach((rule) => {
    const meetsAmount = Number(subtotal) >= rule.desdeMonto;
    const meetsUnits = lines.every((line) => Number(line.qty) >= rule.minUnidadesPorReferencia);
    if (meetsAmount && meetsUnits) selected = rule;
  });
  return selected || null;
}

export function quoteTotals(lines, rules) {
  const subtotal = lines.reduce((sum, line) => sum + Number(line.total || 0), 0);
  const rule = descuentoMayorista(subtotal, lines, rules);
  const discountPct = rule ? rule.descuentoPct : 0;
  const discount = Math.round(subtotal * (discountPct / 100));
  return {
    subtotal,
    rule,
    discountPct,
    discount,
    total: Math.max(0, subtotal - discount),
  };
}

/** Texto resumido de las escalas, p. ej. "$41.000 (10+)". */
export function resumenEscalas(producto) {
  const escalas = Array.isArray(producto?.escalasUnidades) ? producto.escalasUnidades : [];
  return escalas
    .filter((e) => Number.isFinite(Number(e?.desde)) && Number.isFinite(Number(e?.precio)))
    .slice()
    .sort((a, b) => Number(a.desde) - Number(b.desde))
    .map((e) => `${money(Number(e.precio))} (${Number(e.desde)}+)`)
    .join(" · ");
}

/** Formatea un numero a pesos colombianos: 45000 -> "$45.000". */
export function money(n) {
  const v = Number(n) || 0;
  return "$" + v.toLocaleString("es-CO", { maximumFractionDigits: 0 });
}
