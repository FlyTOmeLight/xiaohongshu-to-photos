"""Prepare and install the connector without modifying a working install on failure."""
import json
import os
import shlex
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HOST_NAME = 'com.rednote.photosaver'
EXTENSION_ID = 'doklnnbjpnipnicbiecefbchkhmckcbm'


def build_helper(source: Path, output: Path) -> None:
    compiler = subprocess.run(['/usr/bin/xcrun', '--sdk', 'macosx', '--find', 'swiftc'],
                              capture_output=True, text=True, check=True).stdout.strip()
    sdk = subprocess.run(['/usr/bin/xcrun', '--sdk', 'macosx', '--show-sdk-path'],
                         capture_output=True, text=True, check=True).stdout.strip()
    subprocess.run([compiler, '-sdk', sdk, '-O', str(source), '-o', str(output)],
                   capture_output=True, text=True, check=True)


def install(source: Path, support: Path, manifest: Path, python: Path) -> None:
    support.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.rednote-install-', dir=support.parent) as work:
        stage = Path(work) / 'connector'
        stage.mkdir()
        shutil.copyfile(source / 'host.py', stage / 'host.py')
        build_helper(source / 'live-photo-helper.swift', stage / 'live-photo-helper')
        (stage / 'live-photo-helper').chmod(0o755)
        launcher = stage / 'launch-host'
        launcher.write_text(f'#!/bin/zsh\nexec {shlex.quote(str(python))} {shlex.quote(str(support / "host.py"))} "$@"\n')
        launcher.chmod(0o755)
        config = {'name': HOST_NAME, 'description': '红薯收藏夹 macOS 照片连接器',
                  'path': str(support / 'launch-host'), 'type': 'stdio',
                  'allowed_origins': [f'chrome-extension://{EXTENSION_ID}/']}
        manifest.parent.mkdir(parents=True, exist_ok=True)
        fd, filename = tempfile.mkstemp(prefix='.rednote-manifest-', dir=manifest.parent)
        pending_manifest = Path(filename)
        backup = Path(work) / 'previous'
        installed = False
        try:
            with os.fdopen(fd, 'w') as file:
                json.dump(config, file, ensure_ascii=False, indent=2)
            if support.exists():
                os.replace(support, backup)
            os.replace(stage, support)
            installed = True
            os.replace(pending_manifest, manifest)
        except Exception:
            if installed:
                shutil.rmtree(support)
            if backup.exists():
                os.replace(backup, support)
            raise
        finally:
            pending_manifest.unlink(missing_ok=True)


def main() -> None:
    try:
        if sys.version_info < (3, 10):
            raise RuntimeError('需要 Python 3.10 或更新版本。可通过 Homebrew 运行 brew install python。')
        tools = subprocess.run(['/usr/bin/xcode-select', '-p'], capture_output=True, text=True)
        if tools.returncode:
            raise RuntimeError('缺少 Apple 命令行开发工具。请运行 xcode-select --install，安装后重试。')
        support = Path.home() / 'Library/Application Support/红薯收藏夹'
        manifest = Path.home() / f'Library/Application Support/Google/Chrome/NativeMessagingHosts/{HOST_NAME}.json'
        print('正在编译并安装实况照片连接器…', flush=True)
        install(Path(__file__).parent, support, manifest, Path(sys.executable))
    except (OSError, RuntimeError, subprocess.CalledProcessError) as error:
        detail = error.stderr if isinstance(error, subprocess.CalledProcessError) else str(error)
        print(f'安装失败：{detail or error}', file=sys.stderr)
        sys.exit(1)
    print(f'连接器安装完成。扩展 ID：{EXTENSION_ID}')
    print('首次安装：在 chrome://extensions 开启开发者模式，加载项目文件夹。')
    print('更新已有扩展：在 chrome://extensions 点击刷新，无需移除扩展。')
    print('首次读取相簿或导入时，允许 Chrome 控制“照片”。')


if __name__ == '__main__':
    main()
