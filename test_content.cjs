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

test('the page-world parser handles cycles and preserves original image indices', () => {
  const context = vm.createContext({ URL });
  vm.runInContext(fs.readFileSync('note-parser.js', 'utf8'), context);
  const state = { noteId: 'current123', imageList: [null, image('current')] };
  state.self = state;
  const result = context.RednoteParser.fromState(state, 'https://www.xiaohongshu.com/explore/current123', 'Note');
  assert.equal(result.images[0].index, 2);
  assert.equal(context.RednoteParser.fromState(state, 'https://www.xiaohongshu.com/explore/other123', 'Note'), null);
});
