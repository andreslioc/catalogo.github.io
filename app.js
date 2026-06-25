import { db, COLLECTION, collection, getDocs, query, orderBy } from "./firebase-config.js";
import { precioUnitario, tienePrecio, money } from "./pricing.js";

const CART_KEY = "catalogo_cart_v1";

const state = {
  all: [],
  filtered: [],
  category: "Todas",
  search: "",
  current: null,        // producto abierto en el modal
  cart: loadCart(),     // { [sku]: cantidad }
};

const els = {
  grid: document.getElementById("grid"),
  count: document.getElementById("count"),
  empty: document.getElementById("empty"),
  search: document.getElementById("search"),
  catFilters: document.getElementById("cat-filters"),
  footerCount: document.getElementById("footer-count"),
  modal: document.getElementById("modal"),
  // cotización
  fab: document.getElementById("cart-fab"),
  cartCount: document.getElementById("cart-count"),
  cart: document.getElementById("cart"),
  cartItems: document.getElementById("cart-items"),
  cartEmpty: document.getElementById("cart-empty"),
  cartTotal: document.getElementById("cart-total"),
};

init();

async function init() {
  try {
    const snap = await getDocs(query(collection(db, COLLECTION), orderBy("orden")));
    state.all = snap.docs.map((d) => d.data());
  } catch (err) {
    // Si falla el orderBy (docs sin `orden`), reintenta sin orden.
    try {
      const snap = await getDocs(collection(db, COLLECTION));
      state.all = snap.docs.map((d) => d.data());
    } catch (err2) {
      els.grid.innerHTML =
        '<p class="empty">No se pudo cargar el catálogo desde Firestore. ' +
        "Revisa tu conexión o las reglas de seguridad.</p>";
      console.error(err2 || err);
      return;
    }
  }

  buildCategoryChips();
  bindEvents();
  applyFilters();
  els.footerCount.textContent = state.all.length;
  renderCart();
}

/* ---------------- FILTROS / GRID ---------------- */
function buildCategoryChips() {
  const cats = ["Todas", ...new Set(state.all.map((p) => p.categoria).filter(Boolean))];
  els.catFilters.innerHTML = "";
  cats.forEach((cat) => {
    const chip = document.createElement("button");
    chip.className = "chip" + (cat === state.category ? " active" : "");
    chip.textContent = cat;
    chip.addEventListener("click", () => {
      state.category = cat;
      [...els.catFilters.children].forEach((c) => c.classList.remove("active"));
      chip.classList.add("active");
      applyFilters();
    });
    els.catFilters.appendChild(chip);
  });
}

function bindEvents() {
  els.search.addEventListener("input", (e) => {
    state.search = e.target.value.trim().toLowerCase();
    applyFilters();
  });

  els.modal.addEventListener("click", (e) => {
    if (e.target.hasAttribute("data-close")) closeModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { closeModal(); closeCart(); }
  });

  // Cotizador dentro del modal
  els.modal.querySelectorAll("[data-qty]").forEach((b) =>
    b.addEventListener("click", () => stepQty(Number(b.dataset.qty))));
  document.getElementById("m-qty").addEventListener("input", refreshModalLineTotal);
  document.getElementById("m-add").addEventListener("click", addCurrentToCart);

  // Panel de cotización
  els.fab.addEventListener("click", openCart);
  els.cart.addEventListener("click", (e) => {
    if (e.target.hasAttribute("data-cart-close")) closeCart();
  });
  document.getElementById("cart-clear").addEventListener("click", clearCart);
  document.getElementById("cart-pdf").addEventListener("click", downloadPDF);
}

function applyFilters() {
  let list = state.all;
  if (state.category !== "Todas") list = list.filter((p) => p.categoria === state.category);
  if (state.search) {
    const q = state.search;
    list = list.filter(
      (p) =>
        (p.nombre || "").toLowerCase().includes(q) ||
        (p.sku || "").toLowerCase().includes(q) ||
        (p.marca || "").toLowerCase().includes(q)
    );
  }
  state.filtered = list;
  render();
}

