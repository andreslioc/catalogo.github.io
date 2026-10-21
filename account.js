// Cuentas de comprador: sesión, perfil (nombre / documento / teléfono),
// direcciones de envío (máx. 5) y pedidos. Lo usan el catálogo (index.html)
// y la página de cuenta (cuenta.html).
//
// Perfil:  compradores/{uid}  { nombre, tipoDocumento, documento, telefono, email,
//                               proveedor, aceptaDatos, direcciones[], direccionPredeterminada }
// Pedidos: pedidos/{id}       solo los escribe la Function createCatalogOrder.
import {
  db, auth, BUYERS_COLLECTION, ORDERS_COLLECTION, CATALOG_ORDER_ENDPOINT,
  collection, getDocs, getDoc, doc, setDoc, query, orderBy, where, limit, serverTimestamp,
  onAuthStateChanged, signOut, setPersistence, browserLocalPersistence,
  GoogleAuthProvider, signInWithPopup, signInWithRedirect, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, sendPasswordResetEmail, updateProfile,
} from "./firebase-config.js?v=20261020-1";

export const MAX_ADDRESSES = 5;

export const DOCUMENT_TYPES = [
  { value: "CC", label: "Cédula de ciudadanía" },
  { value: "CE", label: "Cédula de extranjería" },
  { value: "NIT", label: "NIT" },
  { value: "PP", label: "Pasaporte" },
  { value: "PPT", label: "Permiso por protección temporal" },
];

// Estados del pedido tal como los ve el cliente. `error_envio` es interno
// (Nexus no respondió y se reintenta), así que se muestra como "Recibido".
export const ORDER_STATUS = {
  pendiente: { label: "Recibido", tone: "info" },
  error_envio: { label: "Recibido", tone: "info" },
  borrador: { label: "En revisión", tone: "info" },
  confirmado: { label: "Confirmado", tone: "ok" },
  facturado: { label: "Facturado", tone: "ok" },
  despachado: { label: "Despachado", tone: "ok" },
  cancelado: { label: "Cancelado", tone: "bad" },
};

/* ---------------- Sesión ---------------- */

export function onUser(callback) {
  return onAuthStateChanged(auth, callback);
}

export function currentUser() {
  return auth.currentUser;
}

export function logout() {
  return signOut(auth);
}

async function signInGoogle() {
  await setPersistence(auth, browserLocalPersistence);
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });
  try {
    return (await signInWithPopup(auth, provider)).user;
  } catch (err) {
    // Algunos navegadores móviles bloquean el popup: se cae a redirect y
    // onAuthStateChanged recoge la sesión al volver.
    if (err?.code === "auth/popup-blocked") {
      await signInWithRedirect(auth, provider);
      return null;
    }
    throw err;
  }
}

async function signInEmail(email, password) {
  await setPersistence(auth, browserLocalPersistence);
  return (await signInWithEmailAndPassword(auth, email, password)).user;
}

async function signUpEmail(nombre, email, password) {
  await setPersistence(auth, browserLocalPersistence);
  const { user } = await createUserWithEmailAndPassword(auth, email, password);
  if (nombre) await updateProfile(user, { displayName: nombre });
  return user;
}

const AUTH_ERRORS = {
  "auth/invalid-credential": "Correo o contraseña incorrectos.",
  "auth/wrong-password": "Correo o contraseña incorrectos.",
  "auth/user-not-found": "No existe una cuenta con ese correo.",
  "auth/invalid-email": "Ingresa un correo válido.",
  "auth/email-already-in-use": "Ya existe una cuenta con ese correo. Inicia sesión.",
  "auth/weak-password": "La contraseña debe tener al menos 6 caracteres.",
  "auth/too-many-requests": "Demasiados intentos. Espera un momento.",
  "auth/network-request-failed": "Sin conexión. Revisa tu internet.",
  "auth/unauthorized-domain": "Este dominio no está autorizado para iniciar sesión.",
  "auth/operation-not-allowed": "Este método de acceso no está habilitado.",
  "auth/account-exists-with-different-credential": "Ese correo ya está registrado con otro método de acceso.",
};

function authErrorMessage(err) {
  return AUTH_ERRORS[err?.code] || "No se pudo iniciar sesión. Intenta de nuevo.";
}

