"""Build a tested universal macOS release ZIP from the committed checkout."""
import json
import runpy
import struct
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path


def main():
    root = Path(__file__).resolve().parents[1]
    output = Path(sys.argv[1]).resolve()
    output.mkdir(parents=True, exist_ok=True)
    installer = runpy.run_path(str(root / 'native-host/install.py'))
    version = json.loads((root / 'manifest.json').read_text())['version']
    name = f'xiaohongshu-to-photos-{version}'
    with tempfile.TemporaryDirectory(prefix='rednote-release-') as directory:
        work = Path(directory)
        source_archive = work / 'source.tar'
        subprocess.run(['git', 'archive', '--format=tar', f'--prefix={name}/',
                        '-o', str(source_archive), 'HEAD'], cwd=root, check=True)
        # This archive comes from our own committed tree; tar preserves UTF-8 names and modes.
        with tarfile.open(source_archive) as archive:
            archive.extractall(work)
        source = work / name
        bin_dir = source / 'native-host/bin'
        bin_dir.mkdir()
        slices = []
        for architecture in ('arm64', 'x86_64'):
            binary = work / architecture
            installer['build_helper'](source / 'native-host/live-photo-helper.swift', binary,
                                      f'{architecture}-apple-macosx13.0')
            slices.append(str(binary))
        helper = bin_dir / 'live-photo-helper'
        subprocess.run(['/usr/bin/xcrun', 'lipo', '-create', *slices, '-output', str(helper)], check=True)
        architectures = subprocess.check_output(['/usr/bin/xcrun', 'lipo', str(helper), '-archs'], text=True).split()
        if set(architectures) != {'arm64', 'x86_64'}:
            raise RuntimeError(f'Unexpected helper architectures: {architectures}')
        subprocess.run(['/usr/bin/codesign', '--force', '--sign', '-', str(helper)], check=True)
        subprocess.run(['/usr/bin/codesign', '--verify', '--strict', str(helper)], check=True)
        installer['install'](source / 'native-host', work / 'installed', work / 'manifest.json', Path(sys.executable))
        payload = json.dumps({'action': 'status'}).encode()
        reply = subprocess.run([str(work / 'installed/launch-host')],
                               input=struct.pack('@I', len(payload)) + payload,
                               capture_output=True, check=True, timeout=10).stdout
        if len(reply) < 4 or struct.unpack('@I', reply[:4])[0] != len(reply[4:]) or json.loads(reply[4:]) != {'ok': True, 'protocolVersion': 3}:
            raise RuntimeError('Prebuilt installation failed the protocol check')
        fixture = work / 'fixture'
        installer['build_helper'](source / 'scripts/live-photo-fixture.swift', fixture)
        subprocess.run([str(fixture), str(work)], check=True, timeout=30)
        subprocess.run([str(work / 'installed/live-photo-helper'), str(work / 'image.jpg'), str(work / 'video.mov')], check=True, timeout=45)
        archive = output / f'{name}.zip'
        subprocess.run(['/usr/bin/ditto', '-c', '-k', '--keepParent', '--norsrc', str(source), str(archive)], check=True)
        print(archive)


if __name__ == '__main__':
    main()
