// Thin S3-compatible object storage client - used to stop stashing generated
// media inline in the database (ElevenLabs voiceovers as base64 `data:` URLs)
// and to stop relying on kie.ai's own temp-file hosting (which is not
// permanent) for AI-generated covers/videos.
//
// Works with ANY S3-compatible endpoint, not just AWS - Cloudflare R2, a
// self-hosted MinIO container, DigitalOcean/Hetzner Spaces, etc. Uses
// @aws-sdk/client-s3 rather than hand-rolled SigV4 signing: request signing
// for S3 is fiddly to get exactly right (canonical request construction,
// header signing, chunked-upload edge cases) and the official SDK is the
// well-tested way to do it, even though it's a heavier dependency than the
// plain-fetch clients elsewhere in server/lib/ (kieClient.js,
// elevenLabsClient.js). It's an S3 REST-API client, not an AWS-account-only
// thing - the `endpoint` option below is exactly what points it at a
// non-AWS provider.
//
// GRACEFUL DEGRADATION: like every other optional integration in this
// codebase (kie.ai, ElevenLabs, Piper, Telegram), this is entirely
// optional. isObjectStorageConfigured() tells callers whether to use it;
// with no env vars set, callers MUST fall back to their previous behavior
// (base64 data: URLs, kie.ai's own temp URLs) rather than erroring - see
// server/routes/mediaAssets.js.
//
// Required env vars (all of them, or none):
//   S3_ENDPOINT            e.g. https://<account-id>.r2.cloudflarestorage.com
//   S3_BUCKET               bucket name
//   S3_ACCESS_KEY_ID
//   S3_SECRET_ACCESS_KEY
// Optional:
//   S3_REGION               defaults to 'auto' (what R2 expects; most
//                            self-hosted S3-compatible servers ignore the
//                            value entirely, so 'auto' is a safe default)
//   S3_PUBLIC_URL_BASE      base URL to build public-facing links from, since
//                            the API endpoint and the public URL are often
//                            different hosts (an R2 bucket's API endpoint
//                            isn't publicly readable - you attach a custom
//                            domain or public dev URL separately; a
//                            Coolify-hosted MinIO's public URL may differ
//                            from its internal API endpoint too). Falls back
//                            to path-style off S3_ENDPOINT if unset, which
//                            works for a plain MinIO setup with a public
//                            bucket policy but is NOT correct for R2.

import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import crypto from 'crypto';

const S3_ENDPOINT = process.env.S3_ENDPOINT || '';
const S3_BUCKET = process.env.S3_BUCKET || '';
const S3_ACCESS_KEY_ID = process.env.S3_ACCESS_KEY_ID || '';
const S3_SECRET_ACCESS_KEY = process.env.S3_SECRET_ACCESS_KEY || '';
const S3_REGION = process.env.S3_REGION || 'auto';
const S3_PUBLIC_URL_BASE = process.env.S3_PUBLIC_URL_BASE || '';

export function isObjectStorageConfigured() {
    return Boolean(S3_ENDPOINT && S3_BUCKET && S3_ACCESS_KEY_ID && S3_SECRET_ACCESS_KEY);
}

// Lazily created - only ever touched from behind an isObjectStorageConfigured()
// check, so there's no point constructing it (or validating creds) when the
// integration isn't set up at all.
let client = null;
function getClient() {
    if (!client) {
        client = new S3Client({
            endpoint: S3_ENDPOINT,
            region: S3_REGION,
            credentials: {
                accessKeyId: S3_ACCESS_KEY_ID,
                secretAccessKey: S3_SECRET_ACCESS_KEY,
            },
            // Path-style (https://endpoint/bucket/key) rather than
            // virtual-hosted (https://bucket.endpoint/key) - the safe
            // default for self-hosted/MinIO-style endpoints, which usually
            // don't have wildcard DNS/TLS set up for the virtual-hosted
            // form. R2 and Spaces both also accept path-style requests.
            forcePathStyle: true,
        });
    }
    return client;
}

const EXTENSION_BY_CONTENT_TYPE = {
    'audio/mpeg': 'mp3',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/ogg': 'ogg',
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'video/mp4': 'mp4',
    'video/quicktime': 'mov',
    'video/webm': 'webm',
};

function extensionForContentType(contentType) {
    const clean = (contentType || '').split(';')[0].trim().toLowerCase();
    if (EXTENSION_BY_CONTENT_TYPE[clean]) return EXTENSION_BY_CONTENT_TYPE[clean];
    const subtype = clean.split('/')[1];
    if (subtype && /^[a-z0-9]+$/.test(subtype)) return subtype;
    return 'bin';
}

export function publicUrlForKey(key) {
    if (S3_PUBLIC_URL_BASE) {
        return `${S3_PUBLIC_URL_BASE.replace(/\/+$/, '')}/${key}`;
    }
    // No public base configured - fall back to the path-style API endpoint
    // itself. Only correct if the bucket is actually reachable there (e.g.
    // a MinIO instance with a public bucket policy and no separate public
    // hostname) - S3_PUBLIC_URL_BASE should be set for anything else (R2,
    // Spaces, a MinIO behind a different public domain).
    return `${S3_ENDPOINT.replace(/\/+$/, '')}/${S3_BUCKET}/${key}`;
}

// Uploads a Buffer to the configured bucket and returns its public URL.
// `keyPrefix` groups objects under a folder-like prefix (e.g. 'voiceovers',
// 'covers') purely for readability in the bucket - it has no other effect.
// Throws if object storage isn't configured or the upload fails; callers
// must check isObjectStorageConfigured() first and are expected to catch
// failures themselves (this module never silently swallows an upload error).
export async function uploadBuffer(buffer, { contentType, keyPrefix = 'media' } = {}) {
    if (!isObjectStorageConfigured()) {
        throw new Error('Object storage is not configured (S3_* env vars unset)');
    }
    const ext = extensionForContentType(contentType);
    const key = `${keyPrefix}/${Date.now()}-${crypto.randomUUID()}.${ext}`;

    await getClient().send(new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: key,
        Body: buffer,
        ContentType: contentType || 'application/octet-stream',
    }));

    return { url: publicUrlForKey(key), key };
}

// Downloads whatever's at `sourceUrl` and re-uploads it into object storage -
// used to turn a kie.ai temp-hosted result URL into a permanent link before
// it expires. Throws on either the download or the upload failing; callers
// should catch and fall back to the original sourceUrl rather than failing
// the whole request over a re-hosting step.
export async function uploadFromUrl(sourceUrl, { keyPrefix = 'media' } = {}) {
    const res = await fetch(sourceUrl);
    if (!res.ok) {
        throw new Error(`Failed to download ${sourceUrl} for re-upload: ${res.status} ${res.statusText}`);
    }
    const contentType = res.headers.get('content-type') || 'application/octet-stream';
    const buffer = Buffer.from(await res.arrayBuffer());
    return uploadBuffer(buffer, { contentType, keyPrefix });
}
