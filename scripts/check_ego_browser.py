"""Smoke-test the X media DOM and parser through ego-browser."""
from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_URL = "https://x.com/home"
RESULT_PREFIX = "EGO_RESULT="


def main() -> int:
    if shutil.which("ego-browser") is None:
        print("ego-browser smoke test skipped: ego-browser is not installed.")
        return 0

    target = os.environ.get("EGO_X_TEST_URL", DEFAULT_URL)
    parser_source = (ROOT / "note-parser.js").read_text(encoding="utf-8")
    script = f"""
import {{ readFile }} from "node:fs/promises";
const task = await taskSpace("rednote-ego-x-check");
const page = task.page("p1");
const target = {json.dumps(target)};
const parserSource = {json.dumps(parser_source)};
let result;
try {{
  await page.goto(target);
  await page.waitForLoadState("domcontentloaded").catch(() => {{}});
  await page.waitForFunction(
    () => document.readyState !== "loading" &&
      (location.pathname === "/home" || document.querySelectorAll('article[data-testid="tweet"]').length > 0),
    undefined,
    {{ timeout: 15000 }},
  ).catch(() => {{}});
  result = await page.evaluate(({{ parserSource, target }}) => {{
    new Function(parserSource)();
    const host = location.hostname.toLowerCase();
    const isXHost = /(?:^|\\.)(?:x|twitter)\\.com$/.test(host);
    const statusPath = /\\/status(?:es)?\\/\\d+/i.test(location.pathname);
    const statusLinks = [...document.querySelectorAll('article[data-testid="tweet"] a[href*="/status/"]')]
      .map((link) => link.href).filter(Boolean);
    const articles = document.querySelectorAll('article[data-testid="tweet"]').length;
    const images = [...document.querySelectorAll('article[data-testid="tweet"] img')]
      .map((image) => image.currentSrc || image.src).filter(Boolean);
    const videos = [...document.querySelectorAll('article[data-testid="tweet"] video')]
      .map((video) => ({{ src: video.currentSrc || video.src || "", poster: video.poster || "" }}));
    const externalMedia = [...images, ...videos.flatMap((video) => [video.src, video.poster])]
      .filter((url) => /^https?:\\/\\//i.test(url));
    const allowedMedia = externalMedia.every((url) => {{
      try {{
        const mediaHost = new URL(url).hostname.toLowerCase();
        return /(?:^|\\.)(?:pbs|video)\\.twimg\\.com$/.test(mediaHost);
      }} catch {{ return false; }}
    }});
    const pbsImage = images.find((url) => /pbs\\.twimg\\.com\\/media\\//i.test(url));
    const upgraded = pbsImage
      ? globalThis.RednoteParser.tweetImageUrl(pbsImage, location.href, "orig")
      : "";
    const hasOrig = upgraded ? new URL(upgraded).searchParams.get("name") === "orig" : null;
    const targetIsStatus = /\\/status(?:es)?\\/\\d+/i.test(new URL(target).pathname);
    return {{
      target,
      currentUrl: location.href,
      isXHost,
      statusPath,
      targetIsStatus,
      articles,
      statusLinks: statusLinks.slice(0, 5),
      images: images.slice(0, 10),
      videos: videos.slice(0, 10),
      mediaCount: externalMedia.length,
      allowedMedia,
      parserPhotoUpgrade: hasOrig,
      loaded: document.readyState === "complete",
    }};
  }}, {{ parserSource, target }});
  const hasPage = result.isXHost && (!result.targetIsStatus || result.statusPath);
  const hasMedia = result.mediaCount > 0;
  const parserOk = result.parserPhotoUpgrade !== false;
  result.status = hasPage && result.allowedMedia && parserOk
    ? (hasMedia ? "passed" : "skipped")
    : "failed";
}} finally {{
  if (!result) result = {{ status: "failed", error: "no result" }};
  console.log("{RESULT_PREFIX}" + JSON.stringify(result));
  await task.finish({{ keep: [] }});
}}
if (result?.status === "failed") process.exitCode = 1;
"""

    with tempfile.TemporaryDirectory(prefix="rednote-ego-") as directory:
        script_path = Path(directory) / "check.mjs"
        script_path.write_text(script, encoding="utf-8")
        command = ["ego-browser", "nodejs", "-e", f"await import({json.dumps(script_path.as_uri())})"]
        completed = subprocess.run(command, capture_output=True, text=True, check=False)

    output = completed.stdout + completed.stderr
    result_line = next((line for line in output.splitlines() if line.startswith(RESULT_PREFIX)), None)
    if completed.returncode != 0 and result_line is None:
        print(output.strip() or "ego-browser smoke test failed", file=sys.stderr)
        return completed.returncode or 1
    if result_line is None:
        print("ego-browser smoke test did not return a result.", file=sys.stderr)
        print(output.strip(), file=sys.stderr)
        return 1

    result = json.loads(result_line[len(RESULT_PREFIX):])
    status = result.get("status")
    if status == "passed":
        print(f"ego-browser X smoke test passed: {result['mediaCount']} media URL(s) inspected.")
        return 0
    if status == "skipped":
        print("ego-browser X smoke test skipped: no visible media on the selected page.")
        return 0
    print(f"ego-browser X smoke test failed: {json.dumps(result, ensure_ascii=False)}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
