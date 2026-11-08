const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

const image = (name) => ({ urlDefault: `https://ci.xiaohongshu.com/${name}` });
function collect({ path = '/explore/current123', state, root = null, images = [], history = [] }) {
  let listener;
  const document = {
    title: 'Test note', images,
    scripts: state === undefined ? [] : [{ textContent: `window.__INITIAL_STATE__=${state};` }],
    querySelector: (selector) => selector.includes('note-detail-mask') ? root : null,
    querySelectorAll: (selector) => selector === 'img' ? images : [],
  };
  const context = vm.createContext({
    document, location: { pathname: path, href: `https://www.xiaohongshu.com${path}` },
    URL, Node: { DOCUMENT_POSITION_FOLLOWING: 4 }, devicePixelRatio: 1,
    performance: { getEntriesByType: () => history },
    chrome: { runtime: { onMessage: { addListener: (handler) => { listener = handler; } } } },
  });
  const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
  for (const script of manifest.content_scripts[0].js) {
    vm.runInContext(fs.readFileSync(script, 'utf8'), context);
  }
  let result;
  listener({ type: 'COLLECT_NOTE_IMAGES' }, {}, (value) => { result = value; });
  return JSON.parse(JSON.stringify(result));
}
function tweetState(media, id = '20') {
  return { props: { pageProps: { tweet: { rest_id: id, legacy: { id_str: id, full_text: 'hello world', extended_entities: { media } } } } } };
}
function collectTweet({ path = '/jack/status/20', scripts = [], article = null, modal = null, metas = {}, sendMessage = null }) {
  let listener;
  const document = {
    title: 'jack on X',
    images: [],
    scripts,
    querySelector: (selector) => {
      if (selector.includes('aria-modal') || selector.includes('swipe-to-dismiss') || selector === '#layers') return modal;
      if (selector.includes('article[data-testid=')) return article;
      const meta = selector.match(/^meta\[(?:property|name)="([^"]+)"\]$/);
      return meta && metas[meta[1]] ? { content: metas[meta[1]] } : null;
    },
    querySelectorAll: () => [],
  };
  const runtime = { onMessage: { addListener: (handler) => { listener = handler; } } };
  if (sendMessage) runtime.sendMessage = sendMessage;
  const context = vm.createContext({
    document, location: { pathname: path, href: `https://x.com${path}` },
    URL, Node: { DOCUMENT_POSITION_FOLLOWING: 4 }, devicePixelRatio: 1,
    performance: { getEntriesByType: () => [] },
    chrome: { runtime },
  });
  const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
  for (const script of manifest.content_scripts[0].js) {
    vm.runInContext(fs.readFileSync(script, 'utf8'), context);
  }
  return new Promise((resolve) => {
    listener({ type: 'COLLECT_NOTE_IMAGES' }, {}, (value) => {
      resolve(JSON.parse(JSON.stringify(value)));
    });
  });
}
function domImage() {
  return { src: 'https://ci.xiaohongshu.com/current-image', naturalWidth: 800, naturalHeight: 1000,
    getBoundingClientRect: () => ({ width: 800, height: 1000 }),
    alt: '', className: 'note-image', closest: () => null,
  };
}

test('only the current note is collected and malformed image fields are skipped', () => {
  const result = collect({ state: JSON.stringify({ notes: [
    { noteId: 'other123', imageList: [image('other')] },
    { noteId: 'current123', imageList: [null, { ...image('current'), infoList: {}, stream: { h264: [{}] } }] },
  ] }) });
  assert.equal(result.images.length, 1);
  assert.match(result.images[0].url, /current$/);
});

test('undefined values are normalized without changing quoted text', () => {
  const result = collect({ state: '{"noteId":"current123","title":"undefined 的笔记","missing":undefined,"imageList":[{"urlDefault":"https://ci.xiaohongshu.com/undefined"}]}' });
  assert.equal(result.title, 'undefined 的笔记');
  assert.match(result.images[0].url, /undefined$/);
});

