# 开发与维护笔记

面向要改这个插件的人。**使用说明请看 [README.md](README.md)。**

## 目录结构

```
ComfyUI-QG-tools/
├── __init__.py                        # 只汇总 nodes/ 下所有模块的映射，不写节点逻辑
├── PORTED.json                        # 搬运清单（机器可读）：每个文件从哪来、改了什么
├── README.md                          # 面向使用者
├── DEVELOPMENT.md                      # 本文件
├── LICENSE                            # GPL-3.0-or-later 全文
├── pyproject.toml                     # ComfyUI Registry 元数据（Manager 一键安装靠它）
├── requirements.txt                   # 无第三方依赖（ComfyUI Manager 会读）
├── .gitignore
├── .gitattributes                     # 行尾统一 LF
├── .github/
│   └── workflows/
│       └── publish_action.yml         # 改 version 并推送到 main 即自动发布到 Registry
├── licenses/
│   └── ComfyUI-AusBoss-LICENSE.txt    # 被搬运代码的原许可证（MIT，必须保留）
├── nodes/
│   ├── __init__.py                    # 占位，不要在这里写节点
│   ├── _qg_lora_helpers.py            # 被引用，不注册节点（下划线开头 = 不扫）
│   ├── qg_lora_loader.py              # 注册 QG_LoraLoader
│   ├── qg_workflow_note.py            # 注册 QG_WorkflowNote（纯前端节点，无依赖）
│   └── qg_workflow_switches.py        # 注册 QG_WorkflowSwitches（纯前端节点，无依赖）
└── web/                               # WEB_DIRECTORY
    ├── qg_init.js                     # 本插件自己的前端入口
    ├── lora_loader/index.js           # LoRA Loader 的界面（= 一个 ComfyUI 前端扩展）
    ├── workflow_note/index.js         # 工作流说明卡界面
    ├── workflow_switches/index.js     # 工作流开关界面
    └── shared/*.mjs                   # 被上面 import 的共享模块（.mjs = 不会被当扩展加载）
```

`web/shared/` 里有两类模块：本插件节点自己抽出来的（`lora_stack`、`widget_card`、`panel_layout`…），
以及被它们串起来带进来的通用工具（`transform_geometry`、`media_picker`、`pad_canvas`…）。
后一类当前没有节点直接用，但**别删** —— 删了会让 `widget_card.mjs` 的 import 断链。

## 命名约定

本插件所有节点统一：

- **节点 ID**：`QG_` 前缀
- **显示名**：`QG ` 前缀
- **分类**：`QG-tools`（再多就 `QG-tools/子分类`）
- **前端扩展注册名**：`QG.<NodeName>`
- **后端路由**：`/qg/<功能>/...`
- **私有 CSS 类名 / style 元素 id**：`qgtools-` 前缀

## 怎么加节点

1. 在 `nodes/` 下新建一个 `.py`，文件名 `qg_<节点名>.py`；被引用的 helper 用 `_` 开头。
2. 模块里导出两个字典：

```python
NODE_CLASS_MAPPINGS = {"QG_MyNode": QGMyNode}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_MyNode": "QG 我的节点"}
```

3. 节点类里写 `CATEGORY = "QG-tools"`，菜单里就会归到 QG-tools 下面。
4. 重启 ComfyUI。`__init__.py` 会自动扫描 `nodes/`，无需手工注册。

## 硬性约定（踩过的坑）

- **只用相对导入**。`from ._helper import x` ✅，`import helper` ❌ —— 后者会让整个插件
  静默 `IMPORT FAILED`，traceback 只在 `ComfyUI/user/comfyui_<端口>.log` 里。
- `nodes/` 下 **`_` 开头的文件不会被扫描注册**，专门用来放 helper。
- 不要 `node.widgets.splice()` 删控件，会打乱 `widgets_values` 索引，旧工作流参数错位；
  要隐藏就用 `w.type="hidden"; w.hidden=true; w.computeSize=()=>[0,-4]`。
- **引用 ComfyUI 内置脚本一律用绝对路径** `/scripts/app.js`。
  `web/` 是**按原目录树**挂到 `/extensions/ComfyUI-QG-tools/` 下的，不是拍平：
  `web/qg_init.js` 和 `web/lora_loader/index.js` 的层级深度不同，
  相对路径 `../../scripts/app.js` 只在根目录那层成立，换个层级就错。
- **`dataset` 名和属性选择器必须同步改**。`el.dataset.qgFull = x` 生成的 HTML 属性是
  `data-qg-full`；代码里若还有 `querySelector('[data-ausboss-full]')` 就永远匹配不到
  （改名的第一次尝试就踩了这个坑，靠改名脚本的「命中计数校验」抓出来）。
- **批量改名一律用带「命中计数断言」的脚本**，别用裸 `sed`。
- 备份 / 临时文件**不要放进插件目录内被扫描的子目录**（如 `web/`），否则外部 `grep -r` 会连备份一起数进去。
- **改了 `web/shared/*.mjs` 必须跑 `tools/bump_module_versions.py <新版本串> --apply`（工作区脚本）**。
  原因：ComfyUI 只给**扩展入口文件**（`web/<node>/index.js`、`web/qg_init.js`，
  即 `WEB_DIRECTORY` 注册的那几个）加 `Cache-Control: no-store`；被它们 `import`
  间接加载的 `shared/*.mjs` 走静态文件默认处理，**没有任何缓存头**，浏览器于是
  启发式长期缓存且不校验 —— 于是入口是新的、子模块还是旧的，用户 `Ctrl+Shift+R`
  也刷不掉（缓存的键是子模块 URL）。脚本给所有本地 import 说明符加上
  `?v=<版本串>`：入口每次都是 no-store 新内容 → 子模块 URL 随版本变化 → 旧缓存自然失效，
  用户普通刷新即可生效。**每次改了 shared 模块都要换一个新版本串**（建议用
  `YYYYMMDDNN`），否则 URL 不变等于没打。
