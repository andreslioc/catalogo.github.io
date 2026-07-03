const admin = require("firebase-admin");
const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { Pool } = require("pg");

admin.initializeApp();

const neonDatabaseUrl = defineSecret("NEON_DATABASE_URL");
let pool = null;

exports.importCatalogProductFromSku = onRequest(
  {
    region: "us-central1",
    timeoutSeconds: 30,
    memory: "256MiB",
    secrets: [neonDatabaseUrl],
  },
  async (req, res) => {
    setCors(req, res);

    if (req.method === "OPTIONS") {
      res.status(204).send("");
      return;
    }
    if (!["GET", "POST"].includes(req.method)) {
      sendError(res, httpError(405, "method-not-allowed"));
      return;
    }

    try {
      await requireAdmin(req);
      const sku = requestSku(req);
      if (!sku) throw httpError(400, "missing-sku");

      const row = await findNeonProduct(sku);
      if (!row) throw httpError(404, "not-found");

      res.status(200).json({ product: mapNeonRowToCatalogProduct(row, sku) });
    } catch (err) {
      sendError(res, err);
    }
  },
);

exports.upsertCatalogClientUser = onRequest(
  {
    region: "us-central1",
    timeoutSeconds: 30,
    memory: "256MiB",
  },
  async (req, res) => {
    setCors(req, res);

    if (req.method === "OPTIONS") {
      res.status(204).send("");
      return;
    }
    if (req.method !== "POST") {
      sendError(res, httpError(405, "method-not-allowed"));
      return;
    }

    try {
      await requireAdmin(req);
      const client = await upsertClientUser(req.body || {});
      res.status(200).json({ client });
    } catch (err) {
      sendError(res, err);
    }
  },
);

function setCors(req, res) {
  const origin = req.get("origin");
  res.set("Access-Control-Allow-Origin", origin || "*");
  if (origin) res.set("Vary", "Origin");
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.set("Access-Control-Max-Age", "3600");
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

async function requireAdmin(req) {
  const header = req.get("authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) throw httpError(401, "unauthorized");

  const decoded = await admin.auth().verifyIdToken(match[1]);
  if (decoded.admin !== true) throw httpError(403, "forbidden");
  return decoded;
}

function requestSku(req) {
  const raw = req.method === "GET" ? req.query.sku : req.body?.sku;
  const value = Array.isArray(raw) ? raw[0] : raw;
  return String(value || "").trim();
}

async function upsertClientUser(body) {
  const nombre = cleanText(body.nombre);
  const slug = normalizeSlug(body.slug || body.clientId);
  const clientId = normalizeSlug(body.clientId || slug);
  const email = cleanText(body.email).toLowerCase();
  const password = cleanText(body.password);
  const whatsapp = cleanText(body.whatsapp);
  const activo = body.activo !== false;

  if (!nombre || !slug || !email) throw httpError(400, "missing-client-fields");
  if (clientId !== slug) throw httpError(400, "cannot-change-slug");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw httpError(400, "invalid-email");
  if (password && password.length < 6) throw httpError(400, "weak-password");

  const db = admin.firestore();
  const clientRef = db.collection("catalogo_clientes").doc(clientId);
  const clientSnap = await clientRef.get();

  const emailSnap = await db.collection("catalogo_clientes").where("email", "==", email).limit(1).get();
  const emailOwner = emailSnap.docs[0];
  if (emailOwner && emailOwner.id !== clientId) throw httpError(409, "email-already-in-use");

  if (!clientSnap.exists && !password) throw httpError(400, "missing-password");

  let user = null;
  const existingUid = clientSnap.exists ? clientSnap.data().uid : "";
  if (existingUid) {
    user = await admin.auth().getUser(existingUid);
  } else {
    try {
      user = await admin.auth().getUserByEmail(email);
    } catch (err) {
      if (err?.code !== "auth/user-not-found") throw err;
    }
  }

  if (!user) {
    user = await admin.auth().createUser({
      email,
      password,
      displayName: nombre,
      disabled: !activo,
    });
  } else {
    const update = {
      email,
      displayName: nombre,
      disabled: !activo,
    };
    if (password) update.password = password;
    user = await admin.auth().updateUser(user.uid, update);
  }

  await admin.auth().setCustomUserClaims(user.uid, {
    ...(user.customClaims || {}),
    catalogClient: true,
    clientId,
  });

  const now = admin.firestore.FieldValue.serverTimestamp();
  await clientRef.set({
    nombre,
    slug,
    email,
    uid: user.uid,
    whatsapp,
    activo,
    updatedAt: now,
    ...(clientSnap.exists ? {} : { createdAt: now }),
  }, { merge: true });

  return { id: clientId, nombre, slug, email, uid: user.uid, whatsapp, activo };
}

async function findNeonProduct(sku) {
  const source = quoteQualifiedIdentifier(
    process.env.NEON_PRODUCT_SOURCE || "public.catalogo_productos_source",
  );
  const sql = `select * from ${source} where lower(sku::text) = lower($1) limit 1`;
  const result = await getPool().query(sql, [sku]);
  return result.rows[0] || null;
}

function getPool() {
  const connectionString = neonDatabaseUrl.value() || process.env.NEON_DATABASE_URL;
  if (!connectionString) throw httpError(500, "missing-neon-database-url", false);
  if (!pool) {
    pool = new Pool({
      connectionString,
      max: 3,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 10000,
    });
  }
  return pool;
}

function quoteQualifiedIdentifier(raw) {
  const parts = String(raw || "")
    .split(".")
    .map((part) => part.trim())
    .filter(Boolean);
  if (!parts.length || parts.length > 3) {
    throw httpError(500, "invalid-neon-product-source", false);
  }
  return parts.map(quoteIdentifier).join(".");
}

function quoteIdentifier(part) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(part)) {
    throw httpError(500, "invalid-neon-product-source", false);
  }
  return `"${part.replace(/"/g, "\"\"")}"`;
}