test('a recommendation feed is not treated as an open note', () => {
  const result = collect({ path: '/explore', state: JSON.stringify({ noteId: 'other123', imageList: [image('other')] }) });
  assert.equal(result.images.length, 0);
});

test('missing detail root never falls back to recommendation images', () => {
  const result = collect({ images: [domImage()] });
  assert.equal(result.images.length, 0);
});

test('historical network video is never paired to the current cover', () => {
  const img = domImage();
  const root = { querySelector: () => null,
    querySelectorAll: (selector) => selector === 'img' ? [img] : [] };
  const result = collect({ root, images: [img], history: [{ initiatorType: 'video', name: 'https://sns-video-bd.xhscdn.com/previous.mp4' }] });
  assert.equal(result.images.length, 1);
  assert.equal(result.images[0].kind, 'image');
  assert.deepEqual(result.images[0].videoUrls, []);
});

const xMedia = [
  { type: 'photo', media_url_https: 'https://pbs.twimg.com/media/aaa?format=jpg&name=small',
    original_info: { width: 1200, height: 800 } },
  { type: 'animated_gif', media_url_https: 'https://pbs.twimg.com/tweet_video_thumb/bbb?format=jpg',
    video_info: { variants: [
      { content_type: 'video/mp4', bitrate: 256000, url: 'https://video.twimg.com/tweet_video/bbb-low.mp4' },
      { content_type: 'video/mp4', bitrate: 832000, url: 'https://video.twimg.com/tweet_video/bbb.mp4' },
    ] } },
  { type: 'video', media_url_https: 'https://pbs.twimg.com/amplify_video_thumb/ccc?format=jpg',
    video_info: { variants: [
      { content_type: 'application/x-mpegURL', url: 'https://video.twimg.com/amplify_video/ccc/pl/playlist.m3u8' },
      { content_type: 'video/mp4', bitrate: 2176000, url: 'https://video.twimg.com/amplify_video/ccc/vid/1280x720/hi.mp4' },
    ] } },
];

test('an X status page keeps photos, GIFs and videos with their MP4 sources', async () => {
  const result = await collectTweet({ scripts: [{ textContent: `window.__NEXT_DATA__=${JSON.stringify(tweetState(xMedia))};` }] });
  assert.equal(result.title, 'hello world');
  assert.deepEqual(result.images.map((item) => item.kind), ['image', 'gif', 'video']);
  assert.equal(result.images[0].url, 'https://pbs.twimg.com/media/aaa?format=jpg&name=orig');
  assert.equal(result.images[1].videoUrl, 'https://video.twimg.com/tweet_video/bbb.mp4');
  assert.equal(result.images[1].kind, 'gif');
  assert.equal(result.images[2].videoUrl, 'https://video.twimg.com/amplify_video/ccc/vid/1280x720/hi.mp4');
  assert.deepEqual(result.images[2].videoUrls, ['https://video.twimg.com/amplify_video/ccc/vid/1280x720/hi.mp4']);
});

test('an X status page ignores other posts in the same state', async () => {
  const other = tweetState(xMedia, '99').props.pageProps.tweet;
  other.legacy.extended_entities.media = [{ type: 'photo', media_url_https: 'https://pbs.twimg.com/media/other?format=jpg' }];
  const current = tweetState([{ type: 'photo', media_url_https: 'https://pbs.twimg.com/media/mine?format=jpg' }]).props.pageProps.tweet;
  const state = { props: { pageProps: { timeline: [other, current] } } };
  const result = await collectTweet({ scripts: [{ textContent: JSON.stringify(state) }] });
  assert.equal(result.images.length, 1);
  assert.match(result.images[0].url, /mine\?format=jpg&name=orig$/);
});

