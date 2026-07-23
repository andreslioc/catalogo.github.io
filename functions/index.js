const admin = require("firebase-admin");
const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { Pool } = require("pg");

admin.initializeApp();

const neonDatabaseUrl = defineSecret("NEON_DATABASE_URL");
// Base del INVENTARIO (distinta de NEON_DATABASE_URL): NEON_DATABASE_URL apunta
// a la base de productos de Nexus (donde vive catalogo_productos_source, usada
// por el import de productos); el inventario vivo (InventoryItem) está en la
// base Neon del dashboard, que es esta.
const neonInventoryDatabaseUrl = defineSecret("NEON_INVENTORY_DATABASE_URL");
const geminiApiKey = defineSecret("GEMINI_API_KEY");
// Prefer lite first: 3.5 often returns 503 high-demand on free tier.
const DEFAULT_GEMINI_MODEL = "gemini-3.1-flash-lite";
const GEMINI_FALLBACK_MODELS = [
  "gemini-3.1-flash-lite",
  "gemini-3.5-flash",
  "gemini-flash-latest",
];
let pool = null;
let inventoryPool = null;

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
      if (!row) {
        const suggestions = await findNeonProductSuggestions(sku);
        throw httpError(404, "not-found", true, { suggestions });
      }

      res.status(200).json({ product: mapNeonRowToCatalogProduct(row, sku) });
    } catch (err) {
      sendError(res, err);
    }
  },
);

// Public, read-only stock lookup for the storefront. Returns ONLY available
// units per SKU (never costs or margins — InventoryItem also holds avgCostCop
// and totalValueCop, which must never reach the browser).
//
// Source of truth is Neon `InventoryItem`: desde ~2026-06-23 el dashboard
// (Nexus) opera el inventario directamente en Neon (recepciones, ventas ML,
// ajustes) y la copia de Firestore `inventory_items` quedó congelada — solo le
// llegan descuentos de ventas ML, nunca las recepciones, así que subestima el
// stock (los ejemplos reportados marcaban 0 con 8-23 unidades reales).
// El "disponible" suma bodega local + bodega market (ver loadStockSnapshot).
const STOCK_CACHE_TTL_MS = 60000;
const STOCK_MAX_SKUS = 300;
let stockSnapshot = null; // { map: Map(lowercased sku -> units), expires }

exports.getCatalogStock = onRequest(
  {
    region: "us-central1",
    timeoutSeconds: 20,
    memory: "256MiB",
    secrets: [neonInventoryDatabaseUrl],
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
      const skus = requestSkuList(req);
      if (!skus.length) throw httpError(400, "missing-skus");
      const stock = await getStockForSkus(skus);
      res.status(200).json({ stock });
    } catch (err) {
      sendError(res, err);
    }
  },
);

function requestSkuList(req) {
  let raw;
  if (req.method === "GET") {
    raw = req.query.skus ?? req.query.sku;
  } else {
    raw = req.body?.skus ?? req.body?.sku;
  }
  const list = Array.isArray(raw) ? raw : String(raw || "").split(",");
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const sku = cleanText(item);
    if (!sku) continue;
    const key = sku.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(sku);
    if (out.length >= STOCK_MAX_SKUS) break;
  }
  return out;
}

async function getStockForSkus(skus) {
  const map = await loadStockSnapshot();
  const result = {};
  skus.forEach((sku) => {
    const key = sku.toLowerCase();
    // A SKU with no inventory record stays ABSENT from the response so the
    // storefront treats it as "unknown" (no badge, no blocking) rather than
    // wrongly marking it sold out.
    if (map.has(key)) result[sku] = map.get(key);
  });
  return result;
}

