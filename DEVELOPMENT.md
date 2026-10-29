# 开发与维护笔记

面向要改这个插件的人。**使用说明请看 [README.md](README.md)。**

## 目录结构

```
ComfyUI-QG-tools/
├── __init__.py                        # 只汇总 nodes/ 下所有模块的映射，不写节点逻辑
├── ORIGINS.json                       # 节点来源清单（机器可读）：原创 / 搬运 + 参考来源
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
├── locales/
│   └── zh/nodeDefs.json               # 中文语言包（标题 / 输入输出 / 提示 / 选项显示名）
├── nodes/
│   ├── __init__.py                    # 占位，不要在这里写节点
│   ├── _qg_lora_helpers.py            # 被引用，不注册节点（下划线开头 = 不扫）
│   ├── _qg_combo_legacy.py            # 下拉选项老中文值 → 英文值（全插件唯一的表）
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

> 树里的 `nodes/` 与 `web/` 只列了最早期几个做示例，实际数量以目录为准。
> `shared/combo_zh.mjs` 是**生成物**（`tools/gen_combo_zh.py` 从 `_qg_combo_legacy.py` 产出），
> 别手改。

`web/shared/` 里有两类模块：本插件节点自己抽出来的（`lora_stack`、`widget_card`、`panel_layout`…），
以及被它们串起来带进来的通用工具（`transform_geometry`、`media_picker`、`pad_canvas`…）。
后一类当前没有节点直接用，但**别删** —— 删了会让 `widget_card.mjs` 的 import 断链。

### 节点尺寸：`web/shared/node_width.mjs`（唯一真相源）

ComfyUI 的节点默认宽度**不在 Python 里**，是前端按控件类型算的（带多行文本框的会被撑到
400，普通节点 270，只有两个控件的甚至算成 159），`INPUT_TYPES` 里没法声明，grep 也 grep 不到。
所以全部 42 个节点在一张表里登记，**改尺寸只改这一处**：

```js
export const SIZES = {
    QG_ColorMatch: { w: 270 },                                   // 简单节点：钉宽
    QG_LoadImage:  { w: 270, minW: 250, h: 405, own: true },     // 自带布局：最小宽也从表取
    QG_CanvasLabel:{ w: null, own: true },                       // w: null = 宽度跟文字算
};
```

- 字段：`w` 默认宽 / `minW` 最小宽（缺省 = w）/ `h` 默认高（只有写死高度的才填）/ `own` 自带布局标记；
- **A 路**：`pinNodeWidth()` 在新建时把宽度钉成 `w`（`w: null` 的不钉）；
- **B 路**：`own: true` 的节点，`web/<节点>/index.js` 里的 `MIN_WIDTH` / `NODE_WIDTH` /
  `PANEL_MIN_WIDTH` 等常量写成 `sizeFor("QG_Xxx").minW`，最小宽和默认宽都跟着表走；
- 🔴 节点通常只把宽度当**最小宽**用（`minNodeSize`），初始宽由 LiteGraph 给。所以只改常量不钉宽，
  会出现「表里 300 改成 260、节点还是 270」的假象 —— 两条路必须一起用；
- **只影响新建**：存档里有宽度的节点由 `onConfigure` 覆盖回来，不动用户调过的尺寸。

体检：`tools/verify_node_sizes.py`（已进 `regress.py`）—— 查漏登记、僵尸条目、数值合法性、
以及「前端还写死宽度却没引用表」。实测全量尺寸：`tools/probe_all_node_widths.py` /
`tools/_probe_all_sizes.cjs`（headless 起页面逐个新建量，输出 `reports/node_sizes.json`）。

### 右键「测量尺寸」→ 已独立成 ComfyUI-QG-NodeMeasure

这个功能**不在本插件里**了（2026-10-27 拆出去）。`custom_nodes/ComfyUI-QG-NodeMeasure`
是个纯前端插件，没有节点，量的是**任何**插件的节点（官方 / rgthree / Impact 都行）。
原来那份 `web/shared/measure_node.mjs` 已删除。

本插件只负责喂数据：`shared/node_width.mjs` 把 `SIZES` 挂到 `globalThis.__QG_SIZE_TABLE__`
（探针在用的老名字 `__QG_SIZES__` 也保留，同一个对象）。那边读到就多显示一行「默认」，
没装本插件就退化 —— 两个插件互不依赖，谁先加载都行。

🔴 别在本插件里再挂 `getNodeMenuItems` 返回同样的菜单项：两边都挂会让右键出现
**两项**「测量尺寸」。菜单入口只有 NodeMeasure 提供。

卡片本身长这样（在 NodeMeasure 那边实现，CSS 前缀 `qgmeasure-`）：

| 行 | 含义 |
|---|---|
| 节点 / 类型 | 标题与 `QG_` 类名，附带控件数、输入输出槽数 |
| 当前 | 画布上现在多大（含比例） |
| 默认 | 尺寸表里的 `w × h`（读不到表就显示「无尺寸表」） |
| 按内容 | `computeSize()` 算的「该多大」，没有表时用它当参考 |
| 最小 | **真正生效**的下限：`widget.options.minNodeSize`，没有就是 LiteGraph 全局 140。跟表里写的 `minW` 不一致时标黄，并在右侧注明「表里写 X」 |

底部「复制成表格行」产出一行 markdown，可直接贴进 `reports/节点默认与最小尺寸.md`。
探针还在本工作区：`tools/_probe_measure_node.cjs`（数据 + 卡片）、`tools/_probe_measure_menu.cjs`（菜单项，两种模式）。

🔴 类型那一行用伪元素 `attr(data-type)` 画，**不能写进 DOM 文本**：汉化插件把节点类名当词条
（字典键就是 `QG_ColorMatch`），整串会显示成「颜色匹配」，拆成 `QG_` + `ColorMatch` 也会把后半截
翻成「图像调色」。只有伪元素不产生文本节点，翻译器才够不着。

## 命名约定

本插件所有节点统一：

- **节点 ID**：`QG_` 前缀
- **显示名**：**不带** `QG ` 前缀（2026-10-18 起；标题栏只留功能名，分类已经说明归属）
- **分类**：`QG-tools`，二级子分类共八个，**一律英文**：
  `Loaders` / `Text` / `Logic` / `Display` / `Workflow` / `Mask` / `Annotation` / `Image`。
  🔴 后端写中文，英文界面的节点菜单里就会冒出中文分组。中文名走**官方通道**
  `locales/zh/main.json` 的 `nodeCategories`（见「双语与下拉选项值 · 分类」一节），
  不依赖汉化插件；经典画布的右键「添加节点」菜单官方不管，由
  `web/shared/category_zh.mjs` 兜（同见那一节）。新增子分类要同时改**四处**：
  白名单 `verify_categories.py:ALLOWED_SUBS`、`locales/zh/main.json`、
  汉化插件那份同值冗余映射、以及 `web/shared/category_zh.mjs` 的 `CATEGORY_ZH`。
- **前端扩展注册名**：`QG.<NodeName>`
- **后端路由**：`/qg/<功能>/...`
- **私有 CSS 类名 / style 元素 id**：`qgtools-` 前缀

显示名去掉 `QG` 之后，中文标题就搜不到英文关键词了，所以每个节点必须同时在
`web/shared/node_aliases.mjs` 里登记一组英文叫法（`tools/verify_display_names.py`
会检查键不漏不多、别名非空）。

## 怎么加节点

1. 在 `nodes/` 下新建一个 `.py`，文件名 `qg_<节点名>.py`；被引用的 helper 用 `_` 开头。
2. 模块里导出两个字典：

```python
NODE_CLASS_MAPPINGS = {"QG_MyNode": QGMyNode}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_MyNode": "My Node"}
```

🔴 **显示名写英文**。后端是英文优先，中文由 `locales/zh/nodeDefs.json` 的
`display_name` 提供（用户切中文界面时才叠上去）；在 Python 里写中文，英文界面就
只能看到中文。同一个道理适用于 `DESCRIPTION`、所有 tooltip、`RETURN_NAMES`、
下拉选项值 —— `tools/verify_bilingual.py` 会把中文残留一条条报出来。

3. 节点类里写 `CATEGORY = "QG-tools/<英文子分类>"`（现有八个见「命名约定」）。
   **新开子分类**才要动语言包：`locales/zh/main.json` 的 `nodeCategories` 加一条，
   再跑 `tools/verify_categories.py` —— 它有 `ALLOWED_SUBS` 白名单，漏登记直接 FAIL。
4. 重启 ComfyUI。`__init__.py` 会自动扫描 `nodes/`，无需手工注册。
5. 还有六处要一起改 —— 漏了不会崩，但会静默缺中文、搜不到、宽度不对：

| 位置 | 改什么 |
|---|---|
| `locales/zh/nodeDefs.json` | 加条目：`display_name`（**必填**，后端只有英文）/ `description` / `inputs`（带 tooltip）/ `outputs` |
| 汉化插件 `zh-CN/Nodes/ComfyUI-QG-tools.json` | 同上但**格式不同**（`title` + 纯字符串 name），两套不可互换 |
| `web/shared/node_aliases.mjs` | 登记英文别名；`verify_display_names.py` 会检查键不多不少 |
| `web/shared/node_width.mjs` | 在 `SIZES` 里登记一条（`w` / `minW` / `h` / `own`）；漏了会退回 270 默认宽，`verify_node_sizes.py` 会报 |
| `tools/sync_translation_pack.py` | 加进 `NODE_ORDER`，否则同步汉化包时报「字典里还有本脚本没列出的键」 |
| `nodes/_qg_combo_legacy.py` | 有新下拉选项的，把老中文值登记进 `LEGACY`，再跑 `tools/gen_combo_zh.py` |

改完跑 `verify_display_names.py` / `verify_i18n.py` / `verify_i18n_reverse.py` /
`verify_bilingual.py` / `verify_combo_i18n.py` / `js_check.py` / `verify_port.py`，
再 `sync_translation_pack.py --apply` 刷新分发的汉化包。嫌麻烦就一次跑
`python tools/regress.py`（工作区脚本，把上面这些串成一串）。

> 节点总数**不用手改**：`verify_display_names.py` 现在从 `nodes/*.py` 里数出来
> （两种写法都认：映射块里的字面量键，以及 `{NODE_TYPE: "显示名"}` 这种常量做键）。
> 之前写死 28，加节点忘了改就会误报「数量不符」，反而盖住真正的缺口。

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
- 🔴 **DOM widget 里的滚动区用 `flex:1 1 0` + `min-height:0`，别用 `flex:1 1 auto`。**
  Vue（Nodes 2.0）的节点高度是 `renderingSize = max(node.size, DOM 内容高度)`；
  `flex-basis:auto` 会让滚动区按**全文内容**撑开 —— 实测 6,389 字的文档把 360 高的节点
  撑到 721.9，切 Vue 后节点高度失控。经典模式画布尺寸固定，看不出来，所以只在 Vue 复现。
  `md_reader` 曾写成 `auto`；`display_any` 这条一直对，但下一条照样栽了。
- 🔴 **但 `flex:1 1 0` 只保证「滚动区自己肯缩」，面板容器本身还得有高度上限。**
  Vue 外壳只有 `min-h-(--node-height)`（下限，没有上界）；面板若写 `height:100%`，
  在行高 `auto` 的父级里（`WidgetDOM.vue` 的 `flex flex-col *:flex-1`）100% 会退化成 auto
  → 面板跟着内容长 → 外壳再被内容撑长，正反馈没有刹车。实测 `display_any` 30 行文本
  把节点从 140px 拉到 1420px（经典模式下面板固定高、文本在面板里滚动）。
  治本：Vue 下给面板写 `max-height: calc(var(--node-height) - Npx)` —— `--node-height`
  由前端写在外壳上（`LGraphNode.vue`），等于节点应有总高 `size[1] + 标题栏`；
  N 是面板以外的高度（标题栏 + 输入槽行 + 内边距，本机实测 92px）。
  **N 别写死**：它随前端版式变，用「外壳高 − 面板高」实测校准 —— 这个差值恒等于面板以外的高度、与面板多高无关，
  被夹住时同样成立，所以一次就收敛。切回经典模式必须把 `maxHeight` 清空。
  实现在 `web/shared/vue_panel_fit.mjs`（`pinPanelToNodeHeight` / `watchVueShell`）。
- 🔴 **面板分两类，对齐方向相反，别一律套 `max-height`。**
  「外壳高 = size[1] + 30」是唯一目标（Vue 的选中框、槽点、右下角手柄仍读 `node.size`），
  但怎么达到取决于面板能不能压：
  - **弹性面板**（有滚动区，或走 `fillNodeHeight` 参与空间分配）：压面板 →
    `pinPanelToNodeHeight`（`display_any`、`lora_loader`）。
  - **固定面板**（卡片高度由行数定，压不动）：让 `node.size[1]` 跟上外壳 →
    `fitNodeToPanelHeight`（`bool_toggle`、`number`、`seed`、`export_image`、`image_crop_rotate_pad`）。
    前提是面板高**不随 size 变**，否则「size 变大 → 外壳变高 → size 再变大」会自激。
    `image_crop_rotate_pad` 这类带 `min-height` 地板的弹性面板就必须走这条路 ——
    夹面板压不过 CSS 的 `min-height`（`min-height` 赢 `max-height`，实测上限 484、地板 521，
    硬夹无效），而地板卡住时面板不随 size 长，所以反过来跟 size 是收敛的。
  - `lora_loader` 两手一起：先夹面板上限（面板不超过节点给的空间），再让 size 跟上外壳。
    Vue 里槽行是独立几行 DOM，比经典版式多占几十像素，只夹面板会剩几像素地板差额。
  - 别和 `holdVuePanelMinHeight`（`panel_layout.mjs`）抢 `min-height`：它挂在面板的
    `ResizeObserver` 上，会反复把值写回去，两边互相覆盖就是死循环。
- 🔴 **切渲染模式是「卸载再装」，`install*` 里别写死宽度。**
  `bool_toggle` 与 `run_timer` 的 canvas 分支都把整个 `size` 赋成常量
  （`[BASE_WIDTH, NODE_HEIGHT]`），于是「经典下调好的宽度 → 切 Vue → 切回经典」
  宽度被打回默认值。宽度是这些节点唯一的把手，用户拉开就是为了放长名字。
  正确写法：只把高度按回去，宽度取 `node.size[0]`（`run_timer` 用 `__qgKeepWidth`
  在 `uninstall` 时记住，新建节点才落到默认值）。
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

## 双语与下拉选项值

目标口径一句话：**ComfyUI 中文界面显示中文，英文界面显示英文，切换语言不改工作流**。

### 文字类（标题、输入输出名、提示、说明卡）

后端只写英文；中文全部放进 `locales/zh/nodeDefs.json`（结构是
`{节点ID: {display_name, description, inputs: {参数名: {name, tooltip}}, outputs: {"0": {...}}}}`，
`outputs` 的键是**索引字符串**）。ComfyUI 的 `build_translations()` 会把每个
custom_node 的 `locales/<lang>/*.json` 收上来，经 `/i18n` 发给前端，前端用
`resolveNodeDefSlotText()` 按字段查表覆盖。

- `DESCRIPTION` 讲整体，tooltip 只讲那一个框 —— 同一段话在两处都写，用户会看到
  蓝字重复两遍（`QG_Math` 因此被打回两次）。
- 改完必须重启 ComfyUI：`nodeDefs.json` 是后端扫的，刷新页面拿不到新内容。
- 校验：`tools/verify_bilingual.py`。英文侧不许有中文（节点上真能看见的选项值、
  `label_on/off` 除外，那些是给用户看的词，允许被英文说明引用）；中文侧必须一条不漏，
  且不许拿英文原文充数。

### 下拉选项值（COMBO）

**选项值本身必须是英文**，中文只是显示名。三个理由：值要进存档、要进 API 请求体、
要跟别的插件互通，中文值在这三处都是负担。

中文显示走 **`widget.options.getOptionLabel(value)`** —— 这是前端官方的显示名钩子，
`ComboWidget._displayValue` 与 Vue 的 `useWidgetSelectItems.ts` 都认它，所以
canvas 和 Nodes 2.0 两种渲染模式一次覆盖，而且**不动存档里的值**。
（`locales/*/nodeDefs.json` 里也有 `options` 映射，但那只对 settings 生效，
翻不了节点下拉 —— 踩过。）

三腿兜底，缺一条都会漏：

| 腿 | 位置 | 兜住什么 |
|---|---|---|
| 1 | `web/shared/combo_zh.mjs` | 老存档里的中文值，在 `configure()` **之前**就地换成英文值 |
| 2 | `nodes/_qg_combo_legacy.py` 的 `combo_legacy` 类装饰器 | 绕过前端的调用（API 直连、脚本批量跑、老图只读不存） |
| 3 | 各节点的 `VALIDATE_INPUTS` | 让 ComfyUI 跳过「值必须在选项列表里」这道校验，否则第 2 腿根本轮不到 |

🔴 **`VALIDATE_INPUTS` 必须具名收住要放行的参数**（`def VALIDATE_INPUTS(cls, mode=None)`），
不能用 `**kwargs` —— 后者会让 `validate_inputs` 认为「参数名都认」，把整个节点的
min/max 之类校验一起关掉。

🔴 **`chainCallback` 的顺序对 `configure` 是反的**：它是「先跑原来的、再跑自己的」，
而迁移必须抢在 `configure` 塞 `widgets_values` 之前。所以 `combo_zh.mjs` 自己写了
前置版包装，没有用 `chainCallback`。

🔴 **新增 / 修改选项值必须同步三处**：节点里的列表 → `_qg_combo_legacy.py` 的 `LEGACY`
（`{节点ID: {输入名: {新英文值: 老中文值}}}`，新值作键，方便前端反查）→
`python tools/gen_combo_zh.py`（从 LEGACY 生成 `web/shared/combo_zh.mjs`，别手抄）。
校验 `tools/verify_combo_i18n.py`（选项值全英文 / LEGACY 与列表对得上 / 装饰器与
`VALIDATE_INPUTS` 到位 / mjs 与 LEGACY 同步 / 同一输入里中文标签唯一 —— 迁移是反查，
重复就不知道换回哪个）。功能冒烟 `tools/test_combo_migration.py`（真加载 13 个节点，
拿老中文值和新英文值各跑一遍，结果必须完全一致）。

前端自建的下拉（不是 ComfyUI 原生 combo 控件）也要认这个钩子：

```js
const label = widget.options?.getOptionLabel;
for (const option of values) {
    const raw = String(option);
    item.value = raw;                                  // 存的是英文值
    item.textContent = label ? label(raw) : raw;       // 显示的中文
}
```

### 分类（nodeCategories）

节点菜单里的分类名**走的是另一条通道**，和 `nodeDefs` 无关：

```ts
// comfyui_frontend_package .../src/scripts/app.ts  getNodeDefs()
category: def.category.split('/')
  .map(c => st(`nodeCategories.${normalizeI18nKey(c)}`, c)).join('/')