function mapNeonRowToCatalogProduct(row, fallbackSku) {
  const get = valueGetter(row);
  const product = {
    sku: cleanText(get(["sku", "codigo", "codigo_sku", "product_sku"])) || fallbackSku,
    nombre: cleanText(get(["nombre", "name", "titulo", "title", "producto", "product_name", "nombre_producto"])),
    marca: cleanText(get(["marca", "brand", "brand_name", "fabricante"])),
    categoria: cleanText(get(["categoria", "category", "category_name", "linea", "familia"])),
    presentacion: cleanText(get(["presentacion", "presentation", "formato", "size", "tamano"])),
    descripcion: cleanText(get(["descripcion", "description", "descripcion_larga", "description_html"])),
    dosis: cleanText(get(["dosis", "dose", "dosage"])),
    modoUso: cleanText(get(["modoUso", "modo_uso", "usage", "directions", "instrucciones"])),
    advertencias: cleanText(get(["advertencias", "warnings", "precauciones"])),
    beneficios: parseList(get(["beneficios", "benefits"])),
    ingredientes: parseList(get(["ingredientes", "ingredients"])),
    imagen: cleanText(get(["imagen", "image", "image_url", "imagen_url", "foto", "photo_url", "main_image_url"])),
    costoLlegada: parseCurrency(get(["costoLlegada", "costo_llegada", "costo", "cost", "landed_cost", "costo_total"])),
    precioBase: parseCurrency(get(["precioBase", "precio_base", "precio", "price", "sale_price", "precio_venta", "precio_sugerido"])),
    margenSugeridoPct: parseDecimal(get(["margenSugeridoPct", "margen_sugerido_pct", "margen", "margin_pct"])),
    escalasUnidades: parseTiers(get(["escalasUnidades", "escalas_unidades", "volume_prices", "price_tiers"])),
  };

  product.imagenesCatalogo = parseList(
    get(["imagenesCatalogo", "imagenes_catalogo", "images", "image_urls", "gallery"]),
  );
  if (product.imagen && !product.imagenesCatalogo.includes(product.imagen)) {
    product.imagenesCatalogo.unshift(product.imagen);
  }

  return product;
}

