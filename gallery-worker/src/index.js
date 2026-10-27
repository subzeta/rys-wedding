const MiB = 1024 * 1024;
const PART_SIZE = 8 * MiB;
const MAX_PHOTO = 100 * MiB;
const MAX_VIDEO = 1024 * MiB;
const MAX_PREVIEW = 500 * 1024;
const ID = /^\d{13}-[a-f0-9-]{36}$/;
const TYPES = new Map([
  ["image/jpeg", "photo"], ["image/png", "photo"], ["image/webp", "photo"],
  ["image/heic", "photo"], ["image/heif", "photo"], ["image/avif", "photo"],
  ["video/mp4", "video"], ["video/quicktime", "video"], ["video/webm", "video"],
  ["video/3gpp", "video"], ["video/x-m4v", "video"],
]);

function downloadName(name) {
  return name.replaceAll("\\", "/").split("/").pop().replace(/[\x00-\x1f\x7f]/g, "_") || "original";
}

function originalType(name) {
  const ext = name.split(".").pop().toLowerCase();
  return ({ jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", heic: "image/heic", heif: "image/heif", avif: "image/avif", mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm", "3gp": "video/3gpp", m4v: "video/x-m4v" })[ext] || "application/octet-stream";
}

function fail(status, message) {
  throw Object.assign(new Error(message), { status });
}

async function bytes(request, max) {
  if (Number(request.headers.get("content-length")) > max) fail(413, "Archivo demasiado grande.");
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      fail(413, "Archivo demasiado grande.");
    }
    chunks.push(value);
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function json(request) {
  try {
    return JSON.parse(new TextDecoder().decode(await bytes(request, 32 * 1024)));
  } catch (error) {
    if (error.status) throw error;
    fail(400, "Datos no válidos.");
  }
}

const encode = (data) => btoa(String.fromCharCode(...data)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
const decode = (value) => Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));

