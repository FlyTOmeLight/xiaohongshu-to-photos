const elements = {
  loading: document.querySelector("#loadingState"),
  empty: document.querySelector("#emptyState"),
  gallery: document.querySelector("#galleryState"),
  actionBar: document.querySelector("#actionBar"),
  grid: document.querySelector("#imageGrid"),
  title: document.querySelector("#noteTitle"),
  count: document.querySelector("#imageCount"),
  emptyTitle: document.querySelector("#emptyTitle"),
  emptyMessage: document.querySelector("#emptyMessage"),
  refresh: document.querySelector("#refreshButton"),
  retry: document.querySelector("#retryButton"),
  toggleAll: document.querySelector("#toggleAllButton"),
  save: document.querySelector("#saveButton"),
  saveLabel: document.querySelector("#saveButtonLabel"),
  toast: document.querySelector("#toast"),
  destination: document.querySelector("#destinationSelect"),
  albumSettings: document.querySelector("#albumSettings"),
  album: document.querySelector("#albumSelect"),
  loadAlbums: document.querySelector("#loadAlbumsButton"),
  folderSettings: document.querySelector("#folderSettings"),
  chooseFolder: document.querySelector("#chooseFolderButton"),
  folderPath: document.querySelector("#folderPath"),
  destinationHint: document.querySelector("#destinationHint"),
  result: document.querySelector("#resultMessage"),
  retryFailed: document.querySelector("#retryFailedButton"),
  stop: document.querySelector("#stopButton"),
  history: document.querySelector("#historyList"),
  clearHistory: document.querySelector("#clearHistoryButton"),
  duplicateHint: document.querySelector("#duplicateHint")
};

let note = { title: "小红书笔记", images: [] };
let selected = new Set();
let toastTimer;
let busy = false;
let folderPath = "";
let sourceTabId;
let session = {};
let saveHistory = [];
let historyOpen = false;
let resultDetails = "";
let resultMode = false;
let previewIndex = 0;
let targetSnapshot;
let dismissedResult;
const ui = Object.fromEntries(["photosTargetButton", "folderTargetButton", "historyButton", "historyPane", "contentPane", "changeTargetButton", "targetSummary", "targetDialog", "closeTargetButton", "confirmTargetButton", "previewDialog", "previewImage", "previewLabel", "closePreviewButton", "previousImageButton", "nextImageButton", "previewSelectButton", "detailsDialog", "detailTitle", "detailText", "closeDetailsButton", "sourceLink", "detailsButton", "taskProgress", "clearDialog", "cancelClearButton", "confirmClearButton"].map(id => [id, document.querySelector(`#${id}`)]));
function openDialog(dialog) { dialog.showModal(); }
function targetSummary() {
  ui.targetSummary.textContent = elements.destination.value === "folder"
    ? `文件夹 · ${folderPath.split("/").filter(Boolean).pop() || "请选择位置"}`
    : `照片 · ${elements.album.selectedOptions[0]?.textContent || "图库"}`;
}
function switchHistory() {
  historyOpen = !historyOpen;
  ui.historyPane.classList.toggle("hidden", !historyOpen);
  ui.contentPane.classList.toggle("hidden", historyOpen);
  elements.actionBar.classList.toggle("hidden", historyOpen || !note.images.length);
  ui.historyButton.textContent = historyOpen ? "选图" : "记录";
}
function showDetails(title, text, url = "") {
  ui.detailTitle.textContent = title;
  ui.detailText.textContent = text;
  const valid = /^https?:\/\/([\w-]+\.)*xiaohongshu\.com\//i.test(url);
  ui.sourceLink.classList.toggle("hidden", !valid);
  ui.sourceLink.href = valid ? url : "";
  openDialog(ui.detailsDialog);
}
function renderPreview() {
  const item = note.images[previewIndex];
  ui.previewImage.src = item.previewUrl || item.url;
  ui.previewImage.referrerPolicy = "no-referrer";
  ui.previewLabel.textContent = `第 ${item.index || previewIndex + 1} 张 · ${previewIndex + 1}/${note.images.length}`;
  ui.previewSelectButton.textContent = selected.has(previewIndex) ? "✓ 已选本张" : "选择本张";
  ui.previewSelectButton.disabled = busy || resultMode;
}

