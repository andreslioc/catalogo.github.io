import {
  db, auth, storage, COLLECTION,
  collection, getDocs, getDoc, doc, setDoc, deleteDoc, query, orderBy,
  signOut, onAuthStateChanged, getIdTokenResult,
  storageRef, uploadBytes, getDownloadURL,
} from "./firebase-config.js?v=20260630-1";
import {
  DEFAULT_MARGIN_PCT,
  DEFAULT_WHOLESALE_RULES,
  money,
  precioSugeridoDesdeCosto,
} from "./pricing.js";

const TEXT_FIELDS = [
  "nombre", "sku", "marca", "imagen", "categoria",
  "descripcion", "dosis", "modoUso", "advertencias", "presentacion",
];
const LIST_FIELDS = ["beneficios", "ingredientes"];
const CONFIG_COLLECTION = "catalogo_config";
const PRICING_DOC = "pricing";

const state = {
  products: [],
  wholesaleRules: DEFAULT_WHOLESALE_RULES.map((r) => ({ ...r })),
  deleted: new Set(),
  search: "",
  dirty: false,
};
const els = {};
let authResolved = false;
const ADMIN_ENTRY_KEY = "catalogAdminEntry";
const ADMIN_ENTRY_MAX_MS = 10 * 60 * 1000;

function redirectToLogin(reason = "") {
  const suffix = reason ? `&error=${encodeURIComponent(reason)}` : "";
  window.location.replace(`index.html?admin=1${suffix}`);
}

function withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);
}

function hasFreshAdminEntry() {
  try {
    const raw = sessionStorage.getItem(ADMIN_ENTRY_KEY);
    if (!raw) return false;
    const data = JSON.parse(raw);
    return Date.now() - Number(data?.at || 0) < ADMIN_ENTRY_MAX_MS;
  } catch {
    return false;
  }
}

function showEditor() {
  document.getElementById("login").hidden = true;
  document.getElementById("app").hidden = false;
  if (window.__adminBootTimer) clearTimeout(window.__adminBootTimer);
  startApp();
}

function initAuth() {
  const hasEntry = hasFreshAdminEntry();

  if (hasEntry) {
    showEditor();
  }

  setTimeout(() => {
    if (!authResolved && !hasFreshAdminEntry()) redirectToLogin("timeout");
  }, 5000);

  onAuthStateChanged(auth, async (user) => {
    authResolved = true;
    if (!user) {
      if (!hasFreshAdminEntry()) redirectToLogin();
      return;
    }

    if (!hasFreshAdminEntry()) {
      document.getElementById("login").hidden = false;
      document.getElementById("app").hidden = true;
    }

    try {
      const token = await withTimeout(getIdTokenResult(user, true), 6000, "token-timeout");
      if (token.claims.admin !== true) {
        sessionStorage.removeItem(ADMIN_ENTRY_KEY);
        await signOut(auth);
        redirectToLogin("not-admin");
        return;
      }
      sessionStorage.setItem(ADMIN_ENTRY_KEY, JSON.stringify({ at: Date.now(), email: user.email || "" }));
      showEditor();
    } catch (err) {
      if (!hasFreshAdminEntry()) {
        await signOut(auth);
        redirectToLogin("timeout");
      }
    }
  });
}

let started = false;
async function startApp() {
  if (started) return;
  started = true;
  cacheEls();
  bindToolbar();
  await loadPricingConfig();
  await loadData();
  refreshCategories();
  renderRules();
  render();
}

function cacheEls() {
  els.editor = document.getElementById("editor");
  els.tpl = document.getElementById("row-tpl");
  els.escalaTpl = document.getElementById("escala-tpl");
  els.ruleTpl = document.getElementById("rule-tpl");
  els.rules = document.getElementById("wholesale-rules");
  els.status = document.getElementById("status");
  els.count = document.getElementById("admin-count");
  els.search = document.getElementById("admin-search");
  els.toast = document.getElementById("toast");
  els.catList = document.getElementById("cat-list");
}

