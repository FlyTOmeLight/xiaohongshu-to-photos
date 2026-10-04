const NATIVE_HOST = "com.rednote.photosaver";
const PROTOCOL_VERSION = 2;
let running = false;
const ready = recoverInterruptedJob();

async function recoverInterruptedJob() {
  const { connectorJob } = await chrome.storage.session.get("connectorJob");
  if (connectorJob?.busy) {
    await chrome.storage.session.set({ connectorJob: {
      busy: false, payload: connectorJob.payload,
      result: { ok: false, error: "上次任务已中断。请先检查保存位置，再决定是否重新保存。" }
    } });
  }
}

function requestNative(payload, onProgress) {
  return new Promise((resolve) => {
    const port = chrome.runtime.connectNative(NATIVE_HOST);
    let received = false;
    let progressUpdates = Promise.resolve();
    port.onMessage.addListener((result) => {
      if (received) return;
      if (result?.event === "progress") {
        if (onProgress) progressUpdates = progressUpdates.then(() => onProgress(result));
        return;
      }
      received = true;
      port.disconnect();
      progressUpdates.then(() => resolve(result || { ok: false, error: "本机连接器没有返回结果" }),
        (error) => resolve({ ok: false, error: error.message }));
    });
    port.onDisconnect.addListener(() => {
      const error = chrome.runtime.lastError;
      if (received) return;
      received = true;
      const detail = error?.message || "本机连接器没有返回结果";
      const result = { ok: false, code: "NATIVE_CONNECTION", error: /not found|not registered|does not exist/i.test(detail)
        ? "尚未安装照片连接器，请先运行 install.command"
        : `连接器通信失败：${detail}` };
      progressUpdates.then(() => resolve(result), () => resolve(result));
    });
    port.postMessage(payload);
  });
}

async function runJob(payload) {
  await ready;
  await chrome.storage.session.set({ connectorJob: { busy: true, payload } });
  let result;
  try {
    // The native port keeps this worker alive even after the toolbar popup closes.
    const status = await requestNative({ action: "status" });
    if (status.code === "NATIVE_CONNECTION") result = status;
    else if (!status.ok || status.protocolVersion !== PROTOCOL_VERSION) {
      result = { ok: false, error: "本机连接器版本不匹配，请重新运行 install.command 后再试" };
    } else result = await requestNative(payload, (progress) =>
      chrome.storage.session.set({ connectorJob: { busy: true, payload, progress } }));
  } catch (error) {
    result = { ok: false, error: error.message || "连接器通信失败" };
  }
  const updates = { connectorJob: { busy: false, payload, result } };
  if (result.ok && payload.action === "chooseFolder" && !result.cancelled && result.path) {
    updates.folderPath = result.path;
  }
  if (result.ok && payload.action === "listAlbums" && Array.isArray(result.albums)) {
    updates.albums = result.albums;
  }
  await chrome.storage.session.set(updates);
  return result;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "CONNECTOR_STATE") {
    ready.then(() => sendResponse({ ok: true }), (error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type !== "CONNECTOR_REQUEST") return;
  if (running) {
    sendResponse({ ok: false, error: "已有任务正在进行，请稍候" });
    return;
  }
  running = true;
  runJob(message.payload).then(sendResponse, (error) => {
    sendResponse({ ok: false, error: error.message || "保存失败" });
  }).finally(() => { running = false; });
  return true;
});
