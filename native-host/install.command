#!/bin/zsh

set -euo pipefail

source_dir="${0:A:h}"
support_dir="$HOME/Library/Application Support/红薯收藏夹"
host_dir="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
host_name="com.rednote.photosaver"
extension_id="doklnnbjpnipnicbiecefbchkhmckcbm"

mkdir -p "$support_dir" "$host_dir"
cp "$source_dir/host.py" "$support_dir/host.py"
chmod +x "$support_dir/host.py"

echo "正在编译实况照片组件…"
/usr/bin/swiftc -O "$source_dir/live-photo-helper.swift" -o "$support_dir/live-photo-helper"
chmod +x "$support_dir/live-photo-helper"

host_path="$support_dir/host.py"
manifest_path="$host_dir/$host_name.json"

cat > "$manifest_path" <<EOF
{
  "name": "$host_name",
  "description": "红薯收藏夹 macOS 照片连接器",
  "path": "$host_path",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://$extension_id/"
  ]
}
EOF

echo ""
echo "照片、GIF 与实况照片连接器安装完成。"
echo ""
echo "接下来："
echo "1. 打开 chrome://extensions"
echo "2. 如果列表里已有旧版“红薯收藏夹”，请先移除，再重新加载项目文件夹"
echo "3. 确认扩展 ID 是 $extension_id"
echo "4. 第一次导入时，在 macOS 弹窗中允许 Chrome 控制“照片”"
echo ""
read -k 1 "?按任意键关闭…"
echo ""
