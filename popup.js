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
  retryFailed: document.querySelector("#retryFailedButton")
};

let note = { title: "小红书笔记", images: [] };
let selected = new Set();
let toastTimer;
let busy = false;
let folderPath = "";
let sourceTabId;
let session = {};

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
    albumId: elements.album.value
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
  const local = elements.destination.value === "folder";
  elements.albumSettings.classList.toggle("hidden", local);
  elements.folderSettings.classList.toggle("hidden", !local);
  elements.destinationHint.textContent = local
    ? "选择文件夹后若弹窗关闭，再点扩展即可继续"
    : "原图、GIF、实况 · 可同步 iCloud";
}

function showSaveResult(payload, result, toast = false) {
  if (!result.ok) {
    elements.result.textContent = result.error || "保存失败，请稍后再试";
  } else {
    const local = payload.destination === "folder";
    const target = local ? "本地文件夹" : payload.albumId ? `相簿“${payload.albumName}”` : "“照片”";
    const failedText = result.failed ? `，${result.failed} 张失败` : "";
    const fallbackText = result.liveFallback ? `，${result.liveFallback} 张仅保存静态图` : "";
    const qualityText = result.qualityFallbackDetails?.length ? `，${result.qualityFallbackDetails.length} 张使用页面版本` : "";
    const summary = `已${local ? "保存" : "导入"} ${result.saved} 张到${target}${failedText}${fallbackText}${qualityText}`;
    elements.result.textContent = [summary, ...(result.failureDetails || []),
      ...(result.liveFallbackDetails || []), ...(result.qualityFallbackDetails || []),
      local ? result.folderPath : ""].filter(Boolean).join("\n");
  }
  elements.result.classList.remove("hidden");
  if (toast) showToast(elements.result.textContent, 6000);
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
  const job = session.connectorJob;
  busy = Boolean(job?.busy);
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
  } else if (job?.result && job.payload.pageUrl === note.url) {
    if (job.payload.action === "save" || !job.result.ok) {
      showSaveResult(job.payload, job.result);
    }
  }
}

function setView(view) {
  elements.loading.classList.toggle("hidden", view !== "loading");
  elements.empty.classList.toggle("hidden", view !== "empty");
  elements.gallery.classList.toggle("hidden", view !== "gallery");
  elements.actionBar.classList.toggle("hidden", view !== "gallery");
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
  const count = selected.size;
  elements.count.textContent = `已选 ${count} / ${note.images.length} 张`;
  elements.toggleAll.textContent = count === note.images.length ? "取消全选" : "全部选择";
  const local = elements.destination.value === "folder";
  elements.save.disabled = busy || count === 0 || count > 30 || (local && !folderPath);
  if (!busy) elements.saveLabel.textContent = count > 30 ? "最多选择 30 张" : count ? `${local ? "保存" : "导入"} ${count} 张` : "请选择图片";
  [elements.refresh, elements.retry, elements.toggleAll, elements.destination,
    elements.album, elements.loadAlbums, elements.chooseFolder].forEach((control) => {
    control.disabled = busy;
  });
  elements.actionBar.setAttribute("aria-busy", String(busy));
  [...elements.grid.children].forEach((button, index) => {
    button.disabled = busy;
    button.setAttribute("aria-pressed", String(selected.has(index)));
  });
}

function renderGallery() {
  elements.title.textContent = note.title;
  elements.title.title = note.title;
  elements.grid.replaceChildren();

  note.images.forEach((item, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "image-item";
    button.setAttribute("aria-label", `第 ${item.index || index + 1} 张图片`);
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

    button.append(image, check, number, badge);
    button.addEventListener("click", () => {
      if (busy) return;
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
      elements.destination.value = draft.destination;
      if ([...elements.album.options].some((option) => option.value === draft.albumId)) {
        elements.album.value = draft.albumId;
      }
    }
    updateDestinationUi();
    renderGallery();
    applySession();
  } catch (error) {
    setEmpty("读取失败", error?.message || "请刷新小红书页面后重试。");
  } finally {
    elements.refresh.disabled = busy;
  }
}

elements.refresh.addEventListener("click", collect);
elements.retryFailed.addEventListener("click", async () => {
  const job = session.connectorJob;
  if (busy || job?.payload?.pageUrl !== note.url || !job?.result?.failedIndices?.length) return;
  const failed = new Set(job.result.failedIndices);
  const payload = { ...job.payload, images: job.payload.images.filter((item) => failed.has(item.index)) };
  if (!payload.images.length) return;
  busy = true;
  elements.retryFailed.classList.add("hidden");
  updateSelectionUi();
  try {
    const result = await chrome.runtime.sendMessage({ type: "CONNECTOR_REQUEST", payload });
    showSaveResult(payload, result, true);
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

elements.destination.addEventListener("change", () => {
  updateDestinationUi();
  elements.result.classList.add("hidden");
  updateSelectionUi();
  void rememberDraft();
});
elements.album.addEventListener("change", () => { void rememberDraft(); });

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
  const images = note.images.filter((_, index) => selected.has(index));
  if (!images.length || images.length > 30) return;
  const local = elements.destination.value === "folder";
  if (local && !folderPath) return;

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
        kind: item.kind,
        videoUrl: item.videoUrl || "",
        videoUrls: Array.isArray(item.videoUrls) ? item.videoUrls : []
      }] : [])
    });
    if (!result?.ok) {
      throw new Error(result?.error || "保存失败");
    }
    showSaveResult({ destination: elements.destination.value, albumId: elements.album.value,
      albumName: elements.album.selectedOptions[0]?.textContent || "" }, result, true);
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
  if (area !== "session") return;
  for (const [key, change] of Object.entries(changes)) session[key] = change.newValue;
  if (changes.connectorJob || changes.folderPath || changes.albums) applySession();
});

async function initialize() {
  const state = await chrome.runtime.sendMessage({ type: "CONNECTOR_STATE" });
  if (!state?.ok) throw new Error(state?.error || "无法读取后台任务状态");
  session = await chrome.storage.session.get(["popupDraft", "folderPath", "albums", "connectorJob"]);
  applySession();
  await collect();
}

initialize().catch((error) => setEmpty("读取失败", error.message || "请重新打开扩展"));
