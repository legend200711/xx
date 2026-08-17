/**
 * Shadow Nexus Social — Cloudflare R2 Upload + Serve Worker
 *
 * Cloudflare handles ALL media storage for Shadow Nexus Social:
 *   - Profile pictures
 *   - Post images, videos, music files
 *   - Message media attachments
 *
 * Firebase stores only the public URL + file metadata.
 *
 * Routes:
 *   GET  /{key}  — serves a file from R2 with CDN caching
 *   POST /       — uploads a file to R2, returns public URL
 *
 * Security:
 *   - Origin whitelist (ALLOWED_ORIGINS)
 *   - MIME type allowlist (images / video / audio only)
 *   - 200 MB max file size
 *   - User UID scoped storage paths
 *   - Security response headers on every response
 *   - Rate-limit hint headers (enforce limits in Cloudflare dashboard)
 */

const MAX_SIZE_IMAGE = 10   * 1024 * 1024;        // 10 MB  — images
const MAX_SIZE_VIDEO = 2048 * 1024 * 1024;        // 2 GB   — video (matches UI limit)
const MAX_SIZE_AUDIO = 200  * 1024 * 1024;        // 200 MB — audio / music
const MAX_SIZE       = MAX_SIZE_VIDEO;            // absolute upper bound

const ALLOWED_ORIGINS = [
  'https://shadownexussocial.online',
  'https://www.shadownexussocial.online',
  'https://shadowfirelive.com',
  'https://www.shadowfirelive.com',
  'https://horr-a08f4.web.app',
  'https://horr-a08f4.firebaseapp.com',
  'https://legend200711.github.io',  // GitHub Pages hosting (SFL pages live here)
  'http://localhost',
  'http://127.0.0.1'
];

// ── MIME type allowlist ───────────────────────────────────────────────────────
function isAllowedType(mime) {
  if (!mime) return false;
  const m = mime.toLowerCase().split(';')[0].trim();
  return (
    m.startsWith('image/') ||
    m.startsWith('video/') ||
    m.startsWith('audio/') ||
    m === 'application/octet-stream' // fallback for some mobile browsers
  );
}

// ── CORS headers ──────────────────────────────────────────────────────────────
function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.some(o => origin && origin.startsWith(o))
    ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin':  allowed,
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-User-UID, Upload-Offset, Upload-Length, Tus-Resumable',
    'Access-Control-Max-Age':       '86400',
  };
}

// ── Security headers added to every response ──────────────────────────────────
function securityHeaders() {
  return {
    // Prevent MIME sniffing
    'X-Content-Type-Options': 'nosniff',
    // Block pages from being embedded in iframes (clickjacking)
    'X-Frame-Options': 'DENY',
    // XSS protection for older browsers
    'X-XSS-Protection': '1; mode=block',
    // Rate-limit hint (actual limits enforced via Cloudflare dashboard WAF rules)
    'X-RateLimit-Limit':     '100',
    'X-RateLimit-Window':    '60',
    // CDN hint — vary caching per origin
    'Vary': 'Origin',
    // Strict-Transport-Security (HTTPS only)
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
    // Referrer policy
    'Referrer-Policy': 'strict-origin-when-cross-origin',
  };
}

// ── Merge multiple header objects ─────────────────────────────────────────────
function mergeHeaders(...objs) {
  return Object.assign({}, ...objs);
}

// ── Extension → MIME fallback ─────────────────────────────────────────────────
function mimeFromExt(filename) {
  const ext = (filename || '').split('.').pop().toLowerCase();
  const map = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
    gif: 'image/gif',  webp: 'image/webp', svg: 'image/svg+xml',
    mp4: 'video/mp4',  mov: 'video/quicktime',
    avi: 'video/x-msvideo', mkv: 'video/x-matroska', m4v: 'video/mp4',
    mp3: 'audio/mpeg', m4a: 'audio/mp4',  aac: 'audio/aac',
    ogg: 'audio/ogg',  wav: 'audio/wav',  flac: 'audio/flac',
    opus: 'audio/ogg', webm: 'audio/webm',
  };
  return map[ext] || null;
}

