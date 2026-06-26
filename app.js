import {
  db, auth, COLLECTION,
  collection, getDocs, getDoc, doc, query, orderBy,
  signInWithEmailAndPassword, getIdTokenResult, signOut, setPersistence, browserLocalPersistence,
} from "./firebase-config.js?v=20260625-4";
import { DEFAULT_WHOLESALE_RULES, precioUnitario, tienePrecio, money, normalizeWholesaleRules, quoteTotals } from "./pricing.js";

const CART_KEY = "catalogo_cart_v1";
const CONFIG_COLLECTION = "catalogo_config";
const PRICING_DOC = "pricing";

const state = {
  all: [],
  filtered: [],
  category: "Todas",
  search: "",
  current: null,        // producto abierto en el modal
  currentImages: [],
  currentImageIdx: 0,
  currentPrevImageIdx: null,
  currentTurnDirection: 1,
  currentTurnTimer: null,
  wholesaleRules: DEFAULT_WHOLESALE_RULES,
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
  cartSubtotal: document.getElementById("cart-subtotal"),
  cartDiscountRow: document.getElementById("cart-discount-row"),
  cartDiscountLabel: document.getElementById("cart-discount-label"),
  cartDiscount: document.getElementById("cart-discount"),
  cartTotal: document.getElementById("cart-total"),
  infoBook: document.getElementById("m-info-book"),
  adminMenu: document.getElementById("admin-menu"),
  adminLogin: document.getElementById("admin-login"),
  adminForm: document.getElementById("admin-login-form"),
  adminUser: document.getElementById("admin-user"),
  adminPass: document.getElementById("admin-pass"),
  adminError: document.getElementById("admin-login-error"),
  adminSubmit: document.getElementById("admin-login-submit"),
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

  await loadPricingConfig();
  buildCategoryChips();
  bindEvents();
  openAdminLoginFromQuery();
  applyFilters();
  els.footerCount.textContent = state.all.length;
  renderCart();
}

function openAdminLoginFromQuery() {
  const params = new URLSearchParams(window.location.search);
  if (params.get("admin") !== "1") return;
  openAdminLogin();
  const error = params.get("error");
  if (error === "not-admin") {
    els.adminError.textContent = "Este usuario no tiene permisos de administrador.";
    els.adminError.hidden = false;
  } else if (error === "timeout") {
    els.adminError.textContent = "No se pudo confirmar la sesión. Vuelve a ingresar.";
    els.adminError.hidden = false;
  }
  window.history.replaceState({}, "", window.location.pathname);
}

async function loadPricingConfig() {
  try {
    const snap = await getDoc(doc(db, CONFIG_COLLECTION, PRICING_DOC));
    const data = snap.exists() ? snap.data() : {};
    state.wholesaleRules = normalizeWholesaleRules(data.wholesaleRules);
  } catch (err) {
    console.warn("[pricing-config]", err);
    state.wholesaleRules = DEFAULT_WHOLESALE_RULES;
  }
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
    if (e.key === "Escape") { closeModal(); closeCart(); closeAdminLogin(); }
  });

  // Cotizador dentro del modal
  els.modal.querySelectorAll("[data-qty]").forEach((b) =>
    b.addEventListener("click", () => stepQty(Number(b.dataset.qty))));
  document.getElementById("m-qty").addEventListener("input", refreshModalLineTotal);
  document.getElementById("m-add").addEventListener("click", addCurrentToCart);
  document.getElementById("m-img-prev").addEventListener("click", () => stepCarousel(-1));
  document.getElementById("m-img-next").addEventListener("click", () => stepCarousel(1));

  // Panel de cotización
  els.fab.addEventListener("click", openCart);
  els.cart.addEventListener("click", (e) => {
    if (e.target.hasAttribute("data-cart-close")) closeCart();
  });
  document.getElementById("cart-clear").addEventListener("click", clearCart);
  document.getElementById("cart-pdf").addEventListener("click", downloadPDF);

  els.adminMenu.addEventListener("click", openAdminLogin);
  els.adminLogin.addEventListener("click", (e) => {
    if (e.target.hasAttribute("data-admin-close")) closeAdminLogin();
  });
  els.adminForm.addEventListener("submit", handleAdminLogin);
}

