"""Verify startup and reopening of an actual Chrome action popup in an isolated profile."""
import argparse
import base64
import http.server
import json
import os
import shutil
import signal
import subprocess
import tempfile
import threading
import time
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--chrome', default='/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    reports = []

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_POST(self):
            reports.append(json.loads(self.rfile.read(int(self.headers['Content-Length']))))
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b'ok')

        def log_message(self, *_):
            pass

    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    endpoint = f'http://127.0.0.1:{server.server_port}/report'
    try:
        with tempfile.TemporaryDirectory(prefix='rednote-toolbar-') as directory:
            work = Path(directory)
            extension = work / 'extension'
            extension.mkdir()
            manifest = json.loads((root / 'manifest.json').read_text())
            manifest['host_permissions'] = ['http://127.0.0.1/*']
            manifest.pop('content_scripts', None)
            manifest['background'] = {'service_worker': 'test-background.js'}
            manifest['name'] = '红薯收藏夹 · 隔离工具栏测试'
            (extension / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False))
            for name in ('popup.css', 'popup.js'):
                shutil.copyfile(root / name, extension / name)
            html = (root / 'popup.html').read_text().replace('<script src="popup.js"></script>',
                '<script src="fixture.js"></script><script src="popup.js"></script><script src="report.js"></script>')
            (extension / 'popup.html').write_text(html)
            photo = 'data:image/svg+xml;base64,' + base64.b64encode(
                b'<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><rect width="120" height="120" fill="#cdd9d2"/></svg>'
            ).decode()
            note = {'title': 'Actual toolbar popup regression', 'url': 'https://www.xiaohongshu.com/explore/layout123',
                    'images': [{'index': i + 1, 'url': photo, 'kind': 'image'} for i in range(6)]}
            (extension / 'fixture.js').write_text('const toolbarNote=' + json.dumps(note) + ''';
              const actualSend=chrome.runtime.sendMessage.bind(chrome.runtime);
              chrome.tabs.query=async()=>[{id:1,url:toolbarNote.url}];
              chrome.tabs.get=async()=>({id:1,url:toolbarNote.url});
              chrome.tabs.sendMessage=async()=>toolbarNote;
              chrome.scripting.executeScript=async()=>[{result:toolbarNote}];
              chrome.runtime.sendMessage=async message=>message.type==='CONNECTOR_STATE'?{ok:true}:actualSend(message);
            ''')
            worker = '''let attempt=0,windowId;
              const post=message=>fetch(ENDPOINT,{method:'POST',body:JSON.stringify(message)});
              chrome.runtime.onMessage.addListener((message,sender,reply)=>{
                if(message.type!=='POPUP_METRICS')return;
                post({...message,attempt}).then(()=>{
                  reply({close:message.stage==='settled'});
                  if(message.stage==='settled'&&attempt===0){attempt++;
                    setTimeout(async()=>{
                      await chrome.storage.session.set({connectorJob:{busy:false,
                        payload:{action:'save',destination:'photos',pageUrl:NOTE_URL},
                        result:{ok:true,saved:1,failedIndices:[],items:[{index:1,quality:'page'}]}}});
                      await chrome.action.openPopup({windowId});
                    },300);
                  }
                });return true;
              });
              chrome.runtime.onInstalled.addListener(()=>setTimeout(async()=>{
                try{const window=await chrome.windows.create({url:'about:blank',focused:true,width:1000,height:850});
                  windowId=window.id;await new Promise(resolve=>setTimeout(resolve,500));
                  await chrome.action.openPopup({windowId});
                }catch(error){await post({error:error.message});}
              },2000));
            '''.replace('ENDPOINT', json.dumps(endpoint)).replace('NOTE_URL', json.dumps(note['url']))
            (extension / 'test-background.js').write_text(worker)
            (extension / 'report.js').write_text('''function report(stage){
              const footer=document.querySelector('#actionBar').getBoundingClientRect();
              chrome.runtime.sendMessage({type:'POPUP_METRICS',stage,width:innerWidth,height:innerHeight,
                footerBottom:footer.bottom,saveHeight:document.querySelector('#saveButton').getBoundingClientRect().height,
                saveLabel:document.querySelector('#saveButtonLabel').textContent}).then(result=>{
                  if(result?.close)window.close();
                });
              }setTimeout(()=>report('settled'),500);
            ''')
            with (work / 'chrome.log').open('w') as log:
                process = subprocess.Popen([args.chrome, f'--user-data-dir={work}/profile', '--no-first-run',
                    '--no-default-browser-check', f'--load-extension={extension}', '--window-size=1000,850', 'about:blank'],
                    stdout=log, stderr=log, start_new_session=True)
                try:
                    deadline = time.monotonic() + 25
                    while time.monotonic() < deadline:
                        if any(report.get('error') or report.get('attempt') == 1
                               or (report.get('stage') == 'settled' and (report['width'] < 400 or report['height'] < 300))
                               for report in reports):
                            break
                        time.sleep(.1)
                    settled = [report for report in reports if report.get('stage') == 'settled']
                    for report in settled:
                        if not (report['width'] == 420 and report['height'] >= 300
                                and report['saveHeight'] > 0 and report['footerBottom'] <= report['height'] + 1):
                            raise AssertionError(json.dumps(report, ensure_ascii=False))
                    if len(settled) != 2:
                        raise AssertionError(f'Toolbar popup did not open and reopen: {reports}')
                    if settled[1]['saveLabel'] != '继续选图':
                        raise AssertionError('Reopened popup did not restore the saved result')
                    print('Actual Chrome toolbar popup: startup and reopening passed, '
                          + ', '.join(f"{r['width']}×{r['height']}" for r in settled) + '.')
                finally:
                    os.killpg(process.pid, signal.SIGTERM)
                    process.wait(timeout=5)
    finally:
        server.shutdown()
        server.server_close()


if __name__ == '__main__':
    main()
