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
PY
swiftc -O -module-cache-path "$check_dir/module-cache" native-host/live-photo-helper.swift -o "$check_dir/live-photo-helper"
git diff --check
print '所有检查通过。'