function noteIdentity(url) {
  return String(url || "").match(/\/(?:explore|discovery\/item)\/([0-9a-z]+)/i)?.[1] || "";
}

function historyPreviewUrl(record) {
  const first = record.items[0];
  const matchingNote = noteIdentity(record.pageUrl) && noteIdentity(record.pageUrl) === noteIdentity(note.url);
  const sourceImage = matchingNote ? note.images.find((item, index) => (item.index || index + 1) === first?.index) : null;
  const job = session.connectorJob;
  const savedImage = noteIdentity(record.pageUrl) && noteIdentity(record.pageUrl) === noteIdentity(job?.payload?.pageUrl)
    ? job.payload.images?.find(item => item.index === first?.index) : null;
  return record.previewUrl || first?.previewUrl || first?.url
    || sourceImage?.previewUrl || sourceImage?.url || savedImage?.previewUrl || savedImage?.url;
}

async function restoreHistoryPreviews() {
  let changed = false;
  saveHistory = saveHistory.map(record => {
    if (record.previewUrl) return record;
    const previewUrl = historyPreviewUrl(record);
    if (!/^https?:\/\//i.test(previewUrl || "")) return record;
    changed = true;
    return { ...record, previewUrl };
  });
  if (changed) await chrome.storage.local.set({ saveHistory });
}

function renderHistory() {
  elements.history.replaceChildren();
  if (!saveHistory.length) elements.history.textContent = "还没有保存记录，保存成功的笔记会出现在这里。";
  let lastDay;
  for (const record of saveHistory) {
    const date = new Date(record.savedAt);
    const day = date.toLocaleDateString();
    if (day !== lastDay) {
      const heading = document.createElement("p");
      heading.className = "date-label";
      const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
      heading.textContent = day === new Date().toLocaleDateString() ? "今天" : day === yesterday.toLocaleDateString() ? "昨天" : day;
      elements.history.append(heading); lastDay = day;
    }
    const row = document.createElement("button");
    row.type = "button"; row.className = "history-row";
    const thumb = document.createElement("span");
    thumb.className = "history-thumb"; thumb.textContent = "▧";
    const previewUrl = historyPreviewUrl(record);
    if (/^https?:\/\//i.test(previewUrl || "")) {
      const image = document.createElement("img");
      image.className = "history-thumb"; image.src = previewUrl;
      image.alt = ""; image.loading = "lazy"; image.referrerPolicy = "no-referrer";
      image.addEventListener("error", () => image.replaceWith(thumb));
      row.append(image);
    } else row.append(thumb);
    const copy = document.createElement("span"); copy.className = "history-copy";
    const title = document.createElement("b"); title.textContent = record.title || "小红书笔记";
    const detail = document.createElement("small");
    detail.textContent = `${date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · ${record.items.length} 张`;
    const target = document.createElement("em");
    target.textContent = record.destination === "folder" ? `文件夹 · ${record.folderPath || "本地"}` : `照片 · ${record.albumName || "图库"}`;
    copy.append(title, detail, target); row.append(copy);
    row.addEventListener("click", () => showDetails(record.title || "保存记录", [
      date.toLocaleString(), `保存位置：${target.textContent}`,
      ...record.items.map(item => `第 ${item.index} 张 · ${item.kind === "live" ? "实况" : item.kind === "gif" ? "GIF" : "图片"} · ${item.format || ""}${item.quality === "page" ? " · 页面版本" : ""}`)
    ].join("\n"), record.pageUrl));
    elements.history.append(row);
  }
  updateDuplicateHint();
}

function updateDuplicateHint() {
  const id = noteIdentity(note.url);
  const saved = new Set(saveHistory.filter((record) => id && noteIdentity(record.pageUrl) === id)
    .flatMap((record) => record.items.map((item) => item.index)));
  const count = note.images.filter((item, index) => selected.has(index) && saved.has(item.index || index + 1)).length;
  elements.duplicateHint.textContent = count ? `已选图片中有 ${count} 张曾保存。继续保存会再导出一次。` : "";
  elements.duplicateHint.classList.toggle("hidden", !count);
}

function bestNoteResult(candidates, tabUrl) {
  const wantedId = String(tabUrl || "").match(/\/(?:explore|discovery\/item)\/([0-9a-z]+)/i)?.[1] || "";
  return candidates.filter((candidate) => candidate?.images?.length).sort((a, b) => {
    const score = (candidate) => {
      const idScore = wantedId && candidate.noteId === wantedId ? 1000000 : candidate.noteId ? -1000000 : 0;
      const videoCount = candidate.images.reduce((total, item) => total + (item.videoUrls?.length || 0), 0);
      const liveCount = candidate.images.filter((item) => item.kind === "live").length;
      return idScore + videoCount * 10000 + liveCount * 100 + candidate.images.length;
    };
    return score(b) - score(a);
  })[0] || null;
}

function rememberDraft() {
  return chrome.storage.session.set({ popupDraft: {
    pageUrl: note.url,
    selected: [...selected],
    destination: elements.destination.value,
    albumId: elements.album.value, targetDraft: targetSnapshot ? { destination: elements.destination.value, albumId: elements.album.value } : null, targetSnapshot
  } });
}

function rememberDestination() {
  return chrome.storage.local.set({ destinationPreferences: {
    destination: elements.destination.value, albumId: elements.album.value,
    albumName: elements.album.selectedOptions[0]?.textContent || ""
  } });
}

async function sendToConnector(payload) {
  await rememberDraft();
  return chrome.runtime.sendMessage({
    type: "CONNECTOR_REQUEST",
    payload: { ...payload, pageUrl: note.url,
      albumName: elements.album.selectedOptions[0]?.textContent || "" }
  });
}

function updateDestinationUi() {
  targetSummary();
  const local = elements.destination.value === "folder";
  ui.photosTargetButton.setAttribute("aria-pressed", String(!local));
  ui.folderTargetButton.setAttribute("aria-pressed", String(local));
  elements.albumSettings.classList.toggle("hidden", local);
  elements.folderSettings.classList.toggle("hidden", !local);
  elements.destinationHint.textContent = local
    ? "选择文件夹后若弹窗关闭，再点扩展即可继续"
    : "原图、GIF、实况 · 可同步 iCloud";
}

function showSaveResult(payload, result) {
  if (payload.uiSavedItems?.length) {
    const items = [...new Map([...payload.uiSavedItems, ...(result.items || [])].map(item => [item.index, item])).values()];
    result = { ...result, items, saved: items.length, ok: result.ok || items.length > 0 };
  }
  if (!result.ok) {
    elements.result.textContent = result.error || "保存失败，请稍后再试";
  } else {
    const local = payload.destination === "folder";
    const target = local ? "本地文件夹" : payload.albumId ? `相簿“${payload.albumName}”` : "“照片”";
    const failedText = result.failed ? `，${result.failed} 张失败` : "";
    const fallbackText = result.liveFallback ? `，${result.liveFallback} 张仅保存静态图` : "";
    const qualityText = result.qualityFallbackDetails?.length ? `，${result.qualityFallbackDetails.length} 张使用页面版本` : "";
    const summary = `已${local ? "保存" : "导入"} ${result.saved} 张到${target}${failedText}${fallbackText}${qualityText}`;
    elements.result.textContent = [result.cancelled ? "任务已停止，已保存的图片已保留" : "", summary, ...(result.failureDetails || []),
      ...(result.liveFallbackDetails || []), ...(result.qualityFallbackDetails || []),
      result.sourceWarning, result.historyWarning,
      local ? result.folderPath : ""].filter(Boolean).join("\n");
  }
  resultDetails = elements.result.textContent;
  elements.result.textContent = resultDetails.split("\n").slice(0, result.cancelled ? 2 : 1).join("\n");
  elements.result.classList.toggle("warning", !result.ok || Boolean(result.failed || result.liveFallback || result.qualityFallbackDetails?.length || result.cancelled || result.sourceWarning || result.historyWarning));
  elements.result.classList.remove("hidden");
  resultMode = true;
  ui.detailsButton.classList.remove("hidden");
  ui.changeTargetButton.classList.add("hidden");
  elements.save.classList.remove("hidden");
  [...elements.grid.children].forEach((tile, index) => {
    const original = note.images[index].index || index + 1;
    const saved = result.items?.find(item => item.index === original);
    const failed = result.failedIndices?.includes(original);
    const staticFallback = saved && note.images[index].kind === "live" && saved.kind !== "live";
    const marker = tile.children[tile.children.length - 1];
    marker.textContent = failed ? "保存失败" : saved ? staticFallback ? "已保存 · 静态图" : saved.quality === "page" ? "已保存 · 页面版本" : "已保存" : "";
    marker.classList.toggle("hidden", !marker.textContent);
    marker.classList.toggle("warning", Boolean(failed || staticFallback || saved?.quality === "page"));
    tile.classList.toggle("has-result", Boolean(marker.textContent));
  });
  updateSelectionUi();
}

function applySession() {
  folderPath = session.folderPath || "";
  elements.folderPath.textContent = folderPath || "尚未选择文件夹";
  elements.folderPath.title = folderPath;
  elements.chooseFolder.textContent = folderPath ? "更改文件夹…" : "选择文件夹…";
  if (Array.isArray(session.albums)) {
    const previous = elements.album.value;
    elements.album.replaceChildren(new Option("图库（不指定相簿）", ""));
    session.albums.forEach((album) => elements.album.add(new Option(album.name, album.id)));
    elements.album.value = [...elements.album.options].some((option) => option.value === previous) ? previous : "";
    elements.loadAlbums.textContent = "刷新相簿";
  }
  targetSummary();
  const job = session.connectorJob;
  busy = Boolean(job?.busy);
  ui.taskProgress.classList.toggle("hidden", !busy || job?.payload?.action !== "save");
  ui.taskProgress.value = job?.progress?.total ? job.progress.completed / job.progress.total * 100 : 0;
  ui.changeTargetButton.disabled = busy;
  ui.confirmTargetButton.disabled = busy;
  ui.closeTargetButton.disabled = busy;
  if (busy && job.payload.action === "save") {
    elements.save.classList.remove("hidden");
    elements.result.classList.add("hidden");
    ui.detailsButton.classList.add("hidden");
  }
  elements.stop.classList.toggle("hidden", !busy || job?.payload?.action !== "save");
  elements.retryFailed.classList.toggle("hidden", busy || job?.payload?.pageUrl !== note.url
    || !job?.result?.failedIndices?.length);
  updateSelectionUi();
  if (busy) {
    elements.saveLabel.textContent = job.payload.action === "save"
      ? job.payload.destination === "folder" ? "正在保存…" : "正在导入…"
      : "请稍候…";
    if (job.progress) {
      const { phase, completed, total } = job.progress;
      elements.saveLabel.textContent = `${phase === "import" ? "正在导入" : "正在处理"} ${completed}/${total}`;
    }
  } else if (job?.result && job.result !== dismissedResult && job.payload.pageUrl === note.url) {
    if (job.payload.action === "save") {
      showSaveResult(job.payload, job.result);
    }
  }
}

function setView(view) {
  elements.loading.classList.toggle("hidden", view !== "loading");
  elements.empty.classList.toggle("hidden", view !== "empty");
  elements.gallery.classList.toggle("hidden", view !== "gallery");
  elements.actionBar.classList.toggle("hidden", view !== "gallery" || historyOpen);
}

function showToast(message, duration = 2400) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.add("show");
  toastTimer = setTimeout(() => elements.toast.classList.remove("show"), duration);
}

