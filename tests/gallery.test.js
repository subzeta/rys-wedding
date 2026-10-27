import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "../gallery-worker/src/index.js";
const PART_SIZE = 8 * 1024 * 1024;

class MemoryBucket {
  objects = new Map();
  uploads = new Map();
  async put(key, value, options = {}) {
    const data = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
    this.objects.set(key, { data, customMetadata: options.customMetadata || {} });
  }
  async head(key) {
    const object = this.objects.get(key);
    return object ? { size: object.data.byteLength } : null;
  }
  async delete(keys) {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.objects.delete(key);
  }
  async get(key) {
    const object = this.objects.get(key);
    if (!object) return null;
    return { size: object.data.byteLength, body: object.data, json: async () => JSON.parse(new TextDecoder().decode(object.data)) };
  }
  async list({ prefix, limit, cursor }) {
    const objects = [...this.objects.entries()].filter(([key]) => key.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b));
    const start = Number(cursor || 0);
    return { objects: objects.slice(start, start + limit).map(([key, object]) => ({ key, customMetadata: object.customMetadata })), truncated: objects.length > start + limit, cursor: String(start + limit) };
  }
  async createMultipartUpload(key) {
    const uploadId = crypto.randomUUID();
    this.uploads.set(uploadId, { key, parts: new Map() });
    return { uploadId };
  }
  resumeMultipartUpload(key, id) {
    return {
      uploadPart: async (number, body) => {
        const upload = this.uploads.get(id);
        assert.equal(upload.key, key);
        upload.parts.set(number, new Uint8Array(body));
        return { partNumber: number, etag: `etag-${number}` };
      },
      complete: async (parts) => {
        const upload = this.uploads.get(id);
        if (!upload) throw new Error("Already completed");
        const chunks = parts.map((part) => {
          if (part.etag !== `etag-${part.partNumber}` || !upload.parts.has(part.partNumber)) throw new Error("Invalid part");
          return upload.parts.get(part.partNumber);
        });
        const data = new Uint8Array(chunks.reduce((sum, part) => sum + part.byteLength, 0));
        let offset = 0;
        for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
        await this.put(key, data);
        this.uploads.delete(id);
        return { size: data.byteLength };
      },
    };
  }
}

function setup() {
  const env = {
    GALLERY: new MemoryBucket(),
    GUEST_CODE: "guest-test-code", ADMIN_CODE: "private-admin-test-code",
    SESSION_SECRET: "this-is-a-test-secret-with-more-than-32-characters",
    ALLOWED_ORIGINS: "https://subzeta.github.io", UPLOADS_ENABLED: "true",
    LOGIN_LIMIT: { limit: async () => ({ success: true }) },
    UPLOAD_LIMIT: { limit: async () => ({ success: true }) },
  };
  async function call(path, { token, body, method = "GET", origin, raw } = {}) {
    const headers = new Headers();
    if (token) headers.set("Authorization", `Bearer ${token}`);
    if (origin) headers.set("Origin", origin);
    if (body !== undefined) headers.set("Content-Type", "application/json");
    return worker.fetch(new Request(`https://gallery.example${path}`, {
      method, headers, body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
    }), env);
  }
  async function login(role = "guest") {
    const response = await call("/api/session", { method: "POST", body: { role, code: role === "admin" ? env.ADMIN_CODE : env.GUEST_CODE } });
    assert.equal(response.status, 200);
    return (await response.json()).token;
  }
  async function upload(token, overrides = {}) {
    const response = await call("/api/uploads", { token, method: "POST", body: { name: "baile.mov", size: 4, type: "video/quicktime", guestName: "Invitado", ...overrides } });
    assert.equal(response.status, 201);
    const { id } = await response.json();
    const part = await (await call(`/api/uploads/${id}/parts/1`, { token, method: "PUT", raw: new Uint8Array([1, 2, 3, 4]) })).json();
    return { id, parts: [part] };
  }
  return { env, call, login, upload };
}

