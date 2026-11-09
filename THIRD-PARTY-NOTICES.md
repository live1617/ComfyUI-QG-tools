# 第三方组件声明（Third-Party Notices）

本文件随 ComfyUI-QG-tools 一起分发，逐条列出本插件中含有的其他开源项目代码、
各自的许可证与修改情况。

> 由 `tools/gen_third_party_notices.py` 从 `ORIGINS.json` 生成，**请勿手改**；
> 要增删节点或改来源，改 `ORIGINS.json` 后重跑脚本。

- 本插件：ComfyUI-QG-tools · GPL-3.0-or-later · https://github.com/live1617/ComfyUI-QG-tools
- 依据：`ORIGINS.json`（更新于 2026-11-08）
- 规模：57 个节点 = **6 个搬运** + **51 个原创**

## 口径

- **搬运**：整段照抄上游代码，只改类名 / 节点 ID / 分类 / 显示名 / 中文文案，
  逻辑基本没动。下面按上游项目分组逐条列出。
- **原创**：代码由本插件作者自己写 —— 从零实现、参考上游思路后自己重写、
  或合并作者自己的插件，三种都算。参考对象集中列在文末，**不构成代码来源**。

## 1. ComfyUI-AusBoss

- 作者：ausboss
- 许可证：MIT —— 全文见 `licenses/ComfyUI-AusBoss-LICENSE.txt`
- 仓库：https://github.com/ausboss/ComfyUI-AusBoss
- 贡献 6 个节点

| 本插件节点 | 显示名 | 上游节点 | 修改 / 保留说明 |
|---|---|---|---|
| `QG_FreeMemory` | 释放显存 | `Free Memory 🆎` | 四步释放整段照搬（卸模型 / 清模型缓存 / gc / 清 CUDA 缓存），每步独立 fail-soft；通配类型用 AusBoss 的 str 子类写法。10-30 逐行核对：释放例程与上游完全一致、实现正确（四个 try 各自独立，缺 comfy / 缺 CUDA 只少记一条），没有重写的必要。只改两处 —— value 漏了 forceInput（不加的话前端会在画布上多画一个填了也没用的文本框，QG_Exists / QG_RouteBlocker 都带着），FUNCTION 由 free_memory 改 execute。🔴 **仍标 ported 是刻意的**：代码主体确实是上游的，改成 original 等于虚报；这类「逻辑本来就对、只缺一个标志位」的节点不必为了原创率重写。真机验过通配能接通 MODEL（拿 QG_TripleLoader 的 MODEL 输出串两级） |
| `QG_LoraLoader` | LoRA 加载器 | `LoRA Loader 🆎` | 六条 HTTP 路由全部保留（list / thumb / info / hash / civitai / triggers）；后端（节点 + helpers，10-30）与前端数据层 web/shared/lora_stack.mjs（959 行，10-31）都已重写为自己的实现。面板 web/lora_loader/index.js 已改掉信息卡的定位方式、弹窗的尺寸跟随与全部凑出来的文案（10-31），但行渲染 / 选择器 / 模板 / 盒子那一大块仍是搬运结构，故 origin 仍记 ported |
| `QG_WorkflowNote` | 工作流说明卡 | `Workflow Note 🆎` | — |
| `QG_WorkflowSwitches` | 工作流开关 | `Workflow Switches 🆎` | 后端 79 行纯壳（无输入无输出，只为本包可被扫描到）→ 没有可重写的实现，重写全在前端与数据层。10-31 自写：① 另一侧 nodes_off / groups_off（上游主打功能之一，本包此前整块没搬：开着跑 A 路、关着跑 B 路）；② 粘贴重指向（新建 shared/paste_remap.mjs 包 LGraphCanvas._deserializeItems + repointSwitches，治上游 2.20.3 修过的同一个 bug）；③ 设置区 SETTING_SPECS 表驱动，画哪几行与算多高同源；④ 两个行菜单合一到 openRowMenu；⑤ 几何（numbersOf / asRect 合掉 usableRect + toRect，unionRect 去中间表示，frameBounds 重推）；⑥ 读数（partState 明说三类单位，readSwitches 的 find / take 把 gone 从三处收成一处）；⑦ 排序（canvasOrder 的 spine 列判定）；⑧ 行渲染（describeRow 把一行的全部文案抽成纯函数，sync 从 82 行降到 26 行）；⑨ 分组筛选（删掉从没被调用的 hiddenKey，hiddenRecord / hiddenAway 一份判定两处共用）；⑩ 存档归一化（readId 收掉三连 typeof；🔴 收紧 id 必须是非负整数 —— 以前 3.5 / -2 会被存下来，永远匹配不到节点却一直算进 gone）；⑪ 名字与宽度（cardView 早退顺序与注释同序，suggestTitle 只选一个 chosen）；⑫ 成员编辑（两侧字段名只有 sideOf / withSide / otherSide 知道，四个编辑函数共用 joinSide / withoutIds，三个计数共用 countIn / countOutside）；⑬ 设置对与点击计划（pairsOfControl 拆出分支，merge / modesChanged / pairKey / sidesChanged 收掉重复）。另修两个真缺陷：settingsRowCount 的显示条件与画面写反（打开「一次一个」后卡片底下多一条空白）；🔴 上一轮删 hiddenEntry 时漏了 hideGroup 也在用 → 隐藏一行分组直接 ReferenceError，本轮补测试才发现。量法（两边 strip 后长度 >25 的行取交集）：数据层 66% → 48%，前端仍 58%（本轮没动前端）。⑭ 收尾五个（repointSwitches 的 follow 收敛成一条并修掉「映射到自己也算改」的假改动、choiceState 按「在跑的行数」分档、stackRowOwners 抽 pairMovesRow、releaseStackRow / readPairs / choosePlan 注释说准）。至此数据层每个函数都至少过了一遍，逐字重合 48% → 44%，剩下的是 1~11 行的纯函数（rowAt / rowSetting / fileKey / isInRect / offMode），结论唯一，再改只能换等价写法。⑮ 前端四块（10-31）：行渲染（buildRow 拆成 buildToggle/buildName/buildSides，render 拆成 syncRows/syncChrome/fitCard）、菜单（openRowMenu 从收回调改成收清单，菜单项名走 zh）、设置面板（controlRow 统一药丸与下拉、syncChildren 统一行列表与选择药丸的复用/换位/删除、🔴 修「一次一个」两半交叉——点「关」会变成「开」）、卡片骨架（buildPanel 67 行拆成 createCard/wireCard/attachCard）。顺带修的真缺陷：菜单在开关已不存在时挂出空白方块、`+ Switch` 与 `Done` 裸英文、点当前值多记一次撤销。量法：数据层 66%→44%、前端 58%→46%；55 个同名函数里 33 个仍逐字相同，但除 refresh(15) / stopRename(14) / read(11) / picked(11) 外都在 10 行以内，结论唯一、再改只能换等价写法。仍记 ported：这些短函数与 buildPick(73 行) / newSwitch(23) / saveSide(16) / applyPlan(15) 仍是搬运代码。 |
| `QG_ImageCompare` | 图像对比 | `Image Compare A/B 🆎` | 上游约 3900 行，只取滑动 / A / B / 擦除四种模式那部分；后端（节点 + _qg_compare_helpers）2026-10-31 重写为自己的实现，前端 web/image_compare/ 与 shared/compare_erase* 仍是搬运版，故 origin 仍记 ported |
| `QG_Seed` | 种子 | `Seed 🆎 / Seed` | 卡片界面来自 AusBoss，取值与随机逻辑来自 rgthree；老存档 -1/-2/-3 在 onConfigure 翻译（另参考 rgthree-comfy） |

