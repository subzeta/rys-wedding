import { API_URL } from "./config.js";

const $ = (id) => document.getElementById(id);
const base = API_URL.replace(/\/$/, "");
let token = sessionStorage.getItem("gallery-session") || "";
let role = "guest";
let loginRole = "guest";
let cursor = null;
let itemCount = 0;
let loading = false;
let uploading = false;
let settings;
const queue = [];
const previewURLs = new Set();

function message(text, error = false) {
  $("message").textContent = text;
  $("message").classList.toggle("error", error);
}

async function api(path, options = {}) {
  if (!base) throw new Error("Estamos preparando el álbum. Vuelve dentro de un poquito.");
  const headers = new Headers(options.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(base + path, { ...options, headers, referrerPolicy: "no-referrer" });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    const error = Object.assign(new Error(data.error || "No se ha podido conectar. Vuelve a intentarlo."), { status: response.status });
    if (response.status === 401 && token) {
      logout();
      message("Tu sesión ha caducado. Entra otra vez para continuar.", true);
    }
    throw error;
  }
  return response;
}

const post = async (path, body) => (await api(path, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
})).json();

function releasePreviews() {
  for (const url of previewURLs) URL.revokeObjectURL(url);
  previewURLs.clear();
}

function logout() {
  token = "";
  sessionStorage.removeItem("gallery-session");
  $("viewer").close();
  $("viewer-image").removeAttribute("src");
  $("grid").replaceChildren();
  releasePreviews();
  $("album").hidden = true;
  $("login-section").hidden = false;
  $("access-code").focus();
}

async function openAlbum() {
  settings = await (await api("/api/session")).json();
  role = settings.role;
  $("admin-tools").hidden = role !== "admin";
  $("file-picker").hidden = !settings.uploadsEnabled;
  $("uploads-closed").hidden = settings.uploadsEnabled;
  $("login-section").hidden = true;
  $("album").hidden = false;
  await loadItems(true);
}

$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  message("Entrando…");
  try {
    const result = await post("/api/session", { code: $("access-code").value, role: loginRole });
    token = result.token;
    sessionStorage.setItem("gallery-session", token);
    // A new login creates a new upload owner; retry unfinished files from the start.
    for (const item of queue.filter((item) => !item.done)) {
      item.id = null;
      item.parts = [];
      item.previewAttempted = false;
      item.noPreview = false;
    }
    $("access-code").value = "";
    await openAlbum();
    message("");
  } catch (error) {
    message(error.message, true);
  } finally {
    button.disabled = false;
  }
});

$("admin-toggle").addEventListener("click", () => {
  loginRole = loginRole === "guest" ? "admin" : "guest";
  $("login-title").textContent = loginRole === "admin" ? "Acceso privado" : "Un álbum entre todos";
  $("admin-toggle").textContent = loginRole === "admin" ? "Volver al acceso de invitados" : "Acceso de Raquel y Sergio";
  $("access-code").value = "";
  $("access-code").focus();
});
$("logout").addEventListener("click", logout);
$("refresh").addEventListener("click", () => loadItems(true).catch((error) => message(error.message, true)));
$("load-more").addEventListener("click", () => loadItems().catch((error) => message(error.message, true)));
$("close-viewer").addEventListener("click", () => $("viewer").close());
$("viewer").addEventListener("click", (event) => { if (event.target === $("viewer")) $("viewer").close(); });

async function loadItems(reset = false) {
  if (loading) return;
  loading = true;
  $("refresh").disabled = true;
  $("load-more").disabled = true;
  try {
    const result = await (await api(`/api/items${!reset && cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`)).json();
    if (reset) {
      $("viewer").close();
      $("grid").replaceChildren();
      releasePreviews();
      itemCount = 0;
    }
    cursor = result.cursor;
    itemCount += result.items.length;
    $("album-count").textContent = `${itemCount}${cursor ? "+" : ""} ${itemCount === 1 ? "recuerdo compartido" : "recuerdos compartidos"}`;
    $("empty").hidden = itemCount !== 0;
    $("load-more").hidden = !cursor;
    const tiles = result.items.map(addTile);
    // Limit simultaneous downloads to keep mobile connections responsive.
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, tiles.length) }, async () => {
      while (next < tiles.length) {
        const index = next++;
        await loadPreview(result.items[index], tiles[index]);
      }
    }));
  } finally {
    loading = false;
    $("refresh").disabled = false;
    $("load-more").disabled = false;
  }
}