- 前端 JS 改动后浏览器要 `Ctrl+Shift+R` 强刷（带版本串的模块改动只需普通刷新）。
- **面板上的文案：静态串进字典，拼接串/后写的 `title`/画布文字必须走 `zh()`。**
  汉化插件只整串全等匹配、且不监听属性变化，细节与纪律见下方「汉化深度清理」。
- **前端绝不在页面加载时调用 ComfyUI-Manager 的接口；非要用必须带 `skip_update=true`**。
  原理：`/customnode/getlist`（不带 `skip_update`）会让 Manager 顺路对每个 git 插件跑
  git 更新检查，被判「有更新」的插件（本机 detached HEAD 的都算）会被追加一条
  `#LAZY-INSTALL-SCRIPT` 到 `ComfyUI/user/__manager/startup-scripts/install-scripts.txt`，
  **下次启动 ComfyUI 就会 `os.execv` 自动重启一次**（KK 启动器显示 `PID: --`）。
  v0.4.0 的 `workflow_note/index.js` 曾在页面加载 2 秒后自动预热这个接口 ——
  等于每打开一次页面就替用户点一次「检查更新」，每次启动都被重启（v0.5.0 修复：
  URL 加 `&skip_update=true` + 删掉页面加载预热，只在打开卡片编辑器 / 点 Detect 时懒加载）。
  实测：带 `skip_update=true` 后 22.9 s → 2.6 s，返回的 `node_packs`/`reference`/`files` 照旧，
  队列不再被写。验证脚本：工作区 `tools/verify_no_queue_on_load.py`（含阳性对照）。
- 🔴 **`INPUT_TYPES()` 里返回文件列表的，必须每次现取，绝不能在 import 时缓存。**
  ComfyUI 每次请求 `/object_info`（页面加载、按 **R** 刷新、加节点）都会重新调用
  `INPUT_TYPES()`；官方加载器（`UNETLoader` 等）内部每次现扫 `folder_paths`，所以官方节点刷新正常。
  把 `INPUT_TYPES()` 的结果存进模块级变量 = 把列表冻结到下次进程重启。
  v0.8.2 的 `QG_TripleLoader` 正是如此：`_unet_files` / `_clip_files` 两个 lambda 返回的是
  import 时捕获的旧列表（VAE 那个反而是每次重读，属于实现不一致导致的局部冻结），
  结果新下载的模型**只有重启 ComfyUI 才出现在下拉里**。现在三个 getter 统一每次重读。
  - 反之，`weight_dtype` / `clip_type` / `device` 这类**写死在加载器代码里的静态选项**
    不依赖文件系统，import 时读一次即可（代码里已注明，别再"顺手改成每次读"）。
  - 开销可忽略：`INPUT_TYPES()` 只在 `/object_info` 被调用，不在执行热路径；
    且 `folder_paths.get_filename_list` 有 mtime 缓存，目录没变时只是一次 `os.path.getmtime` 比对。
  - 新增带文件下拉的节点（LoRA、ControlNet、upscale 模型…）同样适用：
    直接调 `folder_paths.get_filename_list(...)` 或复用对应官方 loader 的 `INPUT_TYPES()`，别提前快照。
  - 回归测试：工作区 `tools/test_triple_fresh.py`（桩件，对旧代码会失败，可作阳性对照）；
    真机 `tools/run_8199_triple_refresh.py`（与官方节点逐槽对条数 + 丢临时模型文件看是否跟上）。
- 节点 ID 若与已有插件冲突，`__init__.py` 会保留先加载的并在控制台点名，不会静默覆盖。
- 验证 ComfyUI 前**先确认端口上的进程是谁**（用户可能正开着 8188），验证用 `--port 8199` 起独立实例。

## 后端路由

`list` / `thumb` / `info` / `hash` / `civitai`(POST) / `triggers`(POST)，全部挂在 `/qg/lora/` 下。

## 抽取来源

| 来源插件 | 抽取的节点 | 当前 ID | 说明 |
|---|---|---|---|
| ComfyUI-AusBoss v2.10.1（MIT） | LoRA Loader | `QG_LoraLoader` | 见下方「LoRA Loader 搬家记录」 |
| ComfyUI-AusBoss v2.10.1（MIT） | Workflow Note | `QG_WorkflowNote` | 见「说明卡 / 开关 搬家记录」 |
| ComfyUI-AusBoss v2.10.1（MIT） | Workflow Switches | `QG_WorkflowSwitches` | 同上 |

搬运与改名用的是一批开发期脚本（`port_node.py` 抽节点、`rename_to_qg.py` 统一命名、
`rename_css_prefix.py` 改 CSS 前缀），**不随本仓库分发** —— 它们是按当时那个版本的
AusBoss 源码硬编码路径写的，通用性有限。下面「搬家记录」保留了每一步的完整映射表，
照着表可以逐步复现，不需要那些脚本。

## LoRA Loader 搬家记录

前端 1915 行 + 后端 752 行，是本包里前端最重的节点之一。分三个阶段。

### 阶段 1：从 AusBoss 抽出来

