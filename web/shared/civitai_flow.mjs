// Civitai 查询的「编排」层：把 civitai_lookup.mjs 里的纯函数串成一次点击。
//
// 加载器（ⓘ 卡片）和 QG LoRA堆（行尾 T 卡片）原来各写了一份几乎逐行相同的
// lookUpOnCivitai / readCapped / 存预览图。以后重定向白名单、哈希校验、图片
// 上限改一处就够，两边不会再漏。
//
// 🔴 依赖全部注入：fetchApi 是 ComfyUI 的 api.fetchApi，fetchImpl 是浏览器
// fetch。这个模块因此不 import /scripts/api.js、不碰 DOM，Node 里能直接拿
// 假实现跑全部分支（tools/_check_lora_shared_flow.mjs）。
import {
    civitaiByHashUrl,
    isCivitaiAddress,
    MAX_PICTURE_BYTES,
    parseCivitaiBody,
    pickCivitaiPicture,
    pictureError,
    smallPictureUrl,
} from "./civitai_lookup.mjs?v=202611141000";

const defaultFetch = (...args) => fetch(...args);

// 图床的 content-length 不可全信（可能缺失、也可能是压缩前的长度），所以边读
// 边数，到上限就 cancel —— 先 blob() 再量等于把整个 body 拉进内存之后才说不收。
export async function readCapped(response, limit) {
    const reader = response.body?.getReader?.();
    if (!reader) {
        const blob = await response.blob();
        if (blob.size > limit) throw pictureError("picture_too_large_while_reading");
        return blob;
    }
    const chunks = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > limit) {
            await reader.cancel().catch(() => {});
            throw pictureError("picture_too_large_while_reading");
        }
        chunks.push(value);
    }
    return new Blob(chunks, { type: response.headers.get("content-type") || "" });
}

// Civitai 上这张 LoRA 的第一张合规格图，按 450px 副本下载，交给服务器当预览图。
// 服务器不覆盖已有预览图（回 picture_already_saved），那不是失败。
// 返回 false 表示「没有合规格的图」，由 onNoPicture 决定要不要说一句。
export async function saveCivitaiPreview({
    fetchApi,
    fetchImpl = defaultFetch,
    name,
    info,
    anyRating = false,
    onNoPicture = null,
    onSaved = null,
}) {
    const picture = pickCivitaiPicture(info, anyRating);
    if (!picture) {
        onNoPicture?.(anyRating);
        return false;
    }
    // 默认跟随重定向（Civitai 会跳到自己的文件库），跳完再验一次落点。
    const response = await fetchImpl(smallPictureUrl(picture.url), {
        credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store",
    });
    if (!response.ok) throw pictureError("picture_server", { status: response.status });
    if (!isCivitaiAddress(response.url)) throw pictureError("picture_not_civitai");
    if (!(response.headers.get("content-type") || "").startsWith("image/")) {
        throw pictureError("picture_not_an_image");
    }
    const declared = Number(response.headers.get("content-length") || 0);
    if (declared > MAX_PICTURE_BYTES) {
        throw pictureError("picture_too_large", {
            megabytes: Math.round((declared / (1024 * 1024)) * 10) / 10,
            limit: Math.round(MAX_PICTURE_BYTES / (1024 * 1024)),
        });
    }
    const blob = await readCapped(response, MAX_PICTURE_BYTES);
    const saved = await (await fetchApi(
        `/qg/lora/picture?name=${encodeURIComponent(name)}`,
        {
            method: "POST",
            headers: { "Content-Type": blob.type || "application/octet-stream" },
            body: blob,
        },
    )).json();
    if (!saved.ok) {
        throw pictureError(saved.code, saved.params ?? {}, saved.error || "Could not save the picture.");
    }
    onSaved?.();
    return true;
}

// 一次点击、一个文件：服务端算哈希 → 本浏览器问 Civitai → 服务端验过哈希才写侧车
// → 顺手按设置存预览图。Civitai 不认识这个文件（404）时返回 false，不算错误。
//
// 差异全在回调里：加载器失败弹 toast、成功调 pictureSaved()；QG LoRA堆把失败
// 写进卡片 note、成功给缩略图换版本串。两种 UI 共用这一条链路。
export async function lookupCivitaiInfo({
    fetchApi,
    fetchImpl = defaultFetch,
    name,
    picture = "PG-13",
    onNoPicture = null,
    onPictureSaved = null,
    onPictureError = null,
}) {
    const hashed = await (await fetchApi(
        `/qg/lora/hash?name=${encodeURIComponent(name)}`,
    )).json();
    if (!hashed.ok) throw new Error(hashed.error || "Could not hash this LoRA file.");
    // 🔴 redirect 不能设成 "error"：那样 fetch 抛的是 TypeError，跟「根本连不上」
    // 一模一样，会被 civitaiFailureText 判成「防火墙/VPN/代理拦住了」——
    // 明明连上了、只是跟了一次跳转。跟随，然后自己验落点。
    const response = await fetchImpl(civitaiByHashUrl(hashed.sha256), {
        credentials: "omit", redirect: "follow", referrerPolicy: "no-referrer", cache: "no-store",
    });
    if (response.status === 404) return false;
    if (!isCivitaiAddress(response.url)) {
        throw new Error("Civitai redirected the lookup somewhere else.");
    }
    if (!response.ok) throw pictureError("http_status", { status: response.status });
    const info = parseCivitaiBody(await response.text());
    const saved = await (await fetchApi("/qg/lora/civitai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, info }),
    })).json();
    if (!saved.ok) throw new Error(saved.error || "Could not save the Civitai info.");
    if (picture !== "off") {
        // 图没存成不该把「信息已经存好了」也算成失败。
        try {
            await saveCivitaiPreview({
                fetchApi, fetchImpl, name, info,
                anyRating: picture === "any",
                onNoPicture,
                onSaved: onPictureSaved,
            });
        } catch (error) {
            // 🔴 服务器不覆盖已有预览图是常态，不是错误。以前只有开关堆吞它，
            // 加载器每点一次「重新获取」都弹一句「已经有预览图了」—— 现在统一。
            if (error?.code !== "picture_already_saved") onPictureError?.(error);
        }
    }
    return true;
}
