// Which workflow tab a run belongs to.
//
// Every workflow tab in one browser page shares one connection to the
// server, and ComfyUI files a node's results by its node id. A run queued in
// one tab that finishes while another tab is open therefore lands on the
// node with the same id in the open tab: its preview, and its onExecuted
// call. Core only shows the stray picture; a QG node that keeps what a run
// sent would also save it into the wrong workflow.
//
// This module remembers which graph queued each run and says whether the run
// reporting now belongs to the graph on screen. web/prompt_scope/index.js
// wires it to the api; the nodes ask isForeignRun() before they take a
// result. No DOM and no ComfyUI imports, so it stays testable.
//
// Ported from ComfyUI-AusBoss (MIT, js/shared/prompt_scope.mjs +
// js/shared/graph_ids.mjs).

const DEFAULT_LIMIT = 256;

export function createRunScope({ limit = DEFAULT_LIMIT } = {}) {
  // prompt id -> id of the graph that queued it, oldest first
  const owners = new Map();
  let current = null;
  let activeOwner = () => null;

  const ownerOf = (promptId = current) => {
    if (promptId === null || promptId === undefined || promptId === "") return null;
    return owners.get(String(promptId)) ?? null;
  };

  return {
    // A run was queued from the graph `owner`.
    queued(promptId, owner) {
      if (!promptId || owner === null || owner === undefined || owner === "") return;
      const key = String(promptId);
      owners.delete(key);
      owners.set(key, String(owner));
      while (owners.size > Math.max(1, limit)) owners.delete(owners.keys().next().value);
    },
    // The server started, or is reporting on, this run.
    started(promptId) {
      if (promptId) current = String(promptId);
    },
    // Run `task` as if `promptId` were reporting: a result held back from
    // another tab is handed over later, when that tab is open again.
    during(promptId, task) {
      const before = current;
      if (promptId) current = String(promptId);
      try {
        return task();
      } finally {
        current = before;
      }
    },
    // Where the graph on screen comes from: a function, read on every ask.
    setActiveOwner(read) {
      activeOwner = typeof read === "function" ? read : () => null;
    },
    ownerOf,
    get current() {
      return current;
    },
    // True only when both sides are known and differ. A run nobody recorded
    // (queued before this page loaded, or by another client) is never
    // foreign: the nodes then behave as they always have.
    isForeign(promptId = current) {
      const owner = ownerOf(promptId);
      if (owner === null) return false;
      let active = null;
      try {
        active = activeOwner();
      } catch {
        return false;
      }
      return active !== null && active !== undefined && active !== "" && owner !== String(active);
    },
  };
}

// Where the frontend files a node's results (app.nodeOutputs): its id on
// the root graph, "<subgraph id>:<id>" inside a subgraph.
export function outputKey(node, root = null) {
  if (!node || node.id === null || node.id === undefined) return null;
  const graph = node.graph;
  return graph && root && graph !== root && graph.id ? `${graph.id}:${node.id}` : String(node.id);
}

// ComfyUI identifies a node inside a subgraph by its execution id: the chain
// of subgraph node ids that reaches it, colon-joined ("12:3" is node 3 inside
// the subgraph node 12 holds). Only the last segment is a real graph node id,
// and ids are numbered independently inside each subgraph, so looking the
// bare tail up on the root graph does not merely miss - it can return a
// completely unrelated top-level node that happens to share the number.
// Walking the chain is the only way to answer correctly; an id that does not
// resolve returns null, because acting on the wrong node is worse than doing
// nothing at all.
export function nodeByExecutionId(rootGraph, executionId) {
  const parts = String(executionId ?? "")
    .split(":")
    .filter((part) => part !== "");
  if (!parts.length) return null;
  let graph = rootGraph ?? null;
  for (const part of parts.slice(0, -1)) {
    const holder = graph?.getNodeById?.(Number(part)) ?? graph?.getNodeById?.(part);
    graph = holder?.subgraph ?? null;
    if (!graph) return null;
  }
  const tail = parts[parts.length - 1];
  return graph?.getNodeById?.(Number(tail)) ?? graph?.getNodeById?.(tail) ?? null;
}

// The page-wide scope the nodes share.
export const runScope = createRunScope();

// Does the run reporting now belong to another workflow tab?
export function isForeignRun(promptId) {
  return promptId === undefined ? runScope.isForeign() : runScope.isForeign(promptId);
}