## 统一改动

所有搬运节点都做了以下几件事：

- 节点 ID / 类名加 `QG_` 前缀，分类统一到 `QG-tools` 下
- 显示名去掉上游前缀；输入名、输出名、提示文案译为中文
- 代码注释与说明重写为中文
- 少量上游 bug 修复与行为调整，逐条写在对应源文件头部的 `QG changes` 段

每个搬运源文件的头部都写着 `Ported from <上游>（许可证）`、原作者署名，以及
`Modified for ComfyUI-QG-tools on <日期>` 的修改声明 —— GPL-3.0 §5(a) 要求
分发修改版时明确声明改动并给出日期。

## GPL-3.0 来源

下列上游与本插件同为 GPL-3.0，按 GPL-3.0 §5 的要求：保留原作者署名、
声明修改、并以同一许可证分发。本项目根目录的 `LICENSE` 即 GPL-3.0 全文，
可直接作为这些组件的许可证副本。

（无）

## 原创节点里的参考对象

下面这些节点**代码由本插件作者实现**，不含下列项目的代码；列出参考对象只是
说明思路来源，便于溯源。

| 本插件节点 | 显示名 | 参考对象 | 许可证 | 关系 |
|---|---|---|---|---|
| `QG_RemoveBGByMask` | 按遮罩抠图 | ComfyUI-QG-Multipack v0.1.0「QG_RemoveBGByMask」 | GPL-3.0-or-later | 作者自有插件，合并进来 |
| `QG_MaskBlend` | 遮罩混合运算 | ComfyUI-QG-Multipack v0.1.0「QG_MaskBlend」 | GPL-3.0-or-later | 作者自有插件，合并进来 |
| `QG_MaskAnalysis` | 遮罩分析 | ComfyUI-QG-Multipack v0.1.0「QG_MaskAnalysis」 | GPL-3.0-or-later | 作者自有插件，合并进来 |
| `QG_MaskDetect` | 遮罩检测 | ComfyUI-QG-Multipack v0.1.0「QG_MaskDetect」 | GPL-3.0-or-later | 作者自有插件，合并进来 |
| `QG_MaskRefine` | 遮罩精修 | ComfyUI-AusBoss「Mask Refine 🆎」 | MIT | 参考思路，代码自行实现 |
| `QG_ImageCropRotatePad` | 图像裁剪 + 旋转 + 补边 | ComfyUI-AusBoss「Image Crop + Rotate + Pad 🆎」 | MIT | 参考思路，代码自行实现 |
| `QG_OutpaintBoard` | 扩图画板（可视化） | 孤海工具箱 Goohaitools-comfyui「外补画板（可视化）」 | GPL-3.0 | 参考思路，代码自行实现 |
| `QG_RunTimer` | 运行计时器 | ComfyUI-QG-Multipack v0.1.0「QG_Timer」 | GPL-3.0-or-later | 作者自有插件，合并进来 |
| `QG_TextEditOutput` | 文本 | ComfyUI_Muye「Text Edit Output」 | MIT | 参考思路，代码自行实现 |
| `QG_AddWatermark` | 添加水印 | ComfyUI-QG-Multipack v0.1.0「QG_AddWatermark」 | GPL-3.0-or-later | 作者自有插件，合并进来 |
| `QG_ImageGrid` | 宫格图像拼接 | ComfyUI_Muye「MuyeGridImageConcat」 | MIT | 参考思路，代码自行实现 |
| `QG_MaskColorize` | 遮罩上色 | ComfyUI_Muye「MaskColorize」 | MIT | 参考思路，代码自行实现 |
| `QG_MaskConcat` | 遮罩拼接 | ComfyUI_Muye「MaskConcatenate」 | MIT | 参考思路，代码自行实现 |
| `QG_TextSplit` | 文本按分隔符分割 | ComfyUI_Muye「TextSplitByDelimiterEnhanced」 | MIT | 参考思路，代码自行实现 |
| `QG_SizeSelector` | 尺寸选择器 | ComfyUI_Muye「MuyeSizeSelector」 | MIT | 参考思路，代码自行实现 |
| `QG_EmptyLatentResolution` | 空 Latent 分辨率 | ComfyUI-EmptyLatentResolution「EmptyLatentResolution」 | MIT | 作者自有插件，合并进来 |
| `QG_TextConcat` | 文本合并 | ComfyUI_Comfyroll_CustomNodes「CR_TextConcatenate」 | MIT | 参考思路，代码自行实现 |
| `QG_TextReplace` | 文本替换 | ComfyUI_Comfyroll_CustomNodes「CR_TextReplace」 | MIT | 参考思路，代码自行实现 |
| `QG_ColorCorrect` | 颜色校正 | comfyui-art-venture「ColorCorrect」 | MIT | 参考思路，代码自行实现 |
| `QG_ImageScale` | 图像缩放 | ComfyUI-QG-Multipack v0.1.0「QG_ImageScale」 | GPL-3.0-or-later | 作者自有插件，合并进来 |
| `QG_ImageOrLatentSize` | 图像或 Latent 尺寸 | rgthree-comfy「Image or Latent Size」 | MIT | 参考思路，代码自行实现 |
| `QG_RatioResolution` | 比例与分辨率 | ComfyUI-QG-Multipack v0.1.0「QG_RatioResolution」 | GPL-3.0-or-later | 作者自有插件，合并进来 |
| `QG_GoogleTranslateText` | Google 翻译 | ComfyUI_Custom_Nodes_AlekPet「GoogleTranslateTextNode」 | MIT | 参考思路，代码自行实现 |
| `QG_AnySwitch` | 任意切换 | 孤海工具箱 Goohaitools-comfyui「GoohaiAnySwitch」 | GPL-3.0 | 参考思路，代码自行实现 |
| `QG_DisplayAny` | 展示任意 | 孤海工具箱 Goohaitools-comfyui「GoohaiDisplayAny」 | GPL-3.0 | 参考思路，代码自行实现 |
| `QG_RouteBlocker` | 路由阻断 | 孤海工具箱 Goohaitools-comfyui「GoohaiRouteBlocker」 | GPL-3.0 | 参考思路，代码自行实现 |
| `QG_IfElse` | 是否判断 | ComfyUI-Easy-Use「easy ifElse」 | GPL-3.0 | 参考思路，代码自行实现 |
| `QG_MDReader` | 加载文档 | ComfyUI-MD-Reader「MarkdownFileReader」 | MIT | 作者自有插件，合并进来 |
| `QG_TripleLoader` | 模型加载器 | ComfyUI-TripleLoader「TripleLoader」 | MIT | 作者自有插件，合并进来 |
| `QG_StringSwitch` | 字符串切换 | ComfyUI-Crystools「Switch string [Crystools]」 | GPL-3.0 | 参考思路，代码自行实现 |
| `QG_DualMath` | 双式数学运算 | 孤海工具箱 Goohaitools-comfyui「数学运算 孤海」 | GPL-3.0 | 参考思路，代码自行实现 |
| `QG_LoadImage` | 加载图像 | Goohaitools-comfyui「加载图像」 | GPL-3.0 | 参考思路，代码自行实现 |
| `QG_MaskCrop` | 遮罩裁剪 | 孤海工具箱 Goohaitools-comfyui「GH_MaskCropV2」 | GPL-3.0 | 参考思路，代码自行实现 |
| `QG_CropRestore` | 裁剪恢复 | 孤海工具箱 Goohaitools-comfyui「GH_CropRestore」 | GPL-3.0 | 参考思路，代码自行实现 |
| `QG_MaskAlign` | 遮罩对齐 | 孤海工具箱 Goohaitools-comfyui「孤海-遮罩对齐」 | GPL-3.0 | 参考思路，代码自行实现 |
| `QG_CropForInpaint` | 重绘裁剪 | ComfyUI-AusBoss「Crop For Inpaint 🆎」 | MIT | 参考思路，代码自行实现 |
| `QG_StitchInpaint` | 重绘缝合 | ComfyUI-AusBoss「Stitch Inpaint 🆎」 | MIT | 参考思路，代码自行实现 |
| `QG_PromptLine` | 提示词行 | ComfyUI-QG-Multipack v0.1.0「QG_PromptLine」 | GPL-3.0-or-later | 作者自有插件，合并进来 |
| `QG_ImageNormalize` | 图片标准化 | ComfyUI-QG-Multipack v0.1.0「QG_ImageNormalize」 | GPL-3.0-or-later | 作者自有插件，合并进来 |
| `QG_Note` | 注释 | ComfyUI-QG-Multipack v0.1.0「QG_Note」 | GPL-3.0-or-later | 作者自有插件，合并进来 |
| `QG_SetPoint` | 设置点 | ComfyUI-QG-Multipack v0.1.0「QG_SetPoint」 | GPL-3.0-or-later | 作者自有插件，合并进来 |
| `QG_GetPoint` | 获取点 | ComfyUI-QG-Multipack v0.1.0「QG_GetPoint」 | GPL-3.0-or-later | 作者自有插件，合并进来 |
| `QG_LongShortSide` | 长短边 | 孤海工具箱 Goohaitools-comfyui「长边短边」 | GPL-3.0 | 参考思路，代码自行实现 |