test("sessions reject wrong codes, tampered tokens and foreign origins", async () => {
  const { call, login, env } = setup();
  assert.equal((await call("/api/items")).status, 401);
  assert.equal((await call("/api/session", { method: "POST", body: { role: "admin", code: env.GUEST_CODE } })).status, 401);
  const token = await login();
  assert.equal((await call("/api/items", { token: `${token}x` })).status, 401);
  assert.equal((await call("/api/items", { token, origin: "https://other.example" })).status, 403);
  const allowed = await call("/api/items", { token, origin: "https://subzeta.github.io" });
  assert.equal(allowed.headers.get("Access-Control-Allow-Origin"), "https://subzeta.github.io");
  assert.equal(allowed.headers.get("Cache-Control"), "no-store");
  assert.equal(allowed.headers.get("X-Content-Type-Options"), "nosniff");
  env.GUEST_CODE = "simple";
  assert.equal((await call("/api/session", { method: "POST", body: { role: "guest", code: "simple" } })).status, 200);
  assert.equal((await call("/api/session", { method: "POST", body: { role: "admin", code: "simple" } })).status, 401);
});

test("access codes ignore letter case and surrounding spaces without mixing guest and admin access", async () => {
  const { call, env } = setup();
  for (const [role, code] of [["guest", "  GuEsT-TEST-Code  "], ["admin", "  PRIVATE-admin-TEST-code  "]]) {
    const response = await call("/api/session", { method: "POST", body: { role, code } });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).role, role);
  }
  assert.equal((await call("/api/session", { method: "POST", body: { role: "admin", code: env.GUEST_CODE.toUpperCase() } })).status, 401);
  assert.equal((await call("/api/session", { method: "POST", body: { role: "guest", code: "wrong-test-code" } })).status, 401);
  env.GUEST_CODE = "Shared-test-access";
  env.ADMIN_CODE = " SHARED-TEST-ACCESS ";
  assert.equal((await call("/api/session", { method: "POST", body: { role: "guest", code: env.GUEST_CODE } })).status, 503);
});

test("incomplete files stay private; completion is idempotent; direct original access requires admin", async () => {
  const { call, login, upload } = setup();
  const guest = await login();
  const admin = await login("admin");
  const { id, parts } = await upload(guest);
  assert.deepEqual((await (await call("/api/items", { token: guest })).json()).items, []);
  const preview = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  assert.equal((await call(`/api/uploads/${id}/preview`, { token: guest, method: "PUT", raw: preview })).status, 200);
  assert.equal((await call(`/api/uploads/${id}/complete`, { token: guest, method: "POST", body: { parts } })).status, 200);
  assert.equal((await call(`/api/uploads/${id}/complete`, { token: guest, method: "POST", body: { parts } })).status, 200);
  const list = await (await call("/api/items", { token: guest })).json();
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].kind, "video");
  assert.equal(list.items[0].hasPreview, true);
  assert.equal(list.items[0].originalKey, undefined);
  assert.equal((await call(`/api/items/${id}/original`, { token: guest })).status, 403);
  assert.equal((await call(`/api/items/${id}/download`, { token: guest, method: "POST", body: {} })).status, 200);
  assert.equal((await call(`/api/items/${id}/preview`, { token: guest })).status, 200);
  const original = await call(`/api/items/${id}/original`, { token: admin });
  assert.equal(original.status, 200);
  assert.equal(original.headers.get("Content-Type"), "application/octet-stream");
  assert.match(original.headers.get("Content-Disposition"), /^attachment;/);
  assert.deepEqual(new Uint8Array(await original.arrayBuffer()), new Uint8Array([1, 2, 3, 4]));
  assert.equal((await call(`/api/uploads/${id}/preview`, { token: guest, method: "PUT", raw: preview })).status, 409);
});