| 改动 | 从 | 到 | 原因 |
|---|---|---|---|
| aiohttp 路由 | `/ausboss/lora/*`（6 条） | `/qg/lora/*` | 不跟原插件抢同一批路径，两边可共存 |
| 路由幂等标志 | `_ausboss_lora_routes` | `_qg_lora_routes` | 同上（共用标志会导致谁都不注册） |
| Python 相对导入 | `._lora_helpers` | `._ausboss_lora_helpers` | helper 加来源前缀防重名 |

前端只搬了 import 闭包里的 11 个文件（1 个入口 + 10 个 `shared/*.mjs`），
其余的全局 UI 层（`chrome`/`appearance`/`notify`…）**故意没搬**，避免和原插件抢 UI 钩子。

### 阶段 2：统一 QG 命名（v0.3.0）

| 改动 | 从 | 到 |
|---|---|---|
| 节点 ID | `AUSBOSS_NODES_LoraLoader` | `QG_LoraLoader` |
| 显示名 | `LoRA Loader 🆎` | `QG LoRA Loader` |
| 分类 | `🆎 AusBoss/Loaders` | `QG-tools` |
| Python 类名 | `AusBossLoraLoader` | `QGLoraLoader` |
| 节点文件名 | `nodes/ausboss_lora_loader.py` | `nodes/qg_lora_loader.py` |
| helper 文件名 | `nodes/_ausboss_lora_helpers.py` | `nodes/_qg_lora_helpers.py` |
| 路由处理函数 | `ausboss_lora_*`（6 个） | `qg_lora_*` |
| 日志前缀 | `[AusBoss] LoRA Loader:` | `[QG-tools] LoRA Loader:` |
| toast 默认标题 | `AusBoss` | `QG-tools` |
| 前端扩展注册名 | `AusBoss.LoraLoader` | `QG.LoraLoader` |
| 模板存储键 | `AusBoss.lora_loader.templates` | `QG.lora_loader.templates` |
| 节点设置存储键 | `ausboss.settings.<scope>` | `qg.settings.<scope>` |
| DOM widget 名 | `ausboss_lora_rows` | `qg_lora_rows` |
| 节点属性（进工作流 JSON） | `properties.ausbossLoraLinked` | `properties.qgLoraLinked` |
| dataset 名 + 属性选择器 | `ausbossFull` / `[data-ausboss-full]` | `qgFull` / `[data-qg-full]` |
| 自家节点判定前缀 | `comfyClass.startsWith("AUSBOSS_NODES_")` | `startsWith("QG_")` |
| 用户数据目录 | `<ComfyUI>/user/ausboss/` | `<ComfyUI>/user/QG-tools/` |
| 插件版本 | 0.2.0 | 0.3.0 |

### 阶段 3：CSS 类名统一前缀 `qgtools-`（同属 v0.3.0）

阶段 2 曾把 CSS 类名故意留着不动，唯一顾虑是 `web/shared/canvas_passthrough.mjs` 靠
`className.includes("ausboss-")` 认自家面板。阶段 3 把这 278 处一次性改成 `qgtools-`
前缀（`qg-` 太短，容易误匹配别的插件的元素），并同步更新那处 `includes(...)` 判定。

| 改动 | 从 | 到 | 命中 |
|---|---|---|---|
| LoRA Loader 面板类名 / style id | `ausboss-lora-*` / `ausboss-lora-styles` | `qgtools-lora-*` / `qgtools-lora-styles` | 169 |
| 节点设置菜单类名 / style id | `ausboss-set-*` / `ausboss-settings-css` | `qgtools-set-*` / `qgtools-settings-css` | 87 |
| 数值拖拽输入类名 / style id | `ausboss-scrub*` / `ausboss-scrub-css` | `qgtools-scrub*` / `qgtools-scrub-css` | 19 |
| 自家面板判定 | `className.includes("ausboss-")` | `className.includes("qgtools-")` | 3 |

改名脚本带「命中文件集合 + 逐文件命中数」全量断言（沿用阶段 2「漏了 `[data-ausboss-full]`
选择器」的教训）。改名后 `web/` 下 `ausboss-` 归零、`qgtools-` 共 278 处，
12 个前端文件 `node --check` 全过；真机（8199）复验：节点 / 6 条路由 / 静态资源全部正常。

### 仍然故意保留不动的

- `AUSBOSS_LAB_LoraLoader`：**它不是本插件的节点 ID，而是我们要去「识别」的对方节点名**。
  这是 AusBoss 作者 LAB 系列插件（本机未安装）注册的 ID —— AusBoss 主插件 42 个节点全是
  `AUSBOSS_NODES_*`，不含它。`web/shared/lora_stack.mjs` 的 `loaderLoraEntries()`
  用它做类型匹配：「吸收模型链上的 LoRA Loader」沿模型链上下游走，靠一串
  `if (type === ...)` 逐节点认领（这串清单里还认 rgthree / JPS / Pixaroma 等，
  全是**别人注册的名字**）。
  ComfyUI 的节点 type 是**由对方插件自己决定的全局键**，我们改这里不会让别人的节点跟着改名，
  只会让这条分支永远进不去 → 链上遇到该节点时函数返回 `null`，注释明写 caller 会就此
  **停止走链，整条链的吸收静默中断**。何况同一分支前半段已用 `QG_LoraLoader` 认自家节点，
  所以保留它属于「兼容别人」，不是「漏改」。
- `licenses/ComfyUI-AusBoss-LICENSE.txt`：MIT 许可证要求保留。

**改名带来的后果**：节点 ID 变了，含 `AUSBOSS_NODES_LoraLoader` 的工作流需要重新放一次节点。