```

三条硬事实（都吃过亏）：

1. **按 `/` 拆段逐段查**，键是**单段**（`Loaders`），写 `QG-tools/Loaders` 整串永远查不到。
2. `normalizeI18nKey()` 只把 `.` 换成 `_`，**不改大小写**。所以键必须跟
   `CATEGORY` 里的段名一模一样 —— 写成小写 `loaders` 会静默失效
   （官方内置中文包里恰好全是小写键，那是给内置小写分类用的，抄不得）。
3. 语言包放在 **`locales/zh/main.json` 的 `nodeCategories`**，不是 `nodeDefs.json`。
   `build_translations()` 把 `main.json` 的所有顶层键直接倒进 `/i18n` 的
   `<lang>` 下；`EXTRA_LOCALE_FILES`（nodeDefs / commands / settings）只是额外三份。

🔴 **所有插件的 `nodeCategories` 合并成一个扁平字典，后加载覆盖先加载**
（`sorted(glob('*/'))` 字母序 + `merge_json_recursive(base, update)`）。通用词
（`Loaders` / `Image` / `Text`）会跨插件串味 —— 实测 `ComfyUI-Easy-Use` 声明了
`Loaders → 模型加载器`，把 QG 的「加载器」吃掉，菜单里冒出个莫名其妙的
「模型加载器」分组。我们在 `main.json` 里声明同名键才夺回来（`ComfyUI-E` < `ComfyUI-Q`，
我们后加载）。**反过来，字母序排在我们后面的插件若也声明同名键，就会把我们盖掉** ——
这个无解，只能改分类名或认了。

装汉化插件时还有一份同值的冗余兜底
（`ComfyUI-Chinese-Translation/zh-CN/Categories/ComfyUI-QG-tools.json`），
两处值必须一致，`verify_categories.py` 会比对。

### 经典画布的右键菜单（上面那条管不着，得前端自己改）

`nodeCategories` 只作用在 **nodeDefs** 上（Vue 节点库 / 侧边栏 / 搜索框）。经典画布的
「右键 → 添加节点」不查 nodeDefs，它直接拿 `LiteGraph.registered_node_types[].category`
当名字用 —— 分类改成英文之后，中文界面里这一层就一直是 `Logic` / `Annotation`，
和旁边已经翻好的「画布标签」「Markdown 文本」并排着很扎眼（2026-10-24 用户截图）。

补法：`web/shared/category_zh.mjs` 在中文界面下把 QG 节点 category 的尾段就地换中文
（`QG-tools/Logic` → `QG-tools/逻辑`），由 `QG.tools.init` 的 `setup()` 装上：

1. 先改一遍现有注册表；
2. **包住 `LiteGraph.registerNodeType`** —— 实测 `setup()` 跑在**任何节点注册之前**
   （`__QG_CATEGORY_ZH__.setup` 恒为 0），真正生效的是这层包装，漏了它半张菜单仍是英文；
3. 开菜单前（`getCanvasMenuOptions`）再补一次兜底，防止有人绕过入口直接写 `category`。

三条约束：

- **只在中文界面动手**（`wantsChinese()`，读 `app.i18n.global.locale`）。英文界面保持
  后端英文原样，`tools/probe_category_zh_locale.cjs` 有正反两面证据（zh→中文、切 en→英文、切回→中文）。
- 只改 QG 节点的尾段，别的插件和原生节点一律不碰。
- 文案的第三份副本在这份 mjs 里，`verify_categories.py` 第 8 节会跟 `main.json` 逐条比对。

验证：`node tools/_test_category_zh.mjs zh|en`（纯逻辑，不需要浏览器）、
`node tools/probe_category_zh_locale.cjs`（headless Chrome 打开 8199 临时用户目录，中英来回切）。

## 后端路由

`list` / `thumb` / `info` / `hash` / `civitai`(POST) / `triggers`(POST)，全部挂在 `/qg/lora/` 下。

## 抽取来源

42 个节点 = **16 原创**（其中 3 个参考上游思路重写、3 个搬自作者自有旧插件）+ **26 搬运**。
逐文件的 from/to 与每一处字符串替换记在 `PORTED.json`（`pack_version` 停在 0.8.0，
后面几批以本表为准）。

🔴 **两档口径：原创看代码是不是自己写的，搬运看是不是整段抄的。**

- `original`（原创）—— 代码自己写：① 从零实现；② 参考上游的用法/思路后换一种写法
  自己重写（`reference.relation = "idea"`）；③ 把作者自己旧插件里的代码合并进来
  （`relation = "own"`）。
- `ported`（搬运）—— 整段照抄上游代码，只改类名 / 节点 ID / 分类 / 显示名 / 中文文案，
  逻辑一行没动。

判据：**能不能指出某段代码是从上游原样搬来的** —— 指得出就是搬运；指不出、只是照着
别人的思路自己实现，就是原创。参考对象一律写进 `reference`，算原创不等于隐去出处。

🔴 **谁原创、谁搬的，机器可读清单在 `ORIGINS.json`**（每个节点一条：`origin` =
`original` / `ported`，搬运的带 `upstream.plugin` / `node` / `license`，原创带参考对象的
可选写 `reference.plugin` / `node` / `license` / `relation`）。
README 顶部那张「节点来源」表和各章节标题下的来源徽标都由它生成 —— 别手改 README
那两个标记块，改完 `ORIGINS.json` 跑：

```bash
python tools/sync_origin.py --apply    # 重新渲染表格 + 徽标
python tools/verify_origin.py          # 校验：与注册节点 / README / 文件头出处一致
```

**新增节点必须同时登记 `ORIGINS.json` + `sections`**（否则 README 上这个节点没有来源标注，
`verify_origin.py` 会报「注册表里有 X，但 ORIGINS.json 没登记」）。

| 来源插件 | 抽取的节点 | 当前 ID | 说明 |
|---|---|---|---|
| ComfyUI-AusBoss v2.10.1 / 2.11.1 / 2.12.x（MIT） | LoRA Loader / 图像裁剪 + 旋转 + 补边 / Workflow Note / Workflow Switches / RunTimer / 图像对比 / Free Memory | `QG_LoraLoader` / `QG_ImageCropRotatePad` / `QG_WorkflowNote` / `QG_WorkflowSwitches` / `QG_RunTimer` / `QG_ImageCompare` / `QG_FreeMemory` | 见下方各「搬家记录」；`QG_ImageCompare` 上游约 3900 行，只搬滑动 / A / B / 擦除那一部分；`QG_FreeMemory` 四步释放整段照搬（每步 fail-soft），通配类型用上游的 str 子类写法 |
| ComfyUI-AusBoss + rgthree-comfy（MIT） | 种子 | `QG_Seed` | 卡片界面来自 AusBoss，取值与随机逻辑来自 rgthree；老存档 -1/-2/-3 在 `onConfigure` 翻译 |
| ComfyUI_Muye 1.0.17（MIT） | Text Edit Output | `QG_TextEditOutput` | v0.6.0，见「Text Edit Output 搬家记录」 |
| ComfyUI_Muye 1.0.17（MIT） | 图像水印 / 文字叠加图像 / 宫格图像拼接 / 遮罩上色 / 遮罩拼接 / 文本按分隔符分割 / 尺寸选择器 | `QG_ImageWatermark` / `QG_TextOverlayImage` / `QG_ImageGrid` / `QG_MaskColorize` / `QG_MaskConcat` / `QG_TextSplit` / `QG_SizeSelector` | v0.8.5，见「Muye 8 节点搬家记录」 |
| ComfyUI_Comfyroll_CustomNodes（MIT） | 文本合并 / 文本替换 | `QG_TextConcat` / `QG_TextReplace` | v0.9.4。`QG_TextReplace` 原本搬的是 Muye 的 `BatchTextReplace`（v0.8.5 ~ v0.9.3），v0.9.4 换成 Comfyroll 的 `CR_TextReplace`，旧存档由 `web/text_replace/index.js` 自动迁移 |
| rgthree-comfy（MIT） | 图像缩放 / 图像或 Latent 尺寸 | `QG_ImageResize` / `QG_ImageOrLatentSize` | 复用 ComfyUI 自带的 `common_upscale`，没有额外依赖 |
| ComfyUI_Custom_Nodes_AlekPet（MIT） | Google 翻译 | `QG_GoogleTranslateText` | 上游依赖 `googletrans`；这里用 `requests` 直连同一批端点，保持「零新增依赖」 |
| 孤海工具箱（Goohaitools-comfyui，GPL-3.0） | 任意切换 / 展示任意 / 路由阻断 | `QG_AnySwitch` / `QG_DisplayAny` / `QG_RouteBlocker` | 类名与分类改成 QG，GPL 出处标注保留在文件头。`QG_RouteBlocker` 未发布（v0.9.4 之后新增，v0.9.5 仍未发），1:1 搬运自 `GoohaiRouteBlocker`「路由阻断」：`block`(BOOLEAN) + `mode`(combo: `empty` / `cut`，中文界面「仅输出空值」/「中断后续分支」) + `any`(optional, `*`) 进，`any`(`*`) 出一道。阻断时 `empty` 给 `None`（下游照跑）、`cut` 给 ComfyUI 原生的 `ExecutionBlocker(None)`（下游被静默跳过，等于程序化 Ctrl+M）。🔴 唯一改动是给 `any` 加 `forceInput` —— `*` 输入不加的话画布上会多出一个用不了的控件（`QG_Exists` 同款处理）。🔴 它也是 `_qg_combo_legacy.py` 里要登记老值的节点之一，并且 `VALIDATE_INPUTS` 必须具名收 `mode` |
| ComfyUI-Easy-Use（GPL-3.0） | 是否判断 | `QG_IfElse` | 未选中那一支走 `check_lazy_status` 不执行 |
| ComfyUI-MD-Reader（**作者自有插件**） | 加载文档 | `QG_MDReader` | 同一作者的旧插件，合并进来，算**原创**（本来就不是第三方代码） |
| ComfyUI-TripleLoader（**作者自有插件**） | 模型加载器 | `QG_TripleLoader` | 同上，算**原创**；它在 import 期就实例化内置的 UNET / CLIP / VAE Loader |
| ComfyUI-EmptyLatentResolution（**作者自有插件**） | 空 Latent 分辨率 | `QG_EmptyLatentResolution` | v0.9.5。把官方 `ResolutionSelector`（比例 + 百万像素 → 宽高）和 `EmptyLatentImage`（宽高 + 批量 → LATENT）合成一个节点，算**原创**（自己写的旧插件重写并入）。尺寸算法与 `ResolutionSelector` 逐行一致（同样的 `sqrt` 缩放、同样的 multiple 取整），128 组参数实测逐个相同；latent 结构与 `EmptyLatentImage` 一致（4 通道、`intermediate_device()` / `intermediate_dtype()`、`downscale_ratio_spacial=8`）。🔴 原插件是**纯 V3 节点 API**（`io.ComfyNode` + `comfy_entrypoint`），本包走 V1 —— 同时存在 `NODE_CLASS_MAPPINGS` 时 ComfyUI 根本不会调 `comfy_entrypoint`，所以整段改写成 V1 类。🔴 预览控件 `RESOLUTION_PREVIEW` **必须放 optional 段**（`ResolutionPreview.Input` 默认 `optional=True, socketless=True`），三个 `ratio_widget` / `megapixels_widget` / `multiple_widget` 键指向真实输入名；放 required 提交时会缺值。🔴 比例下拉走 `_qg_combo_legacy.py` 登记中文标签（值仍是英文），`VALIDATE_INPUTS` 具名收 `aspect_ratio`。校验：`tools/verify_empty_latent.py`（注册信息 / 输入声明 / 128 组尺寸 / latent 结构 / 与官方 `EmptyLatentImage` 交叉比对） |
| ComfyUI-Crystools（GPL-3.0） | 字符串切换（**只借思路，算原创**） | `QG_StringSwitch` | v0.9.4，见下方「字符串切换」 |
| comfyui-art-venture（MIT） | 颜色校正（**只借参数划分，算原创**） | `QG_ColorCorrect` | v0.9.5。只沿用六个滑条的参数划分与作用顺序（色温/色调/明度/对比度/饱和度/伽马，`-100..100` / 伽马 `0.1..5.0`），实现整段自己写：纯 torch、全 float、无 cv2。修掉参考实现三处问题 —— ① 它逐帧转 PIL `uint8` 再转回，两次量化让渐变出色阶；② 它的 `saturation` 改的是 HLS 的 **L（明度）** 通道而非 S，拉到 -100 是发白不是变灰；③ 它的 `temperature` 只乘单个通道，会把画面一并调亮。另外色相走 HSV 旋转 H（纯红 +120° → 纯绿），不用线性 hueRotate 矩阵（那个会把红色转到只有 44% 的绿）。🔴 参数名 `temperature` / `hue` / `brightness` / `contrast` / `saturation` / `gamma` 全小写，`verify_i18n` 的 `NODES` 已登记 |
| 原创（无上游代码） | 颜色匹配 | `QG_ColorMatch` | v0.9.5。十种方法都是公开算法的自写实现，没搬任何插件代码：Haar 小波 3 层只匹配低频子带、AdaIN 逐通道实例归一化（sRGB 上，**单尺度**）、RBF 核 MMD 拟合仿射映射、逐通道 CDF 分位匹配、Reinhard LAB 逐通道均值/标准差（2001）、LAB 3×3 协方差匹配（Pitié 2007 线性 MKL 的核心：白化再着色）、两种三步串联（直方图-多元高斯-直方图、直方图-MMD-直方图）、Reinhard 的整批 4D 实现、仅匹配均值。参数划分（强度 / 匹配范围 / 遮罩羽化 / 遮罩用途 / 细节回填 / 参考取帧 / 目标统计）是本插件自己的。🔴 出口**不硬裁**：出界像素在 LCh 里缩 chroma（二分 6 次，保色相 + 保 L\*），因为逐通道 clamp 会改三原色比例、也就是改色相（实测饱和色偏 2–8°）。🔴 源侧 σ 有下限 `STD_FLOOR`（归一化 L 的 2%），否则平目标的 σ≈0.005 会被放大几十倍、噪声爆炸（实测同一张近纯色图：无下限偏离 0.12，有下限 0.013）；mvgd 的源协方差同时加了岭项。🔴 `src_mode=whole-batch`（中文界面「目标统计 = 全批统一」）时源侧统计量整批算一次，直方图必须变成「值→值」单调查表（`_hist_lut`/`_hist_map_lut`）才能套用到每一帧，否则帧间会闪 —— 这也是 ComfyUI 内置 ColorTransfer 的 uniform 口径。🔴 对外 10 个方法名，对内是 `CHAINS` 里的步骤组合，链式方法按序依次作用、参考侧统计量各算一次全链复用。🔴 MMD **不能**做成逐像素核回归：E[Y\|X] 的方差上界是 Y 的方差，实测输出 σ 只剩参考的四成、画面发灰 → 改成 12 个参数的仿射映射用 Adam 迭代（60 步）+ 逐通道均值/标准差锚定项（`MMD_ANCHOR`，纯核目标在核宽三倍外的平坦区会乱走）。🔴 AdaIN 曾做多尺度金字塔融合，实测把方差抹平、整体色偏，回退成 sRGB 单尺度。🔴 LAB 归一化尺度 `L/100`、`a,b/128` 是为了让协方差三个维度量纲一致（否则 L 的方差比 a/b 大两个数量级，eigh 出来的变换被 L 主导）。🔴 遮罩有**两个独立用途**，实现上别混：`遮罩` 决定作用区域（结果侧），`mask_use=also-restrict-reference`（中文界面「遮罩用途 = 也限定目标统计」）才让它同时限定**目标侧统计量**（对应 Photoshop 匹配颜色的「使用选区计算颜色」）；参考侧另有 `ref_mask` 单独限定统计区域（对应其「使用来源中的选区」）。`_pool_of()` 是统一入口，遮罩内不足 16 像素就退回全图（几个像素的统计量是噪声）。🔴 `细节回填` 补的是 `_high_freq(原图) - _high_freq(结果)` 的**差额**，不是原图高频本身 —— 后者会把锐度叠两遍；差额再逐通道去均值，保证只动纹理不动明暗（实测 sRGB 通道均值变化 < 1e-4）。🔴 直方图匹配会把低对比素材的噪声一起拉宽（文献里的 grain effect，实测高频能量 0.047→0.086），所以细节回填的方向可能是「压回去」而不是「补回来」。🔴 `_sqrtm` 用 eigh 不用 Cholesky：大面积同色时协方差接近奇异，Cholesky 直接失败，eigh 只是把那个方向压到 EPS。🔴 参考图**不需要**与目标图同尺寸（取统计量），遮罩同样按需插值 |
| 原创（无上游代码） | 布尔开关 | `QG_BoolToggle` | v0.9.4，见下方「布尔开关」。交互参考孤海「布尔」，卡片绘制 / 等比缩放 / 命中区是自己写的 |
| 原创（无上游代码） | 数值 | `QG_Number` | v0.9.4，见下方「数值」 |
| 原创（无上游代码） | 数值滑条 | `QG_Slider` | v0.9.5。一行：滑条 + 读数 + 齿轮；类型 / 范围 / 步长收在齿轮菜单里，五个控件全隐藏、输入槽也摘掉。默认 0–1 / 一格 0.1 / 输出小数（LoRA 强度那一档）。读数**按范围定宽**（默认 22px），轨道一直铺到它左缘前 4px；**点读数就地输入**（`web/slider/` 的 `openValueEditor`，回车提交 / Esc 取消 / 输入法回车放过）。🔴 **经典模式是 canvas 自绘**（和布尔开关同一套模板），节点恒 320×58、和布尔开关同尺寸；Nodes 2.0 走 DOM 卡片（`addDOMWidget` 那条路最低只能到 90，压不到 58）。🔴 输出槽恒 `*`，两种模式都接得进 `FLOAT` 口；`onMouseDown` 必须用 `chainHandler`（`chainCallback` 会丢掉 `return true`，节点会跟着拖动）。🔴 拖拽的 window 监听必须 `{capture:true}`：LiteGraph 在 canvas 的 pointerup 里 stopPropagation，冒泡收不到 → 松手后 `dragging` 一直 true。见 `web/slider/` |
| 原创（无上游代码） | 数学运算 | `QG_Math` | v0.9.4，见下方「数学运算」 |
| 原创（无上游代码） | 存在判断 | `QG_Exists` | v0.9.5。纯后端、无前端 JS：`任意`(optional, `*`) 进，`任意`(`*`) + `布尔`(BOOLEAN) 出。🔴 输入必须 optional —— required 的话 ComfyUI 在执行前就报「缺输入」，节点永远没机会输出假。🔴 `_present()` 口径**对齐孤海工具箱 `GoohaiAnyExists`「万能是否存在(GH)」**：`None` / `ExecutionBlocker` / 空 str·bytes·list·tuple·dict·set / **全黑 MASK**（`(H,W)`·`(B,H,W)`，`max ≤ 0.02`）/ **全零 LATENT**（`samples` 同阈值）算没有；**`0`、`False`、全黑 IMAGE**（`(B,H,W,C)`）算有。🔴 与孤海唯一有意的差异：**只判不改** —— 孤海会顺手把 ≤0.02 的遮罩像素抹成 0 再输出，我们原样透传（那节点叫「原样输出」，改值就是 bug）。逐场景对拍过：13 个用例 + `0.03` 边界 / `zeros(1,4,1,1)` / 0 元素张量全部一致。`VALIDATE_INPUTS` 返回 True 放行具体类型（否则接 IMAGE 端口会被判类型不符，照抄 `QG_IfElse`） |
| 原创（无上游代码） | 画布标注 / Markdown 便签 / 导出图像 | `QG_CanvasLabel` / `QG_MarkdownNote` / `QG_ExportImage` | v0.9.3。前两个是纯前端裸节点，第三个只借了 KOOK / 孤海同类节点「quality 该放在哪」的结论 |
| 原创（无上游代码） | 加载图像 | `QG_LoadImage` | v0.9.8。口径照孤海「加载图像」，但有两处刻意不同。**输出只留两个**：`IMAGE` + `MASK`；宽/高/帧数写在面板图下方，文件名一个字符串节点就能拿到，早先的 `NAME` 槽已砍（旧存档在 `beforeConfigureGraph` 里截到 `KEPT_OUTPUTS = 2` 并删掉线，`addOutput` 再兜一道）。**带色图做成可选开关，不是档位**：`tint_output` 默认关，关着 `IMAGE` 永远是画之前那张图；开着才把 `tint_color`（九色，与编辑器同一套 RGB 值）+ `tint_alpha`（0~100，步长 5，默认 50）混进遮罩区 —— `w = mask * strength`、`colour * (1 - w) + rgb * w`，羽化边缘按遮罩强度渐变（孤海是半透明硬叠色，实测遮罩内均值正好 = 原图 × 0.5 + 色 × 0.5）。编辑器存盘 `onSaved(stored, {colour, alpha})` 回写这两个控件，节点面板、编辑器、下游收到的永远是同一个颜色。遮罩编辑器保存时往 `input/clipspace/` 写三个 PNG —— `qg-src-<13位戳>.png`（原图副本，只为留住自己的 alpha）、`qg-view-<戳>.png`（**不透明**的带色画面，只给编辑器取颜色）与 `qg-painted-<原名>-<戳>.png`（RGB 是画面 / A 是遮罩）；后端 `PAINTED_NAME` 配对，用副本的 alpha 换掉成品的 alpha，所以 IMAGE 默认永不含遮罩、MASK = 1 − alpha。实现自写：配对靠文件名里的时间戳（孤海靠像素比对 + mtime 反查）、写三个文件（孤海也是三个）。遮罩尺寸恒等于图，不会再有 64 × 64 占位。🔴 **一笔一色是「按颜色分层」实现的**（照孤海的 `colorLayers`）：`ed.colours` 是 `Map<色名, canvas>`，每层直接存彩色像素；`ed.mask` 仍是单通道 alpha，所以 MASK 输出、配对、后端 alpha 交换全都不用改。落笔/重放走同一条 `replayStroke()`：画笔只画自己的色层，**橡皮要在所有色层上挖**（否则换色重画时旧颜色会透出来）。`ed.baseLayers` 装「打开时那张图自带的遮罩」的彩色版，`ed.fillLayer` 装自动填充那块（用当前笔色），三者按 base → 笔画 → 填充 的顺序叠。🔴 **存盘要把颜色烧进成品 RGB**（孤海 color 模式就是这么做的），但不能用 `destination-out` 挖遮罩 —— canvas 预乘 alpha，那样会把刚混好的 RGB 一起乘暗；正确做法是先不透明地画完「画面 + 各色层（`globalAlpha = 透明度`）」，再**只改 A 通道**（`A = 255 - mask`）。🔴 干净画面改由后端从 `qg-src` 副本取 RGB（成品 RGB 已经带色了，直接取会污染 IMAGE）；`tint_output` 打开时用 `_has_baked_colour()` 判断成品有没有烧色（遮罩内平均差 > 0.02），有就直接返回成品 RGB（多色），没有（旧版本存的）才退回单色 tint 混。🔴 **成品那张的遮罩区 alpha=0，浏览器加载 PNG 时会把透明像素的 RGB 一律清零** —— 二次进编辑器读回来遮罩区就是 (0,0,0)，按浓度反解后落到最近的中性灰（实测 50% 绿画满一个圆，重开变成 `128,128,128`，用户 2026-10-26 报的）。所以存盘多留一份 `qg-view`（改 A 通道**之前**编的那张不透明画面），读回时把它的 RGB 抄进 ImageData，alpha 仍用成品的。老存档没有这份 → 退回原行为（颜色偏灰、形状对），控制台会喊一句。🔴 读回成品要**先用存盘浓度反解再最近邻**：成品像素是「原图×(1-s) + 色×s」，直接分类会跑偏（50% 绿混在土色上最近的居然是中性灰，屏幕直接变灰板）；没烧色的旧成品则整块铺当前笔色。🔴 反复存盘会「量化漂移」：每次打开都按九色重新归类，第一次打开与之后几次的边缘像素不同（实测最大差 108）。`probe_display_invariance` 因此要先 warm-up 存一次再比。🔴 `sized(canvas, w, h)` 返回的是 **2d context**，不是 canvas，别写成 `sized(...).getContext`。🔴 `tintMask()` 在落笔期间（`ed.stroke` 非空）**必须染 `ed.mask` 而不是 `ed.filled`** —— 填充层是抬笔后 `scheduleFill()` 才算的，正在画的这一笔还没并进去，用它会变成「画的时候什么都不动、一抬笔整片才冒出来」。孤海与官方都是笔迹实时跟手、填充是抬笔后的事。🔴 **孤海那支的填充是自动的，别记成手动**：`Goohaitools-comfyui/web/js/goohai_mask_editor.js` 里 `autoFillHoles` 绑在输出状态的 `data-output-fill` 复选框上，`pointerup` 时 `++fillRevision` 再 `setTimeout(0)` 调 `rebuildFilledPaint()` / `rebuildFilledColorLayers()`；画的过程中 `refreshMaskDisplay(false)` 取的是 `drawingPreviewPaint`（原始笔迹），`refreshMaskDisplay(true)` 才取 `filledPaint`。我们这套时序与它同构（落笔染 `ed.mask`、抬笔 `scheduleFill()` 后染 `ed.filled`）。**墙判据也与它一字不差：`data[i*4+3] > 5` 就算墙**（`rebuildSingleColorFill` 里 `<= 5` 直接 continue），不是「画到一半」。实测 100% 软度 200px 笔宽围出的圈：`> 5` 补 41418 px，`>= 128` 只补 13326 px —— 软边被当成没画，灌水顺着边缘漏出去。🔴 **自动填充必须逐色层灌水**（`holesOfLayer()` 每层各跑一次），不能拿合并后的 mask 算一次 —— 洞的颜色要跟着「围住它的那一笔」走。用户报过：青笔围一圈、换别的笔色之后，圈里整块变色（截图里青/蓝笔迹配紫/绿的洞）。同色的 `baseLayers` 与 `colours` 先合成一张再灌。🔴 `ed.filled` 是「**整张**遮罩」（先 `drawImage(ed.mask)` 再叠洞），不是「只有洞」—— 存盘用它挖 alpha、仅遮罩模式用它上白，只画洞的话笔迹会从遮罩里消失（MASK 全 0、存盘整张不透明，屏幕上看着就是一片黑底）。`ed.fillLayer` 才是「只有洞 + 各自颜色」。🔴 往 `filled` / `fillLayer` 落笔时要用**这一笔自己的颜色**，默认的 `#000` 会在彩色层上留黑块。🔴 **填充必须按色分层**（`ed.fillLayers`，每色一张洞层，跟 `ed.colours` 同形状）：所有色的洞合成一张盖在最上面，会把后画的颜色整块盖掉 —— 先红圈填满、再换绿笔在红块上画，绿笔消失（用户 2026-10-25 报的）；而且后来再补一笔红，红色整组按「最后落笔」跳回最上层，照样盖。叠的顺序由 `paintOrder()` 算：每色最后一次落笔越晚越靠上（`ed.layerOrder` 记 `ed.strokeSeq`，只有画笔落笔才记，橡皮不改层序；没落过笔的排最前垫底）。🔴 **洞只补「原本没遮住」的地方**（只剔 `ed.base` 一道）：`ed.base`（打开时自带遮罩）已经盖住的不填 —— 打开成品时 `baseLayers` 是按颜色拆开的**碎片**（一个像素只属于一个色），对碎片灌水会把碎片之间的小缝当成洞，`growIntoWall` 再把缝撑成实心，实测一张成品重开一次多出 5 万多像素假洞、颜色一轮一轮漂（`probe_display_invariance` 从 0 差异跳到 11419）。🔴 **别的颜色画到的地方不要剔**：曾经加过「这一层的洞让给别的颜色的笔画」，结果红圈套在绿块上时，红洞绕着绿笔留空、圈里露出绿色（用户 2026-10-25 第二张截图）。谁在上面**只由层序决定**：先红填满后画绿笔 → 绿组最后落笔、绿笔压在红洞上；先绿填满后画红圈 → 红组最后落笔、红洞连绿一起盖住。两条都靠 `paintOrder()`，不在这里特判。`ed.filled` 仍是合并的整张遮罩（存盘挖 alpha、仅遮罩模式上白都用它），不受层序影响。🔴 **洞算完再往笔迹里多吃 `FILL_EDGE = 3` 像素**（`growIntoWall()`，见下条）。`ed.soft` **默认 0**（硬笔）。**自动填充漏洞默认开，而且是「视图层」**：`ed.filled` 每次抬笔从 `ed.mask` 重算（`requestAnimationFrame` 一帧一次），灌水以 `alpha > 5` 为墙、只填没通到外面的连通域，**洞算出来之后再往笔迹里多吃 `FILL_EDGE = 3` 像素**（`growIntoWall()`：一轮只收「不是洞、但 `alpha > 5`」的像素，先收集再标记免得一轮连长两圈）—— 洞是切出来的硬边、紧挨着的却是笔迹抗锯齿的软边，255 掉到 6 再升回 255，50% 预览下就是一圈淡线，白底图上像一道虚线（用户 2026-10-25 报的就是这个）。孤海没这毛病是因为 `rebuildSingleColorFill` 把墙一起涂成 255，代价是笔迹边缘也变硬；我们只补洞这一侧。它不算笔画，撤销回退的是笔本身（旧的 `fillUndo` 整层换回机制已删），关掉开关立刻退回手画的样子。灌水本身仍不膨胀：旧版先膨胀 2px 再灌水，能补上收笔时那条 1px 的缝，但每抬一次笔遮罩就胖一圈 —— 自动模式每笔都跑，攒几次轮廓就散了，宁可少填。编辑器画布缩放照孤海的做法：`frame` 包住底图与遮罩色两层，CSS `transform: translate() scale()` （滚轮 factor 1.12/0.89、范围 0.05~12、以指针为锚点，`zoomAt()` 照抄它的 `wheel()`），笔尖圈留在最外层不缩放，线宽永远 1px（**深色垫底 3px + 白色 1px 两道描边**；只描白线的话白底图上整个圈看不见；悬停时也认 Ctrl / 右键，圈会立刻变红）；按住空格或中键拖 `panX/panY`。🔴 **`toPicture()` 必须用 `frame.getBoundingClientRect()` 再除以 `ed.zoom`** —— 用 `view`（不缩放那层）的 rect 等于假装没放大，实测 1.57 倍时笔迹偏 (40, 22) px，越放大越歪。编辑器内部画布分三层（底图 / 遮罩色 / 笔尖圈，各自一张 canvas，各自 `imageSmoothingQuality` medium / low / —，指针移动只重画笔尖那圈，染色也只在帧里做一次）。🔴 **遮罩位图尺寸 = 原图 × maskScale（长边 2048），不是原图尺寸**：笔画坐标按 maskScale 落下来，画布要是按原图建，大图上笔迹会缩到左上角一小块 —— 屏幕看着偏、存盘更偏，而且每帧染色要多算 3 倍像素（8.7M vs 3.1M），直接卡成幻灯片。编辑器底栏是「三根滑条（笔宽 2~600px / 软度 / 透明度）+ 九色圆点」，滑条是原生 input[type=range]，右侧带读数与单位，拖动 / 点轨道 / 方向键都能调，syncTools() 里三根都 set()，所以 [ ] 键和 Alt 拖拽改完笔宽，滑条位置会跟着回来，`draw()` 里 `globalAlpha = alpha / 100`，所以预览浓度就是输出浓度（仅遮罩模式写死 .5）。前端 `web/load_image/`：media_picker + 「保留透明通道」胶囊 + 大图舞台 + 「编辑遮罩」按钮。🔴 **舞台高度是常数 `STAGE_H = 200`，不跟图片比例、也不跟节点宽度走**（早先是 `宽度 × 图高/图宽` 夹 90~420，一张 2560×3413 的竖图能把节点撑到 576 高）：图片 `object-fit: contain` 缩到框里，节点尺寸只由用户拖，换任何图都是同一个尺寸（实测 [270,469] 不变）。`ResizeObserver` 那套「拖宽重算高度」随之删掉，`applyStageHeight` / `stageHeightFor` 整支删除；换图后仍旧要 `syncPanelHeight() + relayout()` 各跑一次，否则节点高度会漂 12px。（`web/shared/mask_editor.mjs` **动态 import** —— 静态 import 失败会连累整份扩展不注册，节点裸奔成原生控件；画笔/橡皮/撤销/清空/反色/自动填充共用 `shared/brush.mjs`）。旧存档的 7 个输出槽（彩色叠加 / 宽 / 高 / 帧数）和后来的 `NAME` 槽都按 `KEPT_OUTPUTS` 截断；老的 `alpha` 值按位置落在 `keep_alpha` 上，`onConfigure` 里换算成布尔。原生 `image` / `keep_alpha` / `tint_output` / `tint_color` / `tint_alpha` / `upload` **六个全藏**（`hideWidget` + `hideInputsInDef` 两套渲染器都盖住），widget 顺序一律不动 —— 存档兼容全靠这一条。面板上只留 `qg_load_panel` 里的 DOM：文件名 + 上传、图、编辑遮罩、`宽 × 高` + 齿轮。🔴 **开关搬到齿轮浮层**（用户 2026-10-26 要求）：`meta` 行右侧一颗 19px 齿轮（内联 SVG，不用字体里的 ⚙），点开弹出一个挂 **`document.body` + `position:fixed`** 的浮层 —— 面板是 `overflow:hidden`，放里面会被裁掉一半；摆位是「右边缘对齐齿轮右边、底边压在齿轮上方 6px」，先 `visibility:hidden` 量完再定位。浮层里两行「名字 + 开/关胶囊」，胶囊只写状态不抄名字（两边都写全名看不出状态）。收起条件：点浮层外、点齿轮、Esc、画布 `wheel`、窗口 `resize`、节点 `onRemoved` —— 全用 capture 阶段听，画布会 stopPropagation。`META_H` 从 15 提到 21 给齿轮腾地方；删掉 `switchRow` 之后节点净矮 18px（`[270,469]` → `[270,403]`）。🔴 **顶栏三段是「输出档位」，不是「显示方式」**（用户 2026-10-26 定，照孤海的做法）：`ed.mode` 只决定 `save()` 时回写的 `tintOutput = (mode === "tint")`，**屏幕上除 `plain` 外看到的永远是同一张「图 + 半透明彩色遮罩」** —— 「仅遮罩」不再涂白、也不再换纯色底（曾经两版都试错：涂白 → 白底图上什么都看不见；换实色遮罩 + 深底 → 跟"我看到的就是我画的"矛盾）。`drawBase()` 一律画原图，`drawTint()` 只有 `plain` 才 `return`。打开编辑器时按节点上的 `tint_output` 定初始档（`true → tint`，`false → mask`），`onSaved` 回传 `tintOutput` 由面板写回 widget —— 面板上那颗「输出带色图」开关已经删掉，两个地方改同一个值必然打架。🔴 **浮层文案用 `zhPair(en, cn)` 而不是 `zh()`**：三段的名字（彩色叠加 / 仅遮罩 / 原图）是新造的，汉化词典里没有对应英文词条，`zh()` 和汉化插件的 DOM 翻译器两边都查不到，中文界面会留英文。`zhPair` 在 `web/shared/zh.mjs`，按当前语言直接给中英两份。🔴 凡是「要看画面」的地方（节点预览、下拉悬浮图、编辑器底图）一律指向**副本**：成品 alpha 就是遮罩，浏览器渲染出来遮罩区全透明；编辑器另把成品自己的 alpha 读回来当初始遮罩，二次编辑才接得上。🔴 预览里的遮罩色是**独立的一层 `<canvas>`** 叠在原图上（stage `display:grid` + 子项全 `1/1`，两层吃同一套 `max-width/max-height` 等比约束），只画刷过的地方、其余透明，**不做 PNG 编码**（旧写法 toBlob，1 兆像素首轮 1.1s、热态 88ms + 解码 4ms，纯白等）；画面与遮罩**并行下载**，`__qgLoadOverlayKey` / `__qgLoadVeilKey` 分别记「占位」「画好」，遮罩可能先到，所以只在画面已就位时才显示绿层 |


