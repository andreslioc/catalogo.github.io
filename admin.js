import {
  db, auth, storage, COLLECTION, NEON_IMPORT_ENDPOINT,
  collection, getDocs, getDoc, doc, setDoc, deleteDoc, query, orderBy,
  signOut, onAuthStateChanged, getIdTokenResult,
  storageRef, uploadBytesResumable, getDownloadURL,
} from "./firebase-config.js?v=20260702-1";
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
const IMAGE_UPLOAD_TIMEOUT_MS = 45000;
const IMAGE_UPLOAD_STALLED_MS = 12000;
const EMBED_IMAGE_MAX_SIDE = 1100;
const EMBED_IMAGE_QUALITY = 0.82;
const EMBED_IMAGE_MAX_BYTES = 260 * 1024;

const state = {
  products: [],
  wholesaleRules: DEFAULT_WHOLESALE_RULES.map((r) => ({ ...r })),
  deleted: new Set(),
  search: "",
  dirty: false,
  storageUploadUnavailable: false,
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
  els.skuImportForm = document.getElementById("sku-import-form");
  els.skuImportInput = document.getElementById("sku-import-input");
  els.skuImportButton = document.getElementById("btn-import-sku");
}

function bindToolbar() {
  document.getElementById("btn-add").addEventListener("click", addProduct);
  document.getElementById("btn-save").addEventListener("click", save);
  document.getElementById("btn-logout").addEventListener("click", () => signOut(auth));
  els.skuImportForm.addEventListener("submit", importProductBySku);
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

async function uploadImage(file, sku, onProgress = () => {}) {
  const safeName = (file.name || "foto").replace(/[^\w.\-]+/g, "_");
  const folder = (sku || "sin-sku").trim().replace(/[^\w\-]+/g, "_") || "sin-sku";
  const ref = storageRef(storage, `catalogo/${folder}/${Date.now()}-${safeName}`);
  const metadata = file.type ? { contentType: file.type } : undefined;
  const task = uploadBytesResumable(ref, file, metadata);

  return new Promise((resolve, reject) => {
    let settled = false;
    let timeoutId;
    let stalledId;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      clearTimeout(stalledId);
      fn(value);
    };

    stalledId = setTimeout(() => {
      const err = new Error("Firebase Storage no empezo a transferir la foto.");
      err.code = "upload/stalled";
      finish(reject, err);
      try { task.cancel(); } catch {}
    }, IMAGE_UPLOAD_STALLED_MS);

    timeoutId = setTimeout(() => {
      const err = new Error("La subida tardo demasiado. Revisa tu conexion e intenta con una foto mas liviana.");
      err.code = "upload/timeout";
      finish(reject, err);
      try { task.cancel(); } catch {}
    }, IMAGE_UPLOAD_TIMEOUT_MS);

    task.on("state_changed",
      (snapshot) => {
        const pct = snapshot.totalBytes
          ? Math.round((snapshot.bytesTransferred / snapshot.totalBytes) * 100)
          : 0;
        if (snapshot.bytesTransferred > 0) clearTimeout(stalledId);
        onProgress(pct);
      },
      (err) => finish(reject, err),
      async () => {
        try {
          finish(resolve, await getDownloadURL(ref));
        } catch (err) {
          finish(reject, err);
        }
      },
    );
  });
}

function uploadErrorMessage(err) {
  const code = err?.code || "";
  if (code === "upload/stalled") return "Firebase Storage no empezo la subida. Se usara una copia comprimida local si es posible.";
  if (code === "upload/timeout") return err.message;
  if (code === "storage/unauthenticated") return "La sesion expiro. Vuelve a iniciar sesion e intenta subir la foto otra vez.";
  if (code === "storage/unauthorized") return "Firebase Storage rechazo la foto por permisos. Revisa las reglas de Storage para el usuario administrador.";
  if (code === "storage/quota-exceeded") return "Firebase Storage no tiene cuota disponible.";
  if (code === "storage/retry-limit-exceeded") return "Firebase no pudo completar la subida por conexion. Intenta de nuevo o usa una foto mas liviana.";
  if (code === "storage/canceled") return "La subida fue cancelada. Intenta de nuevo.";
  return code || err?.message || String(err);
}

function canEmbedAfterUploadError(err) {
  return [
    "upload/stalled",
    "upload/timeout",
    "storage/unauthorized",
    "storage/quota-exceeded",
    "storage/retry-limit-exceeded",
    "storage/unknown",
  ].includes(err?.code || "");
}

async function galleryImageUrl(file, sku, onProgress, onFallback) {
  if (state.storageUploadUnavailable) {
    onFallback(null);
    return embeddedImageDataUrl(file);
  }

  try {
    return await uploadImage(file, sku, onProgress);
  } catch (err) {
    if (!canEmbedAfterUploadError(err)) throw err;
    state.storageUploadUnavailable = true;
    onFallback(err);
    try {
      return await embeddedImageDataUrl(file);
    } catch (embedErr) {
      const msg = uploadErrorMessage(err) + " Ademas, no se pudo preparar una copia local de la foto.";
      embedErr.message = msg;
      throw embedErr;
    }
  }
}

