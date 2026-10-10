# ComfyUI-QG-tools

一个 ComfyUI 自定义节点包。目前包含一个功能完整的 **LoRA 加载器** —— 把整摞 LoRA 收进一个节点里管。

- **一个节点管整摞 LoRA** —— 列表式的行编辑器，每行能搜文件、拖着调强度、随时开关、拖动排序
- **触发词自动汇总** —— 所有启用行的触发词去重后拼成一路字符串输出，直接接进提示词
- **整摞存成模板** —— 常用的 LoRA 组合存下来，在任何同类节点上一键套用
- **吸收模型链上的 LoRA** —— 把串在模型链上下游的其它 LoRA 加载器全部并进来，原节点自动旁通，**出图结果不变**

- **当前版本**：v0.3.0
- **节点**：1 个（`QG LoRA Loader`，分类 `QG-tools`）
- **依赖**：无，只用 ComfyUI 运行期自带的模块
- **许可证**：[GPL-3.0-or-later](LICENSE)

## 安装

**方式一：ComfyUI Manager**

打开 ComfyUI Manager → `Install Custom Nodes` → 搜索 `ComfyUI-QG-Tools`。

> 这条要在插件发布到 [Comfy Registry](https://comfyregistry.org) 之后才可用；
> 还没发布时请用下面的方式二 / 方式三。

**方式二：git clone**

```bash
cd <你的 ComfyUI 目录>/custom_nodes
git clone https://github.com/live1617/ComfyUI-QG-tools
```

**方式三：手动下载**

从 [Releases](https://github.com/live1617/ComfyUI-QG-tools/releases) 下载 zip，
解压到 `custom_nodes/` 下，并确认目录名是 `ComfyUI-QG-tools`。

装完**完整重启 ComfyUI**，控制台应出现：

```
[QG-tools] v0.3.0 加载完成 | 节点数 1
```

无需 `pip install` 任何东西。节点在 `QG-tools` 分类下，搜索 `lora`、`trigger words`、
`strength bars` 等也能找到。

---

## QG LoRA Loader

一个节点管整摞 LoRA：接上 `MODEL`（可选接 `CLIP`），下面排开你要用的所有 LoRA，
输出打好补丁的模型和一行触发词。

### 每一行有什么

| 控件 | 作用 |
|---|---|
| 拖拽手柄 | 按住上下拖动，调整 LoRA 的应用顺序 |
| 开关 | 临时旁通这一行，不必删掉它 |
| 名字 / 选择器 | 点一下打开搜索框挑文件；名字太长会按设置省略 |
| 强度 | 直接在名字上左右拖动就能调，也可以点进数值框；旁边有中心零点强度条 |
| ⓘ | 悬停看预览图、底模、触发词，可顺手查 Civitai |

### 触发词

每个 LoRA 的触发词会自动汇总，**去重**后按 `trigger_separator`（默认 `, `）拼成一路 `triggers`
输出，直接接进提示词。也可以给任意一行**手填自己的触发词**。

有两个刻意的设计：

- 把某行强度调到 **0**，它的触发词**仍然保留** —— 这样对比「用 / 不用这个 LoRA」时只需改权重，提示词不用动。
- 因文件缺失**被跳过**的那一行，不加任何词。

### 整摞存成模板

强度条那一排的 ▤ 按钮可以把当前整摞 LoRA 存成命名模板（存在浏览器本地）。
之后在任何 QG LoRA Loader 上点开 ▤ 就能一键套用，也能删除。

### 吸收模型链上的 LoRA

齿轮菜单里的 **Absorb chain LoRAs** 会沿本节点的模型链往上下游走，把路上遇到的其它 LoRA 加载器
（包含 rgthree、JPS、Pixaroma 等插件的节点）的 LoRA 全部并进本节点，再把那些节点自动旁通 ——
**出图结果完全不变**，只是整摞 LoRA 集中到了一处管理。

前提是那些节点的 LoRA 不是从连线动态接进来的（例如 rgthree 的 Power Lora Loader 接了外部输入）；
这种情况菜单会提示你先断开。整摞 LoRA 也有行数上限，超出时会提示你先清理几行。

### 输入 / 输出

| 方向 | 名称 | 说明 |
|---|---|---|
| 输入（必填） | `model` | 要打 LoRA 补丁的扩散模型 |
| 输入（必填） | `loras` | 序列化的 LoRA 栈，**由面板托管** —— 改行，不要改这个值 |
| 输入（可选） | `clip` | 不接的话 CLIP 强度会被忽略 |
| 输入（可选） | `trigger_separator` | 触发词之间的分隔符，默认 `, `；在齿轮菜单里改，画布上隐藏 |
| 输入（可选） | `on_missing` | 文件缺失时怎么办，见下 |
| 输出 | `model` | 按行顺序打完所有启用 LoRA 的模型 |
| 输出 | `clip` | 同样处理过的 CLIP |
| 输出 | `triggers` | 所有启用行的触发词，去重后拼成的一行字符串 |

### 文件找不到时

- LoRA **只是被移动过**（还在 `loras` 目录里、换了子文件夹）会在运行时按文件名自动找回来，不用管。
- **真的找不到**时，默认行为是**在采样前直接报错停下**，并在错误信息里点名是哪个文件 ——
  无人值守或脚本化跑图不会静默地少打一个 LoRA。
- 想让它在控制台警告一声然后跳过这一行，把齿轮菜单里的 **Stop on missing LoRA** 关掉即可
  （API 调用时对应 `on_missing: "skip"`）。

### 设置

齿轮按钮里是这个节点类型的偏好设置，存在浏览器本地，跟着你所有工作流走：

| 设置 | 默认 | 作用 |
|---|---|---|
| Default strength | 1.0 | 新加一行时的初始强度 |
| Strength step | 0.05 | 拖动与方向键的步长（按住 Shift 恒为 0.01） |
| Separate model / CLIP strength | 关 | 每行显示两个强度框，分别控制模型和 CLIP |
| Strength bars | 开 | 名字后面的中心零点强度条（青色向右为正，红色向左为负） |
| Trigger word separator | `, ` | 拼接 `triggers` 输出用的分隔符 |
| Stop on missing LoRA | 开 | 关掉后，文件缺失只警告并跳过 |
| Hide file extension | 开 | 名字不显示 `.safetensors` |
| Hide folder names | 开 | 只显示文件名（完整路径仍在提示里） |
| Civitai lookup button | 开 | 信息卡里提供「查 Civitai」按钮 |
| Long names | end | 名字太长时怎么省略；`middle` 会保留结尾的数字 |
| Scrub strength on the name | 开 | 在名字上左右拖动改强度（单击仍然是打开选择器） |
| Preview thumbnails | 开 | 悬停选择器时显示预览图 |

## 中文界面

插件自带 `locales/zh/nodeDefs.json`，把 ComfyUI 语言切成中文即生效，**不需要额外装汉化插件**。

## 生效与排障

1. 首次安装要**完整重启 ComfyUI**（不是刷新页面）。
2. 之后前端有更新时，浏览器要 `Ctrl+Shift+R` 强刷 —— ComfyUI 只在页面加载时读一次扩展列表。
3. 后端有 6 条路由，可用这条命令快速自检：

   ```bash
   curl http://127.0.0.1:8188/qg/lora/list
   ```

## 许可证

本项目以 **GPL-3.0-or-later** 发布，全文见 [`LICENSE`](LICENSE)。

其中的 LoRA 加载器抽取并改写自 [ComfyUI-AusBoss](https://github.com/ausboss/ComfyUI-AusBoss)（MIT）。
按 MIT 的要求，原许可证全文保留在 [`licenses/ComfyUI-AusBoss-LICENSE.txt`](licenses/ComfyUI-AusBoss-LICENSE.txt)；
被改写部分的原始版权仍归原作者所有。MIT 与 GPLv3 兼容，因此整体以 GPLv3 分发是合规的。