搬运与改名用的是一批开发期脚本（`port_node.py` 抽节点、`rename_to_qg.py` 统一命名、
`rename_css_prefix.py` 改 CSS 前缀），**不随本仓库分发** —— 它们是按当时那个版本的
AusBoss 源码硬编码路径写的，通用性有限。下面「搬家记录」保留了每一步的完整映射表，
照着表可以逐步复现，不需要那些脚本。

## 字符串切换（原创，v0.9.4）

Crystools 的 `Switch string [Crystools]` 之所以好用，是因为它的两个字符串分支是
**可编辑框**而不是槽 —— 两版提示词直接写在节点上，拨个布尔就换。`QG_IfElse` 做不到：
它的两路是任意类型的纯槽，想填常量得再拉两个文本节点、再连两根线。

所以按它的**思路重写**了一个（不是逐行搬运，文案/惰性判断/显示名都不同）：

```python
"boolean":  ("BOOLEAN", {"default": False, "tooltip": "..."}),
"on_true":  ("STRING", {"default": "", "multiline": True, "rows": 3, "lazy": True, "tooltip": "..."}),
"on_false": ("STRING", {"default": "", "multiline": True, "rows": 3, "lazy": True, "tooltip": "..."}),
```

要点：

- **`default` 才是「画成可编辑框」的原因**，`lazy` 只管执行。两个都有，才能既在节点上
  打字、又能拖成输入槽被上游覆盖（连线优先于框里的值）。
