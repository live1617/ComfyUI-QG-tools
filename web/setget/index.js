/**
 * QG 设置点 / QG 获取点 —— 把长连线收成一对「无线」节点。
 *
 * 搬入说明（2026-11-08，用户确认后 1:1 搬运）
 *   来源：自有插件 ComfyUI-QG-Multipack v0.1.0 / web/qg_setget.js（1286 行，两个节点共用）
 *   搬运清单：dist/QG-Multipack-节点搬迁清单.html 的 QG_SetPoint + QG_GetPoint（必须成对）
 *
 *   只做四类必要改动，交互逻辑一行未改：
 *     1) import 路径 ../../scripts/app.js -> /scripts/app.js（本包约定：内置脚本绝对路径）；
 *     2) 界面文案英化 + zhPair（右键菜单 14 项、连接菜单两项、toast、两个节点定义）；
 *        显示名 "QG 设置点 / QG 获取点" -> "Set Point / Get Point"（本包不许带 QG 前缀）；
 *     3) 标题前缀 设置_ / 获取_ 改成按语言取（en "Set_xxx" / zh "设置_xxx"）—— 标题会
 *        写进工作流，中文用户看到的仍是「设置_xxx」；
 *     4) 分类 "QG 工具" -> "QG-tools/Workflow"，并改调 pinCategory() 钉分类。
 *   节点 ID（QG_SetPoint / QG_GetPoint）与 widgets_values 结构没动，老工作流照常打开。
 *
 * 功能规格与交互形态对齐本机 KJNodes 的 SetNode / GetNode（含右键菜单、
 * 标题/颜色/端口名跟随、虚拟连线显示、类型过滤下拉等），代码独立编写，
 * 节点类型用本包自己的 key，互不干扰。
 *
 * 为什么可以完全写在前端（本机 ComfyUI 前端 1.57.4 已查证）：
 *   1. graphToPrompt 会跳过 isVirtualNode 的节点，不把它们写进 prompt；
 *   2. ExecutableNodeDTO.resolveOutput 遇到虚拟节点时，先问
 *      resolveVirtualOutput(slot)，再退回 node.getInputLink(slot)，并用
 *      link.resolve(graph) 取到真正的上游节点；
 *   3. 设置点不重写 getInputLink —— 基类返回它自己左口的连线，正好穿透；
 *      获取点重写 getInputLink，返回同名设置点左口的连线。
 *   4. addCustomNodeDefs 在页面启动时注入一份节点定义，所以「添加节点
 *      → QG-tools → 工作流」里能搜到；python_module 写成 custom_nodes.frontend_only，
 *      节点右上角会带和参考节点一样的绿色 frontend_only 标记。
 *
 * 与 KJNodes 的已知差异（有意不做）：跨子图作用域解析、快捷键、中键创建、
 * 批量转换全部、设置界面。其余节点级行为均对齐。
 *
 * 🔴 装了 KJNodes 时**让位**：连线菜单（Convert to Set/Get）与连接菜单
 * （Add SetNode）都做了运行时探测，发现 KJ 的补丁在场就不再追加自己的条目，
 * 免得同一个菜单里出现两条一模一样的入口。
 *
 * 不进 /object_info、不写后端、不需要重启 ComfyUI：F5 刷新页面即生效。
 * 工作流 JSON 里保存的只有节点 type / 位置 / 名称（serialize_widgets）。
 */
import { app } from "/scripts/app.js";
import { zhPair } from "../shared/zh.mjs?v=2026110820";
import { pinCategory } from "../shared/category_zh.mjs?v=2026110820";

const SET_TYPE = "QG_SetPoint";
const GET_TYPE = "QG_GetPoint";
// 显示名 / 默认标题。后端 def 的 display_name 由语言包翻成中文，
// 这里管的是画布上节点自身的标题（标题会写进工作流）。
const setTitle = () => zhPair("Set Point", "设置点");
const getTitle = () => zhPair("Get Point", "获取点");
// 标题前缀（"Set_xxx" / 中文界面 "设置_xxx"）。标题会写进工作流，所以两份都给。
const setPrefix = () => zhPair("Set", "设置");
const getPrefix = () => zhPair("Get", "获取");
const CATEGORY = "QG-tools/Workflow";
const WILDCARD = "*";
const NAME_WIDGET = "Name";

const LGraphNode = LiteGraph.LGraphNode;

/* ------------------------------------------------------------------ */
/* 通用工具                                                            */
/* ------------------------------------------------------------------ */

function currentGraph() {
    return app.graph || app.canvas?.graph || null;
}

function nodesOf(graph) {
    return graph?._nodes || graph?.nodes || [];
}

/** graph.links 新版是 Map、旧版是数组/对象；传进来的也可能已经是 link 对象。 */
function getLink(graph, id) {
    if (!graph || id == null) return null;
    if (typeof id === "object") return id;
    if (typeof graph.getLink === "function") return graph.getLink(id) || null;
    const links = graph.links;
    if (!links) return null;
    if (typeof links.get === "function") return links.get(id) || null;
    return links[id] || null;
}

function isSet(node) {
    return node?.type === SET_TYPE;
}

function isGet(node) {
    return node?.type === GET_TYPE;
}

function nameOf(node) {
    return String(node?.widgets?.[0]?.value ?? "");
}

function findSets(graph, name) {
    const list = nodesOf(graph).filter(isSet);
    return name === undefined ? list : list.filter((n) => nameOf(n) === name);
}

function findGets(graph, name) {
    const list = nodesOf(graph).filter(isGet);
    return name === undefined ? list : list.filter((n) => nameOf(n) === name);
}

function findSet(graph, name) {
    return name ? findSets(graph, name)[0] || null : null;
}

function prefixedTitle(prefix, name) {
    return `${prefix}_${name}`;
}

/** 旧版默认尺寸（宽 230）随工作流恢复后收紧到紧凑尺寸；手动调过大小的节点不动。 */
function compactLegacySize(node, legacyHeight) {
    if (node.size?.[0] === 230 && node.size?.[1] === legacyHeight) {
        node.size = [210, 60];
    }
}

