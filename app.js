import {
  db, auth, COLLECTION, CLIENTS_COLLECTION, CATALOG_STOCK_ENDPOINT,
  collection, getDocs, getDoc, doc, query, orderBy,
  signInWithEmailAndPassword, getIdTokenResult, signOut, setPersistence, browserLocalPersistence,
} from "./firebase-config.js?v=20260702-2";
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
  client: null,
  clientSlug: catalogSlugFromUrl(),
  catalogUnavailable: false,
  priceOverrides: new Map(),
  cart: {},             // { [sku]: cantidad }
  stock: {},            // { [sku]: unidades disponibles } (Neon, vía Cloud Function)
  currentStock: null,   // stock del producto abierto en el modal (null = desconocido)
};

// Umbral para avisar "últimas unidades" en badges.
const STOCK_LOW_THRESHOLD = 5;

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
  turnSheet: document.getElementById("m-turn-sheet"),
  adminMenu: document.getElementById("admin-menu"),
  adminLogin: document.getElementById("admin-login"),
  adminForm: document.getElementById("admin-login-form"),
  adminUser: document.getElementById("admin-user"),
  adminPass: document.getElementById("admin-pass"),
  adminError: document.getElementById("admin-login-error"),
  adminSubmit: document.getElementById("admin-login-submit"),
  headerTitle: document.querySelector(".site-header h1"),
  subtitle: document.querySelector(".subtitle"),
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

  await loadClientCatalog();
  state.all = applyClientCatalog(state.all);
  state.cart = loadCart();
  await loadPricingConfig();
  renderCatalogIdentity();
  buildCategoryChips();
  bindEvents();
  openAdminLoginFromQuery();
  applyFilters();
  els.footerCount.textContent = state.all.length;
  renderCart();
  loadStock(); // no bloquea el primer render; repinta cuando llega
}

/* ---------------- INVENTARIO (Neon) ---------------- */

// Consulta las existencias de todos los SKUs del catálogo y repinta.
// Si falla, el catálogo sigue funcionando sin datos de stock (degradación suave).
async function loadStock() {
  if (!CATALOG_STOCK_ENDPOINT) return;
  const skus = [...new Set(state.all.map((p) => String(p.sku || "").trim()).filter(Boolean))];
  if (!skus.length) return;
  try {
    state.stock = await fetchStock(skus);
    render();
  } catch (err) {
    console.warn("[stock]", err);
  }
}

async function fetchStock(skus) {
  const res = await fetch(new URL(CATALOG_STOCK_ENDPOINT, window.location.href).toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ skus }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data?.stock && typeof data.stock === "object" ? data.stock : {};
}

// Unidades disponibles de un SKU, o null si aún no se conocen.
function stockFor(sku) {
  const key = String(sku || "").trim();
  if (!key || !state.stock) return null;
  const v = state.stock[key];
  return typeof v === "number" ? v : null;
}

function renderStockBadge(units) {
  if (units == null) return "";
  if (units <= 0) return '<span class="stock-badge stock-out">Agotado</span>';
  if (units <= STOCK_LOW_THRESHOLD) {
    return `<span class="stock-badge stock-low">Últimas ${units} ${units === 1 ? "unidad" : "unidades"}</span>`;
  }
  return `<span class="stock-badge stock-ok">Disponibles: ${units}</span>`;
}

// Re-consulta un SKU puntual (momento decisivo: abrir el modal) para refrescar
// el número aunque algo se haya vendido en MercadoLibre desde la carga inicial.
async function refreshStockFor(sku) {
  const key = String(sku || "").trim();
  if (!key || !CATALOG_STOCK_ENDPOINT) return;
  try {
    const map = await fetchStock([key]);
    if (typeof map[key] === "number") {
      state.stock[key] = map[key];
      // Solo actualiza el modal si sigue abierto en el mismo producto.
      if (state.current && state.current.sku === key) applyModalStock(map[key]);
    }
  } catch (err) {
    console.warn("[stock-refresh]", err);
  }
}

