const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const read = (name) => fs.readFileSync(path.join(__dirname, name), "utf8");
const tick = () => new Promise(setImmediate);
async function until(condition) {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (condition()) return;
    await tick();
  }
  assert.fail("Timed out waiting for extension state");
}

class Control {
  constructor(text = "", value = "") {
    this.textContent = text;
    this.value = value;
    this.children = [];
    this.handlers = {};
    this.attributes = {};
    this.disabled = false;
    const classes = new Set();
    this.classList = {
      add: (name) => classes.add(name), remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name),
      toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name)
    };
  }
  setAttribute(key, value) { this.attributes[key] = value; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  add(option) { this.children.push(option); }
  addEventListener(event, handler) { this.handlers[event] = handler; }
  get options() { return this.children; }
  get selectedOptions() { return this.children.filter((option) => option.value === this.value); }
  click() { return this.disabled ? undefined : this.handlers.click(); }
}

function extension({ statusResult = { ok: true, protocolVersion: 3 } } = {}) {
  const data = {};
  const localData = {};
  const listeners = new Set();
  const ports = [];
  const requests = [];
  let handleMessage;
  const storage = {
    local: {
      get: async () => structuredClone(localData),
      set: async (values) => Object.assign(localData, structuredClone(values))
    },
    session: {
      get: async () => structuredClone(data),
      set: async (values) => {
        const changes = {};
        for (const [key, value] of Object.entries(values)) {
          changes[key] = { oldValue: data[key], newValue: structuredClone(value) };
          data[key] = structuredClone(value);
        }
        for (const listener of listeners) listener(changes, "session");
      }
    },
    onChanged: { addListener: (listener) => listeners.add(listener) }
  };
  const runtime = {
    onMessage: { addListener: (handler) => { handleMessage = handler; } },
    connectNative: () => {
      let onMessage, onDisconnect;
      const port = {
        onMessage: { addListener: (handler) => { onMessage = handler; } },
        onDisconnect: { addListener: (handler) => { onDisconnect = handler; } },
        postMessage: (payload) => {
          port.payload = payload;
          requests.push(payload);
          if (payload.action === "status") queueMicrotask(() => port.reply(statusResult));
          else ports.push(port);
        },
        disconnect: () => onDisconnect(),
        reply: (result) => onMessage(result),
        fail: (message) => {
          runtime.lastError = { message };
          onDisconnect();
          delete runtime.lastError;
        }
      };
      return port;
    }
  };
  function restartWorker() {
    vm.runInNewContext(read("background.js"), { chrome: { runtime, storage } });
  }
  restartWorker();
  const note = {
    title: "Test note", url: "https://www.xiaohongshu.com/explore/current123",
    images: [{ url: "https://sns-img-bd.xhscdn.com/a" }, { url: "https://sns-img-bd.xhscdn.com/b" }]
  };
  function openPopup() {
    const controls = Object.fromEntries([...read("popup.html").matchAll(/id="([^"]+)"/g)]
      .map((match) => [match[1], new Control()]));
    controls.destinationSelect.value = "photos";
    controls.albumSelect.add(new Control("图库（不指定相簿）", ""));
    const subscriptions = [];
    let closed = false;
    const chrome = {
      storage: { session: storage.session, local: storage.local, onChanged: { addListener: (listener) => {
        subscriptions.push(listener); listeners.add(listener);
      } } },
      runtime: { sendMessage: (message) => new Promise((resolve) => {
        handleMessage(message, {}, (result) => { if (!closed) resolve(result); });
      }) },
      tabs: {
        query: async () => [{ id: 42, url: note.url }],
        get: async (id) => { assert.equal(id, 42); return { id, url: note.url }; },
        sendMessage: async (id) => { assert.equal(id, 42); return note; }
      },
      scripting: { executeScript: async () => [{ result: note }] }
    };
    vm.runInNewContext(read("popup.js"), {
      chrome, document: { querySelector: (selector) => controls[selector.slice(1)], createElement: () => new Control() },
      Option: Control, clearTimeout: () => {}, setTimeout: () => 1
    });
    return { controls, close: () => {
      closed = true;
      subscriptions.forEach((listener) => listeners.delete(listener));
    } };
  }
  return { data, localData, ports, openPopup, note, requests, restartWorker };
}

test("toolbar opens the anchored popup with a fixed compact width", () => {
  const manifest = JSON.parse(read("manifest.json"));
  assert.equal(manifest.action.default_popup, "popup.html");
  assert.match(read("popup.css"), /body\s*\{[^}]*width: 420px/s);
});