function render() {
  els.count.textContent =
    state.filtered.length + (state.filtered.length === 1 ? " producto" : " productos");
  els.empty.hidden = state.filtered.length > 0;

  els.grid.innerHTML = "";
  const frag = document.createDocumentFragment();
  state.filtered.forEach((p) => {
    const card = document.createElement("article");
    card.className = "card";
    const precioTxt = tienePrecio(p) ? `Desde ${money(precioUnitario(p, biggestQty(p)))}` : "";
    card.innerHTML = `
      <div class="card-media">
        ${
          p.imagen
            ? `<img src="${escapeAttr(p.imagen)}" alt="${escapeAttr(p.nombre)}" loading="lazy" onerror="this.parentNode.innerHTML='<span class=&quot;ph&quot;>Sin imagen</span>'" />`
            : '<span class="ph">Sin imagen</span>'
        }
      </div>
      <div class="card-body">
        ${p.marca ? `<span class="card-brand">${escapeHtml(p.marca)}</span>` : ""}
        <h3 class="card-name">${escapeHtml(p.nombre || p.sku)}</h3>
        <span class="card-sku">${escapeHtml(p.sku)}</span>
        ${precioTxt ? `<span class="card-precio">${escapeHtml(precioTxt)}</span>` : ""}
      </div>`;
    card.addEventListener("click", () => openModal(p));
    frag.appendChild(card);
  });
  els.grid.appendChild(frag);
}

/** Mayor umbral de escala (para mostrar "desde" el mejor precio en la card). */
function biggestQty(p) {
  const escalas = Array.isArray(p.escalasUnidades) ? p.escalasUnidades : [];
  return escalas.reduce((m, e) => Math.max(m, Number(e.desde) || 0), 1);
}

/* ---------------- MODAL + COTIZADOR ---------------- */
function openModal(p) {
  state.current = p;
  const img = document.getElementById("m-img");
  img.src = p.imagen || "";
  img.alt = p.nombre || "";
  setText("m-name", p.nombre || p.sku);
  setText("m-sku", "SKU: " + p.sku);
  setBadge("m-cat", p.categoria);
  setBadge("m-brand", p.marca);

  // Precio + escalas
  const precioEl = document.getElementById("m-precio");
  const cotizar = document.getElementById("m-cotizar");
  if (tienePrecio(p)) {
    cotizar.style.display = "";
    precioEl.textContent = `${money(p.precioBase)} c/u`;
    precioEl.style.display = "";
    renderEscalas(p);
    document.getElementById("m-qty").value = state.cart[p.sku] || 1;
    refreshModalLineTotal();
  } else {
    cotizar.style.display = "none";
  }

  toggleBlock("m-pres-wrap", "m-pres", p.presentacion, "text");
  toggleBlock("m-desc-wrap", "m-desc", p.descripcion, "text");
  toggleBlock("m-benef-wrap", "m-benef", p.beneficios, "list");
  toggleBlock("m-ingr-wrap", "m-ingr", p.ingredientes, "list");
  toggleBlock("m-dosis-wrap", "m-dosis", p.dosis, "text");
  toggleBlock("m-modo-wrap", "m-modo", p.modoUso, "text");
  toggleBlock("m-adv-wrap", "m-adv", p.advertencias, "text");

  els.modal.hidden = false;
  document.body.style.overflow = "hidden";
}

function renderEscalas(p) {
  const wrap = document.getElementById("m-escalas-wrap");
  const table = document.getElementById("m-escalas");
  const escalas = (Array.isArray(p.escalasUnidades) ? p.escalasUnidades : [])
    .filter((e) => Number(e.desde) && Number(e.precio))
    .sort((a, b) => Number(a.desde) - Number(b.desde));
  if (!escalas.length) { wrap.style.display = "none"; return; }
  wrap.style.display = "";
  const rows = [`<tr><td>1 +</td><td>${money(p.precioBase)}</td></tr>`]
    .concat(escalas.map((e) => `<tr><td>${Number(e.desde)} +</td><td>${money(Number(e.precio))}</td></tr>`));
  table.innerHTML = rows.join("");
}

