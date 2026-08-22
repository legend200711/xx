# Shadow Nexus Wave — Complete Setup Guide

## Project Architecture

| Platform | Firebase Project | Project ID | Status |
|---|---|---|---|
| **Shadow Nexus Social** | `horr` | `horr-a08f4` | ✅ Production — UNTOUCHED |
| **Shadow Nexus Wave** | `Shadow Nexus Wave` | `shadow-nexus-wave` | ✅ New — Created & Configured |

---

## Login / Account Migration Architecture

Wave and Social are **fully independent Firebase projects**. They do NOT share Auth,
Firestore, Storage, or any backend infrastructure.

### How existing Social users access Wave

| Provider | How it works |
|---|---|
| **Email/Password** | User signs in on Wave with the **same email + same password** they use on Social. Wave Firebase Auth creates a new, separate Wave user record with a new UID. No password is copied — the user simply authenticates independently. |
| **Google OAuth** | `signInWithPopup` is called against the Wave project. Firebase recognises the same Google account and creates a Wave-project UID. No Social tokens or sessions are used. |
| **New users** | Register on Wave using the Create Account tab. Completely independent account. |

### What happens on first login to Wave

1. User signs in (any provider) → Wave Firebase Auth creates/returns a Wave UID.
2. `ensureWaveProfile()` checks if `/users/{waveUID}` exists in Wave Firestore.
3. If it doesn't exist → creates a minimal Wave profile from Firebase Auth claims
   (displayName, email, photoURL). Stores `socialEmail` field for cross-reference.
4. If it already exists → only back-fills blank `avatar`/`displayName` from Google claims.
5. User is redirected to `sfl-home.html` with a valid Wave session.

### Security guarantees

- No password is ever copied, transmitted, or stored between projects.
- No Social Auth token is ever used on Wave.
- No Social Firestore data is ever read by Wave.
- The Wave UID is different from the Social UID (different Firebase projects = different UID spaces).
- `socialEmail` stored in Wave Firestore is only the user's own email (which they provided during login).
- Shadow Nexus Social's Auth, Firestore, Storage, and Cloudflare are **never touched**.

---

## What Has Been Done (Automated)

### Firebase Project
- ✅ New project `shadow-nexus-wave` created
- ✅ Web app registered: App ID `1:68850298302:web:603bbb8539079903cb1def`
- ✅ Firestore database provisioned (default database)
- ✅ Firestore security rules deployed (`firestore-wave.rules`)
- ✅ Firestore indexes deployed (`firestore-wave.indexes.json`)
- ✅ Identity Toolkit API enabled (prerequisite for Auth)

### Codebase Updates
- ✅ All Wave HTML pages updated to use `shadow-nexus-wave` config
- ✅ `live.js` updated to use `shadow-nexus-wave` config
- ✅ `firebase-live.js` updated to use `shadow-nexus-wave` config
- ✅ `firebase-config-wave.js` created (canonical Wave config module)
- ✅ Firebase project aliases configured:
  - `wave` → `shadow-nexus-wave`
  - `social` → `horr-a08f4` (default)
- ✅ `deploy-wave.sh` created for safe Wave-only deployments
- ✅ SNS deploy scripts updated with clear "DO NOT USE FOR WAVE" warnings

### Files Updated (Wave → New Config)
- `index.html`
- `sfl-home.html`
- `sfl-login.html`
- `sfl-profile.html`
- `sfl-upload.html`
- `sfl-player.html`
- `sfl-search.html`
- `sfl-notifications.html`
- `sfl-settings.html`
- `live.html`
- `live-hub.html`
- `live-room.html`
- `snw-test-lab.html`
- `firebase-live.js`
- `live.js`

### Files NOT Modified (Shadow Nexus Social — Production)
- `founder-panel.html` — Social admin panel
- `maintenance.html` — Social maintenance page
- `upload-worker.js` — Social Cloudflare R2 Worker
- `firebase-messaging-sw.js` — Social FCM service worker
- `firebase-config.js` — Social Firebase config (annotated as SNS-only)
- `firestore.rules` — Social Firestore rules (untouched)
- `storage.rules` — Social Storage rules (untouched)
- `firestore.indexes.json` — Social indexes (untouched)
- `database.rules.json` — Social RTDB rules (untouched)

