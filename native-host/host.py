#!/usr/bin/env python3
"""Native Messaging host: download selected XHS images and import them to Photos."""

from __future__ import annotations

import contextlib
import json
import os
import re
import struct
import subprocess
import sys
import tempfile
import urllib.parse
import urllib.request
from pathlib import Path

MAX_MESSAGE_BYTES = 1024 * 1024
MAX_IMAGE_BYTES = 80 * 1024 * 1024
LIVE_PHOTO_HELPER = Path(__file__).with_name("live-photo-helper")
ALLOWED_HOST_SUFFIXES = (
    "xiaohongshu.com",
    "xhscdn.com",
    "xhscdn.net",
)

IMPORT_SCRIPT = r'''
on run argv
  set filesToImport to {}
  repeat with filePath in argv
    set end of filesToImport to POSIX file (contents of filePath)
  end repeat
  -- Do not "activate" Photos here. Stealing focus closes the Chrome popup
  -- before it can report the result, so the user sees nothing at all.
  -- The import itself does not need the app to be frontmost.
  tell application "Photos" to set importedItems to import (filesToImport)
  return count of importedItems
end run
'''


def read_exact(size: int) -> bytes:
    chunks = bytearray()
    while len(chunks) < size:
        chunk = sys.stdin.buffer.read(size - len(chunks))
        if not chunk:
            raise EOFError("native message ended early")
        chunks.extend(chunk)
    return bytes(chunks)


def read_message() -> dict:
    raw_length = sys.stdin.buffer.read(4)
    if not raw_length:
        raise EOFError
    if len(raw_length) != 4:
        raise ValueError("invalid native message header")
    length = struct.unpack("@I", raw_length)[0]
    if length <= 0 or length > MAX_MESSAGE_BYTES:
        raise ValueError("native message is too large")
    value = json.loads(read_exact(length).decode("utf-8"))
    if not isinstance(value, dict):
        raise ValueError("native message must be an object")
    return value


def send_message(value: dict) -> None:
    encoded = json.dumps(value, ensure_ascii=False).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("@I", len(encoded)))
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()


def allowed_url(raw_url: str) -> bool:
    try:
        parsed = urllib.parse.urlsplit(raw_url)
    except ValueError:
        return False
    hostname = (parsed.hostname or "").lower()
    return parsed.scheme in {"http", "https"} and any(
        hostname == suffix or hostname.endswith(f".{suffix}")
        for suffix in ALLOWED_HOST_SUFFIXES
    )


def image_candidates(raw_url: str) -> list[str]:
    """Return original-quality XHS candidates before the displayed CDN URL."""
    if not allowed_url(raw_url):
        raise ValueError("不允许的图片地址")

    parsed = urllib.parse.urlsplit(raw_url)
    clean_path = parsed.path.split("!", 1)[0]
    original = urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, clean_path, "", ""))
    candidates = [original]

    trace = clean_path.rstrip("/").rsplit("/", 1)[-1]
    if len(trace) >= 20 and re.fullmatch(r"[0-9A-Za-z_-]+", trace):
        candidates.extend(
            [
                f"https://ci.xiaohongshu.com/{trace}",
                f"https://sns-img-bd.xhscdn.com/{trace}",
                f"https://sns-img-hw.xhscdn.com/{trace}",
            ]
        )

    if raw_url not in candidates:
        candidates.append(raw_url)
    return list(dict.fromkeys(candidates))


def sniff_format(data: bytes) -> str | None:
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if data.startswith(b"\xff\xd8\xff"):
        return "jpg"
    if data.startswith((b"GIF87a", b"GIF89a")):
        return "gif"
    if data.startswith(b"RIFF") and data[8:12] == b"WEBP":
        return "webp"
    if len(data) >= 12 and data[4:8] == b"ftyp":
        brand = data[8:12]
        if brand in {b"avif", b"avis"}:
            return "avif"
        if brand in {b"heic", b"heix", b"hevc", b"hevx", b"mif1"}:
            return "heic"
    return None