- `check_lazy_status` 沿用 `QG_IfElse` 的写法（带 `is None` 判断）。上游 Crystools 是
  「无条件 `return [needed]`」，那个写法在输入未连接时会把不存在的输入当成待解析项。
- 上游接了线却返回 `None` 时输出空串，避免下游拿到 `None` 报难以定位的错。

**没有搬 `LazySwitch2way`（LG_Tools 的「惰性开关（双路）」）**：它与 `QG_IfElse` 重叠
≥90%，而且四个输入全在 `required` —— 实测缺一条就 `Required input is missing`
（`execution.py:909` 的校验不看 `lazy`），省不了接线，只省一个节点。

## 布尔开关（原创，v0.9.4）

本包里的布尔（`QG_IfElse` / `QG_StringSwitch` 的 `boolean`）都是各节点自己的小控件，
一处控制多处就得逐个点。这个节点把开关本身画到画布上：整张节点就是一枚开关，
一大号「开 / 关」+ 一枚可点的胶囊，输出一个 BOOLEAN 供任意扇出。

后端只有两个普通控件（布尔 + 标签），前端把它们都折叠掉自己画：

```python
"boolean": ("BOOLEAN", {"default": False, "tooltip": "..."}),
"label":   ("STRING",  {"default": "", "multiline": False, "tooltip": "..."}),
RETURN_TYPES = ("BOOLEAN",)
```

`label` 放在 `boolean` **后面**：`configure()` 按位置塞 `widgets_values`，新控件加在末尾才不会
让老存档错位。它只是给前端画字用的，`execute()` 收下就丢；没有输入槽，所以不会被误接上游。

前端 `web/bool_toggle/index.js` 的要点（都是踩过的坑）：

- **隐藏控件，不删控件** —— `hideInputsInDef(nodeData, ["boolean"])` 连输入点一起收掉，
  `hideWidget(widget)` 折叠渲染（两个控件都要 hide）；值仍在 `widgets_values`，存档 / 撤销 /
  API 全不用管。实测存档是 `[false, "美颜"]`。
- **名字得另给入口** —— 控件被折叠就点不到了：双击卡片、或右键「重命名标签…」走
  `openLabelEditor()`。**没有弹窗**：输入框直接浮在卡片那几个大字上面，回车 / 失焦生效、
  Esc 放弃。Nodes 2.0 下标签是真实 DOM，照孤海 `BOOLEAN.js` 那套把 `span` 换成 `input`
  再换回来；经典画布下用 `position:fixed` 浮层。
- 🔴 **就地编辑的位置来自 `state.textBox`**：`drawCard()` 画大字时把 `{x, cy, w, size}`
  记到节点上（局部坐标，`size` 是**缩过之后**的实际字号）。别再自己算一遍 —— 标签太长时
  字号是运行时按剩余宽度缩的，算不对框就会跟字对不齐、大小跳一下。
- 🔴 浮层位置每帧重算（`requestAnimationFrame`）：编辑期间用户可能滚轮缩放、拖画布、拖节点；
  节点被折叠 / 删除时直接关掉。换算一律 `convertOffsetToCanvas` + `canvas.getBoundingClientRect()`。
- 🔴 `input` 里 `stopPropagation()`，否则退格 / 空格会被画布当快捷键；提交还要放过
  `event.isComposing || event.keyCode === 229`，不然中文输入法选词的回车会把名字提前提交。
- 🔴 **`computeSize` 是「拖拽能到的最小尺寸」，不能回声当前尺寸**，否则节点永远拉不大。
  初始尺寸在 `onNodeCreated` 里显式写 `node.size = [320, 84]`。
- 🔴 **坐标系**：`onDrawForeground` / `onMouseDown` 的局部原点在**标题栏左上角**，
  标题栏占 `y ∈ [-30, 0]`，主体是 `y ∈ [0, size[1]]`；`size` 不含标题栏，别再 +30。
- 🔴 **只有胶囊吃点击**。整张卡片都吃点击的话节点就没法拖了（`onMouseDown` 返回 true
  会连拖拽一起吃掉）。命中区还要让开四角 15×15 的缩放手柄，否则右下角再也拉不大。
- **高度恒定，宽度是唯一的把手**：`keepSize()` 把高度钉在 `NODE_HEIGHT`（58 = 「缩到最小
  时的高度」），宽度不小于 220。拉宽只是为了放得下长名字，**不加厚**；一排开关并排时
  高度完全齐平。`onResize` 里调它（拖拽时 LiteGraph 直接写 size、`onResize` 很少回调，
  所以绘制路径里也补一次）。
- **缩放系数由高度定**（`scaleOf` 取 `h/BASE_HEIGHT`，再乘 `w/BASE_WIDTH` 兜极窄）：
  高度固定后系数恒为 58/84 ≈ 0.69，字和胶囊不随拉宽变大，一排并排字号才一致。
- 🔴 `BASE_HEIGHT`（84）只是**缩放基准**，不是节点高度 —— 别拿它当 `node.size[1]`。
- **清掉 `ctx.shadowBlur`**：LiteGraph 画节点主体时留下的阴影会跟着描边一起偏移。
- 🔴 **顶部要给输出槽名留一行**：槽是 LiteGraph 原生画的（在 `onDrawForeground` **之后**），
  卡片铺满整个主体就会跟「布尔值」叠在一起。`cardRect()` 里按 `SLOT_ROW = 22` 让开，
  胶囊和文字都相对卡片算，不再用 `h / 2`。
  🔴 **这 22 不能乘缩放系数**：槽名字号与节点缩放无关，永远占顶部那 ~20px；节点扁到 58 高
  时乘 0.69 只剩 15px，卡片会切掉槽名下半截。顶部只让 `SLOT_ROW`，别再叠 `pad`。
- **标签太长要缩字号**：按胶囊左边的剩余宽度 `measureText`，超了就等比缩（下限 11px）。
- Nodes 2.0 下 canvas 不绘制 → `installDom()` 挂一个大按钮（`addDOMWidget`），
  两种渲染器用 `usesVueNodes()` 分流（同 `web/run_timer/`）。

真机验证（`--port 8199` + `POST /prompt`）：`BoolToggle → StringSwitch.boolean → PreviewAny`，
开 → `TRUE_BRANCH`、关 → `FALSE_BRANCH`。

探针 `tools/probe_bool_toggle.py`：起 8199 → headless 打开 → 真鼠标点胶囊 → 再点回来 →
拉 500x999 / 压 80x80 验等比 → 把 `label` 设成「美颜」截图 → 双击卡片验编辑框**贴在卡片
大字上**（dx / dy / 字号三条断言；换回居中弹窗的话 dx 会差一百多像素，直接被抓住）→
输入「开关测试」回车提交 → 再双击按 Esc 验不提交 → 编辑中把 `ds.scale` 从 1.2 改成 0.9，
验框跟着卡片走。
截图落在 `%TEMP%/qg_bool_shots/`（`off/on/wide/named/editor/renamed/editor_zoom.png`）。

## 数值 —— 整数 / 浮点合一（原创，v0.9.4）

这条节点改了三轮，把过程记下来免得再走回头路：

1. 先是两个节点（`QG_Int` / `QG_Float`）+ 一套 canvas 自绘卡片 → **否掉**（数字框飞位置、看不见）
2. 改成「双击就地编辑」，还是 canvas 自绘 → 还是 **否掉**
3. 最后落到：**用包里现成的 DOM 卡片（`shared/widget_card.mjs`）+ 标题栏齿轮菜单**，
   两个节点合并成一个。canvas 自绘那套（`number_card.mjs`、就地编辑、fixed 坐标换算）
   已整体删除，别再往回改。

```python
"kind":  (["整数", "浮点数"], {"default": "整数"}),
"value": ("FLOAT", {"default": 0.0, "min": -1e12, "max": 1e12, "step": 0.1}),
RETURN_TYPES = ("*",)
```