/* ---------------- Perfil y direcciones ---------------- */

export async function loadProfile(user) {
  const snap = await getDoc(doc(db, BUYERS_COLLECTION, user.uid));
  const data = snap.exists() ? snap.data() : {};
  return {
    nombre: data.nombre || user.displayName || "",
    tipoDocumento: data.tipoDocumento || "CC",
    documento: data.documento || "",
    telefono: data.telefono || "",
    email: data.email || user.email || "",
    aceptaDatos: data.aceptaDatos || null,
    direcciones: Array.isArray(data.direcciones) ? data.direcciones : [],
    direccionPredeterminada: data.direccionPredeterminada || "",
    _exists: snap.exists(),
  };
}

export function isProfileComplete(profile) {
  return !!(profile && profile._exists && profile.nombre && profile.documento
    && profile.telefono && profile.aceptaDatos?.acepta);
}

async function writeProfile(user, profile, patch) {
  const next = { ...profile, ...patch };
  const data = {
    nombre: next.nombre,
    tipoDocumento: next.tipoDocumento,
    documento: next.documento,
    telefono: next.telefono,
    email: user.email || next.email || "",
    proveedor: user.providerData?.some((p) => p.providerId === "google.com") ? "google" : "password",
    aceptaDatos: next.aceptaDatos,
    direcciones: next.direcciones,
    direccionPredeterminada: next.direccionPredeterminada || "",
    actualizado: serverTimestamp(),
  };
  if (!profile._exists) data.creado = serverTimestamp();
  await setDoc(doc(db, BUYERS_COLLECTION, user.uid), data, { merge: true });
  return { ...next, email: data.email, _exists: true };
}

export async function deleteAddress(user, profile, id) {
  const direcciones = profile.direcciones.filter((a) => a.id !== id);
  const direccionPredeterminada = profile.direccionPredeterminada === id
    ? (direcciones[0]?.id || "")
    : profile.direccionPredeterminada;
  return writeProfile(user, profile, { direcciones, direccionPredeterminada });
}

export async function setDefaultAddress(user, profile, id) {
  return writeProfile(user, profile, { direccionPredeterminada: id });
}

// Dirección a preseleccionar: la predeterminada si sigue existiendo, si no la primera.
export function defaultAddressId(profile) {
  const list = profile?.direcciones || [];
  if (list.some((a) => a.id === profile.direccionPredeterminada)) return profile.direccionPredeterminada;
  return list[0]?.id || "";
}

export function formatAddress(a) {
  if (!a) return "";
  return [a.direccion, a.ciudad?.nombre, a.departamento?.nombre]
    .filter(Boolean)
    .filter((v, i, arr) => arr.indexOf(v) === i) // "Bogotá D.C., Bogotá D.C." -> una vez
    .join(", ");
}

/* ---------------- Departamentos y ciudades (DIVIPOLA) ---------------- */

let colombiaPromise = null;
export function loadColombia() {
  if (!colombiaPromise) {
    colombiaPromise = fetch("colombia.json?v=20261020-1")
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .catch((err) => {
        colombiaPromise = null;
        throw err;
      });
  }
  return colombiaPromise;
}

/* ---------------- Pedidos ---------------- */

