import {
  db, auth, COLLECTION,
  collection, getDocs, doc, setDoc, deleteDoc, query, orderBy,
  signInWithEmailAndPassword, signOut, onAuthStateChanged,
} from "./firebase-config.js";

const TEXT_FIELDS = [
  "nombre", "sku", "marca", "imagen", "categoria",
  "descripcion", "dosis", "modoUso", "advertencias", "presentacion",
];
const LIST_FIELDS = ["beneficios", "ingredientes"];

const state = {
  products: [],
  deleted: new Set(),   // skus originales eliminados (para borrar en Firestore)
  search: "",
  dirty: false,
};
const els = {};

/* ---------------- AUTH ---------------- */
function initAuth() {
  const form = document.getElementById("login-form");
  const email = document.getElementById("login-email");
  const pass = document.getElementById("login-pass");
  const error = document.getElementById("login-error");
  const btn = form.querySelector("button");

  const showError = (msg) => { error.textContent = msg; error.hidden = false; };

  const tryLogin = async (e) => {
    if (e) e.preventDefault();
    error.hidden = true;
    btn.disabled = true;
    try {
      await signInWithEmailAndPassword(auth, email.value.trim(), pass.value);
      // onAuthStateChanged se encarga de mostrar la app.
    } catch (err) {
      const map = {
        "auth/invalid-credential": "Correo o contraseña incorrectos.",
        "auth/invalid-email": "Correo no válido.",
        "auth/user-not-found": "No existe una cuenta con ese correo.",
        "auth/wrong-password": "Contraseña incorrecta.",
        "auth/too-many-requests": "Demasiados intentos. Espera un momento.",
      };
      showError(map[err?.code] || ("No se pudo iniciar sesión: " + (err?.code || err)));
      pass.select();
    } finally {
      btn.disabled = false;
    }
  };

  form.addEventListener("submit", tryLogin);
  btn.addEventListener("click", tryLogin);
  pass.addEventListener("keydown", (e) => { if (e.key === "Enter") tryLogin(e); });

  onAuthStateChanged(auth, (user) => {
    const login = document.getElementById("login");
    const app = document.getElementById("app");
    if (user) {
      login.hidden = true;
      app.hidden = false;
      startApp();
    } else {
      app.hidden = true;
      login.hidden = false;
      email.focus();
    }
  });
}

/* ---------------- APP ---------------- */
let started = false;
async function startApp() {
  if (started) return;       // evita doble init si Auth re-emite
  started = true;
  cacheEls();
  bindToolbar();
  await loadData();
  refreshCategories();
  render();
}

function cacheEls() {
  els.editor = document.getElementById("editor");
  els.tpl = document.getElementById("row-tpl");
  els.escalaTpl = document.getElementById("escala-tpl");
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

async function loadData() {
  setStatus("Cargando desde Firestore…");
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
    toast("No se pudo cargar el catálogo: " + (err?.code || err), true);
  }
  state.dirty = false;
  state.deleted.clear();
  setStatus(`Cargado desde Firestore · ${state.products.length} productos`);
}

function normalizeProduct(p) {
  TEXT_FIELDS.forEach((f) => { if (typeof p[f] !== "string") p[f] = p[f] == null ? "" : String(p[f]); });
  LIST_FIELDS.forEach((f) => { if (!Array.isArray(p[f])) p[f] = []; });
  p.precioBase = Number(p.precioBase) || 0;
  p.escalasUnidades = Array.isArray(p.escalasUnidades)
    ? p.escalasUnidades.map((e) => ({ desde: Number(e.desde) || 0, precio: Number(e.precio) || 0 }))
    : [];
  if (!("_origSku" in p)) p._origSku = p.sku || null;
  return p;
}

/* ---------------- RENDER ---------------- */
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

  // Precio base
  const baseInput = node.querySelector(".f-precioBase");
  baseInput.value = p.precioBase || "";
  baseInput.addEventListener("input", () => { p.precioBase = Number(baseInput.value) || 0; markDirty(); });

  // Escalas
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

  node.querySelector(".btn-del").addEventListener("click", () => {
    const label = p.nombre || p.sku || "este producto";
    if (!confirm(`¿Eliminar "${label}" del catálogo?`)) return;
    if (p._origSku) state.deleted.add(p._origSku);
    const i = state.products.indexOf(p);
    if (i >= 0) state.products.splice(i, 1);
    markDirty();
    refreshCategories();
    render();
  });

  return node;
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

/* ---------------- ACCIONES ---------------- */
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
    if (seen.has(key)) return `SKU duplicado: "${sku}". Cada producto necesita un SKU único.`;
    seen.add(key);
  }
  return null;
}

function docId(sku) { return sku.trim().replace(/\//g, "_"); }

/** Limpia el objeto producto para Firestore (sin campos internos). */
function toFirestore(p, orden) {
  const out = { orden };
  TEXT_FIELDS.forEach((f) => { out[f] = p[f] || ""; });
  LIST_FIELDS.forEach((f) => { out[f] = Array.isArray(p[f]) ? p[f] : []; });
  out.precioBase = Number(p.precioBase) || 0;
  out.escalasUnidades = (p.escalasUnidades || [])
    .map((e) => ({ desde: Number(e.desde) || 0, precio: Number(e.precio) || 0 }))
    .filter((e) => e.desde > 0 && e.precio > 0);
  return out;
}

async function save() {
  const err = validate();
  if (err) { toast(err, true); return; }

  setStatus("Guardando en Firestore…");
  try {
    // 1) Escribe / actualiza cada producto.
    for (let i = 0; i < state.products.length; i++) {
      const p = state.products[i];
      const id = docId(p.sku);
      await setDoc(doc(db, COLLECTION, id), toFirestore(p, i));
      // Si renombraron el SKU, borra el documento viejo.
      if (p._origSku && docId(p._origSku) !== id) {
        await deleteDoc(doc(db, COLLECTION, docId(p._origSku)));
      }
      p._origSku = p.sku;
    }
    // 2) Borra los eliminados (que no se hayan recreado con el mismo SKU).
    const vivos = new Set(state.products.map((p) => docId(p.sku)));
    for (const origSku of state.deleted) {
      const id = docId(origSku);
      if (!vivos.has(id)) await deleteDoc(doc(db, COLLECTION, id));
    }
    state.deleted.clear();
    state.dirty = false;
    setStatus(`Guardado en Firestore · ${state.products.length} productos`);
    toast("Cambios guardados ✓ Ya están en vivo en el catálogo.");
  } catch (e) {
    toast("Error al guardar: " + (e?.code || e), true);
    setStatus("Error al guardar. Revisa tu sesión y vuelve a intentar.");
  }
}

/* ---------------- UI HELPERS ---------------- */
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