function addTile(item) {
  const card = document.createElement("article");
  card.className = "media-card";
  const tile = document.createElement(item.kind === "photo" && item.hasPreview ? "button" : "div");
  tile.className = "media-tile";
  if (tile.tagName === "BUTTON") {
    tile.type = "button";
    tile.setAttribute("aria-label", `Ampliar foto${item.guestName ? ` de ${item.guestName}` : ""}`);
  }
  const placeholder = document.createElement("span");
  placeholder.className = "placeholder";
  placeholder.textContent = item.kind === "video" ? "▤" : "♡";
  tile.append(placeholder);
  card.append(tile);
  if (item.kind === "video") {
    const badge = document.createElement("span");
    badge.className = "media-badge";
    badge.textContent = "Vídeo guardado";
    card.append(badge);
  }
  const caption = document.createElement("p");
  caption.className = "media-caption";
  caption.textContent = item.guestName || (item.kind === "video" ? "Un recuerdo para después" : "Un día para recordar");
  card.append(caption);
  if (role === "admin") {
    const download = document.createElement("button");
    download.className = "btn-link download-original";
    download.type = "button";
    download.textContent = "Descargar original";
    download.addEventListener("click", async () => {
      download.disabled = true;
      try {
        const result = await post(`/api/items/${item.id}/download`, {});
        const link = document.createElement("a");
        link.href = result.url;
        link.download = item.name;
        link.referrerPolicy = "no-referrer";
        document.body.append(link);
        link.click();
        link.remove();
      } catch (error) { message(error.message, true); }
      finally { download.disabled = false; }
    });
    card.append(download);
  }
  $("grid").append(card);
  return tile;
}

async function loadPreview(item, tile) {
  if (!item.hasPreview) return;
  try {
    const response = await api(`/api/items/${item.id}/preview`);
    const blob = await response.blob();
    if (!tile.isConnected || !token) return;
    const url = URL.createObjectURL(blob);
    previewURLs.add(url);
    const img = document.createElement("img");
    img.src = url;
    img.alt = item.kind === "video" ? "Portada del vídeo. Sin reproducción." : (item.guestName ? `Foto de ${item.guestName}` : "Foto de nuestra boda");
    img.loading = "lazy";
    tile.replaceChildren(img);
    if (item.kind === "photo") tile.addEventListener("click", () => {
      $("viewer-image").src = url;
      $("viewer-image").alt = img.alt;
      $("viewer-caption").textContent = item.guestName || "Raquel & Sergio · 24 de octubre de 2026";
      $("viewer").showModal();
    });
  } catch (error) {
    if (error.status !== 401) message("Alguna portada no ha cargado. Puedes pulsar «Actualizar álbum» para volver a intentarlo.", true);
  }
}

function mime(file) {
  const ext = file.name.split(".").pop().toLowerCase();
  const types = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", heic: "image/heic", heif: "image/heif", avif: "image/avif", mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm", "3gp": "video/3gpp", m4v: "video/x-m4v" };
  return Object.hasOwn(types, ext) ? types[ext] : file.type;
}

$("files").addEventListener("change", () => {
  for (const file of $("files").files) {
    const type = mime(file);
    const max = type.startsWith("image/") ? settings.maxPhoto : settings.maxVideo;
    const row = document.createElement("li");
    row.className = "upload-row";
    const info = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = file.name;
    const status = document.createElement("small");
    const progress = document.createElement("progress");
    progress.max = 100;
    progress.value = 0;
    progress.setAttribute("aria-label", `Subida de ${file.name}`);
    info.append(name, status, progress);
    row.append(info);
    const item = { file, type, row, status, progress, parts: [], guestName: $("guest-name").value.trim(), ready: true };
    if (!file.size || file.size > max || !/^(image|video)\//.test(type)) {
      item.ready = false;
      status.textContent = "No se puede subir: formato no compatible o tamaño superior al límite.";
      row.classList.add("has-error");
    } else { status.textContent = "En espera"; }
    $("upload-queue").append(row);
    queue.push(item);
  }
  $("files").value = "";
  runQueue();
});

async function retry(action) {
  for (let attempt = 0; ; attempt++) {
    try { return await action(); }
    catch (error) {
      if (attempt >= 2 || (error.status && error.status < 500 && error.status !== 429)) throw error;
      await new Promise((resolve) => setTimeout(resolve, error.status === 429 ? 61000 : 1500 * (attempt + 1)));
    }
  }
}

function uploadPart(item, partNumber, chunk) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", `${base}/api/uploads/${item.id}/parts/${partNumber}`);
    xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.timeout = 180000;
    xhr.upload.onprogress = (event) => {
      const sent = (partNumber - 1) * item.partSize + event.loaded;
      const percent = Math.min(99, Math.floor(sent / item.file.size * 100));
      item.progress.value = percent;
      item.status.textContent = `Subiendo… ${percent} %`;
    };
    xhr.onload = () => {
      let data;
      try { data = JSON.parse(xhr.responseText); } catch { data = {}; }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(Object.assign(new Error(data.error || "La subida no se ha completado."), { status: xhr.status }));
    };
    xhr.onerror = xhr.ontimeout = () => reject(new Error("Se ha interrumpido la conexión. Pulsa reintentar."));
    xhr.send(chunk);
  });
}

