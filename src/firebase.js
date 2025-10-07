// Firebase v9 modular SDK - read config from Vite env vars if present
// You can create a local .env file with VITE_FIREBASE_* variables (see README.md)
import { initializeApp } from 'firebase/app'
import { getDatabase } from 'firebase/database'
import { getAuth, signInAnonymously } from 'firebase/auth'

// Prefer config from environment variables (Vite uses import.meta.env)
const envConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  databaseURL: import.meta.env.VITE_FIREBASE_DATABASE_URL,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
}

// You can also paste the config directly here (not recommended for publishing):
const inlineConfig = {
  // apiKey: 'YOUR_API_KEY',
  // authDomain: 'your-project.firebaseapp.com',
  // databaseURL: 'https://your-project-default-rtdb.firebaseio.com',
  // projectId: 'your-project-id',
}

function pickConfig() {
  const cfg = {}
  let has = false
  for (const k of Object.keys(envConfig)) {
    if (envConfig[k]) {
      cfg[k] = envConfig[k]
      has = true
    }
  }
  if (has) return cfg
  for (const k of Object.keys(inlineConfig)) {
    if (inlineConfig[k]) cfg[k] = inlineConfig[k]
  }
  return cfg
}

let db = null
let auth = null
const firebaseConfig = pickConfig()

if (firebaseConfig && (firebaseConfig.databaseURL || firebaseConfig.projectId)) {
  const app = initializeApp(firebaseConfig)
  db = getDatabase(app)
  try {
    auth = getAuth(app)
    // sign in anonymously so rules requiring auth pass during development
    signInAnonymously(auth).catch((err) => {
      // Log full error for debugging
      // eslint-disable-next-line no-console
      console.error('Anonymous sign-in failed (full error):', err)
      if (err && err.code === 'auth/configuration-not-found') {
        // eslint-disable-next-line no-console
        console.error('Auth configuration not found. Make sure Authentication is enabled for your Firebase project and the web app is registered. In Firebase Console: Authentication -> Sign-in method -> enable Anonymous.')
      }
    })
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('Auth initialization failed', e)
  }
} else {
  // eslint-disable-next-line no-console
  console.warn('Firebase config is missing or incomplete. Add VITE_FIREBASE_DATABASE_URL or VITE_FIREBASE_PROJECT_ID to enable realtime features.')
}

// expose debug helpers in development
if (typeof window !== 'undefined') {
  window.__firebaseDB = db
  window.__firebaseAuth = auth
  // show which config keys were used (non-secret) to help debugging
  try {
    // eslint-disable-next-line no-console
    console.log('Firebase config used:', { projectId: firebaseConfig?.projectId, databaseURL: firebaseConfig?.databaseURL })
  } catch (e) {
    // ignore
  }
  // log when auth state changes (if possible)
  try {
    if (auth && auth.onAuthStateChanged) {
      auth.onAuthStateChanged(u => console.log('firebase auth state changed', u))
    }
  } catch (e) {
    // ignore
  }
}

export { db, auth }
