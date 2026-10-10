# -*- coding: utf-8 -*-
"""nodes/ 下每个模块负责一类节点，抽自哪个插件就在文件头写清楚。

约定（重要，别踩坑）：

1. 只用**相对导入**：`from . import helper` / `from ..utils import x`。
   写 `import helper` 会 ModuleNotFoundError，导致整个插件 IMPORT FAILED。
2. 模块里导出两个字典：
       NODE_CLASS_MAPPINGS = {"节点ID": 节点类}
       NODE_DISPLAY_NAME_MAPPINGS = {"节点ID": "界面上显示的名字"}
3. 想让节点出现在菜单里的某个分类下，给节点类加 `CATEGORY = "QG/..."`。
4. 依赖尽量只用标准库 + ComfyUI 自带的（torch / numpy / PIL / folder_paths / comfy.*）。
   要额外 pip 包，先在 README 里写清楚。

本文件是占位，不要在里面写节点。
"""