function currentQty() {
  return Math.max(1, parseInt(document.getElementById("m-qty").value, 10) || 1);
}

function stepQty(delta) {
  const input = document.getElementById("m-qty");
  input.value = Math.max(1, (parseInt(input.value, 10) || 1) + delta);
  refreshModalLineTotal();
}

function refreshModalLineTotal() {
  const p = state.current;
  if (!p) return;
  const qty = currentQty();
  const unit = precioUnitario(p, qty);
  document.getElementById("m-line-total").textContent =
    `${qty} × ${money(unit)} = ${money(unit * qty)}`;
}

function addCurrentToCart() {
  const p = state.current;
  if (!p) return;
  state.cart[p.sku] = currentQty();
  saveCart();
  renderCart();
  closeModal();
  openCart();
}

function closeModal() {
  els.modal.hidden = true;
  document.body.style.overflow = "";
}

/* ---------------- CARRITO / COTIZACIÓN ---------------- */
function loadCart() {
  try { return JSON.parse(localStorage.getItem(CART_KEY)) || {}; }
  catch { return {}; }
}
function saveCart() {
  localStorage.setItem(CART_KEY, JSON.stringify(state.cart));
}

function cartLines() {
  return Object.entries(state.cart)
    .map(([sku, qty]) => {
      const p = state.all.find((x) => x.sku === sku);
      if (!p) return null;
      const unit = precioUnitario(p, qty);
      return { p, qty, unit, total: unit * qty };
    })
    .filter(Boolean);
}

function renderCart() {
  const lines = cartLines();
  const count = lines.reduce((n, l) => n + l.qty, 0);
  els.cartCount.textContent = count;
  els.fab.hidden = lines.length === 0;
  els.cartEmpty.style.display = lines.length ? "none" : "";

  els.cartItems.innerHTML = "";
  let total = 0;
  lines.forEach((l) => {
    total += l.total;
    const row = document.createElement("div");
    row.className = "cart-row";
    row.innerHTML = `
      <div class="cart-row-img">${
        l.p.imagen ? `<img src="${escapeAttr(l.p.imagen)}" alt="" />` : '<span class="ph">—</span>'
      }</div>
      <div class="cart-row-main">
        <p class="cart-row-name">${escapeHtml(l.p.nombre || l.p.sku)}</p>
        <p class="cart-row-unit">${money(l.unit)} c/u</p>
        <div class="qty-stepper sm">
          <button type="button" data-dec aria-label="Quitar">−</button>
          <input type="number" min="1" value="${l.qty}" data-qty-input />
          <button type="button" data-inc aria-label="Agregar">+</button>
          <button type="button" class="cart-del" data-del aria-label="Eliminar">🗑</button>
        </div>
      </div>
      <div class="cart-row-total">${money(l.total)}</div>`;

    const sku = l.p.sku;
    row.querySelector("[data-dec]").addEventListener("click", () => bumpQty(sku, -1));
    row.querySelector("[data-inc]").addEventListener("click", () => bumpQty(sku, 1));
    row.querySelector("[data-del]").addEventListener("click", () => removeFromCart(sku));
    row.querySelector("[data-qty-input]").addEventListener("change", (e) => {
      const v = Math.max(1, parseInt(e.target.value, 10) || 1);
      state.cart[sku] = v; saveCart(); renderCart();
    });
    els.cartItems.appendChild(row);
  });

  els.cartTotal.textContent = money(total);
}

function bumpQty(sku, delta) {
  state.cart[sku] = Math.max(1, (state.cart[sku] || 1) + delta);
  saveCart();
  renderCart();
}
function removeFromCart(sku) {
  delete state.cart[sku];
  saveCart();
  renderCart();
}
function clearCart() {
  if (!Object.keys(state.cart).length) return;
  if (!confirm("¿Vaciar la cotización?")) return;
  state.cart = {};
  saveCart();
  renderCart();
}

