// 通用数值工具。原先 clamp 在 video_preview / timeline_math 各写一份，
// 逐字相同；这里收成唯一实现，对外仍从原模块 re-export，调用方不用改。
export function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}
