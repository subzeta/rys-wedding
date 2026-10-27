import { API_URL } from "./config.js";
import { prepareDownloads, cancelDownloads, downloadFile as startDownload } from "./downloads.js?v=20261027-7";

const $ = (id) => document.getElementById(id);
const base = API_URL.replace(/\/$/, "");
let token = sessionStorage.getItem("gallery-session") || "";
let role = "guest";
let loginRole = "guest";
let cursor = null;
let itemCount = 0;
let mediaFilter = "";
let loading = null;
let uploading = false;
let settings;
const queue = [];
const previewURLs = new Set();
const recentlyUploaded = new Set();
let itemToDelete = null;
let deleting = false;
const toastTimers = new Map();
const selected = new Set();
let preparingDownload = false;
let viewedTile = null;
let viewerBusy = false;
let playbackRequest = 0;

function updateSelection() {
  $("download-selected").textContent = `Descargar selección (${selected.size})`;
  $("download-selected").disabled = preparingDownload || !selected.size;
  $("download-all").disabled = preparingDownload || !itemCount;
  $("download-all").textContent = mediaFilter === "photo" ? "Descargar fotos" : mediaFilter === "video" ? "Descargar vídeos" : "Descargar todo";
  $("clear-selection").hidden = !selected.size;
}


async function downloadMultiple(all) {
  if (preparingDownload) return;
  preparingDownload = true;
  updateSelection();
  $("download-dialog").showModal();
  try {
    await prepareDownloads({ api, post, selected: all ? null : [...selected], kind: mediaFilter, startDownload });
  } finally { preparingDownload = false; updateSelection(); }
}

$("close-download").addEventListener("click", () => $("download-dialog").close());
$("download-dialog").addEventListener("close", cancelDownloads);
$("download-selected").addEventListener("click", () => downloadMultiple(false));
$("download-all").addEventListener("click", () => downloadMultiple(true));
$("clear-selection").addEventListener("click", () => {
  selected.clear();
  document.querySelectorAll(".select-item input").forEach((input) => { input.checked = false; });
  updateSelection();
});

function dismissLater(element, enabled = true) {
  clearTimeout(toastTimers.get(element));
  if (!enabled) return;
  toastTimers.set(element, setTimeout(() => {
    // Leave actions available while someone is reading or using the toast.
    if (element.matches(":hover, :focus-within")) dismissLater(element);
    else element.hidden = true;
  }, 5000));
}

$("cancel-delete").addEventListener("click", () => $("delete-dialog").close());
$("delete-dialog").addEventListener("cancel", (event) => { if (deleting) event.preventDefault(); });
$("confirm-delete").addEventListener("click", async () => {
  if (!itemToDelete || deleting) return;
  deleting = true;
  $("confirm-delete").disabled = $("cancel-delete").disabled = true;
  $("confirm-delete").textContent = "Eliminando…";
  try {
    await api(`/api/items/${itemToDelete.id}`, { method: "DELETE" });
    $("delete-dialog").close();
    itemToDelete = null;
    await loadItems(true);
    message("Recuerdo eliminado del álbum.");
  } catch (error) {
    $("delete-dialog").close();
    message(error.message, true);
  } finally {
    deleting = false;
    $("confirm-delete").disabled = $("cancel-delete").disabled = false;
    $("confirm-delete").textContent = "Eliminar definitivamente";
  }
});

function clearCompletedUploads() {
  for (let i = queue.length - 1; i >= 0; i--) {
    if (queue[i].done) { queue[i].row.remove(); queue.splice(i, 1); }
  }
}

function openUpload() {
  if (!$("upload-dialog").open) {
    if (!uploading) clearCompletedUploads();
    $("upload-dialog").showModal();
  }
}

async function showNewItems() {
  $("upload-dialog").close();
  if (!$("grid").querySelector(".is-new") && recentlyUploaded.size) await loadItems(true);
  const target = $("grid").querySelector(".is-new") || $("grid");
  target.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth", block: "center" });
  target.focus({ preventScroll: true });
}

