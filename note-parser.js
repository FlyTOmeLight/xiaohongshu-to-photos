// Shared by the isolated content script and the injected page-world reader.
globalThis.RednoteParser = (() => {
  const XHS_HOST = /(?:^|\.)xiaohongshu\.com$/i;
  const X_HOST = /(?:^|\.)(?:x|twitter)\.com$/i;
  const TWIMG_IMAGE_HOST = /(?:^|\.)pbs\.twimg\.com$/i;

  function siteFromUrl(url) {
    try {
      const host = new URL(url).hostname;
      if (XHS_HOST.test(host)) return "xhs";
      if (X_HOST.test(host)) return "x";
    } catch {
      // A URL that cannot be parsed belongs to no supported site.
    }
    return "";
  }

  function noteIdFromUrl(url) {
    return new URL(url).pathname.match(/\/(?:explore|discovery\/item)\/([0-9a-z]+)/i)?.[1] || "";
  }

  function statusIdFromUrl(url) {
    try {
      const parsed = new URL(url);
      if (!X_HOST.test(parsed.hostname)) return "";
      return parsed.pathname.match(/\/status(?:es)?\/(\d+)/i)?.[1] || "";
    } catch {
      return "";
    }
  }

  function articleIdFromUrl(url) {
    try {
      const parsed = new URL(url);
      if (!X_HOST.test(parsed.hostname)) return "";
      return parsed.pathname.match(/\/article\/(\d+)(?:\/|$)/i)?.[1] || "";
    } catch {
      return "";
    }
  }

  function xContentIdFromUrl(url) {
    return statusIdFromUrl(url) || articleIdFromUrl(url);
  }

  function articleMediaIdFromUrl(url) {
    try {
      const parsed = new URL(url);
      if (!X_HOST.test(parsed.hostname)) return "";
      return parsed.pathname.match(/\/article\/\d+\/media\/(\d+)(?:\/|$)/i)?.[1] || "";
    } catch {
      return "";
    }
  }

  function isArticleUrl(url) {
    return Boolean(articleIdFromUrl(url));
  }

  function parseState(text) {
    return JSON.parse(text.trim().replace(/;$/, "").replace(/"(?:\\.|[^"\\])*"|\bundefined\b/g,
      (token) => token === "undefined" ? "null" : token));
  }

  function httpUrl(value, pageUrl) {
    if (typeof value !== "string" || !value.trim()) return "";
    try {
      const url = new URL(value, pageUrl);
      return /^https?:$/.test(url.protocol) ? url.href : "";
    } catch {
      return "";
    }
  }

  // --- X (twitter.com / x.com) ----------------------------------------------

  function scriptStates(text) {
    const body = String(text || "").trim();
    if (!body) return [];
    const states = [];
    const marker = body.match(/^(?:window\.)?__(?:NEXT_DATA|INITIAL_STATE)__\s*=\s*/);
    const payload = marker ? body.slice(marker[0].length) : body;
    if (/[{\[]/.test(payload)) {
      try { states.push(parseState(payload)); } catch { /* Try streamed state below. */ }
    }
    const streamed = /value:\"((?:\\.|[^\"\\])*)\"/g;
    for (let match; (match = streamed.exec(body)); ) {
      try {
        const decoded = JSON.parse(`\"${match[1]}\"`);
        if (/\"media_entities\"/.test(decoded)) states.push(parseState(decoded));
      } catch {
        // A streamed value may be a non-JSON payload.
      }
    }
    return states;
  }

  function isPlaceholderImageUrl(value) {
    if (!value) return false;
    try {
      const parsed = new URL(value);
      if (/(?:^|\.)abs\.twimg\.com$/i.test(parsed.hostname)) return true;
      if (/\/default\/.*\/og\/image/i.test(parsed.pathname)) return true;
    } catch {
      return false;
    }
    return false;
  }

  // X serves the same photo through ?name=small/medium/large/orig. WebP has no
  // original, so ask for the JPEG original instead of a 404; other hosts
  // (video thumbnails, avatars) are returned untouched.
  function tweetImageUrl(value, pageUrl, size = "orig") {
    const safe = httpUrl(value, pageUrl);
    if (!safe || isPlaceholderImageUrl(safe)) return "";
    try {
      const parsed = new URL(safe);
      if (TWIMG_IMAGE_HOST.test(parsed.hostname) && /^\/media\//.test(parsed.pathname)) {
        if (size === "orig" && parsed.searchParams.get("format") === "webp") {
          parsed.searchParams.set("format", "jpg");
        }
        parsed.searchParams.set("name", size);
        return parsed.href;
      }
    } catch {
      // Keep the URL as supplied when it cannot be rewritten.
    }
    return safe;
  }

  function mp4Variants(videoInfo, pageUrl) {
    const variants = videoInfo?.variants;
    if (!Array.isArray(variants)) return [];
    return variants
      .filter((variant) => variant && typeof variant === "object" && /video\/mp4/i.test(String(variant.content_type || "")))
      .map((variant) => ({ url: httpUrl(variant.url, pageUrl), bitrate: Number(variant.bitrate) || 0 }))
      .filter((variant) => variant.url)
      .sort((a, b) => b.bitrate - a.bitrate);
  }

  function mediaEntityItem(entity, pageUrl, index) {
    const poster = tweetImageUrl(entity.media_url_https || entity.media_url, pageUrl, "orig");
    const preview = tweetImageUrl(entity.media_url_https || entity.media_url, pageUrl, "small");
    const type = String(entity.type || "");
    const videoUrls = mp4Variants(entity.video_info, pageUrl).map((variant) => variant.url);
    const width = Number(entity.original_info?.width || entity.sizes?.large?.w) || 800;
    const height = Number(entity.original_info?.height || entity.sizes?.large?.h) || 1000;
    if (type !== "video" && type !== "animated_gif" && !videoUrls.length) {
      if (!poster) return null;
      return { index, url: poster, previewUrl: preview || poster, width, height,
        kind: /\.gif(?:$|[?#])/i.test(poster) ? "gif" : "image", videoUrl: "", videoUrls: [] };
    }
    if (!poster && !videoUrls.length) return null;
    return { index, url: poster || videoUrls[0], previewUrl: preview || poster,
      width, height, kind: type === "animated_gif" ? "gif" : "video",
      videoUrl: videoUrls[0] || "", videoUrls };
  }

  function tweetMediaList(tweet) {
    const entities = tweet.extended_entities || tweet.extendedEntities || tweet.entities;
    const media = Array.isArray(entities?.media) ? entities.media
      : entities?.media_entities2 || tweet.media_entities2;
    return Array.isArray(media) ? media.filter((item) => item && typeof item === "object") : [];
  }

  function collectTweets(state) {
    const seen = new WeakSet();
    const queue = [state];
    const tweets = [];
    for (let cursor = 0; cursor < queue.length && cursor < 50000; cursor += 1) {
      const value = queue[cursor];
      if (!value || typeof value !== "object" || seen.has(value)) continue;
      seen.add(value);
      if (Array.isArray(value)) {
        for (const child of value) if (child && typeof child === "object") queue.push(child);
        continue;
      }
      const legacy = value.legacy && typeof value.legacy === "object" ? value.legacy : null;
      const media = legacy && tweetMediaList(legacy).length ? tweetMediaList(legacy) : tweetMediaList(value);
      const source = legacy && media.length ? legacy : value;
      if (media.length) tweets.push({
        id: String(source.id_str || value.rest_id || source.id || ""),
        text: String(source.full_text || source.text || ""),
        media
      });
      for (const child of Object.values(value)) if (child && typeof child === "object") queue.push(child);
    }
    return tweets;
  }

  function tweetTitle(text, fallback) {
    const fromTweet = String(text || "").replace(/\s+/g, " ").trim().slice(0, 80);
    if (fromTweet) return fromTweet;
    const fromPage = String(fallback || "").replace(/^.*?\bon X:\s*["“]?/, "").replace(/["”]$/, "")
      .replace(/\s*\/\s*X$/, "").replace(/\s+/g, " ").trim().slice(0, 80);
    return fromPage || "X 帖子";
  }

  function articleMediaItem(entity, pageUrl, index) {
    const info = entity?.media_info || entity?.mediaInfo || {};
    const url = tweetImageUrl(info.original_img_url || info.originalImgUrl, pageUrl, "orig");
    if (!url) return null;
    const previewUrl = tweetImageUrl(info.original_img_url || info.originalImgUrl, pageUrl, "small") || url;
    return { index, url, previewUrl,
      width: Number(info.original_img_width || info.originalImgWidth) || 800,
      height: Number(info.original_img_height || info.originalImgHeight) || 1000,
      kind: "image", videoUrl: "", videoUrls: [] };
  }

  function fromArticleState(state, pageUrl, title) {
    const wantedId = articleIdFromUrl(pageUrl);
    if (!wantedId || !state || typeof state !== "object") return null;
    const seen = new WeakSet();
    const queue = [{ value: state, id: "" }];
    const articles = [];
    for (let cursor = 0; cursor < queue.length && cursor < 50000; cursor += 1) {
      const entry = queue[cursor];
      const value = entry.value;
      if (!value || typeof value !== "object" || seen.has(value)) continue;
      seen.add(value);
      const currentId = String(value.rest_id || value.rest_id_str || entry.id || "");
      const result = value.article_results?.result || value.articleResults?.result;
      const media = result?.media_entities || result?.mediaEntities;
      if (result && Array.isArray(media)) {
        const images = media.flatMap((entity, index) => {
          const item = articleMediaItem(entity, pageUrl, index + 1);
          return item ? [item] : [];
        });
        if (images.length) articles.push({ id: currentId, title: String(result.title || "").trim(), images });
      }
      for (const child of Object.values(value)) {
        if (child && typeof child === "object") queue.push({ value: child, id: currentId });
      }
    }
    const wanted = articles.filter((article) => article.id === wantedId);
    const pool = wanted.length ? wanted : articles.length === 1 && !articles[0].id ? articles : [];
    const chosen = pool[0];
    if (!chosen) return null;
    return { noteId: wantedId, title: chosen.title || title || "X 文章", url: pageUrl, images: chosen.images };
  }

  function fromTweetState(state, pageUrl, title) {
    const wantedId = statusIdFromUrl(pageUrl);
    if (!wantedId || !state || typeof state !== "object") return null;
    const tweets = collectTweets(state);
    const wanted = tweets.filter((tweet) => tweet.id === wantedId);
    // Only fall back to an unidentified tweet when the state carries no ids at
    // all; otherwise a recommendation feed could be mistaken for the post.
    const pool = wanted.length ? wanted : tweets.every((tweet) => !tweet.id) ? tweets : [];
    const chosen = pool.sort((a, b) => b.media.length - a.media.length)[0];
    if (!chosen) return null;
    const images = chosen.media.flatMap((entity, index) => {
      const item = mediaEntityItem(entity, pageUrl, index + 1);
      return item ? [item] : [];
    });
    if (!images.length) return null;
    return { noteId: wantedId, title: tweetTitle(chosen.text, title), url: pageUrl, images };
  }

  function fromPage(win, doc, pageUrl, title) {
    if (siteFromUrl(pageUrl) === "x") {
      if (isArticleUrl(pageUrl)) {
        const fromWindow = fromArticleState(win?.__INITIAL_STATE__, pageUrl, title);
        if (fromWindow) return fromWindow;
        for (const script of doc?.scripts || []) {
          for (const state of scriptStates(script.textContent)) {
            const note = fromArticleState(state, pageUrl, title);
            if (note) return note;
          }
        }
        return null;
      }
      const fromWindow = fromTweetState(win?.__INITIAL_STATE__, pageUrl, title);
      if (fromWindow) return fromWindow;
      for (const script of doc?.scripts || []) {
        for (const state of scriptStates(script.textContent)) {
          const note = fromTweetState(state, pageUrl, title);
          if (note) return note;
        }
      }
      return null;
    }
    return fromState(win?.__INITIAL_STATE__, pageUrl, title);
  }

  function normalize(note, pageUrl, title) {
    const list = note.imageList || note.image_list;
    const images = list.flatMap((item, index) => {
      if (!item || typeof item !== "object") return [];
      const rawInfo = item.infoList || item.info_list;
      const info = Array.isArray(rawInfo) ? rawInfo.filter((value) => value && typeof value === "object") : [];
      const preview = info.find((value) => value.imageScene === "WB_PRV") || info[0] || {};
      const original = info.find((value) => value.imageScene === "WB_DFT") || info.at(-1) || {};
      const url = httpUrl(item.urlDefault || item.url_default || item.urlPre || item.url_pre || original.url, pageUrl);
      if (!url) return [];
      const stream = item.stream || item.streams || {};
      const videos = ["h264", "h265", "h266", "av1"].flatMap((codec) => {
        const variants = stream[codec] || stream[codec.toUpperCase()];
        return Array.isArray(variants) ? variants.flatMap((variant) => {
          if (!variant || typeof variant !== "object") return [];
          const backups = variant.backupUrls || variant.backup_urls;
          return [variant.masterUrl || variant.master_url || variant.url,
            ...(Array.isArray(backups) ? backups : [])];
        }) : [];
      });
      const videoUrls = [...new Set(videos.map((value) => httpUrl(value, pageUrl)).filter(Boolean))];
      const live = Boolean(item.livePhoto || item.live_photo || videoUrls.length);
      return [{ index: index + 1, url, previewUrl: httpUrl(preview.url, pageUrl) || url,
        width: Number(item.width || original.width) || 800,
        height: Number(item.height || original.height) || 1000,
        kind: live ? "live" : /gif/i.test(String(item.imageType || item.image_type || original.format || url)) ? "gif" : "image",
        videoUrl: videoUrls[0] || "", videoUrls }];
    });
    return images.length ? { noteId: String(note.noteId || note.note_id || ""),
      title: String(note.title || note.desc || title || "小红书笔记").trim().slice(0, 80),
      url: pageUrl, images } : null;
  }

  function fromState(state, pageUrl, title) {
    const wantedId = noteIdFromUrl(pageUrl);
    if (!wantedId || !state || typeof state !== "object") return null;
    const seen = new WeakSet();
    const queue = [state];
    const notes = [];
    for (let cursor = 0; cursor < queue.length && cursor < 50000; cursor += 1) {
      const value = queue[cursor];
      if (!value || typeof value !== "object" || seen.has(value)) continue;
      seen.add(value);
      const images = value.imageList || value.image_list;
      if (String(value.noteId || value.note_id || "") === wantedId && Array.isArray(images)) {
        const note = normalize(value, pageUrl, title);
        if (note) notes.push(note);
      }
      for (const child of Object.values(value)) {
        if (child && typeof child === "object") queue.push(child);
      }
    }
    const score = (note) => note.images.reduce((total, image) => total + image.videoUrls.length * 100, note.images.length);
    return notes.sort((a, b) => score(b) - score(a))[0] || null;
  }

  return { siteFromUrl, noteIdFromUrl, statusIdFromUrl, articleIdFromUrl, articleMediaIdFromUrl,
    xContentIdFromUrl, parseState, fromState, fromTweetState, fromArticleState, fromPage,
    scriptStates, tweetImageUrl, isPlaceholderImageUrl };
})();
