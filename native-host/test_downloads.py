import io
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