test('WebP media requested at original size uses the JPEG original', async () => {
  const result = await collectTweet({ scripts: [{ textContent: JSON.stringify(tweetState([
    { type: 'photo', media_url_https: 'https://pbs.twimg.com/media/webp?format=webp&name=large' },
  ])) }] });
  assert.equal(result.images[0].url, 'https://pbs.twimg.com/media/webp?format=jpg&name=orig');
  assert.equal(result.images[0].previewUrl, 'https://pbs.twimg.com/media/webp?format=webp&name=small');
});

test('X GraphQL tweet state accepts the newer media_entities2 field', async () => {
  const tweet = { rest_id: '2112136552533156168', legacy: { full_text: 'new media field' },
    media_entities2: [{ type: 'photo', media_url_https: 'https://pbs.twimg.com/media/new-field.jpg',
      original_info: { width: 1179, height: 744 } }] };
  const result = await collectTweet({ path: '/Psych_Nyx/status/2112136552533156168/photo/1',
    scripts: [{ textContent: JSON.stringify({ tweet }) }] });
  assert.equal(result.images.length, 1);
  assert.equal(result.images[0].url, 'https://pbs.twimg.com/media/new-field.jpg?name=orig');
});

test('an X ArticleEntity yields article media with its title and dimensions', async () => {
  const article = { article_results: { result: {
    title: '一个百万级的 FDE 项目',
    media_entities: [
      { media_id: '2112086330608164864', media_info: {
        original_img_url: 'https://pbs.twimg.com/media/HU-jU87boAAA41l.jpg',
        original_img_width: 2628, original_img_height: 1424
      } },
      { media_id: '2112083382750601216', media_info: {
        original_img_url: 'https://pbs.twimg.com/media/HU-gpXTa4AA5tTf.jpg',
        original_img_width: 2000, original_img_height: 800
      } },
    ]
  } } };
  const state = { tweet_result_by_rest_id: { rest_id: '2112113095103639742', article } };
  const result = await collectTweet({ path: '/miles_mazy/article/2112113095103639742/media/2112086330608164864',
    scripts: [{ textContent: JSON.stringify(state) }] });
  assert.equal(result.title, '一个百万级的 FDE 项目');
  assert.equal(result.images.length, 2);
  assert.equal(result.images[0].url, 'https://pbs.twimg.com/media/HU-jU87boAAA41l.jpg?name=orig');
  assert.deepEqual([result.images[0].width, result.images[0].height], [2628, 1424]);
});

test('an article without a matching ID does not guess among multiple articles', async () => {
  const article = (title, url) => ({ article_results: { result: {
    title, media_entities: [{ media_info: { original_img_url: url } }]
  } } });
  const state = { first: article('first', 'https://pbs.twimg.com/media/first.jpg'),
    second: article('second', 'https://pbs.twimg.com/media/second.jpg') };
  const result = await collectTweet({ path: '/miles_mazy/article/2112113095103639742/media/1',
    scripts: [{ textContent: JSON.stringify(state) }] });
  assert.equal(result.images.length, 0);
});

test('X streamed GraphQL values expose ArticleEntity media', async () => {
  const value = JSON.stringify({ data: { tweet_result_by_rest_id: {
    result: { article: { article_results: { result: {
      title: 'Streamed article', media_entities: [{ media_info: {
        original_img_url: 'https://pbs.twimg.com/media/streamed.jpg',
        original_img_width: 640, original_img_height: 360
      } }] }
    } } }
  } } });
  const escaped = JSON.stringify(value).slice(1, -1);
  const result = await collectTweet({ path: '/miles_mazy/article/2112113095103639742/media/1',
    scripts: [{ textContent: `result:{value:"${escaped}"}` }] });
  assert.equal(result.title, 'Streamed article');
  assert.equal(result.images[0].url, 'https://pbs.twimg.com/media/streamed.jpg?name=orig');
});

test('an X profile page is not treated as a status or article page', async () => {
  const result = await collectTweet({ path: '/jack', scripts: [{ textContent: JSON.stringify(tweetState(xMedia)) }] });
  assert.equal(result.images.length, 0);
});