---

## Required Manual Steps (Firebase Console)

Two services require one-time initialization via the Firebase Console before they work.
These **cannot** be done programmatically — Firebase requires the "Get Started" click.

### Step 1: Enable Firebase Authentication ⚠️ REQUIRED BEFORE WAVE WORKS ⚠️

Firebase Auth **cannot** be initialized programmatically on a new project.
The "Get Started" button must be clicked exactly once in the Console.
Until this is done, all Wave logins will fail with a Firebase Auth error.

1. Go to: https://console.firebase.google.com/project/shadow-nexus-wave/authentication
2. Click **"Get Started"** (one time only)
3. Under **Sign-in method**, enable the following providers:

   **Email/Password** (required for existing Social users with email accounts)
   - Sign-in providers → Email/Password → toggle "Enable" → Save

   **Google** (required for Social users who sign in via Google)
   - Sign-in providers → Google → toggle "Enable"
   - Set project support email (your email) → Save

   **Anonymous** (required for live stream viewers)
   - Sign-in providers → Anonymous → toggle "Enable" → Save

4. Under **Settings → Authorized domains**, add:
   - `shadow-nexus-wave.firebaseapp.com` *(auto-added)*
   - `shadow-nexus-wave.web.app` *(auto-added)*
   - `shadowfirelive.com`
   - `www.shadowfirelive.com`
   - `shadownexussocial.online` *(only if Wave is served from that domain)*

### Step 2: Enable Firebase Storage

1. Go to: https://console.firebase.google.com/project/shadow-nexus-wave/storage
2. Click **"Get Started"**
3. Choose rules: Select **"Start in production mode"** (click Next)
4. Choose location: Select **`nam5` (us-central)** → Done
5. After initialization, deploy storage rules via terminal:
   ```bash
   ./deploy-wave.sh storage
   ```

---

## New Firebase Configuration (shadow-nexus-wave)

```javascript
const FIREBASE_CONFIG = {
  apiKey:            'AIzaSyBO4IIDLMp-SKgBaA3RINsYaj-UELLUXZE',
  authDomain:        'shadow-nexus-wave.firebaseapp.com',
  databaseURL:       'https://shadow-nexus-wave-default-rtdb.firebaseio.com',
  projectId:         'shadow-nexus-wave',
  storageBucket:     'shadow-nexus-wave.firebasestorage.app',
  messagingSenderId: '68850298302',
  appId:             '1:68850298302:web:603bbb8539079903cb1def',
};
```

---

## Cloudflare Architecture

### Resources Created

| Resource | Name | Status |
|---|---|---|
| **Wave Worker** | `shadow-nexus-wave` | ✅ Deployed — `https://shadow-nexus-wave.nthntjrn.workers.dev` |
| **Wave R2 Bucket** | `legend2` | ✅ Bound to Wave worker |
| **Social Worker** | `yellow-term-11e6` | ✅ UNTOUCHED |
| **Social R2 Bucket** | `legend` | ✅ UNTOUCHED |

### Wave Worker Source Files

| File | Purpose |
|---|---|
| `wave-worker.js` | Wave Cloudflare Worker source (adapted from upload-worker.js) |
| `wrangler-wave.jsonc` | Wrangler config for Wave worker |

### Deploy Wave Worker

```bash
# Always verify target before deploying
echo "TARGET: shadow-nexus-wave"
npx wrangler deploy --config wrangler-wave.jsonc
```

### ⚠️ Remaining Wave Worker Secrets (Set Manually)

These secrets cannot be read from the Social worker and must be set manually.
Run each command and paste the value when prompted:

```bash
# CLOUDFLARE_API_TOKEN — a Cloudflare API token with "Cloudflare Stream: Edit" permission
# Create one at: https://dash.cloudflare.com/profile/api-tokens
npx wrangler secret put CLOUDFLARE_API_TOKEN --config wrangler-wave.jsonc

# R2_ACCESS_KEY_ID + R2_SECRET_ACCESS_KEY — R2 API token for the "legend2" bucket
# Create one at: https://dash.cloudflare.com → R2 → Manage R2 API Tokens
# Set permissions: Object Read & Write, Bucket: legend2
npx wrangler secret put R2_ACCESS_KEY_ID     --config wrangler-wave.jsonc
npx wrangler secret put R2_SECRET_ACCESS_KEY --config wrangler-wave.jsonc

# LiveKit credentials — same LiveKit project is fine (same cloud URL)
# Get from: https://cloud.livekit.io
npx wrangler secret put LIVEKIT_API_KEY    --config wrangler-wave.jsonc
npx wrangler secret put LIVEKIT_API_SECRET --config wrangler-wave.jsonc
```

Without `CLOUDFLARE_API_TOKEN`: video uploads fall back to R2 multipart (works, no Stream).
Without `R2_ACCESS_KEY_ID/SECRET`: presigned URL generation is disabled (proxied upload used instead).
Without `LIVEKIT_*`: live streaming tokens will fail.

### Already-Set Wave Secrets

| Secret | Value | Set |
|---|---|---|
| `FIREBASE_WEB_API_KEY` | Wave project key (`AIzaSyBO4IIDLMp...`) | ✅ |
| `CLOUDFLARE_ACCOUNT_ID` | `f276c4406b82d3c1e35efed1ef486235` | ✅ |

---

## Deployment Commands

### Deploy to Shadow Nexus Wave (safe)
```bash
./deploy-wave.sh              # deploy everything
./deploy-wave.sh verify       # verify project without deploying
./deploy-wave.sh rules        # Firestore rules only
./deploy-wave.sh indexes      # Firestore indexes only
./deploy-wave.sh storage      # Storage rules only (after manual Step 2)
./deploy-wave.sh hosting      # Hosting only
```

### Deploy to Shadow Nexus Social (unchanged scripts)
```bash
./deploy-firestore-rules.sh   # Social Firestore rules + indexes
./deploy-storage.sh           # Social Storage rules
```

---

## Verify Correct Project Before Deploying

Always run this before any deployment:

```bash
firebase use           # shows current active project
```

Expected output:
- For Wave work: `Now using alias wave (shadow-nexus-wave)`
- For Social work: `Now using alias social (horr-a08f4)`

Switch between them:
```bash
firebase use wave      # switch to Wave project
firebase use social    # switch to Social project (default)
```

---

## Realtime Database

The Wave Realtime Database URL:
`https://shadow-nexus-wave-default-rtdb.firebaseio.com`

To deploy RTDB rules when ready:
```bash
firebase deploy --only database --project shadow-nexus-wave --config firebase-wave.json
```

Note: RTDB may need to be enabled at:
https://console.firebase.google.com/project/shadow-nexus-wave/database

---

## Data Migration Note

**No data has been migrated.** The new Wave project starts with an empty database.

Wave users will need to create new accounts in the Wave project. If you want to
allow existing Shadow Nexus Social users to sign in to Wave with the same credentials,
you would need to use Firebase's user import feature — but this requires a decision
about whether Wave should share the same user base or have its own.

**Do NOT migrate data without explicit sign-off.** The original Social data in
`horr-a08f4` is preserved and untouched.

---

## New Files Created

| File | Purpose |
|---|---|
| **Firebase** | |
| `firebase-config-wave.js` | Canonical Wave Firebase config (ES module) |
| `firebase-wave.json` | Firebase CLI config for Wave project |
| `firestore-wave.rules` | Wave Firestore security rules |
| `firestore-wave.indexes.json` | Wave Firestore indexes |
| `storage-wave.rules` | Wave Storage security rules |
| `database-wave.rules.json` | Wave Realtime Database rules |
| `deploy-wave.sh` | Safe Wave-only Firebase deployment script |
| **Cloudflare** | |
| `wave-worker.js` | Wave Cloudflare Worker (adapted from upload-worker.js) |
| `wrangler-wave.jsonc` | Wrangler config for Wave worker |
| **Documentation** | |
| `WAVE_SETUP.md` | This setup guide |