/** 从一条 link 上取最可靠的类型：link.type → resolve() → 上游输出口类型。 */
function linkType(graph, link) {
    if (!link) return WILDCARD;
    if (link.type && link.type !== WILDCARD) return String(link.type).split(",")[0].trim();
    try {
        const resolved = link.resolve?.(graph);
        const slot = resolved?.output || resolved?.subgraphInput || resolved?.input;
        if (slot?.type && slot.type !== WILDCARD) {
            return String(slot.type).split(",")[0].trim();
        }
    } catch (_) {
        /* 旧版 litegraph 的 link 没有 resolve，走下面的兜底 */
    }
    const source = graph?.getNodeById?.(link.origin_id);
    const type = source?.outputs?.[link.origin_slot]?.type;
    return type && type !== WILDCARD ? String(type).split(",")[0].trim() : WILDCARD;
}

/** 逗号分隔的类型串里是否包含 type（与 KJ 的双向 split 比对一致）。 */
function typeMatches(typeList, type) {
    return String(typeList || "")
        .split(",")
        .map((s) => s.trim())
        .includes(type);
}

/* ------------------------------------------------------------------ */
/* 自动上色（KJ 的 nodeAutoColor 默认开启，这里同样默认开启）           */
/* ------------------------------------------------------------------ */

let typeColorMap = null;
function setColorAndBgColor(node, type) {
    if (!typeColorMap) {
        typeColorMap = {
            DEFAULT: LGraphCanvas.node_colors?.gray,
            MODEL: LGraphCanvas.node_colors?.blue,
            LATENT: LGraphCanvas.node_colors?.purple,
            VAE: LGraphCanvas.node_colors?.red,
            WANVAE: LGraphCanvas.node_colors?.red,
            CONDITIONING: LGraphCanvas.node_colors?.brown,
            IMAGE: LGraphCanvas.node_colors?.pale_blue,
            CLIP: LGraphCanvas.node_colors?.yellow,
            FLOAT: LGraphCanvas.node_colors?.green,
            MASK: { color: "#1c5715", bgcolor: "#1f401b" },
            INT: { color: "#1b4669", bgcolor: "#29699c" },
            CONTROL_NET: { color: "#156653", bgcolor: "#1c453b" },
            NOISE: { color: "#2e2e2e", bgcolor: "#242121" },
            GUIDER: { color: "#3c7878", bgcolor: "#1c453b" },
            SAMPLER: { color: "#614a4a", bgcolor: "#3b2c2c" },
            SIGMAS: { color: "#485248", bgcolor: "#272e27" },
        };
    }
    const colors = typeColorMap[type] || LGraphCanvas.node_colors?.gray;
    if (colors) {
        node.color = colors.color;
        node.bgcolor = colors.bgcolor;
    }
}

function autoColor(node, type) {
    if (type === WILDCARD) {
        node.color = null;
        node.bgcolor = null;
    } else {
        setColorAndBgColor(node, type);
    }
}

/** 找不到配对设置点时的警告：toast + 节点标记（与 KJ 行为一致）。 */
const errorNodes = new Set();
function showAlert(message, nodes) {
    const list = nodes ? (Array.isArray(nodes) ? nodes : [nodes]) : [];
    const info = list
        .map((n) => `${n.title || n.type} [${Math.round(n.pos?.[0] ?? 0)}, ${Math.round(n.pos?.[1] ?? 0)}]`)
        .join(", ");
    if (list.length) {
        for (const n of errorNodes) n.has_errors = false;
        errorNodes.clear();
        setTimeout(() => {
            for (const n of list) {
                n.has_errors = true;
                errorNodes.add(n);
            }
            app.canvas?.setDirty?.(true, true);
        }, 100);
    }
    app.extensionManager?.toast?.add?.({
        severity: "warn",
        summary: zhPair("Set / Get Point", "设置/获取点"),
        detail: info ? `${message} — ${info}` : message,
        life: 5000,
    });
}

/** Vue 节点模式会缓存 options，替换对象 + 重排 widgets 才能强制重新提取。 */
function refreshGetCombos(graph) {
    for (const node of nodesOf(graph)) {
        if (!isGet(node) || !node.widgets?.[0]) continue;
        const widget = node.widgets[0];
        widget.options = makeComboOptions(node);
        const index = node.widgets.indexOf(widget);
        if (index >= 0) {
            node.widgets.splice(index, 1);
            node.widgets.splice(index, 0, widget);
        }
        node.setDirtyCanvas?.(true, true);
    }
    app.canvas?.setDirty?.(true, true);
}

function repaint() {
    app.canvas?.setDirty?.(true, true);
}

/** 获取点下拉：同图所有设置点的名字（已连线时按下游输入类型过滤）。 */
function visibleSetNames(graph, filterType) {
    const names = [];
    for (const setter of findSets(graph)) {
        const name = nameOf(setter);
        if (!name) continue;
        if (filterType && filterType !== WILDCARD) {
            const setType = setter.inputs?.[0]?.type;
            if (setType && setType !== WILDCARD && !typeMatches(filterType, setType)) continue;
        }
        if (!names.includes(name)) names.push(name);
    }
    return names.sort();
}

function makeComboOptions(node) {
    const options = { getOptionLabel: (value) => value ?? "" };
    Object.defineProperty(options, "values", {
        get: () => {
            const graph = node.graph || currentGraph();
            // 与 KJ 的 filterGetNodeOptions（默认开）一致：已连线时只显示
            // 类型兼容的设置点
            let filterType = null;
            const links = node.outputs?.[0]?.links;
            if (links?.length && graph) {
                const link = getLink(graph, links[0]);
                const target = link && graph.getNodeById?.(link.target_id);
                const targetType = target?.inputs?.[link.target_slot]?.type;
                if (targetType) filterType = targetType;
            }
            const names = visibleSetNames(graph, filterType);
            const current = nameOf(node);
            if (current && !names.includes(current)) names.unshift(current);
            return names;
        },
        enumerable: true,
        configurable: true,
    });
    return options;
}

/**
 * 对齐 KJ 的 legacy 下拉交互（Vue 模式用原生行为）：
 *  - 点击控件左/右 40px 区域 = 上一个 / 下一个值；
 *  - 点中间弹自定义菜单，每个条目左边框按同名设置点的类型着色，
 *    顺带绕开旧版 ComboWidget 空数组时不显示搜索框的问题。
 */
