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

    def test_export_source_records_only_successful_resources(self):
        import json
        image = self.temporary_file('.gif')
        with (tempfile.TemporaryDirectory() as directory,
              mock.patch.object(host, 'download_image', return_value=(image, self.image_url, 'gif'))):
            result = host.process({'destination': 'folder', 'folderPath': directory,
                                   'pageUrl': 'https://www.xiaohongshu.com/explore/current123', 'title': '来源测试',
                                   'images': [{'index': 2, 'url': None}, {'index': 7, 'url': self.image_url}]})
            source = json.loads((Path(result['folderPath']) / 'source.json').read_text())
            self.assertEqual(source['title'], '来源测试')
            self.assertIn('current123', source['pageUrl'])
            self.assertEqual(source['failedIndices'], [2])
            self.assertEqual(source['items'][0]['files'], ['07.gif'])
            self.assertEqual(source['items'][0]['index'], 7)

    def test_source_write_failure_keeps_saved_media_and_reports_warning(self):
        image = self.temporary_file('.gif')
        with (tempfile.TemporaryDirectory() as directory,
              mock.patch.object(host, 'download_image', return_value=(image, self.image_url, 'gif')),
              mock.patch.object(Path, 'write_text', side_effect=OSError('磁盘已满'))):
            result = host.process({'destination': 'folder', 'folderPath': directory,
                                   'images': [{'url': self.image_url}]})
            self.assertTrue(result['ok'])
            self.assertEqual(result['saved'], 1)
            self.assertIn('来源记录写入失败', result['sourceWarning'])
            self.assertEqual({p.name for p in Path(result['folderPath']).iterdir()}, {'01.gif'})


class XVideoResultTests(MediaTestCase):
    def test_video_without_a_direct_source_does_not_download_the_poster(self):
        with mock.patch.object(host, 'download_video') as video:
            result = host.process({'images': [{
                'index': 1,
                'url': 'https://pbs.twimg.com/amplify_video_thumb/1/img/poster.jpg',
                'kind': 'video',
            }]})
        self.assertFalse(result['ok'])
        self.assertIn('没有找到视频直链', result['error'])
        video.assert_not_called()

    def test_placeholder_promotional_image_is_rejected(self):
        with mock.patch.object(host, 'download_image') as download:
            result = host.process({'images': [{
                'index': 1,
                'url': 'https://abs.twimg.com/rweb/ssr/default/v2/og/image.png',
                'kind': 'image',
            }]})
        self.assertFalse(result['ok'])
        self.assertIn('跳过平台默认宣传图', result['error'])
        download.assert_not_called()

    def test_mp4_video_and_animated_gif_export_as_video_with_actual_suffix(self):
        import io
        import json
        url = 'https://video.twimg.com/tweet_video/example.mp4'
        payloads = [
            {'url': url, 'kind': 'video'},
            {'url': 'https://pbs.twimg.com/media/poster?format=jpg', 'kind': 'gif', 'videoUrl': url},
            {'url': url, 'kind': 'gif'},
        ]
        for item in payloads:
            with self.subTest(item=item), tempfile.TemporaryDirectory() as directory:
                response = mock.MagicMock()
                response.__enter__.return_value = response
                response.headers = {}
                data = b'\x00\x00\x00\x18ftypisom' + b'\x00' * 16
                response.read.side_effect = io.BytesIO(data).read
                with (mock.patch.object(host, 'open_download', return_value=response),
                      mock.patch.object(host, 'download_image') as image,
                      mock.patch.object(host, 'prepare_live_photo') as pair):
                    result = host.process({'destination': 'folder', 'folderPath': directory,
                                           'images': [{**item, 'index': 4}]})
                self.assertTrue(result['ok'])
                self.assertEqual(result['liveFallback'], 0)
                self.assertEqual(result['items'][0]['kind'], 'video')
                self.assertEqual(result['items'][0]['format'], 'mp4')
                folder = Path(result['folderPath'])
                self.assertEqual((folder / '04.mp4').read_bytes(), data)
                source = json.loads((folder / 'source.json').read_text())
                self.assertEqual(source['items'][0]['files'], ['04.mp4'])
                self.assertEqual(source['items'][0]['url'], url)
                image.assert_not_called()
                pair.assert_not_called()

    def test_standalone_video_imports_one_resource_and_reports_failed_item(self):
        path = self.temporary_file('.mp4')
        url = 'https://video.twimg.com/a.mp4'
        with (mock.patch.object(host, 'download_video', side_effect=[ValueError('不支持 HLS'), (path, 'mp4')]),
              mock.patch.object(host, 'import_to_photos', return_value=(True, 1, '')) as importer,
              mock.patch.object(host, 'prepare_live_photo') as pair):
            result = host.process({'images': [{'index': 2, 'url': url, 'kind': 'video'},
                                             {'index': 8, 'url': url, 'kind': 'video'}]})
        self.assertTrue(result['ok'])
        self.assertEqual((result['saved'], result['failedIndices']), (1, [2]))
        self.assertEqual(result['items'][0]['index'], 8)
        importer.assert_called_once_with([path], '')
        pair.assert_not_called()
        self.assertFalse(path.exists())
