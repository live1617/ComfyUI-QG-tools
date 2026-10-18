// QG 节点的英文搜索别名。
//
// 为什么需要这层：汉化之后节点标题是中文（「图像对比」），而 ComfyUI 的节点搜索
// 只按三个字段建 Fuse 索引 —— name（节点 ID）/ display_name / search_aliases。
// 中文标题里没有英文，用户搜 "compare"、"watermark" 就什么都搜不到。
//
// 这里给每个节点配一组英文叫法，由 web/node_aliases/index.js 在
// beforeRegisterVueAppNodeDefs 阶段写进节点定义的 search_aliases。
// 字段名必须是 search_aliases（下划线），前端的 ComfyNodeDefImpl 直接透传；
// 写成 searchAliases 前端不认。
//
// 每条都带上「连写形式」（imagecompare / watermark 这种），因为节点 ID 里的下划线
// 在搜索里不一定当分隔符处理，连写更稳。别名只加英文，中文本来就能搜。

export const NODE_ALIASES = {
    QG_LoraLoader: [
        "lora loader", "loraloader", "load lora", "lora stack", "apply lora", "lora",
    ],
    QG_TripleLoader: [
        "triple loader", "tripleloader", "model loader", "modelloader",
        "checkpoint loader", "unet clip vae", "load checkpoint",
        "model", "loader",
    ],
    QG_MDReader: [
        "md reader", "mdreader", "markdown", "markdown reader", "read markdown",
        "document reader", "load markdown",
        "document", "doc",
    ],
    QG_GoogleTranslateText: [
        "google translate", "googletranslate", "translate", "translation",
        "translate text", "prompt translate",
    ],
    QG_TextEditOutput: [
        "text", "text box", "textbox", "text edit", "prompt box",
    ],
    QG_TextOverlayImage: [
        "text overlay", "textoverlay", "overlay text", "draw text",
        "text on image", "caption",
        "text",
    ],
    QG_TextReplace: [
        "text replace", "textreplace", "batch replace", "find and replace",
        "search replace", "string replace",
        "text",
    ],
    QG_TextSplit: [
        "text split", "textsplit", "split text", "split by delimiter",
        "string split", "chunk text",
        "text",
    ],
    QG_AnySwitch: [
        "any switch", "anyswitch", "switch", "type switch", "merge inputs",
    ],
    QG_IfElse: [
        "if else", "ifelse", "conditional", "condition", "branch",
        "boolean switch",
    ],
    QG_Seed: [
        "seed", "random seed", "seed control", "seed history",
    ],
    QG_DisplayAny: [
        "display any", "displayany", "show any", "debug", "preview any",
        "inspect",
    ],
    QG_RunTimer: [
        "run timer", "runtimer", "timer", "elapsed time", "stopwatch",
        "execution time",
    ],
    QG_WorkflowNote: [
        "workflow note", "workflownote", "note", "comment", "sticky note",
        "annotation",
        "workflow",
    ],
    QG_WorkflowSwitches: [
        "workflow switches", "workflowswitches", "switch group", "toggles",
        "bypass switches",
        "workflow",
    ],
    QG_MaskColorize: [
        "mask colorize", "maskcolorize", "color mask", "mask to color",
        "colorize mask",
        "mask",
    ],
    QG_MaskConcat: [
        "mask concat", "maskconcat", "concat mask", "merge masks",
        "join masks", "mask combine",
        "mask",
    ],
    QG_ImageCropRotatePad: [
        "crop", "rotate", "pad", "crop rotate pad", "croprotatepad",
        "outpaint", "canvas", "straighten", "deskew",
        "image",
    ],
    QG_ImageResize: [
        "image resize", "imageresize", "resize", "scale image", "image scale",
        "upscale",
        "image",
    ],
    QG_ImageOrLatentSize: [
        "image size", "latent size", "get size", "resolution", "width height",
        "dimensions", "size info",
        "image", "size",
    ],
    QG_ImageWatermark: [
        "watermark", "image watermark", "water mark", "add watermark", "logo",
        "stamp",
        "image",
    ],
    QG_ImageGrid: [
        "image grid", "imagegrid", "grid", "tile images", "contact sheet",
        "collage", "mosaic",
        "image",
    ],
    QG_SizeSelector: [
        "size selector", "sizeselector", "resolution preset", "aspect ratio",
        "size picker", "megapixel",
        "size",
    ],
    QG_ImageCompare: [
        "image compare", "imagecompare", "compare", "ab compare",
        "before after", "diff", "slide compare",
        "image",
    ],
};

export const NODE_ALIAS_COUNT = Object.keys(NODE_ALIASES).length;

