(() => {
  const MIN_WIDTH = 240;
  const MIN_HEIGHT = 180;

  function unwrapCssUrl(value) {
    const match = value?.match(/url\(["']?(.*?)["']?\)/i);
    return match?.[1] || "";
  }

  function validHttpUrl(value) {
    if (typeof value !== "string" || !value.trim()) return "";
    try {
      const url = new URL(value, location.href);
      return /^https?:$/.test(url.protocol) ? url.href : "";
    } catch {
      return "";
    }
  }

  function hostnameOf(value) {
    try {
      return new URL(value, location.href).hostname;
    } catch {
      return "";
    }
  }

  function qualityScore(candidate) {
    let score = Math.max(candidate.width * candidate.height, 1);
    if (/xhscdn\.(com|net)$/i.test(hostnameOf(candidate.url))) score *= 2;
    if (/avatar|icon|logo|emoji|qrcode/i.test(candidate.hint)) score *= 0.02;
    if (/note|swiper|carousel|content|gallery|slide/i.test(candidate.hint)) score *= 3;
    return score;
  }

  function canonicalKey(rawUrl) {
    try {
      const url = new URL(rawUrl, location.href);
      url.search = "";
      url.hash = "";
      url.pathname = url.pathname.replace(/![^/]+$/, "");
      return `${url.hostname}${url.pathname}`.toLowerCase();
    } catch {
      return rawUrl;
    }
  }

  function bestFromSrcset(srcset) {
    if (!srcset) return "";
    const entries = srcset.split(",").map((entry) => {
      const [url, size = "0"] = entry.trim().split(/\s+/);
      return { url: validHttpUrl(url), size: Number.parseFloat(size) || 0 };
    }).filter((entry) => entry.url);
    entries.sort((a, b) => b.size - a.size);
    return entries[0]?.url || "";
  }

  function currentNoteId() {
    return location.pathname.match(/\/(?:explore|discovery\/item)\/([0-9a-z]+)/i)?.[1] || "";
  }

  function videoUrlsFromImageItem(item) {
    const stream = item?.stream || item?.streams || {};
    const variants = ["h264", "h265", "h266", "av1"].flatMap((codec) => {
      const value = stream[codec] || stream[codec.toUpperCase()] || [];
      return Array.isArray(value) ? value : [];
    });
    return [...new Set(variants.flatMap((variant) => [
      variant?.masterUrl || variant?.master_url || variant?.url,
      ...(variant?.backupUrls || variant?.backup_urls || [])
    ]).map(validHttpUrl).filter(Boolean))];
  }

  function normalizeStructuredNote(noteData) {
    const imageList = noteData?.imageList || noteData?.image_list || [];
    const images = imageList.map((item) => {
      const infoList = item.infoList || item.info_list || [];
      const previewInfo = infoList.find((value) => value?.imageScene === "WB_PRV") || infoList[0] || {};
      const imageInfo = infoList.find((value) => value?.imageScene === "WB_DFT")
        || infoList[infoList.length - 1]
        || infoList[0]
        || {};
      const imageUrl = validHttpUrl(
        item.urlDefault || item.url_default || item.urlPre || item.url_pre || imageInfo.url || ""
      );
      const videoUrls = videoUrlsFromImageItem(item);
      const formatHint = String(item.imageType || item.image_type || imageInfo.format || imageUrl);
      const isLive = Boolean(item.livePhoto || item.live_photo || videoUrls.length);

      return {
        url: imageUrl,
        previewUrl: validHttpUrl(previewInfo.url) || imageUrl,
        width: Number(item.width || imageInfo.width) || 800,
        height: Number(item.height || imageInfo.height) || 1000,
        kind: isLive ? "live" : /gif/i.test(formatHint) ? "gif" : "image",
        videoUrl: videoUrls[0] || "",
        videoUrls
      };
    }).filter((item) => item.url);

    if (!images.length) return null;
    return {
      noteId: String(noteData.noteId || noteData.note_id || ""),
      title: String(noteData.title || noteData.desc || getTitle()).trim().slice(0, 80),
      url: location.href,
      images
    };
  }

  function findBestNoteData(root) {
    if (!root || typeof root !== "object") return null;
    const wantedId = currentNoteId();
    const seen = new WeakSet();
    const candidates = [];
    const queue = [root];
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
        const videoCount = imageList.reduce((total, item) => total + videoUrlsFromImageItem(item).length, 0);
        const liveCount = imageList.filter((item) => item?.livePhoto || item?.live_photo).length;
        const idScore = wantedId && noteId === wantedId ? 1000000 : wantedId ? 0 : 1000;
        candidates.push({ value, score: idScore + videoCount * 100 + liveCount * 10 + imageList.length });
      }

      for (const child of Object.values(value)) {
        if (child && typeof child === "object") queue.push(child);
      }
    }

    const matching = wantedId
      ? candidates.filter((candidate) => String(candidate.value.noteId || candidate.value.note_id || "") === wantedId)
      : candidates;
    return matching.sort((a, b) => b.score - a.score)[0]?.value || null;
  }

  function collectStructuredNote() {
    const marker = "window.__INITIAL_STATE__=";
    const results = [];
    for (const stateScript of [...document.scripts].filter((script) => script.textContent?.includes(marker))) {
      const start = stateScript.textContent.indexOf(marker) + marker.length;
      const rawState = stateScript.textContent.slice(start).trim().replace(/;<\/script>.*$/s, "").replace(/;$/, "");
      try {
        const noteData = findBestNoteData(JSON.parse(rawState.replace(/\bundefined\b/g, "null")));
        const normalized = normalizeStructuredNote(noteData);
        if (normalized) results.push(normalized);
      } catch {
        // A different state block may still contain the current note.
      }
    }
    return results.sort((a, b) => {
      const videos = (note) => note.images.reduce((total, item) => total + item.videoUrls.length, 0);
      return videos(b) - videos(a);
    })[0] || null;
  }

  function collectVisibleLiveVideoUrls(root) {
    const urls = [];
    root.querySelectorAll("video, video source").forEach((element) => {
      urls.push(element.currentSrc, element.src, element.getAttribute("src"));
    });
    for (const entry of performance.getEntriesByType("resource")) {
      if (entry.initiatorType === "video" || /(?:sns-video|\/stream\/|\.mp4(?:$|\?))/i.test(entry.name)) {
        urls.push(entry.name);
      }
    }
    return [...new Set(urls.map(validHttpUrl).filter((url) =>
      /(?:xiaohongshu\.com|xhscdn\.(?:com|net))$/i.test(hostnameOf(url))
    ))];
  }

  function collectImages() {
    const candidates = [];
    const add = (url, width, height, hint = "") => {
      const safeUrl = validHttpUrl(url);
      if (!safeUrl) return;
      if (/\.svg(?:$|\?)/i.test(safeUrl)) return;
      if ((width && width < MIN_WIDTH) || (height && height < MIN_HEIGHT)) return;
      candidates.push({ url: safeUrl, width: width || 800, height: height || 1000, hint });
    };

    document.querySelectorAll('meta[property="og:image"], meta[name="twitter:image"]').forEach((meta) => {
      add(meta.content, 1600, 2000, "note metadata");
    });

    const detailRoot = document.querySelector([
      ".note-detail-mask",
      '[class*="note-detail-mask"]',
      "#noteContainer",
      ".note-container",
      '[class*="note-container"]'
    ].join(", "));
    const mediaRoot = detailRoot?.querySelector([
      ".media-container",
      '[class*="media-container"]',
      ".swiper-wrapper",
      '[class*="swiper-wrapper"]',
      '[class*="carousel"]',
      '[class*="gallery"]'
    ].join(", ")) || detailRoot || document;
    const visibleText = [...mediaRoot.querySelectorAll("span, div")].some((element) =>
      element.children.length === 0
        && /^LIVE$/i.test(element.textContent?.trim() || "")
        && element.getBoundingClientRect().width > 0
    );
    const visibleVideoUrls = collectVisibleLiveVideoUrls(mediaRoot);

    mediaRoot.querySelectorAll("img").forEach((img) => {
      const box = img.getBoundingClientRect();
      const width = img.naturalWidth || box.width;
      const height = img.naturalHeight || box.height;
      const context = [
        img.alt,
        img.className,
        img.parentElement?.className,
        img.closest('[class*="swiper"], [class*="note"], [class*="carousel"], [class*="gallery"], [class*="slide"]')?.className
      ].filter((value) => typeof value === "string").join(" ");
      add(bestFromSrcset(img.srcset) || img.currentSrc || img.src, width, height, context);
    });

    mediaRoot.querySelectorAll('[style*="background-image"]').forEach((element) => {
      const box = element.getBoundingClientRect();
      add(unwrapCssUrl(getComputedStyle(element).backgroundImage), box.width * devicePixelRatio, box.height * devicePixelRatio, element.className || "background");
    });

    const deduped = new Map();
    for (const item of candidates) {
      const key = canonicalKey(item.url);
      const previous = deduped.get(key);
      if (!previous || qualityScore(item) > qualityScore(previous)) deduped.set(key, item);
    }

    let items = [...deduped.values()].filter((item) => qualityScore(item) >= MIN_WIDTH * MIN_HEIGHT);
    const noteItems = items.filter((item) => /note|swiper|carousel|content|gallery|slide/i.test(item.hint));
    if (noteItems.length >= 2) items = noteItems;

    return items
      .sort((a, b) => {
        const aElement = [...document.images].find((img) => canonicalKey(img.currentSrc || img.src) === canonicalKey(a.url));
        const bElement = [...document.images].find((img) => canonicalKey(img.currentSrc || img.src) === canonicalKey(b.url));
        if (!aElement || !bElement) return qualityScore(b) - qualityScore(a);
        return aElement.compareDocumentPosition(bElement) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
      })
      .slice(0, 30)
      .map(({ url, width, height }, index, array) => ({
        url,
        width,
        height,
        kind: (visibleText || visibleVideoUrls.length) && array.length === 1
          ? "live"
          : /\.gif(?:$|[?!])/i.test(url) ? "gif" : "image",
        videoUrl: array.length === 1 ? visibleVideoUrls[0] || "" : "",
        videoUrls: array.length === 1 ? visibleVideoUrls : []
      }));
  }

  function getTitle() {
    const selectors = [
      "#detail-title",
      ".note-content .title",
      '[class*="note"] [class*="title"]',
      "h1",
      'meta[property="og:title"]'
    ];
    for (const selector of selectors) {
      const element = document.querySelector(selector);
      const value = element?.content || element?.textContent;
      if (value?.trim()) return value.trim().replace(/\s+/g, " ").slice(0, 80);
    }
    return document.title.replace(/\s*[-–_].*小红书.*$/i, "").trim() || "小红书笔记";
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "COLLECT_NOTE_IMAGES") return;
    let structured = null;
    try {
      structured = collectStructuredNote();
    } catch {
      // Fall through to visible-page collection.
    }
    if (structured) {
      sendResponse(structured);
      return;
    }
    let images = [];
    try {
      images = collectImages();
    } catch {
      // One malformed page resource must not abort the whole popup.
    }
    sendResponse({ title: getTitle(), url: location.href, images });
  });
})();
