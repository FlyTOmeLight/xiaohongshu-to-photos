import tempfile
from pathlib import Path
from unittest import mock

from test_host import MediaTestCase, host


class SaveResultTests(MediaTestCase):
    def test_limit_rejects_the_whole_request_before_download(self):
        with mock.patch.object(host, 'download_image') as download:
            result = host.process({'images': [{'url': self.image_url}] * 31})
        self.assertFalse(result['ok'])
        self.assertIn('30', result['error'])
        download.assert_not_called()

    def test_invalid_items_count_as_failures_and_keep_original_numbers(self):
        image = self.temporary_file('.gif')
        with (
            tempfile.TemporaryDirectory() as directory,
            mock.patch.object(host, 'download_image', return_value=(image, self.image_url, 'gif')),
        ):
            result = host.process({'destination': 'folder', 'folderPath': directory, 'images': [
                {'index': 2, 'url': None}, {'index': 5, 'url': self.image_url},
            ]})
            self.assertTrue(result['ok'])
            self.assertEqual((result['saved'], result['failed']), (1, 1))
            self.assertIn('第 2 张', result['failureDetails'][0])
            self.assertEqual(result['failedIndices'], [2])
            self.assertEqual(result['items'][0]['index'], 5)
            self.assertTrue((Path(result['folderPath']) / '05.gif').is_file())

    def test_failed_export_does_not_count_as_saved_static_fallback(self):
        images = [self.temporary_file('.jpg') for _ in range(2)]
        copy = host.shutil.copyfile
        def fail_first(source, destination):
            if Path(destination).name == '01.jpg':
                raise OSError('磁盘已满')
            return copy(source, destination)
        with (
            tempfile.TemporaryDirectory() as directory,
            mock.patch.object(host, 'download_image', side_effect=[(p, self.image_url, 'jpg') for p in images]),
            mock.patch.object(host.shutil, 'copyfile', side_effect=fail_first),
        ):
            result = host.process({'destination': 'folder', 'folderPath': directory,
                                   'images': [{'url': self.image_url, 'kind': 'live'}] * 2})
        self.assertEqual((result['saved'], result['failed'], result['liveFallback']), (1, 1, 1))
        self.assertEqual(len(result['liveFallbackDetails']), 1)
        self.assertIn('第 2 张', result['liveFallbackDetails'][0])

    def test_photos_partial_import_reports_the_exact_failed_note_item(self):
        images = [self.temporary_file('.jpg') for _ in range(2)]
        with (
            mock.patch.object(host, 'download_image', side_effect=[(p, self.image_url, 'jpg') for p in images]),
            mock.patch.object(host, 'import_to_photos', side_effect=[(False, 0, '相簿导入失败'), (True, 1, '')]),
        ):
            result = host.process({'images': [{'index': 2, 'url': self.image_url, 'kind': 'live'},
                                             {'index': 5, 'url': self.image_url, 'kind': 'live'}]})
        self.assertTrue(result['ok'])
        self.assertEqual((result['saved'], result['failed'], result['liveFallback']), (1, 1, 1))
        self.assertIn('第 2 张：相簿导入失败', result['failureDetails'])
        self.assertEqual(result['failedIndices'], [2])
        self.assertEqual([item['index'] for item in result['items']], [5])
        self.assertIn('第 5 张', result['liveFallbackDetails'][0])

    def test_page_video_lookup_preserves_undefined_inside_urls(self):
        page = '<script>window.__INITIAL_STATE__={"noteId":"current123","value":undefined,"imageList":[{"urlDefault":"https://ci.xiaohongshu.com/undefined-image","stream":{"h264":[{"masterUrl":"https://sns-video-bd.xhscdn.com/undefined-video"}]}}]};</script>'
        with mock.patch.object(host, 'fetch_url', return_value=page.encode()):
            result = host.live_video_map_from_page('https://www.xiaohongshu.com/explore/current123')
        self.assertEqual(result['undefined-image'], ['https://sns-video-bd.xhscdn.com/undefined-video'])

    def test_protocol_check_is_read_only(self):
        with mock.patch.object(host, 'download_image') as download, mock.patch.object(host, 'import_to_photos') as photos:
            result = host.process({'action': 'status'})
        self.assertEqual(result, {'ok': True, 'protocolVersion': 3})
        download.assert_not_called()
        photos.assert_not_called()

    def test_quality_warning_only_counts_saved_page_versions(self):
        for failed_import in (False, True):
            for transformed in (False, True):
                with self.subTest(failed_import=failed_import, transformed=transformed):
                    image = self.temporary_file('.jpg')
                    url = self.image_url + ('!format/webp' if transformed else '')
                    with (mock.patch.object(host, 'download_image', return_value=(image, url, 'jpg')),
                          mock.patch.object(host, 'import_to_photos', side_effect=[(not failed_import, 1, '失败'), (True, 1, '')])):
                        result = host.process({'images': [{'index': 4, 'url': url}, {'index': 9, 'url': self.image_url}]})
                    self.assertEqual(len(result['qualityFallbackDetails']), int(transformed and not failed_import))
                    if result['qualityFallbackDetails']:
                        self.assertIn('第 4 张', result['qualityFallbackDetails'][0])