function setEmpty(title, message) {
  elements.emptyTitle.textContent = title;
  elements.emptyMessage.textContent = message;
  setView("empty");
}

function updateSelectionUi() {
  updateDuplicateHint();
  const count = selected.size;
  elements.count.textContent = `已选 ${count} / ${note.images.length} 张`;
  elements.toggleAll.textContent = count === note.images.length ? "取消全选" : "全部选择";
  const local = elements.destination.value === "folder";
  elements.save.disabled = busy || (!resultMode && (count === 0 || count > 30 || (local && !folderPath)));
  if (!busy) elements.saveLabel.textContent = resultMode ? "继续选图" : count > 30 ? "最多选择 30 张" : count ? `${local ? "保存" : "导入"} ${count} 张` : "请选择图片";
  [elements.refresh, elements.retry, elements.destination,
    elements.album, elements.loadAlbums, elements.chooseFolder].forEach((control) => {
    control.disabled = busy;
  });
  elements.toggleAll.disabled = busy || resultMode;
  elements.actionBar.setAttribute("aria-busy", String(busy));
  [...elements.grid.children].forEach((button, index) => {
    button.disabled = busy || resultMode;
    button.children[0].disabled = busy || resultMode;
    button.children[0].setAttribute("aria-pressed", String(selected.has(index)));
    button.setAttribute("aria-pressed", String(selected.has(index)));
  });
}