function patchComboWidget(widget, node) {
    const options = widget.options;
    const origOnClick = widget.onClick?.["bind"](widget);
    widget.onClick = (params) => {
        if (LiteGraph.vueNodesMode) return origOnClick?.(params);
        const { e, canvas } = params;
        const x = e.canvasX - node.pos[0];
        const width = widget.width || node.size[0];
        if (x < 40) return widget.decrementValue?.({ e, node, canvas });
        if (x > width - 40) return widget.incrementValue?.({ e, node, canvas });
        const rawValues = options.values;
        const labels = rawValues.map((v) => options.getOptionLabel(v) || v);
        const menu = new LiteGraph.ContextMenu(labels, {
            scale: Math.max(1, canvas.ds.scale),
            event: e,
            className: "dark",
            callback: (selectedLabel) => {
                const index = labels.indexOf(selectedLabel);
                if (index >= 0) widget.setValue(rawValues[index], { e, node, canvas });
            },
        });
        // 条目左边框颜色 = 该名字设置点的连线类型色
        if (!typeColorMap) setColorAndBgColor({}, WILDCARD); // 确保配色表已初始化
        const entries = menu.root?.querySelectorAll(".litemenu-entry");
        rawValues.forEach((name, i) => {
            if (!entries?.[i]) return;
            const setter = findSet(node.graph || currentGraph(), name);
            const type = setter?.inputs?.[0]?.type;
            const colors = typeColorMap?.[type];
            const borderColor =
                canvas.default_connection_color_byType?.[type] ||
                LGraphCanvas.link_type_colors?.[type] ||
                (colors && (colors.groupcolor || colors.bgcolor || colors.color)) ||
                "#888";
            entries[i].style.borderLeft = `4px solid ${borderColor}`;
            entries[i].style.paddingLeft = "8px";
        });
    };
}

/** 粘贴一组 Set/Get 时，Set 因重名被自动改名，把新名字告诉同批的 Get。 */
const pasteRenameMap = new Map();

/** 右键菜单打开那一刻的选区快照（含右键节点本身）。 */
function snapshotSelected(node) {
    const set = new Set(Object.values(app.canvas?.selected_nodes || {}));
    set.add(node);
    return [...set];
}

/* ------------------------------------------------------------------ */
/* QG 设置点                                                           */
/* ------------------------------------------------------------------ */

class QGSetPoint extends LGraphNode {
    static title = setTitle();
    static category = CATEGORY;
    serialize_widgets = true;
    drawConnection = false;

    constructor(title) {
        super(title ?? setTitle());
        this.type = SET_TYPE;
        this.comfyClass = SET_TYPE;
        this.isVirtualNode = true;
        this.properties = {
            ...(this.properties || {}),
            previousName: "",
            "Node name for S&R": SET_TYPE,
            aux_id: "qg/ComfyUI-QG-tools",
        };
        this.addWidget("text", NAME_WIDGET, "", () => this.onNameChanged(), {});
        this.addInput(WILDCARD, WILDCARD);
        this.addOutput(WILDCARD, WILDCARD);
        this.size = [210, 60];
    }

    /** 名字冲突时追加 _0 / _1 …；只跟同图里其它设置点比。 */
    validateName() {
        const graph = this.graph || currentGraph();
        let value = nameOf(this);
        if (!value || !graph) return false;
        const taken = new Set(
            findSets(graph)
                .filter((n) => n !== this)
                .map(nameOf)
        );
        const original = value;
        const base = this._justAdded ? value.replace(/_\d+$/, "") : value;
        let index = 0;
        while (taken.has(value)) value = `${base}_${index++}`;
        if (value !== original) this.widgets[0].value = value;
        this.title = prefixedTitle(setPrefix(), value);
        return value !== original;
    }

    onNameChanged() {
        if (app.configuringGraph || !this.widgets?.[0]) return;
        const oldName = this.properties.previousName || "";
        this.validateName();
        const newName = nameOf(this);
        if (newName) this.title = prefixedTitle(setPrefix(), newName);
        this.properties.previousName = newName;
        this.update();
        setTimeout(() => refreshGetCombos(this.graph || currentGraph()), 0);
        repaint();
    }

    /** KJ 的 update()：同步同名获取点的类型与名字。 */
    update() {
        const graph = this.graph || currentGraph();
        if (!graph) return;
        const type = this.inputs[0].type;
        for (const getter of findGets(graph, nameOf(this))) {
            getter.setType?.(type);
        }
        if (this.widgets[0].value && this.properties.previousName) {
            for (const getter of findGets(graph, this.properties.previousName)) {
                getter.setName?.(this.widgets[0].value);
            }
        }
        repaint();
    }

    onConnectionsChange(slotType, slot, isChangeConnect, link_info) {
        if (app.configuringGraph) return;
        const INPUT = LiteGraph.INPUT;
        const OUTPUT = LiteGraph.OUTPUT;
        if (slotType === INPUT && !isChangeConnect) {
            // 断开输入：输出仍有连线时继承输出类型，否则全部重置
            if (this.outputs[0]?.links?.length > 0) {
                this.inputs[slot].type = this.outputs[0].type;
                this.inputs[slot].name = this.outputs[0].name;
            } else {
                this.inputs[0].type = WILDCARD;
                this.inputs[0].name = WILDCARD;
                this.outputs[0].type = WILDCARD;
                this.outputs[0].name = WILDCARD;
                this.title = setTitle();
                this.color = null;
                this.bgcolor = null;
            }
            this.update();
        } else if (slotType === OUTPUT && !isChangeConnect) {
            // 断开输出：输入仍有连线时保持输入类型，否则全部重置
            if (this.inputs[0]?.link != null) {
                this.outputs[slot].type = this.inputs[0].type;
                this.outputs[slot].name = this.inputs[0].name;
            } else {
                this.inputs[0].type = WILDCARD;
                this.inputs[0].name = WILDCARD;
                this.outputs[slot].type = WILDCARD;
                this.outputs[slot].name = WILDCARD;
                this.color = null;
                this.bgcolor = null;
            }
        } else if (link_info && slotType === INPUT && isChangeConnect) {
            // 连上输入：解析上游类型，同步端口与标题
            const type = linkType(this.graph, link_info);
            if (type && type !== WILDCARD) {
                if (this.title === setTitle()) {
                    this.title = prefixedTitle(setPrefix(), type);
                }
                this.validateName();
                this.properties.previousName = this.widgets[0].value;
                this.inputs[0].type = type;
                this.inputs[0].name = type;
                this.outputs[0].type = type;
                this.outputs[0].name = type;
                autoColor(this, type);
                this.update();
            } else {
                showAlert(zhPair(
                `Cannot read the input type of ${this.title}.`,
                `节点 ${this.title} 的输入类型无法识别。`), this);
            }
        } else if (link_info && slotType === OUTPUT && isChangeConnect) {
            // 连上输出：输入已定类型就直接同步，否则从下游输入口解析
            const inputType = this.inputs[0]?.type;
            if (inputType && inputType !== WILDCARD) {
                this.outputs[0].type = inputType;
                this.outputs[0].name = inputType;
            } else {
                const graph = this.graph || currentGraph();
                const link = getLink(graph, link_info.id ?? link_info);
                const target = link && graph.getNodeById?.(link.target_id);
                const type = target?.inputs?.[link.target_slot]?.type;
                if (type && type !== WILDCARD) {
                    this.inputs[0].type = type;
                    this.inputs[0].name = type;
                    this.outputs[0].type = type;
                    this.outputs[0].name = type;
                    autoColor(this, type);
                }
            }
        }
        this.setDirtyCanvas?.(true, true);
        repaint();
    }