// One cached snapshot of the whole table (~600 filas): es pequeña, permite
// matchear SKUs sin distinguir mayúsculas (catálogo e inventario difieren en
// algunos) y mantiene plano el número de queries a Neon sin importar tráfico.
//
// Disponible = onHandLocalQty + onHandMarketQty (suma pura; decisión de negocio
// 2026-07-22). local = bodega Colombia; market = todo lo vendible fuera de ML
// MÁS lo bloqueado en ML. NO suma:
//  - inbound*: mercancía en tránsito, aún no vendible.
//  - onHandFullQty: bodega de Mercado Envíos Full, comprometida con ML.
// NO resta reservedQty ni defectiveQty (por pedido explícito): la suma es pura,
// así que puede exponer como disponible alguna unidad reservada o defectuosa. El
// piso en 0 hace que la deriva negativa (negativeStockFlag) se lea como "agotado".
async function loadStockSnapshot() {
  const now = Date.now();
  if (stockSnapshot && stockSnapshot.expires > now) return stockSnapshot.map;

  const { rows } = await getInventoryPool().query(`
    select sku,
      greatest(0, floor("onHandLocalQty" + "onHandMarketQty"))::int as units
    from public."InventoryItem"
  `);
  const map = new Map();
  rows.forEach((row) => {
    const key = cleanText(row.sku).toLowerCase();
    if (key) map.set(key, row.units);
  });

  stockSnapshot = { map, expires: now + STOCK_CACHE_TTL_MS };
  return map;
}