function updateUploadStatus() {
  if (!queue.length || !token) {
    dismissLater($("upload-status"), false);
    $("upload-status").hidden = true;
    return;
  }
  const done = queue.filter((item) => item.done).length;
  const failed = queue.filter((item) => item.failed).length;
  const total = queue.length;
  const active = uploading || queue.some((item) => !item.done && !item.failed);
  const title = active ? (done + failed === total ? "Terminando…" : `Subiendo ${done + failed + 1} de ${total}`)
    : failed ? `${done} ${done === 1 ? "recuerdo guardado" : "recuerdos guardados"} · ${failed} sin subir`
    : "¡Ya están en el álbum!";
  const detail = active ? "Puedes seguir mirando el álbum. Mantén la página abierta."
    : failed ? "Revisa los archivos pendientes y vuelve a intentarlo."
    : `${done} ${done === 1 ? "recuerdo compartido" : "recuerdos compartidos"}. Gracias por guardar este día con nosotros.`;
  $("upload-status").hidden = false;
  $("upload-status").classList.toggle("is-success", !active && !failed);
  $("upload-status").classList.toggle("has-errors", !active && Boolean(failed));
  for (const [id, text] of [["upload-status-title", title], ["upload-status-detail", detail]]) {
    if ($(id).textContent !== text) $(id).textContent = text;
  }
  $("upload-status-icon").textContent = active ? "↑" : failed ? "!" : "✓";
  $("upload-total-progress").value = queue.reduce((sum, item) => sum + item.progress.value, 0) / total;
  $("upload-total-progress").hidden = !active;
  $("dismiss-upload-status").hidden = active;
  $("upload-status-action").textContent = active ? "Ver progreso" : failed ? "Revisar subidas" : "Ver mis recuerdos";
  dismissLater($("upload-status"), !active);
}

function allowDiscard(item) {
  if (item.discardButton) return;
  item.discardButton = document.createElement("button");
  item.discardButton.className = "btn-link";
  item.discardButton.type = "button";
  item.discardButton.textContent = "Quitar";
  item.discardButton.setAttribute("aria-label", `Quitar ${item.file.name} de la lista de subidas`);
  item.discardButton.addEventListener("click", () => {
    item.row.remove();
    const index = queue.indexOf(item);
    if (index !== -1) queue.splice(index, 1);
    updateUploadStatus();
  });
  item.row.append(item.discardButton);
}

document.querySelectorAll("[data-open-upload]").forEach((button) => button.addEventListener("click", openUpload));
$("close-upload").addEventListener("click", () => $("upload-dialog").close());
$("dismiss-upload-status").addEventListener("click", () => { $("upload-status").hidden = true; });
$("upload-status-action").addEventListener("click", () => {
  if (uploading || queue.some((item) => item.failed)) openUpload();
  else showNewItems().catch((error) => message(error.message, true));
});

function message(text, error = false, persistent = false) {
  $("message").textContent = text;
  $("message").classList.toggle("error", error);
  $("message").hidden = !text;
  dismissLater($("message"), Boolean(text) && !persistent);
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
  $("download-dialog").close();
  selected.clear();
  $("download-status").textContent = "";
  token = "";
  sessionStorage.removeItem("gallery-session");
  closeViewer();
  $("upload-dialog").close();
  $("delete-dialog").close();
  $("upload-status").hidden = true;
  document.body.classList.remove("in-album");
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
  document.querySelectorAll("[data-open-upload]").forEach((button) => { button.hidden = !settings.uploadsEnabled; });
  $("uploads-closed").hidden = settings.uploadsEnabled;
  $("login-section").hidden = true;
  $("album").hidden = false;
  document.body.classList.add("in-album");
  await loadItems(true);
}

$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  message("Entrando…", false, true);
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
$("close-viewer").addEventListener("click", () => closeViewer());
$("viewer").addEventListener("click", (event) => { if (event.target === $("viewer")) closeViewer(); });

document.querySelectorAll("[data-media-filter]").forEach((button) => {
  button.addEventListener("click", async () => {
    if (button.dataset.mediaFilter === mediaFilter) return;
    const previousFilter = mediaFilter;
    mediaFilter = button.dataset.mediaFilter;
    document.querySelectorAll("[data-media-filter]").forEach((option) => {
      option.setAttribute("aria-pressed", String(option === button));
      option.disabled = true;
    });
    try { await loadItems(true); }
    catch (error) {
      mediaFilter = previousFilter;
      updateAlbumCount();
      document.querySelectorAll("[data-media-filter]").forEach((option) => option.setAttribute("aria-pressed", String(option.dataset.mediaFilter === mediaFilter)));
      message(error.message, true);
    }
  });
});