test("folder selection survives popup closure and restores selected images", async () => {
  const app = extension();
  let popup = app.openPopup();
  await until(() => popup.controls.imageGrid.children.length === 2);
  popup.controls.imageGrid.children[1].click();
  popup.controls.destinationSelect.value = "folder";
  popup.controls.destinationSelect.handlers.change();
  void popup.controls.chooseFolderButton.click();
  await until(() => app.ports.length === 1);
  popup.close();
  app.ports[0].reply({ ok: true, path: "/tmp/chosen" });
  await until(() => app.data.folderPath === "/tmp/chosen");
  popup = app.openPopup();
  await until(() => popup.controls.imageGrid.children.length === 2);
  assert.equal(popup.controls.destinationSelect.value, "folder");
  assert.equal(popup.controls.folderPath.textContent, "/tmp/chosen");
  assert.equal(popup.controls.imageCount.textContent, "已选 1 / 2 张");
  assert.equal(popup.controls.saveButton.disabled, false);
  void popup.controls.chooseFolderButton.click();
  await until(() => app.ports.length === 2);
  app.ports[1].reply({ ok: true, cancelled: true, path: "" });
  await until(() => !popup.controls.chooseFolderButton.disabled);
  assert.equal(app.data.folderPath, "/tmp/chosen");
});

test("reopened popup shows a running save and its eventual result", async () => {
  const app = extension();
  let popup = app.openPopup();
  await until(() => popup.controls.imageGrid.children.length === 2);
  void popup.controls.saveButton.click();
  await until(() => app.ports.length === 1);
  popup.close();
  popup = app.openPopup();
  await until(() => popup.controls.imageGrid.children.length === 2);
  assert.equal(popup.controls.galleryState.classList.contains("hidden"), false);
  assert.equal(popup.controls.saveButton.disabled, true);
  assert.equal(popup.controls.imageGrid.children[0].disabled, true);
  popup.controls.saveButton.click();
  assert.equal(app.ports.length, 1);
  app.ports[0].reply({ ok: true, saved: 2 });
  await until(() => !popup.controls.saveButton.disabled);
  assert.match(popup.controls.resultMessage.textContent, /已导入 2 张/);
  popup.close();
  popup = app.openPopup();
  await until(() => popup.controls.imageGrid.children.length === 2);
  assert.match(popup.controls.resultMessage.textContent, /已导入 2 张/);
});

test("album results and native errors remain visible after reopening", async () => {
  const app = extension();
  let popup = app.openPopup();
  await until(() => popup.controls.imageGrid.children.length === 2);
  void popup.controls.loadAlbumsButton.click();
  await until(() => app.ports.length === 1);
  popup.close();
  app.ports[0].reply({ ok: true, albums: [{ id: "album-a", name: "旅行" }] });
  await until(() => app.data.albums?.length === 1);
  popup = app.openPopup();
  await until(() => popup.controls.imageGrid.children.length === 2);
  popup.controls.albumSelect.value = "album-a";
  void popup.controls.saveButton.click();
  await until(() => app.ports.length === 2);
  assert.equal(app.ports[1].payload.albumId, "album-a");
  popup.close();
  app.ports[1].fail("Native host has exited.");
  await until(() => app.data.connectorJob.result?.ok === false);
  popup = app.openPopup();
  await until(() => popup.controls.imageGrid.children.length === 2);
  assert.match(popup.controls.resultMessage.textContent, /Native host has exited/);
  assert.equal(popup.controls.saveButton.disabled, false);
});


test("sparse selections retain note indices and oversized selections cannot save", async () => {
  const app = extension();
  let popup = app.openPopup();
  await until(() => popup.controls.imageGrid.children.length === 2);
  popup.controls.imageGrid.children[0].click();
  void popup.controls.saveButton.click();
  await until(() => app.ports.length === 1);
  assert.equal(app.ports[0].payload.images[0].index, 2);
  app.ports[0].reply({ ok: true, saved: 1 });
  await until(() => !popup.controls.saveButton.disabled);
  popup.close();
  app.note.url += "-other";
  app.note.images = Array.from({ length: 31 }, () => ({ url: "https://ci.xiaohongshu.com/a" }));
  popup = app.openPopup();
  await until(() => popup.controls.imageGrid.children.length === 31);
  assert.equal(popup.controls.saveButton.disabled, true);
  assert.equal(popup.controls.saveButtonLabel.textContent, "最多选择 30 张");
  popup.controls.imageGrid.children[0].click();
  assert.equal(popup.controls.saveButton.disabled, false);
});


test("an old connector is rejected before any save operation is sent", async () => {
  const app = extension({ statusResult: { ok: false, error: "缺少图片列表" } });
  const popup = app.openPopup();
  await until(() => popup.controls.imageGrid.children.length === 2);
  void popup.controls.saveButton.click();
  await until(() => app.data.connectorJob?.result);
  assert.deepEqual(app.requests.map((request) => request.action), ["status"]);
  assert.match(popup.controls.resultMessage.textContent, /install.command/);
  assert.equal(popup.controls.saveButton.disabled, false);
});

test("a restarted worker marks unfinished work interrupted without repeating it", async () => {
  const app = extension();
  let popup = app.openPopup();
  await until(() => popup.controls.imageGrid.children.length === 2);
  void popup.controls.saveButton.click();
  await until(() => app.ports.length === 1);
  popup.close();
  app.restartWorker();
  popup = app.openPopup();
  await until(() => popup.controls.imageGrid.children.length === 2);
  assert.equal(popup.controls.saveButton.disabled, false);
  assert.match(popup.controls.resultMessage.textContent, /中断/);
  assert.equal(app.requests.filter((request) => request.action === "save").length, 1);
});