def fetch_url(url: str, accept: str) -> bytes:
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": (
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140 Safari/537.36"
            ),
            "Accept": accept,
            "Referer": "https://www.xiaohongshu.com/",
        },
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        content_length = int(response.headers.get("Content-Length") or 0)
        if content_length > MAX_IMAGE_BYTES:
            raise ValueError("图片超过 80 MB")
        data = response.read(MAX_IMAGE_BYTES + 1)
    if len(data) > MAX_IMAGE_BYTES:
        raise ValueError("图片超过 80 MB")
    return data


def fetch_image(url: str) -> bytes:
    return fetch_url(url, "image/png,image/jpeg,image/gif,image/webp,image/avif,image/*,*/*;q=0.8")


def image_identity(raw_url: str) -> str:
    """Return the stable XHS file id shared by preview and original CDN URLs."""
    try:
        path = urllib.parse.unquote(urllib.parse.urlsplit(raw_url).path).split("!", 1)[0]
    except ValueError:
        return ""
    marker = "notes_pre_post/"
    if marker in path:
        return path.split(marker, 1)[1].strip("/")
    return path.rstrip("/").rsplit("/", 1)[-1]


def stream_video_urls(item: dict) -> list[str]:
    stream = item.get("stream") or item.get("streams") or {}
    if not isinstance(stream, dict):
        return []
    urls: list[str] = []
    for codec in ("h264", "h265", "h266", "av1"):
        variants = stream.get(codec) or stream.get(codec.upper()) or []
        if not isinstance(variants, list):
            continue
        for variant in variants:
            if not isinstance(variant, dict):
                continue
            urls.append(variant.get("masterUrl") or variant.get("master_url") or variant.get("url") or "")
            backups = variant.get("backupUrls") or variant.get("backup_urls") or []
            if isinstance(backups, list):
                urls.extend(backups)
    return list(dict.fromkeys(url for url in urls if isinstance(url, str) and allowed_url(url)))


def find_note_data(state: object, wanted_id: str) -> dict | None:
    queue = [state]
    cursor = 0
    inspected = 0
    candidates: list[tuple[int, dict]] = []
    while cursor < len(queue) and inspected < 50000:
        value = queue[cursor]
        cursor += 1
        inspected += 1
        if isinstance(value, dict):
            images = value.get("imageList") or value.get("image_list")
            if isinstance(images, list) and images:
                note_id = str(value.get("noteId") or value.get("note_id") or "")
                if not wanted_id or note_id == wanted_id:
                    video_count = sum(len(stream_video_urls(item)) for item in images if isinstance(item, dict))
                    candidates.append((video_count * 100 + len(images), value))
            queue.extend(child for child in value.values() if isinstance(child, (dict, list)))
        elif isinstance(value, list):
            queue.extend(child for child in value if isinstance(child, (dict, list)))
    return max(candidates, key=lambda candidate: candidate[0])[1] if candidates else None


def live_video_map_from_page(page_url: str) -> dict[str, list[str]]:
    if not allowed_url(page_url):
        return {}
    page = fetch_url(page_url, "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8").decode("utf-8", "replace")
    wanted_match = re.search(r"/(?:explore|discovery/item)/([0-9a-z]+)", urllib.parse.urlsplit(page_url).path, re.I)
    wanted_id = wanted_match.group(1) if wanted_match else ""
    results: dict[str, list[str]] = {}
    for match in re.finditer(r"window\.__INITIAL_STATE__=(.*?)</script>", page, re.S):
        raw_state = match.group(1).strip().removesuffix(";")
        try:
            state = json.loads(re.sub(r"\bundefined\b", "null", raw_state))
        except json.JSONDecodeError:
            continue
        note_data = find_note_data(state, wanted_id)
        images = (note_data or {}).get("imageList") or (note_data or {}).get("image_list") or []
        for item in images:
            if not isinstance(item, dict):
                continue
            urls = stream_video_urls(item)
            if not urls:
                continue
            info_list = item.get("infoList") or item.get("info_list") or []
            image_urls = [
                item.get("urlDefault"), item.get("url_default"), item.get("urlPre"), item.get("url_pre"),
                item.get("url"), item.get("fileId"), item.get("file_id"),
            ]
            if isinstance(info_list, list):
                image_urls.extend(value.get("url") for value in info_list if isinstance(value, dict))
            for image_url in image_urls:
                if not isinstance(image_url, str) or not image_url:
                    continue
                identity = image_identity(image_url)
                if identity:
                    results[identity] = urls
    return results