function valueGetter(row) {
  const byKey = new Map();
  Object.entries(row || {}).forEach(([key, value]) => {
    byKey.set(normalizeKey(key), value);
  });
  return (aliases) => {
    for (const alias of aliases) {
      const key = normalizeKey(alias);
      if (byKey.has(key)) return byKey.get(key);
    }
    return undefined;
  };
}

function normalizeKey(key) {
  return String(key || "").replace(/[_\-\s]/g, "").toLowerCase();
}

function cleanText(value) {
  if (value == null) return "";
  return String(value).trim();
}

function parseList(value) {
  if (value == null) return [];
  if (Array.isArray(value)) {
    return value.map(cleanText).filter(Boolean);
  }
  if (typeof value === "object") {
    return Object.values(value).map(cleanText).filter(Boolean);
  }

  const raw = cleanText(value);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map(cleanText).filter(Boolean);
  } catch {}

  const byLineOrPipe = raw.split(/\r?\n|\|/).map(cleanText).filter(Boolean);
  if (byLineOrPipe.length > 1) return byLineOrPipe;
  return raw.split(";").map(cleanText).filter(Boolean);
}

function parseCurrency(value) {
  if (value == null || value === "") return 0;
  if (typeof value === "number") return Number.isFinite(value) ? Math.round(value) : 0;

  const raw = String(value).trim().replace(/[^\d,.-]/g, "");
  if (!raw) return 0;

  const hasComma = raw.includes(",");
  const hasDot = raw.includes(".");
  let normalized = raw;
  if (hasComma && hasDot) {
    normalized = raw.lastIndexOf(",") > raw.lastIndexOf(".")
      ? raw.replace(/\./g, "").replace(",", ".")
      : raw.replace(/,/g, "");
  } else if (hasComma) {
    const decimals = raw.split(",").pop().length;
    normalized = decimals === 3 ? raw.replace(/,/g, "") : raw.replace(",", ".");
  } else if (hasDot) {
    const decimals = raw.split(".").pop().length;
    normalized = decimals === 3 ? raw.replace(/\./g, "") : raw;
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? Math.round(parsed) : 0;
}

function parseDecimal(value) {
  if (value == null || value === "") return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const parsed = Number(String(value).replace(",", ".").replace(/[^\d.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseTiers(value) {
  const source = Array.isArray(value) ? value : parseJsonArray(value);
  return source
    .map((tier) => ({
      desde: parseCurrency(tier?.desde ?? tier?.min ?? tier?.min_qty ?? tier?.cantidad_desde),
      precio: parseCurrency(tier?.precio ?? tier?.price ?? tier?.precio_unitario),
    }))
    .filter((tier) => tier.desde > 0 && tier.precio > 0);
}

function parseJsonArray(value) {
  if (value == null || value === "") return [];
  if (typeof value === "object") return Array.isArray(value) ? value : [];
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function httpError(status, message, expose = true) {
  const err = new Error(message);
  err.status = status;
  err.expose = expose;
  return err;
}

function sendError(res, err) {
  if (err?.code === "auth/email-already-exists") err = httpError(409, "email-already-in-use");
  if (err?.code === "auth/invalid-password" || err?.code === "auth/weak-password") {
    err = httpError(400, "weak-password");
  }
  if (err?.code === "auth/invalid-email") err = httpError(400, "invalid-email");
  const status = Number(err?.status) || 500;
  const expose = err?.expose !== false && status < 500;
  if (status >= 500) console.error("[importCatalogProductFromSku]", err);
  res.status(status).json({ error: expose ? err.message : "internal-error" });
}
