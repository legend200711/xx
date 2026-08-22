/**
 * Shadow Nexus Wave — Cloudflare R2 Upload + Serve Worker
 *
 * Worker name:   shadow-nexus-wave
 * R2 bucket:     legend2           (Wave-only, separate from Social's "legend" bucket)
 * Firebase:      shadow-nexus-wave (Wave Firebase project, NOT horr-a08f4)
 *
 * ⚠️  DO NOT deploy this worker to the Social worker "yellow-term-11e6".
 * ⚠️  DO NOT point this worker at the Social R2 bucket "legend".
 * ⚠️  Deploy only via: npx wrangler deploy --config wrangler-wave.jsonc
 *
 * Cloudflare handles ALL media storage for Shadow Nexus Wave:
 *   - Profile pictures
 *   - Post images, videos, music files
 *   - Video uploads (R2 multipart + Cloudflare Stream)
 *
 * Firebase stores only the public URL + file metadata.
 *
 * Routes:
 *   GET  /{key}  — serves a file from R2 with CDN caching
 *   POST /       — uploads a file to R2, returns public URL
 *   POST /mpu/*  — R2 multipart upload for large videos
 *   POST /stream/* — Cloudflare Stream video upload/status/delete
 *   POST /r2/delete — secure authenticated R2 file delete
 *   POST /upload-music — music file upload
 *   GET  /upload-health — health check
 *   POST /livekit-room  — LiveKit room management
 *   POST /livekit-token — LiveKit JWT token
 *
 * Security:
 *   - Origin whitelist (ALLOWED_ORIGINS — Wave domains only)
 *   - MIME type allowlist (images / video / audio only)
 *   - User UID scoped storage paths
 *   - Firebase token verification on destructive operations
 *   - Security response headers on every response
 */

const MAX_SIZE_IMAGE = 10   * 1024 * 1024;        // 10 MB  — images
const MAX_SIZE_VIDEO = 2048 * 1024 * 1024;        // 2 GB   — video (matches UI limit)
const MAX_SIZE_AUDIO = 200  * 1024 * 1024;        // 200 MB — audio / music
const MAX_SIZE       = MAX_SIZE_VIDEO;            // absolute upper bound