function viewerTiles() {
  return [...$("grid").querySelectorAll("button.media-tile")].filter((tile) => tile.dataset.kind === "video" || tile.querySelector("img"));
}

function updateViewerNavigation() {
  const photos = viewerTiles();
  const index = photos.indexOf(viewedTile);
  $("previous-photo").disabled = viewerBusy || index <= 0;
  $("next-photo").disabled = viewerBusy || (index === photos.length - 1 && !cursor);
  $("viewer-position").textContent = `${index + 1} / ${photos.length}${cursor ? "+" : ""}`;
}

function closeViewer() {
  stopVideo();
  $("viewer").close();
}

function stopVideo() {
  playbackRequest++;
  $("viewer-video").pause();
  $("viewer-video").removeAttribute("src");
  $("viewer-video").removeAttribute("poster");
  $("viewer-video").load();
}

async function showMedia(tile) {
  if (tile.dataset.kind !== "video" && !tile.querySelector("img")) return;
  viewedTile = tile;
  stopVideo();
  const request = playbackRequest;
  const img = tile.querySelector("img");
  const video = tile.dataset.kind === "video";
  $("viewer-image").hidden = video;
  $("viewer-video").hidden = !video;
  $("viewer-download").hidden = !video;
  $("viewer").classList.toggle("showing-video", video);
  if (img && !video) {
    $("viewer-image").src = img.src;
    $("viewer-image").alt = img.alt;
  }
  $("viewer-caption").textContent = tile.querySelector(".media-caption").textContent || "Raquel & Sergio · 24 de octubre de 2026";
  $("viewer-status").textContent = video ? "Preparando vídeo…" : "";
  updateViewerNavigation();
  if (!$("viewer").open) $("viewer").showModal();
  if (!video) return;
  if (img) $("viewer-video").poster = img.src;
  try {
    const result = await post(`/api/items/${tile.closest(".media-card").dataset.id}/play`, {});
    if (request !== playbackRequest || !$("viewer").open) return;
    $("viewer-video").src = result.url;
    $("viewer-status").textContent = "Pulsa ▶ para reproducir.";
  } catch (error) {
    if (request === playbackRequest) $("viewer-status").textContent = error.message;
  }
}

$("viewer-video").addEventListener("playing", () => { $("viewer-status").textContent = ""; });
$("viewer-video").addEventListener("error", () => {
  if ($("viewer-video").hasAttribute("src")) $("viewer-status").textContent = "Este vídeo no se puede reproducir en tu navegador. Puedes descargar el original.";
});
$("viewer-download").addEventListener("click", async () => {
  const tile = viewedTile;
  if (!tile) return;
  $("viewer-download").disabled = true;
  try {
    const result = await post(`/api/items/${tile.closest(".media-card").dataset.id}/download`, {});
    await startDownload(result.url, tile.dataset.name);
  } catch (error) { $("viewer-status").textContent = error.message; }
  finally { $("viewer-download").disabled = false; }
});

async function movePhoto(direction) {
  if (!viewedTile || viewerBusy) return;
  viewerBusy = true;
  updateViewerNavigation();
  const current = viewedTile;
  try {
    let photos = viewerTiles();
    while (direction > 0 && photos.indexOf(current) === photos.length - 1 && cursor) {
      $("viewer-status").textContent = "Cargando más recuerdos…";
      await loadItems();
      if (!$("viewer").open || viewedTile !== current) return;
      photos = viewerTiles();
    }
    const next = photos[photos.indexOf(current) + direction];
    $("viewer-status").textContent = "";
    if (next) await showMedia(next);
  } catch (error) { $("viewer-status").textContent = error.message; }
  finally { viewerBusy = false; updateViewerNavigation(); }
}

$("previous-photo").addEventListener("click", () => movePhoto(-1));
$("next-photo").addEventListener("click", () => movePhoto(1));
$("viewer").addEventListener("close", () => { viewedTile = null; stopVideo(); });
$("viewer").addEventListener("cancel", stopVideo);
document.addEventListener("keydown", (event) => {
  if (!$("viewer").open || event.target === $("viewer-video")) return;
  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
    event.preventDefault();
    movePhoto(event.key === "ArrowLeft" ? -1 : 1);
  }
});