function renderGallery() {
  elements.title.textContent = note.title;
  elements.title.title = note.title;
  elements.grid.replaceChildren();

  note.images.forEach((item, index) => {
    const button = document.createElement("div");
    const pick = document.createElement("button");
    pick.type = "button"; pick.className = "pick";
    button.className = "image-item";
    pick.setAttribute("aria-label", `选择第 ${item.index || index + 1} 张图片`);
    button.setAttribute("aria-pressed", "true");

    const image = document.createElement("img");
    image.src = item.previewUrl || item.url;
    image.alt = `笔记图片 ${item.index || index + 1}`;
    image.loading = "lazy";
    image.referrerPolicy = "no-referrer";

    const check = document.createElement("span");
    check.className = "check";
    check.textContent = "✓";
    const number = document.createElement("span");
    number.className = "image-number";
    number.textContent = String(item.index || index + 1).padStart(2, "0");

    const badge = document.createElement("span");
    badge.className = "media-badge";
    badge.textContent = item.kind === "live" ? "LIVE" : item.kind === "gif" ? "GIF" : "";
    badge.classList.toggle("hidden", !badge.textContent);

    pick.append(image, check, number, badge);
    const zoom = document.createElement("button"); zoom.type = "button"; zoom.className = "zoom";
    zoom.textContent = "⤢"; zoom.setAttribute("aria-label", `放大第 ${item.index || index + 1} 张`);
    zoom.addEventListener("click", () => { previewIndex = index; renderPreview(); openDialog(ui.previewDialog); });
    const marker = document.createElement("span"); marker.className = "result-marker hidden";
    button.append(pick, zoom, marker);
    pick.addEventListener("click", () => {
      if (busy || resultMode) return;
      selected.has(index) ? selected.delete(index) : selected.add(index);
      updateSelectionUi();
      void rememberDraft();
    });
    elements.grid.append(button);
  });

  updateSelectionUi();
  setView("gallery");
}