    onAdded() {
        this._justAdded = true;
        setTimeout(() => refreshGetCombos(this.graph || currentGraph()), 0);
    }

    onRemoved() {
        setTimeout(() => refreshGetCombos(this.graph || currentGraph()), 0);
    }

    onConfigure() {
        this.isVirtualNode = true;
        this.serialize_widgets = true;
        compactLegacySize(this, 90);
        if (this._justAdded) {
            const oldName = nameOf(this);
            if (this.validateName()) {
                pasteRenameMap.set(oldName, nameOf(this));
                setTimeout(() => pasteRenameMap.delete(oldName), 0);
            }
            // 粘贴后还没有连线，重置类型与颜色（与 KJ 一致）
            if (this.inputs[0]?.link == null) {
                this.inputs[0].type = WILDCARD;
                this.inputs[0].name = WILDCARD;
                this.outputs[0].type = WILDCARD;
                this.outputs[0].name = WILDCARD;
                this.color = null;
                this.bgcolor = null;
            }
        }
        this._justAdded = false;
        this.properties.previousName = nameOf(this);
        if (nameOf(this)) this.title = prefixedTitle(setPrefix(), nameOf(this));
        setTimeout(() => {
            this.update();
            refreshGetCombos(this.graph || currentGraph());
        }, 0);
    }

    clone() {
        const cloned = super.clone();
        cloned.inputs[0].name = WILDCARD;
        cloned.inputs[0].type = WILDCARD;
        cloned.properties.previousName = "";
        cloned.size = cloned.computeSize();
        return cloned;
    }

    getExtraMenuOptions(_, options) {
        const linkTypeOfThis = this.inputs[0]?.type;
        options.unshift(
            {
                content: this.drawConnection
                    ? zhPair("Hide link", "隐藏连线")
                    : zhPair("Show link", "显示连线"),
                callback: () => {
                    this.drawConnection = !this.drawConnection;
                    repaint();
                },
            },
            {
                content: zhPair("Hide all links", "隐藏所有连线"),
                callback: () => {
                    for (const n of nodesOf(this.graph || currentGraph())) {
                        if (isSet(n) || isGet(n)) n.drawConnection = false;
                    }
                    repaint();
                },
            }
        );
        options.unshift({
            content: zhPair("Convert to plain links", "转换成普通连线"),
            callback: () => {
                const graph = this.graph || currentGraph();
                for (const n of snapshotSelected(this).filter(isSet)) {
                    convertToLinks(graph, nameOf(n));
                }
            },
        });
        options.unshift({
            content: zhPair("Add matching Get Point", "添加配对的获取点"),
            callback: () => {
                const graph = this.graph || currentGraph();
                const getter = LiteGraph.createNode(GET_TYPE);
                if (!getter) return;
                getter.pos = [this.pos[0] + this.size[0] + 30, this.pos[1]];
                graph.add(getter);
                getter.widgets[0].value = this.widgets[0].value;
                getter.onRename?.();
                app.canvas?.selectNode?.(getter, false);
                setTimeout(() => refreshGetCombos(graph), 0);
                repaint();
            },
        });
        // Getters 子菜单：跳转到每个同名获取点
        const getters = findGets(this.graph || currentGraph(), nameOf(this));
        if (getters.length) {
            options.unshift({
                content: zhPair("Get Points", "获取点"),
                has_submenu: true,
                submenu: {
                    title: zhPair("Get Points", "获取点"),
                    options: getters.map((getter) => ({
                        content: `${getter.title} id: ${getter.id}`,
                        callback: () => {
                            app.canvas?.centerOnNode?.(getter);
                            app.canvas?.selectNode?.(getter, false);
                            repaint();
                        },
                    })),
                },
            });
        }
        void linkTypeOfThis;
    }
}

/* ------------------------------------------------------------------ */
/* QG 获取点                                                           */
/* ------------------------------------------------------------------ */

class QGGetPoint extends LGraphNode {
    static title = getTitle();
    static category = CATEGORY;
    serialize_widgets = true;
    drawConnection = false;
    currentSetter = null;

    constructor(title) {
        super(title ?? getTitle());
        this.type = GET_TYPE;
        this.comfyClass = GET_TYPE;
        this.isVirtualNode = true;
        this.properties = {
            ...(this.properties || {}),
            "Node name for S&R": GET_TYPE,
            aux_id: "qg/ComfyUI-QG-tools",
        };
        const comboWidget = this.addWidget(
            "combo",
            NAME_WIDGET,
            "",
            () => {
                if (!app.configuringGraph) this.onRename();
            },
            makeComboOptions(this)
        );
        patchComboWidget(comboWidget, this);
        this.addOutput(WILDCARD, WILDCARD);
        this.size = [210, 60];
    }

    setName(name) {
        this.widgets[0].value = name;
        this.onRename();
        this.serialize?.();
    }

