// What a paste did to ids, so a node that remembers other nodes by id can
// follow the copies instead of the originals.
//
// A copy gets new ids: copy and paste, duplicate, Alt + drag and dropping a
// saved workflow on the canvas all go through LGraphCanvas._deserializeItems,
// which hands back which old id became which new node. A card that holds a
// list of node ids has no way of knowing that on its own, so it would keep
// naming the originals - and pasted on its own into another workflow, it
// would name whatever now happens to carry those numbers.
//
// The frontend's method returns a value that the caller needs (the added
// items, wrapped), so it is wrapped here rather than hooked with
// chainCallback, which drops returns. No app import: the decisions can be
// checked without a browser.
//
// 实测（本机前端 1.53，2026-10-31）：返回 { nodes: Map, created: Array, links,
// reroutes, subgraphs }；Map 的键是**数字**旧 id，值是新实例且**节点 id 是
// 字符串**（组 id 仍是数字）；`created` 里组排在节点前面。

const handlers = new Set();
let installed = false;

// Old id (as text) -> the copy's id, for the nodes and the groups of one
// paste. Nodes come back in the frontend's own Map. Groups do not: the
// frontend adds the groups it was handed one by one, in order, so the ones
// it made are matched to the old ids by position - and only when the two
// counts agree, because a wrong group is worse than a group left alone.
export function pastedIds(result, groupIds = [], isGroup = () => false) {
  const nodes = new Map();
  for (const [id, node] of result?.nodes ?? []) {
    if (node?.id !== undefined && node?.id !== null) nodes.set(String(id), node.id);
  }
  const created = [...(result?.created ?? [])];
  const groups = new Map();
  const made = created.filter(isGroup);
  if (made.length && made.length === groupIds.length) {
    groupIds.forEach((id, index) => {
      if (id === undefined || id === null) return;
      const copy = made[index]?.id;
      if (copy === undefined || copy === null) return;
      groups.set(String(id), copy);
    });
  }
  return { nodes, groups, created };
}

// Runs `handler({ nodes, groups, created })` after every paste. Handlers are
// isolated: one that throws cannot take the paste down with it, and the
// frontend still gets the value it asked for.
export function onPaste(handler) {
  if (typeof handler === "function") handlers.add(handler);
  install();
}

function install() {
  if (installed) return;
  const lite = globalThis.LiteGraph;
  const proto = lite?.LGraphCanvas?.prototype;
  const original = proto?._deserializeItems;
  // A frontend without the method pastes as before and no handler runs.
  if (typeof original !== "function") return;
  installed = true;
  const isGroup = (item) => Boolean(lite.LGraphGroup && item instanceof lite.LGraphGroup);

  function deserializeItemsWithIds(items, ...rest) {
    // Read before the paste: the frontend gives the groups it is handed new
    // ids as it adds them, so their old ids are only readable now.
    const groupIds = Array.isArray(items?.groups) ? items.groups.map((group) => group?.id) : [];
    const result = original.call(this, items, ...rest);
    if (!result || !handlers.size) return result;
    const ids = pastedIds(result, groupIds, isGroup);
    for (const handler of handlers) {
      try {
        handler(ids);
      } catch (error) {
        console.warn("[QG-tools] after a paste:", error);
      }
    }
    return result;
  }
  proto._deserializeItems = deserializeItemsWithIds;
}