## 说明卡 / 开关 搬家记录（v0.4.0）

节点 #41 `AUSBOSS_NODES_WorkflowNote`、#42 `AUSBOSS_NODES_WorkflowSwitches`。

两个都是**纯前端节点**：Python 侧只有一个空壳类（无输入无输出、不进提示词，只负责在菜单里出现，
并给 Registry / Manager 提供识别用的注册键），全部逻辑在 `web/<节点>/index.js` 与其共享模块里。

### 搬了什么

| Python | 说明 |
|---|---|
| `nodes/node_workflow_note.py` → `nodes/qg_workflow_note.py` | 类名 `AusBossWorkflowNote` → `QGWorkflowNote` |
| `nodes/node_workflow_switches.py` → `nodes/qg_workflow_switches.py` | 类名 `AusBossWorkflowSwitches` → `QGWorkflowSwitches` |

前端从两个入口算 import 闭包共 **19 个文件**，其中 7 个（`index`、`canvas_passthrough`、`lora_stack`、
`panel_layout`、`scrub_input`、`widget_card_math`、`widget_visibility`）早在 v0.3.0 就搬过，
**跳过不覆盖**；本次新增 12 个：`appearance`、`clipboard`、`discard_prompt`、`media_list`、
`media_picker`、`pad_canvas`、`transform_geometry`、`widget_card`、`workflow_note`、`workflow_switches`
+ 两个 `index.js`。

### 改名规则（共 460 处，全部带命中计数断言）

| 类别 | 从 | 到 |
|---|---|---|
| 节点 ID | `AUSBOSS_NODES_WorkflowNote` / `...WorkflowSwitches` | `QG_WorkflowNote` / `QG_WorkflowSwitches` |
| 引用自家 LoRA 加载器 | `AUSBOSS_NODES_LoraLoader` | `QG_LoraLoader` |
| 扩展注册名 | `AusBoss.WorkflowNote` / `AusBoss.WorkflowSwitches` | `QG.WorkflowNote` / `QG.WorkflowSwitches` |
| 共享 API 符号 | `notifyAusbossChange` / `isAusbossNode` | `notifyQgChange` / `isQgNode`（必须与 v0.3.0 的 `shared/index.mjs` 对齐） |
| 私有 CSS 类名 / style id | `ausboss-note-*`、`ausboss-ws-*`、`ausboss-card-*`、`ausboss-media-*`、`ausboss-discard-*` | 同前缀换 `qgtools-` |
| DOM widget 名 / 节点私有属性 | `ausboss_workflow_note_panel`、`__ausbossNote`、`__ausbossWorkflowSwitches`、`ausboss_show_edit` … | `qg_*` |
| 节点设置属性键 | `ausboss_workflow_switches` | `qg_workflow_switches` |
| 颜色方案里的旗舰行 | `{ name: "AusBoss" }` | `{ name: "QG-tools" }` |

### 故意保留的两类字符串

- **上游署名链接**：`https://github.com/ausboss/ComfyUI-AusBoss`（卡片默认链接行 / 节点包行的默认 URL）。
  路径里的 `ausboss` 是别人的 GitHub 账号，改了就成了死链。
  脚本用「保护占位符 → 改名 → 还原」三步确保不被波及。
- **`AUSBOSS_LAB_LoraLoader`**：同 LoRA Loader 那节的理由（那是「认别人」，不是「我们的名字」）。
  本批文件里出现次数为 0，写进保护名单只是防止将来误改。

### 校验

- `tools/verify_port.py`：①`web/`+`nodes/` 里 `ausboss` 残留归零（白名单除外）；
  ②196 条具名 import 全部能在目标模块里找到对应 export（含 `export *` 递归跟随）；
  ③`NODE_CLASS` 常量与 Python 注册表一致；④`CATEGORY` 都在 `QG-tools` 下。
- `tools/js_check.py`：24 个前端文件 `node --check` 全过。

### 中文文案

`locales/zh/nodeDefs.json`（官方格式，3 个节点）+ 汉化插件里的 `ui` 字典
（`QG_WorkflowNote` 49 条、`QG_WorkflowSwitches` 47 条）。写 `ui` 字典时必须**逐条断言**
英文键在原 JS 里真实存在 —— 汉化插件是拿英文原文去匹配 DOM 文本的，键写错了不会报错，
只会静默不生效。

## Image Crop + Rotate + Pad 搬家记录（v0.5.0）

节点 #10 `AUSBOSS_NODES_ImageCropRotatePad`（"Image Crop + Rotate + Pad"）——
本包第一个**重型图像节点**：Python 闭包 10 个文件，前端闭包 29 个文件（新增 16 个）。

### ⚠️ 版本错位（与前三批不同）

前三批（v0.3.0 / v0.4.0）的源是 AusBoss **2.10.1**，这一批本机装的已经是 **2.11.1**。
所以 `web/shared/` 里的旧副本（2.10.1 时代搬过来、改过名、补过汉化）与新引入的文件
**不是同一个版本**。处理原则：

- 已存在的 shared 模块**一律不覆盖**（保 v0.4.0 的改名与汉化成果），先核对新文件
  从旧模块里 import 的每个符号是否存在——实测只差 `transform_geometry.mjs` 的
  `axisLayout` / `keptCrop` / `alignChanges`。
- 该文件是纯几何、没有汉化改动，且 2.11.1 的 `resolvePadding` 改成按
  `_pad_helpers._axis_layout` 的语义补齐/裁切（旧版只在远端多补一截）。
  面板预览要和 Python 输出对得上，就必须整份换成 2.11.1 —— 逐行反向归一核对过，
  差异只有这几个新函数，所以**整份覆盖**是安全的（脚本里 `OVERWRITE` 白名单）。