def persist_image(data: bytes, image_format: str) -> Path:
    descriptor, filename = tempfile.mkstemp(prefix="rednote_", suffix=f".{image_format}")
    with os.fdopen(descriptor, "wb") as file:
        file.write(data)
    return Path(filename)


def download_image(raw_url: str) -> tuple[Path, str, str]:
    last_error: Exception | None = None
    for candidate in image_candidates(raw_url):
        try:
            data = fetch_image(candidate)
            image_format = sniff_format(data)
            if not image_format:
                raise ValueError("服务器返回的内容不是受支持的图片")
            return persist_image(data, image_format), candidate, image_format
        except Exception as error:  # Try the next CDN/original candidate.
            last_error = error
    raise last_error or RuntimeError("无法下载图片")


def download_video(raw_url: str) -> tuple[Path, str]:
    if not allowed_url(raw_url):
        raise ValueError("不允许的实况视频地址")
    parsed = urllib.parse.urlsplit(raw_url)
    secure_url = urllib.parse.urlunsplit(("https", parsed.netloc, parsed.path, parsed.query, ""))
    last_error: Exception | None = None
    for candidate in dict.fromkeys((secure_url, raw_url)):
        try:
            data = fetch_url(candidate, "video/quicktime,video/mp4,video/*,*/*;q=0.8")
            if len(data) < 12 or data[4:8] != b"ftyp" or sniff_format(data):
                raise ValueError("服务器返回的内容不是受支持的实况视频")
            return persist_image(data, "mov"), "mov"
        except Exception as error:
            last_error = error
    raise last_error or RuntimeError("无法下载实况视频")


