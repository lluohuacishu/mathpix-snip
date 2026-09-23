# Math Snip

基于 Mathpix API 的本地数学识别工作台，支持截图识别、LaTeX 复制、PDF 转换和 Word 导出。

项目采用 Electron + Node.js 构建，提供中文界面，面向 Windows 桌面使用。**这是非官方客户端，与 Mathpix 无隶属关系。** 使用识别和转换功能需要自行配置 Mathpix API 凭据，相关费用由 Mathpix 收取。

## 功能

- **截图识别**：全局快捷键 `Alt + Shift + Q`；选区可移动、缩放，确认后识别。
- **图片导入**：支持拖入、文件选择和剪贴板粘贴，可对照原图校对结果。
- **公式编辑**：预览 Mathpix Markdown（MMD），复制单个公式、全部公式或全文，支持不同 LaTeX 分隔符。
- **Word 导出**：使用 Mathpix 官方转换生成 DOCX，保存后通过默认应用打开。
- **PDF 转换**：可选择 Files API 或 `v3/pdf`，一次任务保存 DOCX、普通 Markdown 和原始 MMD。
- **手写板**：鼠标、触摸或手写笔输入；支持文字框、独立字号、拖动、撤销和草稿保存。
- **用量统计**：查询当前 API 凭据的官方用量，查看分类、日期明细和参考费用。
- **本地历史**：保存识别记录、原始文件和编辑内容，支持搜索、重命名与删除。

## 下载与安装