test('X pages without embedded state fall back to the visible tweet media', async () => {
  const video = { poster: 'https://pbs.twimg.com/tweet_video_thumb/ddd?format=jpg', currentSrc: '', src: '',
    querySelectorAll: (selector) => selector === 'source' ? [{ src: 'https://video.twimg.com/tweet_video/ddd.mp4' }] : [] };
  const article = { querySelectorAll: (selector) => {
    if (selector.includes('pbs.twimg.com/media/')) {
      return [{ src: 'https://pbs.twimg.com/media/eee?format=jpg&name=small', currentSrc: '', naturalWidth: 1200, naturalHeight: 900 }];
    }
    return selector === 'video' ? [video] : [];
  } };
  const result = await collectTweet({ article });
  assert.deepEqual(result.images.map((item) => item.kind), ['image', 'gif']);
  assert.equal(result.images[0].url, 'https://pbs.twimg.com/media/eee?format=jpg&name=orig');
  assert.equal(result.images[1].videoUrl, 'https://video.twimg.com/tweet_video/ddd.mp4');
});

test('X full-screen photo modal is collected before the sidebar tweet', async () => {
  const modalImage = { src: 'https://pbs.twimg.com/media/modal-image?format=jpg&name=large',
    currentSrc: '', naturalWidth: 2048, naturalHeight: 1365 };
  const sidebarImage = { src: 'https://pbs.twimg.com/media/sidebar-image?format=jpg&name=small',
    currentSrc: '', naturalWidth: 400, naturalHeight: 300 };
  const modal = {
    querySelector: () => modalImage,
    querySelectorAll: (selector) => selector.includes('pbs.twimg.com/media/') ? [modalImage] : [],
  };
  const article = {
    querySelectorAll: (selector) => selector.includes('pbs.twimg.com/media/') ? [sidebarImage] : [],
  };
  const result = await collectTweet({
    path: '/Viola3s/status/2119381338956734824/photo/1', modal, article,
    metas: { 'og:image': 'https://abs.twimg.com/rweb/ssr/default/v2/og/image.png' },
  });
  assert.equal(result.images.length, 1);
  assert.equal(result.images[0].url, 'https://pbs.twimg.com/media/modal-image?format=jpg&name=orig');
});

test('X photo pages use syndicated images when the DOM has only a placeholder', async () => {
  const result = await collectTweet({
    path: '/Viola3s/status/2119381338956734824/photo/1',
    metas: { 'og:image': 'https://abs.twimg.com/rweb/ssr/default/v2/og/image.png' },
    sendMessage: (message, callback) => {
      assert.equal(message.type, 'RESOLVE_X_MEDIA');
      assert.equal(message.statusId, '2119381338956734824');
      callback({ ok: true, media: [{
        url: 'https://pbs.twimg.com/media/real-photo?format=jpg&name=small',
        poster: 'https://pbs.twimg.com/media/real-photo?format=jpg&name=small',
        type: 'photo', width: 1200, height: 800, videoUrls: [],
      }] });
    },
  });
  assert.equal(result.images.length, 1);
  assert.equal(result.images[0].url, 'https://pbs.twimg.com/media/real-photo?format=jpg&name=orig');
  assert.equal(result.images[0].kind, 'image');
});