function openAdminLogin() {
  if (auth.currentUser) {
    enterAdminWithUser(auth.currentUser).catch(() => {
      signOut(auth).finally(() => {
        els.adminError.textContent = "No se pudo confirmar la sesión. Vuelve a ingresar.";
        els.adminError.hidden = false;
        els.adminLogin.hidden = false;
        document.body.style.overflow = "hidden";
      });
    });
    return;
  }
  els.adminError.hidden = true;
  els.adminError.textContent = "";
  els.adminPass.value = "";
  els.adminLogin.hidden = false;
  document.body.style.overflow = "hidden";
  setTimeout(() => els.adminUser.focus(), 0);
}

function closeAdminLogin() {
  if (els.adminLogin.hidden) return;
  els.adminLogin.hidden = true;
  document.body.style.overflow = "";
}

async function handleAdminLogin(e) {
  e.preventDefault();
  els.adminError.hidden = true;
  els.adminSubmit.disabled = true;
  try {
    await setPersistence(auth, browserLocalPersistence);
    const credential = await signInWithEmailAndPassword(auth, els.adminUser.value.trim(), els.adminPass.value);
    await enterAdminWithUser(credential.user);
  } catch (err) {
    const messages = {
      "auth/invalid-credential": "Usuario o contraseña incorrectos.",
      "auth/invalid-email": "Ingresa un usuario válido.",
      "auth/user-not-found": "No existe un administrador con ese usuario.",
      "auth/wrong-password": "Contraseña incorrecta.",
      "auth/too-many-requests": "Demasiados intentos. Espera un momento.",
      "auth/not-admin": "Este usuario no tiene permisos de administrador.",
    };
    els.adminError.textContent = messages[err?.code] || "No se pudo iniciar sesión.";
    els.adminError.hidden = false;
    els.adminPass.select();
  } finally {
    els.adminSubmit.disabled = false;
  }
}

function adminUrl() {
  return `admin.html?v=${Date.now()}`;
}

