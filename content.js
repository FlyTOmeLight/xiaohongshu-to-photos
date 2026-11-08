(() => {
  const MIN_WIDTH = 240;
  const MIN_HEIGHT = 180;
  const SITE = RednoteParser.siteFromUrl(location.href);

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

  function metaContent(selector) {
    return document.querySelector(selector)?.content?.trim() || "";
  }

  function getTweetTitle() {
    const text = document.querySelector('[data-testid="tweetText"]')?.textContent?.trim();
    if (text) return text.replace(/\s+/g, " ").slice(0, 80);
    const meta = metaContent('meta[property="og:title"]');
    if (meta) {
      return meta.replace(/^.*?\bon X:\s*["“]?/, "").replace(/["”]$/, "").replace(/\s+/g, " ").trim().slice(0, 80)
        || meta.replace(/\s+/g, " ").slice(0, 80);
    }
    return document.title.replace(/\s*\/\s*X$/, "").replace(/\s+/g, " ").trim().slice(0, 80) || "X 帖子";
  }

  function tweetMediaFromDom() {
    const articlePage = RednoteParser.articleIdFromUrl(location.href);
    const articleRoot = articlePage
      ? document.querySelector('[data-article-part="body"]')?.parentElement || document.querySelector('[data-article-part="body"]')
      : document.querySelector('article[data-testid="tweet"]') || document;
    const modal = document.querySelector('div[aria-modal="true"]')
      || document.querySelector('div[data-testid="swipe-to-dismiss"]')
      || document.querySelector('#layers');
    const modalRoot = modal?.querySelector?.('img[src*="pbs.twimg.com/media/"], video') ? modal : null;
    const root = modalRoot || articleRoot;
    const items = [];
    const seen = new Set();
    const push = (item) => {
      if (!item.url || seen.has(item.url)) return;
      seen.add(item.url);
      items.push({ ...item, index: items.length + 1 });
    };

    const mediaLinkId = RednoteParser.articleMediaIdFromUrl(location.href);
    root?.querySelectorAll('a[href*="/article/"] img[src*="pbs.twimg.com/media/"], img[src*="pbs.twimg.com/media/"]').forEach((img) => {
      const link = img.closest?.('a[href*="/article/"]');
      const linkMediaId = link?.href ? RednoteParser.articleMediaIdFromUrl(link.href) : "";
      if (mediaLinkId && linkMediaId && linkMediaId !== mediaLinkId) return;
      const url = RednoteParser.tweetImageUrl(img.currentSrc || img.src, location.href, "orig");
      if (!url) return;
      push({ url, previewUrl: RednoteParser.tweetImageUrl(url, location.href, "small"),
        width: img.naturalWidth || 0, height: img.naturalHeight || 0,
        kind: /\.gif(?:$|[?#])/i.test(url) ? "gif" : "image", videoUrl: "", videoUrls: [] });
    });

    root?.querySelectorAll("video").forEach((video) => {
      const rawPoster = video.poster || video.getAttribute?.("poster")
        || unwrapCssUrl(video.parentElement?.style?.backgroundImage)
        || unwrapCssUrl(video.closest?.('[data-testid="videoComponent"]')?.style?.backgroundImage);
      const poster = RednoteParser.tweetImageUrl(rawPoster, location.href, "orig");
      const direct = [video.currentSrc, video.src, ...[...(video.querySelectorAll?.("source") || [])].map((source) => source.src)]
        .find((value) => /^https?:/i.test(value || "") && /\.mp4(?:$|[?#])/i.test(value));
      const videoUrl = direct || metaContent('meta[property="og:video"]');
      const ogImage = RednoteParser.tweetImageUrl(metaContent('meta[property="og:image"]'), location.href, "orig");
      const url = poster || ogImage || (RednoteParser.statusIdFromUrl(location.href) ? "x-video-pending" : "");
      if (!url && !videoUrl) return;
      const gif = /tweet_video/i.test(poster) || /tweet_video/i.test(videoUrl);
      push({ url: url || videoUrl, previewUrl: poster, width: 0, height: 0,
        kind: gif ? "gif" : "video", videoUrl, videoUrls: videoUrl ? [videoUrl] : [] });
    });

    if (!items.length && !articlePage) {
      const image = RednoteParser.tweetImageUrl(
        metaContent('meta[property="og:image"]') || metaContent('meta[name="twitter:image"]'), location.href, "orig");
      const videoUrl = metaContent('meta[property="og:video"]');
      if (videoUrl) push({ url: image || videoUrl, previewUrl: image, width: 0, height: 0,
        kind: /tweet_video/i.test(videoUrl) ? "gif" : "video", videoUrl, videoUrls: [videoUrl] });
      else if (image) push({ url: image, previewUrl: RednoteParser.tweetImageUrl(image, location.href, "small"),
        width: 0, height: 0, kind: "image", videoUrl: "", videoUrls: [] });
    }
    return items;
  }

  function xVideoMediaKey(url) {
    try {
      const parsed = new URL(url);
      if (!/(?:^|\.)pbs\.twimg\.com$/i.test(parsed.hostname)) return "";
      return parsed.pathname.match(
        /\/(?:amplify_video_thumb|tweet_video_thumb|ext_tw_video_thumb)\/(\d+)\//i
      )?.[1] || "";
    } catch {
      return "";
    }
  }

  function needsXVideoLookup(item) {
    return (item.kind === "video" || item.kind === "gif") && !/^https?:/i.test(item.videoUrl || "");
  }

  function resolveXVideoMedia(statusId) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: "RESOLVE_X_MEDIA", statusId }, (response) => {
          if (chrome.runtime.lastError) {
            resolve([]);
            return;
          }
          resolve(Array.isArray(response?.media) ? response.media : []);
        });
      } catch {
        resolve([]);
      }
    });
  }

  async function enrichTweetVideos(statusId, images) {
    let media;
    try {
      media = (await resolveXVideoMedia(statusId)).filter((entry) =>
        entry && Array.isArray(entry.videoUrls) && entry.videoUrls.length);
    } catch {
      return images;
    }
    if (!media.length) return images;
    const used = new Set();
    return images.map((item) => {
      if (!needsXVideoLookup(item)) return item;
      const key = xVideoMediaKey(item.url);
      let position = key ? media.findIndex((entry) => xVideoMediaKey(entry.poster) === key) : -1;
      if (position < 0) position = media.findIndex((_, index) => !used.has(index));
      if (position < 0) return item;
      used.add(position);
      const entry = media[position];
      const videoUrls = entry.videoUrls.filter((url) => /^https?:/i.test(url));
      if (!videoUrls.length) return item;
      const poster = entry.poster || "";
      const url = (!item.url || item.url === "x-video-pending" || RednoteParser.isPlaceholderImageUrl(item.url)) && poster
        ? poster
        : item.url;
      const previewUrl = item.previewUrl || poster || url;
      return { ...item, url, previewUrl, videoUrl: videoUrls[0], videoUrls };
    });
  }

  function syndicationImageItems(media) {
    return media.flatMap((entry, index) => {
      if (!entry || typeof entry !== "object") return [];
      const rawUrl = entry.url || entry.poster || "";
      const url = RednoteParser.tweetImageUrl(rawUrl, location.href, "orig") || validHttpUrl(rawUrl);
      if (!url) return [];
      const rawPreview = entry.poster || entry.url || url;
      const previewUrl = RednoteParser.tweetImageUrl(rawPreview, location.href, "small") || url;
      const videoUrls = (Array.isArray(entry.videoUrls) ? entry.videoUrls : [])
        .filter((value) => /^https?:/i.test(value || ""));
      const type = String(entry.type || "");
      const kind = type === "animated_gif" ? "gif"
        : type === "video" || videoUrls.length ? "video"
          : /\.gif(?:$|[?#])/i.test(url) ? "gif" : "image";
      return [{
        index: index + 1,
        url,
        previewUrl,
        width: Number(entry.width) || 0,
        height: Number(entry.height) || 0,
        kind,
        videoUrl: videoUrls[0] || "",
        videoUrls
      }];
    });
  }

  function collectTweetNote() {
    const noteId = RednoteParser.xContentIdFromUrl(location.href);
    const statusId = RednoteParser.statusIdFromUrl(location.href);
    if (!noteId) return null;
    const title = RednoteParser.articleIdFromUrl(location.href) ? getArticleTitle() : getTweetTitle();
    const structured = RednoteParser.fromPage(globalThis, document, location.href, title);
    if (structured) return structured;
    const images = tweetMediaFromDom();
    const note = { noteId, title, url: location.href, images };
    if (statusId && !images.length) {
      return resolveXVideoMedia(statusId).then((media) => {
        const fallback = syndicationImageItems(media);
        return fallback.length ? { ...note, images: fallback } : null;
      });
    }
    if (!images.length) return null;
    return statusId && images.some(needsXVideoLookup)
      ? enrichTweetVideos(statusId, images).then((enriched) => ({ ...note, images: enriched }))
      : note;
  }

  function getArticleTitle() {
    const title = document.querySelector('[data-article-part="title"]')?.textContent?.trim();
    if (title) return title.replace(/\s+/g, " ").slice(0, 80);
    return document.title.replace(/\s*\|\s*X$/, "").replace(/\s+/g, " ").trim().slice(0, 80) || "X 文章";
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
    if (SITE === "x") {
      const fallback = { title: getTweetTitle(), url: location.href, images: [] };
      let note = null;
      try {
        note = collectTweetNote();
      } catch {
        // A page without readable state still gets an empty, well-formed answer.
      }
      if (note && typeof note.then === "function") {
        note.then((value) => sendResponse(value || fallback), () => sendResponse(fallback));
        return true;
      }
      sendResponse(note || fallback);
      return;
    }
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
