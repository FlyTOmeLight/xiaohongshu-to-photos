const NATIVE_HOST = "com.rednote.photosaver";
let running = false;

function requestNative(payload) {
  return new Promise((resolve) => {
    const port = chrome.runtime.connectNative(NATIVE_HOST);
    let received = false;
    port.onMessage.addListener((result) => {
      received = true;
      resolve(result || { ok: false, error: "本机连接器没有返回结果" });
      port.disconnect();
    });
    port.onDisconnect.addListener(() => {
      const error = chrome.runtime.lastError;
      if (received) return;
      const detail = error?.message || "本机连接器没有返回结果";
      resolve({ ok: false, error: /not found|not registered|does not exist/i.test(detail)
        ? "尚未安装照片连接器，请先运行 install.command"
        : `连接器通信失败：${detail}` });
    });
    port.postMessage(payload);
  });
}

async function runJob(payload) {
  await chrome.storage.session.set({ connectorJob: { busy: true, payload } });
  let result;
  try {
    // The native port keeps this worker alive even after the toolbar popup closes.
    result = await requestNative(payload);
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