async function embeddedImageDataUrl(file) {
  if (file.type === "image/svg+xml") return readBlobAsDataUrl(file);

  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await loadImage(objectUrl);
    const attempts = [
      { maxSide: EMBED_IMAGE_MAX_SIDE, quality: EMBED_IMAGE_QUALITY, type: "image/webp" },
      { maxSide: 900, quality: 0.74, type: "image/webp" },
      { maxSide: 720, quality: 0.68, type: "image/webp" },
      { maxSide: 600, quality: 0.62, type: "image/jpeg" },
    ];
    let bestBlob = null;

    for (const attempt of attempts) {
      const blob = await imageToBlob(img, attempt);
      if (!blob) continue;
      bestBlob = blob;
      if (blob.size <= EMBED_IMAGE_MAX_BYTES) break;
    }

    return readBlobAsDataUrl(bestBlob || file);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("No se pudo leer la imagen seleccionada."));
    img.src = src;
  });
}

function imageToBlob(img, { maxSide, quality, type }) {
  const scale = Math.min(1, maxSide / Math.max(img.naturalWidth || img.width, img.naturalHeight || img.height));
  const width = Math.max(1, Math.round((img.naturalWidth || img.width) * scale));
  const height = Math.max(1, Math.round((img.naturalHeight || img.height) * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return Promise.resolve(null);
  if (type === "image/jpeg") {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
  }
  ctx.drawImage(img, 0, 0, width, height);
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

function readBlobAsDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("No se pudo preparar la imagen seleccionada."));
    reader.readAsDataURL(blob);
  });
}