async function getSourceTab() {
  if (sourceTabId) return chrome.tabs.get(sourceTabId);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  sourceTabId = tab?.id;
  return tab;
}

async function collect() {
  resultMode = false;
  elements.result.classList.add("hidden");
  setView("loading");
  elements.refresh.disabled = true;
  try {
    const tab = await getSourceTab();
    if (!tab?.id || !/^https?:\/\/([\w-]+\.)*xiaohongshu\.com\//i.test(tab.url || "")) {
      setEmpty("这不是小红书页面", "请先在网页版小红书打开一篇图文笔记，然后再试一次。");
      return;
    }

    let response;
    try {
      response = await chrome.tabs.sendMessage(tab.id, { type: "COLLECT_NOTE_IMAGES" });
    } catch {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["note-parser.js", "content.js"] });
      response = await chrome.tabs.sendMessage(tab.id, { type: "COLLECT_NOTE_IMAGES" });
    }

    let runtimeResponse = null;
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id }, world: "MAIN", files: ["note-parser.js"]
      });
      const injected = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: "MAIN",
        func: () => globalThis.RednoteParser.fromState(window.__INITIAL_STATE__, location.href, document.title)
      });
      runtimeResponse = injected?.[0]?.result || null;
    } catch {
      // The content-script result remains usable when the main world is unavailable.
    }
    response = bestNoteResult([response, runtimeResponse], tab.url || "");

    if (!response?.images?.length) {
      setEmpty("没有找到可保存的图片", "试试先点开笔记详情、等待图片加载完成，再重新读取。");
      return;
    }

    note = {
      title: response.title || "小红书笔记",
      url: response.url || tab.url || "",
      images: response.images
    };
    selected = new Set(note.images.map((_, index) => index));
    const draft = session.popupDraft;
    if (draft?.pageUrl === note.url) {
      selected = new Set(draft.selected.filter((index) => index >= 0 && index < note.images.length));
      elements.destination.value = draft.targetSnapshot?.destination || draft.destination;
      if ([...elements.album.options].some((option) => option.value === draft.albumId)) {
        elements.album.value = draft.albumId;
      }
    }
    updateDestinationUi();
    renderGallery();
    await restoreHistoryPreviews().catch(error => showToast(`首图已恢复，但记录更新失败：${error.message}`, 6000));
    renderHistory();
    applySession();
    if (draft?.pageUrl === note.url && draft.targetDraft) {
      targetSnapshot = draft.targetSnapshot;
      elements.destination.value = draft.targetDraft.destination;
      elements.album.value = draft.targetDraft.albumId;
      updateDestinationUi(); openDialog(ui.targetDialog);
    }
  } catch (error) {
    setEmpty("读取失败", error?.message || "请刷新小红书页面后重试。");
  } finally {
    elements.refresh.disabled = busy;
  }
}