// Refleja el stock en el modal: leyenda, tope de cantidad y bloqueo si agotado.
function applyModalStock(units) {
  state.currentStock = units;
  const line = document.getElementById("m-stock");
  const qty = document.getElementById("m-qty");
  const addBtn = document.getElementById("m-add");
  const steppers = document.querySelectorAll("#m-cotizar .qty-stepper button");

  if (line) {
    if (units == null) {
      line.hidden = true;
      line.textContent = "";
      line.className = "stock-line";
    } else if (units <= 0) {
      line.hidden = false;
      line.textContent = "Agotado — sin unidades disponibles";
      line.className = "stock-line stock-out";
    } else {
      line.hidden = false;
      line.textContent = units <= STOCK_LOW_THRESHOLD
        ? `Últimas ${units} ${units === 1 ? "unidad disponible" : "unidades disponibles"}`
        : `${units} unidades disponibles`;
      line.className = `stock-line ${units <= STOCK_LOW_THRESHOLD ? "stock-low" : "stock-ok"}`;
    }
  }

  const agotado = units != null && units <= 0;
  if (qty) {
    if (units != null && units > 0) {
      qty.max = String(units);
      if ((parseInt(qty.value, 10) || 1) > units) qty.value = String(units);
    } else {
      qty.removeAttribute("max");
    }
    qty.disabled = agotado;
  }
  if (addBtn) {
    addBtn.disabled = agotado;
    addBtn.textContent = agotado ? "Agotado" : "Agregar a cotización";
  }
  steppers.forEach((b) => { b.disabled = agotado; });
}

// Recorta una cantidad al stock disponible (si se conoce).
function clampToStock(qty) {
  const s = state.currentStock;
  if (typeof s === "number" && s >= 0) return Math.max(0, Math.min(qty, s));
  return qty;
}