### 搬了什么

Python（全部 `_qg_` 前缀，与 `_qg_lora_helpers.py` 一致）：

| 源 | 目标 |
|---|---|
| `nodes/node_image_crop_rotate_pad.py` | `nodes/qg_image_crop_rotate_pad.py` |
| `nodes/_inpaint_crop_helpers.py` | `nodes/_qg_inpaint_crop_helpers.py` |
| `nodes/_media_helpers.py` | `nodes/_qg_media_helpers.py` |
| `nodes/_media_upload.py` | `nodes/_qg_media_upload.py` |
| `nodes/_transform_engine.py` | `nodes/_qg_transform_engine.py` |
| `nodes/_transform_inputs.py` | `nodes/_qg_transform_inputs.py` |
| `nodes/_pad_helpers.py` | `nodes/_qg_pad_helpers.py` |
| `nodes/_mask_helpers.py` | `nodes/_qg_mask_helpers.py` |
| `nodes/_color_helpers.py` | `nodes/_qg_color_helpers.py` |
| `nodes/_execution_helpers.py` | `nodes/_qg_execution_helpers.py` |
| `ausboss_presets_example.json`（仓库根） | `qg_presets_example.json`（插件根） |

前端新增 16 个：`image_crop_rotate_pad/index.js`、`widget_kv/index.js`、
`load_video/trim_preview.mjs`，以及 `shared/` 下的 `transform_editor`、`transform_trim`、
`transform_geometry`（覆盖）、`widget_kv`、`wired_limits`、`core_preview`、`video_preview`、
`video_source_card`、`stitch_preview`、`timeline_math`、`timecode`、`fill_color`、`clip_rate`。
另有 13 个 shared 模块已在 v0.3.0/v0.4.0 搬过，跳过不覆盖。

`transform_editor.mjs` 一个文件就 167 KB —— 它是图像/视频两类节点共用的旋转裁切补边编辑器，
所以顺带把视频预览那一支（`trim_preview`/`timeline_math`/`video_preview`/`stitch_preview`）也带进来了。
整批前端约 400 KB。

### 改名规则（共 505 处，全部带命中计数断言）

| 类别 | 从 | 到 |
|---|---|---|
| 节点 ID | `AUSBOSS_NODES_ImageCropRotatePad` | `QG_ImageCropRotatePad` |
| Python 类名 | `AusBossImageCropRotatePad` | `QGImageCropRotatePad` |
| 分类 | `🆎 AusBoss/Image` | `QG-tools/Image` |
| 显示名 | `Image Crop + Rotate + Pad 🆎` | `QG Image Crop + Rotate + Pad` |
| 前端扩展注册名 | `ausboss.transform.<节点ID>` | `QG.transform.<节点ID>` |
| | `ausboss.widget_kv` | `QG.widget_kv` |
| **后端路由** | `/ausboss/transform/video/*`（4 条）、`/ausboss/pack_version` | `/qg/transform/video/*`、`/qg/pack_version` |
| 路由幂等标志 | `_ausboss_transform_routes` | `_qg_transform_routes` |
| 响应头 | `X-AusBoss-Frame-Index/Time` | `X-QG-Frame-Index/Time` |
| 预设文件 | `ausboss_presets.json` | `qg_presets.json` |
| 私有 CSS 类 / style id | `ausboss-*`（256+62+…处） | `qgtools-*` |
| widget 名 / 节点属性 / 内部标识符 | `ausboss_*`、`__ausbossTransformState`、`notifyAusbossChange`… | `qg_*`、`__qgTransformState`、`notifyQgChange`… |

**路由必须改名**：`_media_helpers.py` 的 `register_video_routes()` 是模块级注册，
如果沿用 `/ausboss/...`，会和 AusBoss 自己的注册撞车 —— aiohttp 对同路径同方法的
重复注册是直接抛 `RuntimeError`，两个插件会一起加载失败。

### 两处刻意的改动（不是纯改名）

1. `register_video_routes()` 的调用点：源插件里由两个**视频**节点调用；我们只搬了图像节点，
   就把这个调用挪到 `qg_image_crop_rotate_pad.py` 末尾 —— 面板的「来源」框能载入视频，
   需要这几条路由（图片走核心 `/upload/image`，用不到它们）。
2. `web/widget_kv/index.js` 的 `NODE_TYPES` 集合：原本列了 6 个 AusBoss 节点 ID，
   收窄成只剩 `QG_ImageCropRotatePad` —— AusBoss 自带的 `widget_kv` 扩展已经在管它自己的
   那些节点，两边都接管会重复序列化 / 恢复同一份 `widgets_values`。

### 故意保留的三类字符串

- `AUSBOSS_STITCHER`（socket 类型）与 `ausboss_inpaint_stitcher`（stitcher 里的 `kind` 字段）：
  **跨插件数据契约**，要能接 AusBoss 的 Stitch Inpaint 把结果贴回原图。
  改了这两个字符串，本节点就成了孤岛。
- `AUSBOSS_NODES_Float` / `AUSBOSS_NODES_Integer`：`clip_rate.mjs` 靠它们认 AusBoss 的
  字面量节点（本插件没搬），留着在装了 AusBoss 的机器上仍能识别。
- 上游署名 URL 与 `ComfyUI-AusBoss` 字样（文件头出处注释）。

### 校验