## 完全原创（无上游参考）

8 个节点从零实现，没有对应的上游项目：`QG_ColorMatch`、`QG_BoolToggle`、`QG_Number`、`QG_Slider`、`QG_Math`、`QG_Exists`、`QG_ExportImage`、`QG_StepPreview`。

另有 16 个节点合并自作者自己的插件（`QG_RemoveBGByMask`、`QG_MaskBlend`、`QG_MaskAnalysis`、`QG_MaskDetect`、`QG_RunTimer`、`QG_AddWatermark`、`QG_EmptyLatentResolution`、`QG_ImageScale`、`QG_RatioResolution`、`QG_MDReader`、`QG_TripleLoader`、`QG_PromptLine`、`QG_ImageNormalize`、`QG_Note`、`QG_SetPoint`、`QG_GetPoint`），版权同属作者。

## 许可兼容性

MIT 与 GPL-3.0 兼容（MIT 允许再许可为 GPL-3.0），因此本项目整体以
GPL-3.0-or-later 分发是合规的。被搬运部分的原始版权仍归各上游作者所有；
MIT 来源的许可证全文一并保留在 `licenses/` 目录。

## 如何复核

- `ORIGINS.json` —— 机器可读的逐节点来源清单，本文件的唯一真相源
- `README.md` 的「节点来源」一节 —— 由同一份清单渲染的人读版
- 源文件头部 —— 每个搬运文件都写明上游、许可证、原作者与修改声明
