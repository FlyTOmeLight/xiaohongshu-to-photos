import io
import tempfile
from pathlib import Path
from unittest import mock

from test_host import MediaTestCase, host


class CancelTests(MediaTestCase):
    def setUp(self):
        super().setUp()
        host.CANCELLED.clear()
        self.addCleanup(host.CANCELLED.clear)

    def test_stop_keeps_exported_items_and_does_not_start_next_download(self):
        image = self.temporary_file('.jpg')
        def progress(event):
            if event['completed'] == 1:
                host.CANCELLED.set()
        with (tempfile.TemporaryDirectory() as directory,
              mock.patch.object(host, 'download_image', return_value=(image, self.image_url, 'jpg')) as download):
            result = host.process({'destination': 'folder', 'folderPath': directory,
                                   'images': [{'index': n, 'url': self.image_url} for n in (2, 5, 7)]}, progress)
            self.assertTrue(result['cancelled'])
            self.assertEqual((result['saved'], result['failedIndices']), (1, [5, 7]))
            self.assertTrue((Path(result['folderPath']) / '02.jpg').is_file())
            download.assert_called_once()
        self.assertFalse(image.exists())

    def test_stop_during_download_removes_partial_file_without_trying_another_candidate(self):
        with tempfile.TemporaryDirectory() as directory:
            response = mock.MagicMock()
            response.__enter__.return_value = response
            response.headers = {}
            def read(size):
                host.CANCELLED.set()
                return b'GIF89a'
            response.read.side_effect = read
            real = host.tempfile.mkstemp
            with (mock.patch.object(host.tempfile, 'mkstemp', side_effect=lambda **kw: real(dir=directory, **kw)),
                  mock.patch.object(host, 'open_download', return_value=response) as download):
                with self.assertRaises(host.SaveCancelled):
                    host.download_image(self.image_url)
                download.assert_called_once()
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_streaming_validates_signature_and_size_and_cleans_up_failures(self):
        for data, limit, accepted in [(b'GIF89a' + b'x' * 700000, 800000, True),
                                      (b'GIF89a' + b'x' * 700000, 100, False),
                                      (b'not-media', 100, False)]:
            with self.subTest(limit=limit, accepted=accepted), tempfile.TemporaryDirectory() as directory:
                response = mock.MagicMock()
                response.__enter__.return_value = response
                response.headers = {}
                stream = io.BytesIO(data)
                response.read.side_effect = stream.read
                real = host.tempfile.mkstemp
                with (mock.patch.object(host.tempfile, 'mkstemp', side_effect=lambda **kw: real(dir=directory, **kw)),
                      mock.patch.object(host, 'open_download', return_value=response),
                      mock.patch.object(host, 'MAX_IMAGE_BYTES', limit)):
                    if accepted:
                        path, fmt = host.download_media(self.image_url, 'image/*')
                        self.assertEqual(fmt, 'gif')
                        self.assertEqual(path.read_bytes(), data)
                        self.assertTrue(all(call.args[0] <= host.DOWNLOAD_CHUNK_BYTES for call in response.read.call_args_list))
                    else:
                        with self.assertRaises(ValueError):
                            host.download_media(self.image_url, 'image/*')
                        self.assertEqual(list(Path(directory).iterdir()), [])

    def test_real_native_process_accepts_a_cancel_frame_and_exits_cleanly(self):
        import json
        import struct
        import subprocess
        import sys
        with tempfile.TemporaryDirectory() as directory:
            request = {'destination': 'folder', 'folderPath': directory,
                       'images': [{'url': 'https://example.org/rejected'}] * 30}
            def frame(value):
                data = json.dumps(value).encode()
                return struct.pack('@I', len(data)) + data
            result = subprocess.run([sys.executable, str(Path(host.__file__))],
                                    input=frame(request) + frame({'action': 'cancel'}),
                                    capture_output=True, check=True, timeout=5)
            output = io.BytesIO(result.stdout)
            frames = []
            while header := output.read(4):
                frames.append(json.loads(output.read(struct.unpack('@I', header)[0])))
            self.assertTrue(frames[-1]['cancelled'])
            self.assertEqual(frames[-1]['failedIndices'], list(range(1, 31)))
            self.assertEqual(list(Path(directory).iterdir()), [])