elements.refresh.addEventListener("click", collect);
elements.clearHistory.addEventListener("click", () => openDialog(ui.clearDialog));
ui.confirmClearButton.addEventListener("click", async () => { await chrome.storage.local.set({ saveHistory: [] }); ui.clearDialog.close(); });
ui.cancelClearButton.addEventListener("click", () => ui.clearDialog.close());
ui.historyButton.addEventListener("click", switchHistory);
ui.changeTargetButton.addEventListener("click", () => {
  targetSnapshot = { destination: elements.destination.value, albumId: elements.album.value, folderPath };
  openDialog(ui.targetDialog);
});
function cancelTarget() {
  if (targetSnapshot) {
    elements.destination.value = targetSnapshot.destination; elements.album.value = targetSnapshot.albumId;
    folderPath = targetSnapshot.folderPath || "";
    session.folderPath = folderPath;
    elements.folderPath.textContent = folderPath || "尚未选择文件夹";
    void chrome.storage.session.set({ folderPath });
    void chrome.storage.local.set({ folderPath });
  }
  targetSnapshot = undefined;
  updateDestinationUi(); updateSelectionUi(); void rememberDraft();
}
ui.closeTargetButton.addEventListener("click", () => { cancelTarget(); ui.targetDialog.close(); });
ui.targetDialog.addEventListener("cancel", (event) => { if (busy) event.preventDefault(); else cancelTarget(); });
ui.confirmTargetButton.addEventListener("click", async () => {
  if (elements.destination.value === "folder" && !folderPath) { showToast("请先选择文件夹"); return; }
  targetSnapshot = undefined; await rememberDraft(); await rememberDestination();
  targetSummary(); ui.targetDialog.close(); updateSelectionUi();
});
ui.closePreviewButton.addEventListener("click", () => ui.previewDialog.close());
ui.previousImageButton.addEventListener("click", () => { previewIndex = (previewIndex + note.images.length - 1) % note.images.length; renderPreview(); });
ui.nextImageButton.addEventListener("click", () => { previewIndex = (previewIndex + 1) % note.images.length; renderPreview(); });
ui.previewSelectButton.addEventListener("click", () => {
  if (busy || resultMode) return;
  selected.has(previewIndex) ? selected.delete(previewIndex) : selected.add(previewIndex);
  updateSelectionUi(); renderPreview(); void rememberDraft();
});
ui.detailsButton.addEventListener("click", () => showDetails("保存详情", resultDetails));
ui.closeDetailsButton.addEventListener("click", () => ui.detailsDialog.close());
function continueSelection() {
  resultMode = false; dismissedResult = session.connectorJob?.result;
  [elements.result, elements.retryFailed, ui.detailsButton].forEach(control => control.classList.add("hidden"));
  ui.changeTargetButton.classList.remove("hidden"); elements.save.classList.remove("hidden");
  renderGallery();
}
elements.stop.addEventListener("click", async () => {
  if (!busy) return;
  await chrome.runtime.sendMessage({ type: "CONNECTOR_CANCEL" });
  elements.saveLabel.textContent = "正在停止…";
});
elements.retryFailed.addEventListener("click", async () => {
  const job = session.connectorJob;
  if (busy || job?.payload?.pageUrl !== note.url || !job?.result?.failedIndices?.length) return;
  const failed = new Set(job.result.failedIndices);
  const payload = { ...job.payload, uiSavedItems: [...(job.payload.uiSavedItems || []), ...(job.result.items || [])], images: job.payload.images.filter((item) => failed.has(item.index)) };
  if (!payload.images.length) return;
  busy = true;
  elements.retryFailed.classList.add("hidden");
  updateSelectionUi();
  try {
    const result = await chrome.runtime.sendMessage({ type: "CONNECTOR_REQUEST", payload });
    showSaveResult(payload, result);
  } catch (error) {
    showSaveResult(payload, { ok: false, error: error.message });
  } finally {
    busy = false;
    applySession();
  }
});
elements.retry.addEventListener("click", collect);
elements.toggleAll.addEventListener("click", () => {
  if (busy) return;
  selected = selected.size === note.images.length
    ? new Set()
    : new Set(note.images.map((_, index) => index));
  updateSelectionUi();
  void rememberDraft();
});