async function loadItems(reset = false) {
  if (loading) {
    await loading;
    return reset ? loadItems(true) : undefined;
  }
  loading = renderItems(reset);
  try { return await loading; }
  finally { loading = null; }
}

function updateAlbumCount() {
  const label = mediaFilter === "photo" ? (itemCount === 1 ? "foto" : "fotos") : mediaFilter === "video" ? (itemCount === 1 ? "vídeo" : "vídeos") : (itemCount === 1 ? "recuerdo compartido" : "recuerdos compartidos");
  $("album-count").textContent = `${itemCount}${cursor ? "+" : ""} ${label}`;
  $("album-title").textContent = mediaFilter === "photo" ? "Fotos" : mediaFilter === "video" ? "Vídeos" : "Todos los recuerdos";
  $("empty-title").textContent = mediaFilter === "video" ? "Todavía no hay vídeos" : mediaFilter === "photo" ? "Todavía no hay fotos" : "Un día así merece muchas fotos";
  $("empty").hidden = itemCount !== 0;
  updateSelection();
}

async function renderItems(reset) {
  $("refresh").disabled = true;
  $("load-more").disabled = true;
  $("grid").setAttribute("aria-busy", "true");
  $("download-selected").disabled = $("download-all").disabled = true;
  document.querySelectorAll("[data-media-filter]").forEach((button) => { button.disabled = true; });
  try {
    let pageCursor = reset ? null : cursor;
    let result;
    do {
      const query = new URLSearchParams();
      if (mediaFilter) query.set("kind", mediaFilter);
      if (pageCursor) query.set("cursor", pageCursor);
      result = await (await api(`/api/items${query.size ? `?${query}` : ""}`)).json();
      pageCursor = result.cursor;
    } while (!result.items.length && pageCursor);
    if (reset) {
      closeViewer();
      $("grid").replaceChildren();
      releasePreviews();
      itemCount = 0;
      selected.clear();
    }
    cursor = result.cursor;
    itemCount += result.items.length;
    updateAlbumCount();
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
    $("refresh").disabled = false;
    $("load-more").disabled = false;
    $("grid").setAttribute("aria-busy", "false");
    updateSelection();
    document.querySelectorAll("[data-media-filter]").forEach((button) => { button.disabled = false; });
  }
}

