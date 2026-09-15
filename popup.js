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
  toast: document.querySelector("#toast")
};

let note = { title: "小红书笔记", images: [] };
let selected = new Set();
let toastTimer;
const NATIVE_HOST = "com.rednote.photosaver";

function collectRuntimeNote() {
  const state = window.__INITIAL_STATE__;
  if (!state || typeof state !== "object") return null;
  const wantedId = location.pathname.match(/\/(?:explore|discovery\/item)\/([0-9a-z]+)/i)?.[1] || "";
  const validUrl = (value) => {
    if (typeof value !== "string" || !value.trim()) return "";
    try {
      const url = new URL(value, location.href);
      return /^https?:$/.test(url.protocol) ? url.href : "";
    } catch {
      return "";
    }
  };
  const videoUrls = (item) => {
    const stream = item?.stream || item?.streams || {};
    const variants = ["h264", "h265", "h266", "av1"].flatMap((codec) => {
      const value = stream[codec] || stream[codec.toUpperCase()] || [];
      return Array.isArray(value) ? value : [];
    });
    return [...new Set(variants.flatMap((variant) => [
      variant?.masterUrl || variant?.master_url || variant?.url,
      ...(variant?.backupUrls || variant?.backup_urls || [])
    ]).map(validUrl).filter(Boolean))];
  };

  const seen = new WeakSet();
  const queue = [state];
  const candidates = [];
  let cursor = 0;
  let inspected = 0;
  while (cursor < queue.length && inspected < 50000) {
    const value = queue[cursor++];
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    inspected += 1;
    const imageList = value.imageList || value.image_list;
    if (Array.isArray(imageList) && imageList.length) {
      const noteId = String(value.noteId || value.note_id || "");
      if (!wantedId || noteId === wantedId) {
        const count = imageList.reduce((total, item) => total + videoUrls(item).length, 0);
        candidates.push({ value, score: count * 100 + imageList.length });
      }
    }
    for (const child of Object.values(value)) {
      if (child && typeof child === "object") queue.push(child);
    }
  }

  const noteData = candidates.sort((a, b) => b.score - a.score)[0]?.value;
  if (!noteData) return null;
  const images = (noteData.imageList || noteData.image_list).map((item) => {
    const infoList = item.infoList || item.info_list || [];
    const preview = infoList.find((value) => value?.imageScene === "WB_PRV") || infoList[0] || {};
    const original = infoList.find((value) => value?.imageScene === "WB_DFT")
      || infoList[infoList.length - 1]
      || infoList[0]
      || {};
    const url = validUrl(item.urlDefault || item.url_default || item.urlPre || item.url_pre || original.url || "");
    const videos = videoUrls(item);
    const live = Boolean(item.livePhoto || item.live_photo || videos.length);
    return {
      url,
      previewUrl: validUrl(preview.url) || url,
      width: Number(item.width || original.width) || 800,
      height: Number(item.height || original.height) || 1000,
      kind: live ? "live" : /gif/i.test(String(item.imageType || item.image_type || original.format || url)) ? "gif" : "image",
      videoUrl: videos[0] || "",
      videoUrls: videos
    };
  }).filter((item) => item.url);
  return images.length ? {
    noteId: String(noteData.noteId || noteData.note_id || ""),
    title: String(noteData.title || noteData.desc || document.title || "小红书笔记").trim().slice(0, 80),
    url: location.href,
    images
  } : null;
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

function sendToPhotosConnector(payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendNativeMessage(NATIVE_HOST, payload, (response) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error("尚未安装照片连接器，请先运行 install.command"));
        return;
      }
      resolve(response || { ok: false, error: "本机连接器没有返回结果" });
    });
  });
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
  elements.save.disabled = count === 0;
  elements.saveLabel.textContent = count ? `导入 ${count} 张` : "请选择图片";
  [...elements.grid.children].forEach((button, index) => {
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
    button.setAttribute("aria-label", `第 ${index + 1} 张图片`);
    button.setAttribute("aria-pressed", "true");

    const image = document.createElement("img");
    image.src = item.previewUrl || item.url;
    image.alt = `笔记图片 ${index + 1}`;
    image.loading = "lazy";
    image.referrerPolicy = "no-referrer";

    const check = document.createElement("span");
    check.className = "check";
    check.textContent = "✓";
    const number = document.createElement("span");
    number.className = "image-number";
    number.textContent = String(index + 1).padStart(2, "0");

    const badge = document.createElement("span");
    badge.className = "media-badge";
    badge.textContent = item.kind === "live" ? "LIVE" : item.kind === "gif" ? "GIF" : "";
    badge.classList.toggle("hidden", !badge.textContent);

    button.append(image, check, number, badge);
    button.addEventListener("click", () => {
      selected.has(index) ? selected.delete(index) : selected.add(index);
      updateSelectionUi();
    });
    elements.grid.append(button);
  });

  updateSelectionUi();
  setView("gallery");
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function collect() {
  setView("loading");
  elements.refresh.disabled = true;
  try {
    const tab = await getActiveTab();
    if (!tab?.id || !/^https?:\/\/([\w-]+\.)*xiaohongshu\.com\//i.test(tab.url || "")) {
      setEmpty("这不是小红书页面", "请先在网页版小红书打开一篇图文笔记，然后再试一次。");
      return;
    }

    let response;
    try {
      response = await chrome.tabs.sendMessage(tab.id, { type: "COLLECT_NOTE_IMAGES" });
    } catch {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
      response = await chrome.tabs.sendMessage(tab.id, { type: "COLLECT_NOTE_IMAGES" });
    }

    let runtimeResponse = null;
    try {
      const injected = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: "MAIN",
        func: collectRuntimeNote
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
    renderGallery();
  } catch (error) {
    setEmpty("读取失败", error?.message || "请刷新小红书页面后重试。");
  } finally {
    elements.refresh.disabled = false;
  }
}

elements.refresh.addEventListener("click", collect);
elements.retry.addEventListener("click", collect);
elements.toggleAll.addEventListener("click", () => {
  selected = selected.size === note.images.length
    ? new Set()
    : new Set(note.images.map((_, index) => index));
  updateSelectionUi();
});

elements.save.addEventListener("click", async () => {
  const images = note.images.filter((_, index) => selected.has(index));
  if (!images.length) return;

  elements.save.disabled = true;
  elements.saveLabel.textContent = "正在导入…";
  try {
    const result = await sendToPhotosConnector({
      title: note.title,
      pageUrl: note.url,
      images: images.map((item) => ({
        url: item.url,
        kind: item.kind,
        videoUrl: item.videoUrl || "",
        videoUrls: Array.isArray(item.videoUrls) ? item.videoUrls : []
      }))
    });
    if (!result?.ok) {
      throw new Error(result?.error || "照片导入失败");
    }
    const failedText = result.failed ? `，${result.failed} 张失败` : "";
    const fallbackText = result.liveFallback ? `，${result.liveFallback} 张仅保存静态图` : "";
    const fallbackDetail = result.liveFallbackDetails?.[0] ? `（${result.liveFallbackDetails[0]}）` : "";
    showToast(`已导入 ${result.saved} 张到“照片”${failedText}${fallbackText}${fallbackDetail}`,
      result.liveFallback ? 8000 : 2400);
    elements.saveLabel.textContent = "导入完成";
    setTimeout(updateSelectionUi, 1200);
  } catch (error) {
    showToast(error?.message || "导入失败，请稍后再试", 6000);
    updateSelectionUi();
  }
});

collect();