function changeDestination() {
  updateDestinationUi();
  elements.result.classList.add("hidden");
  updateSelectionUi();
  void rememberDraft();
  if (!targetSnapshot) void rememberDestination();
}
elements.destination.addEventListener("change", changeDestination);
ui.photosTargetButton.addEventListener("click", () => { elements.destination.value = "photos"; changeDestination(); });
ui.folderTargetButton.addEventListener("click", () => { elements.destination.value = "folder"; changeDestination(); });
elements.album.addEventListener("change", () => { void rememberDraft(); if (!targetSnapshot) void rememberDestination(); });

elements.loadAlbums.addEventListener("click", async () => {
  if (busy) return;
  busy = true;
  updateSelectionUi();
  elements.loadAlbums.textContent = "正在读取…";
  try {
    const result = await sendToConnector({ action: "listAlbums" });
    if (!result.ok) throw new Error(result.error || "无法读取相簿");
    if (!Array.isArray(result.albums)) throw new Error("请重新运行 install.command 更新连接器");
    const previous = elements.album.value;
    elements.album.replaceChildren(new Option("图库（不指定相簿）", ""));
    result.albums.forEach((album) => elements.album.add(new Option(album.name, album.id)));
    elements.album.value = [...elements.album.options].some((option) => option.value === previous) ? previous : "";
    if (!targetSnapshot) await rememberDestination();
    if (!result.albums.length) showToast("还没有可选相簿，请先在“照片”中创建相簿");
  } catch (error) {
    showToast(error.message, 6000);
  } finally {
    busy = false;
    elements.loadAlbums.textContent = "刷新相簿";
    updateSelectionUi();
  }
});

