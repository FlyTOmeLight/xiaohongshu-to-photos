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
        self.assertEqual([item['index'] for item in result['items']], [5])
        self.assertIn('第 5 张', result['liveFallbackDetails'][0])
