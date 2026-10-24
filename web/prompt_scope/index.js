// 把一次运行的结果留在排队它的那个工作流标签页上。
//
// 一个页面里的所有工作流标签共用一个服务器连接，而 ComfyUI 按节点 id 归置结果。
// 从 A 标签排队的一次运行，如果在 B 标签打开时才结束，就会落在 B 标签里 id 相同的
// 节点上：预览、onExecuted 全落错。核心只是多显示一张图；会「记住运行结果」的节点
// （图像对比的预览、种子的历史）就会把别人的结果存进自己的存档。
//
// 这里记录每次运行由哪个工作流图排队（shared/prompt_scope.mjs）。别处标签的结果落到
// QG 节点上时，把本标签自己的结果放回去；各节点的 onExecuted 先问 isForeignRun()，
// 谁都不会去接。被挡下的结果会留着，等排队它的那个标签重新打开时再交还。
// 核心节点与第三方节点一律不动。
//
// 🔴 前端 1.53 里 `globalThis.api` 与 `import { api } from "/scripts/api.js"` 拿到的
// **不是同一个对象**：app 派发事件用的是它自己的那个实例。只包模块里 import 进来的
// 那份，等于什么都没做（表现是 runScope.current 一直是 null）。所以这里把所有候选
// 实例都包上，并在 app 就绪后再试一次。
//
// 移植自 ComfyUI-AusBoss（MIT，js/prompt_scope/index.js）。

import { api } from "/scripts/api.js";
import { app } from "/scripts/app.js";
import { isQgNode } from "../shared/index.mjs?v=2026102420";
import { nodeByExecutionId, outputKey, runScope } from "../shared/prompt_scope.mjs?v=2026102420";

const rootGraph = () => app.rootGraph ?? app.graph ?? null;
const graphOwner = (graph) => graph?.rootGraph?.id ?? graph?.id ?? null;

runScope.setActiveOwner(() => graphOwner(rootGraph()));

// 页面上可能同时存在几个「api 实例」。全部找出来，一个都不放过。
function apiCandidates() {
  const found = [];
  const seen = new Set();
  for (const candidate of [app?.api, globalThis.api, api]) {
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    found.push(candidate);
  }
  return found;
}

// 排队调用才会返回 prompt id，所以包住这个调用本身（而不是链在它后面）：
// 包装层得看到解析出来的值。它不改动发出去的内容和返回值；记录失败就静默。
function wrapQueue(target) {
  const queue = target?.queuePrompt;
  if (typeof queue !== "function" || queue.__qgRunScope) return false;
  const scoped = async function (number, data, ...rest) {
    let owner = null;
    try {
      owner = data?.workflow?.id ?? graphOwner(rootGraph());
    } catch (_error) {
      owner = null;
    }
    const result = await queue.call(this, number, data, ...rest);
    try {
      runScope.queued(result?.prompt_id, owner);
    } catch (_error) {
      // 没记上的运行按老样子处理。
    }
    return result;
  };
  scoped.__qgRunScope = true;
  try {
    target.queuePrompt = scoped;
    return target.queuePrompt === scoped;
  } catch (_error) {
    return false;
  }
}

function keepOwnResult(detail) {
  try {
    const executionId = String(detail.display_node ?? detail.node ?? "");
    const node = nodeByExecutionId(rootGraph(), executionId);
    if (!node || !isQgNode(node)) return;
    const own =
      app.extensionManager?.workflow?.activeWorkflow?.changeTracker?.nodeOutputs?.[
        String(detail.node ?? executionId)
      ];
    const key = outputKey(node, rootGraph());
    if (own) app.nodeOutputs[key] = own;
    else if (app.nodeOutputs && key in app.nodeOutputs) delete app.nodeOutputs[key];
  } catch (_error) {
    // 串过来的结果留着，和核心原本的做法一样。
  }
}

// 被挡下的结果，按排队它的图分组，最旧的在前。每个标签留几条就够：面板只显示
// 最新的一条，种子的历史也只留 8 条。
const withheld = new Map();
const WITHHELD_PER_TAB = 32;
const WITHHELD_TABS = 16;

function withhold(detail) {
  const owner = runScope.ownerOf(detail.prompt_id);
  if (!owner) return;
  const node = String(detail.display_node ?? detail.node ?? "");
  const list = withheld.get(owner) ?? [];
  // 同一个 api 可能被几个实例各报一次，同一次运行只留一条。
  if (list.some((item) => item.prompt === detail.prompt_id && item.node === node)) return;
  list.push({ prompt: detail.prompt_id, node, output: detail.output });
  while (list.length > WITHHELD_PER_TAB) list.shift();
  withheld.delete(owner);
  withheld.set(owner, list);
  while (withheld.size > WITHHELD_TABS) withheld.delete(withheld.keys().next().value);
}

// 本标签自己的更新结果会取代同节点被挡下的一条。
function forgetWithheld(detail) {
  const owner = graphOwner(rootGraph());
  const list = withheld.get(owner);
  if (!list?.length) return;
  const node = String(detail.display_node ?? detail.node ?? "");
  const kept = list.filter((item) => item.node !== node);
  if (kept.length !== list.length) withheld.set(owner, kept);
}

function deliverWithheld() {
  const owner = graphOwner(rootGraph());
  const list = owner ? withheld.get(owner) : null;
  if (!list?.length) return;
  withheld.delete(owner);
  for (const item of list) {
    try {
      const node = nodeByExecutionId(rootGraph(), item.node);
      if (!node || !isQgNode(node) || typeof node.onExecuted !== "function") continue;
      runScope.during(item.prompt, () => node.onExecuted(item.output));
    } catch (_error) {
      // 一个节点接不住，不挡别的节点。
    }
  }
}

// 装上：包住排队调用 + 听运行事件。重复调用是安全的。
function install() {
  let wired = 0;
  for (const target of apiCandidates()) {
    if (wrapQueue(target)) wired += 1;
    if (typeof target.addEventListener !== "function" || target.__qgScopeListening) continue;
    target.__qgScopeListening = true;
    // 扩展比 app 自己的处理器先加载，这里排在核心的 "executed" 之前：
    // 任何节点的 onExecuted 被调用之前，作用域已经知道这是哪次运行。
    target.addEventListener("execution_start", ({ detail }) => runScope.started(detail?.prompt_id));
    target.addEventListener("executed", ({ detail }) => {
      if (!detail) return;
      runScope.started(detail.prompt_id);
      if (!runScope.isForeign(detail.prompt_id)) {
        forgetWithheld(detail);
        return;
      }
      withhold(detail);
      queueMicrotask(() => keepOwnResult(detail));
    });
    wired += 1;
  }
  return wired;
}

install();

app.registerExtension({
  name: "QG.PromptScope",
  // app 就绪后再装一次：这时 app.api 之类才真正是派发事件的那个实例。
  setup() {
    install();
    setTimeout(install, 2000);
  },
  // 打开一个标签会一次性恢复它存下的结果；等它的节点都摆好了，再把被挡下的交还。
  onNodeOutputsUpdated() {
    setTimeout(deliverWithheld, 0);
  },
});

// 探针用：看看当前装到了哪几个实例上。
export function qgScopeWiring() {
  return apiCandidates().map((target) => ({
    hasQueue: typeof target.queuePrompt === "function",
    wrapped: target.queuePrompt?.__qgRunScope === true,
    listening: target.__qgScopeListening === true,
  }));
}
