const $ = (id) => document.getElementById(id);
let active;

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
        await startDownload(result.url, item.name);
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
