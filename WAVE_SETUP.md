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
| **Social Account bridge** | User clicks the **"Social Account"** tab on `sfl-login.html`, enters their Social email + password. The Wave Cloudflare Worker verifies credentials against Social Firebase server-side, then returns a **Wave Firebase custom token**. The browser calls `signInWithCustomToken()` → normal Wave session. Social password is discarded inside the Worker — never returned to the browser. |
| **Google OAuth** | `signInWithPopup` is called against the Wave project. Firebase recognises the same Google account and creates a Wave-project UID. No Social tokens or sessions are used. |
| **Direct Wave email/password** | User signs in on Wave directly with a Wave account (may share same email as Social — Wave creates an independent record). |
| **New users** | Register on Wave using the Create Account tab. Completely independent account. |

### Social→Wave Authentication Bridge — How It Works

```
Browser                 Wave Cloudflare Worker             Social Firebase (horr-a08f4)
  │                            │                                     │
  │  POST /auth/social-bridge  │                                     │
  │  { email, password }       │                                     │
  │──────────────────────────► │                                     │
  │                            │  signInWithPassword REST API        │
  │                            │────────────────────────────────────►│
  │                            │◄────────────────────────────────────│
  │                            │  { idToken, localId }               │
  │                            │                                     │
  │                            │  accounts:lookup (verify token)     │
  │                            │────────────────────────────────────►│
  │                            │◄────────────────────────────────────│
  │                            │  { users[0].localId confirmed }     │
  │                            │                                     │
  │                            │  *** idToken discarded here ***     │
  │                            │  Mint Wave custom JWT               │
  │                            │  UID = "snx_social_{socialUID}"     │
  │◄──────────────────────────│                                     │
  │  { customToken, waveUid }  │                                     │
  │                            │                                     │
  │  signInWithCustomToken()   │                                     │
  │  → Wave Firebase session   │                                     │
  │  → ensureWaveProfile()     │                                     │
  │  → redirect sfl-home.html  │                                     │
```

### What happens on first login to Wave

1. User signs in (any provider) → Wave Firebase Auth creates/returns a Wave UID.
2. `ensureWaveProfile()` checks if `/users/{waveUID}` exists in Wave Firestore.
3. If it doesn't exist → creates a full Wave profile document. Bridge accounts are
   stamped with `socialOrigin: true`, `socialEmail`, and `provider: 'snx_social'`.
4. If it already exists → only back-fills blank `avatar`/`displayName`. Never overwrites.
5. User is redirected to `sfl-home.html` with a valid Wave Firebase session.

### Bridge Wave UID namespace

Bridged users receive the Wave UID `snx_social_{socialUID}`. This:
- Namespaces Social-origin UIDs away from native Wave UIDs
- Makes bridged accounts auditable (Founder Panel can filter on `socialOrigin: true`)
- Prevents collisions even if Social and Wave assign the same UID string

### Security guarantees

- No password is ever copied, transmitted, or stored between projects.
- No Social Auth token is ever returned to the browser.
- No Social Firestore data is ever read by Wave.
- Social Firebase Admin credentials are never used — only the public Web API key.
- The Wave UID is different from the Social UID (different Firebase projects = different UID spaces).
- `socialEmail` stored in Wave Firestore is only the user's own email (which they provided during login).
- Shadow Nexus Social's Auth, Firestore, Storage, Rules, and Cloudflare are **never touched**.
- Wave can be fully logged out without affecting the Social session.

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

Existing Social users access Wave via the **Social Account bridge** (see above).
No user import, password copy, or Firebase Admin SDK migration is required.
The bridge creates Wave accounts on-demand at first sign-in.

**Do NOT migrate Social Firestore data to Wave.** The original Social data in
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
| `wave-worker.js` | Wave Cloudflare Worker — includes `handleSocialBridge` + `_mintFirebaseCustomToken` |
| `wrangler-wave.jsonc` | Wrangler config for Wave worker (bridge secrets documented) |
| **Frontend** | |
| `sfl-login.html` | Login page — includes "Social Account" tab and bridge form |
| **Documentation** | |
| `WAVE_SETUP.md` | This setup guide |

---

## Social→Wave Bridge — Required Secrets

Three Worker secrets must be set before the bridge works:

```bash
# 1. Social Firebase Web API key (public client key — NOT a service account)
#    Value: AIzaSyByZRmp6R9HY17T2_WdJUFWeeaLNOP6y2Y  (Social project horr-a08f4)
npx wrangler secret put SOCIAL_FIREBASE_WEB_API_KEY --config wrangler-wave.jsonc

# 2. Wave Firebase service account email
#    Get from: Firebase Console → shadow-nexus-wave → Project Settings →
#              Service Accounts → Generate new private key → JSON field "client_email"
npx wrangler secret put WAVE_SA_CLIENT_EMAIL --config wrangler-wave.jsonc

# 3. Wave Firebase service account private key (full PKCS8 PEM including newlines)
#    Get from: same JSON file, field "private_key"
#    Paste the full -----BEGIN PRIVATE KEY----- ... -----END PRIVATE KEY----- block
npx wrangler secret put WAVE_SA_PRIVATE_KEY --config wrangler-wave.jsonc
```

After setting secrets, redeploy the Wave Worker:
```bash
npx wrangler deploy --config wrangler-wave.jsonc
```

### Health-check the bridge (optional)

```bash
curl -X POST https://shadow-nexus-wave.nthntjrn.workers.dev/auth/social-bridge \
  -H 'Content-Type: application/json' \
  -d '{"email":"test@example.com","password":"wrongpassword"}'
# Expected: 401 { "error": "No Shadow Nexus Social account found..." } or "Incorrect password..."
# If 503: secrets not yet configured.
```

---

## Test Checklist — Authentication Bridge

| # | Test | Expected |
|---|---|---|
| 1 | Open `sfl-login.html` → click **Social Account** tab | Bridge form visible; Sign In / Create Account forms hidden |
| 2 | Enter a valid Social email + correct Social password → submit | Spinner shows; redirects to `sfl-home.html` with valid Wave session |
| 3 | Sign in with same Social email a second time | No duplicate Wave account created; same `snx_social_{uid}` UID returned |
| 4 | Enter valid Social email + wrong password | Error: "Incorrect password for your Shadow Nexus Social account." |
| 5 | Enter email that has no Social account | Error: "No Shadow Nexus Social account found for this email." |
| 6 | Open Shadow Nexus Social — still works, session intact | Social unaffected |
| 7 | Log out of Wave | Wave session cleared; Social session untouched |
| 8 | Verify `firebase-config.js` (Social) and Social Cloudflare worker (`yellow-term-11e6`) unchanged | `git diff` shows no changes to Social files |
| 9 | Check Wave Firestore `/users/{snx_social_*}` doc | Contains `socialOrigin: true`, `socialEmail`, `provider: 'snx_social'` |
| 10 | Bridge with secrets not yet configured | Error: "The authentication bridge is not yet configured on the server." (503) |