function bindToolbar() {
  document.getElementById("btn-add").addEventListener("click", addProduct);
  document.getElementById("btn-save").addEventListener("click", save);
  document.getElementById("btn-logout").addEventListener("click", () => signOut(auth));
  els.search.addEventListener("input", (e) => {
    state.search = e.target.value.trim().toLowerCase();
    render();
  });
  window.addEventListener("beforeunload", (e) => {
    if (state.dirty) { e.preventDefault(); e.returnValue = ""; }
  });
}

async function loadPricingConfig() {
  try {
    const snap = await getDoc(doc(db, CONFIG_COLLECTION, PRICING_DOC));
    const data = snap.exists() ? snap.data() : {};
    const rules = Array.isArray(data.wholesaleRules) && data.wholesaleRules.length
      ? data.wholesaleRules
      : DEFAULT_WHOLESALE_RULES;
    state.wholesaleRules = rules.map((rule) => ({
      desdeMonto: Number(rule.desdeMonto) || 0,
      minUnidadesPorReferencia: Math.max(1, Number(rule.minUnidadesPorReferencia) || 1),
      descuentoPct: Number(rule.descuentoPct) || 0,
      activo: rule.activo !== false,
    }));
  } catch (err) {
    state.wholesaleRules = DEFAULT_WHOLESALE_RULES.map((r) => ({ ...r }));
    toast("No se pudieron cargar las reglas mayoristas: " + (err?.code || err), true);
  }
}

async function loadData() {
  setStatus("Cargando desde Firestore...");
  try {
    let snap;
    try {
      snap = await getDocs(query(collection(db, COLLECTION), orderBy("orden")));
    } catch {
      snap = await getDocs(collection(db, COLLECTION));
    }
    state.products = snap.docs.map((d) => normalizeProduct({ ...d.data(), _origSku: d.data().sku }));
  } catch (err) {
    state.products = [];
    toast("No se pudo cargar el catalogo: " + (err?.code || err), true);
  }
  state.dirty = false;
  state.deleted.clear();
  setStatus(`Cargado desde Firestore · ${state.products.length} productos`);
}

function normalizeProduct(p) {
  TEXT_FIELDS.forEach((f) => { if (typeof p[f] !== "string") p[f] = p[f] == null ? "" : String(p[f]); });
  LIST_FIELDS.forEach((f) => { if (!Array.isArray(p[f])) p[f] = []; });
  // Galería: unifica la portada (imagen) y las fotos adicionales (imagenesCatalogo)
  // en una sola lista sin duplicados. La primera foto es la portada.
  const gallery = [];
  const cover = String(p.imagen || "").trim();
  if (cover) gallery.push(cover);
  (Array.isArray(p.imagenesCatalogo) ? p.imagenesCatalogo : []).forEach((u) => {
    const s = String(u || "").trim();
    if (s && !gallery.includes(s)) gallery.push(s);
  });
  p.imagenesCatalogo = gallery;
  p.imagen = gallery[0] || "";
  p.costoLlegada = Number(p.costoLlegada) || 0;
  p.margenSugeridoPct = Number.isFinite(Number(p.margenSugeridoPct)) ? Number(p.margenSugeridoPct) : DEFAULT_MARGIN_PCT;
  p.precioBase = Number(p.precioBase) || 0;
  p.escalasUnidades = Array.isArray(p.escalasUnidades)
    ? p.escalasUnidades.map((e) => ({ desde: Number(e.desde) || 0, precio: Number(e.precio) || 0 }))
    : [];
  if (!("_origSku" in p)) p._origSku = p.sku || null;
  return p;
}

function renderRules() {
  els.rules.innerHTML = "";
  state.wholesaleRules.forEach((rule) => {
    const node = els.ruleTpl.content.firstElementChild.cloneNode(true);
    const monto = node.querySelector(".r-monto");
    const min = node.querySelector(".r-min");
    const pct = node.querySelector(".r-pct");
    const activo = node.querySelector(".r-activo");
    monto.value = rule.desdeMonto || "";
    min.value = rule.minUnidadesPorReferencia || 1;
    pct.value = rule.descuentoPct || "";
    activo.checked = rule.activo !== false;
    monto.addEventListener("input", () => { rule.desdeMonto = Number(monto.value) || 0; markDirty(); });
    min.addEventListener("input", () => { rule.minUnidadesPorReferencia = Number(min.value) || 1; markDirty(); });
    pct.addEventListener("input", () => { rule.descuentoPct = Number(pct.value) || 0; markDirty(); });
    activo.addEventListener("change", () => { rule.activo = activo.checked; markDirty(); });
    els.rules.appendChild(node);
  });
}

