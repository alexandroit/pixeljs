// The B01 scene: an original 256 × 144 character/HUD frame. Everything is
// derived from the frame number, so Node (core-only, prebuilt records) and
// the browser (public graphics API) draw exactly the same commands.
// No DOM or Node APIs: this module runs in both.

export const SCENE_WIDTH = 256;
export const SCENE_HEIGHT = 144;

/** Indexed images (palette 0–15, 0 transparent) used by the scene. */
export function sceneImages() {
  // Hero: four 16 × 16 walking frames side by side (64 × 16).
  const hero = new Uint8Array(64 * 16);
  for (let frame = 0; frame < 4; frame++) {
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        const dx = x - 7.5;
        const dy = y - 6.5;
        let color = 0;
        if (dx * dx + dy * dy <= 36) color = 9; // body
        if (y === 5 && (x === 5 || x === 10)) color = 7; // eyes
        if (y >= 12 && (x + frame * 2) % 8 < 3) color = 4; // stepping feet
        hero[y * 64 + frame * 16 + x] = color;
      }
    }
  }
  // Coin: two 8 × 8 frames (16 × 8).
  const coin = new Uint8Array(16 * 8);
  for (let frame = 0; frame < 2; frame++) {
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const dx = (x - 3.5) * (frame === 0 ? 1 : 2);
        const dy = y - 3.5;
        coin[y * 16 + frame * 8 + x] = dx * dx + dy * dy <= 12 ? ((x + y) % 5 === 0 ? 7 : 10) : 0;
      }
    }
  }
  // Ground tile 8 × 8, opaque.
  const tile = new Uint8Array(64);
  for (let index = 0; index < 64; index++) {
    const x = index % 8;
    const y = index >> 3;
    tile[index] = y === 0 ? 11 : (x * 3 + y * 5) % 7 === 0 ? 4 : 3;
  }
  return {
    hero: { width: 64, height: 16, pixels: hero, transparentIndex: 0 },
    coin: { width: 16, height: 8, pixels: coin, transparentIndex: 0 },
    tile: { width: 8, height: 8, pixels: tile },
  };
}

const pad = (value, length) => String(value).padStart(length, '0');

/**
 * Draws one frame through a graphics-like object: the engine's `graphics`
 * or the benchmark's record encoder. `images` maps hero/coin/tile to the
 * drawer's own image values. About 95 commands per frame.
 */
export function drawScene(g, images, frame) {
  g.clear(1);
  for (let star = 0; star < 24; star++)
    g.pixel((star * 37 + (frame >> 2)) % SCENE_WIDTH, 14 + ((star * 11) % 60), 7);
  g.rect(0, 112, SCENE_WIDTH, 32, 3);
  for (let x = -(frame % 8); x < SCENE_WIDTH; x += 8) g.sprite(images.tile, x, 112);
  for (let coin = 0; coin < 6; coin++)
    g.sprite(
      images.coin,
      ((((coin * 45 - frame) % 300) + 300) % 300) - 20,
      96 + (((frame + coin * 10) >> 3) % 3),
      {
        sourceX: ((frame >> 3) & 1) * 8,
        width: 8,
      },
    );
  g.sprite(images.hero, 60 + (frame % 120), 96, {
    sourceX: ((frame >> 2) & 3) * 16,
    width: 16,
    flipX: Math.floor(frame / 120) % 2 === 1,
  });
  g.rect(0, 0, SCENE_WIDTH, 11, 0);
  g.text(2, 2, `SCORE ${pad((frame * 10) % 1000000, 6)}`, 7);
  g.text(112, 2, `LIVES ${3 - (Math.floor(frame / 600) % 3)}`, 8);
  g.text(192, 2, `T ${pad(300 - (Math.floor(frame / 60) % 300), 3)}`, 7);
  g.rectb(2, 131, 62, 10, 7);
  g.rect(3, 132, 60 - (frame % 61), 8, 8);
}