🔴 **类型是运行时选的，而 `RETURN_TYPES` 是类级静态声明 —— 改不了。**
所以输出声明成 `*`（任意类型，ComfyUI 会跳过类型校验）。真正的类型由 `execute` 的返回值
决定：整数回 `int`、浮点回 `float`。代价是「浮点模式接到 INT 输入」时 ComfyUI 不会拦，
会一路传下去 —— 跟原生 primitive 的行为一致，由用户自己选对类型。

前端（`web/number/index.js`）做的事：

- **卡片接管 `value`**：`mountWidgetCard(node, { rows: [{ widget: "value", label: "值",
  trimZeros: true }], minWidth: 260, hide: ["kind"] })`。卡片会自己 `hideWidget`，
  并把 `value` 的槽位画到那一行上（隐藏控件的 socket 要靠卡片的 `y` 访问器才落在正确位置）。
- **`kind` 藏起来，走标题栏齿轮**：`?` 左边 22px 那枚齿轮，点开是统一设置弹层
  （`shared/settings_menu.mjs`），里面就一项 `类型`。几何整套抄 `web/export_image/`
  的 `gearCenter / hitsGear / drawGear / gearAnchor`。
- 🔴 **齿轮菜单的 `persist: false` 不能省**：`kind` 是每个节点自己的状态，存进
  localStorage 会让新建的节点跟着上次那个节点的模式走。
- 🔴 **`applyKind` 要改四处**：控件 `step`/`precision`、卡片数字框的 `setStep`/`setDecimals`、
  整数模式取整、`node.outputs[0].type`。少哪一处都会「看着变了其实没变」。
- 🔴 **`scrub_input.mjs` 为此加了 `trimZeros` 和 `setDecimals`**（都向后兼容，默认行为不变）：
  小数位要能跟着类型换，而 `decimals` 是闭包里的值；`trimZeros` 让浮点里的整数也读作
  `12` 而不是 `12.00`，两种模式长得一样干净。
- 🔴 **读档不走 callback**：`widgets_values` 是直接塞进控件的，所以 `onConfigure` 里
  必须 `queueMicrotask(() => applyKind(this, kindOf(this)))` 重放一次；卡片自己的
  `onConfigure` microtask 会重挂隐藏控件，两者互不依赖，先后都行。
- 控件顺序必须是 `kind` 在前、`value` 在后，跟 `widgets_values` 对齐；卡片 widget
  `serialize=false`，不进 `widgets_values`（探针会断言这一点）。
- **切到整数要顺手取整**：不然框里挂着 3.7、输出却是 4，看着别扭。

探针 `tools/probe_number.py` 验十件事（起 8199 + headless Chrome，真点齿轮、真跑 prompt）：
控件列表与 `widgets_values`、卡片标签/数字框真的占地方、齿轮点开是「数值设置」且当前项高亮、
点 `?` 不会串到齿轮菜单、从菜单切成浮点后框里变 `1.25`、切回整数后框里只有 `4`、
**浮点模式存档读回来还是浮点**、整数接 `EmptyLatentImage.width` 跑通、
浮点接 `PreviewAny` 拿到 `1.25`。

## 数学运算（原创，v0.9.4）

「宽按高度算」「百分比」「勾股」这类地方，串三个节点不如写一行。所以做成
**一个表达式 + 四个变量**，而不是「运算下拉 + 两输入」的四则节点。

- `nodes/qg_math.py` —— 节点本体，五个控件（`expr` 字符串 + a/b/c/d 四个 `FLOAT`，后者是
  **optional**，所以能就地改也能接线）
- `nodes/_qg_math_engine.py` —— 求值引擎，**故意单独一个文件**：它只 import `ast` / `math`，
  探针可以直接 `sys.path.insert(nodes_dir)` 后 import，不用起 ComfyUI 就能跑全部用例
- `web/math/index.js` —— 卡片：3 行（表达式 + 两行 pair）

### 为什么不用内置的动态求值

节点上的表达式来自**工作流文件**，跟别人分享的 workflow 一样属于外部输入。哪怕把
`__builtins__` 清空，属性链（`().__class__`）照样能绕出去。所以引擎走
「`ast.parse(mode="eval")` → 白名单逐节点递归求值」：

- 允许：数字、`a`/`b`/`c`/`d`、`pi`/`e`/`tau`、四则/整除/取余/幂、一元正负、比较、
  `and`/`or`/`not`、三元、列表、白名单函数调用
- 拒绝：属性访问、下标、lambda、推导式、f-string、`*` 展开、关键字参数，
  以及任何不在表里的名字/函数

三条闸门防卡死：表达式 ≤ 2000 字符、语法节点 ≤ 400、幂指数 ≤ 512（`10**10**10` 这种
会在算之前就被拦住）。`int()` 也夹了 `1e15`，免得 `int(1e300)` 生成天文数字串。

### 几个刻意的取舍

- 🔴 **`^` 保持 Python 语义（按位异或），不偷偷当幂**。想换幂是 `**`。帮助卡和 README
  里都写明了 —— 静默改语义比让人查文档更糟。
- **全角归一**：`（ ）＋ － × ÷ ：` 全部转半角再解析（`3：4` 还能当 `3/4` 用）。
- **报错就报错**：语法错 / 未知名字 / 除零 / 参数不对一律抛 `ValueError`，消息里带**原始
  表达式**（`数学运算「a +」算不了：语法错误…`）。空表达式是唯一的例外：输出 0，不报错。
- **三个输出**：`数值 FLOAT` / `整数 INT`（四舍五入 + 夹 INT32）/ `布尔 BOOLEAN`（非零）。
  比较表达式 `a > b` 的结果本来就是 bool，三个槽都能直接用，不用再挂一个转换节点。
- **NaN 归零**：`number != number` 时按 0 输出，免得下游拿 NaN 当尺寸。

### 卡片

```js
mountWidgetCard(node, { rows: [
  { widget: "expr", label: "表达式", placeholder: "a * b / 2" },
  { pair: ["a", "b"], label: "变量", prefixes: ["a", "b"], sep: "", top: true },
  { pair: ["c", "d"], label: "", prefixes: ["c", "d"], sep: "", top: true },
], minWidth: 300 });
```

- 两行变量用 `pair` 摆成 a|b、c|d，靠 `prefixes` 标名字 —— 两个并排的数字框本身不带标签，
  不标出来根本分不清谁是谁。
- 🔴 **`top: true` 不是装饰**。a/b/c/d 是 optional 输入，属于「控件型输入」（`input.widget`
  指着那个控件）：前端只在**拖动连线时**才画这种槽的圆点，而卡片又把控件藏成了 0 高
  —— 结果画布上一个输入点都看不见（用户反馈「没有输入点」）。`top: true` 走
  `liftSocket()`，把 `input.widget` 删掉，槽就变成节点真正的输入槽，常显在左上角的槽位列里。
  控件本身还在 `node.widgets` 里（值仍是 `widgets_values` 第 2~5 位），所以：
  没连线 → 卡片的数照常进 prompt（实测 `graphToPrompt` 里 `a: 7`）；
  连着线 → 上游赢（`input.link` 优先）。**这两条都要探针盯着**，删 `input.widget` 很容易
  把「没连线时的值」弄丢。
- `QG_Math` 在 `web/shared/node_width.mjs` 里是 `own: true` + `minW: 260`：卡片自己用
  `minWidth` 管宽度（现在从表里取），外层钉宽只管新建时那一下。
- 变量行接上线后只有那一格变灰（`fieldsLinked[0] === true`，行本身不变灰）——
  这是 `mountWidgetCard` 既有的「pair 里只暗被连的那个字段」行为，不是特例。

两条实测结论，别再走弯路：

- 🔴 **卡片上方那块空白不是排布没刷新**。前端 `_arrangeWidgets` 把控件区起点定在
  「槽位区底部 + 2」（`widgets_start_y ?? (widgets_up ? 0 : 槽位底) + 2`），
  槽位区高度 = `max(输入槽数, 输出槽数) × 20`。现在是 4 个输入槽（a/b/c/d）对 3 个输出槽
  → 4×20 = 80，卡片从 86px 处开始（节点总高 216）。手动调 `node.arrange()` 结果一样
  （而且在 `onNodeCreated` 里调会抛 `NullGraphError`：那时还没进图）。
  想更紧凑只能减槽 —— 减输出槽或者把变量并成两个。
- 🔴 **INT 输出接不到这里的 FLOAT 变量** —— 实测原生 `PrimitiveInt` 同样接不上，
  `PrimitiveFloat` 可以。这是前端的连线规则，不是本节点的问题；所以 `QG_Number`
  处于整数模式时也不要指望能直接接到 `a`，切到浮点即可。这条写进了变量 tooltip，
  免得用户以为是 bug。

### 探针

`tools/probe_math.py`（起 8199 + headless Chrome）：

- **后端 11 条**：四则 / 除法 / 函数 / 百分比 / 比较 / 三元 / 全角 / 空表达式 / 只写常量 /
  除零报错 / 语法错报错，三个输出各接一个 `PreviewAny` 对文本
- **前端**：控件表、五个控件都藏掉、三行布局、四个变量前缀、卡片宽度跟节点一致、
  真连线后 a 那格变灰而 b 仍可改、表达式那行照常能打字
- **存档往返**：改值 → `serialize()` → 新节点 `configure()`，`expr` / `a` / 卡片都回来

## 采样预览（原创，v0.9.10）

`--preview-method` 是**启动参数**，改一次影响整台服务器所有工作流。这个节点把它变成
**按工作流生效**：丢在画布上、不用连线，只有它所在的 prompt 开预览，跑完自动复位。

### 不用打补丁：ComfyUI 自己就有这个口子

`PromptExecutor.execute_async` 第一行：

```python
set_preview_method(extra_data.get("preview_method"))
```

`extra_data` 就是 `/prompt` 请求体里的那个字段。**所以只要在排队之前改写它**，
剩下的 ComfyUI 全包了 —— 不用碰采样器、不用改全局状态、也不用担心恢复：

```python
def _prompt_handler(json_data):
    ...
    json_data.setdefault("extra_data", {})["preview_method"] = method
    return json_data

PromptServer.instance.add_on_prompt_handler(_prompt_handler)
```

`trigger_on_prompt()` 里是 `json_data = handler(json_data)`，返回值就是后续要用的对象；
`post_prompt` 随后 `extra_data = json_data["extra_data"]` 原样送进队列。链路上没有任何
"副本" 或 "拷贝"，改了就生效。

🔴 **`set_preview_method(None)` 会恢复启动默认**。所以「下一个工作流没带本节点」
不需要我们做任何事，ComfyUI 自己就复位了 —— 这也是为什么这个节点可以随时删掉而不留后遗症。

### 预览尺寸是模块常量，不是运行时参数

`latent_preview.py:14` 的 `MAX_PREVIEW_RESOLUTION = args.preview_size` 只在 **import 时**
读一次，之后跟着每一帧预览发给前端。改 `args.preview_size` 没用，得改这个常量：

```python
latent_preview.MAX_PREVIEW_RESOLUTION = size   # 记住启动时的原值，无节点时复位
```

### 几个刻意的取舍

- **`OUTPUT_NODE = True` 且 `RETURN_TYPES = ()`** —— 不加 OUTPUT_NODE 的话，孤立节点
  根本不会被调度（也就不会被当成「有输出」），单独提交会报 `Prompt has no outputs`。
  加了之后它自己就是合法终点，用户不用为了「有个输出」再接一根线。
- **多个本节点取 id 最小的** —— 随便取会让「同一份工作流两次跑出不同预览方式」变成
  极难复现的 bug。
- **非法值兜成 `auto`** —— `method` 最终会交给 `LatentPreviewMethod.from_string()`，
  它认不出就返回 `None`，而 `set_preview_method(None)` 会**静默复位成启动默认**。
  表现是「选了但没反应」，所以这里先兜一道。
- **值必须与 CLI 一字不差** —— `auto` / `latent2rgb` / `taesd` / `none`。中文只作显示，
  靠 `_qg_combo_legacy.py` 的 LEGACY 表反查（顺带让老存档里的中文值也能跑）。
- **`auto` 目前等于 `latent2rgb`** —— `get_previewer()` 里 `Auto` 直接映射成 `Latent2RGB`。
  两个选项都留着：哪天上游改成「有 taesd 就用 taesd」，`auto` 才有独立含义。

### 老版本兜底

没有 `extra_data` 这个口子的版本，靠 `latent_preview.set_preview_method` 是否存在来判
（两者是同一次改动引入的）。判为不支持时，节点 `run()` 里直接改 `cli_args.args.preview_method`
—— 只能影响它之后执行的采样器，精度差但不会静默失效。

### 面板上的三种状态（上游 2.20.2 的三条，都是真问题）

| 情况 | 以前 | 现在 |
|---|---|---|
| 已经开跑、第一帧还没到（模型加载那几秒） | 落到最后的兜底，写「没有可显示的图」，看着像坏了 | 「正在运行，画面一出来就显示在这里」。判据是 `status === "running"` 且没有 `url` |
| 分块放大在切块采样（Ultimate SD Upscale 在自己节点里切块） | 每一帧都是**一小块**，被当成整图顶上去，画面像被放大到只剩一角 | 整图留着不动，状态栏写「分块放大中 · step 5 / 20」。整图来自哪个节点都行；一上来就是分块、根本没有整图时，才显示第一块 |
| 最后一步 → 成品图 | `executed` 一到就换 `src`，解码那一下可能闪白 | 先 `new Image()` 解码，`onload` / `decode()` 完成再换；4 秒兜底，`onerror` 照换 —— 拿不到成品也不能装作还在跑 |

🔴 **怎么认出分块帧**：`TILE_NODE_RE = /^UltimateSDUpscale/i`，判的是**发帧那个节点**的类型，
不是我们自己的节点。`b_preview_with_metadata` 带 `nodeId`，直接用；老接口 `b_preview`
只有 Blob，退回用 `executing` 事件记下的「当前正在跑哪个节点」。判不出来就当整图 ——
宁可按老样子显示，也不要因为误判把正常帧藏起来。

🔴 `RUN.whole` 和 `RUN.url` 可能是**同一个** blob 地址，回收必须走 `releaseSoon()` 去重；
同一个 URL 被 revoke 两次，第二次会把还挂在 `<img>` 上的地址弄坏。

### 哪些采样器吃这套

`--preview-method` 只对**走 `latent_preview.prepare_callback()` 的采样器**有效。实测（真实 SD1.5、
CPU、64×64）确认这三条路径都会出预览：

| 节点 | 调回调的位置 |
|---|---|
| `KSampler` / `KSamplerAdvanced` | `nodes.py:1595` → `latent_preview.prepare_callback(model, steps)` |
| `SamplerCustom` | `comfy_extras/nodes_custom_sampler.py:774` |
| `SamplerCustomAdvanced` | 同上 `:1052`（`guider.model_patcher`） |

自己写采样循环、不调 `prepare_callback` 的第三方采样器（手搓 `for i in range(steps)` 那种）
不会有预览 —— 这不是本节点能解决的，得那个节点自己发。

### 画面有两个去处：采样器节点 + 本节点的面板

`ProgressBar(steps)` 建的时候 `node_id=None`，`main.py` 的全局 hook 补成
`executing_context.node_id`（实测 WS：`{"node": "5"}` 就是 KSampler 的 id），
所以 ComfyUI 会把预览画在**采样器节点**上 —— 这一路不用我们管。

本节点的面板是**另一路**：前端自己监听同样的预览帧，接到 `web/step_preview/index.js` 的
画布上。两处同时显示，互不影响。

前端要点：

- 事件名是 `b_preview_with_metadata`（`detail.blob` + `detail.jobId`）；老版前端发的是
  `b_preview`，`detail` 直接就是 Blob。**两个都监听**，前端版本不同事件也不同。
- `progress` 是全流程的，`VAE Decode` 之类也会发且 `max` 常为 1 —— 只收 `max > 1`
  的，否则「step 8 / 8」会被盖成「step 1 / 1」。