function render() {
  const q = state.search;
  const visible = q
    ? state.products.filter((p) =>
        [p.nombre, p.sku, p.marca].some((v) => (v || "").toLowerCase().includes(q)))
    : state.products;

  els.count.textContent = `${visible.length} de ${state.products.length}`;
  els.editor.innerHTML = "";
  const frag = document.createDocumentFragment();
  visible.forEach((p) => frag.appendChild(buildRow(p)));
  els.editor.appendChild(frag);
}

function buildRow(p) {
  const node = els.tpl.content.firstElementChild.cloneNode(true);
  const thumb = node.querySelector(".edit-thumb");
  const setThumb = (url) => {
    if (url) { thumb.src = url; thumb.style.display = ""; }
    else { thumb.removeAttribute("src"); thumb.style.display = "none"; }
  };
  setThumb(p.imagen);

  TEXT_FIELDS.forEach((f) => {
    const input = node.querySelector(".f-" + f);
    if (!input) return;
    input.value = p[f] || "";
    input.addEventListener("input", () => {
      p[f] = input.value;
      if (f === "imagen") setThumb(input.value.trim());
      markDirty();
    });
  });

  LIST_FIELDS.forEach((f) => {
    const input = node.querySelector(".f-" + f);
    if (!input) return;
    input.value = (p[f] || []).join("\n");
    input.addEventListener("input", () => {
      p[f] = input.value.split("\n").map((s) => s.trim()).filter(Boolean);
      markDirty();
    });
  });

  bindPriceFields(node, p);
  bindGalleryFields(node, p, setThumb);
  bindScaleFields(node, p);
  bindDelete(node, p);
  return node;
}

function bindPriceFields(node, p) {
  const costInput = node.querySelector(".f-costoLlegada");
  const marginInput = node.querySelector(".f-margenSugeridoPct");
  const baseInput = node.querySelector(".f-precioBase");
  costInput.value = p.costoLlegada || "";
  marginInput.value = p.margenSugeridoPct ?? DEFAULT_MARGIN_PCT;
  baseInput.value = p.precioBase || "";
  costInput.addEventListener("input", () => { p.costoLlegada = Number(costInput.value) || 0; markDirty(); });
  marginInput.addEventListener("input", () => { p.margenSugeridoPct = Number(marginInput.value) || DEFAULT_MARGIN_PCT; markDirty(); });
  baseInput.addEventListener("input", () => { p.precioBase = Number(baseInput.value) || 0; markDirty(); });
  node.querySelector(".btn-calc-price").addEventListener("click", () => {
    p.precioBase = precioSugeridoDesdeCosto(p.costoLlegada, p.margenSugeridoPct);
    baseInput.value = p.precioBase || "";
    markDirty();
  });
}

async function uploadImage(file, sku) {
  const safeName = (file.name || "foto").replace(/[^\w.\-]+/g, "_");
  const folder = (sku || "sin-sku").trim().replace(/[^\w\-]+/g, "_") || "sin-sku";
  const ref = storageRef(storage, `catalogo/${folder}/${Date.now()}-${safeName}`);
  await uploadBytes(ref, file);
  return getDownloadURL(ref);
}

