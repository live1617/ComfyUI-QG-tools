// LoRA rows on a subgraph box: the LoRA Loader's rows shown on the face of
// the box (subgraph node) that holds the loader, the way the frontend shows
// any other setting it brings up to a box.
//
// The frontend brings a setting up by giving the subgraph an input and
// linking it to the setting's own input on the inner node. From then on the
// box keeps the value, one copy per box, and that copy is what runs; the
// inner node's own value is no longer read. This module answers the
// questions around that: which inputs of a box carry a loader's rows, which
// box an inner loader takes its rows from, and the box's copy itself.
//
// No DOM and no app import, so tests/lora_box.test.mjs runs it under
// node:test. Node ids are compared as text: the frontend keeps them as
// strings, older saves have numbers.

// litegraph's id for a subgraph's own input node, where a subgraph input's
// links start inside the subgraph.
export const SUBGRAPH_INPUT_ID = "-10";
export const ROWS_INPUT = "loras";

const same = (a, b) => a != null && b != null && String(a) === String(b);

function linkOf(graph, id) {
  if (id == null || !graph) return null;
  return graph.getLink?.(id) ?? graph.links?.get?.(id) ?? graph.links?.[id] ?? null;
}

function nodeOf(graph, id) {
  return graph?.getNodeById?.(id) ?? (graph?.nodes ?? graph?._nodes ?? []).find((node) => same(node?.id, id)) ?? null;
}

// The inputs of a box that carry a loader's rows, in the box's input order:
// [{ name, loader }]. `isLoader` says whether a node is a LoRA Loader.
export function boxRowInputs(box, isLoader) {
  const subgraph = box?.subgraph;
  if (!subgraph) return [];
  const found = [];
  for (const input of subgraph.inputs ?? []) {
    for (const id of input?.linkIds ?? []) {
      const link = linkOf(subgraph, id);
      const loader = link && nodeOf(subgraph, link.target_id);
      if (loader && isLoader(loader) && loader.inputs?.[link.target_slot]?.name === ROWS_INPUT) {
        found.push({ name: input.name, loader });
        break;
      }
    }
  }
  return found;
}

// The box's own copy of the rows that come in through its input `name`.
export function boxRowsWidget(box, name) {
  return (box?.widgets ?? []).find((widget) => widget?.name === name && typeof widget.value === "string") ?? null;
}

// When a loader's rows come in from its box: the name of the subgraph input
// they come through, or null.
export function rowsInputName(loader) {
  const graph = loader?.graph;
  const index = (loader?.inputs ?? []).findIndex((input) => input?.name === ROWS_INPUT);
  if (!graph || index < 0) return null;
  const link = typeof loader.getInputLink === "function"
    ? safely(() => loader.getInputLink(index))
    : linkOf(graph, loader.inputs[index].link);
  if (!link || !same(link.origin_id, SUBGRAPH_INPUT_ID)) return null;
  return graph.inputs?.[link.origin_slot]?.name ?? null;
}

function safely(read) {
  try {
    return read();
  } catch {
    return null;
  }
}

// Every node of a workflow at any depth: the root graph's and every
// subgraph's (the frontend keeps the subgraphs in a Map on the root).
export function workflowNodes(root) {
  const nodes = [...(root?.nodes ?? root?._nodes ?? [])];
  const subgraphs = root?.subgraphs;
  const list = typeof subgraphs?.values === "function" ? [...subgraphs.values()] : Object.values(subgraphs ?? {});
  for (const subgraph of list) nodes.push(...(subgraph?.nodes ?? subgraph?._nodes ?? []));
  return nodes;
}

// The boxes that hold `subgraph`.
export function boxesOf(subgraph, nodes) {
  if (!subgraph) return [];
  return nodes.filter((node) => node?.isSubgraphNode?.() === true && node.subgraph === subgraph);
}

// Which box an inner loader takes its rows from: the box the user came in
// through, while it still holds this subgraph, else the only box there is.
// With several boxes and no way in known, none: each box keeps its own rows.
export function hostBox(subgraph, boxes, entered) {
  if (entered && entered.subgraph === subgraph && boxes.includes(entered)) return entered;
  return boxes.length === 1 ? boxes[0] : null;
}
