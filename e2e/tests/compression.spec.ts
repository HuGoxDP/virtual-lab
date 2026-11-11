// e2e/tests/compression.spec.ts
//
// P3 / P3b — the static assets are served pre-compressed, proved on the wire.
//
// The image build pre-compresses the files it ships (Dockerfile.frontend,
// `gzip -9 -k`) and nginx answers with `gzip_static on` (nginx.conf). This spec
// pins what a client actually receives.
//
// **What it pins, precisely:** the bundle travels compressed to a client that
// asks (at least 2:1), and the compressed bytes decompressed are exactly the
// identity ones. It cannot tell gzip -9 at build time from nginx's on-the-fly
// gzip — both answer `Content-Encoding: gzip`, and only the byte count (and
// per-request CPU) differ. The before/after measurement of that difference
// lives in `code-foundations/P3/notes.md` (473,875 → 393,306 bytes).
//
// **Why a raw request and not Playwright's `request` fixture or an in-page
// `fetch`** — measured while settling P3b, both hide the answer:
//   * Playwright's `request` context sends `Accept-Encoding: gzip` but
//     transparently inflates the body and strips `Content-Encoding`, so the
//     compressed bytes are never observable (both requests report 1.5 MB).
//   * A `fetch` inside the page does not send `Accept-Encoding` at all under
//     this harness (the request leaves with no such header), so the identity
//     answer it gets is the correct one and proves nothing either way.
// A raw `node:http` request is the only thing here that sees the wire, and the
// wire is what P3 changed.

import { expect, test } from '@playwright/test';
import { get } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { BASE_URL } from '../helpers/api';

/** The biggest immutable file the stack serves, and the one every page pays for. */
const ENGINE_BUNDLE = '/engine/0.2.0/WebEngineTS.standalone.js';

/** One raw GET: the status, the headers of interest, and the bytes as sent. */
function rawGet(path: string, acceptEncoding?: string): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
    return new Promise((resolve, reject) => {
        const req = get(new URL(path, BASE_URL), {
            headers: acceptEncoding ? { 'Accept-Encoding': acceptEncoding } : {},
        }, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () => resolve({
                status: res.statusCode ?? 0,
                headers: res.headers as Record<string, string>,
                body: Buffer.concat(chunks),
            }));
        });
        req.on('error', reject);
    });
}

test('a gzip request is answered pre-compressed, much smaller', async () => {
    const identity = await rawGet(ENGINE_BUNDLE);
    expect(identity.status).toBe(200);
    expect(identity.body.byteLength).toBeGreaterThan(256 * 1024); // a sanity floor: this is the engine bundle
    expect(identity.headers['content-encoding']).toBeUndefined();

    const gzipped = await rawGet(ENGINE_BUNDLE, 'gzip');
    expect(gzipped.status).toBe(200);
    expect(gzipped.headers['content-encoding']).toBe('gzip');
    expect(gzipped.body.byteLength).toBeLessThan(identity.body.byteLength / 2);
});

test('the compressed body decompresses to exactly the identity one', async () => {
    const identity = await rawGet(ENGINE_BUNDLE);
    const gzipped = await rawGet(ENGINE_BUNDLE, 'gzip');
    const inflated = gunzipSync(gzipped.body);
    expect(inflated.equals(identity.body)).toBe(true);
});

test('an identity request is the whole file, uncompressed', async () => {
    const res = await rawGet(ENGINE_BUNDLE);
    expect(res.headers['content-encoding']).toBeUndefined();
    expect(res.body.byteLength).toBeGreaterThan(256 * 1024);
});
