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

  function collectStructuredNote() {
    const marker = "window.__INITIAL_STATE__=";
    const results = [];
    for (const stateScript of [...document.scripts].filter((script) => script.textContent?.includes(marker))) {
      const start = stateScript.textContent.indexOf(marker) + marker.length;
      const rawState = stateScript.textContent.slice(start).trim().replace(/;<\/script>.*$/s, "").replace(/;$/, "");
      try {
        const normalized = RednoteParser.fromState(RednoteParser.parseState(rawState), location.href, getTitle());
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
    return [...new Set(urls.map(validHttpUrl).filter((url) =>
      /(?:^|\.)(?:xiaohongshu\.com|xhscdn\.(?:com|net))$/i.test(hostnameOf(url))
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

    const detailRoot = document.querySelector([
      ".note-detail-mask",
      '[class*="note-detail-mask"]',
      "#noteContainer",
      ".note-container",
      '[class*="note-container"]'
    ].join(", "));
    if (!RednoteParser.noteIdFromUrl(location.href) || !detailRoot) return [];
    const mediaRoot = detailRoot.querySelector([
      ".media-container",
      '[class*="media-container"]',
      ".swiper-wrapper",
      '[class*="swiper-wrapper"]',
      '[class*="carousel"]',
      '[class*="gallery"]'
    ].join(", ")) || detailRoot;
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
      .map(({ url, width, height }, index, array) => ({
        index: index + 1,
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
