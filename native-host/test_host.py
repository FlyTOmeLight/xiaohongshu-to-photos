import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest import mock


HOST_PATH = Path(__file__).with_name("host.py")
SPEC = importlib.util.spec_from_file_location("rednote_host", HOST_PATH)
host = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(host)


class ProcessLivePhotoTests(unittest.TestCase):
    def setUp(self):
        self.image_url = "https://sns-img-bd.xhscdn.com/example_image_1234567890"
        self.video_url = "https://sns-video-bd.xhscdn.com/example_video_1234567890"

    @staticmethod
    def temporary_file(suffix):
        descriptor, filename = tempfile.mkstemp(suffix=suffix)
        Path(filename).write_bytes(b"test")
        return Path(filename)

    def test_live_photo_without_video_falls_back_to_static_image(self):
        image_path = self.temporary_file(".jpg")
        imported_paths = []

        def capture_import(paths):
            imported_paths.extend(paths)
            return True, 1, ""

        with (
            mock.patch.object(host, "download_image", return_value=(image_path, self.image_url, "jpg")),
            mock.patch.object(host, "import_to_photos", side_effect=capture_import),
        ):
            result = host.process({
                "images": [{"url": self.image_url, "kind": "live", "videoUrls": []}]
            })

        self.assertTrue(result["ok"])
        self.assertEqual(result["saved"], 1)
        self.assertEqual(result["liveFallback"], 1)
        self.assertIn("没有实况视频地址", result["liveFallbackDetails"][0])
        self.assertEqual(result["items"][0]["kind"], "image")
        self.assertEqual(imported_paths, [image_path])

    def test_webp_and_mov_are_imported_together_as_one_live_photo(self):
        webp_path = self.temporary_file(".webp")
        jpeg_path = self.temporary_file(".jpg")
        mov_path = self.temporary_file(".mov")
        imported_paths = []

        def capture_import(paths):
            imported_paths.extend(paths)
            return True, 1, ""

        with (
            mock.patch.object(host, "download_image", return_value=(webp_path, self.image_url, "webp")),
            mock.patch.object(host, "convert_live_image_to_jpeg", return_value=jpeg_path),
            mock.patch.object(host, "download_video", return_value=(mov_path, "mov")),
            mock.patch.object(host, "prepare_live_photo") as pairer,
            mock.patch.object(host, "import_to_photos", side_effect=capture_import),
        ):
            result = host.process({
                "images": [{
                    "url": self.image_url,
                    "kind": "live",
                    "videoUrl": self.video_url,
                    "videoUrls": [self.video_url],
                }]
            })

        self.assertTrue(result["ok"])
        self.assertEqual(result["saved"], 1)
        self.assertEqual(result["items"][0]["kind"], "live")
        self.assertEqual(result["items"][0]["sourceFormat"], "webp")
        self.assertEqual(result["items"][0]["format"], "jpg")
        self.assertEqual(imported_paths, [jpeg_path, mov_path])
        pairer.assert_called_once_with(jpeg_path, mov_path)

    def test_missing_video_url_is_recovered_from_the_note_page(self):
        image_url = "https://sns-img-bd.xhscdn.com/a/notes_pre_post/live_file_123!format/webp"
        page_url = "https://www.xiaohongshu.com/explore/current123"
        image_path = self.temporary_file(".jpg")
        mov_path = self.temporary_file(".mov")

        with (
            mock.patch.object(host, "live_video_map_from_page", return_value={
                "live_file_123": [self.video_url]
            }) as page_lookup,
            mock.patch.object(host, "download_image", return_value=(image_path, image_url, "jpg")),
            mock.patch.object(host, "download_video", return_value=(mov_path, "mov")) as video_download,
            mock.patch.object(host, "prepare_live_photo"),
            mock.patch.object(host, "import_to_photos", return_value=(True, 1, "")),
        ):
            result = host.process({
                "pageUrl": page_url,
                "images": [{"url": image_url, "kind": "live", "videoUrls": []}],
            })

        self.assertTrue(result["ok"])
        self.assertEqual(result["items"][0]["kind"], "live")
        page_lookup.assert_called_once_with(page_url)
        video_download.assert_called_once_with(self.video_url)


if __name__ == "__main__":
    unittest.main()
