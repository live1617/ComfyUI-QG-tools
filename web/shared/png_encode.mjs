// 自己写 PNG：canvas 内部按「预乘 alpha」存像素，alpha 一归零，RGB 就跟着没了。
// 所以「透明但还留着原图颜色」这种像素，canvas 表达不出来 —— out.toBlob() 拿到的
// 必然是一片黑。遮罩编辑器正需要它：遮罩处 alpha=0（MASK 读 1-alpha），可 IMAGE
// 切到「保留画面」时还得把原图颜色还回去，只能绕过 canvas 自己编码。
//
// 只做一件事：8 位 RGBA、不过滤、不隔行，够用就好。压缩借浏览器的
// CompressionStream("deflate")（PNG 要的正是 zlib 流），拿不到就返回 null，
// 调用方退回 canvas.toBlob —— 那时颜色会丢，但图还能存。

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let value = n;
    for (let k = 0; k < 8; k += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[n] = value >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

async function deflate(bytes) {
  if (typeof CompressionStream !== "function") return null;
  const stream = new CompressionStream("deflate");
  const writer = stream.writable.getWriter();
  writer.write(bytes);
  writer.close();
  return new Uint8Array(await new Response(stream.readable).arrayBuffer());
}

// 每行先写一个 filter 字节（0 = 不过滤），PNG 的规定。
function scanlines(width, height, rgba) {
  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const at = y * (stride + 1);
    raw[at] = 0;
    raw.set(rgba.subarray(y * stride, y * stride + stride), at + 1);
  }
  return raw;
}

export async function encodeRgbaPng(width, height, rgba) {
  if (!width || !height || !rgba || rgba.length < width * height * 4) return null;
  const packed = await deflate(scanlines(width, height, rgba));
  if (!packed) return null;
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8;    // 每通道 8 位
  ihdr[9] = 6;    // 颜色类型 6 = 真彩 + alpha
  return new Blob(
    [
      new Uint8Array(SIGNATURE),
      chunk("IHDR", ihdr),
      chunk("IDAT", packed),
      chunk("IEND", new Uint8Array(0)),
    ],
    { type: "image/png" },
  );
}