async function enterAdminWithUser(user) {
  const token = await getIdTokenResult(user, true);
  if (token.claims.admin !== true) {
    await signOut(auth);
    throw Object.assign(new Error("not-admin"), { code: "auth/not-admin" });
  }
  sessionStorage.setItem("catalogAdminEntry", JSON.stringify({
    at: Date.now(),
    email: user.email || els.adminUser.value.trim(),
  }));
  window.location.href = adminUrl();
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
    const precioTxt = tienePrecio(p) ? `${money(p.precioBase)} sugerido` : "";
    const img = productImages(p)[0];
    card.innerHTML = `
      <div class="card-media">
        ${
          img
            ? `<img src="${escapeAttr(img)}" alt="${escapeAttr(p.nombre)}" loading="lazy" onerror="this.parentNode.innerHTML='<span class=&quot;ph&quot;>Sin imagen</span>'" />`
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
  state.currentImages = productImages(p);
  state.currentImageIdx = 0;
  state.currentPrevImageIdx = null;
  if (state.currentTurnTimer) clearTimeout(state.currentTurnTimer);
  state.currentTurnTimer = null;
  renderCarousel();
  setText("m-name", p.nombre || p.sku);
  setText("m-sku", "SKU: " + p.sku);
  setBadge("m-cat", p.categoria);
  setBadge("m-brand", p.marca);

  // Precio + escalas
  const precioEl = document.getElementById("m-precio");
  const cotizar = document.getElementById("m-cotizar");
  if (tienePrecio(p)) {
    cotizar.style.display = "";
    precioEl.textContent = `${money(p.precioBase)} precio sugerido`;
    precioEl.style.display = "";
    renderEscalas(p);
    document.getElementById("m-qty").value = state.cart[p.sku] || 1;
    refreshModalLineTotal();
  } else {
    cotizar.style.display = "none";
    precioEl.textContent = "";
    precioEl.style.display = "none";
  }

  renderInfoBook();

  els.modal.hidden = false;
  document.body.style.overflow = "hidden";
}

function productImages(p) {
  const imgs = Array.isArray(p.imagenesCatalogo) ? p.imagenesCatalogo : [];
  return [...imgs, p.imagen].map((url) => String(url || "").trim()).filter(Boolean).slice(0, 3);
}

function modalPageCount() {
  return Math.max(state.currentImages.length || 1, productInfoPages(state.current).length || 1);
}

function renderCarousel() {
  const wrap = document.getElementById("m-carousel");
  const prev = document.getElementById("m-img-prev");
  const next = document.getElementById("m-img-next");
  const images = state.currentImages.length ? state.currentImages : [""];
  const total = modalPageCount();
  const idx = state.currentImageIdx % images.length;
  const turning = state.currentPrevImageIdx !== null;
  const directionClass = state.currentTurnDirection > 0 ? "turn-next" : "turn-prev";
  const prevIdx = state.currentPrevImageIdx === null ? idx : state.currentPrevImageIdx % images.length;
  const pages = turning
    ? [
        { url: images[idx], index: idx, cls: `active incoming ${directionClass}` },
        { url: images[prevIdx], index: prevIdx, cls: `active turning ${directionClass}` },
      ]
    : [{ url: images[idx], index: idx, cls: "active" }];

  wrap.innerHTML = pages.map(({ url, index, cls }) => `
    <figure class="book-page ${cls}" aria-label="Imagen ${index + 1} de ${images.length}">
      ${url ? `<img src="${escapeAttr(url)}" alt="${escapeAttr(state.current?.nombre || "")}" loading="lazy" />` : '<span class="ph">Sin imagen</span>'}
    </figure>
  `).join("");
  wrap.dataset.page = `${state.currentImageIdx + 1} / ${total}`;
  prev.style.display = total > 1 ? "" : "none";
  next.style.display = total > 1 ? "" : "none";
  renderInfoBook();
}

function stepCarousel(delta) {
  const total = modalPageCount();
  if (total <= 1) return;
  if (state.currentTurnTimer) clearTimeout(state.currentTurnTimer);
  state.currentPrevImageIdx = state.currentImageIdx;
  state.currentTurnDirection = delta >= 0 ? 1 : -1;
  state.currentImageIdx = (state.currentImageIdx + delta + total) % total;
  renderCarousel();
  state.currentTurnTimer = setTimeout(() => {
    state.currentPrevImageIdx = null;
    state.currentTurnTimer = null;
    renderCarousel();
  }, 720);
}

function productInfoPages(p) {
  if (!p) return [];
  const pages = [
    {
      eyebrow: "Resumen",
      blocks: [
        infoBlock("Presentación", p.presentacion, "text"),
        infoBlock("Descripción", p.descripcion, "text"),
      ],
    },
    {
      eyebrow: "Beneficios",
      blocks: [
        infoBlock("Beneficios clave", p.beneficios, "list"),
        infoBlock("Ingredientes", p.ingredientes, "list"),
      ],
    },
    {
      eyebrow: "Uso y compra",
      blocks: [
        infoBlock("Dosis", p.dosis, "text"),
        infoBlock("Modo de uso", p.modoUso, "text"),
        infoBlock("Advertencias", p.advertencias, "text"),
        infoBlock("Condiciones", [
          "Producto sujeto a disponibilidad de unidades.",
          "El precio del transporte corre por cuenta del comprador.",
        ], "list"),
      ],
    },
  ].map((page) => ({ ...page, blocks: page.blocks.filter(Boolean) }));

  const filled = pages.filter((page) => page.blocks.length > 0);
  return filled.length ? filled : [{
    eyebrow: "Producto",
    blocks: [infoBlock("Información", "Consulta disponibilidad y condiciones con el asesor.", "text")],
  }];
}

function infoBlock(title, value, kind) {
  const has = kind === "list"
    ? Array.isArray(value) && value.some((item) => String(item || "").trim())
    : !!String(value || "").trim();
  if (!has) return null;
  return { title, value, kind };
}

function renderInfoBook() {
  if (!els.infoBook || !state.current) return;
  const pages = productInfoPages(state.current);
  const total = modalPageCount();
  const idx = state.currentImageIdx % pages.length;
  const turning = state.currentPrevImageIdx !== null;
  const directionClass = state.currentTurnDirection > 0 ? "turn-next" : "turn-prev";
  const prevIdx = state.currentPrevImageIdx === null ? idx : state.currentPrevImageIdx % pages.length;
  const visiblePages = turning
    ? [
        { page: pages[idx], index: idx, cls: `active incoming ${directionClass}` },
        { page: pages[prevIdx], index: prevIdx, cls: `active turning ${directionClass}` },
      ]
    : [{ page: pages[idx], index: idx, cls: "active" }];

  els.infoBook.innerHTML = visiblePages.map(({ page, index, cls }) => `
    <section class="info-page ${cls}" aria-label="Detalle ${state.currentImageIdx + 1} de ${total}">
      <div class="info-page-inner">
        <p class="info-eyebrow">${escapeHtml(page.eyebrow)}</p>
        ${page.blocks.map(renderInfoBlock).join("")}
      </div>
      <p class="info-page-count">${state.currentImageIdx + 1} / ${total}</p>
    </section>
  `).join("");
}

function renderInfoBlock(block) {
  if (block.kind === "list") {
    const items = block.value
      .map((item) => String(item || "").trim())
      .filter(Boolean)
      .map((item) => `<li>${escapeHtml(item)}</li>`)
      .join("");
    return `<article class="info-block"><h3>${escapeHtml(block.title)}</h3><ul>${items}</ul></article>`;
  }
  return `<article class="info-block"><h3>${escapeHtml(block.title)}</h3><p>${escapeHtml(block.value)}</p></article>`;
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
  if (state.currentTurnTimer) clearTimeout(state.currentTurnTimer);
  state.currentTurnTimer = null;
  state.currentPrevImageIdx = null;
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
  const totals = quoteTotals(lines, state.wholesaleRules);
  els.cartCount.textContent = count;
  els.fab.hidden = lines.length === 0;
  els.cartEmpty.style.display = lines.length ? "none" : "";

  els.cartItems.innerHTML = "";
  lines.forEach((l) => {
    const row = document.createElement("div");
    const img = productImages(l.p)[0];
    row.className = "cart-row";
    row.innerHTML = `
      <div class="cart-row-img">${
        img ? `<img src="${escapeAttr(img)}" alt="" />` : '<span class="ph">-</span>'
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

  els.cartSubtotal.textContent = money(totals.subtotal);
  els.cartDiscountRow.style.display = totals.discount > 0 ? "" : "none";
  els.cartDiscountLabel.textContent = totals.rule
    ? `Descuento mayorista ${totals.discountPct}%`
    : "Descuento";
  els.cartDiscount.textContent = "-" + money(totals.discount);
  els.cartTotal.textContent = money(totals.total);
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
  const totals = quoteTotals(lines, state.wholesaleRules);

  // Total
  y += 4;
  doc.setDrawColor(229, 231, 235).line(M, y, W - M, y);
  y += 22;
  doc.setFont("helvetica", "bold").setFontSize(13);
  doc.text("Subtotal", colX.unit, y, { align: "right" });
  doc.text(money(total), colX.tot, y, { align: "right" });
  if (totals.discount > 0) {
    y += 18;
    doc.setFont("helvetica", "bold").setFontSize(11).setTextColor(22, 101, 52);
    doc.text(`Descuento mayorista ${totals.discountPct}%`, colX.unit, y, { align: "right" });
    doc.text("-" + money(totals.discount), colX.tot, y, { align: "right" });
  }
  y += 22;
  doc.setFont("helvetica", "bold").setFontSize(13).setTextColor(31, 41, 55);
  doc.text("Total estimado", colX.unit, y, { align: "right" });
  doc.setTextColor(14, 116, 144);
  doc.text(money(totals.total), colX.tot, y, { align: "right" });

  // Nota
  y += 26;
  doc.setFont("helvetica", "italic").setFontSize(8).setTextColor(107, 114, 128);
  doc.text(
    "Producto sujeto a disponibilidad de unidades. Precio del transporte corre por cuenta del comprador. Cotizacion referencial, no es factura.",
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
