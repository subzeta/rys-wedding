import assert from "node:assert/strict";
import { test } from "node:test";
import { prepareDownloads, cancelDownloads } from "../salseo/downloads.js";

function setup() {
  const elements = new Map(["save-downloads", "download-status"].map((id) => [id, {}]));
  globalThis.document = { getElementById: (id) => elements.get(id) };
  const items = [
    { id: "photo-1", name: "foto.jpg" },
    { id: "photo-2", name: "otra.heic" },
    { id: "video", name: "baile.mov" },
  ];
  const sent = [];
  const options = {
    api: async (path) => ({ json: async () => path.includes("cursor=") ? { items: items.slice(2), cursor: null } : { items: items.slice(0, 2), cursor: "next" } }),
    post: async (path) => ({ url: `https://gallery.example${path}` }),
    startDownload: async (url, name) => { sent.push({ url, name }); },
  };
  return { elements, items, sent, options };
}

test("selected photos and videos download directly without sharing or a list of links", async () => {
  const { options, sent, elements } = setup();
  await prepareDownloads({ ...options, selected: ["photo-1", "video"] });
  assert.deepEqual(sent.map((item) => item.name), ["foto.jpg", "baile.mov"]);
  assert.equal(elements.get("save-downloads").hidden, true);
  assert.match(elements.get("download-status").textContent, /2 archivos enviados/);
});

test("download all includes unloaded pages and closing stops pending downloads", async () => {
  const { options, sent } = setup();
  await prepareDownloads({ ...options, selected: null });
  assert.equal(sent.length, 3);
  sent.length = 0;
  await prepareDownloads({ ...options, selected: null, startDownload: async (url, name) => {
    sent.push(name);
    cancelDownloads();
  } });
  assert.deepEqual(sent, ["foto.jpg"]);
});

test("a failed download can retry only the files still pending", async () => {
  const { options, sent, elements } = setup();
  let fail = true;
  await prepareDownloads({ ...options, selected: ["photo-1", "video"], post: async (path) => {
    if (path.includes("video") && fail) { fail = false; throw new Error("Conexión interrumpida"); }
    return options.post(path);
  } });
  assert.equal(elements.get("save-downloads").hidden, false);
  await elements.get("save-downloads").onclick();
  assert.deepEqual(sent.map((item) => item.name), ["foto.jpg", "baile.mov"]);
});