async function key(secret) {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function issue(env, role, scope = {}) {
  const payload = encode(new TextEncoder().encode(JSON.stringify({
    role, uid: crypto.randomUUID(), exp: Math.floor(Date.now() / 1000) + (role === "download" ? 300 : 12 * 3600), ...scope,
  })));
  const signature = await crypto.subtle.sign("HMAC", await key(env.SESSION_SECRET), new TextEncoder().encode(payload));
  return `${payload}.${encode(new Uint8Array(signature))}`;
}

async function authenticate(request, env, providedToken) {
  try {
    const token = providedToken ?? (request.headers.get("Authorization")?.replace(/^Bearer /, "") || "");
    if (token.length > 1024) throw new Error();
    const [payload, signature, extra] = token.split(".");
    if (extra || !signature) throw new Error();
    const valid = await crypto.subtle.verify("HMAC", await key(env.SESSION_SECRET), decode(signature), new TextEncoder().encode(payload));
    if (!valid) throw new Error();
    const session = JSON.parse(new TextDecoder().decode(decode(payload)));
    if (!Number.isFinite(session.exp) || session.exp <= Date.now() / 1000 || !["guest", "admin", "download"].includes(session.role) || typeof session.uid !== "string") throw new Error();
    return session;
  } catch {
    fail(401, "Vuelve a entrar con el código de la boda.");
  }
}

async function sameCode(input, expected) {
  if (typeof input !== "string") return false;
  const hash = (s) => crypto.subtle.digest("SHA-256", new TextEncoder().encode(s.trim().toLowerCase()));
  const [a, b] = await Promise.all([hash(input), hash(expected)]);
  const aa = new Uint8Array(a), bb = new Uint8Array(b);
  let difference = 0;
  for (let i = 0; i < aa.length; i++) difference |= aa[i] ^ bb[i];
  return difference === 0;
}

async function limit(binding, value) {
  if (!(await binding.limit({ key: value })).success) fail(429, "Demasiados intentos. Espera un minuto y vuelve a probar.");
}

async function readRecord(env, prefix, id) {
  const object = await env.GALLERY.get(`${prefix}/${id}.json`);
  if (!object) fail(404, "No encontramos este archivo.");
  return object.json();
}

function publicRecord(record, admin) {
  const { id, kind, name, uploadedAt, size, hasPreview, guestName } = record;
  return { id, kind, name, uploadedAt, size, hasPreview, guestName, ...(admin ? { originalKey: record.originalKey } : {}) };
}

async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  if (path === "/api/session" && method === "POST") {
    if (!env.GUEST_CODE || env.GUEST_CODE.trim().length < 6 || !env.ADMIN_CODE || env.ADMIN_CODE.trim().length < 16 || env.GUEST_CODE.trim().toLowerCase() === env.ADMIN_CODE.trim().toLowerCase() || !env.SESSION_SECRET || env.SESSION_SECRET.length < 32) {
      fail(503, "La galería todavía no está configurada.");
    }
    await limit(env.LOGIN_LIMIT, `login:${request.headers.get("CF-Connecting-IP") || "local"}`);
    const data = await json(request);
    if (!data || !["guest", "admin"].includes(data.role)) fail(400, "Acceso no válido.");
    const role = data.role;
    if (!await sameCode(data.code, role === "admin" ? env.ADMIN_CODE : env.GUEST_CODE)) fail(401, "El código no es correcto.");
    return Response.json({ token: await issue(env, role), role });
  }

  const downloadMatch = path.match(/^\/api\/download\/([^/]+)(?:\/[^/]+)?$/);
  if (downloadMatch && method === "GET") {
    const session = await authenticate(request, env, url.searchParams.get("token") || "");
    const id = downloadMatch[1];
    if (!ID.test(id) || session.role !== "download" || session.item !== id) fail(403, "Enlace de descarga no válido.");
    return originalResponse(env, await readRecord(env, "entries", id));
  }
  const session = await authenticate(request, env);
  if (session.role === "download") fail(403, "Acceso no permitido.");
  const admin = session.role === "admin";
  if (path === "/api/session" && method === "GET") {
    return Response.json({ role: session.role, uploadsEnabled: env.UPLOADS_ENABLED === "true", maxPhoto: MAX_PHOTO, maxVideo: MAX_VIDEO });
  }

  if (path === "/api/items" && method === "GET") {
    const cursor = url.searchParams.get("cursor") || undefined;
    if (cursor?.length > 2048) fail(400, "Página no válida.");
    const listed = await env.GALLERY.list({ prefix: "entries/", limit: 60, cursor, include: ["customMetadata"] });
    const items = listed.objects.map((object) => publicRecord(JSON.parse(object.customMetadata.record), admin));
    return Response.json({ items, cursor: listed.truncated ? listed.cursor : null });
  }

  const deleteMatch = path.match(/^\/api\/items\/([^/]+)$/);
  if (deleteMatch && method === "DELETE") {
    if (!admin) fail(403, "Solo Raquel y Sergio pueden eliminar recuerdos.");
    const id = deleteMatch[1];
    if (!ID.test(id)) fail(400, "Archivo no válido.");
    const record = await readRecord(env, "entries", id);
    // Keep the record until file deletion succeeds so a failed deletion can be retried.
    await env.GALLERY.delete([record.originalKey, `previews/${id}.jpg`, `uploads/${id}.json`]);
    await env.GALLERY.delete(`entries/${id}.json`);
    return Response.json({ id });
  }

  const itemMatch = path.match(/^\/api\/items\/([^/]+)\/(preview|original|download)$/);
  if (itemMatch) {
    const [, id, action] = itemMatch;
    if (!ID.test(id)) fail(400, "Archivo no válido.");
    if (action === "original" && !admin) fail(403, "Solo Raquel y Sergio pueden acceder directamente a los originales.");
    const record = await readRecord(env, "entries", id);
    if (action === "preview" && method === "PUT") {
      if (!admin) fail(403, "Solo Raquel y Sergio pueden reparar portadas.");
      const body = await bytes(request, MAX_PREVIEW);
      if (body.length < 4 || body[0] !== 0xff || body[1] !== 0xd8 || body[2] !== 0xff) fail(400, "Vista previa no válida.");
      await env.GALLERY.put(`previews/${id}.jpg`, body, { httpMetadata: { contentType: "image/jpeg" } });
      record.hasPreview = true;
      await env.GALLERY.put(`entries/${id}.json`, JSON.stringify(record), { customMetadata: { record: JSON.stringify(record) } });
      return Response.json({ ok: true });
    }
    if (action === "download" && method === "POST") {
      const token = await issue(env, "download", { item: id });
      return Response.json({ url: `${url.origin}/api/download/${id}/${encodeURIComponent(downloadName(record.name))}?token=${token}` });
    }
    if (method !== "GET" || action === "download") fail(405, "Método no permitido.");
    if (action === "original") return originalResponse(env, record);
    if (!record.hasPreview) fail(404, "Este archivo no tiene vista previa.");
    const object = await env.GALLERY.get(`previews/${id}.jpg`);
    if (!object) fail(404, "No encontramos este archivo.");
    return new Response(object.body, { headers: { "Content-Type": "image/jpeg", "Content-Length": String(object.size) } });
  }

  if (path === "/api/uploads" && method === "POST") {
    if (env.UPLOADS_ENABLED !== "true") fail(403, "La recogida de recuerdos está cerrada.");
    await limit(env.UPLOAD_LIMIT, session.uid);
    const data = await json(request);
    if (!data || typeof data.name !== "string" || !data.name.trim() || data.name.length > 240 || typeof data.guestName !== "string" || data.guestName.length > 80) fail(400, "Nombre no válido.");
    const kind = TYPES.get(data.type);
    if (!kind) fail(400, "Selecciona una foto o un vídeo compatible.");
    if (!Number.isSafeInteger(data.size) || data.size <= 0 || data.size > (kind === "photo" ? MAX_PHOTO : MAX_VIDEO)) fail(413, "El archivo supera el límite: 100 MB por foto o 1 GB por vídeo.");
    const id = `${String(9999999999999 - Date.now()).padStart(13, "0")}-${crypto.randomUUID()}`;
    const originalKey = `originals/${id}/${data.name.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
    const multipart = await env.GALLERY.createMultipartUpload(originalKey, { httpMetadata: { contentType: "application/octet-stream" } });
    const record = {
      id, originalKey, uploadId: multipart.uploadId, owner: session.uid,
      name: data.name, guestName: data.guestName.trim(), kind, size: data.size,
      uploadedAt: new Date().toISOString(),
    };
    await env.GALLERY.put(`uploads/${id}.json`, JSON.stringify(record));
    return Response.json({ id, partSize: PART_SIZE }, { status: 201 });
  }

  const uploadMatch = path.match(/^\/api\/uploads\/([^/]+)\/(parts\/(\d+)|preview|complete)$/);
  if (uploadMatch) {
    const [, id, action, partString] = uploadMatch;
    if (!ID.test(id)) fail(400, "Subida no válida.");
    const record = await readRecord(env, "uploads", id);
    if (record.owner !== session.uid) fail(403, "Esta subida pertenece a otra sesión.");
    if (Date.now() - Date.parse(record.uploadedAt) > 24 * 3600 * 1000) fail(410, "La subida ha caducado. Vuelve a seleccionar el archivo.");
    const existing = await env.GALLERY.head(`entries/${id}.json`);
    if (existing) {
      if (method === "POST" && action === "complete") return Response.json({ id });
      fail(409, "El archivo ya está guardado.");
    }
    if (env.UPLOADS_ENABLED !== "true") fail(403, "La recogida de recuerdos está cerrada.");
    const multipart = env.GALLERY.resumeMultipartUpload(record.originalKey, record.uploadId);
    const partCount = Math.ceil(record.size / PART_SIZE);
    if (method === "PUT" && partString) {
      const number = Number(partString);
      if (!Number.isSafeInteger(number) || number < 1 || number > partCount) fail(400, "Parte no válida.");
      const expected = Math.min(PART_SIZE, record.size - (number - 1) * PART_SIZE);
      const body = await bytes(request, expected);
      if (body.byteLength !== expected) fail(400, "La parte está incompleta. Vuelve a intentarlo.");
      return Response.json(await multipart.uploadPart(number, body));
    }
    if (method === "PUT" && action === "preview") {
      const body = await bytes(request, MAX_PREVIEW);
      if (body.length < 4 || body[0] !== 0xff || body[1] !== 0xd8 || body[2] !== 0xff) fail(400, "Vista previa no válida.");
      await env.GALLERY.put(`previews/${id}.jpg`, body, { httpMetadata: { contentType: "image/jpeg" } });
      return Response.json({ ok: true });
    }
    if (method === "POST" && action === "complete") {
      const data = await json(request);
      if (!Array.isArray(data?.parts) || data.parts.length !== partCount || data.parts.some((p, i) => !p || p.partNumber !== i + 1 || typeof p.etag !== "string" || p.etag.length > 256 || !p.etag)) fail(400, "Faltan partes de la subida.");
      // A lost response after completion must not force the guest to upload again.
      const original = await env.GALLERY.head(record.originalKey) || await multipart.complete(data.parts);
      if (original.size !== record.size) fail(400, "El tamaño recibido no coincide. El archivo no se ha publicado.");
      record.hasPreview = Boolean(await env.GALLERY.head(`previews/${id}.jpg`));
      const published = publicRecord(record, true);
      await env.GALLERY.put(`entries/${id}.json`, JSON.stringify(published), { customMetadata: { record: JSON.stringify(published) } });
      return Response.json({ id });
    }
  }
  fail(404, "Esta dirección no existe.");
}

async function originalResponse(env, record) {
  const object = await env.GALLERY.get(record.originalKey);
  if (!object) fail(404, "No encontramos este archivo.");
  const name = downloadName(record.name);
  const fallback = name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-zA-Z0-9._-]/g, "_");
  return new Response(object.body, { headers: {
    "Content-Type": originalType(name), "Content-Length": String(object.size),
    "Content-Disposition": `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name).replaceAll("'", "%27")}`,
  } });
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin");
    const allowed = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim());
    const headers = new Headers({
      "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer", "Vary": "Origin",
    });
    if (origin && !allowed.includes(origin)) return Response.json({ error: "Origen no permitido." }, { status: 403, headers });
    if (origin) headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
    headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    let response;
    try {
      response = await route(request, env);
    } catch (error) {
      // Never return Cloudflare errors, storage keys or secrets to the browser.
      response = Response.json({ error: error.status ? error.message : "No se ha podido completar la operación. Vuelve a intentarlo." }, { status: error.status || 500 });
    }
    const result = new Response(response.body, response);
    for (const [name, value] of headers) result.headers.set(name, value);
    if (response.status === 429) result.headers.set("Retry-After", "60");
    return result;
  },
};
