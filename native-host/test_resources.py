import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from test_host import MediaTestCase, host


class ResourceTests(MediaTestCase):
    def test_partial_write_failure_removes_temp_file(self):
        with tempfile.TemporaryDirectory() as directory:
            real_mkstemp = tempfile.mkstemp
            real_fdopen = os.fdopen

            def broken_writer(fd, mode):
                file = real_fdopen(fd, mode)
                writer = mock.MagicMock()
                writer.__enter__.return_value = writer
                writer.__exit__.side_effect = lambda *args: file.close()
                def write(data):
                    file.write(data[:2])
                    raise OSError('磁盘已满')
                writer.write.side_effect = write
                return writer

            with (
                mock.patch.object(host.tempfile, 'mkstemp', side_effect=lambda **kw: real_mkstemp(dir=directory, **kw)),
                mock.patch.object(host.os, 'fdopen', side_effect=broken_writer),
            ):
                response = mock.MagicMock()
                response.__enter__.return_value = response
                response.headers = {}
                response.read.side_effect = [b'GIF89a', b'']
                with mock.patch.object(host, 'open_download', return_value=response):
                    with self.assertRaisesRegex(OSError, '磁盘已满'):
                        host.download_media(self.image_url, 'image/*')
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_conversion_timeout_removes_output(self):
        with tempfile.TemporaryDirectory() as directory:
            real_mkstemp = tempfile.mkstemp
            with (
                mock.patch.object(host.tempfile, 'mkstemp', side_effect=lambda **kw: real_mkstemp(dir=directory, **kw)),
                mock.patch.object(host.subprocess, 'run', side_effect=subprocess.TimeoutExpired('sips', 120)),
            ):
                with self.assertRaises(subprocess.TimeoutExpired):
                    host.convert_live_image_to_jpeg(Path('/input.webp'))
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_missing_video_keeps_original_gif(self):
        path = self.temporary_file('.gif')
        captured = []
        def import_image(paths, album_id=''):
            captured.extend(paths)
            return True, 1, ''
        with (
            mock.patch.object(host, 'download_image', return_value=(path, self.image_url, 'gif')),
            mock.patch.object(host, 'convert_live_image_to_jpeg') as convert,
            mock.patch.object(host, 'import_to_photos', side_effect=import_image),
        ):
            result = host.process({'images': [{'url': self.image_url, 'kind': 'live'}]})
        self.assertTrue(result['ok'])
        self.assertEqual(result['items'][0]['format'], 'gif')
        self.assertEqual(captured, [path])
        convert.assert_not_called()

    def test_failed_pairing_cannot_destroy_static_fallback(self):
        path = self.temporary_file('.jpg')
        video = self.temporary_file('.mov')
        captured = []
        def break_pair(image, video):
            image.unlink()
            raise RuntimeError('配对失败')
        def capture(paths, album_id=''):
            captured.append(paths[0].read_bytes())
            return True, 1, ''
        with (
            mock.patch.object(host, 'download_image', return_value=(path, self.image_url, 'jpg')),
            mock.patch.object(host, 'download_video', return_value=(video, 'mov')),
            mock.patch.object(host, 'prepare_live_photo', side_effect=break_pair),
            mock.patch.object(host, 'import_to_photos', side_effect=capture),
        ):
            result = host.process({'images': [{'url': self.image_url, 'kind': 'live', 'videoUrl': self.video_url}]})
        self.assertTrue(result['ok'])
        self.assertEqual(captured, [b'test'])
        self.assertEqual(result['liveFallback'], 1)
        self.assertFalse(path.exists())
        self.assertFalse(video.exists())