    onRename() {
        const graph = this.graph || currentGraph();
        const setter = findSet(graph, nameOf(this));
        if (setter) {
            this.setType(setter.inputs[0]?.type || WILDCARD);
            this.title = prefixedTitle(getPrefix(), nameOf(this));
        } else {
            this.setType(WILDCARD);
            const name = nameOf(this);
            this.title = name ? prefixedTitle(getPrefix(), name) : getTitle();
        }
        repaint();
    }

    /** 与 KJ 的 setType 一致：端口名 = 类型名，随后校验连线与上色。 */
    setType(type) {
        this.outputs[0].name = type;
        this.outputs[0].type = type;
        this.validateLinks();
        autoColor(this, type);
        this.setDirtyCanvas?.(true, true);
    }

    /** 类型变了以后，把已经不兼容的右口连线断开，避免留下非法链接。 */
    validateLinks() {
        const graph = this.graph || currentGraph();
        const type = this.outputs[0]?.type;
        if (!graph || !type || type === WILDCARD) return;
        for (const id of [...(this.outputs[0].links || [])]) {
            const link = getLink(graph, id);
            if (!link) continue;
            const target = graph.getNodeById?.(link.target_id);
            const targetType = target?.inputs?.[link.target_slot]?.type;
            if (!targetType || targetType === WILDCARD) continue;
            if (typeMatches(targetType, type)) continue;
            if (typeMatches(link.type, type)) continue;
            try {
                graph.removeLink?.(id);
            } catch (_) {
                /* 旧版没有 removeLink 时保留连线，由 ComfyUI 自己校验 */
            }
        }
    }

    /**
     * 这是虚拟节点能跑起来的关键：返回「同名设置点左口」的那条 link，
     * ComfyUI 会用它把本节点右口的下游直接接到真实上游节点上。
     */
    getInputLink(slot) {
        if (slot !== 0) return null;
        const graph = this.graph || currentGraph();
        const name = nameOf(this);
        if (!name) return null;
        const setter = findSet(graph, name);
        if (setter) {
            const slotInfo = setter.inputs?.[slot];
            if (!slotInfo || slotInfo.link == null) return null;
            return getLink(setter.graph || graph, slotInfo.link);
        }
        showAlert(zhPair(
            `No Set Point named "${name}"`,
            `找不到名为 ${name} 的设置点`), this);
        return null;
    }

    onConnectionsChange() {
        if (app.configuringGraph) return;
        this.validateLinks();
    }

    onAdded() {
        this._justAdded = true;
    }

    onConfigure() {
        this.isVirtualNode = true;
        this.serialize_widgets = true;
        compactLegacySize(this, 76);
        if (this._justAdded) {
            const newName = pasteRenameMap.get(nameOf(this));
            if (newName && this.widgets?.[0]) this.widgets[0].value = newName;
            setTimeout(() => this.onRename(), 0);
        }
        this._justAdded = false;
        setTimeout(() => {
            this.onRename();
            refreshGetCombos(this.graph || currentGraph());
        }, 0);
    }

    clone() {
        const cloned = super.clone();
        cloned.size = cloned.computeSize();
        return cloned;
    }

    goToSetter() {
        const setter = this.currentSetter || findSet(this.graph || currentGraph(), nameOf(this));
        if (!setter) return;
        app.canvas?.centerOnNode?.(setter);
        app.canvas?.selectNode?.(setter, false);
        repaint();
    }

    getExtraMenuOptions(_, options) {
        this.currentSetter = findSet(this.graph || currentGraph(), nameOf(this));
        if (!this.currentSetter) return;
        options.unshift(
            {
                content: zhPair("Convert to plain links", "转换成普通连线"),
                callback: () => {
                    const graph = this.graph || currentGraph();
                    const setters = new Set(
                        snapshotSelected(this)
                            .filter(isGet)
                            .map((n) => findSet(graph, nameOf(n)))
                            .filter(Boolean)
                    );
                    for (const setter of setters) convertToLinks(graph, nameOf(setter));
                },
            },
            {
                content: zhPair("Go to Set Point", "跳转到设置点"),
                callback: () => this.goToSetter(),
            },
            {
                content: this.currentSetter.drawConnection
                    ? zhPair("Hide link", "隐藏连线")
                    : zhPair("Show link", "显示连线"),
                callback: () => {
                    // 与 KJ 一致：开关作用在设置点上（绘制钩子只认设置点），
                    // 同时同步到获取点自身，视口防裁剪补丁才能覆盖两端
                    this.currentSetter.drawConnection = !this.currentSetter.drawConnection;
                    this.drawConnection = this.currentSetter.drawConnection;
                    repaint();
                },
            }
        );
    }
}

/* ------------------------------------------------------------------ */
/* 把一对虚拟节点还原成真实连线（分享工作流给没装本包的人时有用）        */
/* ------------------------------------------------------------------ */

function convertToLinks(graph, name) {
    const setter = findSet(graph, name);
    if (!setter) return;
    let inputLink = null;
    try {
        inputLink = setter.getInputLink?.(0) || null;
    } catch (_) {
        inputLink = null;
    }
    inputLink = inputLink || getLink(graph, setter.inputs?.[0]?.link);
    const source = inputLink && graph.getNodeById?.(inputLink.origin_id);
    const sourceSlot = inputLink?.origin_slot;
    const targets = [];
    const collect = (node) => {
        for (const id of [...(node.outputs?.[0]?.links || [])]) {
            const link = getLink(graph, id);
            const target = link && graph.getNodeById?.(link.target_id);
            if (target && target !== setter) targets.push([target, link.target_slot]);
        }
    };
    collect(setter);
    const getters = findGets(graph, name);
    for (const getter of getters) collect(getter);

    if (source && sourceSlot != null) {
        for (const [target, slot] of targets) {
            try {
                source["connect"](sourceSlot, target, slot);
            } catch (error) {
                console.warn("[QG-tools] 转换连线失败：", error);
            }
        }
    }
    const remove = (node) => {
        try {
            if (typeof graph.remove === "function") graph.remove(node);
            else graph.removeNode?.(node);
        } catch (error) {
            console.warn("[QG-tools] 移除虚拟节点失败：", error);
        }
    };
    for (const getter of getters) remove(getter);
    remove(setter);
    setTimeout(() => refreshGetCombos(graph), 0);
    repaint();
}