export async function listMyOrders(user, max = 50) {
  const q = query(
    collection(db, ORDERS_COLLECTION),
    where("uid", "==", user.uid),
    orderBy("creado", "desc"),
    limit(max),
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

// items: [{ sku, qty }]. El servidor recalcula precios, descuento y stock.
export async function createOrder(user, { items, clienteSlug, direccionId, notas }) {
  const token = await user.getIdToken();
  const res = await fetch(CATALOG_ORDER_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ items, clienteSlug, direccionId, notas }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(new Error(data?.error || `HTTP ${res.status}`), {
      status: res.status,
      details: data,
    });
  }
  return data.pedido;
}

export function orderErrorMessage(err) {
  const map = {
    "profile-incomplete": "Completa tus datos antes de finalizar.",
    "address-not-found": "La dirección elegida ya no existe. Selecciona otra.",
    "insufficient-stock": "Algunos productos no tienen unidades suficientes. Ajusta las cantidades.",
    "product-unavailable": "Algunos productos ya no están disponibles en el catálogo.",
    "too-many-requests": "Acabas de enviar un pedido. Espera unos segundos antes de enviar otro.",
    "catalog-unavailable": "Este catálogo no está disponible.",
    unauthorized: "Tu sesión expiró. Vuelve a iniciar sesión.",
  };
  return map[err?.message] || "No se pudo registrar el pedido. Intenta de nuevo.";
}

export function orderDate(order) {
  const v = order?.creado;
  if (v?.toDate) return v.toDate();
  if (typeof v === "string") return new Date(v);
  return new Date();
}

/* ---------------- Validación ---------------- */

function cleanText(v, max = 160) {
  return String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

// Celular (3xx xxx xxxx) o fijo (60x xxx xxxx). Acepta +57 y separadores.
export function normalizePhone(v) {
  let digits = String(v || "").replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("57")) digits = digits.slice(2);
  return /^(3\d{9}|60\d{8})$/.test(digits) ? digits : "";
}

export function normalizeDocument(tipo, v) {
  const raw = String(v || "").toUpperCase().replace(/[\s.]/g, "");
  if (tipo === "CC") return /^\d{5,10}$/.test(raw) ? raw : "";
  if (tipo === "NIT") return /^\d{8,10}(-\d)?$/.test(raw) ? raw : "";
  return /^[A-Z0-9-]{4,16}$/.test(raw) ? raw : "";
}

/* ---------------- Diálogos ---------------- */

function escapeHtml(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Monta un diálogo modal y devuelve { root, close }. `onClose` recibe el valor
// con el que se cerró (undefined si el usuario lo cerró sin terminar).
function mountDialog(title, bodyHtml, onClose) {
  const root = document.createElement("div");
  root.className = "acc-dialog";
  root.innerHTML = `
    <div class="acc-dialog-backdrop" data-acc-close></div>
    <div class="acc-dialog-card" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
      <button class="acc-dialog-close" type="button" data-acc-close aria-label="Cerrar">&times;</button>
      <h2>${escapeHtml(title)}</h2>
      ${bodyHtml}
    </div>`;
  const prevOverflow = document.body.style.overflow;
  document.body.style.overflow = "hidden";
  let closed = false;
  const close = (value) => {
    if (closed) return;
    closed = true;
    document.removeEventListener("keydown", onKey, true);
    root.remove();
    document.body.style.overflow = prevOverflow;
    onClose(value);
  };
  const onKey = (e) => {
    if (e.key === "Escape") { e.stopPropagation(); close(undefined); }
  };
  root.addEventListener("click", (e) => {
    if (e.target.hasAttribute("data-acc-close")) close(undefined);
  });
  document.addEventListener("keydown", onKey, true);
  document.body.appendChild(root);
  return { root, close };
}

function showError(el, msg) {
  el.textContent = msg || "";
  el.hidden = !msg;
}

/**
 * Inicio de sesión / registro. Resuelve con el usuario, o null si se cancela.
 * `reason` es un texto opcional sobre por qué se pide la cuenta.
 */
export function openAuthDialog({ reason = "", mode = "login" } = {}) {
  return new Promise((resolve) => {
    const { root, close } = mountDialog("Tu cuenta", `
      ${reason ? `<p class="acc-lead">${escapeHtml(reason)}</p>` : ""}
      <div class="acc-tabs" role="tablist">
        <button type="button" role="tab" data-tab="login">Iniciar sesión</button>
        <button type="button" role="tab" data-tab="signup">Crear cuenta</button>
      </div>
      <button type="button" class="acc-google" data-google>
        <svg viewBox="0 0 48 48" width="18" height="18" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9 3.6l6.7-6.7C35.6 2.4 30.2 0 24 0 14.6 0 6.6 5.4 2.7 13.2l7.8 6.1C12.4 13.6 17.7 9.5 24 9.5z"/><path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.5 5.8c4.4-4.1 7.1-10.1 7.1-17.5z"/><path fill="#FBBC05" d="M10.5 28.7c-.5-1.4-.8-3-.8-4.7s.3-3.3.8-4.7l-7.8-6.1C1 16.5 0 20.1 0 24s1 7.5 2.7 10.8l7.8-6.1z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.5-5.8c-2.1 1.4-4.9 2.3-8.4 2.3-6.3 0-11.6-4.1-13.5-9.8l-7.8 6.1C6.6 42.6 14.6 48 24 48z"/></svg>
        Continuar con Google
      </button>
      <div class="acc-sep"><span>o con tu correo</span></div>
      <form class="acc-form" data-form="login" novalidate>
        <label><span>Correo</span><input name="email" type="email" autocomplete="email" required /></label>
        <label><span>Contraseña</span><input name="password" type="password" autocomplete="current-password" required /></label>
        <button type="button" class="acc-link" data-reset>¿Olvidaste tu contraseña?</button>
        <button type="submit" class="acc-primary">Iniciar sesión</button>
      </form>
      <form class="acc-form" data-form="signup" novalidate hidden>
        <label><span>Nombre completo</span><input name="nombre" type="text" autocomplete="name" required maxlength="120" /></label>
        <label><span>Correo</span><input name="email" type="email" autocomplete="email" required /></label>
        <label><span>Contraseña</span><input name="password" type="password" autocomplete="new-password" minlength="6" required placeholder="Mínimo 6 caracteres" /></label>
        <button type="submit" class="acc-primary">Crear cuenta</button>
      </form>
      <p class="acc-error" role="alert" hidden></p>
      <p class="acc-ok" role="status" hidden></p>`, (value) => resolve(value || null));

    const errorEl = root.querySelector(".acc-error");
    const okEl = root.querySelector(".acc-ok");
    const forms = {
      login: root.querySelector('[data-form="login"]'),
      signup: root.querySelector('[data-form="signup"]'),
    };
    const setMode = (m) => {
      root.querySelectorAll("[data-tab]").forEach((b) => {
        const on = b.dataset.tab === m;
        b.classList.toggle("active", on);
        b.setAttribute("aria-selected", String(on));
      });
      forms.login.hidden = m !== "login";
      forms.signup.hidden = m !== "signup";
      showError(errorEl, "");
      showError(okEl, "");
      setTimeout(() => forms[m].querySelector("input")?.focus(), 0);
    };
    root.querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.tab)));
    setMode(mode);

    const busy = (on) => root.querySelectorAll("button, input").forEach((el) => {
      if (!el.hasAttribute("data-acc-close")) el.disabled = on;
    });
    const run = async (fn) => {
      showError(errorEl, "");
      showError(okEl, "");
      busy(true);
      try {
        const user = await fn();
        if (user) close(user);
      } catch (err) {
        if (err?.code !== "auth/popup-closed-by-user" && err?.code !== "auth/cancelled-popup-request") {
          showError(errorEl, err?.userMessage || authErrorMessage(err));
        }
      } finally {
        busy(false);
      }
    };

    root.querySelector("[data-google]").addEventListener("click", () => run(signInGoogle));
    forms.login.addEventListener("submit", (e) => {
      e.preventDefault();
      const f = new FormData(forms.login);
      run(() => signInEmail(String(f.get("email")).trim(), String(f.get("password"))));
    });
    forms.signup.addEventListener("submit", (e) => {
      e.preventDefault();
      const f = new FormData(forms.signup);
      const nombre = cleanText(f.get("nombre"), 120);
      run(() => {
        if (nombre.length < 3) throw Object.assign(new Error(), { userMessage: "Escribe tu nombre completo." });
        return signUpEmail(nombre, String(f.get("email")).trim(), String(f.get("password")));
      });
    });
    root.querySelector("[data-reset]").addEventListener("click", async () => {
      const email = String(new FormData(forms.login).get("email") || "").trim();
      if (!email) { showError(errorEl, "Escribe tu correo y vuelve a pulsar “¿Olvidaste tu contraseña?”."); return; }
      try {
        await sendPasswordResetEmail(auth, email);
        showError(errorEl, "");
        showError(okEl, "Si el correo tiene cuenta, te enviamos un enlace para restablecer la contraseña.");
      } catch (err) {
        showError(errorEl, authErrorMessage(err));
      }
    });
  });
}