- `tools/port_node_10.py`：改名 + `--apply` 落盘，带逐条命中数与整批总量断言，残留归零。
- `tools/verify_port.py`：残留 / 329 条具名 import 对齐 / 注册一致性 / CATEGORY。
- `tools/js_check.py`：40 个前端文件 `node --check` 全过。
- `tools/import_check_10.py`（新增，用 ComfyUI 自己的解释器跑）：
  走 `import nodes` → 构造 `PromptServer` → 载入本插件的真实路径，断言 4 个节点已注册、
  接口是 14 必 + 7 选、`AUSBOSS_STITCHER` 仍在输出里、5 条 `/qg/` 路由进了注册表、
  并且 `add_routes()` 能干净合并（撞车会在这里抛错）。
  比 `main.py --quick-test-for-ci` 快得多，也不受 ComfyUI-Manager 预启动重启干扰。

### 中文文案

`locales/zh/nodeDefs.json` 增加第 4 个节点；汉化插件 `ui` 字典增加 `QG_ImageCropRotatePad`
条目。新增词条同样逐条断言英文键在源码里存在。

真机（headless Chrome + CDP）第一轮就露出马脚：面板里 `Source` / `pick a ratio first` /
`Feather` / `Center` / `Megapixels` / `Step` / `off` / `on` / `crop` / `pad` 还是英文。
根因是**扫描工具的系统性盲区**——这三类位置 `scan_en_strings_v2.py` 都不认：

1. `createElement(tag, cls, "文本")` 第 3 参、`addScrubField(区, "标签", …)` 第 2 参
   （`scan_en_strings_v3.py` 专门扫这两类）；
2. **纯小写字符串**会被「选择器」噪音过滤规则（`^[#.a-z0-9_\-\s...]+$`）整个吃掉，
   `off` / `on` / `crop` / `pad` / `pick a ratio first` 全栽在这儿；
3. 模板字面量拼出来的整串（`${kind === "video" ? "Video" : "Image"} Crop + Rotate + Pad`）
   源码里没有整串字面量，要按「拼接后的运行时串」入字典，断言时改查拼接位。

`tools/add_ui_entries_10.py` 补了 29 条（ui 128 → 157），逐条断言后在真机复验，面板
DOM 文本里除单位（`px` / `MP`）和比例（`1:1` / `4:3`…）外已无英文。
`tools/scan_en_strings_v4.py` 是宽口径版（所有字面量都提出来对账），噪音多但最保险，
以后新增节点建议 v2 + v4 各跑一遍再人工过目。

**⚠️ 三元拼串差点留死键**：上面第 3 类的键只能做「片段断言」（证明 `"Video"` 和
`" Crop + Rotate + Pad"` 两段碎片都在源码里），而片段断言**证明不了可达性**。
`${state.kind === "video" ? "Video" : "Image"}` 这个三元里，本插件只有一处
`registerTransformExtension(...)` 调用、`kind` 传的是 `"image"`，所以 `"Video"` 那一支
永远不执行 —— `Video Crop + Rotate + Pad` 是**死键**，DOM 里永远匹配不到它。
是 `verify_i18n.py` 第 [2] 项把它揪出来的，已用 `tools/fix_ui_entries_dedup.py` 删除
（ui 157 → 156）。**以后遇到三元拼串，先确认两条分支都可达再入字典。**

同批顺手对齐两处文案：`Image Crop + Rotate + Pad settings` 的译文改成与节点显示名同一套
写法（`图像裁剪 + 旋转 + 补边 设置`）；`Reset rotation, crop, padding…` 那条 tooltip 里的
「保留**视频**来源」改成「保留来源」（本节点只载入图片）。

### 前端扩展注册名的坑

`app.registerExtension({name})` 里的 name 是**纯前端标识符**，不参与节点功能，但排查时会
按前缀筛。这一批最初照抄上游结构留成了小写 `qgtools.transform.<节点ID>`（由
`transform_editor.mjs` 的 `registerTransformExtension` 统一注册），`widget_kv` 同理留成
`qgtools.widget_kv` —— 结果真机检查里按「以 `QG.` 开头」筛扩展名时**整个漏掉了这个节点**，
差点误判成「没注册扩展」。

现已统一回 `QG.` 命名空间（`QG.transform.<节点ID>` / `QG.widget_kv`，与
`QG.tools.init` / `QG.LoraLoader` / `QG.WorkflowNote` / `QG.WorkflowSwitches` 一致）。
`verify_port.py` 第 4 项会扫出所有 `registerExtension` 的名字并断言前缀是 `QG.`，
以后再有新节点忘记改会在这里炸。

注意 `qgtools-`（**连字符**）是另一套约定，用于私有 CSS 类名与 style 元素 id，不要改。

### 汉化深度清理：什么时候必须走 `zh()`（v0.5.0 第二遍）

第一遍把「静态文本」补进字典就完事，真机上仍留下几类英文。根因是汉化插件的机制：

- 它**只做整串全等匹配**（文本节点按 `trim()` 后比对，属性按原值比对）；
- 它的 `MutationObserver` 只订阅 `{childList:true, subtree:true}`，**不订阅 attributes**，
  且只挂在**节点自己的 DOMWidget 根元素**与 **`document.body` 顶层新增元素**上；
- 节点面 DOM 只用**本节点自己的 ui 字典**（`main.js:430`），弹层才用全节点汇总。

于是下面三类它**永远够不到**，必须在源码里用 `shared/zh.mjs` 的 `zh()` 拼句子时查字典：