/* ------------------------------------------------------------------ */
/* KJ 右键菜单对齐：添加设置/获取节点、输出转换为设置/获取              */
/* ------------------------------------------------------------------ */

/** 在节点旁创建并自动连到第一个空闲口（对齐 KJ 的 addNode）。 */
function addNodeNear(nodeType, nextTo, side) {
    const node = LiteGraph.createNode(nodeType);
    if (!node) return;
    const graph = nextTo.graph || currentGraph();
    graph.add(node);
    node.pos = [
        side === "left" ? nextTo.pos[0] - (node.size[0] + 30) : nextTo.pos[0] + nextTo.size[0] + 30,
        nextTo.pos[1],
    ];
    if (side === "left") {
        // 新节点在左侧：新节点输出 → 目标第一个空闲输入
        for (let i = 0; i < nextTo.inputs.length; i++) {
            if (nextTo.inputs[i].link == null) {
                node.pos[1] += i * (node.size[1] + 32);
                node["connect"](0, nextTo, i);
                break;
            }
        }
    } else {
        // 新节点在右侧：目标第一个空闲输出 → 新节点输入
        for (let o = 0; o < nextTo.outputs.length; o++) {
            const links = nextTo.outputs[o].links;
            if (!links || links.length === 0) {
                node.pos[1] += o * (node.size[1] + 32);
                for (let i = 0; i < node.inputs.length; i++) {
                    if (node.inputs[i].link == null) {
                        nextTo["connect"](o, node, i);
                        break;
                    }
                }
                break;
            }
        }
    }
    app.canvas?.selectNode?.(node, false);
    repaint();
    return node;
}

/** 把节点每个有连线的输出改造成「设置点 + 每个下游一个获取点」（折叠）。 */
function convertOutputsToSetGet(graph, node) {
    if (!graph || !node) return;
    for (let slotIdx = 0; slotIdx < node.outputs.length; slotIdx++) {
        const output = node.outputs[slotIdx];
        if (!output.links || output.links.length === 0) continue;

        const linkName = output.name || output.type || WILDCARD;
        const targets = [];
        const linksToRemove = [];
        for (const linkId of [...output.links]) {
            const link = getLink(graph, linkId);
            const targetNode = link && graph.getNodeById?.(link.target_id);
            if (targetNode && !isSet(targetNode) && !isGet(targetNode)) {
                targets.push([targetNode, link.target_slot]);
                linksToRemove.push(linkId);
            }
        }
        if (targets.length === 0) continue;

        const setNode = LiteGraph.createNode(SET_TYPE);
        if (!setNode) continue;
        setNode.pos = [node.pos[0] + node.size[0] + 30, node.pos[1] + slotIdx * 60];
        graph.add(setNode);
        setNode.flags.collapsed = true;
        for (const linkId of linksToRemove) graph.removeLink(linkId);
        node["connect"](slotIdx, setNode, 0);
        setNode.widgets[0].value = linkName;
        setNode.validateName();
        setNode.properties.previousName = nameOf(setNode);

        for (const [targetNode, targetSlot] of targets) {
            const getter = LiteGraph.createNode(GET_TYPE);
            if (!getter) continue;
            getter.pos = [targetNode.pos[0] - (getter.size[0] + 30), targetNode.pos[1]];
            graph.add(getter);
            getter.flags.collapsed = true;
            getter.widgets[0].value = nameOf(setNode);
            getter.onRename?.();
            getter["connect"](0, targetNode, targetSlot);
        }
    }
    setTimeout(() => refreshGetCombos(graph), 0);
    repaint();
}

/* ------------------------------------------------------------------ */
/* 虚拟连线绘制（对齐 KJ：per-node 显示开关 + 可见节点补丁）            */
/* ------------------------------------------------------------------ */

function patchCanvasDrawing() {
    // 让开了「显示连线」的节点在视口外也不被裁剪
    const originalComputeVisibleNodes = LGraphCanvas.prototype.computeVisibleNodes;
    if (!originalComputeVisibleNodes.__qgSetGet) {
        LGraphCanvas.prototype.computeVisibleNodes = function () {
            const visible = originalComputeVisibleNodes.apply(this, arguments);
            const graph = this.graph;
            if (graph?._nodes) {
                for (const node of graph._nodes) {
                    if ((isSet(node) || isGet(node)) && node.drawConnection && !visible.includes(node)) {
                        visible.push(node);
                    }
                }
            }
            return visible;
        };
        LGraphCanvas.prototype.computeVisibleNodes.__qgSetGet = true;
    }

    const originalOnDrawBackground = app.canvas.onDrawBackground;
    app.canvas.onDrawBackground = function (ctx) {
        originalOnDrawBackground?.apply(this, arguments);
        const graph = this.graph || app.graph;
        if (!graph?._nodes) return;
        for (const setNode of graph._nodes) {
            if (!isSet(setNode) || !setNode.drawConnection) continue;
            const getters = findGets(graph, nameOf(setNode));
            if (!getters.length) continue;
            const linkType = setNode.inputs[0]?.type;
            const color =
                this.default_connection_color_byType?.[linkType] ||
                LGraphCanvas.link_type_colors?.[linkType] ||
                setNode.bgcolor ||
                "#AAA";
            const startPos = setNode.getConnectionPos(false, 0);
            for (const getter of getters) {
                const endPos = getter.getConnectionPos(true, 0);
                const highlighted = setNode.is_selected || getter.is_selected;
                this.renderLink(
                    ctx,
                    startPos,
                    endPos,
                    null,
                    false,
                    null,
                    highlighted ? "#FFF" : color,
                    LiteGraph.RIGHT,
                    LiteGraph.LEFT
                );
            }
        }
    };
}

/* ------------------------------------------------------------------ */
/* 连线右键菜单：转换为 设置/获取（对齐 KJ 的 LinkToSetGet）           */
/* ------------------------------------------------------------------ */

