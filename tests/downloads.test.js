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

test("saving creates a local downloadable file instead of navigating to the external photo", async (t) => {
  const { downloadFile } = await import("../salseo/downloads.js");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  const response = new Response(bytes, { headers: { "Content-Type": "image/jpeg" } });
  t.mock.method(globalThis, "fetch", async () => response);
  let savedBlob;
  t.mock.method(URL, "createObjectURL", (blob) => { savedBlob = blob; return "blob:https://gallery.example/local-photo"; });
  const revoke = t.mock.method(URL, "revokeObjectURL", () => {});
  const anchor = { click: t.mock.fn(), remove: t.mock.fn() };
  globalThis.document = { createElement: () => anchor, body: { append: t.mock.fn() } };
  await downloadFile("https://api.example/photo.jpg", "foto de boda.jpg");
  assert.equal(anchor.href, "blob:https://gallery.example/local-photo");
  assert.equal(anchor.download, "foto de boda.jpg");
  assert.equal(savedBlob.type, "image/jpeg");
  assert.deepEqual(new Uint8Array(await savedBlob.arrayBuffer()), bytes);
  assert.equal(anchor.click.mock.callCount(), 1);
  assert.equal(anchor.remove.mock.callCount(), 1);
  assert.equal(revoke.mock.callCount(), 0);
  t.mock.timers.tick(10000);
  assert.equal(revoke.mock.callCount(), 1);
});

test("a failed photo fetch cannot navigate or download an error page", async (t) => {
  const { downloadFile } = await import("../salseo/downloads.js");
  t.mock.method(globalThis, "fetch", async () => new Response("Expired", { status: 401 }));
  const create = t.mock.fn();
  globalThis.document = { createElement: create };
  await assert.rejects(downloadFile("https://api.example/photo.jpg", "foto.jpg"), /obtener el archivo/);
  assert.equal(create.mock.callCount(), 0);
});

test("download all respects the active type filter on every page", async () => {
  const { options, sent } = setup();
  const queries = [];
  await prepareDownloads({ ...options, kind: "video", selected: null, api: async (path) => {
    const url = new URL(path, "https://gallery.example");
    queries.push(url);
    return { json: async () => url.searchParams.has("cursor") ? { items: [{ id: "video", name: "baile.mov" }], cursor: null } : { items: [], cursor: "next" } };
  } });
  assert.equal(queries.length, 2);
  assert.ok(queries.every((url) => url.searchParams.get("kind") === "video"));
  assert.equal(queries[1].searchParams.get("cursor"), "next");
  assert.deepEqual(sent.map((item) => item.name), ["baile.mov"]);
});