/**
 * Datos básicos: nombre, documento, teléfono y autorización de datos.
 * Resuelve con el perfil guardado, o null si se cancela.
 */
export function openProfileDialog(user, profile, { reason = "" } = {}) {
  return new Promise((resolve) => {
    const needsConsent = !profile.aceptaDatos?.acepta;
    const docOptions = DOCUMENT_TYPES.map((t) =>
      `<option value="${t.value}" ${t.value === profile.tipoDocumento ? "selected" : ""}>${escapeHtml(t.label)}</option>`).join("");
    const { root, close } = mountDialog("Tus datos", `
      <p class="acc-lead">${escapeHtml(reason || "Los guardamos en tu cuenta para tus próximos pedidos.")}</p>
      <form class="acc-form" novalidate>
        <label><span>Nombre completo</span><input name="nombre" type="text" autocomplete="name" maxlength="120" required value="${escapeHtml(profile.nombre)}" /></label>
        <div class="acc-row">
          <label class="acc-col-sm"><span>Tipo</span><select name="tipoDocumento">${docOptions}</select></label>
          <label><span>Documento / cédula</span><input name="documento" type="text" inputmode="numeric" maxlength="16" required value="${escapeHtml(profile.documento)}" /></label>
        </div>
        <label><span>Tel / celular</span><input name="telefono" type="tel" inputmode="tel" autocomplete="tel-national" maxlength="16" required placeholder="3001234567" value="${escapeHtml(profile.telefono)}" /></label>
        ${needsConsent ? `
        <label class="acc-check">
          <input name="acepta" type="checkbox" />
          <span>Autorizo el tratamiento de mis datos personales para gestionar mis pedidos, la facturación y el envío (Ley 1581 de 2012).</span>
        </label>` : ""}
        <p class="acc-error" role="alert" hidden></p>
        <button type="submit" class="acc-primary">Guardar datos</button>
      </form>`, (value) => resolve(value || null));

    const form = root.querySelector("form");
    const errorEl = root.querySelector(".acc-error");
    setTimeout(() => form.querySelector(profile.nombre ? '[name="documento"]' : '[name="nombre"]')?.focus(), 0);

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = new FormData(form);
      const nombre = cleanText(f.get("nombre"), 120);
      const tipoDocumento = String(f.get("tipoDocumento") || "CC");
      const documento = normalizeDocument(tipoDocumento, f.get("documento"));
      const telefono = normalizePhone(f.get("telefono"));
      if (nombre.length < 3) return showError(errorEl, "Escribe tu nombre completo.");
      if (!documento) {
        return showError(errorEl, tipoDocumento === "NIT"
          ? "Revisa el NIT: 8 a 10 dígitos, con dígito de verificación opcional (900123456-7)."
          : "Revisa el número de documento.");
      }
      if (!telefono) return showError(errorEl, "Revisa el teléfono: 10 dígitos, celular (3…) o fijo (60…).");
      if (needsConsent && !f.get("acepta")) return showError(errorEl, "Debes autorizar el tratamiento de datos para continuar.");

      showError(errorEl, "");
      const btn = form.querySelector('[type="submit"]');
      btn.disabled = true;
      try {
        const aceptaDatos = needsConsent ? { acepta: true, fecha: new Date().toISOString() } : profile.aceptaDatos;
        close(await writeProfile(user, profile, { nombre, tipoDocumento, documento, telefono, aceptaDatos }));
      } catch (err) {
        console.error("[profile]", err);
        showError(errorEl, "No se pudieron guardar tus datos. Intenta de nuevo.");
        btn.disabled = false;
      }
    });
  });
}