def prepare_live_photo(image_path: Path, video_path: Path) -> None:
    if not LIVE_PHOTO_HELPER.is_file() or not os.access(LIVE_PHOTO_HELPER, os.X_OK):
        raise RuntimeError("实况照片组件尚未安装")
    result = subprocess.run(
        [str(LIVE_PHOTO_HELPER), str(image_path), str(video_path)],
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError((result.stderr or result.stdout or "实况照片配对失败").strip())


def convert_live_image_to_jpeg(image_path: Path) -> Path:
    descriptor, filename = tempfile.mkstemp(prefix="rednote_live_", suffix=".jpg")
    os.close(descriptor)
    output_path = Path(filename)
    result = subprocess.run(
        [
            "/usr/bin/sips",
            "-s", "format", "jpeg",
            "-s", "formatOptions", "best",
            str(image_path),
            "--out", str(output_path),
        ],
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )
    if result.returncode != 0:
        with contextlib.suppress(OSError):
            output_path.unlink()
        raise RuntimeError((result.stderr or result.stdout or "WebP 转 JPEG 失败").strip())
    with output_path.open("rb") as file:
        if sniff_format(file.read(16)) != "jpg":
            with contextlib.suppress(OSError):
                output_path.unlink()
            raise RuntimeError("Live 静态帧没有成功转换为 JPEG")
    return output_path


def import_to_photos(paths: list[Path]) -> tuple[bool, int, str]:
    result = subprocess.run(
        ["/usr/bin/osascript", "-e", IMPORT_SCRIPT, *map(str, paths)],
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )
    detail = (result.stderr or result.stdout or "").strip()
    if result.returncode != 0:
        return False, 0, detail or "Photos 导入失败"
    try:
        imported_count = int(result.stdout.strip())
    except ValueError:
        return False, 0, "Photos 没有返回有效的导入结果"
    if imported_count <= 0:
        return False, 0, "Photos 没有导入任何图片"
    return True, imported_count, ""


def process(message: dict) -> dict:
    items = message.get("images")
    if not isinstance(items, list):
        return {"ok": False, "error": "缺少图片列表"}

    urls = []
    for item in items[:30]:
        url = item.get("url", "") if isinstance(item, dict) else ""
        if allowed_url(url):
            urls.append(url)
    if not urls:
        return {"ok": False, "error": "没有有效的小红书图片地址"}

    cleanup_paths: list[Path] = []
    import_paths: list[Path] = []
    downloaded: list[dict] = []
    failures: list[str] = []
    live_fallback = 0
    live_fallback_details: list[str] = []
    page_live_urls: dict[str, list[str]] = {}
    page_live_error = ""
    needs_live_lookup = any(
        isinstance(item, dict)
        and item.get("kind") == "live"
        and not item.get("videoUrl")
        and not item.get("videoUrls")
        for item in items[:30]
    )
    if needs_live_lookup:
        try:
            page_live_urls = live_video_map_from_page(str(message.get("pageUrl") or ""))
        except Exception as error:
            page_live_error = str(error)
    try:
        valid_items = [item for item in items[:30] if isinstance(item, dict) and allowed_url(item.get("url", ""))]
        for index, item in enumerate(valid_items, start=1):
            url = item["url"]
            try:
                path, used_url, image_format = download_image(url)
                cleanup_paths.append(path)
                import_image_path = path
                import_image_format = image_format
                media_kind = "gif" if image_format == "gif" else "image"

                supplied_video_urls = item.get("videoUrls", [])
                video_urls = [item.get("videoUrl", "")]
                if isinstance(supplied_video_urls, list):
                    video_urls.extend(supplied_video_urls[:8])
                if item.get("kind") == "live" and not any(video_urls):
                    video_urls.extend(page_live_urls.get(image_identity(url), []))
                video_urls = list(dict.fromkeys(
                    value for value in video_urls if isinstance(value, str) and allowed_url(value)
                ))
                is_live_item = item.get("kind") == "live" or bool(video_urls)
                if is_live_item:
                    last_live_error: Exception | None = None
                    if image_format not in {"jpg", "heic"}:
                        try:
                            import_image_path = convert_live_image_to_jpeg(path)
                            import_image_format = "jpg"
                            cleanup_paths.append(import_image_path)
                        except Exception as error:
                            last_live_error = error

                    paired_video_path: Path | None = None
                    if last_live_error is None:
                        for video_url in video_urls:
                            try:
                                video_path, video_format = download_video(video_url)
                                cleanup_paths.append(video_path)
                                prepare_live_photo(import_image_path, video_path)
                                paired_video_path = video_path
                                media_kind = "live"
                                break
                            except Exception as error:
                                last_live_error = error
                                continue
                    if media_kind != "live":
                        # No usable video: keep the still as a normal photo instead of
                        # failing the item, and report it so the popup can say so.
                        live_fallback += 1
                        live_fallback_details.append(
                            f"第 {index} 张：{last_live_error or page_live_error or '没有实况视频地址'}"
                        )

                import_paths.append(import_image_path)
                if is_live_item and media_kind == "live" and paired_video_path:
                    import_paths.append(paired_video_path)

                downloaded.append({
                    "index": index,
                    "url": used_url,
                    "format": import_image_format,
                    "sourceFormat": image_format,
                    "kind": media_kind,
                })
            except Exception as error:
                failures.append(f"第 {index} 张：{error}")

        if not import_paths:
            return {"ok": False, "error": failures[0] if failures else "没有图片下载成功"}

        imported, imported_count, detail = import_to_photos(import_paths)
        if not imported:
            return {"ok": False, "error": detail, "failed": len(urls)}

        saved_count = min(imported_count, len(downloaded))
        return {
            "ok": True,
            "saved": saved_count,
            "failed": len(failures) + max(0, len(downloaded) - saved_count),
            "liveFallback": live_fallback,
            "liveFallbackDetails": live_fallback_details,
            "items": downloaded,
        }
    finally:
        for path in cleanup_paths:
            with contextlib.suppress(OSError):
                path.unlink()


def main() -> None:
    try:
        send_message(process(read_message()))
    except EOFError:
        return
    except Exception as error:
        send_message({"ok": False, "error": str(error)})


if __name__ == "__main__":
    main()
