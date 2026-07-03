import {
  db, auth, COLLECTION, CLIENTS_COLLECTION,
  collection, getDocs, getDoc, doc, setDoc, query, orderBy,
  signInWithEmailAndPassword, signOut, onAuthStateChanged, getIdTokenResult,
  setPersistence, browserLocalPersistence,
} from "./firebase-config.js?v=20260702-2";
import { money } from "./pricing.js";

const state = {
  client: null,
  products: [],
  rows: [],
  search: "",
  onlyVisible: false,
  dirty: false,
};

const els = {
  login: document.getElementById("login"),
  loginForm: document.getElementById("login-form"),
  loginEmail: document.getElementById("login-email"),
  loginPassword: document.getElementById("login-password"),
  loginError: document.getElementById("login-error"),
  loginSubmit: document.getElementById("login-submit"),
  app: document.getElementById("app"),
  clientName: document.getElementById("client-name"),
  status: document.getElementById("client-status"),
  publicLink: document.getElementById("public-link"),
  copyLink: document.getElementById("copy-link"),
  save: document.getElementById("save"),
  logout: document.getElementById("logout"),
  search: document.getElementById("search"),
  margin: document.getElementById("margin"),
  applyMargin: document.getElementById("apply-margin"),
  onlyVisible: document.getElementById("only-visible"),
  count: document.getElementById("count"),
  products: document.getElementById("products"),
  tpl: document.getElementById("row-tpl"),
  toast: document.getElementById("toast"),
};

bind();
initAuth();

function bind() {
  els.loginForm.addEventListener("submit", handleLogin);
  els.logout.addEventListener("click", () => signOut(auth));
  els.save.addEventListener("click", savePrices);
  els.copyLink.addEventListener("click", copyPublicLink);
  els.search.addEventListener("input", (e) => {
    state.search = e.target.value.trim().toLowerCase();
    render();
  });
  els.onlyVisible.addEventListener("change", () => {
    state.onlyVisible = els.onlyVisible.checked;
    render();
  });
  els.applyMargin.addEventListener("click", applyMargin);
  window.addEventListener("beforeunload", (e) => {
    if (state.dirty) { e.preventDefault(); e.returnValue = ""; }
  });
}

function initAuth() {
  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      showLogin();
      return;
    }

    try {
      const token = await getIdTokenResult(user, true);
      if (token.claims.catalogClient !== true || !token.claims.clientId) {
        await signOut(auth);
        showLogin("Este usuario no tiene permisos de cliente.");
        return;
      }
      await showApp(String(token.claims.clientId));
    } catch (err) {
      await signOut(auth);
      showLogin("No se pudo validar tu sesion.");
    }
  });
}

async function handleLogin(e) {
  e.preventDefault();
  els.loginError.hidden = true;
  els.loginSubmit.disabled = true;
  try {
    await setPersistence(auth, browserLocalPersistence);
    await signInWithEmailAndPassword(auth, els.loginEmail.value.trim(), els.loginPassword.value);
  } catch (err) {
    const messages = {
      "auth/invalid-credential": "Correo o contrasena incorrectos.",
      "auth/invalid-email": "Ingresa un correo valido.",
      "auth/user-not-found": "No existe un cliente con ese correo.",
      "auth/wrong-password": "Contrasena incorrecta.",
      "auth/too-many-requests": "Demasiados intentos. Espera un momento.",
    };
    showLogin(messages[err?.code] || "No se pudo iniciar sesion.");
    els.loginPassword.select();
  } finally {
    els.loginSubmit.disabled = false;
  }
}

function showLogin(error = "") {
  els.app.hidden = true;
  els.login.hidden = false;
  if (error) {
    els.loginError.textContent = error;
    els.loginError.hidden = false;
  }
}

async function showApp(clientId) {
  els.login.hidden = true;
  els.app.hidden = false;
  setStatus("Cargando catalogo...");

  const clientSnap = await getDoc(doc(db, CLIENTS_COLLECTION, clientId));
  if (!clientSnap.exists() || clientSnap.data().activo === false) {
    await signOut(auth);
    showLogin("Tu catalogo no esta activo.");
    return;
  }

  state.client = { id: clientSnap.id, ...clientSnap.data() };
  els.clientName.textContent = state.client.nombre || "Catalogo";
  els.publicLink.href = publicCatalogUrl();
  await loadProducts();
  render();
  state.dirty = false;
  setStatus(`${state.rows.length} productos disponibles · ${publicCatalogUrl()}`);
}