let toastTimer = null;
function toast(msg, isError = false) {
  let el = document.getElementById("catalog-toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "catalog-toast";
    el.className = "catalog-toast";
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.toggle("is-error", !!isError);
  el.classList.add("show");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 3200);
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

async function loadClientCatalog() {
  if (!state.clientSlug) return;
  try {
    const clientRef = doc(db, CLIENTS_COLLECTION, state.clientSlug);
    const clientSnap = await getDoc(clientRef);
    if (!clientSnap.exists() || clientSnap.data().activo === false) {
      showCatalogUnavailable();
      return;
    }

    state.client = { id: clientSnap.id, ...clientSnap.data() };
    const pricesSnap = await getDocs(collection(clientRef, "precios"));
    state.priceOverrides = new Map(pricesSnap.docs.map((d) => [String(d.data().sku || d.id), d.data()]));
  } catch (err) {
    console.warn("[client-catalog]", err);
    showCatalogUnavailable();
  }
}

function applyClientCatalog(products) {
  if (!state.client) return products;
  return products
    .map((product) => {
      const override = state.priceOverrides.get(product.sku);
      if (override?.visible === false) return null;
      const next = { ...product, _clientPrice: !!override };
      const price = Number(override?.precioBase) || 0;
      if (price > 0) {
        next.precioBase = price;
        next.precio = money(price);
      }
      if (Array.isArray(override?.escalasUnidades)) {
        next.escalasUnidades = override.escalasUnidades
          .map((e) => ({ desde: Number(e.desde) || 0, precio: Number(e.precio) || 0 }))
          .filter((e) => e.desde > 0 && e.precio > 0);
      }
      return next;
    })
    .filter(Boolean);
}

function renderCatalogIdentity() {
  if (!state.client) return;
  const name = state.client.nombre || "Catalogo";
  document.title = `${name} · Catalogo`;
  if (els.headerTitle) els.headerTitle.textContent = name;
  if (els.subtitle) {
    els.subtitle.textContent = state.client.subtitulo || "Catalogo compartido con precios propios";
  }
}

function showCatalogUnavailable() {
  state.catalogUnavailable = true;
  state.all = [];
  state.filtered = [];
  state.priceOverrides = new Map();
  if (els.headerTitle) els.headerTitle.textContent = "Catalogo no disponible";
  if (els.subtitle) els.subtitle.textContent = "El link no esta activo o no existe.";
  els.grid.innerHTML = '<p class="empty">Este catalogo no esta disponible.</p>';
  els.empty.hidden = true;
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
  if (state.catalogUnavailable) {
    state.filtered = [];
    render();
    return;
  }
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
  if (state.catalogUnavailable) {
    els.count.textContent = "0 productos";
    els.empty.hidden = true;
    els.grid.innerHTML = '<p class="empty">Este catalogo no esta disponible.</p>';
    return;
  }

  els.grid.innerHTML = "";
  const frag = document.createDocumentFragment();
  state.filtered.forEach((p) => {
    const card = document.createElement("article");
    card.className = "card";
    const precioTxt = tienePrecio(p) ? `${money(p.precioBase)}${state.client ? "" : " sugerido"}` : "";
    const img = productImages(p)[0];
    const units = stockFor(p.sku);
    if (units === 0) card.classList.add("card-agotado");
    card.innerHTML = `
      <div class="card-media">
        ${
          img
            ? `<img src="${escapeAttr(img)}" alt="${escapeAttr(p.nombre)}" loading="lazy" onerror="this.parentNode.innerHTML='<span class=&quot;ph&quot;>Sin imagen</span>'" />`
            : '<span class="ph">Sin imagen</span>'
        }
        ${renderStockBadge(units)}
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
  clearTurnSheet();
  const carousel = document.getElementById("m-carousel");
  if (carousel) carousel.innerHTML = "";
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
    precioEl.textContent = `${money(p.precioBase)}${state.client ? "" : " precio sugerido"}`;
    precioEl.style.display = "";
    renderEscalas(p);
    document.getElementById("m-qty").value = state.cart[p.sku] || 1;
    applyModalStock(stockFor(p.sku));
    refreshModalLineTotal();
    refreshStockFor(p.sku); // re-consulta fresca al abrir (por ventas en ML)
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
  const imgs = [];
  const cover = String(p?.imagen || "").trim();
  if (cover) imgs.push(cover);
  if (Array.isArray(p?.imagenesCatalogo)) {
    p.imagenesCatalogo.forEach((u) => {
      const s = String(u || "").trim();
      if (s && !imgs.includes(s)) imgs.push(s);
    });
  }
  return imgs;
}

function modalPageCount() {
  return Math.max(state.currentImages.length || 1, productInfoPages(state.current).length || 1);
}

function renderCarousel() {
  renderPhotoPage();
  updateCarouselChrome();
  renderInfoBook();
  preloadNeighborImages();
}

function updateCarouselChrome() {
  const wrap = document.getElementById("m-carousel");
  const prev = document.getElementById("m-img-prev");
  const next = document.getElementById("m-img-next");
  const total = modalPageCount();
  wrap.dataset.page = `${state.currentImageIdx + 1} / ${total}`;
  prev.style.display = total > 1 ? "" : "none";
  next.style.display = total > 1 ? "" : "none";
}

// Swaps the photo half to the current page's image. If the URL didn't change
// (products with one photo but several info pages) it is a no-op — replacing
// the photo with itself is what caused it to blink.
// Returns a promise that resolves once the new photo is painted, so callers
// can keep a covering leaf in place until the hand-off is seamless.
function renderPhotoPage(instant = false) {
  const wrap = document.getElementById("m-carousel");
  const images = state.currentImages.length ? state.currentImages : [""];
  const idx = state.currentImageIdx % images.length;
  const url = images[idx] || "";
  const existing = wrap.querySelector(".book-page.active");
  if (existing && wrap.dataset.url === url) return Promise.resolve();
  wrap.dataset.url = url;
  const oldPages = Array.from(wrap.querySelectorAll(".book-page"));
  wrap.insertAdjacentHTML(
    "beforeend",
    renderImagePage(url, idx, images.length, instant ? "book-page active" : "book-page")
  );
  const fresh = wrap.lastElementChild;
  const img = fresh.querySelector("img");
  return new Promise((resolve) => {
    let revealed = false;
    // Only crossfade once the new photo is actually paintable: the outgoing
    // page stays put underneath and is removed after the fade. No blank gap.
    const reveal = () => {
      if (revealed) return;
      revealed = true;
      if (!instant) {
        fresh.getBoundingClientRect(); // flush styles so the transition runs
        fresh.classList.add("active");
      }
      if (oldPages.length) setTimeout(() => oldPages.forEach((el) => el.remove()), instant ? 0 : 520);
      // Give the browser two frames to actually put the pixels on screen.
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    };
    if (img && !img.complete) {
      img.addEventListener("load", reveal, { once: true });
      img.addEventListener("error", reveal, { once: true });
      setTimeout(reveal, 1500); // guard: never leave the page hidden forever
    } else {
      reveal();
    }
  });
}

// Resolves once the bitmap is downloaded AND decoded, so it can be painted in
// the same frame it is inserted (no late "pop in" after the page turn). The
// browser caches the URL, so the real <img> later reuses it instantly.
function preloadImage(url) {
  return new Promise((resolve) => {
    if (!url) { resolve(); return; }
    const img = new Image();
    const settle = () => resolve();
    img.onload = () => { (img.decode ? img.decode() : Promise.resolve()).then(settle, settle); };
    img.onerror = settle;
    img.src = url;
  });
}

// Warm the adjacent photos so a page turn finds them already decoded in cache.
function preloadNeighborImages() {
  const imgs = state.currentImages;
  if (!imgs || imgs.length <= 1) return;
  const i = state.currentImageIdx % imgs.length;
  preloadImage(imgs[(i + 1) % imgs.length]);
  preloadImage(imgs[(i - 1 + imgs.length) % imgs.length]);
}

function stepCarousel(delta) {
  const total = modalPageCount();
  if (total <= 1) return;
  if (state.currentTurnTimer) return;

  const isNext = delta >= 0;
  const previousIdx = state.currentImageIdx;
  const nextIdx = (state.currentImageIdx + delta + total) % total;
  state.currentPrevImageIdx = previousIdx;
  state.currentTurnDirection = isNext ? 1 : -1;

  const imgs = state.currentImages.length ? state.currentImages : [""];
  const destUrl = imgs[nextIdx % imgs.length];
  const currUrl = imgs[previousIdx % imgs.length];
  // On the stacked (mobile) layout the leaf swings out of view, so the photo
  // below simply crossfades. On the two-page layout the leaf itself carries
  // the photo: its back face IS the photo page that lands on the left half.
  const stacked = window.matchMedia("(max-width: 760px)").matches;

  preloadImage(destUrl);

  // The turning leaf lives on the info side. NEXT: its front carries the info
  // page we are leaving and its back carries the INCOMING photo, which lands
  // flat on the photo half — the photo arrives WITH the page turn. PREV: its
  // back shows the CURRENT photo (so covering it is invisible) and lifts away
  // to reveal the previous photo already swapped in underneath.
  renderTurnSheet(isNext ? previousIdx : nextIdx, isNext, isNext ? destUrl : currUrl);

  state.currentImageIdx = nextIdx;
  if (isNext) {
    // The leaf lifts off the info half: the new info page must already be
    // underneath. The photo half keeps the old photo — the leaf delivers it.
    renderInfoBook();
    if (stacked) renderPhotoPage();
  } else {
    // The leaf is covering the photo half: swap the photo under it now.
    renderPhotoPage();
  }
  updateCarouselChrome();
  preloadNeighborImages();

  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    if (state.currentTurnTimer) clearTimeout(state.currentTurnTimer);
    state.currentTurnTimer = null;
    state.currentPrevImageIdx = null;
    if (els.turnSheet) els.turnSheet.removeEventListener("animationend", onEnd);
    if (isNext && !stacked) {
      // The leaf lies flat showing the new photo. Swap the real page under it
      // and lift the sheet only once that page is painted — seamless hand-off.
      // (If another turn already started, its sheet is live: don't clear it.)
      renderPhotoPage(true).then(() => { if (!state.currentTurnTimer) clearTurnSheet(); });
    } else {
      renderInfoBook();
      clearTurnSheet();
    }
  };
  const onEnd = (e) => { if (e.target === els.turnSheet) finish(); };
  els.turnSheet.addEventListener("animationend", onEnd);
  // Fallback in case animationend never fires (e.g. prefers-reduced-motion).
  state.currentTurnTimer = setTimeout(finish, 950);
}

function renderImagePage(url, index, total, cls) {
  return `
    <figure class="${cls}" aria-label="Imagen ${index + 1} de ${total}">
      ${url ? `<img src="${escapeAttr(url)}" alt="${escapeAttr(state.current?.nombre || "")}" decoding="async" />` : '<span class="ph">Sin imagen</span>'}
    </figure>
  `;
}

function renderTurnSheet(infoPageIndex, isNext, backPhotoUrl) {
  if (!els.turnSheet || !state.current) return;
  const infoPages = productInfoPages(state.current);
  const infoPage = infoPages[infoPageIndex % infoPages.length];
  const total = modalPageCount();
  const front = `
    <div class="turn-page-info">
      <div class="turn-info-head">
        <div class="badges">${renderBadgeCopy(state.current.categoria, "badge")}${renderBadgeCopy(state.current.marca, "badge badge-soft")}</div>
        <h2>${escapeHtml(state.current.nombre || state.current.sku)}</h2>
        <p class="sku">SKU: ${escapeHtml(state.current.sku)}</p>
      </div>
      ${renderQuoteCopy()}
      ${renderInfoPage(infoPage, infoPageIndex + 1, total, "info-page active turn-copy")}
    </div>
  `;

  // Two-faced leaf: a solid front carrying the info page, and a back that IS
  // the photo page — mirroring the real media pane's geometry so that when
  // the leaf lands flat on the photo half the hand-off is pixel-identical.
  const back = `
    <div class="turn-page-media">
      <div class="turn-image-wrap">
        ${renderImagePage(backPhotoUrl || "", state.currentImageIdx, state.currentImages.length || 1, "book-page active")}
      </div>
    </div>
  `;
  els.turnSheet.innerHTML = `
    <div class="turn-face turn-face-front">${front}</div>
    <div class="turn-face turn-face-back" aria-hidden="true">${back}</div>
  `;
  els.turnSheet.hidden = false;
  els.turnSheet.className = `turn-sheet ${isNext ? "turn-next" : "turn-prev"}`;
  els.turnSheet.getBoundingClientRect();
  els.turnSheet.classList.add("is-turning");
}

function clearTurnSheet() {
  if (!els.turnSheet) return;
  els.turnSheet.hidden = true;
  els.turnSheet.className = "turn-sheet";
  els.turnSheet.innerHTML = "";
}

function renderBadgeCopy(text, cls) {
  return text ? `<span class="${cls}">${escapeHtml(text)}</span>` : "";
}

function renderQuoteCopy() {
  const p = state.current;
  if (!p || !tienePrecio(p)) return "";
  const qty = currentQty();
  const unit = precioUnitario(p, qty);
  return `
    <div class="turn-quote">
      <p class="precio">${money(p.precioBase)}${state.client ? "" : " precio sugerido"}</p>
      <div class="cotizar-add">
        <div class="qty-stepper">
          <button type="button" aria-hidden="true">−</button>
          <input type="number" min="1" value="${qty}" tabindex="-1" />
          <button type="button" aria-hidden="true">+</button>
        </div>
        <button class="btn-add" type="button" tabindex="-1">Agregar a cotización</button>
      </div>
      <p class="line-total">${qty} × ${money(unit)} = ${money(unit * qty)}</p>
    </div>
  `;
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
  els.infoBook.innerHTML = renderInfoPage(pages[idx], state.currentImageIdx + 1, total, "info-page active");
}

function renderInfoPage(page, pageNumber, total, cls) {
  return `
    <section class="${cls}" aria-label="Detalle ${pageNumber} de ${total}">
      <div class="info-page-inner">
        <p class="info-eyebrow">${escapeHtml(page.eyebrow)}</p>
        ${page.blocks.map(renderInfoBlock).join("")}
      </div>
      <p class="info-page-count">${pageNumber} / ${total}</p>
    </section>
  `;
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
  const raw = Math.max(1, parseInt(document.getElementById("m-qty").value, 10) || 1);
  const capped = clampToStock(raw);
  return Math.max(1, capped);
}

function stepQty(delta) {
  const input = document.getElementById("m-qty");
  let next = Math.max(1, (parseInt(input.value, 10) || 1) + delta);
  const s = state.currentStock;
  if (typeof s === "number" && s > 0) next = Math.min(next, s);
  input.value = next;
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
  const s = state.currentStock;
  if (typeof s === "number" && s <= 0) {
    toast("Este producto está agotado.", true);
    return;
  }
  let qty = currentQty();
  if (typeof s === "number" && qty > s) {
    qty = s;
    toast(`Solo hay ${s} ${s === 1 ? "unidad disponible" : "unidades disponibles"}. Ajustamos la cantidad.`, true);
  }
  state.cart[p.sku] = qty;
  saveCart();
  renderCart();
  closeModal();
  openCart();
}

function closeModal() {
  if (state.currentTurnTimer) clearTimeout(state.currentTurnTimer);
  state.currentTurnTimer = null;
  state.currentPrevImageIdx = null;
  clearTurnSheet();
  els.modal.hidden = true;
  document.body.style.overflow = "";
}

/* ---------------- CARRITO / COTIZACIÓN ---------------- */
function loadCart() {
  try { return JSON.parse(localStorage.getItem(cartStorageKey())) || {}; }
  catch { return {}; }
}
function saveCart() {
  localStorage.setItem(cartStorageKey(), JSON.stringify(state.cart));
}

function cartStorageKey() {
  return state.clientSlug ? `${CART_KEY}_${state.clientSlug}` : CART_KEY;
}

function catalogSlugFromUrl() {
  const params = new URLSearchParams(window.location.search);
  return normalizeSlug(params.get("cliente") || params.get("catalogo") || params.get("c"));
}

function normalizeSlug(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function cartLines() {
  return Object.entries(state.cart)
    .map(([sku, qty]) => {
      const p = state.all.find((x) => x.sku === sku);
      if (!p) return null;
      const unit = precioUnitario(p, qty);
      const stock = stockFor(sku);
      const excede = typeof stock === "number" && qty > stock;
      return { p, qty, unit, total: unit * qty, stock, excede };
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
        ${l.excede ? `<p class="cart-row-warn">⚠ Solo ${l.stock} ${l.stock === 1 ? "disponible" : "disponibles"}</p>` : ""}
        <div class="qty-stepper sm">
          <button type="button" data-dec aria-label="Quitar">−</button>
          <input type="number" min="1" value="${l.qty}" data-qty-input />
          <button type="button" data-inc aria-label="Agregar">+</button>
          <button type="button" class="cart-del" data-del aria-label="Eliminar">🗑</button>
        </div>
      </div>
      <div class="cart-row-total">${money(l.total)}</div>`;
    if (l.excede) row.classList.add("cart-row-excede");

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