| 类别 | 例子 |
|---|---|
| **拼接出来的句子** | `` `Pad to ${ratio}: keep every pixel…` ``、`` `already ${request}: pick another ratio` ``、`sendLines` 的 `Source {a} × {b}` |
| **插入之后才写的属性** | `sync()` 里重赋的 `title`、`aria-label`（首帧在插入前赋的能翻，之后每次重赋都会退回英文） |
| **画布上画的字** | `drawEmptyCanvas` 的「先选择一个来源」、`drawOutputSize` 框里的 token 与警告 —— canvas 文字对 DOM 观察器完全不可见 |

`zh()` 的字典来源是**后端路由 `/translation_node/get_translation` 的合并结果**
（不是某节点的 ui），所以模板键放哪个节点的 ui 里都能被查到；但**节点面上的纯文本**
仍必须进**本节点**的 ui，否则汉化插件的 DOM 兜底那一层抓不到。

约定：
- 字典里放**带 `{a}` / `{n}` 占位符的模板**，源码里写 `zh("… {a} …").replace("{a}", …)`；
  占位符模板必须是**字面量**（`tools/verify_i18n.py` 第 [2] 项是源码子串查找，
  `` `Filter {a} image${s}…` `` 这种带 `${}` 的模板会被判「源码里没有这个键」）。
- 不要用「一个词一个槽」拆句子（`{pad ? "add" : "trim"}`）—— 单词键（`add`/`trim`）
  容易撞上别处的文本节点。**两种说法各写一整条模板**。
- 数字/单位留在模板外或放 `{n}`，别把 `%` 同时写进模板和参数（踩过：`{a}% wider`
  配上 `"3.4%"` → `3.4%%`）。
- 字典到达是**异步**的：`transform_editor.mjs` 在模块顶层挂
  `zhReady().then(() => { if (zhOn()) for (const live of liveStates) draw(live) })`，
  字典落地后重绘所有活面板，把「首帧还没字典」的那些拼接串补上。
- **只加可达的键**。共享组件按参数分叉（`kind === "video" ? … : …`）时，先确认哪一支
  真的会被走到（本插件 `state.kind` 恒为 `image`，`widget_card` 的 `preview.kind` 没有
  任何配置在用），不可达的那支**不写进字典**，留英文兜底即可 —— 这就是上次
  「片段断言证明不了可达性」的正面用法。

本轮落地（ui 156 → **222**）：

- `transform_editor.mjs`：比例行（翻转/caption/比例块/锁）、Fit 行、填充色、居中按钮、
  读数提示、拉伸警告、状态面板与读数 tooltip 的尺寸链、来源选择器（placeholder/label）、
  空画布文字。
- `transform_geometry.mjs`：`sizeChainTokens` / `alignChanges` 的 token 与警告片段。
- `media_picker.mjs`（共享）：`Click to choose another …`、过滤框 placeholder 与
  `aria-label`、`Can't preview this …`。
- `scrub_input.mjs`（共享）：步进按钮的 `Step up/down; Shift = fine.`
  （拆成两条整句，替换掉原来的三元拼串）。
- `settings_menu.mjs`（共享）：`Send {a} with the request…` / `Reset {a} to {b}`
  （`{a}` 用 `zh(entry.label)` 填，标签本身已在字典里）。

排查工具：`tools/scan_en_strings_v5.py`（**按节点作用域**对账 —— v2/v3/v4 都把全部节点的
ui 合并后比对，看不出「某个键在别的节点有、在本节点没有」这种缺口，`Custom` 就是这么漏的；
它扫 `createElement#3` / `.title=` / `setAttribute` / `.textContent=`，并把三元分支、
模板片段的假键单独列出来人工过目）。真机端 `tools/frontend_cdp_check.py` 第 5 节会把
面板与弹层里「含英文单词又不含中文」的文本与 `title`/`placeholder`/`aria-label` 全列出来。

**顺带修掉一个真 bug**：`updateModalInfo` 找的是 `[data-qgtools-status]`，而元素上写的是
`dataset.qgStatus`（= `data-qg-status`），选择器对不上 → 编辑器右侧的尺寸状态栏一直是空的。
现在两边统一为 `data-qg-status`。

## Run Timer 搬家记录（AusBoss #31，v0.6.0）

最小的搬运：**1 个 Python 空壳（34 行）+ 1 个前端入口（468 行）+ 1 个新共享模块（83 行）**。

- **性质**：纯展示节点。无输入无输出、`FUNCTION = "noop"` 且**永远不会被执行**
  （没有输出就不进 prompt 图）——整个节点就是块黑底读数：无标题栏（`flags.no_title`）、
  用 `Object.defineProperty` 把 `node.badges` 钉成空数组（不然前端挂的「哪个包」徽标悬在空白处）、
  `color`/`bgcolor` 钉成 `#07090a`。
- **两条渲染路径**（`usesVueNodes()` 分流）：经典画布走 `onDrawForeground` **节点自绘**
  （没有 DOM widget，指针落点就是画布，拖拽/缩放/右键都是原生行为）；Nodes 2.0 渲染器
  不跑 canvas paint，回退成 DOM widget（`.qgtools-timer-*`）。宽度是把手，高度按
  176:56 锁定比例（`keepAspect` 在 draw 路径里也跑，拖完下一帧就修正）。
- **共享层需求**：`shared/index.mjs`（BRAND/chainCallback/keepDomWidgetWidthAuto）与
  `panel_layout.mjs`（holdNodeMinWidth）本来就有；**新增 `shared/run_timer.mjs`**
  （83 行纯逻辑 reducer + 缓存发光层，零 import，测试友好的那部分都在这）。