function bindGalleryFields(node, p, setThumb) {
  const grid = node.querySelector(".gallery-grid");
  const fileInput = node.querySelector(".g-file");
  const urlInput = node.querySelector(".g-url");
  const urlAdd = node.querySelector(".g-url-add");
  const uploadLabel = node.querySelector(".gallery-upload");

  const syncCover = () => {
    p.imagen = p.imagenesCatalogo[0] || "";
    setThumb(p.imagen);
  };

  const renderGallery = () => {
    grid.innerHTML = "";
    if (!p.imagenesCatalogo.length) {
      const empty = document.createElement("p");
      empty.className = "gallery-empty";
      empty.textContent = "Sin fotos todavía. Sube una o pega una URL.";
      grid.appendChild(empty);
      return;
    }
    p.imagenesCatalogo.forEach((url, idx) => {
      const item = document.createElement("div");
      item.className = "gallery-item" + (idx === 0 ? " is-cover" : "");
      item.innerHTML = `
        <img src="${escapeAttr(url)}" alt="" loading="lazy" decoding="async" />
        ${idx === 0
          ? '<span class="gallery-badge">Portada</span>'
          : '<button type="button" class="g-cover" title="Usar como portada">★</button>'}
        <button type="button" class="g-del" title="Quitar foto">✕</button>`;
      item.querySelector(".g-del").addEventListener("click", () => {
        p.imagenesCatalogo.splice(idx, 1);
        markDirty(); syncCover(); renderGallery();
      });
      const coverBtn = item.querySelector(".g-cover");
      if (coverBtn) coverBtn.addEventListener("click", () => {
        const [moved] = p.imagenesCatalogo.splice(idx, 1);
        p.imagenesCatalogo.unshift(moved);
        markDirty(); syncCover(); renderGallery();
      });
      grid.appendChild(item);
    });
  };

  const addUrl = (raw) => {
    const url = String(raw || "").trim();
    if (!url) return;
    if (p.imagenesCatalogo.includes(url)) { toast("Esa foto ya está en la galería."); return; }
    p.imagenesCatalogo.push(url);
    markDirty(); syncCover(); renderGallery();
  };

  urlAdd.addEventListener("click", () => { addUrl(urlInput.value); urlInput.value = ""; });
  urlInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); addUrl(urlInput.value); urlInput.value = ""; }
  });

  fileInput.addEventListener("change", async () => {
    const files = Array.from(fileInput.files || []);
    fileInput.value = "";
    if (!files.length) return;
    uploadLabel.classList.add("is-loading");
    let added = 0;
    try {
      for (const file of files) {
        if (!file.type.startsWith("image/")) { toast(`"${file.name}" no es una imagen.`, true); continue; }
        const url = await uploadImage(file, p.sku);
        if (!p.imagenesCatalogo.includes(url)) { p.imagenesCatalogo.push(url); added++; }
      }
      if (added) { markDirty(); syncCover(); renderGallery(); }
      toast(added ? "Foto(s) subida(s). No olvides Guardar cambios." : "No se agregó ninguna foto.");
    } catch (err) {
      toast("Error al subir la foto: " + (err?.code || err?.message || err), true);
    } finally {
      uploadLabel.classList.remove("is-loading");
    }
  });

  renderGallery();
}

function bindScaleFields(node, p) {
  const rowsWrap = node.querySelector(".escalas-rows");
  const renderEscalas = () => {
    rowsWrap.innerHTML = "";
    p.escalasUnidades.forEach((esc, idx) => rowsWrap.appendChild(buildEscalaRow(p, esc, idx, renderEscalas)));
  };
  renderEscalas();
  node.querySelector(".btn-escala-add").addEventListener("click", () => {
    p.escalasUnidades.push({ desde: 0, precio: 0 });
    markDirty();
    renderEscalas();
  });
}

function bindDelete(node, p) {
  node.querySelector(".btn-del").addEventListener("click", () => {
    const label = p.nombre || p.sku || "este producto";
    if (!confirm(`Eliminar "${label}" del catalogo?`)) return;
    if (p._origSku) state.deleted.add(p._origSku);
    const i = state.products.indexOf(p);
    if (i >= 0) state.products.splice(i, 1);
    markDirty();
    refreshCategories();
    render();
  });
}

function buildEscalaRow(p, esc, idx, rerender) {
  const node = els.escalaTpl.content.firstElementChild.cloneNode(true);
  const desde = node.querySelector(".e-desde");
  const precio = node.querySelector(".e-precio");
  desde.value = esc.desde || "";
  precio.value = esc.precio || "";
  desde.addEventListener("input", () => { esc.desde = Number(desde.value) || 0; markDirty(); });
  precio.addEventListener("input", () => { esc.precio = Number(precio.value) || 0; markDirty(); });
  node.querySelector(".escala-del").addEventListener("click", () => {
    p.escalasUnidades.splice(idx, 1);
    markDirty();
    rerender();
  });
  return node;
}

