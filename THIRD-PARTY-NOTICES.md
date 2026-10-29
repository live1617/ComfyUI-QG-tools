# 第三方组件声明（Third-Party Notices）

本文件随 ComfyUI-QG-tools 一起分发，逐条列出本插件中含有的其他开源项目代码、
各自的许可证与修改情况。

> 由 `tools/gen_third_party_notices.py` 从 `ORIGINS.json` 生成，**请勿手改**；
> 要增删节点或改来源，改 `ORIGINS.json` 后重跑脚本。

- 本插件：ComfyUI-QG-tools · GPL-3.0-or-later · https://github.com/live1617/ComfyUI-QG-tools
- 依据：`ORIGINS.json`（更新于 2026-10-28）
- 规模：45 个节点 = **26 个搬运** + **19 个原创**

## 口径

- **搬运**：整段照抄上游代码，只改类名 / 节点 ID / 分类 / 显示名 / 中文文案，
  逻辑基本没动。下面按上游项目分组逐条列出。
- **原创**：代码由本插件作者自己写 —— 从零实现、参考上游思路后自己重写、
  或合并作者自己的旧插件，三种都算。参考对象集中列在文末，**不构成代码来源**。

## 1. ComfyUI-AusBoss

- 作者：ausboss
- 许可证：MIT —— 全文见 `licenses/ComfyUI-AusBoss-LICENSE.txt`
- 仓库：https://github.com/ausboss/ComfyUI-AusBoss
- 贡献 9 个节点

| 本插件节点 | 显示名 | 上游节点 | 修改 / 保留说明 |
|---|---|---|---|
| `QG_FreeMemory` | Free Memory | `Free Memory 🆎` | 四步释放整段照搬（卸模型 / 清模型缓存 / gc / 清 CUDA 缓存），每步独立 fail-soft；通配类型用 AusBoss 的 str 子类写法 |
| `QG_MaskRefine` | Mask Refine | `Mask Refine 🆎` | 扩缩 / 补洞 / 平滑 / 羽化 / 边缘精修 / 色阶六步顺序与算法整组搬入（逐样本 max_pool、边界漫水、可分离高斯都保留）；scipy 仍是可选加速，没装走 torch fallback；预览改用本插件的 temp PNG 写法 |
| `QG_LoraLoader` | LoRA Loader | `LoRA Loader 🆎` | 六条 HTTP 路由全部保留（list / thumb / info / hash / civitai / triggers） |
| `QG_ImageCropRotatePad` | Image Crop + Rotate + Pad | `Image Crop + Rotate + Pad 🆎` | 编辑器与几何换算整组搬入（10 个 Python 闭包 + 前端闭包 16 个） |
| `QG_WorkflowNote` | Workflow Note | `Workflow Note 🆎` | — |
| `QG_WorkflowSwitches` | Workflow Switches | `Workflow Switches 🆎` | — |
| `QG_RunTimer` | Run Timer | `Run Timer` | — |
| `QG_ImageCompare` | 图像对比 | `Image Compare A/B 🆎` | 上游约 3900 行，只取滑动 / A / B / 擦除四种模式那部分 |
| `QG_Seed` | 种子 | `Seed 🆎 / Seed` | 卡片界面来自 AusBoss，取值与随机逻辑来自 rgthree；老存档 -1/-2/-3 在 onConfigure 翻译（另参考 rgthree-comfy） |

## 2. ComfyUI-Muye-nodes

- 作者：muyexiuluo (Muye)
- 许可证：MIT —— 全文见 `licenses/ComfyUI-Muye-nodes-LICENSE.txt`
- 仓库：https://github.com/muyexiuluo/ComfyUI-Muye-nodes
- 贡献 8 个节点

