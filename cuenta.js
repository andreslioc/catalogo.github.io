// Página "Mi cuenta": datos del comprador, direcciones (máx. 5) e historial de pedidos.
import { money } from "./pricing.js";
import {
  onUser, logout, loadProfile, isProfileComplete, renderAddressList, openAuthDialog,
  openProfileDialog, listMyOrders, orderDate, formatAddress, DOCUMENT_TYPES, ORDER_STATUS, MAX_ADDRESSES,
} from "./account.js?v=20261020-1";
import { downloadQuotePdf } from "./quote-pdf.js?v=20261020-1";

const els = {
  loading: document.getElementById("acct-loading"),
  guest: document.getElementById("acct-guest"),
  content: document.getElementById("acct-content"),
  logout: document.getElementById("acct-logout"),
  profile: document.getElementById("acct-profile"),
  editProfile: document.getElementById("acct-edit-profile"),
  addresses: document.getElementById("acct-addresses"),
  dirCount: document.getElementById("acct-dir-count"),
  orders: document.getElementById("acct-orders"),
};

const state = { user: null, profile: null, orders: [] };

document.getElementById("acct-login").addEventListener("click", () => openAuthDialog({ mode: "login" }));
document.getElementById("acct-signup").addEventListener("click", () => openAuthDialog({ mode: "signup" }));
els.logout.addEventListener("click", () => logout());
els.editProfile.addEventListener("click", editProfile);

onUser(async (user) => {
  state.user = user || null;
  state.profile = null;
  state.orders = [];
  els.logout.hidden = !user;
  if (!user) {
    els.loading.hidden = true;
    els.content.hidden = true;
    els.guest.hidden = false;
    return;
  }
  els.guest.hidden = true;
  els.loading.hidden = false;
  try {
    state.profile = await loadProfile(user);
  } catch (err) {
    console.error("[profile]", err);
    els.loading.textContent = "No se pudo cargar tu cuenta. Recarga la página.";
    return;
  }
  if (state.user?.uid !== user.uid) return;
  els.loading.hidden = true;
  els.content.hidden = false;
  renderProfile();
  renderAddresses();
  loadOrders();
  // Cuenta nueva (o creada con Google): se piden los datos básicos una vez.
  if (!isProfileComplete(state.profile)) editProfile();
});

async function editProfile() {
  if (!state.user || !state.profile) return;
  const saved = await openProfileDialog(state.user, state.profile);
  if (saved) {
    state.profile = saved;
    renderProfile();
  }
}

function renderProfile() {
  const p = state.profile;
  const docLabel = DOCUMENT_TYPES.find((t) => t.value === p.tipoDocumento)?.label || p.tipoDocumento;
  const rows = [
    ["Nombre", p.nombre],
    ["Documento", p.documento ? `${docLabel} · ${p.documento}` : ""],
    ["Tel / celular", p.telefono],
    ["Correo", p.email || state.user.email],
  ];
  els.profile.innerHTML = rows.map(([k, v]) => `
    <div><dt>${k}</dt><dd>${v ? escapeHtml(v) : '<span class="acct-missing">Sin completar</span>'}</dd></div>`).join("");
  els.editProfile.textContent = isProfileComplete(p) ? "Editar" : "Completar datos";
}

function renderAddresses() {
  const p = state.profile;
  els.dirCount.textContent = `${p.direcciones.length} de ${MAX_ADDRESSES}`;
  renderAddressList(els.addresses, state.user, p, {
    onChange: (profile) => {
      state.profile = profile;
      renderAddresses();
    },
  });
}

async function loadOrders() {
  els.orders.innerHTML = '<p class="acc-muted">Cargando pedidos…</p>';
  try {
    state.orders = await listMyOrders(state.user);
  } catch (err) {
    console.error("[orders]", err);
    els.orders.innerHTML = '<p class="acc-muted">No se pudieron cargar tus pedidos.</p>';
    return;
  }
  renderOrders();
}

function renderOrders() {
  if (!state.orders.length) {
    els.orders.innerHTML = `
      <div class="acct-empty">
        <p>Aún no tienes pedidos.</p>
        <a class="btn-link" href="index.html">Ir al catálogo</a>
      </div>`;
    return;
  }
  els.orders.innerHTML = state.orders.map((o) => {
    const status = ORDER_STATUS[o.estado] || ORDER_STATUS.pendiente;
    const date = orderDate(o).toLocaleDateString("es-CO", { year: "numeric", month: "short", day: "numeric" });
    const units = (o.lineas || []).reduce((n, l) => n + (Number(l.cantidad) || 0), 0);
    return `
      <details class="acct-order" data-id="${escapeHtml(o.id)}">
        <summary>
          <span class="acct-order-main">
            <strong>${escapeHtml(o.numero || o.id)}</strong>
            <span class="acc-muted">${date} · ${units} ${units === 1 ? "unidad" : "unidades"}</span>
          </span>
          <span class="acct-status acct-status-${status.tone}">${status.label}</span>
          <span class="acct-order-total">${money(o.totales?.total)}</span>
        </summary>
        <div class="acct-order-body">
          ${o.envio ? `<p class="acct-order-ship"><strong>Enviar a:</strong> ${escapeHtml(formatAddress(o.envio))}${o.envio.indicaciones ? ` · ${escapeHtml(o.envio.indicaciones)}` : ""}</p>` : ""}
          <ul class="acct-lines">
            ${(o.lineas || []).map((l) => `
              <li>
                <span class="acct-line-img">${l.imagen ? `<img src="${escapeHtml(l.imagen)}" alt="" loading="lazy" />` : ""}</span>
                <span class="acct-line-name">${escapeHtml(l.nombre || l.sku)}<small>SKU ${escapeHtml(l.sku)} · ${l.cantidad} × ${money(l.precioUnit)}</small></span>
                <span class="acct-line-total">${money(l.subtotal)}</span>
              </li>`).join("")}
          </ul>
          <div class="acct-order-totals">
            ${o.totales?.descuento > 0 ? `
              <div><span>Subtotal</span><span>${money(o.totales.subtotal)}</span></div>
              <div class="acct-discount"><span>Descuento mayorista ${o.totales.descuentoPct}%</span><span>-${money(o.totales.descuento)}</span></div>` : ""}
            <div class="acct-total"><span>Total</span><span>${money(o.totales?.total)}</span></div>
          </div>
          ${o.notas ? `<p class="acc-muted">Notas: ${escapeHtml(o.notas)}</p>` : ""}
          <button type="button" class="btn-ghost-brand" data-pdf>Descargar orden (PDF)</button>
        </div>
      </details>`;
  }).join("");

  els.orders.querySelectorAll(".acct-order").forEach((el) => {
    const order = state.orders.find((o) => o.id === el.dataset.id);
    el.querySelector("[data-pdf]").addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      if (!window.jspdf?.jsPDF) { alert("No se pudo cargar el generador de PDF. Revisa tu conexión."); return; }
      const text = btn.textContent;
      btn.disabled = true;
      btn.textContent = "Generando…";
      try {
        await downloadQuotePdf({ ...order, fecha: orderDate(order) });
      } finally {
        btn.disabled = false;
        btn.textContent = text;
      }
    });
  });

  // cuenta.html#pedidos abre el más reciente.
  if (location.hash === "#pedidos") {
    els.orders.querySelector(".acct-order")?.setAttribute("open", "");
    document.getElementById("pedidos").scrollIntoView({ block: "start" });
  }
}

function escapeHtml(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
