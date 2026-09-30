// Minimal GIF89a decoder for tests, written from the GIF89a specification and
// kept independent of the SDK encoder. It decodes every image, composites it
// onto the logical screen (disposal methods 0-2, no interlacing) and reports
// the LZW details the tests assert: clear codes and the largest code size.

function lzwDecode(data, minCodeSize, pixelCount) {
  if (minCodeSize < 2 || minCodeSize > 8)
    throw new Error(`Invalid LZW minimum code size ${minCodeSize}.`);
  const clear = 1 << minCodeSize;
  const end = clear + 1;
  const prefix = new Int32Array(4096).fill(-1);
  const suffix = new Uint8Array(4096);
  for (let code = 0; code < clear; code++) suffix[code] = code;
  let size = minCodeSize + 1;
  let next = end + 1;
  let previous = -1;
  let position = 0;
  let clears = 0;
  let largestSize = size;
  let ended = false;
  const output = [];
  const expand = (code) => {
    const text = [];
    for (let at = code; at !== -1; at = prefix[at]) text.push(suffix[at]);
    return text.reverse();
  };
  while (!ended) {
    if (position + size > data.length * 8)
      throw new Error('The LZW stream ends without an end code.');
    let code = 0;
    for (let bit = 0; bit < size; bit++, position++)
      code |= ((data[position >> 3] >> (position & 7)) & 1) << bit;
    if (code === clear) {
      size = minCodeSize + 1;
      next = end + 1;
      previous = -1;
      clears++;
      continue;
    }
    if (code === end) {
      ended = true;
      break;
    }
    if (previous === -1) {
      if (code >= clear) throw new Error(`Code ${code} cannot follow a clear code.`);
      output.push(code);
      previous = code;
      continue;
    }
    if (code > next || (code === next && next >= 4096))
      throw new Error(`Invalid LZW code ${code}.`);
    const first = code < next ? expand(code)[0] : expand(previous)[0];
    if (next < 4096) {
      prefix[next] = previous;
      suffix[next] = first;
      next++;
      if (next === 1 << size && size < 12) size++;
      largestSize = Math.max(largestSize, size);
    }
    for (const value of expand(code)) output.push(value);
    previous = code;
  }
  if (Math.ceil(position / 8) !== data.length)
    throw new Error('Unexpected data after the LZW end code.');
  if (output.length !== pixelCount)
    throw new Error(`Decoded ${output.length} pixels, expected ${pixelCount}.`);
  return { indices: Uint8Array.from(output), clears, largestSize };
}

/** Decodes a GIF; every frame carries a copy of the composited screen as RGB bytes. */
export function decodeGif(input) {
  const data = input instanceof Uint8Array ? input : Uint8Array.from(input);
  let at = 0;
  const byte = () => {
    if (at >= data.length) throw new Error('The GIF is truncated.');
    return data[at++];
  };
  const u16 = () => byte() | (byte() << 8);
  const ascii = (length) => String.fromCharCode(...Array.from({ length }, byte));
  const table = (bits) => Array.from({ length: 1 << bits }, () => [byte(), byte(), byte()]);
  const blocks = () => {
    const bytes = [];
    for (let length = byte(); length !== 0; length = byte())
      for (let index = 0; index < length; index++) bytes.push(byte());
    return Uint8Array.from(bytes);
  };
  if (ascii(6) !== 'GIF89a') throw new Error('Not a GIF89a file.');
  const width = u16();
  const height = u16();
  const packed = byte();
  byte(); // background color index
  byte(); // pixel aspect ratio
  const globalColors = packed & 0x80 ? table((packed & 7) + 1) : null;
  const screen = new Uint8Array(width * height * 3);
  const frames = [];
  let loop = null;
  let control = null;
  for (;;) {
    const introducer = byte();
    if (introducer === 0x3b) break;
    if (introducer === 0x21) {
      const label = byte();
      if (label === 0xf9) {
        if (byte() !== 4) throw new Error('Malformed graphic control extension.');
        const flags = byte();
        const delay = u16();
        const transparent = byte();
        if (byte() !== 0) throw new Error('Missing graphic control terminator.');
        control = {
          disposal: (flags >> 2) & 7,
          delay,
          transparent: flags & 1 ? transparent : null,
        };
      } else if (label === 0xff) {
        const identifier = ascii(byte());
        const payload = blocks();
        if (identifier === 'NETSCAPE2.0' && payload[0] === 1) loop = payload[1] | (payload[2] << 8);
      } else blocks();
      continue;
    }
    if (introducer !== 0x2c) throw new Error(`Unexpected block 0x${introducer.toString(16)}.`);
    const x = u16();
    const y = u16();
    const frameWidth = u16();
    const frameHeight = u16();
    const flags = byte();
    if (flags & 0x40) throw new Error('Interlaced images are not supported by this test decoder.');
    const localColors = flags & 0x80 ? table((flags & 7) + 1) : null;
    const colors = localColors ?? globalColors;
    if (!colors) throw new Error('A frame has no color table.');
    if (x + frameWidth > width || y + frameHeight > height)
      throw new Error('A frame lies outside the logical screen.');
    const minCodeSize = byte();
    const lzw = lzwDecode(blocks(), minCodeSize, frameWidth * frameHeight);
    const before = screen.slice();
    for (let row = 0; row < frameHeight; row++)
      for (let column = 0; column < frameWidth; column++) {
        const index = lzw.indices[row * frameWidth + column];
        if (index >= colors.length) throw new Error(`Index ${index} is outside the color table.`);
        if (control?.transparent === index) continue;
        screen.set(colors[index], ((y + row) * width + x + column) * 3);
      }
    frames.push({
      x,
      y,
      width: frameWidth,
      height: frameHeight,
      delay: control?.delay ?? 0,
      disposal: control?.disposal ?? 0,
      localColors: localColors?.length ?? 0,
      minCodeSize,
      clears: lzw.clears,
      largestCodeSize: lzw.largestSize,
      rgb: screen.slice(),
    });
    if (control?.disposal === 2)
      for (let row = 0; row < frameHeight; row++)
        screen.fill(0, ((y + row) * width + x) * 3, ((y + row) * width + x + frameWidth) * 3);
    else if (control?.disposal === 3) screen.set(before);
    control = null;
  }
  if (at !== data.length) throw new Error('Unexpected data after the GIF trailer.');
  return { width, height, loop, globalColors: globalColors?.length ?? 0, frames };
}