**[下载最新版 Windows 安装包](https://github.com/lluohuacishu/mathpix-snip/releases/latest)**

在 Releases 页面的 **Assets** 中选择：

| 文件 | 适用方式 |
| --- | --- |
| `Math-Snip-Setup-版本号-x64.exe` | **推荐**。双击安装，可选择安装位置，并创建桌面与开始菜单快捷方式 |
| `Math-Snip-版本号-x64.zip` | 免安装版。完整解压到固定文件夹，再双击 `Math Snip.exe`；不要在压缩包内直接运行 |
| `SHA256SUMS.txt` | 下载文件的 SHA-256 校验值 |

安装包和免安装版均自带运行环境，**无需安装 Node.js、npm 或执行命令**。GitHub 自动提供的 `Source code` 是源代码，不是可直接使用的软件。

当前版本支持 Windows 10 / 11（x64）。发行文件暂未进行代码签名，Windows 可能显示“未知发布者”；请核对下载来源为本仓库的 Releases。

### 首次使用

1. 从桌面或开始菜单打开 **Math Snip**。
2. 在首次引导中点击 **配置 API**，填写自己的 Mathpix App ID 和 App Key；也可以先体验演示。
3. 按 `Alt + Shift + Q` 截图，调整选框后按 `Enter` 识别。

勾选“记住密钥”后，凭据通过 Windows 当前用户加密保存；不勾选则仅保存在本次运行的内存中。每位使用者需要配置自己的 API，软件不附带共享密钥。

关闭主窗口会隐藏到托盘，截图快捷键和后台任务仍可使用。右键托盘图标，选择 **退出 Math Snip** 才会完全退出。

### 更新与卸载

从托盘菜单选择 **下载新版 / 查看版本** 打开 Releases。当前采用手动更新：先从托盘退出，再运行新版安装包；免安装版请将新版本完整解压到新文件夹后启动。

运行数据保存在安装目录之外，同一 Windows 用户下的安装版与免安装版共用数据，正常更新会保留配置和历史。可通过 Windows 的“已安装的应用”卸载安装版；卸载会保留用户数据和导出的文档，便于以后恢复使用。

## 使用要求

- Windows 10 / 11（x64）。
- 可用的 Mathpix API App ID 和 App Key。
- 如需打开 DOCX，请安装支持该格式的应用，例如 Microsoft Word 或 WPS。

识别与官方转换需要网络连接。macOS 和 Linux 暂未提供完整适配，Windows 密钥保存、全局截图及文件打开流程不应视为跨平台功能。

## 使用说明

### 截图与图片识别

1. 按 `Alt + Shift + Q`，拖动鼠标框选区域。
2. 松开后可拖动选区移动，或拖动边缘与四角调整大小。
3. 按 `Enter` 或点击 **识别** 提交；`Esc` 或右键取消。
4. 识别后核对预览和原图，点击公式即可复制 LaTeX，也可在源码区域修改内容。

方向键移动选区，`Shift + 方向键` 加大移动步长。多显示器时截取鼠标所在屏幕；快捷键被占用时会提示。

普通导入或粘贴的图片先保存在本机，点击 **开始识别** 后上传。图片识别默认在后台准备官方 Word，点击 **导出 Word** 保存并打开。

### PDF 转换

点击 **PDF → Word + MD + MMD** 或拖入 PDF，选择接口和页码，然后开始转换。

| 模式 | 官方接口 | 说明 |
| --- | --- | --- |
| 经济模式 | `POST /files/v1` | Files API，适合对等待时间要求较低的转换 |
| 快速模式 | `POST /v3/pdf` | 文档识别接口，适合需要较快获得结果的场景 |

支持页码范围，例如 `1-3,5`。界面显示预估用量和参考费用，并记住最近选择的模式；实际处理时间和收费以官方服务为准。

完成后，在当前用户的 `Documents/Mathsnip` 下创建独立文件夹：

```text
Documents/Mathsnip/
└── 文档名称/
    ├── 文档名称.docx
    ├── 文档名称.md
    ├── 文档名称.mmd
    └── images/          # 含插图时
```

- **DOCX**：Mathpix 官方生成的 Word 文档。
- **MD**：普通 Markdown，配图使用本地相对路径。
- **MMD**：保留官方原始 Mathpix Markdown；其中的 CDN 图片链接保持原样。

同名目录自动增加序号，不覆盖已有文档。单份格式失败时保留其他已成功文件；“继续任务”查询并下载原任务，不自动重新上传或切换接口。已记录任务编号的转换可在下次启动时继续处理。

### Word 导出

所有 Word 转换均使用 Mathpix 官方接口，无需安装 Pandoc。

导出文件默认保存到当前用户的 `Documents/Mathsnip`，随后调用默认应用打开。同名文件自动增加序号。已缓存的相同内容可复用，修改正文后再次导出会创建新的转换任务。

### 手写与文字

在 **手写公式板** 中绘制公式，或点击 **文字** 后选择插入位置。每个文字框可独立调整字号（12–96）、拖动和删除，修改支持撤销。

- 纯手写使用笔迹接口 `/v3/strokes`。
- 文字与笔迹混合时，按画板的实际位置和字号生成图片，通过 `/v3/text` 整体识别。
- 仅输入文字时在本地整理，无需调用 OCR。
- 默认手动识别，可开启停笔后自动识别；自动识别可能产生多次计费请求。

**混合识别仍有局限**：输入文字会再次经过 OCR，汉字和上下标关系可能被误识别，并不保证原文不变。请校对结果；需要精确表达时，可在源码中使用 `U_{\text{真实}}` 等 LaTeX 写法。

### 用量与计费

**API 用量统计** 支持今天、近 7 天、本月及自选日期，统计当前凭据的官方用量，包括其他程序使用同一凭据产生的调用。

日期按 UTC 统计，数据可能存在延迟。界面金额是已知类别的参考估算，不等同于账单；未知或未估价类别不会被视为免费。API 与 Snip 软件订阅是不同服务，请查看 [Mathpix API 价格](https://mathpix.com/pricing/api)。

## 数据与隐私

- 服务仅监听 `127.0.0.1`，用于单用户本机工作流，不作为公网服务部署。
- API Key 由本地服务发送给 Mathpix，不写入前端源码或浏览器草稿。
- 图片、PDF 和手写内容在请求识别时发送到 Mathpix；Word 转换会发送相应 MMD。请求设置 `improve_mathpix: false`，数据保留规则以官方政策为准。
- 安装版与免安装版在 `%APPDATA%\Math Snip` 保存凭据、历史、原始文件和缓存；托盘菜单的 **打开数据目录** 可直达该文件夹。加密凭据文件为 `credentials.safe`，由 Electron 的 Windows 原生加密功能保护。
- 源码运行的数据保存在项目内的 `data/`，凭据文件为 `credentials.dpapi`。源码版与发行版的数据相互独立，从源码版切换到发行版需重新填写 API 凭据。
- 画板草稿保存在桌面应用的浏览器配置中；通过浏览器模式打开时，保存在所用浏览器的本机存储中。
- `work/` 用于开发过程的临时文件，可能包含测试数据或诊断输出。

`.gitignore` 已排除运行数据、环境配置、凭据文件、缓存、日志、临时文件和构建产物。发行构建使用文件白名单，不收录运行数据。分享软件请使用 Releases 中的安装包或 ZIP，分享源码不要打包整个工作目录。`.gitignore` 不会移除已经进入 Git 历史的文件；若密钥曾被提交，应撤销该密钥并清理历史。

## 开发

源码运行需要 Node.js 22 或更高版本及 npm，并将其加入 `PATH`。克隆仓库后，在项目根目录执行：

```sh
npm ci
npm run build
npm run desktop
```

安装依赖时会下载 Electron。前端构建产物 `public/app.js` 不纳入版本控制，首次启动前需要构建；也可在完成构建后双击 `启动工具.cmd`。后台启动使用 `npm run desktop -- --background`。

浏览器模式使用 `npm start`，随后打开 <http://127.0.0.1:47831/>。该模式不注册全局截图快捷键，可使用系统截图后粘贴到页面。

API 凭据也可通过进程环境变量 `MATHPIX_APP_ID`、`MATHPIX_APP_KEY` 提供。已有本机加密配置会在启动时加载；应用不会自动读取 `.env` 文件。

```sh
npm run build          # 构建前端
npm test               # API 与逻辑测试
npm run test:desktop   # Windows 桌面集成测试
npm run test:features  # 手写板与用量界面测试
npm run dist:win       # 生成 Windows x64 安装包和 ZIP
npm run verify:package # 检查发行包的文件白名单
npm run test:packaged  # 验证独立程序、首次引导和加密保存
npm run checksums      # 生成 dist/SHA256SUMS.txt
```

集成测试使用隔离的数据目录和模拟接口。修改 `src/` 后需要重新构建，修改后端或桌面进程代码后需要重启应用。

发行文件输出至 `dist/`。仓库的 **Windows release** 工作流可手动构建并创建 Release 草稿，检查附件后再发布。

### 项目结构

```text
├── desktop/           # Electron 主进程、托盘、快捷键和截图界面
├── lib/               # Mathpix 接口、存储、转换、手写及用量逻辑
├── public/            # 页面、样式和公开静态资源
├── scripts/           # 构建、启动和测试入口
├── src/               # 前端源代码
├── tests/             # 自动化测试
├── server.js          # 本地 HTTP 服务
├── electron-builder.json # Windows 发行构建与文件白名单
├── 启动工具.cmd        # Windows 启动入口
├── package.json
└── package-lock.json
```

### 可选环境变量

| 变量 | 用途 |
| --- | --- |
| `MATHPIX_APP_ID` | API App ID |
| `MATHPIX_APP_KEY` | API App Key |
| `SNIP_DATA_DIR` | 覆盖运行数据目录；建议使用绝对路径。发行版默认 `%APPDATA%\Math Snip`，源码版默认项目内 `data/` |
| `PORT` | 独立浏览器服务端口；默认 `47831` |
| `SNIP_PORT` | 桌面版服务端口；默认 `47831`，发行版在端口被占用时自动选择可用端口 |

## 常见问题

**快捷键没有反应**

确认桌面版仍在托盘中运行，并检查是否被其他应用占用。只启动浏览器服务不会注册全局快捷键。

**提示 Request too large**

图片直传设有 4.90 MB 安全上限。请裁剪到需要的题目区域或拆分图片。程序不会自动压缩原图。PDF 本地导入上限为 100 MiB。

**PDF 进度到了 100%，文件还没生成**

OCR 完成后仍需等待各输出格式转换完成。可保持后台运行，或稍后使用“继续任务”。

**网络中断后能直接重试吗**

已取得任务编号的任务可继续查询；提交后未取得编号时，应先核对官方控制台，避免重复计费。程序不会自动重发结果不确定的提交。

**Word 打开失败**

先检查页面显示的保存路径和 DOCX 默认打开方式。文件已经保存时，可在文件管理器中手动打开。

## 相关资料

- [Mathpix API 文档](https://docs.mathpix.com/)
- [Mathpix Markdown](https://mathpix.com/docs/mathpix-markdown/overview)
- [Files API](https://docs.mathpix.com/guides/files-api-overview)
- [API 控制台](https://console.mathpix.com/)
