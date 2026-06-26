import { createRequire } from "node:module";
import crypto from "node:crypto";
import fs from "node:fs";

const require = createRequire(import.meta.url);
const admin = require("C:/Users/Admin/Dashboard/Dashboard/node_modules/firebase-admin");

const serviceAccountPath =
  process.env.FIREBASE_SERVICE_ACCOUNT ||
  "C:/Users/Admin/Dashboard/Dashboard/cuenta_servicio/ventasdashboard-e48b2-firebase-adminsdk-fbsvc-9dd379717f.json";

const email = process.env.CATALOG_ADMIN_EMAIL || "catalogo.admin@ventasdashboard.local";
const password = process.env.CATALOG_ADMIN_PASSWORD || makePassword();

function makePassword() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%";
  const bytes = crypto.randomBytes(18);
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}

const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, "utf8"));

if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}

let user;
try {
  user = await admin.auth().getUserByEmail(email);
  await admin.auth().updateUser(user.uid, {
    password,
    emailVerified: true,
    disabled: false,
    displayName: "Administrador Catalogo",
  });
} catch (err) {
  if (err?.code !== "auth/user-not-found") throw err;
  user = await admin.auth().createUser({
    email,
    password,
    emailVerified: true,
    disabled: false,
    displayName: "Administrador Catalogo",
  });
}

await admin.auth().setCustomUserClaims(user.uid, { admin: true, catalogAdmin: true });

console.log(JSON.stringify({
  email,
  password,
  uid: user.uid,
  claims: { admin: true, catalogAdmin: true },
}, null, 2));