| 本插件节点 | 显示名 | 上游节点 | 修改 / 保留说明 |
|---|---|---|---|
| `QG_TextEditOutput` | Text | `Text Edit Output` | v0.6.0；显示名从「文本」改成「Text」是刻意的 |
| `QG_ImageWatermark` | 图像水印 | `AddImageWatermark` | v0.8.5 |
| `QG_TextOverlayImage` | 文字叠加图像 | `TextOverlayImage` | v0.8.5 |
| `QG_ImageGrid` | 宫格图像拼接 | `MuyeGridImageConcat` | v0.8.5；OUTPUT_NODE |
| `QG_MaskColorize` | 遮罩上色 | `MaskColorize` | v0.8.5 |
| `QG_MaskConcat` | 遮罩拼接 | `MaskConcatenate` | v0.8.5 |
| `QG_TextSplit` | 文本按分隔符分割 | `TextSplitByDelimiterEnhanced` | v0.8.5 |
| `QG_SizeSelector` | 尺寸选择器 | `MuyeSizeSelector` | v0.8.5；latent 尺寸必须是 8 的倍数 |

## 3. ComfyUI_Comfyroll_CustomNodes

- 作者：Suzie1 (Comfyroll)
- 许可证：MIT —— 全文见 `licenses/ComfyUI_Comfyroll_CustomNodes-LICENSE.txt`
- 仓库：https://github.com/Suzie1/ComfyUI_Comfyroll_CustomNodes
- 贡献 2 个节点

| 本插件节点 | 显示名 | 上游节点 | 修改 / 保留说明 |
|---|---|---|---|
| `QG_TextConcat` | 文本合并 | `CR_TextConcatenate` | 两个文本输入都是纯槽（forceInput），分隔符是控件，不做任何 trim |
| `QG_TextReplace` | 文本替换 | `CR_TextReplace` | v0.8.5 起搬的是 Muye BatchTextReplace，v0.9.4 换成 Comfyroll；旧存档由 web/text_replace/ 自动迁移 |

## 4. rgthree-comfy

- 作者：rgthree
- 许可证：MIT
- 仓库：https://github.com/rgthree/rgthree-comfy
- 贡献 2 个节点

| 本插件节点 | 显示名 | 上游节点 | 修改 / 保留说明 |
|---|---|---|---|
| `QG_ImageResize` | 图像缩放 | `RgthreeImageResize` | 复用 ComfyUI 自带的 common_upscale，没有额外依赖 |
| `QG_ImageOrLatentSize` | 图像或 Latent 尺寸 | `Image or Latent Size` | — |

## 5. ComfyUI_Custom_Nodes_AlekPet

- 作者：AlekPet
- 许可证：MIT —— 全文见 `licenses/ComfyUI-AlekPet-LICENSE.txt`
- 仓库：https://github.com/AlekPet/ComfyUI_Custom_Nodes_AlekPet
- 贡献 1 个节点

| 本插件节点 | 显示名 | 上游节点 | 修改 / 保留说明 |
|---|---|---|---|
| `QG_GoogleTranslateText` | Google Translate | `GoogleTranslateTextNode` | 上游依赖 googletrans；这里用 requests 直连同一批端点，保持零新增依赖 |

## 6. 孤海工具箱（Goohaitools-comfyui）

- 作者：孤海 (Goohaitools)
- 许可证：GPL-3.0 —— 全文见 `LICENSE`
- 仓库：https://github.com/goohai/Goohaitools-comfyui
- 贡献 3 个节点

| 本插件节点 | 显示名 | 上游节点 | 修改 / 保留说明 |
|---|---|---|---|
| `QG_AnySwitch` | 任意切换 | `GoohaiAnySwitch` | GPL 出处标注保留在文件头 |
| `QG_DisplayAny` | 展示任意 | `GoohaiDisplayAny` | GPL 出处标注保留在文件头 |
| `QG_RouteBlocker` | 路由阻断 | `GoohaiRouteBlocker` | 1:1 搬运，唯一改动是给 any 加 forceInput（不加会在画布上多出一个用不了的控件） |