// 给节点定义数组补 search_aliases。defs 是 /object_info 的对象数组（前端注册前那份），
// 也可能已经是 ComfyNodeDefImpl 实例 —— 两种都是普通对象，直接写字段即可。
// 返回注入成功的节点数，便于日志里核对。
export function applyNodeAliases(defs) {
    if (!Array.isArray(defs)) return 0;
    let count = 0;
    for (const def of defs) {
        const aliases = NODE_ALIASES[def?.name];
        if (!aliases) continue;
        const current = Array.isArray(def.search_aliases) ? def.search_aliases : [];
        // 用 Set 去重，避免重复执行时越堆越多（这个函数可能被调用多次）
        def.search_aliases = [...new Set([...current, ...aliases])];
        count++;
    }
    return count;
}

// 把「别名精确命中」的 QG 节点往前提，最多提 MAX_PIN 个。
//
// 为什么需要：NodeSearchService.calcAuxScores 的打分是
// [匹配等级 a, 位置 o, 文本长度 s, fuse 分]，字典序比较。中文界面下 display_name 是「文本」，
// 英文词只能从 name（QG_TextEditOutput）拿到 a=2；而几十个原生节点叫 `Text xxx`，a=1（前缀命中），
// 于是搜 text 时 QG 文本在全量 481 条里排第 159 —— UI 只取前 64 条，等于搜不到。
//
// 克制规则（用户 2026-10-18：「不要太抢位」）：
//   • 每次最多提前 2 个，不是所有命中项一起拎到前面；
//   • 优先提「别名里排序更靠前」的那个（英文名本身排第一 → 最相关）；
//   • 没被提的命中项保持它原来的名次，不会被额外抬高；
//   • 只认精确相等（aliases.includes(q)），模糊蹭上的不动。
const MAX_PIN = 2;

// 该词在别名数组里的位置：越小越相关（英文名本身在最前）
function aliasRank(def, query) {
    const aliases = NODE_ALIASES[def?.name];
    if (!Array.isArray(aliases)) return 999;
    const i = aliases.indexOf(query);
    return i === -1 ? 999 : i;
}

export function pinExactAliasHits(store) {
    const service = store?.nodeSearchService;
    if (!service) return false;

    // 打原型补丁，不包实例：nodeDef store 里的 nodeSearchService 是 computed，
    // 节点定义一变就 new 一个新实例，包在旧实例上的方法会跟着作废（实测会时灵时不灵）。
    const proto = Object.getPrototypeOf(service);
    const original = proto?.searchNode;
    if (typeof original !== "function") return false;
    if (proto.__qgPatched) return true;      // 已经打过了，算完成（扩展重载时会走到这里）

    let currentQuery = "";      // 闭包存当前查询词（写 Pinia store 的临时属性读不回来）
    const isHit = (def) => {
        const aliases = NODE_ALIASES[def?.name];
        return Array.isArray(aliases) && aliases.includes(currentQuery);
    };

    proto.searchNode = function (query, filters = [], options, extra = {}) {
        currentQuery = typeof query === "string" ? query.trim().toLowerCase() : "";

        const out = original.call(this, query, filters, options, extra);
        if (!currentQuery) return out;

        // 命中项按「别名里的位置」排，最相关的那个排最前；sort 是稳定的，同分保持原顺序
        const rank = (d) => aliasRank(d, currentQuery);

        const hit = out.filter(isHit);
        if (hit.length) {
            // 已经在结果里：只把前 MAX_PIN 个往前提，其余留在原地
            const pinned = hit.slice().sort((a, b) => rank(a) - rank(b)).slice(0, MAX_PIN);
            const pinnedSet = new Set(pinned);
            return [...pinned, ...out.filter((d) => !pinnedSet.has(d))];
        }

        // 一个都没进前 N 条：补一次不限条数的搜索，把最相关的 MAX_PIN 个捞回来
        const all = original.call(this, query, filters, undefined, extra);
        const pinned = all
            .filter(isHit)
            .sort((a, b) => rank(a) - rank(b))
            .slice(0, MAX_PIN);
        if (!pinned.length) return out;

        // 底用 out（已截断的那批），不要拿全量结果去拼，避免列表突然变长
        const pinnedSet = new Set(pinned);
        const merged = [...pinned, ...out.filter((d) => !pinnedSet.has(d))];
        return options?.limit ? merged.slice(0, options.limit) : merged;
    };

    proto.__qgPatched = true;
    return true;
}

// LiteGraph 侧的兜底：老式右键「添加节点」菜单读的是 registered_node_types，
// 那份定义和后端 /object_info 不是同一个对象，得单独补一次。
export function applyNodeAliasesToLiteGraph(liteGraph) {
    const types = liteGraph?.registered_node_types;
    if (!types) return 0;
    let count = 0;
    for (const [name, aliases] of Object.entries(NODE_ALIASES)) {
        const nodeClass = types[name];
        if (!nodeClass || Array.isArray(nodeClass.search_aliases)) continue;
        nodeClass.search_aliases = aliases.slice();
        count++;
    }
    return count;
}
