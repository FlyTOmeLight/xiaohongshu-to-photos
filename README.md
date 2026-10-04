# 红薯收藏夹

**把小红书网页版的原图、GIF 和实况照片，存进 Mac「照片」相簿或本地文件夹。**

[中文](#中文) · [English](#english)

![演示：在小红书笔记页打开扩展，勾选图片，一键导入](docs/demo.gif)

预览、勾选、选择保存位置。默认导入「照片」，可选择目标相簿，也可导出到本地文件夹。导入「照片」后，可经 iCloud 照片同步到其他 Apple 设备。

---

# 中文

## 这是什么

一个 Chrome 扩展 + 本机连接器。在小红书网页版打开一篇图文笔记，扩展会列出页面里的图片，你勾选需要的，它们就被下载并保存到 macOS「照片」或本地文件夹。

它解决的是网页版小红书最麻烦的几件事：

- **拿到的是缩略图，不是原图。** 连接器会剥离 CDN 的缩放、格式转换和水印后缀，回源下载原始上传文件。
- **GIF 被转成了静态图。** 这里按文件真实内容判断格式，GIF 保持动图。
- **实况照片存下来只剩一张封面。** 连接器会同时取回静态帧与短视频，写入相同的 Apple Content Identifier 后作为配对资源导入，「照片」里就是能按下去的实况照片。

没有远程服务器，没有账号，没有遥测。所有处理都在你自己的 Mac 上完成。

## 工作方式

Chrome 扩展不能直接写入 macOS 照片图库，所以走 Chrome 官方的 Native Messaging：

```
扩展弹窗 → 后台任务 → Native Messaging → 本机连接器 → Photos.app / 本地文件夹
```

![架构图：扩展 → Native Messaging → 本机连接器 → Photos.app](docs/architecture.png)

连接器只接受来自本扩展固定 ID 的消息，只允许下载小红书及其图片 CDN 的地址。

| 组件 | 文件 | 职责 |
| --- | --- | --- |
| 扩展界面 | `popup.html` `popup.css` `popup.js` | 列出图片、选择目的地、触发保存 |
| 后台任务 | `background.js` | 保持本机连接，保存任务状态和结果 |
| 内容脚本 | `content.js` | 解析笔记页，提取图片与实况视频地址 |
| 本机连接器 | `native-host/host.py` | 校验地址、回源下载、嗅探格式、导入相簿或导出文件 |
| 实况配对 | `native-host/live-photo-helper.swift` | 为静态帧与 MOV 写入同一 Content Identifier |
| 纯快捷指令版 | `ios-shortcut/` | 不装任何东西，用 iPhone 快捷指令存图 |

## 安装

需要 macOS、Chrome 109+、Python 3。

1. 在 Finder 中打开项目的 `native-host` 文件夹。
2. 右键 `install.command`，选择「打开」，确认运行。
3. 在 Chrome 地址栏打开 `chrome://extensions`。
4. 如果列表里已有旧版「红薯收藏夹」，先移除它。然后点「加载已解压的扩展程序」，选择本项目文件夹。
5. 确认扩展 ID 是 `doklnnbjpnipnicbiecefbchkhmckcbm`。

安装脚本会把连接器复制到 `~/Library/Application Support/红薯收藏夹/`，用 `swiftc` 现场编译实况照片组件，并注册 Native Messaging 清单。

> **升级提示：** 旧版扩展没有固定 ID，仅点刷新可能匹配不上已安装的连接器，所以这次升级需要移除后重新加载。以后更新只需刷新扩展。

首次读取相簿或导入时，macOS 会询问 Chrome 是否可以控制「照片」，选择**允许**。

## 使用

1. 在网页版小红书打开一篇图文笔记，**等待图片加载完成**。
2. 点击工具栏上的「红薯收藏夹」。
3. 勾选需要的图片（默认全选），点「导入 N 张」。

默认保存到「照片」图库。点「读取相簿」后，可选择已有的目标相簿；未指定相簿时，仍直接导入图库。

要保存为文件，将「保存到」切换为「本地文件夹」，点「选择文件夹」，再点「保存 N 张」。每次导出会在所选位置创建以笔记标题开头的独立子文件夹，不覆盖以前保存的文件。普通图片和 GIF 保留文件格式；实况照片保存为同名的图片与 `.mov` 配对文件，例如 `02.jpg` 和 `02.mov`。文件夹本身不会像「照片」一样播放实况。

扩展在工具栏按钮下方显示小弹窗。系统文件夹选择器可能使弹窗关闭；选好后再次点击扩展即可继续，勾选状态和保存位置会保留。保存任务在后台执行，关闭弹窗后仍能完成，再次打开可查看结果。取消文件夹选择不会开始下载。

**从 1.3.0 升级到 1.3.1：** 到 `chrome://extensions` 刷新扩展即可，本机连接器无需重新安装。

**从 1.2.7 或更早版本升级到 1.3.1：** 重新运行 `native-host/install.command`，再到 `chrome://extensions` 刷新扩展。本机连接器也必须更新，才能读取相簿和保存到文件夹。

导入完成后会提示成功张数。如果某张失败，提示里会说明是哪一张、为什么。

**实况照片降级：** 如果某篇笔记没有向网页提供实况视频地址，那张图会作为**静态图**正常导入，并在结果中明确提示「N 张仅保存静态图」。部分旧笔记只返回静态封面，视频部分无法恢复。

单次最多导入 30 张，单张上限 80 MB。

## 权限说明

| 权限 | 用途 |
| --- | --- |
| `activeTab` | 点击扩展时读取当前标签页 |
| `scripting` | 在页面主世界注入读取脚本 |
| `nativeMessaging` | 把选中的图片 URL 交给本机连接器 |
| `storage` | 在当前浏览器会话中保留勾选状态、保存位置和任务结果 |
| `host_permissions` | 仅限 `*.xiaohongshu.com`、`*.xhscdn.com`、`*.xhscdn.net` |

连接器侧另有一层独立的域名白名单校验，扩展被篡改也无法让它去下载别处的文件。

## 常见问题

**提示「尚未安装照片连接器」或 Native host not found**
重新运行 `native-host/install.command`，确认扩展 ID 与上文一致，然后重启 Chrome。

**只找到封面**
先点开笔记详情并滑动图片让内容加载完成，再点弹窗右上角的刷新按钮。

**首次导入失败**
在「系统设置 → 隐私与安全性 → 自动化」中，允许 Chrome 控制「照片」。

**出现重复图片确认**
这是「照片」App 自己的重复检测，选择跳过或导入都可以。

**实况照片变成了静态图**
先重新运行 `native-host/install.command`，再刷新扩展。若仍如此，多半是这篇笔记本身没有向网页返回视频地址。

## 纯快捷指令版（iPhone，无需安装）

不想装 App 也不想用 Mac？`ios-shortcut/` 里有一个纯快捷指令版本：复制小红书笔记链接，运行快捷指令，它能从「标题 + 短链 + 口令」的整段分享文案中提取 URL、跟随 `xhslink.com` 短链跳转、读取公开页面的图片列表，多选后直接存进 iPhone「照片」。

**能力边界：** 只支持普通图片和源页面返回的原始 GIF。实况照片只能保存静态封面——系统 Live Photo 是照片与配对视频组成的资源，纯快捷指令没有把它们配对导入的动作。完整的实况照片保存需要 Mac 端连接器。

安装说明见 [ios-shortcut/README.md](ios-shortcut/README.md)。

## 卸载

运行 `native-host/uninstall.command`。它会把连接器和清单文件移到废纸篓，**不会删除照片图库里的任何图片**。

## 致谢与许可

实现参考了两个 MIT 许可的项目：

- [FlyTOmeLight/x-photo-saver](https://github.com/FlyTOmeLight/x-photo-saver) — Native Messaging 架构、CDN URL 归一化策略、Referer 处理
- [RhetTbull/makelive](https://github.com/RhetTbull/makelive) — Live Photo Content Identifier 方案、ImageIO 与 AVFoundation 用法

完整许可文本见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

---

# English

**Save original photos, GIFs, and Live Photos from the Xiaohongshu (RED) web player into macOS Photos albums or a local folder.**

Preview, tick the ones you want, import. iCloud Photos then syncs them to your iPhone and other Apple devices.

## What it is

A Chrome extension plus a local native-messaging host. Open a Xiaohongshu post in the web player, and the extension lists the images on the page. Tick what you want and they are downloaded into macOS Photos or a local folder.

It fixes the three things that make the web player annoying:

- **You get thumbnails, not originals.** The host strips the CDN's resize, format-conversion, and watermark suffixes, then fetches the original uploaded file.
- **GIFs arrive as stills.** File format is decided by sniffing the actual bytes, so GIFs stay animated.
- **Live Photos lose their motion.** The host downloads both the still frame and the short video, stamps them with the same Apple Content Identifier, and imports them as a paired asset — a real, pressable Live Photo in your library.

No remote server, no account, no telemetry. Everything runs on your own Mac.

## How it works

A Chrome extension cannot write to the macOS photo library directly, so this uses Chrome's official Native Messaging:

```
Extension popup → Background task → Native Messaging → Local connector → Photos.app / Local folder
```

![Architecture: extension → Native Messaging → local connector → Photos.app](docs/architecture.png)

The connector only accepts messages from this extension's fixed ID, and only downloads from Xiaohongshu and its image CDNs.

| Component | Files | Role |
| --- | --- | --- |
| Extension UI | `popup.html` `popup.css` `popup.js` | Lists images, selects a destination, starts saving |
| Background task | `background.js` | Keeps the native connection alive and stores task state and results |
| Content script | `content.js` | Parses the post page, extracts image and Live Photo video URLs |
| Native host | `native-host/host.py` | Validates URLs, downloads originals, sniffs formats, imports to albums or exports files |
| Live Photo pairing | `native-host/live-photo-helper.swift` | Writes one shared Content Identifier into the still and the MOV |
| Shortcuts-only build | `ios-shortcut/` | Save images from an iPhone Shortcut with nothing installed |

## Installation

Requires macOS, Chrome 109+, and Python 3.

1. Open the project's `native-host` folder in Finder.
2. Right-click `install.command`, choose **Open**, and confirm.
3. Open `chrome://extensions` in Chrome.
4. If an older "红薯收藏夹" is already listed, remove it first. Then click **Load unpacked** and select the project folder.
5. Confirm the extension ID is `doklnnbjpnipnicbiecefbchkhmckcbm`.

The installer copies the host to `~/Library/Application Support/红薯收藏夹/`, compiles the Live Photo helper on the spot with `swiftc`, and registers the Native Messaging manifest.

> **Upgrading:** the older extension had no fixed ID, so a plain refresh may not match the installed host. This one upgrade needs a remove-and-reload. Future updates are just a refresh.

When you first load albums or import, macOS asks whether Chrome may control Photos — choose **Allow**.

## Usage

1. Open a post in the Xiaohongshu web player and **wait for the images to finish loading**.
2. Click **红薯收藏夹** in the toolbar.
3. Tick the images you want (all are selected by default) and click **Import N**.

Photos is the default destination. Click **读取相簿** (Load albums) to select an existing album, or leave the album unspecified to import directly into the library.

For local files, choose **本地文件夹** (Local folder), click **选择文件夹** (Choose folder), then **保存 N 张** (Save N). Each export creates a separate subfolder named after the post, so previous exports are never overwritten. Ordinary images and GIFs retain their format. Live Photos are saved as matching image/MOV pairs, such as `02.jpg` and `02.mov`; a folder does not play them as Live Photos.

The extension opens a small popup below its toolbar button. The system folder picker may close the popup; click the extension again after choosing a folder to continue with your selection and destination preserved. Save tasks run in the background and finish even when the popup closes. Reopen it to see the result. Cancelling the folder picker does not start a download.

**Updating from 1.3.0 to 1.3.1:** refresh the extension at `chrome://extensions`. The native host does not need to be reinstalled.

**Updating from 1.2.7 or earlier to 1.3.1:** re-run `native-host/install.command`, then refresh the extension at `chrome://extensions`. The native host must also be updated for album selection and folder exports.

You will be told how many succeeded. If one fails, the message names which one and why.

**Live Photo fallback:** if a post never exposes its Live Photo video URL to the page, the still is imported normally as a static photo and the result explicitly says "N saved as still only". Some older posts only serve a static cover, and the missing video cannot be recovered.

Up to 30 images per import, 80 MB per image.

## Permissions

| Permission | Why |
| --- | --- |
| `activeTab` | Read the current tab when you click the extension |
| `scripting` | Inject the read script into the page's main world |
| `nativeMessaging` | Hand the selected image URLs to the local connector |
| `storage` | Retain image selection, destination, task state and results for the current browser session |
| `host_permissions` | Limited to `*.xiaohongshu.com`, `*.xhscdn.com`, `*.xhscdn.net` |

The host enforces its own independent hostname allowlist, so even a tampered extension cannot make it fetch files from anywhere else.

## Troubleshooting

**"Connector not installed" / Native host not found**
Re-run `native-host/install.command`, confirm the extension ID matches the one above, then restart Chrome.

**Only the cover image is found**
Open the post detail and scroll through the images so the content loads, then click the refresh button at the top right of the popup.

**First import fails**
In System Settings → Privacy & Security → Automation, allow Chrome to control Photos.

**A duplicate-photo prompt appears**
That is Photos' own duplicate detection. Skip or import — either is fine.

**A Live Photo was saved as a still**
Re-run `native-host/install.command` and refresh the extension. If it persists, that post likely never served a video URL to the page.

## Shortcuts-only build (iPhone, nothing to install)

Prefer not to use a Mac? `ios-shortcut/` contains a pure Shortcuts version: copy a Xiaohongshu post link, run the shortcut, and it pulls the URL out of a full share blob ("title + short link + code"), follows the `xhslink.com` redirect, reads the public page's image list, and saves your selection to iPhone Photos.

**Limits:** plain images and original GIFs only. Live Photos save as a static cover — a system Live Photo is a photo plus a paired video, and Shortcuts has no action to import them as a pair. Full Live Photo saving needs the Mac connector.

See [ios-shortcut/README.md](ios-shortcut/README.md) for setup.

## Uninstalling

Run `native-host/uninstall.command`. It moves the connector and its manifest to the Trash and **does not delete anything from your photo library**.

## Credits & License

Modelled on two MIT-licensed projects:

- [FlyTOmeLight/x-photo-saver](https://github.com/FlyTOmeLight/x-photo-saver) — Native Messaging architecture, CDN URL normalization, Referer handling
- [RhetTbull/makelive](https://github.com/RhetTbull/makelive) — Live Photo Content Identifier strategy, ImageIO and AVFoundation usage

Full license texts are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

---

请只保存你有权使用的图片，并尊重作者版权和平台规则。
Please only save images you have the right to use, and respect creators' rights and platform rules.
