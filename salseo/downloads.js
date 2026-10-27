const $ = (id) => document.getElementById(id);
const MOBILE_BATCH_BYTES = 64 * 1024 * 1024;
let active;

export function nextBatch(items) {
  const batch = [];
  let size = 0;
  for (const item of items) {
    if (batch.length && (size + item.size > MOBILE_BATCH_BYTES || batch.length >= 20)) break;
    batch.push(item);
    size += item.size;
    if (size > MOBILE_BATCH_BYTES) break;
  }
  return batch;
}

export function cancelDownloads() {
  active?.abort();
  active = null;
  $("save-downloads").onclick = null;
  $("save-downloads").hidden = true;
}

function mediaType(name) {
  return ({ jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", heic: "image/heic", heif: "image/heif", avif: "image/avif", mov: "video/quicktime", mp4: "video/mp4", m4v: "video/x-m4v", webm: "video/webm", "3gp": "video/3gpp" })[name.split(".").pop().toLowerCase()] || "application/octet-stream";
}

export async function prepareDownloads({ api, post, selected, startDownload }) {
  cancelDownloads();
  const controller = active = new AbortController();
  const { signal } = controller;
  const status = $("download-status");
  const save = $("save-downloads");
  const links = $("download-links");
  links.replaceChildren();
  save.disabled = false;
  status.textContent = "Preparando fotos y vídeos…";
  try {
    const items = [];
    const wanted = selected && new Set(selected);
    let cursor;
    do {
      const page = await (await api(`/api/items${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`, { signal })).json();
      items.push(...page.items.filter((item) => !wanted || wanted.has(item.id)));
      cursor = page.cursor;
    } while (cursor);
    if (signal.aborted) return;
    if (!items.length) { status.textContent = "No hay archivos disponibles para descargar."; return; }
    for (const item of items) {
      const row = document.createElement("li");
      const link = document.createElement("a");
      link.href = "#";
      link.textContent = item.name;
      link.addEventListener("click", async (event) => {
        event.preventDefault();
        try {
          const result = await post(`/api/items/${item.id}/download`, {});
          if (!signal.aborted) startDownload(result.url, item.name);
        } catch (error) { if (!signal.aborted) status.textContent = error.message; }
      });
      row.append(link);
      links.append(row);
    }
    const canShare = typeof navigator.canShare === "function" && navigator.canShare({ files: [new File([""], "foto.jpg", { type: "image/jpeg" })] });
    if (!canShare) {
      status.textContent = `${items.length} archivos listos para descargar por separado.`;
      save.textContent = "Descargar archivos";
      save.hidden = false;
      save.onclick = async () => {
        save.disabled = true;
        try {
          for (let i = 0; i < items.length && !signal.aborted; i++) {
            const result = await post(`/api/items/${items[i].id}/download`, {});
            if (signal.aborted) return;
            startDownload(result.url, items[i].name);
            status.textContent = `Enviando descarga ${i + 1} de ${items.length}. Revisa las descargas del navegador.`;
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
        } catch (error) { if (!signal.aborted) status.textContent = error.message; }
        finally { save.disabled = false; }
      };
      return;
    }
    let remaining = [...items];
    let saved = 0;
    async function prepareBatch() {
      if (signal.aborted) return;
      save.hidden = true;
      save.disabled = false;
      save.onclick = null;
      if (!remaining.length) { status.textContent = "Todos los archivos se han enviado para guardar. Comprueba Fotos, Archivos o Descargas."; return; }
      const batch = nextBatch(remaining);
      const large = batch[0].size > MOBILE_BATCH_BYTES;
      status.textContent = large ? `Vídeo o foto grande: ${batch[0].name}. Se descargará directamente.` : `Preparando ${batch.length} archivos para el móvil (${saved} de ${items.length} enviados)…`;
      const files = [];
      if (!large) {
        for (const item of batch) {
          const result = await post(`/api/items/${item.id}/download`, {});
          const response = await fetch(result.url, { signal, referrerPolicy: "no-referrer" });
          if (!response.ok) throw new Error("No se ha podido preparar un archivo. Cierra esta ventana y vuelve a intentarlo.");
          files.push(new File([await response.blob()], item.name, { type: mediaType(item.name) }));
        }
      }
      if (signal.aborted) return;
      const shareable = !large && navigator.canShare({ files });
      status.textContent = `${batch.length} archivos listos. ${saved} de ${items.length} enviados. Pulsa para guardarlos${remaining.length > batch.length ? "; después prepararemos los siguientes" : ""}.`;
      save.textContent = shareable ? `Guardar ${batch.length} archivos en el móvil` : "Descargar archivos";
      save.hidden = false;
      save.onclick = async () => {
        save.disabled = true;
        try {
          if (shareable) await navigator.share({ files });
          else {
            for (const item of batch) {
              const result = await post(`/api/items/${item.id}/download`, {});
              if (signal.aborted) return;
              startDownload(result.url, item.name);
              await new Promise((resolve) => setTimeout(resolve, 1000));
            }
          }
          remaining = remaining.slice(batch.length);
          saved += batch.length;
          files.length = 0;
          await prepareBatch();
        } catch (error) {
          if (!signal.aborted) status.textContent = error.name === "AbortError" ? "Guardado cancelado. Puedes volver a pulsar para intentarlo." : error.message;
        } finally { save.disabled = false; }
      };
    }
    await prepareBatch();
  } catch (error) {
    if (!signal.aborted) status.textContent = error.message;
  }
}