- **改名**：`tools/port_run_timer.py`，8 条改名 + 命中数断言。教训：**短串的预期命中数
  要按改之前的原文统计**——`ausboss_run_timer` 原文 3 处 = `_panel` 1 + `PROPERTY` 值 1 +
  DOM widget 名 1，第一版断言写成 2 被 FATAL 当场拦下（这正是断言的价值）。
  改完 `grep -ci ausboss` 必须为 0。
- **i18n**：右键菜单（历史记录 + 清空）是**点击时构建**的，汉化插件的 DOM 观察器够不到
  → 三条全走 `zh()`（`Runs: {a}` / `No completed runs yet` / `Reset Run Timer history`，
  键放本节点 ui）。两份字典都用 `tools/add_i18n_run_timer.py` 补齐（脚本先断言
  「键的字面量在 web/ 源码里存在」再写盘）。节点本身无输入无输出，nodeDefs 两边
  `inputs`/`outputs` 都是空对象。
- **版本串**：新增 shared 模块 → `2026101316` → `2026101401`（82 处）。
- **验证**：`frontend_cdp_check.py` 的「节点实测」段加了 `runTimer` 探针
  （installed / mode=noTitle / badges=0 / size=[176,56] / color=#07090a）；
  8199 实测 PASS、启动日志「节点数 5」、汉化与布局断言无回归。

## Text Edit Output 搬家记录（Muye #24，v0.6.0）

最小的一个：**1 个 Python 文件、零前端、零新增依赖**。

- **性质**：纯 Python 输出节点。`multiline` 文本框 → `OUTPUT_IS_LIST = (True,)`
  + `OUTPUT_NODE = True`，`process_text` 返回 `([text],)` —— **整段作为一个元素传出，
  绝不按换行切分**（上游语义如此；切了就变成多路输出，接下游会炸）。
- **改名**：`MuyeTextEditOutput` → `QG_TextEditOutput` / `QGTextEditOutput`；
  display 从中文「文本」改成 `QG Text Edit`；CATEGORY 走 `QG-tools/文本`。
- **许可证**：上游 `ComfyUI-Muye-nodes` 是 MIT（copyright 2025 muye_xiuluo），
  全文已落到 `licenses/ComfyUI-Muye-nodes-LICENSE.txt`；README 的许可证段一并列了出处。
- **i18n**：`locales/zh/nodeDefs.json` 的 `QG_TextEditOutput` 四条（display_name /
  description / inputs.text / outputs）；汉化插件字典同步补同一份。

## appearance 全局扩展（AusBoss 全局前端层，v0.6.0）

用户截图反馈「QG 节点怎么没有 ? 徽章和配色」才补的 —— 之前只搬过数据层
`shared/appearance.mjs`，节点一直没徽章也没配色。

- **新增** `web/appearance/index.js`（扩展名 `QG.Appearance`，全局，不绑节点）：
  `nodeCreated` 时按当前方案给 QG 节点上色 + 画「?」徽章；右键加「QG 配色」子菜单；
  `installTitleInk` 给标题栏挂 `.qgTitleInk` 做墨色适配。
- **新增** `web/shared/help_badge.mjs`（徽章绘制，纯逻辑，无 import）。
- **「已有配色不动」**：`shouldRecolor` 只认没上过色的节点，保护用户手动挑的颜色。
  副作用是旧会话/别的插件带来的杂色节点会一直留着 → 解法是配色子菜单最后一项
  「把所有 QG 节点重刷为当前配色」（`repaintEveryQgNode`，无视 shouldRecolor，
  遍历含子图强制重刷；方案选 `Theme default` 即为清色）。
- **i18n**：菜单走 `zh()`。字典里新增**非节点的顶层条目** `QG_Appearance`
  —— `verify_i18n.py` 只遍历 NODES 名单，独立条目不影响校验；配色方案名
  各节点条目里本来就有，`zh()` 走合并字典直接复用。
- **验证**：专项脚本 `tools/verify_appearance.py`（真机 CDP 造节点看上色 / 徽章 /
  菜单）；`tools/probe_teo_color.py` 验 TextEditOutput 也吃到配色。

## 发布到 Registry

`pyproject.toml` 与 `.github/workflows/publish_action.yml` 已经按官方模板配好：

1. Registry 站点是 **[registry.comfy.org](https://registry.comfy.org)**（注意不是 `comfyregistry.org`，
   那个域名打不开）。`PublisherId = "live1617"` 已核实为该站点上真实存在的 publisher，
   邮箱与仓库 git 身份一致，无需再改。
2. 在本仓库 `Settings → Secrets and variables → Actions` 新建 secret，
   名字 `REGISTRY_ACCESS_TOKEN`，值填 registry 上生成的 personal access token
   （登入 registry.comfy.org 后在个人/发布页生成）。
3. 以后发版只需改 `pyproject.toml` 的 `version` 并推到 `main`，workflow 会自动发布；
   也可在 Actions 页面手动 `workflow_dispatch` 重跑。

## 打包

需要给 GitHub Release 传 zip 时，**不要把整个目录直接压** —— 先排除这些：

- `__pycache__/`、`*.pyc`（Python 缓存）
- `.git/`（版本库，不该进发布包）

压好的 zip 顶层目录名应为 `ComfyUI-QG-tools`，这样用户解压到 `custom_nodes/` 下即可直接用。
GitHub 自动生成的 "Source code (zip)" 顶层是 `仓库名-分支名`，**不适合**当 Release 附件，
建议手动压一份上传。
