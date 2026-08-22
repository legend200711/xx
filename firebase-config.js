/**
 * firebase-config.js
 * Shadow Nexus SOCIAL — Firebase configuration.
 *
 * ⚠️  THIS FILE IS FOR SHADOW NEXUS SOCIAL ONLY (project: horr-a08f4).
 * ⚠️  DO NOT import this file from Shadow Nexus Wave pages.
 * ⚠️  For Shadow Nexus Wave pages, use: firebase-config-wave.js
 *
 * Usage (ES module):
 *   import { app, auth, db, liveDB } from './firebase-config.js';
 */

import { initializeApp, getApps, getApp }
  from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js';
import { getAuth }
  from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js';
import { getFirestore }
  from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js';
import { getDatabase }
  from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-database.js';

/* ── Firebase project credentials ── */
const _CONFIG = {
  apiKey:            'AIzaSyBO4IIDLMp-SKgBaA3RINsYaj-UELLUXZE',
  authDomain:        'shadow-nexus-wave.firebaseapp.com',
  databaseURL:       'https://shadow-nexus-wave-default-rtdb.firebaseio.com',
  projectId:         'shadow-nexus-wave',
  storageBucket:     'shadow-nexus-wave.firebasestorage.app',
  messagingSenderId: '68850298302',
  appId:             '1:68850298302:web:603bbb8539079903cb1def',
};

/*
 * Reuse the existing app instance if one has already been initialised
 * (e.g. index.html and live-hub.html loaded in the same session).
 */
const app    = getApps().length ? getApp() : initializeApp(_CONFIG);
const auth   = getAuth(app);
const db     = getFirestore(app);
const liveDB = getDatabase(app);

export { app, auth, db, liveDB, _CONFIG };
