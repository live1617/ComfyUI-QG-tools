export const INPUT_FOLDER_MODE = "input folder";
export const LOCAL_PATH_MODE = "local path";

export function normalizeVideoSourceMode(value) {
  return value === LOCAL_PATH_MODE ? LOCAL_PATH_MODE : INPUT_FOLDER_MODE;
}

export function normalizeVideoOptions(values, selected = "") {
  const result = [];
  for (const value of Array.isArray(values) ? values : []) {
    const text = String(value ?? "");
    if (text && !result.includes(text)) result.push(text);
  }
  const current = String(selected ?? "");
  if (current && !result.includes(current)) result.push(current);
  return result;
}

export function videoSourceState(mode, video, localPath) {
  const normalizedMode = normalizeVideoSourceMode(mode);
  const selection = String(
    normalizedMode === LOCAL_PATH_MODE ? localPath ?? "" : video ?? "",
  ).trim();
  return {
    mode: normalizedMode,
    selection,
    key: selection ? `${normalizedMode === LOCAL_PATH_MODE ? "local" : "input"}:${selection}` : "",
    hint: normalizedMode === LOCAL_PATH_MODE
      ? "Reads directly from this server without copying the file."
      : "Choose an uploaded video or add one to ComfyUI's input folder.",
  };
}

// Images use the same picker card, but their backend accepts input-folder
// references only. Do not advertise a Local path mode it cannot execute.
export function mediaSourceState(kind, mode, selection, localPath) {
  if (kind !== "image") return videoSourceState(mode, selection, localPath);
  const image = String(selection ?? "");
  return {
    mode: INPUT_FOLDER_MODE,
    selection: image,
    key: image,
    hint: "Choose an uploaded image or drop one onto this node.",
  };
}
