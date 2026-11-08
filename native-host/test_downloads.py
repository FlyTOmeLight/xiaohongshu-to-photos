import io
import tempfile
from pathlib import Path
import urllib.request
import urllib.response
import unittest
from email.message import Message
from unittest import mock

from test_host import host


class DownloadBoundaryTests(unittest.TestCase):
    def test_redirects_are_checked_before_contacting_the_target(self):
        for target, allowed in (
            ('https://sns-img-bd.xhscdn.com/final', True),
            ('https://pbs.twimg.com/media/final', True),
            ('https://twimg.com.evil.org/final', False),
            ('https://example.org/private', False),
            ('http://127.0.0.1/private', False),
        ):
            with self.subTest(target=target):
                visited = []

                class Transport(urllib.request.BaseHandler):
                    handler_order = 100
                    def https_open(self, request):
                        visited.append(request.full_url)
                        headers = Message()
                        redirect = request.full_url.endswith('/start')
                        if redirect:
                            headers['Location'] = target
                        response = urllib.response.addinfourl(
                            io.BytesIO(b'GIF89a'), headers, request.full_url, 302 if redirect else 200)
                        response.msg = 'Found' if redirect else 'OK'
                        return response
                    http_open = https_open

                build = urllib.request.build_opener
                opener = build(Transport())
                with (
                    mock.patch.object(urllib.request, '_opener', opener),
                    mock.patch.object(urllib.request, 'build_opener',
                                      side_effect=lambda *handlers: build(Transport(), *handlers)),
                ):
                    if allowed:
                        self.assertEqual(host.fetch_url('https://ci.xiaohongshu.com/start', 'image/*'), b'GIF89a')
                        self.assertEqual(visited[-1], target)
                    else:
                        with self.assertRaisesRegex(ValueError, '不允许'):
                            host.fetch_url('https://ci.xiaohongshu.com/start', 'image/*')
                        self.assertEqual(visited, ['https://ci.xiaohongshu.com/start'])

    def test_untrusted_initial_url_never_opens_a_connection(self):
        with mock.patch.object(urllib.request, 'urlopen') as open_url:
            with self.assertRaisesRegex(ValueError, '不允许'):
                host.fetch_url('https://example.org/image', 'image/*')
            open_url.assert_not_called()


class XDownloadTests(unittest.TestCase):
    def test_allowlist_and_original_image_candidates(self):
        for url in ('https://x.com/a/status/1', 'https://twitter.com/a/status/1',
                    'https://pbs.twimg.com/media/photo?format=jpg&name=small',
                    'https://video.twimg.com/tweet_video/a.mp4'):
            self.assertTrue(host.allowed_url(url))
        for url in ('https://twimg.com.evil.org/a', 'https://evilx.com/a', 'file:///a'):
            self.assertFalse(host.allowed_url(url))
        url = 'https://pbs.twimg.com/media/photo?format=jpg&name=small&tag=1'
        self.assertEqual(host.image_candidates(url), [
            'https://pbs.twimg.com/media/photo?format=jpg&tag=1&name=orig', url])
        self.assertEqual(host.image_candidates('https://pbs.twimg.com/media/photo.jpg:large')[0],
                         'https://pbs.twimg.com/media/photo.jpg?name=orig')
        self.assertEqual(host.image_candidates('https://pbs.twimg.com/media/photo?format=webp&name=large')[0],
                         'https://pbs.twimg.com/media/photo?format=jpg&name=orig')
        self.assertEqual(host.image_candidates('https://x.com/image'), ['https://x.com/image'])

    def test_referer_matches_the_download_site(self):
        for url, referer in [('https://pbs.twimg.com/media/a', 'https://x.com/'),
                             ('https://video.twimg.com/a.mp4', 'https://x.com/'),
                             ('https://ci.xiaohongshu.com/a', 'https://www.xiaohongshu.com/')]:
            with self.subTest(url=url), mock.patch.object(urllib.request, 'build_opener') as build:
                host.open_download(url, '*/*')
                request = build.return_value.open.call_args.args[0]
                self.assertEqual(request.get_header('Referer'), referer)

    def test_video_signature_suffix_and_independent_size_cap(self):
        for brand, suffix in [(b'isom', 'mp4'), (b'mp42', 'mp4'), (b'qt  ', 'mov')]:
            with self.subTest(brand=brand):
                response = mock.MagicMock()
                response.__enter__.return_value = response
                data = b'\x00\x00\x00\x18ftyp' + brand + b'\x00' * 16
                response.headers = {'Content-Length': str(len(data))}
                response.read.side_effect = io.BytesIO(data).read
                with (mock.patch.object(host, 'open_download', return_value=response),
                      mock.patch.object(host, 'MAX_IMAGE_BYTES', 1),
                      mock.patch.object(host, 'MAX_VIDEO_BYTES', len(data))):
                    path, fmt = host.download_media('https://video.twimg.com/a.mp4', 'video/*', video=True)
                self.addCleanup(path.unlink, missing_ok=True)
                self.assertEqual(fmt, suffix)
                self.assertEqual(path.suffix, '.' + suffix)
                self.assertEqual(path.read_bytes(), data)

    def test_hls_invalid_video_and_oversize_downloads_leave_no_files(self):
        cases = [
            ('https://video.twimg.com/a.m3u8', {}, b'anything'),
            ('https://video.twimg.com/a', {'Content-Type': 'application/vnd.apple.mpegurl'}, b'anything'),
            ('https://video.twimg.com/a', {}, b'#EXTM3U\n#EXT-X-STREAM-INF'),
            ('https://video.twimg.com/a', {}, b'GIF89a'),
            ('https://video.twimg.com/a', {}, b'\x00\x00\x00\x18ftypavif' + b'x' * 8),
            ('https://video.twimg.com/a', {}, b'\x00\x00\x00\x18ftypisom' + b'x' * 40),
            ('https://video.twimg.com/a', {'Content-Length': '100'}, b''),
        ]
        for url, headers, data in cases:
            with self.subTest(url=url, headers=headers, data=data), tempfile.TemporaryDirectory() as directory:
                response = mock.MagicMock()
                response.__enter__.return_value = response
                response.headers = headers
                response.read.side_effect = io.BytesIO(data).read
                mkstemp = tempfile.mkstemp
                with (mock.patch.object(host, 'open_download', return_value=response) as opener,
                      mock.patch.object(host, 'MAX_VIDEO_BYTES', 32),
                      mock.patch.object(host.tempfile, 'mkstemp', side_effect=lambda **kw: mkstemp(dir=directory, **kw))):
                    with self.assertRaises(ValueError):
                        host.download_media(url, 'video/*', video=True)
                    if url.endswith('.m3u8'):
                        opener.assert_not_called()
                self.assertEqual(list(Path(directory).iterdir()), [])