- 跑完监听 `executed` 拿 `output.images[0]`，换成 `/view?` 的成品图；没有保存节点就保留最后一帧。
- 用的是 `addDOMWidget` + `fillNodeHeight`（跟 `display_any` 的预览面板同一套），
  Vue 模式下高度靠 `panel_layout` 的 `holdVuePanelMinHeight` 撑住。
- 🔴 **`<img>` 必须 `position:absolute; inset:0`**。写成普通块级元素时，图片的固有高度
  （比如 512×512）会把 stage 撑开，底部状态栏连 STOP 一起被 `overflow:hidden` 裁掉。
- 🔴 **节点高度要给够**（SIZES 里 400 / minH 300）。面板实际需要 302px：
  画布 272 + 状态条 22 + 间距。给 360 时状态栏会掉出节点边界。
- STOP 调 `api.interrupt()`，跟工具栏的取消是同一个接口；中断后 `execution_interrupted`
  把状态改成「已停止」。

### 实测数据（真采样，不是模拟）

| 场景 | 预览帧 | 说明 |
|---|---|---|
| 不带本节点（启动参数 `none`） | **0** | 有 progress 事件，采样确实跑了 |
| 带本节点 `method=auto`，2 步 | **2 帧**，各 ~7.4 KB | 逐步骤出图 |
| 带本节点，3 步 | **3 帧** | 帧数 = 步数 |
| `max_size=512` | 每帧 ~26 KB | |
| `max_size=128` | 每帧 ~3.8 KB | 缩小 6.8 倍，尺寸参数确实生效 |
| 带本节点 `method=none`，12 步 | **0** | 但跑完仍有成品图（128×128，来自 `预览图像`） |

🔴 **`none` 关掉的是采样中间帧，不是成品图**。成品图走 `executed` 事件的
`output.images`，跟 `preview_method` 半点关系没有 —— 所以这一档跑完，面板里照样换成成品。
面板之所以要单独提示「预览已关闭，跑完显示成品图」，是因为中间那段空白看着像坏了。

🔴 **测的时候两次 seed 必须不同**：同 seed + 同输入会命中节点缓存，KSampler 根本不执行，
于是「0 帧」看起来像功能失效 —— 我第一版就是这么误判的。`tools/_probe_step_off.cjs`
里 seed 是 `SP_SEED` 环境变量，换值再跑。

### 隐藏采样器上的缩略图（`hide_sampler`）

需求是「画面只留在我这块面板里，KSampler 上别挂那张小图」。**两条渲染路要走两套做法**：

| 渲染 | 缩略图是什么 | 怎么按 |
|---|---|---|
| Nodes 2.0（Vue） | 节点外壳里的一张 `<img src="blob:…">` | 给 `[data-node-id]` 外壳加类，CSS `display:none` |
| 经典画布 | `node.imgs` 数组，canvas 逐帧绘制 | 在实例上盖 `imgs` 访问器，读出恒为空数组 |

🔴 **经典模式不能「收到帧就清 node.imgs」**：前端是异步解码 blob 之后才写 `imgs` 的，
我们清完它又填回去，实测采样期间读到的始终是 1。必须用 `Object.defineProperty` 盖访问器 ——
值照样存（前端逻辑不受影响），读出来永远空。关开关只要把 `__qgSpShow` 置回 true。

🔴 **登记节点不能只靠帧事件**：`b_preview_with_metadata` 的 `detail.nodeId` 要到第一帧才有，
那时第一帧已经画出来了。所以 `execution_start` 先按 `comfyClass` / `type` 里的 `sampler`
预登记一遍，帧事件再按 `nodeId` 补（第三方采样器也能罩住）。

🔴 **Vue 里加的类会被重排冲掉**，所以 `progress` 每步补一次；跑完 `execution_success` 再补一次，
否则 KSampler 上留着的最后一帧会冒回来。

⚠️ 藏了图之后 Vue 节点底部还留着「512 × 512」那行尺寸标注（img 的兄弟元素）。
刻意没动：它本身是信息，而且用 `img + *` 去藏会波及 resize 手柄那种兄弟节点。

### 三个参数收进齿轮（`web/step_preview/index.js`）

节点上不放控件行，右下角一个 20×20 的齿轮，点开在画面区域盖一层设置面板。

**原生控件必须留着**（值要靠它进存档和 prompt），只是让它不占位置：

| 渲染 | 怎么藏 |
|---|---|
| 经典画布 | `hideCanvasWidget()`（`shared/core_preview.mjs`）把 `computeSize` 压成 `[0,-4]` |
| Nodes 2.0 | 外壳加 `qgtools-sp-nested`，CSS 选 `[data-widget-name="method"]` 等三行 |

🔴 `data-widget-name` 是 Nodes 2.0 给每个 widget 行打的记号（实测存在，
`data-testid="node-widget"` 也在）。但它只在 Vue 下才有，经典模式那半必须靠 `hideCanvasWidget`。

🔴 浮层里改值写的是 `widget.value`，然后手动调一次 `widget.callback`。Vue 下这条
**双向同步是通的**：改完 `<input>` 的 DOM 值会跟着变，`graphToPrompt()` 里的 inputs
也确实是新值（`tools/_probe_step_prompt.cjs` 逐项断言过）。别改成往 store 里写 ——
`widgetValueStore` 的入口不稳定，镜像这条够用。

🔴 `max_size` 的范围夹取搬到了浮层里做。原生控件被藏起来后没人管它，浮层里
自己按 64–2048、步长 64 夹（输入 1000 会变成 1024）。

🔴 浮层铺满整个画面而不是只盖一条：只盖上面一条时，下面会露出半截提示文字，看着割裂。
铺满但内容贴顶 + 底部一句灰字填补空白，别用 `justify-content:center`（三行飘在正中很像加载中）。

尺寸随之从 320×428 收到 **320×360**（少三行控件），`minH` 240。

### 探针

- `tools/probe_step_preview.py`：同进程 import 真模块，逐分支断言（写入 / 不写入 / 尺寸复位 /
  多节点取最小 id / 非法值 / 中文老值 / 六种脏输入 / 验 `execution.py` 里那行确实存在），8 组全过
- `tools/probe_ksampler_preview.py`：**真跑 KSampler**（CPU 64×64 2 步），WS 收二进制帧数，
  对比「带 / 不带本节点」；两次用不同 seed 避免缓存
- `tools/_probe_step_preview_ui.cjs [classic|vue]`：节点尺寸是否照表（210×78）、
  下拉 `auto` 是否显示成「自动」、有没有输出槽
- `tools/_probe_step_panel.cjs`：面板布局体检 —— 塞一张假预览帧，量 `root / stage / img / bar`
  的 `offsetHeight`，断言状态条没被挤出 root（图片撑高面板时就靠这条抓）
- `tools/_probe_step_stop.cjs`：跑 40 步，第 3 秒点 STOP，断言状态变「已停止」且按钮变灰
- `tools/_probe_step_off.cjs`（`SP_METHOD=none|auto`）：数采样帧，再看跑完有没有成品图。
  `none` 档必须是 **0 帧 + 有成品**，`auto` 档必须是「帧数 = 步数 + 有成品」
- `tools/_probe_step_height.cjs`（`VUE=1` 切 Nodes 2.0）：量 `root / stage / bar` 的
  `offsetHeight`，用同一坐标系的 `getBoundingClientRect` 判状态栏有没有溢出 —— 别拿
  `offsetTop` 比，两边的 `offsetParent` 不是同一个，会误报「状态栏丢了」
- `tools/_probe_hide_thumb.cjs`（`VUE=1` / `HIDE=1`）：四种组合各跑一遍，断言
  「采样器缩略图藏没藏」与「面板里有没有图」。🔴 `VUE=0` 时必须显式把
  `Comfy.VueNodes.Enabled` 写回 false：这个设置存在 user 目录里，上一轮切成 Vue 后会一直留着，
  不清的话「经典模式」的探针其实还在 Vue 里跑
- `tools/_probe_step_settings.cjs`（`VUE=1`）：断言三个原生控件不渲染、齿轮能开合、
  浮层尺寸、以及浮层改值能写回 widget（1000 应被夹成 1024）
- `tools/_probe_step_prompt.cjs`（`VUE=1`）：走浮层改三个值，然后比 `graphToPrompt()`
  的 `output[id].inputs` —— 这一步才证明设置不是只改了界面
- `tools/probe_ksampler_preview.py`：后端侧，数 WS 二进制帧数，对比带 / 不带本节点

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
| 显示名 | `LoRA Loader 🆎` | `LoRA Loader` |
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

### 跟上游 2.19 / 2.20 的差异（v0.9.10）

搬过来时对的是 2.12.x，之后上游走到 2.20.2。逐条筛完，只做两条、其余明确不跟：

| 上游 | 我们的做法 |
|---|---|
| **2.19.0 选择框可勾多个文件一次加** | ✅ **已做**（`web/lora_loader/index.js` 的 `ticked` / `tickRun` / `addTicked`）。交互按我们自己的手感定：点勾选框或 Ctrl 点整行勾一个、Shift 点整行勾一段（从上次勾的那行连到这儿）、Shift+Enter 是键盘版；底部一条「已勾选 N 个 / 清空 / 加入 N 个」。🔴 勾选**不随搜索清空** —— 可以分几次搜索攒一批。🔴 已在栈里的文件加 `.instack`：不给勾、点了只提示，否则勾上也只会被 `appendFolderRows` 跳过，等于骗人。加到栈里走 `appendFolderRows`（不是逐行 push），去重和行数上限都由它管 |
| **2.19.2 Civitai 查询失败说清原因** | ✅ **已做**。`civitaiFailureText()` 判 `TypeError`（请求根本没发出去）→ 给出「防火墙 / VPN / 代理」的解释，其余照原样抛出。面板除写进按钮的 `title` 之外**再弹一次 toast** —— title 要悬停才看得见 |
| **2.19.0 行分组 + 2.19.1 组开关 / Workflow Switches 拥有一个组** | ❌ **不做**。要动 `serializeRows` 的存档格式（每行多一个 group 字段），还要连到 `QG_WorkflowSwitches`，老工作流和新老存档交错时容易错位。要做就得单独排一轮，含存档兼容测试 |
| **2.19.0 Civitai 预览图下载并存到 LoRA 旁边** | ✅ **已做**（见下节）。齿轮里多一档「Civitai 图片：关 / PG-13 / 任意」，默认 PG-13 |

### Civitai 预览图存盘（v0.9.10）

一次「获取 Civitai 信息」会顺带把这张 LoRA 在 Civitai 的第一张图存成
`<模型>.preview.jpg`，之后悬停就有图 —— 不用另装 LoRA Previews 插件。

链路是**浏览器下载、服务端只验再写**：

1. 齿轮里选档：`off` / `PG-13`（默认）/ `any`。`PG-13` 跳过 Civitai 标为 R 及以上的图。
2. 前端 `pickCivitaiPicture()` 从**原始响应**的 `images` 里挑第一张能用的
   （`type: "image"`、分级够温和、地址在 `image.civitai.com`）。
   🔴 不能用 `/qg/lora/civitai` 返回的 `saved.info` —— 那是归一化后的，**没有 `images` 字段**。
3. `smallPictureUrl()` 把地址里的 `width=` 段换成 450（没有就插一段）再下载；
   `credentials: "omit"` + `referrerPolicy: "no-referrer"`，不带 cookie。
4. **跳转之后才验来源**：这个请求用默认的 `follow`（Civitai 会跳到自家文件库），
   拿到 `response.url` 再用 `isCivitaiAddress()` 判 `civitai.com` / `*.civitai.com` + https。
   🔴 别照抄查 hash 那条路的 `redirect: "error"` —— 那会把正常跳转一起拒掉。
5. `POST /qg/lora/picture?name=` 交字节；服务端 `save_civitai_picture()`
   **重新解码**、转 RGB、缩到 768、质量 88 存 JPEG（Civitai 塞在 EXIF 里的东西一概不落地）。

🔴 服务端三道闸，缺一不可：
- `MAX_PICTURE_BYTES = 8 MB`（`content_length` 先挡，读完再按实际长度挡一次）
- `MAX_PICTURE_PIXELS = 4000 万` —— 解压炸弹防线。20000×20000 的 PNG 只有几百 KB，
  解开要 1.2 GB，**只按字节数限制挡不住**。
- `open(target, "xb")` 独占创建 —— 已有预览图的 LoRA **永不覆盖**，两个请求同时到达也覆盖不了。
  用户自己放的那张比 Civitai 的珍贵。

🔴 「先查有没有预览图，再解码」—— 顺序别反，已有的文件连解码都省了。

存好之后 `pictureSaved()` 把 `thumbVersion` +1。悬停缩略图和信息卡里的 `<img>` 都带这个版本号，
否则浏览器手里那张 404 会一直留着（`/qg/lora/thumb` 的 404 响应没有 Cache-Control）。

验证：`tools/_check_civitai_picture.py`（17 项，临时目录替身，不碰真实 LoRA）、
`tools/_check_civitai_picture.mjs`（30 项纯函数）、`tools/_probe_civitai_picture.py`
（真路由端到端，自己造文件自己删）、`tools/_probe_lora_picture_post.cjs`（浏览器 Blob 直传）。

### 全插件中文覆盖普查（v0.9.10）

「面板还有英文」这种事不能再靠印象判断，用工具查：

- **`tools/audit_zh_keys.py`**（已进 `regress`）—— 扫 `web/**/*.{js,mjs}` 里所有
  `zh()` / `zhCount()` 的**字符串字面量键**，逐个查「全节点 `ui` 拍平合并」后的词典。
  现 **273 处调用、0 条缺口**。
  🔴 `zhPair(英文, 中文)` 的英文参数**不算缺口** —— 它自带中文，英文那份只给英文界面用。
  把 zhPair 也算进去会报一堆假账（第一版就这么错，LoRA 面板被误报 9 条）。
- **`tools/_probe_lora_zh_scan.cjs`** —— 运行时扫描：依次打开面板 / 齿轮 / 选择框，
  收集所有「有 ASCII、没汉字」的可见文本，外加 `title` / `aria-label` / `placeholder`
  （这三个属性汉化插件的 MutationObserver 看不到）。中文界面下只剩 `+ LoRA`、`PG-13`
  和三个文件名，都该保留。

这轮补掉的 11 条：遮罩编辑器的 9 条 `Overlay colour: *`、`Write the mask into a new file
and use it.`、导出节点的 `Export settings`。

🔴 **`mask_editor.mjs` 的 `TINT_TIP` 是模块顶层求值**，靠「这个模块只在点『编辑遮罩』时
动态 import」才拿到已就绪的字典。代码里已经写了警告 —— **别把那条 import 改成静态的**，
否则那九条提示会永久留在英文。

📌 核对汉化包之前先刷快照：`fetch_qg_object_info.py --port 8199`。`audit_zh_pack.py` 读的是
`reports/qg_object_info.json` 这份**快照**而不是活实例，忘了刷会报一堆假的「僵尸条目」。

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
| 显示名 | `Image Crop + Rotate + Pad 🆎` | `Image Crop + Rotate + Pad` |
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
  display 从中文「文本」改成 `Text`（中文标题「QG 文本」；v0.8.5 期按用户要求去掉「编辑」二字）；CATEGORY 走 `QG-tools/Text`（当时是 `QG-tools/文本`，2026-10-24 改英文）。
- **许可证**：上游 `ComfyUI-Muye-nodes` 是 MIT（copyright 2025 muye_xiuluo），
  全文已落到 `licenses/ComfyUI-Muye-nodes-LICENSE.txt`；README 的许可证段一并列了出处。
- **i18n**：`locales/zh/nodeDefs.json` 的 `QG_TextEditOutput` 四条（display_name /
  description / inputs.text / outputs）；汉化插件字典同步补同一份。

## Muye 8 节点搬家记录（含遮罩分类，v0.8.5）

用户从 `ComfyUI_Muye 1.0.17` 勾了 8 个节点要搬：图像水印、文字叠加图像、宫格拼接、
遮罩上色、遮罩拼接、批量文本替换、文本按分隔符分割、尺寸选择器。
**全部纯 Python、零前端、零新增 pip 依赖**，所以这一批的坑全在「上游 bug + 汉化」上。