test("only upload owner can write parts; server checks size, type, preview and missing parts", async () => {
  const { call, login, upload } = setup();
  const token = await login();
  const other = await login();
  const { id } = await upload(token);
  assert.equal((await call(`/api/uploads/${id}/parts/1`, { token: other, method: "PUT", raw: new Uint8Array(4) })).status, 403);
  assert.equal((await call(`/api/uploads/${id}/parts/1`, { token, method: "PUT", raw: new Uint8Array(5) })).status, 413);
  assert.equal((await call(`/api/uploads/${id}/parts/1`, { token, method: "PUT", raw: new Uint8Array(3) })).status, 400);
  assert.equal((await call(`/api/uploads/${id}/parts/2`, { token, method: "PUT", raw: new Uint8Array(4) })).status, 400);
  assert.equal((await call(`/api/uploads/${id}/preview`, { token, method: "PUT", raw: new TextEncoder().encode("<svg>bad</svg>") })).status, 400);
  assert.equal((await call(`/api/uploads/${id}/complete`, { token, method: "POST", body: { parts: [] } })).status, 400);
  const create = (body) => call("/api/uploads", { token, method: "POST", body: { name: "test", size: 1, guestName: "", ...body } });
  assert.equal((await create({ type: "text/html" })).status, 400);
  assert.equal((await create({ type: "image/jpeg", size: 101 * 1024 ** 2 })).status, 413);
  assert.equal((await create({ type: "video/mp4", size: 1024 ** 3 + 1 })).status, 413);
  assert.equal((await create({ type: "image/heic", size: 20 * 1024 ** 2 })).status, 201);
});

test("only admins can delete a published original, its preview and its upload record", async () => {
  const { call, login, upload, env } = setup();
  const guest = await login();
  const admin = await login("admin");
  const { id, parts } = await upload(guest);
  await call(`/api/uploads/${id}/preview`, { token: guest, method: "PUT", raw: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]) });
  await call(`/api/uploads/${id}/complete`, { token: guest, method: "POST", body: { parts } });
  const originalCount = env.GALLERY.objects.size;
  assert.equal((await call(`/api/items/${id}`, { token: guest, method: "DELETE" })).status, 403);
  assert.equal(env.GALLERY.objects.size, originalCount);
  assert.equal((await call(`/api/items/${id}`, { method: "DELETE" })).status, 401);
  assert.equal((await call(`/api/items/${id}`, { token: admin, method: "DELETE" })).status, 200);
  assert.equal(env.GALLERY.objects.size, 0);
  assert.equal((await call(`/api/items/${id}/original`, { token: admin })).status, 404);
});

test("a failed file deletion retains its record so an admin can retry", async () => {
  const { call, login, upload, env } = setup();
  const admin = await login("admin");
  const { id, parts } = await upload(admin);
  await call(`/api/uploads/${id}/complete`, { token: admin, method: "POST", body: { parts } });
  const remove = env.GALLERY.delete.bind(env.GALLERY);
  env.GALLERY.delete = async () => { throw new Error("Storage unavailable"); };
  assert.equal((await call(`/api/items/${id}`, { token: admin, method: "DELETE" })).status, 500);
  assert.ok(await env.GALLERY.head(`entries/${id}.json`));
  env.GALLERY.delete = remove;
  assert.equal((await call(`/api/items/${id}`, { token: admin, method: "DELETE" })).status, 200);
  assert.equal(env.GALLERY.objects.size, 0);
});

test("multipart combines real chunks, validates ordering and preserves originals without a preview", async () => {
  const { call, login } = setup();
  const token = await login();
  const admin = await login("admin");
  const created = await (await call("/api/uploads", { token, method: "POST", body: { name: "large.mp4", size: PART_SIZE + 3, type: "video/mp4", guestName: "" } })).json();
  const parts = [];
  for (const [number, raw] of [[1, new Uint8Array(PART_SIZE).fill(42)], [2, new Uint8Array([1, 2, 3])]]) {
    const response = await call(`/api/uploads/${created.id}/parts/${number}`, { token, method: "PUT", raw });
    assert.equal(response.status, 200);
    parts.push(await response.json());
  }
  assert.equal((await call(`/api/uploads/${created.id}/complete`, { token, method: "POST", body: { parts: [...parts].reverse() } })).status, 400);
  assert.equal((await call(`/api/uploads/${created.id}/complete`, { token, method: "POST", body: { parts } })).status, 200);
  const list = await (await call("/api/items", { token })).json();
  assert.equal(list.items[0].hasPreview, false);
  const body = new Uint8Array(await (await call(`/api/items/${created.id}/original`, { token: admin })).arrayBuffer());
  assert.equal(body.length, PART_SIZE + 3);
  assert.equal(body[PART_SIZE - 1], 42);
  assert.deepEqual(body.slice(-3), new Uint8Array([1, 2, 3]));
});