function bindGalleryFields(node, p, setThumb) {
  const grid = node.querySelector(".gallery-grid");
  const fileInput = node.querySelector(".g-file");
  const urlInput = node.querySelector(".g-url");
  const urlAdd = node.querySelector(".g-url-add");
  const uploadLabel = node.querySelector(".gallery-upload");
  const uploadText = node.querySelector(".gallery-upload-label");
  const defaultUploadText = uploadText?.textContent || "+ Subir foto";
  const setUploadText = (text) => {
    if (uploadText) uploadText.textContent = text;
  };

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
    setUploadText("Subiendo 0%");
    let added = 0;
    let embedded = 0;
    try {
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        if (!file.type.startsWith("image/")) { toast(`"${file.name}" no es una imagen.`, true); continue; }
        const prefix = files.length > 1 ? `${i + 1}/${files.length} ` : "";
        const url = await galleryImageUrl(
          file,
          p.sku,
          (pct) => setUploadText(`Subiendo ${prefix}${pct}%`),
          () => {
            embedded++;
            setUploadText(`Optimizando ${prefix}foto`);
          },
        );
        if (!p.imagenesCatalogo.includes(url)) { p.imagenesCatalogo.push(url); added++; }
      }
      if (added) { markDirty(); syncCover(); renderGallery(); }
      toast(added
        ? (embedded ? "Foto(s) agregada(s) comprimida(s). No olvides Guardar cambios." : "Foto(s) subida(s). No olvides Guardar cambios.")
        : "No se agregó ninguna foto.");
    } catch (err) {
      toast("Error al subir la foto: " + uploadErrorMessage(err), true);
    } finally {
      uploadLabel.classList.remove("is-loading");
      setUploadText(defaultUploadText);
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

async function importProductBySku(e) {
  e.preventDefault();
  const sku = (els.skuImportInput.value || "").trim();
  if (!sku) { toast("Escribe un SKU para buscar en Neon.", true); return; }

  const existing = findProductBySku(sku);
  if (existing) {
    const update = confirm(
      `El SKU "${sku}" ya existe en el catalogo. Actualizar datos basicos y precios desde Neon sin borrar fotos ni textos editados?`,
    );
    if (!update) {
      focusProduct(existing);
      return;
    }
  }

  setImportLoading(true);
  try {
    const imported = await fetchNeonProduct(sku);
    if (existing) {
      mergeImportedProduct(existing, imported);
      markDirty();
      refreshCategories();
      focusProduct(existing);
      toast(`SKU ${existing.sku} actualizado desde Neon. Revisa y guarda cambios.`);
    } else {
      const nuevo = normalizeProduct({ ...imported, _origSku: null });
      state.products.unshift(nuevo);
      state.search = "";
      els.search.value = "";
      markDirty();
      refreshCategories();
      render();
      focusFirstProduct();
      toast(`SKU ${nuevo.sku} importado desde Neon. Revisa y guarda cambios.`);
    }
    els.skuImportInput.value = "";
  } catch (err) {
    toast(importProductErrorMessage(err), true);
  } finally {
    setImportLoading(false);
  }
}

async function fetchNeonProduct(sku) {
  const endpoint = configuredNeonEndpoint();
  if (!endpoint) {
    throw new Error("Configura NEON_IMPORT_ENDPOINT en firebase-config.js antes de importar desde Neon.");
  }

  const token = await currentAdminToken();
  const url = new URL(endpoint, window.location.href);
  url.searchParams.set("sku", sku);
  const res = await fetch(url.toString(), {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error || data?.message || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  if (!data?.product) throw new Error("Neon no devolvio un producto valido.");
  const rawProduct = { ...data.product };
  const importedMargin = Number(rawProduct.margenSugeridoPct);
  const hasImportedMargin = Number.isFinite(importedMargin) && importedMargin > 0;
  if (!hasImportedMargin) delete rawProduct.margenSugeridoPct;
  return normalizeProduct({
    ...rawProduct,
    sku: rawProduct.sku || sku,
    _origSku: null,
    _hasImportedMargin: hasImportedMargin,
  });
}

function configuredNeonEndpoint() {
  return String(window.CATALOGO_NEON_IMPORT_ENDPOINT || NEON_IMPORT_ENDPOINT || "").trim();
}

async function currentAdminToken() {
  if (auth.currentUser) return auth.currentUser.getIdToken();
  const user = await waitForAuthUser();
  if (!user) throw new Error("No se pudo confirmar la sesion de administrador.");
  return user.getIdToken();
}

function waitForAuthUser(timeoutMs = 4000) {
  return new Promise((resolve) => {
    const done = (user) => {
      clearTimeout(timer);
      if (unsubscribe) unsubscribe();
      resolve(user || null);
    };
    let unsubscribe = null;
    const timer = setTimeout(() => done(auth.currentUser), timeoutMs);
    unsubscribe = onAuthStateChanged(auth, done);
  });
}

function setImportLoading(isLoading) {
  els.skuImportInput.disabled = isLoading;
  els.skuImportButton.disabled = isLoading;
  els.skuImportButton.textContent = isLoading ? "Buscando..." : "Importar";
}

function findProductBySku(sku) {
  const key = String(sku || "").trim().toLowerCase();
  return state.products.find((p) => String(p.sku || "").trim().toLowerCase() === key) || null;
}

function mergeImportedProduct(target, source) {
  ["nombre", "marca", "categoria", "presentacion"].forEach((f) => {
    if (hasValue(source[f])) target[f] = source[f];
  });
  ["descripcion", "dosis", "modoUso", "advertencias"].forEach((f) => {
    if (!hasValue(target[f]) && hasValue(source[f])) target[f] = source[f];
  });
  LIST_FIELDS.forEach((f) => {
    if (!target[f]?.length && source[f]?.length) target[f] = source[f].slice();
  });

  ["costoLlegada", "precioBase"].forEach((f) => {
    const n = Number(source[f]) || 0;
    if (n > 0) target[f] = n;
  });
  const margin = Number(source.margenSugeridoPct);
  if (source._hasImportedMargin && Number.isFinite(margin) && margin > 0) {
    target.margenSugeridoPct = margin;
  }
  if (Array.isArray(source.escalasUnidades) && source.escalasUnidades.length) {
    target.escalasUnidades = source.escalasUnidades
      .map((e) => ({ desde: Number(e.desde) || 0, precio: Number(e.precio) || 0 }))
      .filter((e) => e.desde > 0 && e.precio > 0);
  }

  const currentGallery = Array.isArray(target.imagenesCatalogo) ? target.imagenesCatalogo : [];
  const incomingGallery = Array.isArray(source.imagenesCatalogo) ? source.imagenesCatalogo : [];
  incomingGallery.forEach((url) => {
    const clean = String(url || "").trim();
    if (clean && !currentGallery.includes(clean)) currentGallery.push(clean);
  });
  target.imagenesCatalogo = currentGallery;
  target.imagen = target.imagenesCatalogo[0] || target.imagen || "";
}

function hasValue(value) {
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "number") return Number.isFinite(value) && value !== 0;
  return String(value || "").trim().length > 0;
}

function focusProduct(p) {
  state.search = p.sku || "";
  els.search.value = state.search;
  render();
  focusFirstProduct();
}

function focusFirstProduct() {
  requestAnimationFrame(() => {
    const card = els.editor.querySelector(".edit-card");
    if (!card) return;
    card.scrollIntoView({ behavior: "smooth", block: "center" });
    const input = card.querySelector(".f-nombre") || card.querySelector(".f-sku");
    if (input) input.focus();
  });
}

function importProductErrorMessage(err) {
  const msg = err?.message || String(err);
  if (msg === "not-found") return "No se encontro ese SKU en Neon.";
  if (msg === "missing-sku") return "Escribe un SKU para buscar en Neon.";
  if (msg === "forbidden") return "Tu usuario no tiene permisos para importar desde Neon.";
  if (msg === "unauthorized") return "La sesion expiro. Vuelve a iniciar sesion.";
  return "No se pudo importar desde Neon: " + msg;
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