exports.generateCatalogProductDraft = onRequest(
  {
    region: "us-central1",
    timeoutSeconds: 90,
    memory: "512MiB",
    secrets: [geminiApiKey],
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
      const product = normalizeAiProductInput(req.body?.product || {});
      if (!product.sku && !product.nombre) throw httpError(400, "missing-product-context");

      const result = await generateProductDraftWithAi(product);
      res.status(200).json(result);
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

function normalizeAiProductInput(raw) {
  const source = raw || {};
  const images = Array.isArray(source.imagenesCatalogo)
    ? source.imagenesCatalogo
    : source.imagen
      ? [source.imagen]
      : [];
  return {
    sku: cleanText(source.sku),
    nombre: cleanText(source.nombre),
    marca: cleanText(source.marca),
    categoria: cleanText(source.categoria),
    presentacion: cleanText(source.presentacion),
    imagenesCatalogo: images.map(cleanText).filter(Boolean).slice(0, 4),
  };
}

async function generateProductDraftWithAi(product) {
  const apiKey = geminiApiKey.value() || process.env.GEMINI_API_KEY || "";
  if (!apiKey || apiKey === "REPLACE_WITH_GEMINI_API_KEY") {
    throw httpError(503, "missing-gemini-api-key");
  }

  const model = process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
  const payload = {
    systemInstruction: {
      role: "system",
      parts: [{
        text: [
          "Eres un asistente de catalogo para productos reales de suplementos, salud, belleza, bebes y alimentos.",
          "Genera un borrador en espanol de Colombia, breve y comercial.",
          "Debes completar TODOS los campos del esquema para revision humana: presentacion, descripcion, beneficios, ingredientes, dosis, modoUso y advertencias.",
          "Usa conocimiento general seguro del producto/marca cuando sea razonable; marca confidence media o baja si no tienes ficha oficial.",
          "No inventes concentraciones numericas exactas ni beneficios medicos diagnosticos.",
          "Si un dato es incierto, escribe un borrador prudente y generico (no dejes el campo vacio salvo que sea imposible).",
          "Evita promesas terapeuticas o diagnosticas.",
          "Devuelve exclusivamente JSON valido con el esquema solicitado.",
        ].join(" "),
      }],
    },
    contents: [
      {
        role: "user",
        parts: [{
          text: [
            "Completa los campos del producto para el catalogo. El humano revisara y aprobara antes de guardar.",
            "Prioriza rellenar campos vacios. Incluye dosis, modo de uso, ingredientes y advertencias con redaccion prudente si conoces el tipo de producto.",
            "Devuelve texto util en cada campo; evita strings vacios y listas vacias cuando puedas inferir algo seguro.",
            JSON.stringify(product, null, 2),
          ].join("\n\n"),
        }],
      },
    ],
    generationConfig: {
      temperature: 0.35,
      responseMimeType: "application/json",
      responseSchema: geminiCatalogProductDraftSchema(),
    },
  };

  const { data, model: usedModel } = await callGemini(model, payload, apiKey);
  const text = geminiResponseText(data);
  if (!text) throw httpError(502, "empty-ai-response");

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    console.error("[generateCatalogProductDraft] invalid JSON", text);
    throw httpError(502, "invalid-ai-response");
  }

  const draft = normalizeAiDraft(parsed);

  return {
    draft: {
      presentacion: draft.presentacion,
      descripcion: draft.descripcion,
      beneficios: draft.beneficios,
      ingredientes: draft.ingredientes,
      dosis: draft.dosis,
      modoUso: draft.modoUso,
      advertencias: draft.advertencias,
    },
    sources: draft.sources,
    confidence: draft.confidence,
    notes: draft.notes,
    model: usedModel,
    provider: "gemini",
    generatedAt: new Date().toISOString(),
  };
}

function geminiModelCandidates(preferred) {
  const ordered = [preferred, ...GEMINI_FALLBACK_MODELS];
  return [...new Set(ordered.map((m) => String(m || "").trim()).filter(Boolean))];
}

function shouldTryNextGeminiModel(status) {
  // 404 = model removed/unavailable; 429/5xx = quota or saturation.
  return [404, 408, 425, 429, 500, 502, 503, 504].includes(status);
}

function shouldSkipRetriesForGemini(status, data) {
  const msg = String(data?.error?.message || "").toLowerCase();
  if (status === 404) return true;
  // High demand / overload: switch model immediately instead of waiting on the same one.
  if (status === 503 && (msg.includes("high demand") || msg.includes("overloaded") || msg.includes("try again later"))) {
    return true;
  }
  return false;
}

async function callGemini(model, payload, apiKey) {
  const models = geminiModelCandidates(model);
  let lastError = null;

  for (const candidate of models) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(candidate)}:generateContent?key=${encodeURIComponent(apiKey)}`;
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await response.json().catch(() => ({}));
      if (response.ok) return { data, model: candidate };

      lastError = { status: response.status, model: candidate, data };
      console.warn(
        "[generateCatalogProductDraft] Gemini candidate failed",
        candidate,
        response.status,
        data?.error?.message || data?.error || "",
      );

      // Auth errors: same key on every free model — fail fast.
      if (response.status === 401 || response.status === 403) {
        break;
      }

      // Model gone or saturated — jump to next free-tier model now.
      if (shouldSkipRetriesForGemini(response.status, data)) break;

      if (!shouldTryNextGeminiModel(response.status)) break;
      if (attempt < 2) {
        await sleep(geminiRetryDelayMs(data, attempt));
      }
    }
    if (lastError?.status === 401 || lastError?.status === 403) break;
  }

  console.error("[generateCatalogProductDraft] Gemini error", lastError);
  const message = lastError?.status === 429 ? "gemini-rate-limited" : "gemini-request-failed";
  throw httpError(lastError?.status === 401 || lastError?.status === 403 ? 503 : 502, message);
}

function geminiResponseText(data) {
  return String(data?.candidates?.[0]?.content?.parts?.[0]?.text || "").trim();
}

function geminiRetryDelayMs(data, attempt) {
  const msg = String(data?.error?.message || "");
  const match = msg.match(/retry in\s+([\d.]+)s/i);
  if (match) {
    return Math.min(25000, Math.ceil(Number(match[1]) * 1000) + 500);
  }
  return Math.min(15000, 750 * 2 ** (attempt - 1) + Math.floor(Math.random() * 300));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function geminiCatalogProductDraftSchema() {
  return {
    type: "object",
    properties: {
      presentacion: { type: "string" },
      descripcion: { type: "string" },
      beneficios: {
        type: "array",
        items: { type: "string" },
      },
      ingredientes: {
        type: "array",
        items: { type: "string" },
      },
      dosis: { type: "string" },
      modoUso: { type: "string" },
      advertencias: { type: "string" },
      sources: {
        type: "array",
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            url: { type: "string" },
            kind: { type: "string" },
          },
          required: ["title", "url", "kind"],
        },
      },
      confidence: { type: "string", enum: ["alta", "media", "baja"] },
      notes: { type: "string" },
    },
    required: [
      "presentacion",
      "descripcion",
      "beneficios",
      "ingredientes",
      "dosis",
      "modoUso",
      "advertencias",
      "sources",
      "confidence",
      "notes",
    ],
  };
}

function catalogProductDraftSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "presentacion",
      "descripcion",
      "beneficios",
      "ingredientes",
      "dosis",
      "modoUso",
      "advertencias",
      "sources",
      "confidence",
      "notes",
    ],
    properties: {
      presentacion: { type: "string" },
      descripcion: { type: "string" },
      beneficios: {
        type: "array",
        maxItems: 6,
        items: { type: "string" },
      },
      ingredientes: {
        type: "array",
        maxItems: 16,
        items: { type: "string" },
      },
      dosis: { type: "string" },
      modoUso: { type: "string" },
      advertencias: { type: "string" },
      sources: {
        type: "array",
        maxItems: 8,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["title", "url", "kind"],
          properties: {
            title: { type: "string" },
            url: { type: "string" },
            kind: { type: "string" },
          },
        },
      },
      confidence: { type: "string", enum: ["alta", "media", "baja"] },
      notes: { type: "string" },
    },
  };
}

function normalizeAiDraft(raw) {
  return {
    presentacion: cleanText(raw?.presentacion).slice(0, 160),
    descripcion: cleanText(raw?.descripcion).slice(0, 900),
    beneficios: cleanList(raw?.beneficios, 6, 120),
    ingredientes: cleanList(raw?.ingredientes, 16, 120),
    dosis: cleanText(raw?.dosis).slice(0, 220),
    modoUso: cleanText(raw?.modoUso).slice(0, 420),
    advertencias: cleanText(raw?.advertencias).slice(0, 520),
    sources: normalizeSources(raw?.sources),
    confidence: ["alta", "media", "baja"].includes(raw?.confidence) ? raw.confidence : "baja",
    notes: cleanText(raw?.notes).slice(0, 500),
  };
}

function cleanList(value, maxItems, maxLength) {
  const source = Array.isArray(value) ? value : [];
  return source.map(cleanText).filter(Boolean).slice(0, maxItems).map((item) => item.slice(0, maxLength));
}

function normalizeSources(value) {
  const source = Array.isArray(value) ? value : [];
  return source.map((item) => ({
    title: cleanText(item?.title).slice(0, 140),
    url: cleanText(item?.url).slice(0, 500),
    kind: cleanText(item?.kind).slice(0, 80) || "web",
  })).filter((item) => item.url);
}

function mergeSources(...groups) {
  const byUrl = new Map();
  groups.flat().forEach((source) => {
    const url = cleanText(source?.url);
    if (!url || byUrl.has(url)) return;
    byUrl.set(url, {
      title: cleanText(source?.title) || url,
      url,
      kind: cleanText(source?.kind) || "web",
    });
  });
  return [...byUrl.values()].slice(0, 8);
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
  const source = neonProductSource();
  const sql = `select * from ${source} where lower(sku::text) = lower($1) limit 1`;
  const result = await getPool().query(sql, [sku]);
  return result.rows[0] || null;
}

async function findNeonProductSuggestions(sku) {
  const patterns = suggestionPatterns(sku);
  if (!patterns.length) return [];

  const source = neonProductSource();
  const where = patterns
    .map((_, index) => `sku::text ilike $${index + 1} escape '\\'`)
    .join(" or ");
  const sql = `
    select *
    from ${source}
    where ${where}
    order by sku::text
    limit 6
  `;
  const result = await getPool().query(sql, patterns);
  return result.rows.map((row) => {
    const product = mapNeonRowToCatalogProduct(row, "");
    return {
      sku: product.sku,
      nombre: product.nombre,
      marca: product.marca,
    };
  });
}

function neonProductSource() {
  return quoteQualifiedIdentifier(
    process.env.NEON_PRODUCT_SOURCE || "public.catalogo_productos_source",
  );
}

function suggestionPatterns(sku) {
  const clean = String(sku || "").trim();
  if (!clean) return [];

  const values = new Set();
  values.add(`${escapeLike(clean)}%`);

  const withoutTrailingNumber = clean.replace(/[-_\s]*\d+$/, "");
  if (withoutTrailingNumber.length >= 3 && withoutTrailingNumber !== clean) {
    values.add(`${escapeLike(withoutTrailingNumber)}%`);
  }

  const firstChunk = clean.split(/[-_\s/]+/)[0];
  if (firstChunk.length >= 3 && firstChunk !== clean && firstChunk !== withoutTrailingNumber) {
    values.add(`${escapeLike(firstChunk)}%`);
  }

  return [...values];
}

function escapeLike(value) {
  return String(value).replace(/[\\%_]/g, "\\$&");
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

function getInventoryPool() {
  const connectionString =
    neonInventoryDatabaseUrl.value() || process.env.NEON_INVENTORY_DATABASE_URL;
  if (!connectionString) throw httpError(500, "missing-neon-inventory-database-url", false);
  if (!inventoryPool) {
    inventoryPool = new Pool({
      connectionString,
      max: 3,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 10000,
    });
  }
  return inventoryPool;
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

// La app vieja de Nexus (product-master--nexus.replit.app) desaparecio al
// migrar a Vercel; sus /objects/... devuelven 404. Las mismas imagenes viven
// ahora en el bucket R2 publico. Firestore ya se corrigio una vez con
// fix_image_urls.cjs, pero Neon (fuente de los SKUs que aun no se han
// importado) sigue con las URLs muertas, asi que hay que reescribirlas aqui
// tambien para que un SKU importado por primera vez no traiga la foto rota.
const OLD_REPLIT_UPLOADS = /^https:\/\/product-master--nexus\.replit\.app\/objects\/uploads\//;
const OLD_REPLIT_PRIVATE = /^https:\/\/product-master--nexus\.replit\.app\/objects\/\.private\//;
const R2_PUBLIC_BASE = "https://pub-74be3f08e8ab44c490fe4d652d79a419.r2.dev/";

function rewriteImageUrl(url) {
  const s = String(url || "").trim();
  if (!s) return s;
  if (OLD_REPLIT_UPLOADS.test(s)) return s.replace(OLD_REPLIT_UPLOADS, `${R2_PUBLIC_BASE}uploads/`);
  if (OLD_REPLIT_PRIVATE.test(s)) return s.replace(OLD_REPLIT_PRIVATE, R2_PUBLIC_BASE);
  return s;
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
    imagen: rewriteImageUrl(cleanText(get(["imagen", "image", "image_url", "imagen_url", "foto", "photo_url", "main_image_url"]))),
    costoLlegada: parseCurrency(get([
      "costoLlegada",
      "costo_llegada",
      "costoLlegadaCop",
      "costo_llegada_cop",
      "costo llegada COP",
      "costo",
      "cost",
      "landed_cost",
      "landed_cost_cop",
      "costo_total",
    ])),
    precioBase: parseCurrency(get(["precioBase", "precio_base", "precio", "price", "sale_price", "precio_venta", "precio_sugerido"])),
    margenSugeridoPct: parseDecimal(get(["margenSugeridoPct", "margen_sugerido_pct", "margen", "margin_pct"])),
    escalasUnidades: parseTiers(get(["escalasUnidades", "escalas_unidades", "volume_prices", "price_tiers"])),
  };

  product.imagenesCatalogo = parseList(
    get(["imagenesCatalogo", "imagenes_catalogo", "images", "image_urls", "gallery"]),
  ).map(rewriteImageUrl);
  if (product.imagen && !product.imagenesCatalogo.includes(product.imagen)) {
    product.imagenesCatalogo.unshift(product.imagen);
  }

  // Neon puede exponer solamente el costo de llegada. En ese caso usamos el
  // margen importado (30 % por defecto) para que el producto nuevo no quede
  // publicado sin un precio base calculable.
  if (product.costoLlegada > 0 && product.precioBase <= 0) {
    const margin = product.margenSugeridoPct > 0 ? product.margenSugeridoPct : 30;
    product.margenSugeridoPct = margin;
    product.precioBase = Math.round(product.costoLlegada * (1 + margin / 100));
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

function httpError(status, message, expose = true, details = {}) {
  const err = new Error(message);
  err.status = status;
  err.expose = expose;
  Object.assign(err, details);
  return err;
}

function sendError(res, err) {
  if (err?.code === "auth/email-already-exists") err = httpError(409, "email-already-in-use");
  if (err?.code === "auth/invalid-password" || err?.code === "auth/weak-password") {
    err = httpError(400, "weak-password");
  }
  if (err?.code === "auth/invalid-email") err = httpError(400, "invalid-email");
  const status = Number(err?.status) || 500;
  const expose = err?.expose === true || (err?.expose !== false && status < 500);
  if (status >= 500) console.error("[importCatalogProductFromSku]", err);
  const body = { error: expose ? err.message : "internal-error" };
  if (Array.isArray(err?.suggestions) && err.suggestions.length) {
    body.suggestions = err.suggestions;
  }
  res.status(status).json(body);
}
