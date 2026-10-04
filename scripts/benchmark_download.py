"""Compare peak Python allocations for an 80 MB response; no network required."""
import importlib.util
import json
import time
import tracemalloc
from pathlib import Path
from unittest import mock

spec = importlib.util.spec_from_file_location('host', Path(__file__).resolve().parents[1] / 'native-host/host.py')
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)

class Response:
    def __init__(self):
        self.remaining = 80 * 1024 * 1024
        self.headers = {'Content-Length': str(self.remaining)}
        self.first = True
    def __enter__(self): return self
    def __exit__(self, *args): pass
    def read(self, size):
        count = min(size, self.remaining)
        self.remaining -= count
        prefix = b'GIF89a' if self.first and count else b''
        self.first = False
        return prefix + b'x' * (count - len(prefix))

for mode in ('buffered', 'streamed'):
    tracemalloc.start()
    started = time.perf_counter()
    if mode == 'buffered':
        data = b'x' * host.MAX_IMAGE_BYTES
        del data
    else:
        with mock.patch.object(host, 'open_download', return_value=Response()):
            path, _ = host.download_media('https://ci.xiaohongshu.com/test', 'image/*')
            path.unlink()
    elapsed = time.perf_counter() - started
    _, peak = tracemalloc.get_traced_memory()
    tracemalloc.stop()
    print(json.dumps({'mode': mode, 'pythonPeakMiB': round(peak / 1024 / 1024, 2), 'seconds': round(elapsed, 3)}))