function addTile(item) {
  const card = document.createElement("article");
  card.className = "media-card";
  card.dataset.id = item.id;
  card.tabIndex = -1;
  if (recentlyUploaded.has(item.id)) {
    card.classList.add("is-new");
    const badge = document.createElement("span");
    badge.className = "new-badge";
    badge.textContent = "Nuevo";
    card.append(badge);
  }
  const tile = document.createElement(item.kind === "video" || item.hasPreview ? "button" : "div");
  tile.className = "media-tile";
  tile.dataset.kind = item.kind;
  tile.dataset.name = item.name;
  if (tile.tagName === "BUTTON") {
    tile.type = "button";
    tile.addEventListener("click", () => showMedia(tile));
    tile.setAttribute("aria-label", `${item.kind === "video" ? "Reproducir vídeo" : "Ampliar foto"}${item.guestName ? ` de ${item.guestName}` : ""}`);
  }
  const placeholder = document.createElement("span");
  placeholder.className = "placeholder";
  placeholder.textContent = item.kind === "video" ? "▤" : "♡";
  tile.append(placeholder);
  card.append(tile);
  if (item.kind === "video") {
    tile.classList.add("video-tile");
    const play = document.createElement("span");
    play.className = "play-icon";
    play.setAttribute("aria-hidden", "true");
    play.textContent = "▶";
    tile.append(play);
    const badge = document.createElement("span");
    badge.className = "media-badge";
    badge.textContent = "Vídeo";
    card.append(badge);
  }
  const caption = document.createElement("span");
  caption.className = "media-caption";
  caption.textContent = item.guestName || "";
  caption.hidden = !item.guestName;
  tile.append(caption);
  {
    const selection = document.createElement("label");
    selection.className = "select-item";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.setAttribute("aria-label", `Seleccionar ${item.name} para descargar`);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) selected.add(item.id); else selected.delete(item.id);
      updateSelection();
    });
    selection.title = "Seleccionar para descargar";
    const check = document.createElement("span");
    check.setAttribute("aria-hidden", "true");
    check.textContent = "✓";
    selection.append(checkbox, check);
    card.append(selection);
    const actions = document.createElement("div");
    actions.className = "media-actions";
    const download = document.createElement("button");
    download.className = "download-original";
    download.type = "button";
    download.textContent = "Descargar";
    download.setAttribute("aria-label", `Descargar original de ${item.name}`);
    download.addEventListener("click", async () => {
      download.disabled = true;
      try {
        const result = await post(`/api/items/${item.id}/download`, {});
        await startDownload(result.url, item.name);
      } catch (error) { message(error.message, true); }
      finally { download.disabled = false; }
    });
    const remove = document.createElement("button");
    remove.className = "btn-link delete-item";
    remove.type = "button";
    remove.textContent = "Eliminar";
    remove.setAttribute("aria-label", `Eliminar ${item.name}`);
    remove.addEventListener("click", () => {
      itemToDelete = item;
      $("delete-file-name").textContent = item.name;
      $("delete-dialog").showModal();
    });
    actions.append(download);
    if (role === "admin") actions.append(remove);
    card.append(actions);
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
    img.alt = item.kind === "video" ? "Portada del vídeo" : (item.guestName ? `Foto de ${item.guestName}` : "Foto de nuestra boda");
    img.loading = "lazy";
    tile.querySelector(".placeholder").replaceWith(img);
    if ($("viewer").open) updateViewerNavigation();
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
  if (!$("files").files.length) return;
  if (!uploading) {
    recentlyUploaded.clear();
    clearCompletedUploads();
  }
  openUpload();
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
      item.failed = true;
      status.textContent = !file.size ? "Este archivo está vacío. Selecciona otra foto o vídeo." : "No se puede subir: formato no compatible o tamaño superior al límite.";
      row.classList.add("has-error");
    } else { status.textContent = "En espera"; }
    $("upload-queue").append(row);
    queue.push(item);
    if (item.failed) allowDiscard(item);
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
      updateUploadStatus();
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
  message("");
  updateUploadStatus();
  $("logout").disabled = true;
  let wakeLock;
  try { wakeLock = await navigator.wakeLock?.request("screen"); } catch { /* Some browsers cannot keep the screen awake. */ }
  let saved = 0;
  try {
    for (const item of queue) {
      if (!item.ready || item.done) continue;
      item.ready = false;
      item.failed = false;
      item.row.classList.remove("has-error");
      item.retryButton?.remove();
      item.discardButton?.remove();
      item.discardButton = null;
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
        recentlyUploaded.add(item.id);
        item.file = null;
        item.progress.value = 100;
        item.status.textContent = item.noPreview ? "Guardado ✓ · Original conservado, sin portada disponible" : "Guardado ✓";
        item.row.classList.add("is-done");
        updateUploadStatus();
        saved++;
      } catch (error) {
        item.failed = true;
        item.status.textContent = error.message;
        item.row.classList.add("has-error");
        item.retryButton = document.createElement("button");
        item.retryButton.className = "btn-link";
        item.retryButton.type = "button";
        item.retryButton.textContent = "Reintentar";
        item.retryButton.addEventListener("click", () => { item.ready = true; item.failed = false; runQueue(); });
        item.row.append(item.retryButton);
        allowDiscard(item);
        updateUploadStatus();
        if (error.status === 401) {
          logout();
          break;
        }
      }
    }
    if (saved && token) {
      await loadItems(true).catch((error) => message(`Tus archivos se han guardado. ${error.message}`, true));
    }
  } finally {
    uploading = false;
    if (token) {
      updateUploadStatus();
      if (saved && queue.every((item) => item.done) && $("upload-dialog").open) {
        await showNewItems().catch((error) => message(error.message, true));
      }
    }
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
      const finish = (action) => { clearTimeout(timer); media.onerror = media.onload = media.onloadedmetadata = media.onloadeddata = media.onseeked = null; action(); };
      media.onerror = () => finish(() => reject(new Error("Formato sin vista previa.")));
      if (video) {
        media.onloadedmetadata = () => {
          if (!Number.isFinite(media.duration) || media.duration < .1) {
            if (media.readyState >= 2) finish(resolve);
            else media.onloadeddata = () => finish(resolve);
            return;
          }
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
    media.onerror = media.onload = media.onloadedmetadata = media.onloadeddata = media.onseeked = null;
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