elements.chooseFolder.addEventListener("click", async () => {
  if (busy) return;
  busy = true;
  updateSelectionUi();
  elements.chooseFolder.textContent = "正在选择…";
  try {
    const result = await sendToConnector({ action: "chooseFolder" });
    if (!result.ok) throw new Error(result.error || "无法选择文件夹");
    if (!result.cancelled) {
      if (!result.path) throw new Error("请重新运行 install.command 更新连接器");
      folderPath = result.path;
      elements.folderPath.textContent = folderPath;
      elements.folderPath.title = folderPath;
    }
  } catch (error) {
    showToast(error.message, 6000);
  } finally {
    busy = false;
    elements.chooseFolder.textContent = folderPath ? "更改文件夹…" : "选择文件夹…";
    updateSelectionUi();
  }
});

elements.save.addEventListener("click", async () => {
  if (busy) return;
  if (resultMode) { continueSelection(); return; }
  const images = note.images.filter((_, index) => selected.has(index));
  if (!images.length || images.length > 30) return;
  const local = elements.destination.value === "folder";
  if (local && !folderPath) return;

  resultMode = false;
  busy = true;
  elements.result.classList.add("hidden");
  updateSelectionUi();
  elements.saveLabel.textContent = local ? "正在保存…" : "正在导入…";
  try {
    const result = await sendToConnector({
      action: "save",
      destination: elements.destination.value,
      albumId: elements.album.value,
      folderPath,
      title: note.title,
      pageUrl: note.url,
      images: note.images.flatMap((item, index) => selected.has(index) ? [{
        index: item.index || index + 1,
        url: item.url,
        previewUrl: item.previewUrl || item.url,
        kind: item.kind,
        videoUrl: item.videoUrl || "",
        videoUrls: Array.isArray(item.videoUrls) ? item.videoUrls : []
      }] : [])
    });
    if (!result?.ok) {
      throw new Error(result?.error || "保存失败");
    }
    showSaveResult({ destination: elements.destination.value, albumId: elements.album.value,
      albumName: elements.album.selectedOptions[0]?.textContent || "" }, result);
  } catch (error) {
    elements.result.textContent = error?.message || "保存失败，请稍后再试";
    elements.result.classList.remove("hidden");
    showToast(elements.result.textContent, 6000);
  } finally {
    busy = false;
    updateSelectionUi();
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.saveHistory) {
    saveHistory = changes.saveHistory.newValue || [];
    renderHistory();
  }
  if (area !== "session") return;
  for (const [key, change] of Object.entries(changes)) session[key] = change.newValue;
  if (changes.connectorJob || changes.folderPath || changes.albums) applySession();
});

async function initialize() {
  const state = await chrome.runtime.sendMessage({ type: "CONNECTOR_STATE" });
  if (!state?.ok) throw new Error(state?.error || "无法读取后台任务状态");
  session = await chrome.storage.session.get(["popupDraft", "folderPath", "albums", "connectorJob"]);
  const local = await chrome.storage.local.get(["destinationPreferences", "folderPath", "saveHistory"]);
  saveHistory = local.saveHistory || [];
  renderHistory();
  if (!session.folderPath) session.folderPath = local.folderPath || "";
  const preferences = local.destinationPreferences;
  if (preferences) {
    elements.destination.value = preferences.destination === "folder" ? "folder" : "photos";
    if (preferences.albumId) {
      elements.album.add(new Option(preferences.albumName || "上次使用的相簿", preferences.albumId));
      elements.album.value = preferences.albumId;
    }
  }
  applySession();
  await collect();
}

initialize().catch((error) => setEmpty("读取失败", error.message || "请重新打开扩展"));
