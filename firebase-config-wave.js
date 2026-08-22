/**
 * firebase-config-wave.js
 * Shadow Nexus Wave — NEW dedicated Firebase project configuration.
 *
 * ⚠️  THIS FILE IS FOR SHADOW NEXUS WAVE ONLY.
 * ⚠️  DO NOT import this file from any Shadow Nexus Social page.
 * ⚠️  DO NOT deploy changes using this config to project horr-a08f4.
 *
 * Firebase project: shadow-nexus-wave
 * Social project  : horr-a08f4  (DO NOT TOUCH)
 *
 * Usage (ES module):
 *   import { app, auth, db, liveDB } from './firebase-config-wave.js';
 */

import { initializeApp, getApps, getApp }
  from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js';
import { getAuth }
  from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js';
import { getFirestore }
  from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js';
import { getDatabase }
  from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-database.js';

// ── TARGET PROJECT VERIFICATION ────────────────────────────────────────────
// This config must ALWAYS point to shadow-nexus-wave, NEVER to horr-a08f4.
const _SNW_PROJECT_ID = 'shadow-nexus-wave';

/* ── Firebase project credentials (Shadow Nexus Wave) ── */
const _SNW_CONFIG = {
  apiKey:            'AIzaSyBO4IIDLMp-SKgBaA3RINsYaj-UELLUXZE',
  authDomain:        'shadow-nexus-wave.firebaseapp.com',
  databaseURL:       'https://shadow-nexus-wave-default-rtdb.firebaseio.com',
  projectId:         'shadow-nexus-wave',
  storageBucket:     'shadow-nexus-wave.firebasestorage.app',
  messagingSenderId: '68850298302',
  appId:             '1:68850298302:web:603bbb8539079903cb1def',
};

// Runtime guard: refuse to initialise if the config points to the wrong project.
if (_SNW_CONFIG.projectId !== _SNW_PROJECT_ID) {
  throw new Error(
    `[firebase-config-wave] SAFETY VIOLATION: config points to ` +
    `"${_SNW_CONFIG.projectId}" but must point to "${_SNW_PROJECT_ID}". ` +
    `Refusing to initialise to prevent accidental writes to Shadow Nexus Social.`
  );
}

/*
 * Use a named app instance "shadow-nexus-wave" so this never collides with
 * any existing DEFAULT app that might still be initialised from legacy code.
 */
const _SNW_APP_NAME = 'shadow-nexus-wave';

const waveApp = getApps().find(a => a.name === _SNW_APP_NAME)
  ?? initializeApp(_SNW_CONFIG, _SNW_APP_NAME);

const waveAuth   = getAuth(waveApp);
const waveDb     = getFirestore(waveApp);
const waveLiveDB = getDatabase(waveApp);

export { waveApp, waveAuth, waveDb, waveLiveDB, _SNW_CONFIG };