test('X blob videos use the public syndication MP4s', async () => {
  const poster = 'https://pbs.twimg.com/amplify_video_thumb/2119380594979487744/img/G4rmMA0WpNBOzFuU.jpg';
  const video = { poster, currentSrc: 'blob:https://x.com/abc', src: 'blob:https://x.com/abc',
    querySelectorAll: () => [] };
  const article = { querySelectorAll: (selector) => selector === 'video' ? [video] : [] };
  const result = await collectTweet({
    path: '/mintchocccs/status/2119380630018613658', article,
    sendMessage: (message, callback) => {
      assert.equal(message.type, 'RESOLVE_X_MEDIA');
      assert.equal(message.statusId, '2119380630018613658');
      callback({ ok: true, media: [{
        poster: 'https://pbs.twimg.com/amplify_video_thumb/2119380594979487744/img/other.jpg',
        videoUrls: [
          'https://video.twimg.com/amplify_video/2119380594979487744/vid/avc1/1024x576/hi.mp4',
          'https://video.twimg.com/amplify_video/2119380594979487744/vid/avc1/640x360/lo.mp4',
        ],
      }] });
    },
  });
  assert.equal(result.images.length, 1);
  assert.equal(result.images[0].kind, 'video');
  assert.equal(result.images[0].url, poster);
  assert.equal(result.images[0].videoUrl,
    'https://video.twimg.com/amplify_video/2119380594979487744/vid/avc1/1024x576/hi.mp4');
  assert.equal(result.images[0].videoUrls.length, 2);
});

test('an X page with only metadata still yields the video source', async () => {
  const result = await collectTweet({ metas: {
    'og:image': 'https://pbs.twimg.com/amplify_video_thumb/fff?format=jpg',
    'og:video': 'https://video.twimg.com/amplify_video/fff/vid/1280x720/hi.mp4',
  } });
  assert.equal(result.images.length, 1);
  assert.equal(result.images[0].kind, 'video');
  assert.equal(result.images[0].videoUrl, 'https://video.twimg.com/amplify_video/fff/vid/1280x720/hi.mp4');
  // Video thumbnails are path-based, so only /media/ URLs gain the size parameter.
  assert.equal(result.images[0].url, 'https://pbs.twimg.com/amplify_video_thumb/fff?format=jpg');
});

test('X placeholder and default promotional og:images are ignored', async () => {
  const result = await collectTweet({ metas: {
    'og:image': 'https://abs.twimg.com/rweb/ssr/default/v2/og/image.png',
  } });
  assert.equal(result.images.length, 0);
});

test('an X video without native poster recovers the syndication poster and ignores placeholder og:image', async () => {
  const video = { poster: '', currentSrc: 'blob:https://x.com/blob1', src: 'blob:https://x.com/blob1',
    querySelectorAll: () => [] };
  const article = { querySelectorAll: (selector) => selector === 'video' ? [video] : [] };
  const result = await collectTweet({
    path: '/mintchocccs/status/2119380630018613658', article,
    metas: { 'og:image': 'https://abs.twimg.com/rweb/ssr/default/v2/og/image.png' },
    sendMessage: (message, callback) => {
      callback({ ok: true, media: [{
        poster: 'https://pbs.twimg.com/amplify_video_thumb/2119380594979487744/img/real.jpg',
        videoUrls: ['https://video.twimg.com/amplify_video/2119380594979487744/vid/avc1/1024x576/hi.mp4'],
      }] });
    },
  });
  assert.equal(result.images.length, 1);
  assert.equal(result.images[0].kind, 'video');
  assert.equal(result.images[0].url, 'https://pbs.twimg.com/amplify_video_thumb/2119380594979487744/img/real.jpg');
  assert.equal(result.images[0].videoUrl, 'https://video.twimg.com/amplify_video/2119380594979487744/vid/avc1/1024x576/hi.mp4');
});

test('the page-world parser handles cycles and preserves original image indices', () => {
  const context = vm.createContext({ URL });
  vm.runInContext(fs.readFileSync('note-parser.js', 'utf8'), context);
  const state = { noteId: 'current123', imageList: [null, image('current')] };
  state.self = state;
  const result = context.RednoteParser.fromState(state, 'https://www.xiaohongshu.com/explore/current123', 'Note');
  assert.equal(result.images[0].index, 2);
  assert.equal(context.RednoteParser.fromState(state, 'https://www.xiaohongshu.com/explore/other123', 'Note'), null);
});
