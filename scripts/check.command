#!/bin/zsh
set -euo pipefail
cd "${0:A:h:h}"

check_dir="$(mktemp -d "${TMPDIR:-/tmp}/rednote-check.XXXXXX")"
trap 'rm -rf "$check_dir"' EXIT

node --test test_extension.cjs test_content.cjs
python3 -B -m unittest discover -s native-host -p 'test_*.py' -v
for source_file in background.js popup.js content.js note-parser.js; do
  node --check "$source_file"
done
zsh -n native-host/install.command native-host/uninstall.command scripts/check.command
python3 -B - "$check_dir" <<'PY'
import ast
import json
import struct
import runpy
import subprocess
import sys
from pathlib import Path

for folder in ('native-host', 'ios-shortcut'):
    for source in Path(folder).glob('*.py'):
        ast.parse(source.read_text(), filename=str(source), feature_version=(3, 10))
scripts = runpy.run_path('native-host/host.py')
for name in ('IMPORT_SCRIPT', 'ALBUMS_SCRIPT', 'FOLDER_SCRIPT'):
    source = Path(sys.argv[1]) / f'{name}.applescript'
    source.write_text(scripts[name])
    subprocess.run(['/usr/bin/osacompile', '-o', str(source.with_suffix('.scpt')), str(source)], check=True)
# Exercise the real installation path, including the selected compiler and SDK.
installer = runpy.run_path('native-host/install.py')
work = Path(sys.argv[1])
manifest = work / 'hosts/com.rednote.photosaver.json'
installer['install'](Path('native-host'), work / 'connector', manifest, Path(sys.executable))
payload = json.dumps({'action': 'status'}).encode()
config = json.loads(manifest.read_text())
response = subprocess.run([config['path']], input=struct.pack('@I', len(payload)) + payload,
                          capture_output=True, check=True, timeout=10).stdout
if len(response) < 4 or struct.unpack('@I', response[:4])[0] != len(response[4:]):
    raise RuntimeError('Installed connector returned an invalid native frame')
if json.loads(response[4:]) != {'ok': True, 'protocolVersion': 2}:
    raise RuntimeError('Installed connector returned an unexpected protocol version')
PY
git diff --check
print '所有检查通过。'
