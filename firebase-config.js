
// Config web de Firebase (es PÚBLICA y segura de exponer: la protección real
// la dan las Security Rules de Firestore, no estas claves). Misma app que el
// dashboard, proyecto ventasdashboard-e48b2.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  getFirestore, collection, getDocs, getDoc, doc, setDoc, deleteDoc, query, orderBy,
  where, limit, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import {
  getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged, getIdTokenResult,
  setPersistence, browserLocalPersistence,
  GoogleAuthProvider, signInWithPopup, signInWithRedirect, createUserWithEmailAndPassword,
  sendPasswordResetEmail, updateProfile,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import {
  getStorage, ref as storageRef, uploadBytesResumable, getDownloadURL,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-storage.js";

const firebaseConfig = {
  apiKey: "AIzaSyDser9H4yD-IX4ZGU0YmTBIkpcUs7T_bMA",
  authDomain: "ventasdashboard-e48b2.firebaseapp.com",
  projectId: "ventasdashboard-e48b2",
  storageBucket: "ventasdashboard-e48b2.firebasestorage.app",
  messagingSenderId: "685566054954",
  appId: "1:685566054954:web:e15f0d419ebe3c3d33e953",
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);
export const storage = getStorage(app);

export const COLLECTION = "catalogo_productos";
export const CLIENTS_COLLECTION = "catalogo_clientes";
export const BUYERS_COLLECTION = "compradores";
export const ORDERS_COLLECTION = "pedidos";
export const NEON_IMPORT_ENDPOINT =
  "https://us-central1-ventasdashboard-e48b2.cloudfunctions.net/importCatalogProductFromSku";
export const CATALOG_STOCK_ENDPOINT =
  "https://us-central1-ventasdashboard-e48b2.cloudfunctions.net/getCatalogStock";
export const CATALOG_COST_ENDPOINT =
  "https://us-central1-ventasdashboard-e48b2.cloudfunctions.net/getCatalogLandedCost";
export const CLIENT_USER_ENDPOINT =
  "https://us-central1-ventasdashboard-e48b2.cloudfunctions.net/upsertCatalogClientUser";
export const AI_DRAFT_ENDPOINT =
  "https://us-central1-ventasdashboard-e48b2.cloudfunctions.net/generateCatalogProductDraft";
export const CATALOG_ORDER_ENDPOINT =
  "https://us-central1-ventasdashboard-e48b2.cloudfunctions.net/createCatalogOrder";

export {
  collection, getDocs, getDoc, doc, setDoc, deleteDoc, query, orderBy,
  where, limit, serverTimestamp,
  signInWithEmailAndPassword, signOut, onAuthStateChanged, getIdTokenResult,
  setPersistence, browserLocalPersistence,
  GoogleAuthProvider, signInWithPopup, signInWithRedirect, createUserWithEmailAndPassword,
  sendPasswordResetEmail, updateProfile,
  storageRef, uploadBytesResumable, getDownloadURL,
};
