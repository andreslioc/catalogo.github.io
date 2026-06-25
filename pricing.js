// Lógica de precios por volumen (escalas por unidades). Compartida por el
// catálogo público, el cotizador y el admin (vista previa).

/**
 * Precio unitario de un producto según la cantidad pedida.
 * Recorre las escalas ordenadas y aplica la mayor que cumpla `cantidad >= desde`.
 */
export function precioUnitario(producto, cantidad) {
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
  return precio;
}

/** ¿El producto tiene algún precio configurado? */
export function tienePrecio(producto) {
  return (Number(producto?.precioBase) || 0) > 0;
}

/** Texto resumido de las escalas, p. ej. "Desde $41.000 (10+) · $38.000 (50+)". */
export function resumenEscalas(producto) {
  const escalas = Array.isArray(producto?.escalasUnidades) ? producto.escalasUnidades : [];
  return escalas
    .filter((e) => Number.isFinite(Number(e?.desde)) && Number.isFinite(Number(e?.precio)))
    .slice()
    .sort((a, b) => Number(a.desde) - Number(b.desde))
    .map((e) => `${money(Number(e.precio))} (${Number(e.desde)}+)`)
    .join(" · ");
}

/** Formatea un número a pesos colombianos: 45000 -> "$45.000". */
export function money(n) {
  const v = Number(n) || 0;
  return "$" + v.toLocaleString("es-CO", { maximumFractionDigits: 0 });
}
