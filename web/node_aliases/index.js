/**
 * 搜索别名 —— 让 QG 节点用中英文口语词都能搜到（前端）
 *
 * 两件事：
 *   1. 节点定义注册进 Vue 应用之前，把 web/shared/node_aliases.mjs 里那张表
 *      写进每个 QG 节点的 search_aliases（搜索索引认这个字段）。
 *      表里以英文为主，中文名带空格 / 中英混排的节点另补无空格写法（`空latent`）。
 *   2. 包一层 nodeDef store 的 searchNode：别名精确命中的 QG 节点提到最前面。
 *      不这么做的话，搜 `text` 会被几十个原生 `Text xxx` 节点按前缀命中压到
 *      第 159 名，而 UI 只取前 64 条 —— 等于搜不到。
 *
 * 时序很关键：前端是在 beforeRegisterVueAppNodeDefs 之后才 new
 * NodeSearchService（按 name / display_name / search_aliases 建 Fuse 索引）。
 * 早一步或晚一步都白干 —— 索引建好之后再改定义，本次会话的搜索不会重建。
 *
 * 想加别名只改 web/shared/node_aliases.mjs。
 */

import { app } from "/scripts/app.js";
import {
    applyNodeAliases,
    applyNodeAliasesToLiteGraph,
    pinExactAliasHits,
    NODE_ALIAS_COUNT,
} from "../shared/node_aliases.mjs?v=2026102706";

// 探针和排障用：扩展脚本到底跑没跑、钩子有没有触发，看一眼这个就知道。
// 只读标记，不参与任何逻辑。
globalThis.__QG_NODE_ALIASES__ = { loaded: true, injected: 0, litegraph: 0, pinned: false };

// 搜索服务在 pinia 的 nodeDef store 里。注意 app.vueApp 是空的，
// Vue 应用实例挂在 DOM 根元素 #vue-app 的 __vue_app__ 上。
function findNodeDefStore() {
    const root = [...document.querySelectorAll("*")].find((el) => el.__vue_app__);
    const pinia = root?.__vue_app__?.config?.globalProperties?.$pinia;
    if (!pinia?._s) return null;
    for (const [, store] of pinia._s) {
        if (store && "nodeSearchService" in store) return store;
    }
    return null;
}

app.registerExtension({
    name: "QG.NodeAliases",

    // Vue 侧：搜索框用的就是这份定义
    beforeRegisterVueAppNodeDefs(defs) {
        const count = applyNodeAliases(defs);
        globalThis.__QG_NODE_ALIASES__.injected = count;
        if (count) {
            console.log(
                "[QG-tools] 英文搜索别名：%d/%d 个节点已注入",
                count,
                NODE_ALIAS_COUNT
            );
        }
    },

    async setup() {
        // LiteGraph 侧兜底：老右键菜单读的是另一份注册表
        const count = applyNodeAliasesToLiteGraph(globalThis.LiteGraph);
        globalThis.__QG_NODE_ALIASES__.litegraph = count;

        // store 是 Vue 挂载后才有的，轮询等它（最多 20 秒）
        for (let i = 0; i < 40; i++) {
            const store = findNodeDefStore();
            if (store && pinExactAliasHits(store)) {
                globalThis.__QG_NODE_ALIASES__.pinned = true;
                console.log("[QG-tools] 英文搜索别名：搜索结果提权已挂上");
                break;
            }
            await new Promise((r) => setTimeout(r, 500));
        }
    },
});
