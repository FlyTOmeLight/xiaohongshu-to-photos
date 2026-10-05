"""Check the real popup DOM at constrained viewport heights using installed Chrome."""
import argparse
import base64
import json
import os
import re
import signal
import subprocess
import tempfile
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--chrome', default='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    photo = 'data:image/svg+xml;base64,' + base64.b64encode(
        b'<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><rect width="120" height="120" fill="#cdd9d2"/></svg>'
    ).decode()
    note = {'title': 'Popup layout regression', 'url': 'https://www.xiaohongshu.com/explore/layout123',
            'images': [{'index': i + 1, 'url': photo, 'kind': 'image'} for i in range(30)]}
    states = {
        'ready': None,
        'progress': {'busy': True, 'progress': {'phase': 'download', 'completed': 1, 'total': 30}},
        'saved': {'busy': False, 'result': {'ok': True, 'saved': 1, 'failedIndices': [],
                                          'items': [{'index': 1, 'quality': 'page', 'kind': 'image'}]}},
        'partial': {'busy': False, 'result': {'ok': True, 'saved': 1, 'failed': 1, 'failedIndices': [2],
                                            'items': [{'index': 1}]}},
        'stopped': {'busy': False, 'result': {'ok': True, 'saved': 1, 'cancelled': True,
                                            'failedIndices': [2], 'items': [{'index': 1}]}},
        'error': {'busy': False, 'result': {'ok': False, 'error': '保存失败，请检查连接器。' * 100}},
    }
    mock = """<script>(()=>{const f=FIXTURE;window.chrome={storage:{
      session:{get:async()=>f.session,set:async()=>{}},local:{get:async()=>({}),set:async()=>{}},
      onChanged:{addListener:()=>{}}},runtime:{sendMessage:async m=>{
        if(m.type==='CONNECTOR_REQUEST')throw Error('Unexpected save');return {ok:true};}},
      tabs:{query:async()=>[{id:1,url:f.note.url}],get:async()=>({id:1,url:f.note.url}),
        sendMessage:async()=>f.note},scripting:{executeScript:async()=>[{result:f.note}]}};})();</script>"""
    with tempfile.TemporaryDirectory(prefix='rednote-popup-layout-') as directory:
        work = Path(directory)
        frames = []
        for name, state in states.items():
            session = {}
            if state:
                session['connectorJob'] = {**state, 'payload': {'action': 'save', 'destination': 'photos', 'pageUrl': note['url']}}
            html = (root / 'popup.html').read_text().replace(
                '<link rel="stylesheet" href="popup.css" />', '<style>' + (root / 'popup.css').read_text() + '</style>')
            html = html.replace('<script src="popup.js"></script>',
                                mock.replace('FIXTURE', json.dumps({'note': note, 'session': session}))
                                + '<script>' + (root / 'popup.js').read_text() + '</script>')
            (work / f'{name}.html').write_text(html)
            for height in (360, 480, 600):
                frames.append(f'<iframe title="{name}-{height}" style="width:420px;height:{height}px;border:0" src="{name}.html"></iframe>')
        board = '<!doctype html><meta charset="utf-8">' + ''.join(frames) + """<pre id="verdict">waiting</pre>
          <script>window.addEventListener('load',()=>setTimeout(()=>{
            const results=[...document.querySelectorAll('iframe')].map(frame=>{
              const w=frame.contentWindow,d=frame.contentDocument,footer=d.querySelector('#actionBar');
              const button=d.querySelector(frame.title.startsWith('progress')?'#stopButton':'#saveButton');
              const r=footer.getBoundingClientRect(),b=button.getBoundingClientRect();
              return {state:frame.title,height:w.innerHeight,bottom:r.bottom,
                pass:r.bottom<=w.innerHeight+1&&d.scrollingElement.scrollHeight<=w.innerHeight+1
                  &&b.height>0&&b.bottom<=w.innerHeight+1&&w.getComputedStyle(button).display!=='none'};
            });document.querySelector('#verdict').textContent=JSON.stringify(results);
          },100));</script>"""
        (work / 'board.html').write_text(board)
        with (work / 'chrome.log').open('w') as log:
            process = subprocess.Popen([args.chrome, '--headless', '--disable-gpu', '--no-first-run',
                '--no-default-browser-check', '--allow-file-access-from-files', f'--user-data-dir={work}/profile',
                '--window-size=600,700', '--virtual-time-budget=2000', '--dump-dom', (work / 'board.html').as_uri()],
                stdout=log, stderr=log, start_new_session=True)
            try:
                process.wait(timeout=20)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGTERM)
                process.wait(timeout=5)
        output = (work / 'chrome.log').read_text()
        match = re.search(r'<pre id="verdict">(.*?)</pre>', output)
        if not match or match[1] == 'waiting':
            raise RuntimeError('Chrome did not finish popup layout checks')
        results = json.loads(match[1])
        failures = [result for result in results if not result['pass']]
        if failures:
            raise AssertionError(json.dumps(failures, ensure_ascii=False))
        print(f'Chrome popup layout: {len(results)} states/heights passed (360, 480, 600px).')


if __name__ == '__main__':
    main()
