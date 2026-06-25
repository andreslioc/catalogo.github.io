// Config web de Firebase (es PÚBLICA y segura de exponer: la protección real
// la dan las Security Rules de Firestore, no estas claves). Misma app que el
// dashboard, proyecto ventasdashboard-e48b2.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  getFirestore, collection, getDocs, getDoc, doc, setDoc, deleteDoc, query, orderBy,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import {
  getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";

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

export const COLLECTION = "catalogo_productos";

export {
  collection, getDocs, getDoc, doc, setDoc, deleteDoc, query, orderBy,
  signInWithEmailAndPassword, signOut, onAuthStateChanged,
};