async function loadProducts() {
  let snap;
  try {
    snap = await getDocs(query(collection(db, COLLECTION), orderBy("orden")));
  } catch {
    snap = await getDocs(collection(db, COLLECTION));
  }
  state.products = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

  const priceSnap = await getDocs(collection(db, CLIENTS_COLLECTION, state.client.id, "precios"));
  const prices = new Map(priceSnap.docs.map((d) => [String(d.data().sku || d.id), d.data()]));

  state.rows = state.products.map((product) => {
    const saved = prices.get(product.sku) || {};
    const price = Number(saved.precioBase) || Number(product.precioBase) || 0;
    return {
      product,
      sku: product.sku,
      precioBase: price,
      visible: saved.visible !== false,
      dirty: false,
    };
  });
}

function render() {
  const visibleRows = state.rows.filter((row) => {
    if (state.onlyVisible && !row.visible) return false;
    if (!state.search) return true;
    return [row.product.nombre, row.product.sku, row.product.marca]
      .some((v) => String(v || "").toLowerCase().includes(state.search));
  });

  els.count.textContent = `${visibleRows.length} de ${state.rows.length} productos`;
  els.products.innerHTML = "";
  const frag = document.createDocumentFragment();
  visibleRows.forEach((row) => frag.appendChild(buildRow(row)));
  els.products.appendChild(frag);
}

function buildRow(row) {
  const node = els.tpl.content.firstElementChild.cloneNode(true);
  const img = node.querySelector(".p-img");
  const imageUrl = productImages(row.product)[0];
  if (imageUrl) img.src = imageUrl;
  else img.style.visibility = "hidden";

  node.querySelector(".p-name").textContent = row.product.nombre || row.sku;
  node.querySelector(".p-meta").textContent =
    `${row.sku || ""} · ${row.product.marca || "Sin marca"} · Maestro ${money(row.product.precioBase || 0)}`;

  const price = node.querySelector(".f-price");
  const visible = node.querySelector(".f-visible");
  price.value = row.precioBase || "";
  visible.checked = row.visible;

  price.addEventListener("input", () => {
    row.precioBase = Number(price.value) || 0;
    row.dirty = true;
    markDirty();
  });
  visible.addEventListener("change", () => {
    row.visible = visible.checked;
    row.dirty = true;
    markDirty();
  });
  return node;
}

function applyMargin() {
  const margin = Number(els.margin.value);
  if (!Number.isFinite(margin) || margin < 0) {
    toast("Ingresa un margen valido.", true);
    return;
  }
  state.rows.forEach((row) => {
    if (!row.visible) return;
    const base = Number(row.product.precioBase) || 0;
    if (base <= 0) return;
    row.precioBase = Math.round(base * (1 + margin / 100));
    row.dirty = true;
  });
  markDirty();
  render();
  toast("Margen aplicado. Revisa y guarda precios.");
}

async function savePrices() {
  els.save.disabled = true;
  setStatus("Guardando precios...");
  try {
    for (const row of state.rows) {
      await setDoc(doc(db, CLIENTS_COLLECTION, state.client.id, "precios", docId(row.sku)), {
        sku: row.sku,
        precioBase: Number(row.precioBase) || 0,
        visible: row.visible !== false,
        updatedAt: new Date().toISOString(),
      }, { merge: true });
      row.dirty = false;
    }
    state.dirty = false;
    setStatus(`Guardado · link publico: ${publicCatalogUrl()}`);
    toast("Precios guardados.");
  } catch (err) {
    toast("No se pudieron guardar los precios: " + (err?.code || err), true);
    setStatus("Error al guardar. Revisa tu sesion.");
  } finally {
    els.save.disabled = false;
  }
}

async function copyPublicLink() {
  try {
    await navigator.clipboard.writeText(publicCatalogUrl());
    toast("Link copiado.");
  } catch {
    toast(publicCatalogUrl());
  }
}

function publicCatalogUrl() {
  const url = new URL("index.html", window.location.href);
  url.searchParams.set("cliente", state.client?.slug || state.client?.id || "");
  return url.toString();
}

function setStatus(text) {
  els.status.textContent = text;
}

function markDirty() {
  state.dirty = true;
  setStatus("Cambios sin guardar.");
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

function docId(sku) {
  return String(sku || "").trim().replace(/\//g, "_");
}

let toastTimer = null;
function toast(msg, isError = false) {
  els.toast.textContent = msg;
  els.toast.classList.toggle("toast-error", !!isError);
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { els.toast.hidden = true; }, 3500);
}