/**
 * Crear o editar una dirección. `address` null = nueva.
 * Resuelve con { profile, id } guardados, o null si se cancela.
 */
export function openAddressDialog(user, profile, address = null) {
  return new Promise((resolve) => {
    const isNew = !address;
    const a = address || {};
    const isOnlyOne = isNew ? profile.direcciones.length === 0 : profile.direcciones.length === 1;
    const isDefault = !isNew && profile.direccionPredeterminada === a.id;
    const { root, close } = mountDialog(isNew ? "Nueva dirección" : "Editar dirección", `
      <form class="acc-form" novalidate>
        <label><span>Nombre de la dirección <em>(opcional)</em></span><input name="alias" type="text" maxlength="30" placeholder="Casa, Oficina, Bodega…" value="${escapeHtml(a.alias)}" /></label>
        <label><span>Dirección</span><input name="direccion" type="text" autocomplete="street-address" maxlength="160" required placeholder="Cra 7 # 45-12 apto 301" value="${escapeHtml(a.direccion)}" /></label>
        <label><span>Departamento</span><select name="departamento" required><option value="">Cargando…</option></select></label>
        <label><span>Ciudad</span><select name="ciudad" required disabled><option value="">Primero elige departamento</option></select></label>
        <label><span>Indicaciones <em>(opcional)</em></span><input name="indicaciones" type="text" maxlength="160" placeholder="Barrio, portería, punto de referencia…" value="${escapeHtml(a.indicaciones)}" /></label>
        ${isOnlyOne ? "" : `
        <label class="acc-check">
          <input name="predeterminada" type="checkbox" ${isDefault ? "checked" : ""} />
          <span>Usar como dirección predeterminada</span>
        </label>`}
        <p class="acc-error" role="alert" hidden></p>
        <button type="submit" class="acc-primary">Guardar dirección</button>
      </form>`, (value) => resolve(value || null));

    const form = root.querySelector("form");
    const errorEl = root.querySelector(".acc-error");
    const depSel = form.elements.departamento;
    const citySel = form.elements.ciudad;
    let departamentos = [];

    const fillCities = (depCode, selected = "") => {
      const dep = departamentos.find((d) => d.codigo === depCode);
      if (!dep) {
        citySel.innerHTML = '<option value="">Primero elige departamento</option>';
        citySel.disabled = true;
        return;
      }
      citySel.innerHTML = '<option value="">Seleccionar ciudad…</option>' + dep.ciudades
        .map((c) => `<option value="${c.codigo}" ${c.codigo === selected ? "selected" : ""}>${escapeHtml(c.nombre)}</option>`).join("");
      citySel.disabled = false;
      // Departamentos de una sola ciudad (Bogotá D.C.): se preselecciona.
      if (dep.ciudades.length === 1) citySel.value = dep.ciudades[0].codigo;
    };

    loadColombia().then((list) => {
      departamentos = list;
      depSel.innerHTML = '<option value="">Seleccionar departamento…</option>' + list
        .map((d) => `<option value="${d.codigo}" ${d.codigo === a.departamento?.codigo ? "selected" : ""}>${escapeHtml(d.nombre)}</option>`).join("");
      fillCities(depSel.value, a.ciudad?.codigo || "");
    }).catch((err) => {
      console.error("[colombia]", err);
      depSel.innerHTML = '<option value="">No se pudo cargar la lista</option>';
      showError(errorEl, "No se pudo cargar la lista de departamentos. Recarga la página.");
    });
    depSel.addEventListener("change", () => fillCities(depSel.value));
    setTimeout(() => form.elements.direccion.focus(), 0);

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const direccion = cleanText(form.elements.direccion.value, 160);
      const dep = departamentos.find((d) => d.codigo === depSel.value);
      const city = dep?.ciudades.find((c) => c.codigo === citySel.value);
      if (direccion.length < 5) return showError(errorEl, "Escribe la dirección completa.");
      if (!dep) return showError(errorEl, "Selecciona el departamento.");
      if (!city) return showError(errorEl, "Selecciona la ciudad.");
      if (isNew && profile.direcciones.length >= MAX_ADDRESSES) {
        return showError(errorEl, `Puedes guardar máximo ${MAX_ADDRESSES} direcciones. Borra una para agregar otra.`);
      }

      const id = a.id || `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      const entry = {
        id,
        alias: cleanText(form.elements.alias.value, 30),
        direccion,
        departamento: { codigo: dep.codigo, nombre: dep.nombre },
        ciudad: { codigo: city.codigo, nombre: city.nombre },
        indicaciones: cleanText(form.elements.indicaciones.value, 160),
      };
      const direcciones = isNew
        ? [...profile.direcciones, entry]
        : profile.direcciones.map((x) => (x.id === id ? entry : x));
      const wantsDefault = isOnlyOne || form.elements.predeterminada?.checked;
      let direccionPredeterminada = profile.direccionPredeterminada;
      if (wantsDefault) direccionPredeterminada = id;
      else if (direccionPredeterminada === id) direccionPredeterminada = "";

      showError(errorEl, "");
      const btn = form.querySelector('[type="submit"]');
      btn.disabled = true;
      try {
        const saved = await writeProfile(user, profile, { direcciones, direccionPredeterminada });
        close({ profile: saved, id });
      } catch (err) {
        console.error("[address]", err);
        showError(errorEl, "No se pudo guardar la dirección. Intenta de nuevo.");
        btn.disabled = false;
      }
    });
  });
}

/**
 * Lista de direcciones con Editar / Borrar y "+ Agregar nueva dirección".
 * Con `selectable`, cada tarjeta es un radio y `onSelect(id)` avisa la elegida.
 * `onChange(profile, newId?)` se llama tras guardar o borrar.
 */
export function renderAddressList(container, user, profile, {
  selectable = false, selectedId = "", onSelect = () => {}, onChange = () => {},
} = {}) {
  const list = profile.direcciones;
  const name = `addr-${Math.random().toString(36).slice(2, 8)}`;
  container.innerHTML = `
    <div class="acc-addr-list">
      ${list.map((a) => `
        <div class="acc-addr ${selectable && a.id === selectedId ? "is-selected" : ""}" data-id="${escapeHtml(a.id)}">
          ${selectable
            ? `<label class="acc-addr-main"><input type="radio" name="${name}" value="${escapeHtml(a.id)}" ${a.id === selectedId ? "checked" : ""} />`
            : '<div class="acc-addr-main">'}
            <span class="acc-addr-text">
              <strong>${escapeHtml(a.alias || a.ciudad?.nombre || "Dirección")}${profile.direccionPredeterminada === a.id ? ' <span class="acc-tag">Predeterminada</span>' : ""}</strong>
              <span>${escapeHtml(formatAddress(a))}</span>
              ${a.indicaciones ? `<span class="acc-muted">${escapeHtml(a.indicaciones)}</span>` : ""}
            </span>
          ${selectable ? "</label>" : "</div>"}
          <div class="acc-addr-actions">
            ${!selectable && profile.direccionPredeterminada !== a.id ? '<button type="button" class="acc-link" data-default>Hacer predeterminada</button>' : ""}
            <button type="button" class="acc-link" data-edit>Editar</button>
            <button type="button" class="acc-link acc-danger" data-del>Borrar</button>
          </div>
        </div>`).join("")}
      ${list.length < MAX_ADDRESSES ? `
        <button type="button" class="acc-addr-add" data-add>
          <span aria-hidden="true">+</span> Agregar nueva dirección
        </button>` : `<p class="acc-muted acc-addr-max">Tienes ${MAX_ADDRESSES} direcciones, el máximo. Borra una para agregar otra.</p>`}
    </div>`;

  container.querySelectorAll('input[type="radio"]').forEach((r) =>
    r.addEventListener("change", () => onSelect(r.value)));
  container.querySelector("[data-add]")?.addEventListener("click", async () => {
    const res = await openAddressDialog(user, profile, null);
    if (res) onChange(res.profile, res.id);
  });
  container.querySelectorAll(".acc-addr").forEach((card) => {
    const id = card.dataset.id;
    const addr = list.find((a) => a.id === id);
    card.querySelector("[data-edit]").addEventListener("click", async () => {
      const res = await openAddressDialog(user, profile, addr);
      if (res) onChange(res.profile, res.id);
    });
    card.querySelector("[data-del]").addEventListener("click", async () => {
      if (!confirm(`¿Borrar la dirección "${addr.alias || formatAddress(addr)}"?`)) return;
      try {
        onChange(await deleteAddress(user, profile, id));
      } catch (err) {
        console.error("[address-delete]", err);
        alert("No se pudo borrar la dirección.");
      }
    });
    card.querySelector("[data-default]")?.addEventListener("click", async () => {
      try {
        onChange(await setDefaultAddress(user, profile, id));
      } catch (err) {
        console.error("[address-default]", err);
      }
    });
  });
}
