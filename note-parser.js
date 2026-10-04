// Shared by the isolated content script and the injected page-world reader.
globalThis.RednoteParser = (() => {
  function noteIdFromUrl(url) {
    return new URL(url).pathname.match(/\/(?:explore|discovery\/item)\/([0-9a-z]+)/i)?.[1] || "";
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
  return { noteIdFromUrl, parseState, fromState };
})();