function openCart() { els.cart.hidden = false; document.body.style.overflow = "hidden"; }
function closeCart() { els.cart.hidden = true; document.body.style.overflow = ""; }

/* ---------------- PDF ---------------- */
function downloadPDF() {
  const lines = cartLines();
  if (!lines.length) { alert("Agrega productos antes de descargar la cotización."); return; }

  const { jsPDF } = window.jspdf || {};
  if (!jsPDF) { alert("No se pudo cargar el generador de PDF. Revisa tu conexión."); return; }

  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const W = doc.internal.pageSize.getWidth();
  const M = 40;
  let y = M;

  // Encabezado
  doc.setFillColor(14, 116, 144);
  doc.rect(0, 0, W, 70, "F");
  doc.setTextColor(255).setFont("helvetica", "bold").setFontSize(20);
  doc.text("Cotización", M, 44);
  doc.setFont("helvetica", "normal").setFontSize(10).setTextColor(220, 243, 249);
  const hoy = new Date().toLocaleDateString("es-CO", { year: "numeric", month: "long", day: "numeric" });
  doc.text(hoy, W - M, 44, { align: "right" });
  y = 95;

  // Cliente
  const nombre = (document.getElementById("cart-nombre").value || "").trim();
  doc.setTextColor(31, 41, 55).setFontSize(11);
  if (nombre) { doc.setFont("helvetica", "bold").text(`Cliente: ${nombre}`, M, y); y += 20; }

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
  doc.setFont("helvetica", "normal").setTextColor(31, 41, 55).setFontSize(10);
  let total = 0;
  lines.forEach((l) => {
    if (y > doc.internal.pageSize.getHeight() - 80) { doc.addPage(); y = M; }
    const name = doc.splitTextToSize(l.p.nombre || l.p.sku, colX.cant - colX.prod - 16);
    doc.text(name, colX.prod, y);
    doc.text(String(l.qty), colX.cant, y, { align: "right" });
    doc.text(money(l.unit), colX.unit, y, { align: "right" });
    doc.text(money(l.total), colX.tot, y, { align: "right" });
    total += l.total;
    y += Math.max(name.length * 12, 14) + 8;
  });

  // Total
  y += 4;
  doc.setDrawColor(229, 231, 235).line(M, y, W - M, y);
  y += 22;
  doc.setFont("helvetica", "bold").setFontSize(13);
  doc.text("Total estimado", colX.unit, y, { align: "right" });
  doc.setTextColor(14, 116, 144);
  doc.text(money(total), colX.tot, y, { align: "right" });

  // Nota
  y += 26;
  doc.setFont("helvetica", "italic").setFontSize(8).setTextColor(107, 114, 128);
  doc.text(
    "Cotización referencial. Los precios varían según la cantidad y están sujetos a cambios. No es factura.",
    M, y, { maxWidth: W - M * 2 }
  );

  const fecha = new Date().toISOString().slice(0, 10);
  doc.save(`cotizacion-${fecha}.pdf`);
}

/* ---------------- HELPERS ---------------- */
function toggleBlock(wrapId, contentId, value, kind) {
  const wrap = document.getElementById(wrapId);
  const has = kind === "list" ? Array.isArray(value) && value.length > 0 : !!(value && String(value).trim());
  wrap.style.display = has ? "" : "none";
  if (!has) return;
  const target = document.getElementById(contentId);
  if (kind === "list") target.innerHTML = value.map((b) => `<li>${escapeHtml(b)}</li>`).join("");
  else target.textContent = value;
}

function setText(id, txt) { document.getElementById(id).textContent = txt; }
function setBadge(id, txt) {
  const el = document.getElementById(id);
  el.textContent = txt || "";
  el.style.display = txt ? "" : "none";
}
function escapeHtml(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escapeAttr(s) { return escapeHtml(s).replace(/"/g, "&quot;"); }