function refreshCategories() {
  const cats = [...new Set(state.products.map((p) => p.categoria).filter(Boolean))];
  els.catList.innerHTML = cats.map((c) => `<option value="${escapeAttr(c)}"></option>`).join("");
}

function addProduct() {
  const nuevo = normalizeProduct({ sku: "", nombre: "", imagen: "", categoria: "", marca: "", _origSku: null });
  state.products.unshift(nuevo);
  state.search = "";
  els.search.value = "";
  markDirty();
  render();
  els.editor.scrollIntoView({ behavior: "smooth" });
  const first = els.editor.querySelector(".edit-card .f-nombre");
  if (first) first.focus();
}

function markDirty() { state.dirty = true; }

function validate() {
  const seen = new Set();
  for (const p of state.products) {
    const sku = (p.sku || "").trim();
    if (!sku) return "Hay un producto sin SKU. El SKU es obligatorio.";
    const key = sku.toLowerCase();
    if (seen.has(key)) return `SKU duplicado: "${sku}". Cada producto necesita un SKU unico.`;
    seen.add(key);
  }
  return null;
}

function docId(sku) { return sku.trim().replace(/\//g, "_"); }

function toFirestore(p, orden) {
  const out = { orden };
  TEXT_FIELDS.forEach((f) => { out[f] = p[f] || ""; });
  LIST_FIELDS.forEach((f) => { out[f] = Array.isArray(p[f]) ? p[f] : []; });
  out.precioBase = Number(p.precioBase) || 0;
  out.precio = out.precioBase > 0 ? money(out.precioBase) : "";
  out.costoLlegada = Number(p.costoLlegada) || 0;
  out.margenSugeridoPct = Number(p.margenSugeridoPct) || DEFAULT_MARGIN_PCT;
  const gallery = (p.imagenesCatalogo || [])
    .map((u) => String(u || "").trim())
    .filter((u, i, arr) => u && arr.indexOf(u) === i);
  out.imagenesCatalogo = gallery;
  out.imagen = gallery[0] || "";
  out.escalasUnidades = (p.escalasUnidades || [])
    .map((e) => ({ desde: Number(e.desde) || 0, precio: Number(e.precio) || 0 }))
    .filter((e) => e.desde > 0 && e.precio > 0);
  return out;
}

async function save() {
  const err = validate();
  if (err) { toast(err, true); return; }

  setStatus("Guardando en Firestore...");
  try {
    for (let i = 0; i < state.products.length; i++) {
      const p = state.products[i];
      const id = docId(p.sku);
      await setDoc(doc(db, COLLECTION, id), toFirestore(p, i));
      if (p._origSku && docId(p._origSku) !== id) {
        await deleteDoc(doc(db, COLLECTION, docId(p._origSku)));
      }
      p._origSku = p.sku;
    }

    const vivos = new Set(state.products.map((p) => docId(p.sku)));
    for (const origSku of state.deleted) {
      const id = docId(origSku);
      if (!vivos.has(id)) await deleteDoc(doc(db, COLLECTION, id));
    }

    await setDoc(doc(db, CONFIG_COLLECTION, PRICING_DOC), {
      wholesaleRules: state.wholesaleRules.map((rule) => ({
        desdeMonto: Number(rule.desdeMonto) || 0,
        minUnidadesPorReferencia: Math.max(1, Number(rule.minUnidadesPorReferencia) || 1),
        descuentoPct: Number(rule.descuentoPct) || 0,
        activo: rule.activo !== false,
      })),
      updatedAt: new Date().toISOString(),
    }, { merge: true });

    state.deleted.clear();
    state.dirty = false;
    setStatus(`Guardado en Firestore · ${state.products.length} productos`);
    toast("Cambios guardados. Ya estan en vivo en el catalogo.");
  } catch (e) {
    toast("Error al guardar: " + (e?.code || e), true);
    setStatus("Error al guardar. Revisa tu sesion y vuelve a intentar.");
  }
}

function setStatus(html) { els.status.innerHTML = html; }

let toastTimer = null;
function toast(msg, isError) {
  els.toast.textContent = msg;
  els.toast.classList.toggle("toast-error", !!isError);
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { els.toast.hidden = true; }, 3500);
}

function escapeAttr(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

initAuth();