/** 把一条真实连线原地改造成「设置点 + 获取点」。 */
function linkToSetGet(graph, link) {
    const originNode = graph.getNodeById?.(link.origin_id);
    const targetNode = graph.getNodeById?.(link.target_id);
    if (!originNode || !targetNode) return;
    const outputSlot = originNode.outputs?.[link.origin_slot];
    const linkName = outputSlot?.name || outputSlot?.type || WILDCARD;

    const setNode = LiteGraph.createNode(SET_TYPE);
    if (!setNode) return;
    setNode.pos = [originNode.pos[0] + originNode.size[0] + 30, originNode.pos[1]];
    graph.add(setNode);

    const getter = LiteGraph.createNode(GET_TYPE);
    if (!getter) return;
    graph.add(getter);
    getter.pos = [targetNode.pos[0] - (getter.size[0] + 30), targetNode.pos[1]];

    graph.removeLink?.(link.id);

    originNode["connect"](link.origin_slot, setNode, 0);
    setNode.widgets[0].value = linkName;
    setNode.validateName();
    setNode.properties.previousName = nameOf(setNode);

    getter.widgets[0].value = nameOf(setNode);
    getter.onRename?.();
    getter["connect"](0, targetNode, link.target_slot);

    setTimeout(() => refreshGetCombos(graph), 0);
    repaint();
}

/**
 * 官方没有给连线菜单留扩展钩子，和 KJ 一样用 DOM 补丁：
 * 数一下 showLinkMenu 前后 .litecontextmenu 的数量，找到新弹出的那个，
 * 往里追加「转换为 设置/获取」条目。
 */
let kjLinkMenuPatched = false;

function patchLinkMenu() {
    const originalShowLinkMenu = LGraphCanvas.prototype.showLinkMenu;
    if (!originalShowLinkMenu || originalShowLinkMenu.__qgSetGet) return;
    const wrapper = function (segment, e) {
        // KJNodes 也在连线菜单里加同款条目（创建它的 Set/Get）；检测到它
        // 在场就整体让位，避免菜单里出现两条一模一样的入口
        if (kjLinkMenuPatched) return originalShowLinkMenu.call(this, segment, e);
        const menusBefore = document.querySelectorAll(".litecontextmenu").length;
        const result = originalShowLinkMenu.call(this, segment, e);

        const graph = this.graph;
        if (!graph) return result;
        const link = getLink(graph, segment?.id);
        if (!link || link.origin_id == null || link.target_id == null) return result;

        const menus = document.querySelectorAll(".litecontextmenu");
        if (menus.length <= menusBefore) return result;
        const lastMenu = menus[menus.length - 1];
        const entries = lastMenu.querySelector(".litemenu-entry")?.parentElement;
        if (!entries) return result;

        // KJNodes 等其它插件也会追加「转换为 设置/获取」条目；已有同类条目
        // 时不再追加，避免菜单出现两条一模一样的入口
        const existing = [...entries.querySelectorAll(".litemenu-entry")]
            .map((x) => x.textContent.trim())
            .some((t) => t === "转换为 设置/获取" || t.includes("Convert to Set/Get"));
        if (existing) return result;

        const separator = document.createElement("div");
        separator.className = "litemenu-entry separator";
        entries.appendChild(separator);

        const item = document.createElement("div");
        item.className = "litemenu-entry submenu";
        item.textContent = zhPair("Convert to Set/Get", "转换为 设置/获取");
        entries.appendChild(item);

        item.addEventListener("click", () => {
            lastMenu.remove();
            linkToSetGet(graph, link);
        });

        return result;
    };
    wrapper.__qgSetGet = true;
    patchLinkMenu.wrapper = wrapper;
    LGraphCanvas.prototype.showLinkMenu = wrapper;

    // 扩展注册顺序在本包之后（按目录名排序）的插件如果也打了这个补丁
    // （KJ 的特征是往菜单里加 "Convert to Set/Get"），就让位
    setTimeout(() => {
        const fn = LGraphCanvas.prototype.showLinkMenu;
        if (
            typeof fn === "function" &&
            fn !== wrapper &&
            String(fn).includes("Convert to Set/Get")
        ) {
            kjLinkMenuPatched = true;
        }
    }, 2000);
}

/**
 * 拖动端口连线时弹出的连接菜单（「Add Reroute」那个）里注入
 * 「添加 设置节点 / 添加 获取节点」：节点创建在松手位置并自动连线。
 * 对齐 KJNodes 的 showSetGetInConnectionMenu（默认开启）。
 */
let kjConnMenuPatched = false;

function patchConnectionMenu() {
    const canvas = app.canvas;
    const original = canvas.showConnectionMenu?.["bind"](canvas);
    if (!original) return;

    const wrapper = function (optPass) {
        if (kjConnMenuPatched) return original(optPass);
        const isFrom = optPass?.nodeFrom && optPass.slotFrom != null;
        const nodeType = isFrom ? SET_TYPE : GET_TYPE;
        const label = isFrom
            ? zhPair("Add Set node", "添加 设置节点")
            : zhPair("Add Get node", "添加 获取节点");

        const OriginalContextMenu = LiteGraph.ContextMenu;
        let interceptActive = true;
        LiteGraph.ContextMenu = function (options, menuOpts) {
            LiteGraph.ContextMenu = OriginalContextMenu;
            if (!interceptActive) return new OriginalContextMenu(options, menuOpts);
            interceptActive = false;

            const index = options.indexOf("Add Reroute");
            if (index !== -1) options.splice(index + 1, 0, label);

            const originalCallback = menuOpts.callback;
            menuOpts.callback = function (value, callbackOpts, event) {
                if (value === label) {
                    const created = LiteGraph.createNode(nodeType);
                    if (created) {
                        const graph = canvas.graph || currentGraph();
                        created.pos = [optPass.e?.canvasX ?? 0, optPass.e?.canvasY ?? 0];
                        graph.add(created);
                        if (isFrom && optPass.nodeFrom) {
                            const slotIndex =
                                typeof optPass.slotFrom === "number"
                                    ? optPass.slotFrom
                                    : optPass.nodeFrom.findOutputSlot(optPass.slotFrom.name);
                            optPass.nodeFrom["connect"](slotIndex, created, 0);
                        } else if (optPass.nodeTo) {
                            const slotIndex =
                                typeof optPass.slotTo === "number"
                                    ? optPass.slotTo
                                    : optPass.nodeTo.findInputSlot(optPass.slotTo.name);
                            created["connect"](0, optPass.nodeTo, slotIndex);
                        }
                        graph.change();
                        setTimeout(() => refreshGetCombos(graph), 0);
                        canvas.setDirty(true, true);
                    }
                    return;
                }
                return originalCallback?.call(this, value, callbackOpts, event);
            };
            return new OriginalContextMenu(options, menuOpts);
        };
        LiteGraph.ContextMenu.prototype = OriginalContextMenu.prototype;

        try {
            return original(optPass);
        } finally {
            LiteGraph.ContextMenu = OriginalContextMenu;
            interceptActive = false;
        }
    };

    // KJNodes 也往这个菜单注入同款条目（标签 "Add SetNode"，会被汉化插件
    // 翻译）；检测到它的补丁在场就让位，避免菜单里出现两条入口
    if (String(canvas.showConnectionMenu).includes("Add SetNode")) return;
    canvas.showConnectionMenu = wrapper;
    setTimeout(() => {
        const fn = canvas.showConnectionMenu;
        if (typeof fn === "function" && fn !== wrapper && String(fn).includes("Add SetNode")) {
            kjConnMenuPatched = true;
        }
    }, 2000);
}

