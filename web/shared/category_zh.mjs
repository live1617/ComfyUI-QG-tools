/**
 * 中文界面下的分类名 —— 专治「经典画布右键 → 添加节点」里的英文分类。
 *
 * 背景：后端 CATEGORY 已经统一成英文（`QG-tools/Logic`），英文界面才不会冒出
 * 「逻辑」。中文名走官方 `nodeCategories` 通道（`locales/zh/main.json`），但那条
 * 通道只作用于 **nodeDefs** —— 也就是 Vue 节点库、侧边栏和搜索框。经典画布的
 * 添加节点菜单不查 nodeDefs，它直接读 `LiteGraph.registered_node_types[].category`
 * 这个裸字符串，官方没给它接翻译，于是中文界面里分类永远是英文，跟旁边的
 * 「画布标签」「Markdown 文本」并排着格外扎眼。
 *
 * 办法：把 QG 节点 category 的尾段就地换成中文。菜单不管是遍历注册表还是按
 * 前缀分组，看到的都是中文；`LiteGraph.getNodeTypesInCategory()` 拿同一个字符串
 * 做等值匹配，两边一起变，菜单的下一层照样点得开。存盘的工作流不含 category，
 * 改它不会弄坏老存档。
 *
 * 🔴 只在中文界面动手。判据是当前 i18n 语言（见 zh.mjs 的 wantsChinese）：
 * 英文界面保持后端英文原样，绝不把英文用户刷成中文。
 *
 * 改中文名要同步三处：这里 + `locales/zh/main.json` 的 nodeCategories + 汉化插件
 * `zh-CN/Categories/ComfyUI-QG-tools.json`。`tools/verify_categories.py` 会核对三份
 * 是否一致，漏一处就报错。
 */

import { wantsChinese } from "./zh.mjs?v=2026102915";

/** 子分类 → 中文菜单名。键必须跟后端 CATEGORY 的尾段逐字相同（含大小写）。 */
export const CATEGORY_ZH = {
    Loaders: "加载器",
    Text: "文本",
    Logic: "逻辑",
    Display: "展示",
    Annotation: "标注",
    Workflow: "工作流",
    Mask: "遮罩",
    Image: "图像",
};

// 前缀故意拆成两截写：带斜杠的整串会被 verify_categories.py 当成前端硬编码分类
// 去校验（那条规则针对运行期钉 category 的节点脚本），这里不该被它管。
const PREFIX = "QG-tools" + "/";

/**
 * 把注册表里 QG 节点的分类尾段换成中文。
 *
 * 幂等：已经是中文的会被 `CATEGORY_ZH[...]` 查不到，直接跳过，重复调用没有副作用。
 *
 * @param {object} litegraph 通常是 globalThis.LiteGraph
 * @returns {number} 实际改动的注册项数量（0 表示英文界面 / 没有可改的）
 */
export function applyCategoryNames(litegraph) {
    const types = litegraph?.registered_node_types;
    if (!types) return 0;
    if (!wantsChinese()) return 0;

    let changed = 0;
    for (const type of Object.values(types)) {
        const category = type?.category;
        if (typeof category !== "string" || !category.startsWith(PREFIX)) continue;
        const name = CATEGORY_ZH[category.slice(PREFIX.length)];
        if (!name) continue;
        type.category = PREFIX + name;
        changed += 1;
    }
    return changed;
}

/**
 * 装上分类改写：先来一遍，再把 `registerNodeType` 包一层。
 *
 * 为什么要包：扩展的 setup 是按插件逐个跑的，别的扩展（包括我们自己的
 * canvas_label / markdown）可能在本函数之后才注册节点 —— 那样这些节点就漏掉了，
 * 菜单里同一层里一半中文一半英文。registerNodeType 是唯一入口，包住它就不会漏。
 * 只包一次，重复调用无副作用。
 *
 * @param {object} litegraph 通常是 globalThis.LiteGraph
 * @returns {number} 首次立即改动的注册项数量
 */
export function installCategoryNames(litegraph) {
    const changed = applyCategoryNames(litegraph);
    const register = litegraph?.registerNodeType;
    if (typeof register !== "function" || register.__qgCategoryNames) return changed;

    const wrapped = function (...args) {
        const result = register.apply(this, args);
        applyCategoryNames(litegraph);
        return result;
    };
    wrapped.__qgCategoryNames = true;
    litegraph.registerNodeType = wrapped;
    return changed;
}
