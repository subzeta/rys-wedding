const $ = (id) => document.getElementById(id);
let active;

export async function downloadFile(url, name, { signal } = {}) {
  const response = await fetch(url, { signal, referrerPolicy: "no-referrer" });
  if (!response.ok) throw new Error("No se ha podido obtener el archivo. Vuelve a intentarlo.");
  // A local blob makes download work even when the browser ignores it on external URLs.
  // shortcut: prepares one original before saving; use streaming storage for videos exceeding mobile device limits.
  const blob = await response.blob();
  if (signal?.aborted) return;
  const localURL = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = localURL;
  link.download = name;
  document.body.append(link);
  try { link.click(); }
  finally {
    link.remove();
    // Allow the browser to take ownership of the download before releasing the blob.
    setTimeout(() => URL.revokeObjectURL(localURL), 10000);
  }
}

export function cancelDownloads() {
  active?.abort();
  active = null;
  $("save-downloads").onclick = null;
  $("save-downloads").hidden = true;
}

export async function prepareDownloads({ api, post, selected, startDownload }) {
  cancelDownloads();
  const controller = active = new AbortController();
  const { signal } = controller;
  const status = $("download-status");
  const retry = $("save-downloads");
  status.textContent = "Preparando fotos y vídeos…";
  const items = [];
  let next = 0;
  async function downloadRemaining() {
    retry.hidden = true;
    try {
      for (; next < items.length; next++) {
        const item = items[next];
        const result = await post(`/api/items/${item.id}/download`, {});
        if (signal.aborted) return;
        status.textContent = `Preparando ${next + 1} de ${items.length}: ${item.name}`;
        await startDownload(result.url, item.name, { signal });
        if (signal.aborted) return;
        status.textContent = `Enviando ${next + 1} de ${items.length}: ${item.name}`;
        await new Promise((resolve) => setTimeout(resolve, 1200));
        if (signal.aborted) return;
      }
      status.textContent = `${items.length} archivos enviados a Descargas. Comprueba allí que están todos. Si falta alguno, permite las descargas múltiples en el navegador y vuelve a intentarlo.`;
    } catch (error) {
      if (!signal.aborted) {
        status.textContent = `No se ha podido descargar ${items[next].name}. ${error.message}`;
        retry.textContent = "Reintentar pendientes";
        retry.hidden = false;
        retry.onclick = downloadRemaining;
      }
    }
  }
  try {
    const wanted = selected && new Set(selected);
    let cursor;
    do {
      const page = await (await api(`/api/items${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`, { signal })).json();
      items.push(...page.items.filter((item) => !wanted || wanted.has(item.id)));
      cursor = page.cursor;
    } while (cursor);
    if (signal.aborted) return;
    if (!items.length) { status.textContent = "No hay archivos disponibles para descargar."; return; }
    await downloadRemaining();
  } catch (error) {
    if (!signal.aborted) status.textContent = error.message;
  }
}