async function runQueue() {
  if (uploading || !token) return;
  uploading = true;
  $("logout").disabled = true;
  let wakeLock;
  try { wakeLock = await navigator.wakeLock?.request("screen"); } catch { /* Some browsers cannot keep the screen awake. */ }
  let saved = 0;
  try {
    for (const item of queue) {
      if (!item.ready || item.done) continue;
      item.ready = false;
      item.row.classList.remove("has-error");
      item.retryButton?.remove();
      try {
        if (!item.id) {
          item.status.textContent = "Preparando recuerdo…";
          const result = await post("/api/uploads", { name: item.file.name, type: item.type, size: item.file.size, guestName: item.guestName });
          item.id = result.id;
          item.partSize = result.partSize;
        }
        const count = Math.ceil(item.file.size / item.partSize);
        for (let number = item.parts.length + 1; number <= count; number++) {
          const chunk = item.file.slice((number - 1) * item.partSize, number * item.partSize);
          item.parts.push(await retry(() => uploadPart(item, number, chunk)));
        }
        item.status.textContent = "Preparando portada…";
        if (!item.previewAttempted) {
          item.previewAttempted = true;
          const preview = await makePreview(item.file, item.type).catch(() => null);
          if (preview) {
            try {
              await retry(() => api(`/api/uploads/${item.id}/preview`, { method: "PUT", headers: { "Content-Type": "image/jpeg" }, body: preview }));
            } catch { item.noPreview = true; }
          } else { item.noPreview = true; }
        }
        item.status.textContent = "Guardando…";
        await retry(() => post(`/api/uploads/${item.id}/complete`, { parts: item.parts }));
        item.done = true;
        item.file = null;
        item.progress.value = 100;
        item.status.textContent = item.noPreview ? "Guardado ✓ · Original conservado, sin portada disponible" : "Guardado ✓";
        saved++;
      } catch (error) {
        item.status.textContent = error.message;
        item.row.classList.add("has-error");
        item.retryButton = document.createElement("button");
        item.retryButton.className = "btn-link";
        item.retryButton.type = "button";
        item.retryButton.textContent = "Reintentar";
        item.retryButton.addEventListener("click", () => { item.ready = true; runQueue(); });
        item.row.append(item.retryButton);
        if (error.status === 401) {
          logout();
          break;
        }
      }
    }
    if (saved && token) {
      message("¡Recuerdos guardados! Gracias por compartirlos con nosotros.");
      await loadItems(true).catch((error) => message(`Tus archivos se han guardado. ${error.message}`, true));
    }
  } finally {
    uploading = false;
    $("logout").disabled = false;
    await wakeLock?.release().catch(() => {});
    if (token && queue.some((item) => item.ready && !item.done)) runQueue();
  }
}

async function makePreview(file, type) {
  const url = URL.createObjectURL(file);
  const video = type.startsWith("video/");
  const media = document.createElement(video ? "video" : "img");
  try {
    if (video) {
      media.muted = true;
      media.playsInline = true;
      media.preload = "auto";
    }
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("No se pudo crear la portada.")), 20000);
      const finish = (action) => { clearTimeout(timer); media.onerror = media.onload = media.onloadeddata = media.onseeked = null; action(); };
      media.onerror = () => finish(() => reject(new Error("Formato sin vista previa.")));
      if (video) {
        media.onloadeddata = () => {
          if (!Number.isFinite(media.duration) || media.duration < .1) return finish(resolve);
          media.onseeked = () => finish(resolve);
          media.currentTime = Math.min(.5, media.duration / 2);
        };
      } else { media.onload = () => finish(resolve); }
      media.src = url;
    });
    const width = video ? media.videoWidth : media.naturalWidth;
    const height = video ? media.videoHeight : media.naturalHeight;
    if (!width || !height) throw new Error("Sin imagen disponible.");
    const scale = Math.min(1, 1600 / Math.max(width, height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext("2d");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(media, 0, 0, canvas.width, canvas.height);
    for (const quality of [.82, .65, .45]) {
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
      if (blob && blob.size <= 500 * 1024) return blob;
    }
    return null;
  } finally {
    media.onerror = media.onload = media.onloadeddata = media.onseeked = null;
    media.removeAttribute("src");
    if (video) media.load();
    URL.revokeObjectURL(url);
  }
}

window.addEventListener("beforeunload", (event) => {
  if (uploading || queue.some((item) => item.file && !item.done && item.id)) {
    event.preventDefault();
    event.returnValue = "";
  }
});

if (!base) message("Estamos preparando el álbum. Pronto podréis compartir vuestros recuerdos.");
else if (token) openAlbum().catch((error) => message(error.message, true));
