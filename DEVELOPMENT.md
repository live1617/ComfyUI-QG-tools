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
