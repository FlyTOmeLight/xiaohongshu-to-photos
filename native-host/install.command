#!/bin/zsh
set -euo pipefail

source_dir="${0:A:h}"
if ! python_path="$(command -v python3)"; then
  print -u2 '未找到 Python 3。请安装 Python 3.10 或更新版本，再运行安装程序。'
  exit 1
fi
"$python_path" "$source_dir/install.py"
if [[ -t 0 ]]; then
  read -k 1 '?按任意键关闭…'
  print
fi