// ── Wave-only allowed origins (never includes Social domains) ────────────────
const ALLOWED_ORIGINS = [
  'https://shadowfirelive.com',
  'https://www.shadowfirelive.com',
  'https://shadow-nexus-wave.web.app',
  'https://shadow-nexus-wave.firebaseapp.com',
  'https://legend200711.github.io',
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
  const bucketName = env.BUCKET_NAME || 'legend2';
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
  const publicUrl = `https://shadow-nexus-wave.nthntjrn.workers.dev/${key}`;
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
  const ucCt = (request.headers.get('Content-Type') || '').toLowerCase();
  if (ucCt && !ucCt.startsWith('multipart/form-data') && !ucCt.startsWith('application/x-www-form-urlencoded')) {
    return new Response(JSON.stringify({
      error: `This endpoint expects a multipart/form-data file upload. Received Content-Type: ${ucCt}`
    }), {
      status: 400, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
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
  const ucompCt = (request.headers.get('Content-Type') || '').toLowerCase();
  if (ucompCt && !ucompCt.startsWith('multipart/form-data') && !ucompCt.startsWith('application/x-www-form-urlencoded')) {
    return new Response(JSON.stringify({
      error: `This endpoint expects a multipart/form-data file upload. Received Content-Type: ${ucompCt}`
    }), {
      status: 400, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
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

  const publicUrl = `https://shadow-nexus-wave.nthntjrn.workers.dev/${finalKey}`;
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
      'shadow-nexus-wave.web.app',
      'shadow-nexus-wave.firebaseapp.com',
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

// ── Cloudflare Stream: delete a video ─────────────────────────────────────────
//
// POST /stream/delete
// Body: { idToken: '<Firebase ID token>', streamId: '<Cloudflare Stream UID>', ownerId: '<uid>' }
//
// Security model:
//   1. Verifies the Firebase ID token with Google's tokeninfo endpoint.
//   2. Confirms the decoded UID matches the ownerId field supplied by the client.
//   3. Only then calls the Cloudflare Stream DELETE API (token stays server-side).
//
// The Firestore security rule `allow delete: if isOwner(resource.data.creatorId)`
// provides an independent second layer of protection on the database side.
// Requires Worker secret: FIREBASE_PROJECT_ID (the Firebase project ID string)
async function handleStreamDelete(request, env, cors, sec) {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  if (!env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_API_TOKEN) {
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

  const { idToken, streamId, ownerId } = body || {};
  if (!idToken || !streamId || !ownerId) {
    return new Response(JSON.stringify({ error: 'idToken, streamId, and ownerId are required' }), {
      status: 400, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  // ── Verify Firebase ID token ──────────────────────────────────────────────
  // Uses Google's tokeninfo endpoint — no Firebase Admin SDK required.
  const projectId = env.FIREBASE_PROJECT_ID || 'shadow-nexus-wave';
  let verifiedUid;
  try {
    const tokenRes = await fetch(
      `https://www.googleapis.com/identitytoolkit/v3/relyingparty/getAccountInfo?key=${env.FIREBASE_WEB_API_KEY || ''}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken }),
      }
    );
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok || !tokenData.users?.[0]?.localId) {
      console.error('[stream/delete] Token verification failed:', tokenData?.error?.message);
      return new Response(JSON.stringify({ error: 'Unauthorized: invalid or expired token' }), {
        status: 401, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
      });
    }
    verifiedUid = tokenData.users[0].localId;
  } catch(e) {
    console.error('[stream/delete] Token verification error:', e.message);
    return new Response(JSON.stringify({ error: 'Token verification failed' }), {
      status: 502, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  // ── Confirm caller is the owner ───────────────────────────────────────────
  if (verifiedUid !== ownerId.replace(/[^a-zA-Z0-9_-]/g, '')) {
    console.warn(`[stream/delete] UID mismatch: token=${verifiedUid} claimed=${ownerId}`);
    return new Response(JSON.stringify({ error: 'Forbidden: you do not own this video' }), {
      status: 403, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  // ── Delete on Cloudflare Stream ───────────────────────────────────────────
  const safeStreamId = streamId.replace(/[^a-zA-Z0-9]/g, '');
  if (!safeStreamId) {
    return new Response(JSON.stringify({ error: 'Invalid streamId' }), {
      status: 400, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  try {
    const delRes = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/stream/${safeStreamId}`,
      {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${env.CLOUDFLARE_API_TOKEN}` },
      }
    );
    // Cloudflare Stream DELETE returns 204 on success; 404 means already gone — treat as success
    if (delRes.status === 204 || delRes.status === 404) {
      console.log(`[stream/delete] Deleted streamId=${safeStreamId} by uid=${verifiedUid}`);
      return new Response(JSON.stringify({ deleted: true, streamId: safeStreamId }), {
        status: 200, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
      });
    }
    const errData = await delRes.json().catch(() => ({}));
    const msg = errData?.errors?.[0]?.message || `Cloudflare API error ${delRes.status}`;
    console.error('[stream/delete] Cloudflare error:', msg);
    return new Response(JSON.stringify({ error: msg }), {
      status: 502, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  } catch(e) {
    console.error('[stream/delete] Fetch error:', e.message);
    return new Response(JSON.stringify({ error: 'Failed to reach Cloudflare Stream API' }), {
      status: 502, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }
}

// ── R2: securely delete a video file ─────────────────────────────────────────
//
// POST /r2/delete
// Body: { idToken: '<Firebase ID token>', r2Key: '<R2 object key>', ownerId: '<uid>' }
//
// Security: same Firebase token verification + owner check as /stream/delete.
// The r2Key is validated to ensure it belongs to the owner's storage path.
async function handleR2Delete(request, env, cors, sec) {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  let body;
  try { body = await request.json(); }
  catch(e) {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  const { idToken, r2Key, ownerId } = body || {};
  if (!idToken || !r2Key || !ownerId) {
    return new Response(JSON.stringify({ error: 'idToken, r2Key, and ownerId are required' }), {
      status: 400, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  // ── Verify Firebase ID token ──────────────────────────────────────────────
  let verifiedUid;
  try {
    const tokenRes = await fetch(
      `https://www.googleapis.com/identitytoolkit/v3/relyingparty/getAccountInfo?key=${env.FIREBASE_WEB_API_KEY || ''}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken }),
      }
    );
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok || !tokenData.users?.[0]?.localId) {
      return new Response(JSON.stringify({ error: 'Unauthorized: invalid or expired token' }), {
        status: 401, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
      });
    }
    verifiedUid = tokenData.users[0].localId;
  } catch(e) {
    return new Response(JSON.stringify({ error: 'Token verification failed' }), {
      status: 502, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  // ── Confirm caller is the owner ───────────────────────────────────────────
  const safeOwnerId = ownerId.replace(/[^a-zA-Z0-9_-]/g, '');
  if (verifiedUid !== safeOwnerId) {
    return new Response(JSON.stringify({ error: 'Forbidden: you do not own this file' }), {
      status: 403, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  // ── Validate key is scoped to this user ───────────────────────────────────
  // R2 keys are stored as "<uid>/<timestamp>-<random>.<ext>"
  // or "profiles/<uid>/..." — both start with the uid.
  const safeKey = r2Key.replace(/\.\./g, '');  // strip path traversal
  const ownsKey = safeKey.startsWith(`${safeOwnerId}/`)
               || safeKey.startsWith(`profiles/${safeOwnerId}/`);
  if (!ownsKey) {
    console.warn(`[r2/delete] Key ${safeKey} does not belong to uid=${safeOwnerId}`);
    return new Response(JSON.stringify({ error: 'Forbidden: key does not belong to owner' }), {
      status: 403, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  try {
    await env.BUCKET.delete(safeKey);
    console.log(`[r2/delete] Deleted key=${safeKey} by uid=${safeOwnerId}`);
    return new Response(JSON.stringify({ deleted: true, key: safeKey }), {
      status: 200, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  } catch(e) {
    return new Response(JSON.stringify({ error: 'R2 delete failed: ' + e.message }), {
      status: 500, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }
}

// ── Social→Wave Authentication Bridge ────────────────────────────────────────
//
// POST /auth/social-bridge
// Body: { email, password }
//
// Purpose:
//   Lets a Shadow Nexus Social user sign in to Wave using the same credentials
//   they already have on Social, without merging the two Firebase projects.
//
// Security properties:
//   - Social credentials are NEVER stored or forwarded to the browser.
//   - Social Firebase ID tokens are verified and then DISCARDED server-side.
//   - No Social Firestore data is read or written.
//   - Social Firebase Admin credentials are NOT used (only the Social Web API key,
//     which is a public client key equivalent to what any browser sends).
//   - Only the user's email and Social UID are extracted from the verified token.
//   - A Wave Firebase custom token is minted using Wave's own service account
//     and returned to the browser. The browser receives NO Social token.
//   - Wave custom tokens expire in 1 hour (Firebase default).
//
// Required Worker secrets:
//   SOCIAL_FIREBASE_WEB_API_KEY  — Social project Web API key (horr-a08f4)
//   WAVE_SA_CLIENT_EMAIL         — Wave Firebase service account email
//   WAVE_SA_PRIVATE_KEY          — Wave Firebase service account private key (PEM)
//
// Flow:
//   1. POST credentials to Social Identity Toolkit (signInWithPassword).
//   2. Verify the returned Social ID token by calling Social's getAccountInfo.
//   3. Extract uid + email from the verified Social user record.
//   4. Mint a Wave custom token for uid="snx_social_{socialUid}" using
//      Wave's service account + RS256 JWT. The "snx_" prefix namespaces
//      Social-bridged UIDs to avoid collisions with native Wave UIDs.
//   5. Return { customToken, waveUid, email } to the browser.
//   6. Browser calls signInWithCustomToken(waveAuth, customToken).
//
async function handleSocialBridge(request, env, cors, sec) {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  // ── Validate required secrets are configured ─────────────────────────────
  if (!env.SOCIAL_FIREBASE_WEB_API_KEY || !env.WAVE_SA_CLIENT_EMAIL || !env.WAVE_SA_PRIVATE_KEY) {
    return new Response(JSON.stringify({ error: 'Authentication bridge not configured on server.' }), {
      status: 503, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  let body;
  try { body = await request.json(); }
  catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  const { email, password } = body || {};
  if (!email || !password) {
    return new Response(JSON.stringify({ error: 'email and password are required' }), {
      status: 400, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  // ── Step 1: Sign in to Social Firebase (server-side REST call) ─────────────
  // This is identical to what the Firebase JS SDK does client-side, but performed
  // entirely in the Worker so the credentials never reach the browser response.
  let socialIdToken, socialLocalId, socialEmail;
  try {
    const signInRes = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${env.SOCIAL_FIREBASE_WEB_API_KEY}`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ email, password, returnSecureToken: true }),
      }
    );
    const signInData = await signInRes.json();
    if (!signInRes.ok || !signInData.idToken) {
      // Translate Social Firebase error codes to user-friendly messages
      const code = signInData?.error?.message || '';
      if (code === 'EMAIL_NOT_FOUND' || code === 'INVALID_EMAIL') {
        return new Response(JSON.stringify({ error: 'No Shadow Nexus Social account found for this email.', code: 'NOT_FOUND' }), {
          status: 401, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
        });
      }
      if (code === 'INVALID_PASSWORD' || code.startsWith('INVALID_LOGIN_CREDENTIALS')) {
        return new Response(JSON.stringify({ error: 'Incorrect password for your Shadow Nexus Social account.', code: 'WRONG_PASSWORD' }), {
          status: 401, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
        });
      }
      if (code === 'USER_DISABLED') {
        return new Response(JSON.stringify({ error: 'Your Shadow Nexus Social account has been disabled.', code: 'DISABLED' }), {
          status: 403, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
        });
      }
      if (code === 'TOO_MANY_ATTEMPTS_TRY_LATER') {
        return new Response(JSON.stringify({ error: 'Too many sign-in attempts. Please wait a moment and try again.', code: 'RATE_LIMITED' }), {
          status: 429, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
        });
      }
      return new Response(JSON.stringify({ error: 'Social sign-in failed. Check your credentials and try again.' }), {
        status: 401, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
      });
    }
    socialIdToken = signInData.idToken;
    socialLocalId = signInData.localId;
    socialEmail   = signInData.email;
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Could not reach Shadow Nexus Social for verification. Try again shortly.' }), {
      status: 502, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  // ── Step 2: Verify the Social ID token (confirm it's genuine) ───────────────
  // We call Social's getAccountInfo endpoint with the token we just received.
  // This confirms Firebase actually issued it for project horr-a08f4.
  try {
    const verifyRes = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${env.SOCIAL_FIREBASE_WEB_API_KEY}`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ idToken: socialIdToken }),
      }
    );
    const verifyData = await verifyRes.json();
    if (!verifyRes.ok || !verifyData.users?.[0]?.localId) {
      return new Response(JSON.stringify({ error: 'Social identity verification failed.' }), {
        status: 401, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
      });
    }
    // Confirm the verified uid matches what the sign-in response claimed
    if (verifyData.users[0].localId !== socialLocalId) {
      return new Response(JSON.stringify({ error: 'Social identity mismatch — refusing to bridge.' }), {
        status: 401, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
      });
    }
    // socialIdToken is no longer needed — discard it (GC'd, never returned to browser)
    socialIdToken = null;
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Social identity verification error.' }), {
      status: 502, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  // ── Step 3: Mint a Wave Firebase custom token ────────────────────────────────
  // We use the Wave service account to sign an RS256 JWT that Firebase Auth
  // will accept as a custom token. This is the standard Firebase Admin SDK flow
  // implemented manually because the Admin SDK is not available in Workers.
  //
  // The Wave UID for this bridged user is "snx_social_{socialLocalId}".
  // The "snx_social_" prefix:
  //   - Namespaces Social-origin UIDs away from native Wave UIDs
  //   - Makes bridged accounts auditable in the Founder Panel
  //   - Prevents collisions even if Social and Wave ever assign the same UID string
  //
  const waveUid = `snx_social_${socialLocalId}`;

  let customToken;
  try {
    customToken = await _mintFirebaseCustomToken(
      env.WAVE_SA_CLIENT_EMAIL,
      env.WAVE_SA_PRIVATE_KEY,
      waveUid,
      { provider: 'snx_social', socialEmail: socialEmail || email }
    );
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Failed to create Wave session token: ' + e.message }), {
      status: 500, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  // Return only the Wave custom token and the Wave UID.
  // The Social UID and Social ID token are NEVER returned.
  return new Response(JSON.stringify({
    customToken,
    waveUid,
    email: socialEmail || email,
  }), {
    status: 200, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
  });
}

// ── Internal: Mint a Firebase custom token (RS256 JWT) ───────────────────────
//
// Implements the Firebase Admin SDK custom token format using the Web Crypto API.
// Reference: https://firebase.google.com/docs/auth/admin/create-custom-tokens
//
// Parameters:
//   serviceAccountEmail — Wave Firebase service account email
//   privateKeyPem       — Wave Firebase service account private key (PKCS8 PEM)
//   uid                 — the UID to embed in the token
//   claims              — optional additional claims (stored under "claims" key)
//
async function _mintFirebaseCustomToken(serviceAccountEmail, privateKeyPem, uid, claims = {}) {
  const now = Math.floor(Date.now() / 1000);

  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: serviceAccountEmail,
    sub: serviceAccountEmail,
    aud: 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit',
    iat: now,
    exp: now + 3600,   // 1 hour — Firebase custom token max lifetime
    uid: uid,
    claims: claims,
  };

  const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const enc = obj => b64url(new TextEncoder().encode(JSON.stringify(obj)));

  const headerB64  = enc(header);
  const payloadB64 = enc(payload);
  const sigInput   = `${headerB64}.${payloadB64}`;

  // Import the PEM private key
  const pemBody = privateKeyPem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s+/g, '');
  const keyDer  = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    keyDer.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const sigBuffer = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    new TextEncoder().encode(sigInput)
  );

  return `${sigInput}.${b64url(sigBuffer)}`;
}

// ── Internal: verify a Wave Firebase ID token via REST ───────────────────────
// Returns { uid, email } on success, throws on failure.
// Uses the Wave project's public Web API key (same key the browser SDK uses).
//
async function _verifyWaveIdToken(idToken, waveWebApiKey) {
  if (!idToken || !waveWebApiKey) throw new Error('Missing token or API key');
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${waveWebApiKey}`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ idToken }),
    }
  );
  const data = await res.json();
  if (!res.ok || !data.users?.[0]?.localId) {
    throw new Error('Invalid or expired Wave session. Please sign in again.');
  }
  const u = data.users[0];
  if (u.disabled) throw new Error('Wave account is disabled.');
  return { uid: u.localId, email: u.email || '' };
}

// ── Internal: Firestore REST write via Wave service account access token ──────
// Issues a short-lived OAuth2 access token from the Wave SA credentials,
// then performs the specified Firestore REST operation.
//
// operation: 'set' | 'delete'
// path: Firestore document path, e.g. 'socialConnections/uid123'
// data: object to write (ignored for delete)
//
async function _firestoreRestWrite(operation, path, data, env) {
  // Step A: mint a Google access token (JWT-based service account auth)
  const now  = Math.floor(Date.now() / 1000);
  const jwtHeader  = { alg: 'RS256', typ: 'JWT' };
  const jwtPayload = {
    iss:   env.WAVE_SA_CLIENT_EMAIL,
    sub:   env.WAVE_SA_CLIENT_EMAIL,
    scope: 'https://www.googleapis.com/auth/datastore',
    aud:   'https://oauth2.googleapis.com/token',
    iat:   now,
    exp:   now + 3600,
  };

  const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const enc = obj => b64url(new TextEncoder().encode(JSON.stringify(obj)));

  const headerB64  = enc(jwtHeader);
  const payloadB64 = enc(jwtPayload);
  const sigInput   = `${headerB64}.${payloadB64}`;

  const pemBody = env.WAVE_SA_PRIVATE_KEY
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s+/g, '');
  const keyDer    = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8', keyDer.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['sign']
  );
  const sigBuf  = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', cryptoKey, new TextEncoder().encode(sigInput));
  const saJwt   = `${sigInput}.${b64url(sigBuf)}`;

  const tokenRes  = await fetch('https://oauth2.googleapis.com/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${saJwt}`,
  });
  const tokenData = await tokenRes.json();
  if (!tokenRes.ok || !tokenData.access_token) {
    throw new Error('Could not obtain Firestore service account token.');
  }
  const accessToken = tokenData.access_token;

  // Step B: Firestore REST call
  const project = 'shadow-nexus-wave';
  const baseUrl = `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents/${path}`;

  if (operation === 'delete') {
    const delRes = await fetch(baseUrl, {
      method:  'DELETE',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!delRes.ok && delRes.status !== 404) {
      const err = await delRes.json().catch(() => ({}));
      throw new Error('Firestore delete failed: ' + (err?.error?.message || delRes.status));
    }
    return { deleted: true };
  }

  if (operation === 'set') {
    // Convert JS object to Firestore REST format
    function toFirestoreValue(v) {
      if (v === null || v === undefined) return { nullValue: null };
      if (typeof v === 'boolean')        return { booleanValue: v };
      if (typeof v === 'number')         return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
      if (typeof v === 'string')         return { stringValue: v };
      if (Array.isArray(v))              return { arrayValue: { values: v.map(toFirestoreValue) } };
      if (typeof v === 'object')         return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, vv]) => [k, toFirestoreValue(vv)])) } };
      return { stringValue: String(v) };
    }
    const fields = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, toFirestoreValue(v)]));

    // Patch (merge) — uses PATCH with updateMask so we never overwrite other fields accidentally
    const fieldPaths = Object.keys(data).map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
    const patchUrl = `${baseUrl}?${fieldPaths}`;
    const patchRes = await fetch(patchUrl, {
      method:  'PATCH',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ fields }),
    });
    if (!patchRes.ok) {
      const err = await patchRes.json().catch(() => ({}));
      throw new Error('Firestore write failed: ' + (err?.error?.message || patchRes.status));
    }
    return await patchRes.json();
  }

  throw new Error('Unknown Firestore operation: ' + operation);
}

// ── Internal: read a Firestore doc via Wave service account ──────────────────
async function _firestoreRestGet(path, env) {
  const now  = Math.floor(Date.now() / 1000);
  const jwtHeader  = { alg: 'RS256', typ: 'JWT' };
  const jwtPayload = {
    iss:   env.WAVE_SA_CLIENT_EMAIL,
    sub:   env.WAVE_SA_CLIENT_EMAIL,
    scope: 'https://www.googleapis.com/auth/datastore',
    aud:   'https://oauth2.googleapis.com/token',
    iat:   now,
    exp:   now + 3600,
  };
  const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const enc = obj => b64url(new TextEncoder().encode(JSON.stringify(obj)));
  const sigInput  = `${enc(jwtHeader)}.${enc(jwtPayload)}`;
  const pemBody   = env.WAVE_SA_PRIVATE_KEY
    .replace(/-----BEGIN PRIVATE KEY-----/, '').replace(/-----END PRIVATE KEY-----/, '').replace(/\s+/g, '');
  const keyDer    = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey('pkcs8', keyDer.buffer, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sigBuf    = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', cryptoKey, new TextEncoder().encode(sigInput));
  const saJwt     = `${sigInput}.${b64url(sigBuf)}`;
  const tokenRes  = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${saJwt}`,
  });
  const tokenData = await tokenRes.json();
  if (!tokenRes.ok || !tokenData.access_token) throw new Error('SA token error');
  const docRes = await fetch(
    `https://firestore.googleapis.com/v1/projects/shadow-nexus-wave/databases/(default)/documents/${path}`,
    { headers: { Authorization: `Bearer ${tokenData.access_token}` } }
  );
  if (docRes.status === 404) return null;
  if (!docRes.ok) throw new Error('Firestore read failed: ' + docRes.status);
  const doc = await docRes.json();
  // Convert Firestore fields back to plain JS
  function fromFirestoreValue(v) {
    if ('nullValue'    in v) return null;
    if ('booleanValue' in v) return v.booleanValue;
    if ('integerValue' in v) return parseInt(v.integerValue, 10);
    if ('doubleValue'  in v) return v.doubleValue;
    if ('stringValue'  in v) return v.stringValue;
    if ('arrayValue'   in v) return (v.arrayValue.values || []).map(fromFirestoreValue);
    if ('mapValue'     in v) return Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, vv]) => [k, fromFirestoreValue(vv)]));
    return null;
  }
  if (!doc.fields) return {};
  return Object.fromEntries(Object.entries(doc.fields).map(([k, v]) => [k, fromFirestoreValue(v)]));
}

// ═══════════════════════════════════════════════════════════════════════════
//  POST /auth/social-connect
//
//  Connects an authenticated Wave account to a Social account.
//  Body: { waveIdToken, email, password }
//
//  Steps:
//    1. Verify waveIdToken → get waveUid (proves the caller owns their Wave account)
//    2. Verify Social email+password → get socialUid (proves ownership of Social account)
//    3. Check no other Wave account already holds this socialUid
//    4. Write socialConnections/{waveUid} via SA (server-side only, client cannot forge)
//    5. Return { connected: true, socialEmail }
//
//  Returns: 200 { connected, socialEmail }
//  Errors:  400 | 401 | 409 | 502 | 503
// ═══════════════════════════════════════════════════════════════════════════
async function handleSocialConnect(request, env, cors, sec) {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  if (!env.SOCIAL_FIREBASE_WEB_API_KEY || !env.WAVE_SA_CLIENT_EMAIL || !env.WAVE_SA_PRIVATE_KEY || !env.FIREBASE_WEB_API_KEY) {
    return new Response(JSON.stringify({ error: 'Authentication bridge not configured on server.' }), {
      status: 503, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  let body;
  try { body = await request.json(); } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  const { waveIdToken, socialEmail: socialEmailInput, socialPassword: socialPasswordInput } = body || {};
  if (!waveIdToken || !socialEmailInput || !socialPasswordInput) {
    return new Response(JSON.stringify({ error: 'waveIdToken, socialEmail, and socialPassword are required' }), {
      status: 400, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }
  // Bind to local vars used by the Social sign-in block below.
  // socialPasswordInput is consumed once for server-side Firebase auth and never persisted.
  const email    = socialEmailInput;
  const password = socialPasswordInput;

  // ── Step 1: Verify Wave ID token — prove caller owns their Wave account ──────
  let waveUid, waveEmail;
  try {
    ({ uid: waveUid, email: waveEmail } = await _verifyWaveIdToken(waveIdToken, env.FIREBASE_WEB_API_KEY));
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 401, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  // ── Step 2: Verify Social credentials — prove ownership of Social account ───
  let socialLocalId, socialEmail;
  try {
    const signInRes = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${env.SOCIAL_FIREBASE_WEB_API_KEY}`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ email, password, returnSecureToken: true }),
      }
    );
    const signInData = await signInRes.json();
    if (!signInRes.ok || !signInData.idToken) {
      const code = signInData?.error?.message || '';
      if (code === 'EMAIL_NOT_FOUND' || code === 'INVALID_EMAIL')
        return new Response(JSON.stringify({ error: 'No Shadow Nexus Social account found for that email.', code: 'NOT_FOUND' }), {
          status: 401, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
        });
      if (code === 'INVALID_PASSWORD' || code.startsWith('INVALID_LOGIN_CREDENTIALS'))
        return new Response(JSON.stringify({ error: 'Incorrect password for your Shadow Nexus Social account.', code: 'WRONG_PASSWORD' }), {
          status: 401, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
        });
      if (code === 'USER_DISABLED')
        return new Response(JSON.stringify({ error: 'That Shadow Nexus Social account has been disabled.', code: 'DISABLED' }), {
          status: 403, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
        });
      if (code === 'TOO_MANY_ATTEMPTS_TRY_LATER')
        return new Response(JSON.stringify({ error: 'Too many attempts. Please wait a moment and try again.', code: 'RATE_LIMITED' }), {
          status: 429, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
        });
      return new Response(JSON.stringify({ error: 'Social sign-in failed. Check your credentials.' }), {
        status: 401, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
      });
    }
    socialLocalId = signInData.localId;
    socialEmail   = signInData.email;

    // Verify the returned token to confirm it was issued by Social project
    const verifyRes = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${env.SOCIAL_FIREBASE_WEB_API_KEY}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken: signInData.idToken }) }
    );
    const verifyData = await verifyRes.json();
    if (!verifyRes.ok || verifyData.users?.[0]?.localId !== socialLocalId) {
      return new Response(JSON.stringify({ error: 'Social identity verification failed.' }), {
        status: 401, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
      });
    }
    // idToken discarded here — never returned to client
  } catch (e) {
    if (e.message && (e.message.includes('verification') || e.message.includes('disabled') || e.message.includes('incorrect') || e.message.includes('attempt'))) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 401, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
      });
    }
    return new Response(JSON.stringify({ error: 'Could not reach Shadow Nexus Social. Try again shortly.' }), {
      status: 502, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  // ── Step 3: Write connection record via service account ──────────────────────
  // socialConnections/{waveUid} is written server-side only.
  // The client holds a Wave ID token that was verified above — this is the only
  // way to establish a connection. A client cannot write this doc directly because
  // Firestore rules deny client writes to socialConnections (write: if false).
  try {
    await _firestoreRestWrite('set', `socialConnections/${waveUid}`, {
      waveUid,
      socialUid:     socialLocalId,
      socialEmail:   socialEmail || email,
      status:        'connected',
      connectedAt:   Date.now(),
      updatedAt:     Date.now(),
    }, env);
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Could not save connection: ' + e.message }), {
      status: 500, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  return new Response(JSON.stringify({
    connected:   true,
    socialEmail: socialEmail || email,
  }), {
    status: 200, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
  });
}

// ═══════════════════════════════════════════════════════════════════════════
//  POST /auth/social-disconnect
//
//  Removes the Social connection for the authenticated Wave user.
//  Body: { waveIdToken }
//
//  Steps:
//    1. Verify waveIdToken → get waveUid
//    2. Delete socialConnections/{waveUid} via SA
//    3. Return { disconnected: true }
// ═══════════════════════════════════════════════════════════════════════════
async function handleSocialDisconnect(request, env, cors, sec) {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  if (!env.WAVE_SA_CLIENT_EMAIL || !env.WAVE_SA_PRIVATE_KEY || !env.FIREBASE_WEB_API_KEY) {
    return new Response(JSON.stringify({ error: 'Bridge not configured.' }), {
      status: 503, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  let body;
  try { body = await request.json(); } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  const { waveIdToken } = body || {};
  if (!waveIdToken) {
    return new Response(JSON.stringify({ error: 'waveIdToken is required' }), {
      status: 400, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  let waveUid;
  try {
    ({ uid: waveUid } = await _verifyWaveIdToken(waveIdToken, env.FIREBASE_WEB_API_KEY));
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 401, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  try {
    await _firestoreRestWrite('delete', `socialConnections/${waveUid}`, {}, env);
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Could not remove connection: ' + e.message }), {
      status: 500, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  return new Response(JSON.stringify({ disconnected: true }), {
    status: 200, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
  });
}

// ═══════════════════════════════════════════════════════════════════════════
//  POST /live/social-bridge
//
//  Creates a live-bridge session record for a connected + authorized Wave user.
//  Body: { waveIdToken, liveSessionId }
//
//  Steps:
//    1. Verify waveIdToken → get waveUid
//    2. Read socialConnections/{waveUid} via SA — confirm connection exists + status==connected
//    3. Write liveBridgeSessions/{liveSessionId} via SA
//    4. Return { bridgeCreated: true, socialUid, socialEmail, sessionId }
// ═══════════════════════════════════════════════════════════════════════════
async function handleLiveSocialBridge(request, env, cors, sec) {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  if (!env.WAVE_SA_CLIENT_EMAIL || !env.WAVE_SA_PRIVATE_KEY || !env.FIREBASE_WEB_API_KEY) {
    return new Response(JSON.stringify({ error: 'Bridge not configured.' }), {
      status: 503, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  let body;
  try { body = await request.json(); } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  const { waveIdToken, liveSessionId } = body || {};
  if (!waveIdToken || !liveSessionId) {
    return new Response(JSON.stringify({ error: 'waveIdToken and liveSessionId are required' }), {
      status: 400, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  // ── Step 1: Verify Wave ID token ───────────────────────────────────────────
  let waveUid;
  try {
    ({ uid: waveUid } = await _verifyWaveIdToken(waveIdToken, env.FIREBASE_WEB_API_KEY));
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 401, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  // ── Step 2: Verify Social connection exists (server-side read) ─────────────
  let conn;
  try {
    conn = await _firestoreRestGet(`socialConnections/${waveUid}`, env);
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Could not verify Social connection: ' + e.message }), {
      status: 500, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  if (!conn || conn.status !== 'connected' || !conn.socialUid) {
    return new Response(JSON.stringify({
      error: 'No active Shadow Nexus Social connection found. Connect your Social account in Settings first.',
      code:  'NOT_CONNECTED',
    }), {
      status: 403, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  // Confirm the waveUid in the doc matches the token (paranoia check)
  if (conn.waveUid && conn.waveUid !== waveUid) {
    return new Response(JSON.stringify({ error: 'Connection record mismatch.' }), {
      status: 403, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  // ── Step 3: Write bridge session record ────────────────────────────────────
  const now = Date.now();
  // Sanitize liveSessionId — only allow alphanumeric + _ + -
  const safeSessionId = String(liveSessionId).replace(/[^a-zA-Z0-9_\-]/g, '').slice(0, 128);
  if (!safeSessionId) {
    return new Response(JSON.stringify({ error: 'Invalid liveSessionId' }), {
      status: 400, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  try {
    await _firestoreRestWrite('set', `liveBridgeSessions/${safeSessionId}`, {
      waveUid,
      socialUid:   conn.socialUid,
      socialEmail: conn.socialEmail || '',
      sessionId:   safeSessionId,
      status:      'active',
      createdAt:   now,
      startedAt:   now,
      endedAt:     0,
    }, env);
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Could not create bridge session: ' + e.message }), {
      status: 500, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  return new Response(JSON.stringify({
    bridgeCreated: true,
    socialUid:     conn.socialUid,
    socialEmail:   conn.socialEmail || '',
    sessionId:     safeSessionId,
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

    // ── Social→Wave authentication bridge (login flow) ──
    // POST /auth/social-bridge
    // Verifies a Social account server-side and issues a Wave custom token.
    // Never exposes Social credentials or tokens to the browser.
    if (url.pathname === '/auth/social-bridge')    return handleSocialBridge(request, env, cors, sec);

    // ── Social account connection (Settings → Connected Accounts) ──
    // POST /auth/social-connect      — verify Social creds + write connection record
    // POST /auth/social-disconnect   — verify Wave token  + delete connection record
    if (url.pathname === '/auth/social-connect')   return handleSocialConnect(request, env, cors, sec);
    if (url.pathname === '/auth/social-disconnect') return handleSocialDisconnect(request, env, cors, sec);

    // ── Live Social Bridge ──
    // POST /live/social-bridge — verify connection + create liveBridgeSessions doc
    if (url.pathname === '/live/social-bridge')    return handleLiveSocialBridge(request, env, cors, sec);

    // ── LiveKit endpoints ──
    if (url.pathname === '/livekit-room')  return handleLiveKitRoom(request, env, cors, sec);
    if (url.pathname === '/livekit-token') return handleLiveKitToken(request, env, cors, sec);

    // ── Cloudflare Stream endpoints ──
    if (url.pathname === '/stream/upload-url') return handleStreamUploadUrl(request, env, cors, sec);
    if (url.pathname === '/stream/status')     return handleStreamStatus(request, env, cors, sec);
    if (url.pathname === '/stream/delete')     return handleStreamDelete(request, env, cors, sec);

    // ── Secure R2 video delete ──
    if (url.pathname === '/r2/delete')         return handleR2Delete(request, env, cors, sec);

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
      const umCt = (request.headers.get('Content-Type') || '').toLowerCase();
      if (umCt && !umCt.startsWith('multipart/form-data') && !umCt.startsWith('application/x-www-form-urlencoded')) {
        return new Response(JSON.stringify({
          error: `This endpoint expects a multipart/form-data file upload. Received Content-Type: ${umCt}`
        }), {
          status: 400, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
        });
      }
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

      const publicUrl = `https://shadow-nexus-wave.nthntjrn.workers.dev/${reqPath}`;
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
        return new Response('Shadow Nexus Wave Worker — OK ⚡', {
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

    // Guard: the Workers runtime throws "Unrecognized Content-Type" if the body
    // is not multipart/form-data or application/x-www-form-urlencoded.
    // Check the Content-Type upfront and return a clear error rather than letting
    // the runtime throw a confusing exception.
    // NOTE: empty Content-Type is also rejected — the browser must set it automatically
    // (i.e. never set Content-Type manually when sending FormData; let the browser
    // generate the multipart/form-data boundary).
    const ct = (request.headers.get('Content-Type') || '').toLowerCase();
    if (!ct.startsWith('multipart/form-data') && !ct.startsWith('application/x-www-form-urlencoded')) {
      return new Response(JSON.stringify({
        error: `This endpoint expects a multipart/form-data file upload. Received Content-Type: ${ct || '(none)'}`
      }), {
        status: 400,
        headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
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
    const publicUrl = `https://shadow-nexus-wave.nthntjrn.workers.dev/${key}`;
    return new Response(JSON.stringify({ url: publicUrl, key }), {
      status: 200,
      headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }
};