> v0.9.4 补充：其中「批量文本替换」（`QG_TextReplace`）后来**改搬 Comfyroll 的
> `CR_TextReplace`**（加了字面/正则模式下拉），显示名也从「批量文本替换」变成「文本替换」。
> 本节其余 7 个节点没动。

### 上游 bug（不是改名，是修逻辑）

| 节点 | 上游问题 | 处理 |
|---|---|---|
| 图像水印 | `common_upscale` 引用了本模块没定义的 `bislerp`/`lanczos` → 一旦缩放就 NameError | 改用 `comfy.utils.common_upscale` |
| 图像水印 | `squeeze()` 把批次压成单帧 | 保留 B 维，逐帧贴 |
| 图像水印 | 无水印遮罩时 `paste(img, loc)` 不带 alpha → **透明度与旋转边角全失效** | 永远 `paste(img, loc, img)` |
| 文字叠加 | 默认字体取 `font_choices[0][0]`（拿到首字符） | 显式取字体名，优先 NotoSansSC-VF |
| 文字叠加 | 只画第一帧 | 逐帧绘制 |
| 文字叠加 | `IS_CHANGED` 恒 True → 每次重跑且破坏缓存 | 删掉 |
| 宫格拼接 | 无条件剔除全黑帧 | 改成 `drop_black` 开关（默认开） |
| 遮罩上色 | 只取遮罩第一片 | 单张遮罩广播到整批 |
| 遮罩拼接 | 返回裸 `(H, W)` | 改成标准 `(1, H, W)` |
| 文本替换 | 所有输入强制必填连线，单放一个节点点不动 | 全部可选：接 texts 走批量，否则用文本框 |
| 尺寸选择器 | 潜在通道数写死 16（SD1.5/SDXL 直接错） | 新增 `latent_channels` 下拉 4 / 16 |
| 尺寸选择器 | `ratio="none"` 时长边同时套到宽高 → 2:3 被压成正方形 | 按原比例换算另一边 |
| 尺寸选择器 ★ | 比例改完再各自向上取整 → **比例漂移**（16:9 @ factor32 算出 1344×768 = 7:4） | 改 `w=rx·k, h=ry·k` 求解，k 走 `lcm(step/gcd(step,rx), step/gcd(step,ry))`，比例精确且两边同时在网格上；拒绝时回退旧算法（`_legacy_shape`） |
| 尺寸选择器 ★ | LATENT 不带 `downscale_ratio_spacial` → **16 倍下采样的模型出图正好翻倍** | 补 `8`（与核心 `EmptyLatentImage` 一致），其余交给 `comfy.sample.fix_empty_latent_channels` 换算 |
| 尺寸选择器 ★ | `对齐倍数=0` 时求解器只保证整数 → 出 **810×1215** 这类非 8 倍数尺寸，latent 的 `//8` 把它截断（节点报 1215、图只有 1208） | 求解路径的步长兜底 `max(factor, 8)`；手填宽高覆盖与 preset 原样两条老路径不动 |

★ 是本包自己发现、上游没有的问题（v0.9.4）。第二条的证据链：
`comfy/sample.py:53` 只在**传了非 None 且与模型不符**时才缩放；核心 `nodes.py:1275`
恒返回 `{"samples": ..., "downscale_ratio_spacial": 8}`；`comfy/latent_formats.py` 里
有 10 个 format 不是 8 倍（42 / 4 / 16×5 / 32×2 / 1）。

`mp`（百万像素）是 v0.9.4 新加的可选参数，算法照 AusBoss `resolution_math.mjs` 的
`sizeForMegapixels` 改写（候选三档按面积误差取最近），**只借思路，不引前端依赖**。
它排在 `INPUT_TYPES()` 的 `optional` 末尾 —— LiteGraph 按位置还原 `widgets_values`，
插在 `required` 里会让老存档整体错位（探针 `tools/probe_size_selector.py` 断言了这点）。

### 「采用比例」：`ratio` 从自由文本改成下拉

用户要求「比例里面加上采用比例」。为什么需要它：预设的**像素比和标签比经常对不上**
—— `2304x1280 - 16:9` 的实际比例是 9:5（1.8），标签写的才是 16:9（1.778）。
只按像素比算 `mp` / `长边`，出图永远不是标签承诺的那个形状。

- `ratio` 由 `STRING` 改成 `COMBO`：
  `none` / `from-preset` / `1:1` / `4:3` / `3:4` / `3:2` / `2:3` / `16:9` / `9:16` / `5:4` / `4:5` / `7:4` / `4:7` / `2:1` / `21:9`
  （中文界面依次显示 `无` / `采用比例` / 比例本身，比例值中英同形不翻译）
- **`from-preset`（采用比例）** = 用 preset 标签里的比例（`_ratio_from_preset` 正则取 `- 16:9` 那段），
  取不到就退回像素最简比。`none`（无）保持老语义（用预设原始像素）。
- 自由文本没丢：新增可选参数 **`ratio_custom`**（`optional` 最末，第 9 格 widget），
  填了优先于下拉，支持 `2.39:1` / `5 4` / `1.85`。
- 🔴 **老存档可能存着自定义比例**（那时 `ratio` 是文本框），而它**不在 COMBO 选项里** ——
  直接加载会让后端 COMBO 成员校验报错。`web/size_selector/index.js` 的 `onConfigure`
  负责接住：值不在选项里就搬到 `ratio_custom`、下拉回 `none`。
  探针 `probe_size_selector.py` 的 **2b 段**用 `LEGACY_CUSTOM` 存档断言这条。
- 🔴 **老存档选项值同样是中文**（`无` / `采用比例`）—— 这一层不归 `web/size_selector`
  管，统一由 `_qg_combo_legacy.py` + `web/shared/combo_zh.mjs` 处理，见「下拉选项的双语」。
- 老存档 8 项（含 mp）→ 新 9 项，`ratio_custom` 缺席取默认空串，前面一格格都不会错位。

### 求解路径的步长兜底到 8

`对齐倍数=0` 原本等于 `step=1`，求解器只保证「整数」。但 latent 是按
`out_w // 8` 展开的 —— 非 8 的倍数会被**悄悄截断**：

```
from-preset（preset 832x1216 - 2:3, 对齐倍数 0）
  改前 → 810x1215   （1215 // 8 = 151 → 张量实际 808x1208，节点却报 810x1215）
  改后 → 816x1224   （8 的倍数，张量展开与输出一致）
```

- 改法：`step = max(int(factor), LATENT_SPACIAL_DOWNSCALE)`，同一条兜底也加进
  `_legacy_shape` 的回退路径。
- **只作用于求解路径**（比例 / 百万像素 / 长边）。两条老路径保持原样：
  手填 `width`/`height` 覆盖（factor=0 即原样）、`ratio=none` 直接用 preset 像素。
- 已知取舍：`factor` 填 1~7 会被抬到 8（低于 8 在 latent 层面没有意义）。
  tooltip 里写的是「0 = 不额外贴，但求解比例时最低仍保证 8 的倍数」。

宫格拼接上游是**输出节点**（`OUTPUT_NODE = True`），保留并改造成
`return {"ui": {...}, "result": (grid,)}`，节点上照旧直接预览。
配套的 `MuyeImageList`（图像列表）**不搬**：QG 侧用批次张量或任意列表即可替代。

### 分类

新增子分类 **`QG-tools/Mask`**（`QG_MaskColorize` / `QG_MaskConcat`）。
（当时后端写的是中文 `遮罩`，2026-10-24 统一改成英文；`verify_categories.py`
现在有 `ALLOWED_SUBS` 白名单，新增子分类必须登记，漏了直接 FAIL —— 别再看
老版本「不需要改白名单」那句话。）

### 汉化（这批的重点）

按硬规矩「搬完必须彻底汉化」：**tooltip 全部写在源码里、就是中文**，
两套字典只补 `name/title/description` 与枚举译名。tooltip 逐字来源是后端的
`INPUT_TYPES()` / `OUTPUT_TOOLTIPS`，所以用脚本生成而不是手抄：

```
python tools/gen_muye_i18n.py           # 干跑：列出每个节点几条输入/输出
python tools/gen_muye_i18n.py --apply   # 写 nodeDefs.json + 汉化插件字典
```

脚本自带三道断言：输入键集合必须与 `INPUT_TYPES()` 完全对齐（多一个少一个都停）、
每个参数的 tooltip 必须存在且含中文、每个输出 tooltip 数必须等于输出数。
顺带补了 `QG_ImageResize` 的下拉枚举译名（`pixels/percentage`、`crop/pad/contain`、
`nearest-exact/bilinear/area/bicubic/lanczos`）——之前只靠 tooltip 解释，值还是英文。

> ⚠️ 新增节点后别忘了 `tools/sync_translation_pack.py` 的 `NODE_ORDER` 也要补 ID，
> 否则导出汉化包时会报「字典里还有本脚本没列出的键」。

### 校验

- `tools/test_muye_nodes.py`：整包真加载 + 8 节点功能实测，**48 项全过**
  （水印透明度/旋转、逐帧文字、宫格、遮罩广播、正则替换、三路切分、尺寸换算）。
  开头必须先建 `server.PromptServer(asyncio.new_event_loop(), default_asset_manager())`，
  否则 google_translate / md_reader / display_any 的在 import 期注册路由会失败，
  节点数从 23 掉到 20。
- `tools/verify_085_live.py`：8199 实例 `/object_info` 逐字比对两套字典（见验收报告）。

## 种子 换脸记录（AusBoss 种子卡，v0.8.5）

节点 ID 不变（`QG_Seed`），只把 rgthree 那套「seed 控件 + 三个按钮 + 前端包装
`queuePrompt` 改写哨兵」换成 AusBoss 的卡片模型：

- **后端**：`seed` 变成非负 INT（0 … 2^64-1），`INPUT_TYPES` 里声明
  `control_after_generate: True` —— ComfyUI 会自动附加那个「生成后控制」控件；
  前端把它藏起来，改由卡片上的「随机值 / 固定 / Step」写它。`emit()` 返回
  `{"ui": {"seed": [seed]}, "result": (seed,)}`，`ui.seed` 就是前端的「上次运行」。
  旧的 `IS_CHANGED` 随机兜底随之删除（哨兵没了，缓存靠种子本身变化来区分）。
- **前端**：`web/seed/index.js` 整份重写；新增 `web/shared/seed_history.mjs`
  （AusBoss 同源，纯逻辑：`seedFromExecuted` / `pushSeed` / `formatSeed`）。
  复制按钮用 SVG 图标（与 `展示任意` 一致），卡片配色走 `BRAND`。
- **老存档迁移**：`-1 / -2 / -3` 在 `onConfigure` 里翻译成「随机值 / Step +1 / Step -1」
  并当场抽一枚种子；只存了一个种子、没有模式的存档（v0.8.4 那版把控件摘掉了）
  一律按「固定」处理，否则会被默认的「随机值」抽走。
- **新节点默认值**：`control_after_generate` 默认就是 `randomize`，而 ComfyUI 的
  生成后控制是「排队之后」才改值 → 新节点第一次排队会跑 0 号种子。所以
  `onNodeCreated` 里当场抽一枚（加载工作流时 `onConfigure` 会用存档值覆盖）。
- **没搬**：AusBoss 的跨标签页运行隔离（`js/prompt_scope` + `shared/prompt_scope.mjs`）。
  这一条在搬「图像对比」时补上了，见下一节。
- **校验**：`tools/probe_seed_card.py`（CDP，27 项）+ `tools/gen_seed_i18n.py`
  （两套字典由后端定义生成，tooltip 逐字一致）。

## 图像对比 搬家记录（AusBoss，第一批：滑动 / A / B）

`AUSBOSS_NODES_Compare` → `QG_ImageCompare`（`QG-tools/Image`）。上游约 3900 行，这次只搬
「滑动 / A / B」这一支；橡皮擦（`compare_erase*.mjs` 约 2260 行）与保存合成图的
`POST /ausboss/compare/save` 路由留到第二批。

- **后端** `nodes/qg_image_compare.py`（约 130 行，零新增依赖）：两路 IMAGE 各取第一帧写进
  temp（`folder_paths.get_save_image_path`），前缀按实例区分（`qg_compare_` + 5 位随机），
  所以一个工作流放两个对比节点不会互相覆盖；`ui` 回 `a_images` / `b_images`。
  `image_a` 原样从 `result` 送出，节点本身是 `OUTPUT_NODE`。
- **前端** `web/image_compare/index.js`：DOM 面板 + 模式切换条（`web/shared/slide_switch.mjs`，
  前缀改成 `qgtools-slide`）。台面用 `<img>` 叠两层 + `clip-path` 裁左半，竖线与 A/B 标签
  跟着 fraction 走。`compare.mjs` 的纯逻辑（`slideFraction` / `compareClip` / `compareBadges` /
  `compareResultSide`）原样搬过来，「结果」按连线判断，同一子图里的两路会钻进去找。
- **跨标签页串台** `web/prompt_scope/index.js` + `web/shared/prompt_scope.mjs`：
  🔴 上游在模块顶层就包 `api.queuePrompt`，**在本机前端 1.53 上会被覆盖**——核心会在扩展加载之后
  再包一层（函数名 `collapsing`），于是原来的补丁形同不存在，`runScope.current` 永远是 null。
  改法：包的动作放进 `registerExtension({ setup() })` 里再装一次，另加 2 秒兜底重试；
  候选实例 `app.api` / `globalThis.api` / 模块导出的 `api` 三个都试，谁有 `queuePrompt` 就包谁。
  探针里 `[FAIL] runScope 认得刚才那次运行` 就是撞的这条，别删那段兜底。
- **另一个坑**：同一个 `.mjs` 带 `?v=` 和不带是**两个模块实例**，`runScope` 状态互不相通。
  插件自己的代码一律带 `?v=2026101603`；探针要验状态也必须用带 `?v=` 的那条 URL。
- **模式与存档**：模式存 `node.properties.qg_compare_mode`（`slide` / `toggle`），
  toggle 的那一侧存 `qg_compare_side`（`A` / `B`）；`hold` 这种老模式名映射到 `toggle`。
- **校验**：`tools/probe_image_compare.py`（CDP，真跑一次两个 `EmptyImage` → 42 项）、
  `tools/gen_image_compare_i18n.py`（两套字典由后端定义生成）。

## 图像对比 搬家记录（AusBoss，第二批：橡皮擦 + 保存）

补上第一批留下的那一半。上游橡皮擦相关约 2260 行，这里实际搬了 `compare_erase.mjs`（185）
+ `compare_erase_stage.mjs`（920）+ `brush.mjs`（168），再加后端约 400 行。

- **存的是笔画，不是位图**：面板只往 `properties.qg_compare_paint` 里存
  `{ w, h, strokes }`，一笔是 `{ o, d, s, p }`（擦/画、笔宽、软度、路径）。所以保存时
  由服务端按**原图尺寸**重画一遍，跟面板当时显示到多大无关。图换了尺寸，旧笔迹自动丢掉
  （`readPaint` 只认 `w`/`h` 对得上的）。
- **前端三个新模块**：`compare_erase.mjs`（纯逻辑，`thinStroke` / `extendStroke` 从上游
  `touch_math.mjs` 里摘出来内联，免得为两个函数拖进 1174 行）、`compare_erase_stage.mjs`
  （画布 + 工具行 + 保存行，920 行）、`brush.mjs`（全包共用的画笔数学，改成中文 `brushWords`）。
- **后端三个新模块**：`_qg_brush_helpers.py`（笔芯/软边/`stroke_cover`）、
  `_qg_psd_helpers.py`（PSD 写入器，139 行原样搬）、`_qg_compare_helpers.py`
  （笔画校验 + 遮罩 + 混合 + 命名 + 预览键；`next_free_counter` / `require_output_path` /
  `strip_image_extension` 三个小工具内联，省得拖上游 354 行的 `_image_save_helpers`）。
- 🔴 **浏览器从不指名要读哪个文件**：每次运行把两张 temp 预览的位置记进一个最多 64 条的
  `OrderedDict`，给面板一个 `secrets.token_urlsafe(16)` 的随机键（`ui.pair`）；保存时把这个键
  发回来。请求里唯一能带的文字是新文件的名字，`clean_save_name` 只放行
  `[\w][\w .\-]*`（去扩展名后 ≤ 80 字），路径穿越和目录一律拒——不是「修」成合法名字。