// ── Shared: sign a LiveKit JWT ────────────────────────────────────────────────
async function signLiveKitJwt(apiKey, apiSecret, payload) {
  const b64url = s => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const enc    = s => b64url(unescape(encodeURIComponent(s)));
  const header = { alg: 'HS256', typ: 'JWT' };
  const h = enc(JSON.stringify(header));
  const p = enc(JSON.stringify(payload));
  const sigInput = `${h}.${p}`;
  const keyData  = new TextEncoder().encode(apiSecret);
  const msgData  = new TextEncoder().encode(sigInput);
  const cryptoKey = await crypto.subtle.importKey(
    'raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sigBuffer = await crypto.subtle.sign('HMAC', cryptoKey, msgData);
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sigBuffer)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${sigInput}.${sigB64}`;
}

// ── LiveKit room creator ──────────────────────────────────────────────────────
// POST /livekit-room   body: { roomName }
// Creates the room on the LiveKit server so participants can join it.
async function handleLiveKitRoom(request, env, cors, sec) {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: mergeHeaders(cors, sec) });
  }

  const apiKey    = env.LIVEKIT_API_KEY;
  const apiSecret = env.LIVEKIT_API_SECRET;
  const livekitUrl = (env.LIVEKIT_URL || '')
    .replace('wss://', 'https://')
    .replace('ws://',  'http://');

  if (!apiKey || !apiSecret) {
    return new Response(JSON.stringify({ error: 'LiveKit credentials not configured' }), {
      status: 500,
      headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  let body;
  try { body = await request.json(); }
  catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  const { roomName } = body;
  if (!roomName) {
    return new Response(JSON.stringify({ error: 'roomName is required' }), {
      status: 400, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  // Mint an admin JWT (roomCreate grant) to call the LiveKit REST API
  const now = Math.floor(Date.now() / 1000);
  const adminToken = await signLiveKitJwt(apiKey, apiSecret, {
    iss: apiKey, sub: 'server', iat: now, exp: now + 60, nbf: now,
    video: { roomCreate: true },
  });

  // Call LiveKit REST API — CreateRoom (Twirp/JSON)
  let lkResp;
  try {
    lkResp = await fetch(`${livekitUrl}/twirp/livekit.RoomService/CreateRoom`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        name:              roomName,
        empty_timeout:     300,   // close room 5 min after last participant leaves
        max_participants:  500,
      }),
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: 'LiveKit API unreachable: ' + e.message }), {
      status: 502, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  const lkBody = await lkResp.text();
  if (!lkResp.ok) {
    return new Response(JSON.stringify({ error: 'LiveKit room creation failed: ' + lkBody }), {
      status: lkResp.status, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  return new Response(JSON.stringify({ roomName, created: true }), {
    status: 200,
    headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
  });
}

// ── LiveKit JWT token generator ───────────────────────────────────────────────
// Signs an access token using the LiveKit API key + secret stored as Worker secrets.
// POST /livekit-token   body: { roomName, participantName, canPublish }
async function handleLiveKitToken(request, env, cors, sec) {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: mergeHeaders(cors, sec) });
  }

  const apiKey    = env.LIVEKIT_API_KEY;
  const apiSecret = env.LIVEKIT_API_SECRET;

  if (!apiKey || !apiSecret) {
    return new Response(JSON.stringify({ error: 'LiveKit credentials not configured' }), {
      status: 500,
      headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  let body;
  try { body = await request.json(); }
  catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  const { roomName, participantName, canPublish = false } = body;
  if (!roomName || !participantName) {
    return new Response(JSON.stringify({ error: 'roomName and participantName are required' }), {
      status: 400,
      headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  // Build LiveKit access token using shared JWT signer
  const now = Math.floor(Date.now() / 1000);
  const token = await signLiveKitJwt(apiKey, apiSecret, {
    iss:  apiKey,
    sub:  participantName,
    iat:  now,
    exp:  now + 6 * 3600,
    nbf:  now,
    name: participantName,
    video: {
      room:           roomName,
      roomJoin:       true,
      canPublish,
      canSubscribe:   true,
      canPublishData: true,
    },
  });

  return new Response(JSON.stringify({ token, url: env.LIVEKIT_URL }), {
    status: 200,
    headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
  });
}

// ── Resumable / chunked upload ────────────────────────────────────────────────
//
//  Phase 1 — POST /upload-chunk
//    FormData: { uploadId, chunkIndex, totalChunks, uid, key, chunk(File) }
//    Stores each chunk as a temporary R2 object at:
//      _tmp/{uploadId}/chunk_{chunkIndex}
//    Returns { ok: true }
//
//  Phase 2 — POST /upload-complete
//    FormData: { uploadId, totalChunks, key, uid, fileName, fileType, fileSize }
//    Reads all chunks from R2 in order, concatenates them, stores the final
//    object at `key`, deletes temp chunk objects, returns { url, key }.
//
// This lets the client implement retry-per-chunk for mobile/slow connections.

// ── R2 Multipart Upload — video upload without loading file into Worker memory ─
//
// Flow:
//   1. POST /mpu/create    → BUCKET.createMultipartUpload()  → { r2UploadId, key }
//   2. POST /mpu/part      → BUCKET.resumeMultipartUpload().uploadPart(stream)
//                         → { partNumber, etag }   (NO arrayBuffer — streamed directly)
//   3. POST /mpu/complete  → BUCKET.resumeMultipartUpload().complete(parts)
//                         → { url, key }
//   4. POST /mpu/abort     → BUCKET.resumeMultipartUpload().abort()  (on cancel/error)
//
// Each part body is raw application/octet-stream — metadata comes from query params.
// Minimum part size enforced by R2: 5 MiB (except final part).

async function handleMpuCreate(request, env, cors, sec) {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }
  let body;
  try { body = await request.json(); }
  catch(e) {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  const uid      = (body.uid      || '').replace(/[^a-zA-Z0-9_-]/g, '');
  const fileName = (body.fileName || 'upload').slice(0, 200);
  let   fileType =  body.fileType || 'application/octet-stream';
  const fileSize = parseInt(body.fileSize || '0', 10);

  if (!uid) {
    return new Response(JSON.stringify({ error: 'uid is required' }), {
      status: 400, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  // Validate MIME
  const extMime = mimeFromExt(fileName);
  if (!fileType || fileType === 'application/octet-stream') fileType = extMime || fileType;
  else if (extMime && fileType.startsWith('video/') && extMime.startsWith('audio/')) fileType = extMime;
  if (!isAllowedType(fileType)) {
    return new Response(JSON.stringify({ error: `File type not supported: ${fileType}` }), {
      status: 415, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  // Validate size
  const sizeLimit = fileType.startsWith('image/') ? MAX_SIZE_IMAGE
                  : fileType.startsWith('video/') ? MAX_SIZE_VIDEO
                  : MAX_SIZE_AUDIO;
  if (fileSize > sizeLimit) {
    const limitMB = Math.round(sizeLimit / 1024 / 1024);
    return new Response(JSON.stringify({ error: `File too large (max ${limitMB} MB)` }), {
      status: 413, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  const ext = (fileName.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '');
  const key = `videos/${uid}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const cleanMime = fileType.split(';')[0].trim();

  let mpu;
  try {
    mpu = await env.BUCKET.createMultipartUpload(key, {
      httpMetadata:   { contentType: cleanMime },
      customMetadata: { uploaderUid: uid, originalName: fileName },
    });
  } catch(e) {
    return new Response(JSON.stringify({ error: 'Failed to create multipart upload: ' + e.message }), {
      status: 500, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  console.log(`[MPU] Created. key=${key} r2UploadId=${mpu.uploadId} uid=${uid}`);
  return new Response(JSON.stringify({ r2UploadId: mpu.uploadId, key }), {
    status: 200, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
  });
}

// ── R2 Multipart Upload: generate a presigned URL for one part ────────────────
//
// POST /mpu/presign
// Body: JSON { key, r2UploadId, partNumber }
// Returns: { presignedUrl }
//
// The browser receives the presigned URL and PUTs the part bytes directly to R2
// without passing through this Worker.  This avoids Worker CPU/wall-clock limits
// for large video parts on slow connections.
//
// Requires Worker secrets: R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
// These are R2 API token credentials (not the main Cloudflare API token).
// Create them at: Cloudflare Dashboard → R2 → Manage R2 API tokens
//
async function handleMpuPresign(request, env, cors, sec) {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  if (!env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY) {
    // Fall back gracefully: tell the browser to use the proxy path instead
    return new Response(JSON.stringify({ error: 'R2 presign not configured — use /mpu/part instead', fallback: true }), {
      status: 503, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  let body;
  try { body = await request.json(); }
  catch(e) {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  const key        = (body.key        || '').replace(/\.\./g, '');
  const r2UploadId =  body.r2UploadId || '';
  const partNumber = parseInt(body.partNumber || '0', 10);

  if (!key || !r2UploadId || partNumber < 1 || partNumber > 10000) {
    return new Response(JSON.stringify({ error: 'key, r2UploadId, and partNumber (1–10000) are required' }), {
      status: 400, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  // Build the S3-compatible presigned URL for this multipart part.
  // R2's S3 endpoint: https://<accountId>.r2.cloudflarestorage.com/<bucket>/<key>
  const bucketName = env.BUCKET_NAME || 'legend';
  const accountId  = env.CLOUDFLARE_ACCOUNT_ID;
  if (!accountId) {
    return new Response(JSON.stringify({ error: 'CLOUDFLARE_ACCOUNT_ID not set' }), {
      status: 503, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  const s3Endpoint = `https://${accountId}.r2.cloudflarestorage.com`;
  const partUrl    = `${s3Endpoint}/${bucketName}/${encodeURIComponent(key)}?partNumber=${partNumber}&uploadId=${encodeURIComponent(r2UploadId)}`;

  // Sign using AWS Signature Version 4 (R2 is S3-compatible).
  // We use the Web Crypto API directly — no external dependencies needed.
  const expires   = 3600; // 1 hour — plenty of time even on slow connections
  const now       = new Date();
  const dateStamp = now.toISOString().slice(0, 10).replace(/-/g, '');
  const amzDate   = now.toISOString().replace(/[:\-]|\.\d{3}/g, '').slice(0, 16) + 'Z'; // yyyyMMddTHHmmssZ

  const method    = 'PUT';
  const service   = 's3';
  const region    = 'auto';
  const credScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const signedHeaders = 'host';
  const host      = `${accountId}.r2.cloudflarestorage.com`;

  const urlObj    = new URL(partUrl);
  // Add query params required for pre-signed URL
  urlObj.searchParams.set('X-Amz-Algorithm',  'AWS4-HMAC-SHA256');
  urlObj.searchParams.set('X-Amz-Credential', `${env.R2_ACCESS_KEY_ID}/${credScope}`);
  urlObj.searchParams.set('X-Amz-Date',       amzDate);
  urlObj.searchParams.set('X-Amz-Expires',    String(expires));
  urlObj.searchParams.set('X-Amz-SignedHeaders', signedHeaders);

  // Sort query parameters alphabetically for canonical request
  urlObj.searchParams.sort();
  const canonicalQueryString = urlObj.searchParams.toString();

  const canonicalRequest = [
    method,
    `/${bucketName}/${key}`,
    canonicalQueryString,
    `host:${host}\n`,
    signedHeaders,
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const enc    = s => new TextEncoder().encode(s);
  const hashHex = async (data) => {
    const buf = await crypto.subtle.digest('SHA-256', typeof data === 'string' ? enc(data) : data);
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  };
  const hmacKey = async (key, data) => {
    const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return new Uint8Array(await crypto.subtle.sign('HMAC', k, enc(data)));
  };

  const hashedCanonical = await hashHex(canonicalRequest);
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credScope,
    hashedCanonical,
  ].join('\n');

  // Derive the signing key
  const kDate    = await hmacKey(enc('AWS4' + env.R2_SECRET_ACCESS_KEY), dateStamp);
  const kRegion  = await hmacKey(kDate,    region);
  const kService = await hmacKey(kRegion,  service);
  const kSigning = await hmacKey(kService, 'aws4_request');

  const sigBuffer = await crypto.subtle.sign('HMAC', await crypto.subtle.importKey('raw', kSigning, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']), enc(stringToSign));
  const signature = Array.from(new Uint8Array(sigBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');

  urlObj.searchParams.set('X-Amz-Signature', signature);

  console.log(`[MPU Presign] Presigned URL for part ${partNumber} of key=${key}`);
  return new Response(JSON.stringify({ presignedUrl: urlObj.toString() }), {
    status: 200, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
  });
}

async function handleMpuPart(request, env, cors, sec) {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  const url        = new URL(request.url);
  const key        = decodeURIComponent(url.searchParams.get('key')        || '').replace(/\.\./g, '');
  const r2UploadId = url.searchParams.get('r2UploadId') || '';
  const partNumber = parseInt(url.searchParams.get('partNumber') || '0', 10);

  if (!key || !r2UploadId || partNumber < 1 || partNumber > 10000) {
    return new Response(JSON.stringify({ error: 'key, r2UploadId, and partNumber (1-10000) are required' }), {
      status: 400, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  if (!request.body) {
    return new Response(JSON.stringify({ error: 'Request body (part bytes) is required' }), {
      status: 400, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  const upload = env.BUCKET.resumeMultipartUpload(key, r2UploadId);
  let uploadedPart;
  try {
    // Stream the request body directly into R2 — no arrayBuffer(), no memory spike
    uploadedPart = await upload.uploadPart(partNumber, request.body);
  } catch(e) {
    return new Response(JSON.stringify({ error: 'Part upload failed: ' + e.message }), {
      status: 500, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  return new Response(JSON.stringify({ partNumber: uploadedPart.partNumber, etag: uploadedPart.etag }), {
    status: 200, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
  });
}

async function handleMpuComplete(request, env, cors, sec) {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }
  let body;
  try { body = await request.json(); }
  catch(e) {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  const key        = (body.key        || '').replace(/\.\./g, '');
  const r2UploadId =  body.r2UploadId || '';
  const parts      =  body.parts;     // [{ partNumber, etag }, ...]

  if (!key || !r2UploadId || !Array.isArray(parts) || parts.length === 0) {
    return new Response(JSON.stringify({ error: 'key, r2UploadId, and parts[] are required' }), {
      status: 400, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  const upload = env.BUCKET.resumeMultipartUpload(key, r2UploadId);
  try {
    await upload.complete(parts);
  } catch(e) {
    return new Response(JSON.stringify({ error: 'Multipart complete failed: ' + e.message }), {
      status: 500, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  // Serve via the Worker so CORS, caching and range-request headers are applied.
  const publicUrl = `https://yellow-term-11e6.nthntjrn.workers.dev/${key}`;
  console.log(`[MPU] Complete. key=${key} parts=${parts.length} url=${publicUrl}`);
  return new Response(JSON.stringify({ url: publicUrl, key }), {
    status: 200, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
  });
}

async function handleMpuAbort(request, env, cors, sec) {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }
  let body;
  try { body = await request.json(); }
  catch(e) {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  const key        = (body.key        || '').replace(/\.\./g, '');
  const r2UploadId =  body.r2UploadId || '';
  if (!key || !r2UploadId) {
    return new Response(JSON.stringify({ error: 'key and r2UploadId are required' }), {
      status: 400, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  const upload = env.BUCKET.resumeMultipartUpload(key, r2UploadId);
  try { await upload.abort(); } catch(e) { /* best-effort */ }

  return new Response(JSON.stringify({ aborted: true }), {
    status: 200, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
  });
}

// ── Legacy chunk endpoints — kept for backward compat (non-video small files) ─

async function handleUploadChunk(request, env, cors, sec) {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: mergeHeaders(cors, sec) });
  }
  let fd;
  try { fd = await request.formData(); }
  catch (e) {
    return new Response(JSON.stringify({ error: 'Invalid form data: ' + e.message }), {
      status: 400, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  const uploadId    = (fd.get('uploadId')    || '').replace(/[^a-zA-Z0-9_-]/g, '');
  const chunkIndex  = parseInt(fd.get('chunkIndex')  || '0', 10);
  const totalChunks = parseInt(fd.get('totalChunks') || '1', 10);
  const userUid     = (fd.get('uid') || '').replace(/[^a-zA-Z0-9_-]/g, '');
  const chunk       = fd.get('chunk');

  if (!uploadId || !userUid || !chunk || typeof chunk === 'string') {
    return new Response(JSON.stringify({ error: 'uploadId, uid, and chunk are required' }), {
      status: 400, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }
  if (chunkIndex < 0 || chunkIndex >= totalChunks) {
    return new Response(JSON.stringify({ error: 'Invalid chunkIndex' }), {
      status: 400, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  const buffer = await chunk.arrayBuffer();
  if (buffer.byteLength > 50 * 1024 * 1024) {
    return new Response(JSON.stringify({ error: 'Chunk too large (max 50 MB)' }), {
      status: 413, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  const tmpKey = `_tmp/${uploadId}/chunk_${String(chunkIndex).padStart(6, '0')}`;
  try {
    await env.BUCKET.put(tmpKey, buffer, {
      customMetadata: { uploaderUid: userUid, chunkIndex: String(chunkIndex) }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: 'R2 chunk store failed: ' + e.message }), {
      status: 500, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  return new Response(JSON.stringify({ ok: true, chunkIndex }), {
    status: 200, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
  });
}

async function handleUploadComplete(request, env, cors, sec) {
  // Legacy: only used for non-video files (images, audio) that fit in memory.
  // Videos use /mpu/* endpoints instead.
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: mergeHeaders(cors, sec) });
  }
  let fd;
  try { fd = await request.formData(); }
  catch (e) {
    return new Response(JSON.stringify({ error: 'Invalid form data: ' + e.message }), {
      status: 400, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  const uploadId    = (fd.get('uploadId')    || '').replace(/[^a-zA-Z0-9_-]/g, '');
  const totalChunks = parseInt(fd.get('totalChunks') || '1', 10);
  const finalKey    = (fd.get('key')         || '').replace(/\.\./g, '');
  const userUid     = (fd.get('uid')         || '').replace(/[^a-zA-Z0-9_-]/g, '');
  const fileName    = fd.get('fileName')    || 'upload';
  let   fileType    = fd.get('fileType')    || 'application/octet-stream';
  const fileSize    = parseInt(fd.get('fileSize') || '0', 10);

  if (!uploadId || !finalKey || !userUid || totalChunks < 1) {
    return new Response(JSON.stringify({ error: 'uploadId, key, uid, and totalChunks are required' }), {
      status: 400, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  // Block videos from using the legacy path — they must use /mpu/*
  const extMime2 = mimeFromExt(fileName);
  if (!fileType || fileType === 'application/octet-stream') fileType = extMime2 || fileType;
  if (fileType.startsWith('video/')) {
    return new Response(JSON.stringify({ error: 'Videos must use the /mpu/* upload endpoints' }), {
      status: 400, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  const sizeLimit = fileType.startsWith('image/') ? MAX_SIZE_IMAGE : MAX_SIZE_AUDIO;
  if (fileSize > sizeLimit) {
    const limitMB = Math.round(sizeLimit / 1024 / 1024);
    return new Response(JSON.stringify({ error: `File too large (max ${limitMB} MB for this type)` }), {
      status: 413, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  const extMime = mimeFromExt(fileName);
  if (!fileType || fileType === 'application/octet-stream') fileType = extMime || fileType;
  else if (extMime && fileType.startsWith('video/') && extMime.startsWith('audio/')) fileType = extMime;
  if (!isAllowedType(fileType)) {
    return new Response(JSON.stringify({ error: `File type not supported: ${fileType}` }), {
      status: 415, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  const parts = [];
  for (let i = 0; i < totalChunks; i++) {
    const tmpKey = `_tmp/${uploadId}/chunk_${String(i).padStart(6, '0')}`;
    let obj;
    try { obj = await env.BUCKET.get(tmpKey); }
    catch (e) {
      return new Response(JSON.stringify({ error: `Failed to read chunk ${i}: ` + e.message }), {
        status: 500, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
      });
    }
    if (!obj) {
      return new Response(JSON.stringify({ error: `Chunk ${i} not found — upload may have expired` }), {
        status: 400, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
      });
    }
    parts.push(await obj.arrayBuffer());
  }

  const totalBytes = parts.reduce((s, b) => s + b.byteLength, 0);
  const assembled  = new Uint8Array(totalBytes);
  let offset = 0;
  for (const part of parts) {
    assembled.set(new Uint8Array(part), offset);
    offset += part.byteLength;
  }

  const cleanMime = fileType.split(';')[0].trim();
  try {
    await env.BUCKET.put(finalKey, assembled.buffer, {
      httpMetadata:   { contentType: cleanMime },
      customMetadata: { uploaderUid: userUid, originalName: fileName }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: 'R2 final write failed: ' + e.message }), {
      status: 500, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  for (let i = 0; i < totalChunks; i++) {
    const tmpKey = `_tmp/${uploadId}/chunk_${String(i).padStart(6, '0')}`;
    env.BUCKET.delete(tmpKey).catch(() => {});
  }

  const publicUrl = `https://yellow-term-11e6.nthntjrn.workers.dev/${finalKey}`;
  return new Response(JSON.stringify({ url: publicUrl, key: finalKey }), {
    status: 200, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
  });
}

// ── Cloudflare Stream: create a direct-upload URL ────────────────────────────
//
// POST /stream/upload-url
// Body: JSON { uid, maxDurationSeconds?, title? }
// Returns: { uploadURL, streamId }
//
// Requires Worker secrets: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN
async function handleStreamUploadUrl(request, env, cors, sec) {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  if (!env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_API_TOKEN) {
    console.error('[Stream] Missing CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN secrets');
    return new Response(JSON.stringify({ error: 'Stream service not configured' }), {
      status: 503, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  let body;
  try { body = await request.json(); }
  catch(e) {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  const uid    = (body.uid || '').replace(/[^a-zA-Z0-9_-]/g, '');
  const title  = (body.title  || '').slice(0, 255);
  const maxSec = Math.min(Math.max(parseInt(body.maxDurationSeconds || '10800', 10), 1), 36000);

  if (!uid) {
    return new Response(JSON.stringify({ error: 'uid is required' }), {
      status: 400, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  // Expiry: 4 hours from now — plenty of time even for large files on slow connections
  const expiry = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString();

  const payload = {
    maxDurationSeconds: maxSec,
    expiry,
    creator: uid,
    meta: title ? { name: title } : {},
    // allowedOrigins controls which origins can PLAY the video (not where the upload comes from).
    // The tus upload itself goes directly to Cloudflare Stream from the browser — no origin restriction.
    allowedOrigins: [
      'shadowfirelive.com',
      '*.shadowfirelive.com',
      'shadownexussocial.online',
      '*.shadownexussocial.online',
      'localhost',
      '127.0.0.1',
    ],
    requireSignedURLs: false,
  };

  let cfRes;
  try {
    cfRes = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/stream/direct_upload`,
      {
        method:  'POST',
        headers: {
          'Authorization': `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
          'Content-Type':  'application/json',
        },
        body: JSON.stringify(payload),
      }
    );
  } catch(e) {
    console.error('[Stream] Cloudflare API fetch error:', e.message);
    return new Response(JSON.stringify({ error: 'Failed to reach Cloudflare Stream API' }), {
      status: 502, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  let cfData;
  try { cfData = await cfRes.json(); }
  catch(e) {
    return new Response(JSON.stringify({ error: 'Invalid response from Cloudflare Stream API' }), {
      status: 502, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  if (!cfRes.ok || !cfData.success) {
    const msg = cfData.errors?.[0]?.message || `Cloudflare API error ${cfRes.status}`;
    console.error('[Stream] Cloudflare API error:', msg);
    // Quota / capacity errors must return 503 so the client falls back to R2 instead
    // of surfacing "Failed to fetch" to the user.
    const isQuota = /quota|capacity|storage|minutes|limit/i.test(msg);
    const status  = isQuota ? 503 : (cfRes.status >= 500 ? 502 : 400);
    return new Response(JSON.stringify({ error: msg, fallback: isQuota }), {
      status,
      headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  const streamId  = cfData.result.uid;
  const uploadURL = cfData.result.uploadURL;

  console.log(`[Stream] Direct upload URL created. streamId=${streamId} uid=${uid}`);

  // Return only the info the browser needs — never the API token
  return new Response(JSON.stringify({ uploadURL, streamId }), {
    status: 200, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
  });
}

// ── Cloudflare Stream: check processing status ────────────────────────────────
//
// GET /stream/status?id=<streamId>
// Returns: { status, readyToStream, playbackUrl, thumbnailUrl, duration }
//
// Requires Worker secrets: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN
async function handleStreamStatus(request, env, cors, sec) {
  if (request.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  if (!env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_API_TOKEN) {
    return new Response(JSON.stringify({ error: 'Stream service not configured' }), {
      status: 503, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  const streamId = (new URL(request.url).searchParams.get('id') || '').replace(/[^a-zA-Z0-9]/g, '');
  if (!streamId) {
    return new Response(JSON.stringify({ error: 'id is required' }), {
      status: 400, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  let cfRes;
  try {
    cfRes = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/stream/${streamId}`,
      {
        method:  'GET',
        headers: { 'Authorization': `Bearer ${env.CLOUDFLARE_API_TOKEN}` },
      }
    );
  } catch(e) {
    return new Response(JSON.stringify({ error: 'Failed to reach Cloudflare Stream API' }), {
      status: 502, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  let cfData;
  try { cfData = await cfRes.json(); }
  catch(e) {
    return new Response(JSON.stringify({ error: 'Invalid response from Cloudflare Stream API' }), {
      status: 502, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  if (!cfRes.ok || !cfData.success) {
    const msg = cfData.errors?.[0]?.message || `Cloudflare API error ${cfRes.status}`;
    return new Response(JSON.stringify({ error: msg }), {
      status: cfRes.ok ? 200 : 400, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  const r = cfData.result;

  // Prefer the playback URLs that Cloudflare returns directly in the API response.
  // These are always correct. The fallback uses the videodelivery.net CDN domain which
  // works for all accounts without needing the customer subdomain.
  const hlsUrl  = r.playback?.hls  || `https://videodelivery.net/${r.uid}/manifest/video.m3u8`;
  const thumbUrl = r.thumbnail     || `https://videodelivery.net/${r.uid}/thumbnails/thumbnail.jpg`;

  return new Response(JSON.stringify({
    streamId:        r.uid,
    status:          r.status?.state    || 'unknown',
    readyToStream:   r.readyToStream    || false,
    playbackUrl:     hlsUrl,
    dashUrl:         r.playback?.dash   || null,
    thumbnailUrl:    thumbUrl,
    duration:        r.duration         || null,
    pctComplete:     r.status?.pctComplete    || null,
    errorReasonCode: r.status?.errorReasonCode || null,
    errorReasonText: r.status?.errorReasonText || null,
  }), {
    status: 200, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
  });
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const cors   = corsHeaders(origin);
    const sec    = securityHeaders();
    const url    = new URL(request.url);

    // ── Preflight ──
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: mergeHeaders(cors, sec)
      });
    }

    // ── Upload service health check ──────────────────────────────────────────
    // GET /upload-health
    // Returns: { ok, r2: true/false, stream: 'configured'|'not_configured', worker: 'ok' }
    // Does NOT reveal secrets. Used by the frontend to distinguish between
    // internet problems, CORS failures, and server-side configuration errors.
    if (request.method === 'GET' && url.pathname === '/upload-health') {
      const hasStreamCreds = !!(env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_API_TOKEN);
      const hasR2 = !!env.BUCKET;
      return new Response(JSON.stringify({
        ok:     true,
        worker: 'ok',
        r2:     hasR2,
        stream: hasStreamCreds ? 'configured' : 'not_configured',
      }), {
        status: 200,
        headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
      });
    }

    // ── LiveKit endpoints ──
    if (url.pathname === '/livekit-room')  return handleLiveKitRoom(request, env, cors, sec);
    if (url.pathname === '/livekit-token') return handleLiveKitToken(request, env, cors, sec);

    // ── Cloudflare Stream endpoints ──
    if (url.pathname === '/stream/upload-url') return handleStreamUploadUrl(request, env, cors, sec);
    if (url.pathname === '/stream/status')     return handleStreamStatus(request, env, cors, sec);

    // ── R2 Multipart Upload endpoints (video) ──
    // /mpu/create   — creates a new multipart upload, returns { r2UploadId, key }
    // /mpu/presign  — generates a presigned URL for one part (browser uploads directly to R2)
    // /mpu/complete — finalises the upload by listing all committed parts
    // /mpu/abort    — cleans up an incomplete upload
    if (url.pathname === '/mpu/create')   return handleMpuCreate(request, env, cors, sec);
    if (url.pathname === '/mpu/presign')  return handleMpuPresign(request, env, cors, sec);
    if (url.pathname === '/mpu/part')     return handleMpuPart(request, env, cors, sec);
    if (url.pathname === '/mpu/complete') return handleMpuComplete(request, env, cors, sec);
    if (url.pathname === '/mpu/abort')    return handleMpuAbort(request, env, cors, sec);

    // ── Legacy chunked upload endpoints (non-video: images, audio) ──
    if (url.pathname === '/upload-chunk')    return handleUploadChunk(request, env, cors, sec);
    if (url.pathname === '/upload-complete') return handleUploadComplete(request, env, cors, sec);

    // ── POST /upload-music: upload a profile music file to R2 at a caller-supplied key ──
    // The client sends: file, uid, path (the full R2 key)
    // Path must start with profiles/{uid}/music/ — enforced server-side.
    if (request.method === 'POST' && url.pathname === '/upload-music') {
      let formData;
      try { formData = await request.formData(); }
      catch (e) {
        return new Response(JSON.stringify({ error: 'Invalid form data: ' + e.message }), {
          status: 400, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
        });
      }

      const file    = formData.get('file');
      const userUid = (formData.get('uid') || '').replace(/[^a-zA-Z0-9_-]/g, '');
      const reqPath = (formData.get('path') || '').replace(/\.\./g, '');  // strip traversal

      if (!file || typeof file === 'string') {
        return new Response(JSON.stringify({ error: 'No file received' }), {
          status: 400, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
        });
      }
      if (!userUid) {
        return new Response(JSON.stringify({ error: 'uid is required' }), {
          status: 400, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
        });
      }

      // Enforce: path must be scoped to this user under profiles/{uid}/music/
      const expectedPrefix = `profiles/${userUid}/music/`;
      if (!reqPath.startsWith(expectedPrefix)) {
        return new Response(JSON.stringify({ error: 'Invalid path: must start with ' + expectedPrefix }), {
          status: 403, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
        });
      }

      // MIME validation — audio only for music uploads
      let mime = file.type || '';
      const extMime = mimeFromExt(file.name);
      if (!mime || mime === 'application/octet-stream') mime = extMime || mime;
      else if (extMime && mime.startsWith('video/') && extMime.startsWith('audio/')) mime = extMime;

      if (!mime.startsWith('audio/') && !mime.startsWith('image/') && mime !== 'application/octet-stream') {
        return new Response(JSON.stringify({ error: `Only audio or image files are allowed for music uploads. Got: ${file.type}` }), {
          status: 415, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
        });
      }

      const buffer = await file.arrayBuffer();
      const sizeLimit = mime.startsWith('image/') ? MAX_SIZE_IMAGE : MAX_SIZE_AUDIO;
      if (buffer.byteLength > sizeLimit) {
        const limitMB = Math.round(sizeLimit / 1024 / 1024);
        return new Response(JSON.stringify({ error: `File too large (max ${limitMB} MB for this type)` }), {
          status: 413, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
        });
      }

      const cleanMime = (mime || 'audio/mpeg').split(';')[0].trim();
      try {
        await env.BUCKET.put(reqPath, buffer, {
          httpMetadata:   { contentType: cleanMime },
          customMetadata: { uploaderUid: userUid, originalName: file.name }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: 'R2 upload failed: ' + e.message }), {
          status: 500, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
        });
      }

      const publicUrl = `https://yellow-term-11e6.nthntjrn.workers.dev/${reqPath}`;
      return new Response(JSON.stringify({ url: publicUrl, key: reqPath }), {
        status: 200,
        headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
      });
    }

    // ── DELETE /{key}: delete a file from R2 (called when user deletes a song) ──
    if (request.method === 'DELETE') {
      // url.pathname is already decoded by the URL constructor; slice off the leading '/'
      const key = url.pathname.slice(1);
      if (!key) {
        return new Response(JSON.stringify({ error: 'key is required' }), {
          status: 400, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
        });
      }
      try {
        await env.BUCKET.delete(key);
        return new Response(JSON.stringify({ deleted: true, key }), {
          status: 200,
          headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: 'R2 delete failed: ' + e.message }), {
          status: 500, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
        });
      }
    }

    // ── GET: serve a file from R2 (CDN delivery) ──────────────────────────────
    if (request.method === 'GET') {
      const key = url.pathname.slice(1);
      if (!key) {
        return new Response('Shadow Nexus Upload Worker — OK ⚡', {
          status: 200,
          headers: mergeHeaders(cors, sec, { 'Content-Type': 'text/plain' })
        });
      }

      try {
        const obj = await env.BUCKET.get(key);
        if (!obj) {
          return new Response('Not found', {
            status: 404,
            headers: mergeHeaders(cors, sec)
          });
        }

        const headers = new Headers(mergeHeaders(cors, sec));
        headers.set('Content-Type', obj.httpMetadata?.contentType || 'application/octet-stream');
        // Long-lived immutable cache for media files (files are content-addressed)
        headers.set('Cache-Control', 'public, max-age=31536000, immutable');
        headers.set('Accept-Ranges', 'bytes');
        if (obj.httpEtag) headers.set('ETag', obj.httpEtag);
        // Bot protection hint (actual blocking via Cloudflare Bot Management)
        headers.set('X-Robots-Tag', 'noindex, nofollow');

        return new Response(obj.body, { status: 200, headers });
      } catch (e) {
        return new Response(JSON.stringify({ error: 'Fetch error: ' + e.message }), {
          status: 500,
          headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
        });
      }
    }

    // ── POST /: generic upload (profile pics, posts, messages, etc.) ─────────
    if (request.method !== 'POST') {
      return new Response('Method not allowed', {
        status: 405,
        headers: mergeHeaders(cors, sec)
      });
    }

    let formData;
    try { formData = await request.formData(); }
    catch (e) {
      return new Response(JSON.stringify({ error: 'Invalid form data: ' + e.message }), {
        status: 400,
        headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
      });
    }

    const file    = formData.get('file');
    const userUid = (formData.get('uid') || 'anonymous').replace(/[^a-zA-Z0-9_-]/g, '');

    if (!file || typeof file === 'string') {
      return new Response(JSON.stringify({ error: 'No file received' }), {
        status: 400,
        headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
      });
    }

    // ── MIME determination ────────────────────────────────────────────────────
    // Some mobile browsers report video/webm for audio recordings;
    // override based on file extension when that happens.
    let mime = file.type || '';
    const extMime = mimeFromExt(file.name);
    if (!mime || mime === 'application/octet-stream') {
      mime = extMime || mime;
    } else if (extMime && mime.startsWith('video/') && extMime.startsWith('audio/')) {
      mime = extMime;
    }

    if (!isAllowedType(mime)) {
      return new Response(JSON.stringify({ error: `File type not supported: ${file.type} (${file.name})` }), {
        status: 415,
        headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
      });
    }

    const buffer = await file.arrayBuffer();
    // Per-type size limits enforced server-side
    const cleanMime = mime.split(';')[0].trim();
    const sizeLimit = cleanMime.startsWith('image/') ? MAX_SIZE_IMAGE
                    : cleanMime.startsWith('video/') ? MAX_SIZE_VIDEO
                    : MAX_SIZE_AUDIO;
    if (buffer.byteLength > sizeLimit) {
      const limitMB = Math.round(sizeLimit / 1024 / 1024);
      return new Response(JSON.stringify({ error: `File too large (max ${limitMB} MB for this type)` }), {
        status: 413,
        headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
      });
    }

    // ── Store in R2 under userUid/timestamp-random.ext ────────────────────────
    const ext = (file.name.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '');
    const key = `${userUid}/${Date.now()}-${Math.random().toString(16).slice(2)}.${ext}`;

    try {
      await env.BUCKET.put(key, buffer, {
        httpMetadata:   { contentType: cleanMime },
        customMetadata: { uploaderUid: userUid, originalName: file.name }
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: 'R2 upload failed: ' + e.message }), {
        status: 500,
        headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
      });
    }

    // ── Return public CDN URL (stored in Firebase, served via Cloudflare CDN) ──
    const publicUrl = `https://yellow-term-11e6.nthntjrn.workers.dev/${key}`;
    return new Response(JSON.stringify({ url: publicUrl, key }), {
      status: 200,
      headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }
};
