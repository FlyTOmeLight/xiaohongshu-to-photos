import importlib.util
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock


HOST_PATH = Path(__file__).with_name("host.py")
SPEC = importlib.util.spec_from_file_location("rednote_host", HOST_PATH)
host = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(host)


class MediaTestCase(unittest.TestCase):
    def setUp(self):
        self.image_url = "https://sns-img-bd.xhscdn.com/example_image_1234567890"
        self.video_url = "https://sns-video-bd.xhscdn.com/example_video_1234567890"

    @staticmethod
    def temporary_file(suffix):
        descriptor, filename = tempfile.mkstemp(suffix=suffix)
        os.close(descriptor)
        Path(filename).write_bytes(b"test")
        return Path(filename)


class ProcessLivePhotoTests(MediaTestCase):
    def test_live_photo_without_video_falls_back_to_static_image(self):
        image_path = self.temporary_file(".jpg")
        imported_paths = []

        def capture_import(paths, album_id=""):
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

        def capture_import(paths, album_id=""):
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
        self.assertEqual(imported_paths[0], jpeg_path)
        self.assertEqual(imported_paths[1].suffix, ".mov")
        self.assertNotEqual(imported_paths[1], mov_path)
        pairer.assert_called_once_with(*imported_paths)
        self.assertFalse(imported_paths[1].parent.exists())

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


class DestinationTests(MediaTestCase):
    def test_default_destination_imports_into_library(self):
        image_path = self.temporary_file(".jpg")
        with (
            mock.patch.object(host, "download_image", return_value=(image_path, self.image_url, "jpg")),
            mock.patch.object(host, "import_to_photos", return_value=(True, 1, "")) as importer,
        ):
            result = host.process({"images": [{"url": self.image_url}]})
        self.assertTrue(result["ok"])
        importer.assert_called_once_with([image_path], "")
        self.assertFalse(image_path.exists())

    def test_selected_album_is_passed_as_argument(self):
        image_path = self.temporary_file(".gif")
        with (
            mock.patch.object(host, "download_image", return_value=(image_path, self.image_url, "gif")),
            mock.patch.object(host, "import_to_photos", return_value=(True, 1, "")) as importer,
        ):
            result = host.process({"albumId": 'album/with"quotes', "images": [{"url": self.image_url}]})
        self.assertTrue(result["ok"])
        importer.assert_called_once_with([image_path], 'album/with"quotes')

    def test_folder_preserves_gif_and_paired_live_resources_without_overwriting(self):
        with tempfile.TemporaryDirectory() as directory:
            results = []
            for _ in range(2):
                gif = self.temporary_file(".gif")
                jpeg = self.temporary_file(".jpg")
                mov = self.temporary_file(".mov")
                with (
                    mock.patch.object(host, "download_image", side_effect=[
                        (gif, self.image_url, "gif"), (jpeg, self.image_url, "jpg")]),
                    mock.patch.object(host, "download_video", return_value=(mov, "mov")),
                    mock.patch.object(host, "prepare_live_photo"),
                    mock.patch.object(host, "import_to_photos") as importer,
                ):
                    result = host.process({
                        "destination": "folder", "folderPath": directory, "title": "../笔记:标题",
                        "images": [{"url": self.image_url},
                                   {"url": self.image_url, "kind": "live", "videoUrl": self.video_url}],
                    })
                self.assertTrue(result["ok"])
                self.assertEqual(result["saved"], 2)
                importer.assert_not_called()
                exported = Path(result["folderPath"])
                self.assertEqual(exported.parent, Path(directory))
                self.assertEqual({path.name for path in exported.iterdir()}, {"01.gif", "02.jpg", "02.mov"})
                self.assertEqual((exported / "01.gif").read_bytes(), b"test")
                self.assertFalse(any(path.exists() for path in (gif, jpeg, mov)))
                results.append(exported)
            self.assertNotEqual(*results)

    def test_invalid_folder_is_rejected_before_download(self):
        with mock.patch.object(host, "download_image") as downloader:
            for path in ("", "relative/path", "/nonexistent/rednote-folder"):
                with self.subTest(path=path):
                    result = host.process({"destination": "folder", "folderPath": path,
                                           "images": [{"url": self.image_url}]})
                    self.assertFalse(result["ok"])
            downloader.assert_not_called()

    def test_partial_export_reports_failed_item(self):
        image_path = self.temporary_file(".png")
        with tempfile.TemporaryDirectory() as directory, mock.patch.object(
            host, "download_image", side_effect=[RuntimeError("下载失败"), (image_path, self.image_url, "png")]
        ):
            result = host.process({"destination": "folder", "folderPath": directory,
                                   "images": [{"url": self.image_url}] * 2})
            self.assertEqual(result["saved"], 1)
            self.assertEqual(result["failed"], 1)
            self.assertIn("第 1 张：下载失败", result["failureDetails"])
            self.assertTrue((Path(result["folderPath"]) / "02.png").exists())

    def test_failed_live_copy_removes_both_resources(self):
        jpeg = self.temporary_file(".jpg")
        mov = self.temporary_file(".mov")
        original_copy = host.shutil.copyfile

        def copy_until_full(source, destination):
            original_copy(source, destination)
            if Path(destination).name == "01.mov":
                raise OSError("磁盘已满")

        with (
            tempfile.TemporaryDirectory() as directory,
            mock.patch.object(host, "download_image", return_value=(jpeg, self.image_url, "jpg")),
            mock.patch.object(host, "download_video", return_value=(mov, "mov")),
            mock.patch.object(host, "prepare_live_photo"),
            mock.patch.object(host.shutil, "copyfile", side_effect=copy_until_full),
        ):
            result = host.process({"destination": "folder", "folderPath": directory,
                                   "images": [{"url": self.image_url, "kind": "live", "videoUrl": self.video_url}]})
            self.assertFalse(result["ok"])
            self.assertIn("磁盘已满", result["error"])
            self.assertEqual(list(Path(directory).iterdir()), [])
        self.assertFalse(jpeg.exists())
        self.assertFalse(mov.exists())

    def test_folder_dialog_cancellation_is_not_an_error(self):
        with mock.patch.object(host.subprocess, "run", return_value=mock.Mock(returncode=0, stdout="\n")):
            self.assertEqual(host.process({"action": "chooseFolder"}),
                             {"ok": True, "cancelled": True, "path": ""})

    def test_album_listing_preserves_ids_and_names(self):
        with mock.patch.object(host.subprocess, "run", return_value=mock.Mock(
            returncode=0, stdout='[{"id":"b","name":"相簿\\\"B"},{"id":"a","name":"相簿\\nA"}]'
        )):
            result = host.process({"action": "listAlbums"})
        self.assertTrue(result["ok"])
        self.assertEqual({album["id"] for album in result["albums"]}, {"a", "b"})
        self.assertIn('相簿"B', [album["name"] for album in result["albums"]])


if __name__ == "__main__":
    unittest.main()