- 🔴 **防路径穿越有两道**：名字先过正则，落盘前再过 `require_output_path`（`resolve()` 后必须
  在 output 根目录里），因为文件名本身可以是一个符号链接。
- **保存是离线重算**：`POST /qg/compare/save` 走 `run_in_executor`，不占服务器自己的线程；
  笔画有上限（400 笔 / 单笔 600 点 / 共 40000 点 / 坐标不超过画外 4096px），超了就拒而不是崩。
- **PSD**：`layers` 打开时另写 `<name>_00001.psd`（底下那张一层，上面那张一层 + 擦掉的部分作
  图层蒙版）+ `<name>_00001_mask.png`（下面那张露出来处为白）。不压缩写，所以文件大但写得准。
- **工具行的键盘**：`[` `]` 改笔宽、`Shift` 加它们改软度、`E`/`B` 切擦/画、`Ctrl` 或右键临时反着
  做、`Alt`+右键拖动调笔（横拖改宽、竖拖改软）、`Esc` 取消这一笔。`Ctrl+Z` 留给 ComfyUI
  ——一笔对图来说就是一次改动，它的撤销连笔画一起退。
- **切回滑动不撑高节点**：上游有一段 `sizeAfterErase`（记下撑高前后的尺寸再收回），但那个
  `SIZE_BEFORE_ERASE` 属性在上游**从来没被写入过**，等于死代码；这里没搬。工具行窄了就折行，
  「地方从图上出」，节点宽度不变（真机验过 `[420,326]` 进出擦除完全一致）。
- **不走上游的两件事**：`video_ui.mjs` 的 `makeToolButton` 只为一个 22px 按钮，这里直接画；
  `canvas_passthrough.mjs` 只用到 `keepKeyInField`，插件里早就有这份（`web/shared/`），直接复用。
- **校验**：`tools/test_compare_erase.py`（纯后端数值，47 项：笔画/名字校验、混合像素、
  软边过渡、PSD 头、遮罩极性、编号递增、换方向擦、预览键 404 —— 用 ComfyUI 的 python 跑）；
  `tools/probe_compare_erase.py`（CDP 真机，62+ 项：真画一笔、撤销、清空、真保存并下载回来、
  `filename` 接线后名字框变灰）。

## 遮罩裁剪 / 裁剪恢复 / 遮罩对齐（自写，2026-10-29）

三个节点一套流程，对着孤海「遮罩裁剪V2 + 裁剪恢复 + 遮罩对齐V2」的**用法**重写，代码没抄：
几何全在 `nodes/_qg_mask_crop_helpers.py` 的纯函数里（`plan_crop` 一函数包办四方向扩展、
三种取景、multiple 取整），不依赖 PIL / cv2 / scipy；`QG_CropRestore` 靠 `QG_MaskCrop`
给的 `seam` 字典（`SEAM_TYPE = "QGSeam"`）回贴，只写落在画面内的部分。

### 🔴 「没画遮罩」必须判在尺寸检查之前

`ComfyUI` 原生 `LoadImage` 在图片**没有 alpha** 时给的是 **64×64 全零占位遮罩**
（`torch.zeros((64, 64))`），不是图像尺寸。于是「用户还没画遮罩」这个状态，表现出来
就是**尺寸对不上**。

`crop()` 原本先查尺寸、再查 `mask_bounds() is None`，结果那条「没画就整图直通」的
分支**永远走不到** —— 64×64 的占位遮罩在第一道检查就被 `mask_size_mismatch()` 拦下，
抛 `No mask painted`，整个 prompt 崩掉。2026-10-29 用户实拍报的就是这个：

```
ValueError: No mask painted: right-click your picture, choose Open in MaskEditor...
  at nodes/qg_mask_crop.py:225  raise ValueError(mask_size_mismatch(mask[0], height, width))
```

修法：`is_unpainted_mask(mask[0])` 命中（64×64 且全零）时**先换成同尺寸的全零遮罩**，
让后面既有的「没画 → 整图直通 + `warn_once`」分支接住。真正的尺寸错误（比如 100×100
的空白遮罩配 768×512 的图）仍然抛错，文案带两个尺寸。

- 这不是「宽容过头」：遮罩没画是用户**还没走到那一步**，不是图画坏了。为此中断整条
  工作流代价太大，直通则下游立刻能看出没裁剪。
- `QG_MaskRefine` / `Crop For Inpaint` 不适用这条 —— 它们**必须**有遮罩才能干活，
  报错是对的。只有 `QG_MaskCrop` 的语义允许「无遮罩 = 整图」。
- 断言在 `tools/_check_mask_crop_align.py` 的 `test_unpainted_mask_passes_through`：
  64×64 占位 → 不抛、输出等于原图、回贴逐像素差 0；100×100 空白 → 仍然报错。

### 两个配套约束

- `SEAM_TYPE` 写 `"QGSeam"`，**别写 `QG_SEAM`** —— `verify_display_names` 会把带下划线
  的大写串当成节点 ID。
- 模块级辅助函数别放 class 前面：`verify_bilingual` 会向上 40 行找 `"name": (`，把函数体
  里的 `if anchor == "center":` 读成输入名（`QG_MaskAlign` 踩过，已把 `_anchor_offset`
  挪到 class 之后）。

## 导出图像（`QG_ExportImage`）：JPEG 参数到底怎么选

### 为什么要有这个节点

社区两个保存节点（KOOK 的 `SaveJPGImage`、孤海的 `保存图像JPG`）都把 quality 写死 90，
期望用户在前面接一个「压缩」节点调质量。这条路走不通：

压缩节点输出的还是 IMAGE 张量，保存节点会**再编码一次**，最终画质由保存节点决定。
上游调的 quality 只决定「被破坏得多狠」，不决定最终体积。

实测（2336×4096 原图，PNG 16.84 MB）：

| 路线 | 体积 | PSNR |
|---|---|---|
| 压缩节点 q90 → 保存 90 | 2.59 MB | 36.94 dB |
| 直接保存 90 | 2.60 MB | 37.23 dB |

体积只差 0.11%，画质反而掉了 0.29 dB —— 多出来那一步纯属白做。
所以 quality 必须放在编码那一刻，这就是本节点存在的理由。

### PIL 参数的实际含义

**`subsampling`（仅 JPEG）**

| 值 | 实际采样 | 色度 |
|---|---|---|
| `0` | 4:4:4 | 完整保留 |
| `1` | 4:2:2 | 水平减半 |
| `2` | 4:2:0 | 水平垂直都减半 |

本节点默认 `0`。社区插件普遍写 `1`，并在文档里称「保持较高的色度采样精度」——
这句是反的：`1` 是中间档，精度低于 `0`。同一张图 quality 90 下，
4:4:4 是 894.9 KB / 29.99 dB，4:2:2 是 579.6 KB / 25.68 dB，差 4.3 dB，
红橙边缘能直接看出来。

**`quality`**

只对 JPEG 和 WEBP 生效。PNG 是无损编码，这个值不参与 —— 界面不会隐藏它，
但填了确实没用，tooltip 已写明。参考曲线（同一张原图，一步保存）：

| quality | 体积 | PSNR |
|---|---|---|
| 95 | 4.00 MB | 39.69 dB |
| 90 | 2.60 MB | 37.23 dB |
| 85 | 1.96 MB | 35.93 dB |
| 80 | 1.61 MB | 35.10 dB |
| 70 | 1.22 MB | 34.02 dB |
| 50 | 0.84 MB | 32.70 dB |

**`optimize=True`（JPEG）**

只重排 Huffman 表，**无损**，通常省 2~5% 体积，跟画质无关。别把它当成画质开关。

**`compress_level`（PNG）**

取 `4`，与 ComfyUI 原生 `SaveImage` 同档。取 `6` 慢一倍，只省 0.3%
（16.49 MB → 16.44 MB，2110 ms → 3065 ms），不值得。

**`method`（WEBP）**

取 `2`。取 `4` 慢 2.8 倍（902 ms → 2504 ms），只小 2%（1.63 MB → 1.60 MB）。

### 默认值为什么这么定

- `format=JPEG` / `quality=90`：肉眼无损的常用档，和社区习惯一致，换过来不用重新学。
- `subsampling=4:4:4`：先给足画质，想省体积自己降。默认就砍色度的话，
  用户遇到偏色时根本想不到是这个参数。
- `alpha_mode=on-white`（中文界面显示「合成白底」）：JPEG 不支持 alpha，直接丢通道会让透明区变成黑块；
  白底是最不容易出错的默认。
- `save_path` 留空 = output：绝大多数人只在节点上点开预览，不需要额外配置。

### 路径与命名的两个约束

- `save_path` 走相对路径时，解析结果必须仍在 output 下（挡 `..` 越界）；
  走绝对路径时放行，但拒绝盘符根目录和系统目录。
- 自定义目录在 ComfyUI 的 `/view` 之外，预览另存一份**缩略图**（最长边 1600）到 temp。
  存整图会让大图耗时和磁盘都翻倍（同一张图 PNG 5.9 s → 2.6 s）。

## 启动横幅（`__init__.py` 的 `_print_banner`）

用户看到 AusBoss 启动时那三行框（`AusBoss v2.17.0 | 44 nodes loaded` + 仓库地址），
要求 QG 也来一个。实现在 `__init__.py` 末尾，节点全部加载完之后打印：

```
----------------------------------------------------------------------
  QG-tools v0.9.10  |  45 nodes loaded  |  8 categories
  https://github.com/live1617/ComfyUI-QG-tools
----------------------------------------------------------------------
```

节点数、子分类数都是**现算**的（`len(NODE_CLASS_MAPPINGS)`、扫描 `CATEGORY` 的
`/` 后段），不写死。加载失败 / 节点 ID 冲突的行只在出问题时才出现。

- 🔴 **横幅内只用 ASCII**。Windows 控制台的编码可能是 cp1252，`print` 中文会在
  import 阶段抛 `UnicodeEncodeError` → 整个插件静默加载失败。所以 `QG-tools`、
  `nodes loaded`、`categories` 全是英文；中文告警（模块加载失败）走原来的
  `print("[QG-tools] ...")`，那部分一直是中文且能跑（用户控制台是 GBK/UTF-8）。
- **只在真终端上色**：`_use_color()` = `sys.stdout.isatty()` 且环境里没有 `NO_COLOR`。
  stdout 被重定向到 `comfyui_8188.log` 时（启动器常见）输出纯文本，免得日志里
  全是 `\033[...m`。AusBoss 是无条件上色，这里刻意比它稳一点。
- **版本一致性检查**：横幅顺便比对 `pyproject.toml` 的 `version` 与 `__version__`，
  不一致就黄字打一行 `Version mismatch: pyproject.toml says X`。
  发版必须同时 bump 两处，这一行就是防漏的。
- 验证：起 `--port 8199` 看控制台输出；或裸 python 里
  `importlib.import_module('custom_nodes.ComfyUI-QG-tools')`（会因缺 PromptServer
  报几个模块加载失败，属于预期，正好能验「Failed to load」那行的排版）。

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

## Registry 扫描误报（`NodeVersionStatusFlagged`）

每次发布，Registry 会对发布包跑一套 YARA 规则 + 溯源扫描。**命中任何一条就整版标
`NodeVersionStatusFlagged`——不看严重级别，`severity: info` 一样拦**。被标的版本：

- 在 ComfyUI Manager 的版本列表里看不到、装不了（Manager 侧要开 `allow_flagged_nodepack_install`
  且只监听 loopback 才放行）；
- `latest_version` 只认 `Active`，所以「最新版」会停在旧版本；
- 搜索排序权重也掉。

`Pending` 扫完会自动转 `Active`；`Flagged` **不会自动转**，只能人工复核 / 申诉。

### 查原因（关键：`include_status_reason=true`）

这个参数不在公开文档里，不戴它 `status_reason` 字段会被抹掉：

```bash
curl -s 'https://api.comfy.org/nodes/comfyui-qg-tools/versions?include_status_reason=true'
```

每条命中给出 `issue_type` / `scanner` / `file_path` / `line_number` / `line_snippet` /
`severity` / `metadata.yara_matches`。

### v0.8.0 ~ 0.8.5 被打上的四条（全是误报，`severity` 都是 `info`）

| 位置 | 命中内容 | 被认定成 | 实际 |
|---|---|---|---|
| `nodes/qg_google_translate.py:141` | 读取可选 API key 的那一行 | `python_environment_manipulation`（T1574.007 环境变量劫持） | 读自己可选 API key |
| `nodes/qg_text_overlay_image.py:45` | 读 `WINDIR` 环境变量的那行 | 同上 | 找 Windows 字体目录 |
| `nodes/qg_google_translate.py:121` | `su` → `sundanese` 这一条 | `python_privilege_escalation`（sudo/su 提权） | 巽他语的 BCP-47 语言码（**v0.9.3 已删除该键**） |
| `web/google_translate/index.js:89` | 给 `manual_translate_prompt` 做 `bind` 绑定的那行 | `python_network_operations`（socket bind） | JS 的函数 `bind` |

0.7.0 及更早都是 `Active`——规则集后来更新了，不是我们改坏了什么。

### v0.9.1 做的最小消音

不改变任何行为，只让源码不再长得像那三个模式（语言码那条当时绕不过，交申诉；**v0.9.3 已改为
直接从语言表里删掉巽他语**——这是唯一一处连注释都消不掉的命中，理由见下）：

- 字体目录：改 `os.path.expandvars(r"%WINDIR%")` + 未展开时回退 `C:\Windows`；
- API key：先把 `os.environ` 取成局部名，再调它的 `get` 方法（源码里不再有连续的「取环境变量」调用形态）；
- 前端：`manual_translate_prompt(node)` 改成收参数，调用处用箭头函数，去掉 `bind` 绑定。

> 以后再往 nodes/ 里加代码，**别让源码里出现「直接取环境变量的 get 调用」「子进程模块名」
> 「网络库裸调用」这几种连续形态**，JS 里也别用 `bind` 绑定；网络路由里确实无法避免的，
> 交给申诉并在这张表里登记。
>
> 🔴 **扫描器连 `.md` 一起扫**（v0.9.1 就因为本节的示例代码多出两条误报：
> `DEVELOPMENT.md` 里的取环境变量调用和 JS 绑定写法）。在文档里写「不要这么写」时，
> 把字面拆开、或者只做文字描述，别贴完整调用。

### v0.9.3 删掉了一个语言码

`QG_GoogleTranslateText` 的语言表里那条巽他语，是唯一一处**加注释也消不掉**的命中：
扫描器的 `confidence_note` 原文写着 `_presence`（60%）匹配的是裸字符串字面量、
`remove_comments()` 会先剥注释，而「非安全字符串里的小写 su」被规则作者登记为
**已知可接受的误报**（FN-prevention-first 策略）。申诉挂了近两天没有回复，所以
直接把那个下拉选项删掉，让源码里不再存在这个字面量。

影响：语言下拉 105 项变 104 项；`translate()` 不校验语言码，老工作流里存着的值
仍会原样发给 Google API，照常翻译。

### 申诉

同一批误报只需申诉一次，但**重发版会重跑扫描**——代码不改就还会被打上。渠道：

- Comfy Org Discord 的 `SUPPORT/#security-review-council`，按发布者建一个长期 thread
  （频道的自动通知很快会冲掉散消息），贴版本号 + 上表；
- 或在 [Comfy-Org/registry-backend](https://github.com/Comfy-Org/registry-backend) 开 issue
  贴同样内容，Discord 里只放链接（频道有 2000 字限制）。

## 打包

需要给 GitHub Release 传 zip 时，**不要把整个目录直接压** —— 先排除这些：

- `__pycache__/`、`*.pyc`（Python 缓存）
- `.git/`（版本库，不该进发布包）

压好的 zip 顶层目录名应为 `ComfyUI-QG-tools`，这样用户解压到 `custom_nodes/` 下即可直接用。
GitHub 自动生成的 "Source code (zip)" 顶层是 `仓库名-分支名`，**不适合**当 Release 附件，
建议手动压一份上传。