test("progress messages keep the native port open and survive reopening", async () => {
  const app = extension();
  let popup = app.openPopup();
  await until(() => popup.controls.imageGrid.children.length === 2);
  void popup.controls.saveButton.click();
  await until(() => app.ports.length === 1);
  app.ports[0].reply({ event: "progress", phase: "download", completed: 1, total: 2 });
  await until(() => app.data.connectorJob?.progress);
  assert.equal(app.data.connectorJob.busy, true);
  assert.equal(popup.controls.saveButton.disabled, true);
  assert.match(popup.controls.saveButtonLabel.textContent, /1\/2/);
  popup.close();
  popup = app.openPopup();
  await until(() => popup.controls.imageGrid.children.length === 2);
  assert.match(popup.controls.saveButtonLabel.textContent, /1\/2/);
  app.ports[0].reply({ event: "progress", phase: "import", completed: 0, total: 2 });
  app.ports[0].reply({ ok: true, saved: 2 });
  await until(() => !popup.controls.saveButton.disabled);
  assert.equal(app.data.connectorJob.busy, false);
  assert.match(popup.controls.resultMessage.textContent, /已导入 2 张/);
});

for (const allFailed of [false, true]) {
  test(`retry ${allFailed ? 'all' : 'partial'} failures preserves target and original indices`, async () => {
    const app = extension();
    app.note.images[0].index = 3;
    app.note.images[1].index = 7;
    let popup = app.openPopup();
    await until(() => popup.controls.imageGrid.children.length === 2);
    void popup.controls.saveButton.click();
    await until(() => app.ports.length === 1);
    const original = app.ports[0].payload;
    app.ports[0].reply({ ok: !allFailed, saved: allFailed ? 0 : 1,
      failedIndices: allFailed ? [3, 7] : [7], error: '下载失败' });
    await until(() => !popup.controls.saveButton.disabled);
    popup.close();
    popup = app.openPopup();
    await until(() => popup.controls.imageGrid.children.length === 2);
    assert.equal(popup.controls.retryFailedButton.classList.contains('hidden'), false);
    void popup.controls.retryFailedButton.click();
    await until(() => app.ports.length === 2);
    const retry = app.ports[1].payload;
    assert.deepEqual(Array.from(retry.images, (item) => item.index), allFailed ? [3, 7] : [7]);
    assert.equal(retry.destination, original.destination);
    assert.equal(retry.albumId, original.albumId);
    app.ports[1].reply({ ok: true, saved: retry.images.length, failedIndices: [] });
    await until(() => !app.data.connectorJob.busy);
    assert.equal(popup.controls.retryFailedButton.classList.contains('hidden'), true);
  });
}

test('destination preferences survive a browser session reset and another note', async () => {
  const app = extension();
  app.localData.destinationPreferences = { destination: 'photos', albumId: 'album-a', albumName: '旅行' };
  let popup = app.openPopup();
  await until(() => popup.controls.imageGrid.children.length === 2);
  assert.equal(popup.controls.albumSelect.value, 'album-a');
  popup.controls.destinationSelect.value = 'folder';
  popup.controls.destinationSelect.handlers.change();
  void popup.controls.chooseFolderButton.click();
  await until(() => app.ports.length === 1);
  app.ports[0].reply({ ok: true, path: '/tmp/persistent-folder' });
  await until(() => app.localData.folderPath);
  popup.close();
  Object.keys(app.data).forEach((key) => delete app.data[key]);
  app.note.url += '-another';
  app.restartWorker();
  popup = app.openPopup();
  await until(() => popup.controls.imageGrid.children.length === 2);
  assert.equal(popup.controls.destinationSelect.value, 'folder');
  assert.equal(popup.controls.folderPath.textContent, '/tmp/persistent-folder');
  assert.equal(popup.controls.imageCount.textContent, '已选 2 / 2 张');
});

test('a reopened popup can stop a running native save without disconnecting it', async () => {
  const app = extension();
  let popup = app.openPopup();
  await until(() => popup.controls.imageGrid.children.length === 2);
  void popup.controls.saveButton.click();
  await until(() => app.ports.length === 1);
  popup.close();
  popup = app.openPopup();
  await until(() => popup.controls.imageGrid.children.length === 2);
  assert.equal(popup.controls.stopButton.classList.contains('hidden'), false);
  void popup.controls.stopButton.click();
  await until(() => app.requests.some((request) => request.action === 'cancel'));
  assert.equal(app.data.connectorJob.busy, true);
  app.ports[0].reply({ ok: true, saved: 1, cancelled: true, failedIndices: [2] });
  await until(() => !app.data.connectorJob.busy);
  assert.match(popup.controls.resultMessage.textContent, /已保留/);
});