/* ------------------------------------------------------------------ */
/* 注册                                                                */
/* ------------------------------------------------------------------ */

const NODE_DEFS = [
    {
        type: SET_TYPE,
        // 存函数而不是值：模块顶层求值会赶上语言还没就绪，定稿成英文
        title: setTitle,
        description:
            "Name a link: feed an upstream output into the left slot, type the "
            + "name into 'Name', then keep wiring from the right slot. Frontend "
            + "only: never executes, never enters a prompt.",
    },
    {
        type: GET_TYPE,
        title: getTitle,
        description:
            "Pick the name of a Set Point from the 'Name' dropdown and the right "
            + "slot carries that link's value — no long wire needed. Frontend "
            + "only: never executes, never enters a prompt.",
    },
];

const extension = {
    name: "QG.SetGet",

    /** 让节点出现在「添加节点 → QG 工具」，且不用重启后端。 */
    async addCustomNodeDefs(defs) {
        if (!defs) return;
        for (const item of NODE_DEFS) {
            if (defs[item.type]) continue;
            defs[item.type] = {
                name: item.type,
                display_name: item.title(),
                description: item.description,
                category: CATEGORY,
                input: { required: {}, optional: {} },
                output: [],
                output_name: [],
                output_node: false,
                python_module: "custom_nodes.frontend_only",
            };
        }
    },

    registerCustomNodes() {
        LiteGraph.registerNodeType(SET_TYPE, QGSetPoint);
        LiteGraph.registerNodeType(GET_TYPE, QGGetPoint);
        for (const [type, cls, title] of [
            [SET_TYPE, QGSetPoint, setTitle()],
            [GET_TYPE, QGGetPoint, getTitle()],
        ]) {
            cls.type = type;
            cls.comfyClass = type;
            cls.title = title;
            // registerNodeType 会清空 category，旧版菜单靠它分类，补回来。
            // 🔴 用 pinCategory：它把英文尾段 + 中文译名一起钉住，只写英文的话
            //    中文界面下这两个节点会永远停在英文分类（纯前端裸节点最常漏的一手）。
            pinCategory(cls, "Workflow");
        }
    },

    /** 对齐 KJ 的 getNodeMenuItems：任意节点的右键菜单里加快捷入口。 */
    getNodeMenuItems(node) {
        const items = [];
        if (node?.inputs?.length > 0) {
            // 菜单打开那一刻先快照选区，回调时右键点击可能已改选区
            const selected = snapshotSelected(node);
            items.push(
                {
                    content: zhPair("Add Get node", "添加 获取节点"),
                    callback: () => {
                        for (const n of selected) addNodeNear(GET_TYPE, n, "left");
                    },
                },
                {
                    content: zhPair("Add Set node", "添加 设置节点"),
                    callback: () => {
                        for (const n of selected) addNodeNear(SET_TYPE, n, "right");
                    },
                },
                {
                    content: zhPair("Convert all outputs to Set/Get", "将所有输出转换为 设置/获取"),
                    callback: () => {
                        const graph = node.graph || currentGraph();
                        for (const n of selected) convertOutputsToSetGet(graph, n);
                    },
                }
            );
        }
        return items;
    },

    /** 对齐 KJ 的 getCanvasMenuItems：画布空白处右键的批量入口。 */
    getCanvasMenuItems() {
        return [
            {
                content: zhPair("Set / Get Points", "设置/获取点"),
                has_submenu: true,
                submenu: {
                    options: [
                        {
                            content: zhPair("Convert the selected nodes' outputs to Set/Get",
                            "将选中节点的输出转换为 设置/获取"),
                            callback: () => {
                                const selected = Object.values(app.canvas?.selected_nodes || {});
                                if (selected.length === 0) return;
                                const graph = currentGraph();
                                for (const node of selected) convertOutputsToSetGet(graph, node);
                            },
                        },
                        {
                            content: zhPair("Convert the selected Set/Get points to plain links",
                            "将选中的设置/获取转换成连线"),
                            callback: () => {
                                const graph = currentGraph();
                                const selected = Object.values(app.canvas?.selected_nodes || {});
                                const setNodes = selected.filter(isSet);
                                const getNodes = selected.filter(isGet);
                                for (const node of setNodes) convertToLinks(graph, nameOf(node));
                                const setters = new Set(
                                    getNodes
                                        .map((node) => findSet(graph, nameOf(node)))
                                        .filter(Boolean)
                                );
                                for (const setter of setters) convertToLinks(graph, nameOf(setter));
                            },
                        },
                    ],
                },
            },
        ];
    },

    setup() {
        patchCanvasDrawing();
        patchLinkMenu();
        patchConnectionMenu();

        // 双击获取点跳到对应设置点（下拉菜单打开时不抢双击；
        // 折叠节点上抑制改名弹窗，让双击只负责跳转）
        document.addEventListener("dblclick", () => {
            if (document.querySelector(".litecontextmenu")) return;
            const selected = Object.values(app.canvas?.selected_nodes || {});
            if (selected.length !== 1 || !isGet(selected[0])) return;
            selected[0].goToSetter();
        });
        document.addEventListener("litegraph:canvas", (e) => {
            if (e.detail?.subType !== "node-double-click") return;
            if (isGet(e.detail.node) && e.detail.node.flags?.collapsed) {
                e.stopImmediatePropagation();
            }
        });
    },
};

app.registerExtension(extension);
