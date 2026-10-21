// Copia CommonJS de la lógica de precios de ../pricing.js (el catálogo es ES
// module y no se despliega con las Functions). Si cambias una, cambia la otra:
// el pedido se cobra con lo que calcula esta.

const DEFAULT_WHOLESALE_RULES = [
  { desdeMonto: 1000000, minUnidadesPorReferencia: 2, descuentoPct: 10, activo: true },
  { desdeMonto: 2000000, minUnidadesPorReferencia: 2, descuentoPct: 15, activo: true },
];

function precioUnitario(producto, cantidad) {
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
  return Math.round(precio);
}

function normalizeWholesaleRules(rules) {
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

function descuentoMayorista(subtotal, lines, rules) {
  let selected = null;
  normalizeWholesaleRules(rules).forEach((rule) => {
    const meetsAmount = Number(subtotal) >= rule.desdeMonto;
    const meetsUnits = lines.every((line) => Number(line.qty) >= rule.minUnidadesPorReferencia);
    if (meetsAmount && meetsUnits) selected = rule;
  });
  return selected;
}

function quoteTotals(lines, rules) {
  const subtotal = lines.reduce((sum, line) => sum + Number(line.total || 0), 0);
  const rule = descuentoMayorista(subtotal, lines, rules);
  const discountPct = rule ? rule.descuentoPct : 0;
  const discount = Math.round(subtotal * (discountPct / 100));
  return { subtotal, discountPct, discount, total: Math.max(0, subtotal - discount) };
}

module.exports = { precioUnitario, quoteTotals };