## 7. ComfyUI-Easy-Use

- 作者：yolain
- 许可证：GPL-3.0 —— 全文见 `LICENSE`
- 仓库：https://github.com/yolain/ComfyUI-Easy-Use
- 贡献 1 个节点

| 本插件节点 | 显示名 | 上游节点 | 修改 / 保留说明 |
|---|---|---|---|
| `QG_IfElse` | 是否判断 | `easy ifElse` | 未选中的那一支走 check_lazy_status 不执行 |

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

| 上游 | 作者 | 贡献节点 |
|---|---|---|
| 孤海工具箱（Goohaitools-comfyui） | 孤海 (Goohaitools) | `QG_AnySwitch`, `QG_DisplayAny`, `QG_RouteBlocker` |
| ComfyUI-Easy-Use | yolain | `QG_IfElse` |

## 原创节点里的参考对象

下面这些节点**代码由本插件作者实现**，不含下列项目的代码；列出参考对象只是
说明思路来源，便于溯源。

| 本插件节点 | 显示名 | 参考对象 | 许可证 | 关系 |
|---|---|---|---|---|
| `QG_EmptyLatentResolution` | 空 Latent 分辨率 | ComfyUI-EmptyLatentResolution「EmptyLatentResolution」 | MIT | 作者自有旧插件，合并进来 |
| `QG_ColorCorrect` | 颜色校正 | comfyui-art-venture「ColorCorrect」 | MIT | 参考思路，代码自行实现 |
| `QG_MDReader` | 加载文档 | ComfyUI-MD-Reader「MarkdownFileReader」 | MIT | 作者自有旧插件，合并进来 |
| `QG_TripleLoader` | 模型加载器 | ComfyUI-TripleLoader「TripleLoader」 | MIT | 作者自有旧插件，合并进来 |
| `QG_StringSwitch` | 字符串切换 | ComfyUI-Crystools「Switch string [Crystools]」 | GPL-3.0 | 参考思路，代码自行实现 |
| `QG_LoadImage` | 加载图像 | Goohaitools-comfyui「加载图像」 | GPL-3.0 | 参考思路，代码自行实现 |
| `QG_MaskCrop` | 遮罩裁剪 | 孤海工具箱 Goohaitools-comfyui「GH_MaskCropV2」 | GPL-3.0 | 参考思路，代码自行实现 |
| `QG_CropRestore` | 裁剪恢复 | 孤海工具箱 Goohaitools-comfyui「GH_CropRestore」 | GPL-3.0 | 参考思路，代码自行实现 |
| `QG_MaskAlign` | 遮罩对齐 | 孤海工具箱 Goohaitools-comfyui「孤海-遮罩对齐」 | GPL-3.0 | 参考思路，代码自行实现 |

## 完全原创（无上游参考）

10 个节点从零实现，没有对应的上游项目：`QG_ColorMatch`、`QG_BoolToggle`、`QG_Number`、`QG_Slider`、`QG_Math`、`QG_Exists`、`QG_CanvasLabel`、`QG_MarkdownNote`、`QG_ExportImage`、`QG_StepPreview`。

另有 3 个节点合并自作者自己的旧插件（`QG_EmptyLatentResolution`、`QG_MDReader`、`QG_TripleLoader`），版权同属作者。

## 许可兼容性

MIT 与 GPL-3.0 兼容（MIT 允许再许可为 GPL-3.0），因此本项目整体以
GPL-3.0-or-later 分发是合规的。被搬运部分的原始版权仍归各上游作者所有；
MIT 来源的许可证全文一并保留在 `licenses/` 目录。

## 如何复核

- `ORIGINS.json` —— 机器可读的逐节点来源清单，本文件的唯一真相源
- `README.md` 的「节点来源」一节 —— 由同一份清单渲染的人读版
- 源文件头部 —— 每个搬运文件都写明上游、许可证、原作者与修改声明
