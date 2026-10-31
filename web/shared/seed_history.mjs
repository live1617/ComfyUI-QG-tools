// 种子节点的「上次运行」记忆。纯逻辑：不碰 DOM，也不 import ComfyUI。
//
// 移植自 ComfyUI-AusBoss（MIT，js/shared/seed_history.mjs）。
// 后端每次运行都把实际用过的种子塞进 ui.seed 回传，前端靠它记录历史，
// 所以「随机值」模式下框里已经是下一枚种子时，这里记的仍是刚才真跑的那一个。

export const SEED_HISTORY_LIMIT = 8;

// 🔴 必须是整数。上游只判了 `Number.isFinite(value) && value >= 0`，于是 1.5 这种
// 值能一路走到「历史菜单 → 点一下 → setSeed → widget.value = 1.5」，
// 后端的 INT 校验（`isinstance(value, int)`）当场拒绝排队，报的还是一句看不出
// 源头的类型错误。框里显示 "1.5" 同样没法再提交（输入框只收纯数字）。
function isSeed(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

// 从 onExecuted 的 ui 回包里取种子：可能是数字、字符串数字，也可能包在数组里。
export function seedFromExecuted(message) {
  const value = message?.seed;
  const first = Array.isArray(value) ? value[0] : value;
  if (typeof first === "string" && /^\d+$/.test(first)) return Number(first);
  return isSeed(first) ? first : null;
}

// 最近的排最前，且不留重复（重跑同一个种子时把它挪到最前）。
export function pushSeed(history, seed, limit = SEED_HISTORY_LIMIT) {
  const kept = Array.isArray(history) ? history.filter((item) => isSeed(item) && item !== seed) : [];
  if (!isSeed(seed)) return kept.slice(0, limit);
  return [seed, ...kept].slice(0, limit);
}

export function formatSeed(seed) {
  return isSeed(seed) ? String(seed) : "—";
}
