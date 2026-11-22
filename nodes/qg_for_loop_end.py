# -*- coding: utf-8 -*-
"""QG_ForLoopEnd —— For 循环终点（截图「For循环-结束」，零依赖自写）。

输入：流（rawLink）+ 四个携带值 + 内部索引；输出：值1 / 值2 / 值3 / 值4。
回环机制（ComfyUI 官方 node expansion / tail recursion）：
  - 执行图默认无环，本节点在运行时用内核 GraphBuilder 把起点到终点之间的
    节点整段克隆成递归子图；
  - 索引计数放在本节点自身的 idx 输入里（首轮 0），每轮回带 idx+1 给克隆的
    终点，下一轮 execute 就能读到递增后的值；
  - idx+1 >= total 时退出，把携带值直接输出。
只依赖 ComfyUI 内核 comfy_api / comfy_execution，不依赖任何外部插件。
"""

from comfy_api.latest import io


class QGForLoopEnd(io.ComfyNode):
    CATEGORY = "QG-tools/Logic"
    DESCRIPTION = (
        "For-loop end: closes the loop, advances the index and carries values back. "
        "Pair with QG For Loop Start. IMPORTANT: connect one of this node's outputs to a final output "
        "node (PreviewAny, SaveImage, ...); ComfyUI schedules nodes backwards from outputs, so without "
        "this the loop is never executed and the body runs only once. Zero-dependency, ComfyUI core only."
    )
    SEARCH_ALIASES = ["for loop end", "forloop", "循环结束", "for循环", "qg"]

    @classmethod
    def define_schema(cls):
        inputs = [
            io.Custom("QG_FLOW").Input("flow", raw_link=True,
                                       tooltip="Loop marker from QG For Loop Start."),
            io.AnyType.Input("value1", optional=True,
                             tooltip="Carried value 1 to feed back / output."),
            io.AnyType.Input("value2", optional=True,
                             tooltip="Carried value 2 to feed back / output."),
            io.AnyType.Input("value3", optional=True,
                             tooltip="Carried value 3 to feed back / output."),
            io.AnyType.Input("value4", optional=True,
                             tooltip="Carried value 4 to feed back / output."),
            # 内部索引：下一轮由本节点回带 idx+1；用户不用接线。
            io.Int.Input("idx", default=0, min=0, max=0x7FFFFFFFFFFFFFFF, step=1,
                         optional=True, advanced=True,
                         tooltip="Internal loop index, advanced by the node itself."),
        ]
        outputs = [
            io.AnyType.Output("value1", tooltip="Carried value 1 at loop exit. Connect to an output node to trigger the loop."),
            io.AnyType.Output("value2", tooltip="Carried value 2 at loop exit. Connect to an output node to trigger the loop."),
            io.AnyType.Output("value3", tooltip="Carried value 3 at loop exit. Connect to an output node to trigger the loop."),
            io.AnyType.Output("value4", tooltip="Carried value 4 at loop exit. Connect to an output node to trigger the loop."),
        ]
        return io.Schema(
            node_id="QG_ForLoopEnd",
            display_name="For Loop End",
            category=cls.CATEGORY,
            description=cls.DESCRIPTION,
            search_aliases=cls.SEARCH_ALIASES,
            inputs=inputs,
            outputs=outputs,
            hidden=[io.Hidden.dynprompt, io.Hidden.unique_id, io.Hidden.execution_list],
            enable_expand=True,
        )

    @staticmethod
    def _as_int(value):
        if isinstance(value, bool):
            return int(value)
        if isinstance(value, (int, float)):
            return int(value)
        try:
            return int(value)
        except Exception:
            return 0

    def _explore(self, node_id, dynprompt, upstream, parent_ids):
        """从终点向上游递归；upstream[parent] 记录它有哪些下游（正向收集循环体用）。"""
        try:
            node_info = dynprompt.get_node(node_id)
        except Exception:
            return
        for value in (node_info.get("inputs") or {}).values():
            if not (isinstance(value, list) and len(value) == 2 and isinstance(value[0], str)):
                continue
            parent = value[0]
            display = dynprompt.get_display_node_id(parent)
            try:
                cls_type = dynprompt.get_node(display).get("class_type", "")
            except Exception:
                cls_type = ""
            if cls_type not in ("QG_ForLoopEnd",):
                parent_ids.append(display)
            upstream.setdefault(parent, [])
            self._explore(parent, dynprompt, upstream, parent_ids)
            if node_id not in upstream[parent]:
                upstream[parent].append(node_id)

    def _collect(self, node_id, upstream, contained):
        for child in upstream.get(node_id, []):
            if child not in contained:
                contained[child] = True
                self._collect(child, upstream, contained)

    def _explore_output_nodes(self, dynprompt, upstream, output_nodes, parent_ids):
        """把连到循环体的输出节点纳入循环体，让它们每轮被克隆执行。

        关键点：upstream 的 key 在展开节点里是带前缀的 id
        （如 '5.0.0.3'），用 get_display_node_id 映射回原始 id 才能和
        parent_ids / output_nodes 的源 id 对上；输出节点 id 也要按同样的
        前缀拼回展开 id（把最后一段换成输出节点 id），否则第二轮以后
        输出节点进不了 contained，循环体里的 SaveImage 就会少存图。
        """
        for parent in list(upstream.keys()):
            display = dynprompt.get_display_node_id(parent)
            for out_id, src_id in output_nodes.items():
                if src_id in parent_ids and display == src_id and out_id not in upstream[parent]:
                    if "." in parent:
                        parts = parent.split(".")
                        parts[-1] = out_id
                        upstream[parent].append(".".join(parts))
                    else:
                        upstream[parent].append(out_id)

    @classmethod
    def execute(cls, flow=None, value1=None, value2=None, value3=None, value4=None, idx=0):
        from comfy_execution.graph_utils import GraphBuilder, is_link

        dynprompt = cls.hidden.dynprompt if cls.hidden is not None else None
        unique_id = cls.hidden.unique_id if cls.hidden is not None else None
        flow_pair = flow if is_link(flow) else None
        open_id = flow_pair[0] if flow_pair else None

        if dynprompt is None or open_id is None:
            return io.NodeOutput(value1, value2, value3, value4)

        # total 从起点的原始节点读。填固定数字时直接是值；接了别的节点时
        # 这里是 link（如 ["3", 0]），需要从上游节点的执行缓存里取运行时求值结果。
        total = 0
        try:
            start_info = dynprompt.get_node(open_id)
            raw_total = (start_info.get("inputs") or {}).get("total", 0)
            if is_link(raw_total):
                # total 接线：上游节点（如 QG_Math）会被内核正常调度，结果进主缓存。
                # get_cache(from,to) 依赖 execution_cache 的显式关联，total 上游没跟
                # 终点建立关联，所以取不到；改从 output_cache（主缓存）按节点 id 直接读。
                exec_list = cls.hidden.execution_list if cls.hidden is not None else None
                if exec_list is not None and getattr(exec_list, "output_cache", None) is not None:
                    cached = exec_list.output_cache.get_local(raw_total[0])
                    if cached is not None and cached.outputs is not None:
                        slot = int(raw_total[1])
                        if slot < len(cached.outputs) and cached.outputs[slot]:
                            total = cls._as_int(cached.outputs[slot][0])
            else:
                total = cls._as_int(raw_total)
        except Exception:
            total = 0

        current = cls._as_int(idx)
        nxt = current + 1
        if total <= 0 or nxt >= total:
            # 退出循环（索引从 0 起，共 total 轮：0..total-1）。
            if total <= 0 and current == 0:
                # 0 轮：循环体节点不该执行，其加工过的四个 value 不可信。
                # 直接把起点原始 inputs 里的固定值透传出去，
                # 这样终点输出的是初始值而不是被（多跑一次的）循环体改过的值。
                # 只有固定值（非 link）能在这里安全读取；link 情形退回 value 参数。
                try:
                    si = dynprompt.get_node(open_id).get("inputs") or {}
                    for i in range(1, 5):
                        key = "value%d" % i
                        raw = si.get(key)
                        if raw is not None and not is_link(raw):
                            if i == 1:
                                value1 = raw
                            elif i == 2:
                                value2 = raw
                            elif i == 3:
                                value3 = raw
                            else:
                                value4 = raw
                except Exception:
                    pass
            return io.NodeOutput(value1, value2, value3, value4)

        # unique_id 在展开节点里可能是展开后的 id，用 display id 找回原终点。
        self = cls()
        if unique_id is None:
            for nid, info in dynprompt.get_original_prompt().items():
                if info.get("class_type") == "QG_ForLoopEnd":
                    unique_id = nid
                    break
        if unique_id is None:
            return io.NodeOutput(value1, value2, value3, value4)

        upstream = {}
        parent_ids = []
        self._explore(unique_id, dynprompt, upstream, parent_ids)
        parent_ids = list(set(parent_ids))

        # 收集原始图里的输出节点（OUTPUT_NODE）：记录每个输出节点连到哪个源。
        # 之后按 display id 映射到循环体节点，把它们纳入每轮克隆。
        output_nodes = {}
        for oid, info in dynprompt.get_original_prompt().items():
            if not info.get("inputs"):
                continue
            for value in info["inputs"].values():
                if isinstance(value, list) and len(value) == 2 and isinstance(value[0], str):
                    output_nodes[oid] = value[0]
                    break
        self._explore_output_nodes(dynprompt, upstream, output_nodes, parent_ids)

        contained = {}
        self._collect(open_id, upstream, contained)
        contained[unique_id] = True
        contained[open_id] = True

        graph = GraphBuilder()
        for nid in contained:
            try:
                info = dynprompt.get_node(nid)
            except Exception:
                continue
            alias = "Recurse" if nid == unique_id else nid
            graph.node(info["class_type"], alias).set_override_display_id(nid)
        for nid in contained:
            try:
                info = dynprompt.get_node(nid)
            except Exception:
                continue
            alias = "Recurse" if nid == unique_id else nid
            node = graph.lookup_node(alias)
            for key, value in (info.get("inputs") or {}).items():
                if is_link(value) and value[0] in contained:
                    parent_alias = "Recurse" if value[0] == unique_id else value[0]
                    node.set_input(key, graph.lookup_node(parent_alias).out(value[1]))
                else:
                    node.set_input(key, value)

        # 回带：idx 递增写在终点自己（下一轮 execute 读到）；
        # 携带值必须写回「克隆的起点」——循环体是从起点的 value1/value2 输出读值的，
        # 只有更新起点，下一轮循环体才能拿到本轮加工后的值，形成真正递推。
        recurse = graph.lookup_node("Recurse")
        recurse.set_input("idx", nxt)
        try:
            start_node = graph.lookup_node(open_id)
            start_node.set_input("idx", nxt)   # 下一轮起点输出的 index = nxt
            start_node.set_input("value1", value1)
            start_node.set_input("value2", value2)
            start_node.set_input("value3", value3)
            start_node.set_input("value4", value4)
        except Exception:
            pass

        return io.NodeOutput(
            recurse.out(0), recurse.out(1), recurse.out(2), recurse.out(3),
            expand=graph.finalize(),
        )


NODE_CLASS_MAPPINGS = {"QG_ForLoopEnd": QGForLoopEnd}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_ForLoopEnd": "For Loop End"}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