test("download links are signed, expire and grant access to exactly one original", async () => {
  const { call, login, upload } = setup();
  const admin = await login("admin");
  const { id, parts } = await upload(admin);
  await call(`/api/uploads/${id}/complete`, { token: admin, method: "POST", body: { parts } });
  const result = await (await call(`/api/items/${id}/download`, { token: admin, method: "POST", body: {} })).json();
  const link = new URL(result.url);
  const token = link.searchParams.get("token");
  assert.equal((await call(link.pathname + link.search)).status, 200);
  assert.equal((await call("/api/items", { token })).status, 403);
  assert.equal((await call(`/api/download/${id.replace(/.$/, id.endsWith("a") ? "b" : "a")}${link.search}`)).status, 403);
  const now = Date.now;
  try {
    Date.now = () => now() + 301000;
    assert.equal((await call(link.pathname + link.search)).status, 401);
  } finally { Date.now = now; }
});

test("closed uploads and rate limits are enforced by the backend", async () => {
  const { call, login, env } = setup();
  const token = await login();
  env.UPLOADS_ENABLED = "false";
  assert.equal((await call("/api/uploads", { token, method: "POST", body: {} })).status, 403);
  env.LOGIN_LIMIT.limit = async () => ({ success: false });
  const response = await call("/api/session", { method: "POST", body: { role: "guest", code: env.GUEST_CODE } });
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("Retry-After"), "60");
  env.UPLOADS_ENABLED = "true";
  env.UPLOAD_LIMIT.limit = async () => ({ success: false });
  assert.equal((await call("/api/uploads", { token, method: "POST", body: {} })).status, 429);
});

test("pagination exports every entry and malformed inputs don't leak internals", async () => {
  const { call, login, env } = setup();
  const token = await login("admin");
  for (let i = 0; i < 61; i++) {
    const record = { id: String(i).padStart(3, "0"), originalKey: `originals/${i}`, name: `foto-${i}.jpg`, kind: "photo", size: 1 };
    await env.GALLERY.put(`entries/${record.id}.json`, JSON.stringify(record), { customMetadata: { record: JSON.stringify(record) } });
  }
  const first = await (await call("/api/items", { token })).json();
  const second = await (await call(`/api/items?cursor=${first.cursor}`, { token })).json();
  assert.equal(first.items.length, 60);
  assert.equal(second.items.length, 1);
  assert.equal(second.cursor, null);
  assert.equal(new Set([...first.items, ...second.items].map((i) => i.id)).size, 61);
  assert.equal((await call("/api/uploads", { token, method: "POST", raw: "{" })).status, 400);
  assert.equal((await call("/api/uploads", { token, method: "POST", body: null })).status, 400);
  env.GALLERY.list = () => { throw new Error("secret-storage-detail"); };
  const response = await call("/api/items", { token });
  assert.equal(response.status, 500);
  assert.doesNotMatch(await response.text(), /secret-storage-detail/);
});

test("guests can download signed originals, while only admins can repair published covers", async () => {
  const { call, login, upload } = setup();
  const guest = await login();
  const admin = await login("admin");
  const { id, parts } = await upload(guest);
  await call(`/api/uploads/${id}/complete`, { token: guest, method: "POST", body: { parts } });
  const link = new URL((await (await call(`/api/items/${id}/download`, { token: guest, method: "POST", body: {} })).json()).url);
  const original = await call(link.pathname + link.search);
  assert.deepEqual(new Uint8Array(await original.arrayBuffer()), new Uint8Array([1, 2, 3, 4]));
  const raw = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  assert.equal((await call(`/api/items/${id}/preview`, { token: guest, method: "PUT", raw })).status, 403);
  assert.equal((await call(`/api/items/${id}/preview`, { token: admin, method: "PUT", raw: new Uint8Array([1, 2, 3, 4]) })).status, 400);
  assert.equal((await call(`/api/items/${id}/preview`, { token: admin, method: "PUT", raw })).status, 200);
  const items = await (await call("/api/items", { token: guest })).json();
  assert.equal(items.items[0].hasPreview, true);
  assert.deepEqual(new Uint8Array(await (await call(`/api/items/${id}/preview`, { token: guest })).arrayBuffer()), raw);
});
