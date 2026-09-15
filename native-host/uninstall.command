#!/bin/zsh

set -euo pipefail

support_dir="$HOME/Library/Application Support/红薯收藏夹"
manifest_path="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.rednote.photosaver.json"
timestamp="$(date +%Y%m%d-%H%M%S)"

if [[ -f "$manifest_path" ]]; then
  mv "$manifest_path" "$HOME/.Trash/com.rednote.photosaver-$timestamp.json"
fi
if [[ -d "$support_dir" ]]; then
  mv "$support_dir" "$HOME/.Trash/红薯收藏夹-$timestamp"
fi

echo "照片连接器已移到废纸篓。照片图库中的图片不会被删除。"
read -k 1 "?按任意键关闭…"
echo ""
