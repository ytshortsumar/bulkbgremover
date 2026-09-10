/* firebase-config.js — Firebase (Spark free plan) setup for the key gate + admin.
   Config values below are NOT secrets; security comes from Firestore rules + Auth.
   Paste your web-app config to enable the gate; until then downloads stay open.
   See SETUP.md. */

/* Firebase modular SDK (Google CDN). Bump to upgrade the version. */
export const SDK = 'https://www.gstatic.com/firebasejs/10.12.2';

export const FIREBASE_CONFIG = {
  apiKey: "AIzaSyAN397jss0dMRI-J2uw1P7N6xfd6eRpkcM",
  authDomain: "bg-remover-no-ads.firebaseapp.com",
  projectId: "bg-remover-no-ads",
  storageBucket: "bg-remover-no-ads.firebasestorage.app",
  messagingSenderId: "263098434696",
  appId: "1:263098434696:web:477ede898404d32a770b3d"
  // no measurementId — we deliberately don't load Google Analytics
};

/* True once real config is present; the download gate only turns on then. */
export function isConfigured() {
  const k = FIREBASE_CONFIG && FIREBASE_CONFIG.apiKey;
  return typeof k === 'string' && k.length > 0 && !k.startsWith('PASTE');
}

let _app = null;
let _db = null;
let _auth = null;

/* Import + init the Firebase app once (lazy — no network until needed). */
async function ensureApp() {
  if (_app) return _app;
  const { initializeApp } = await import(/* @vite-ignore */ `${SDK}/firebase-app.js`);
  _app = initializeApp(FIREBASE_CONFIG);
  return _app;
}

/* Lazily create + memoize the Firestore instance. */
export async function getDb() {
  if (_db) return _db;
  await ensureApp();
  const { getFirestore } = await import(/* @vite-ignore */ `${SDK}/firebase-firestore.js`);
  _db = getFirestore(_app);
  return _db;
}

/* Lazily create + memoize the Auth instance (admin panel only). */
export async function getAuthInstance() {
  if (_auth) return _auth;
  await ensureApp();
  const { getAuth } = await import(/* @vite-ignore */ `${SDK}/firebase-auth.js`);
  _auth = getAuth(_app);
  return _auth;
}
