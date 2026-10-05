'use strict';
// Pixel-block banner: bitmap letters, drop shadow, horizontal gradient.
// bannerFor(columns, level) picks the largest variant that fits:
//   >= 120 columns  thick 2-pixel-stroke letters
//   >= 100 columns  1-pixel letters, two cells per pixel
//   >=  50 columns  1-pixel letters in half-blocks (compact)
//   otherwise, or without colour support: one line of text
const { colorLevel, gradientAt, shade, fg, bg, RESET } = require('./colors');
const { SLIM, THICK } = require('./logo-fonts');

const TEXT = '>AI-SDLC';
const BLUE_PURPLE_PINK = [[71, 150, 228], [132, 122, 206], [195, 103, 127]];
const BASIC = ['\x1b[94m', '\x1b[95m', '\x1b[91m'];

// Pixel grid with 0 = empty, 1 = letter, 2 = shadow. One extra row below
// the letters holds the shadow of the bottom stroke.
function pixels(text, font = SLIM) {
  const height = Object.values(font)[0].length;
  const rows = Array.from({ length: height }, () => []);
  [...text].forEach((ch, n) => {
    const glyph = font[ch];
    if (!glyph) throw new Error(`no glyph for ${ch}`);
    for (let r = 0; r < height; r++) rows[r].push(...[...glyph[r]].map((c) => (c === '#' ? 1 : 0)), ...(n < text.length - 1 ? [0] : []));
  });
  const w = rows[0].length;
  const out = [...rows, new Array(w).fill(0)].map((row) => [...row, 0]);
  // shadow: one pixel down-right of every letter pixel, where no letter pixel already is
  for (let r = 0; r < height; r++) for (let c = 0; c < w; c++) if (rows[r][c] && !(rows[r + 1] || [])[c + 1]) out[r + 1][c + 1] = 2;
  return out;
}

// scale 2 -> two cells per pixel (wide); scale 1 -> half-block rows (compact).
function renderLogo({ text = TEXT, scale = 2, level = colorLevel(), font = SLIM } = {}) {
  const grid = pixels(text, font);
  const w = grid[0].length;
  const paint = (cls, x) => {
    if (!cls) return null;
    const base = gradientAt(BLUE_PURPLE_PINK, x / (w - 1));
    return cls === 1 ? base : shade(base);
  };
  const third = (x) => BASIC[Math.min(2, Math.floor((x / w) * 3))];
  const lines = [];
  if (scale === 2) {
    for (const row of grid) {
      let s = '';
      row.forEach((cls, x) => {
        if (!cls) s += '  ';
        else if (level === 3) s += `${fg(paint(cls, x))}██${RESET}`;
        else if (level === 1) s += cls === 1 ? `${third(x)}██${RESET}` : '\x1b[2m░░\x1b[0m';
        else s += cls === 1 ? '██' : '░░';
      });
      lines.push(s.replace(/\s+$/, ''));
    }
    return lines;
  }
  for (let r = 0; r < grid.length; r += 2) {
    let s = '';
    for (let x = 0; x < w; x++) {
      const t = grid[r][x];
      const b = r + 1 < grid.length ? grid[r + 1][x] : 0;
      if (level === 3) {
        const tc = paint(t, x);
        const bc = paint(b, x);
        if (!tc && !bc) s += ' ';
        else if (tc && bc && t === b) s += `${fg(tc)}█${RESET}`;
        else if (tc && !bc) s += `${fg(tc)}▀${RESET}`;
        else if (!tc && bc) s += `${fg(bc)}▄${RESET}`;
        else s += `${fg(tc)}${bg(bc)}▀${RESET}`;
      } else {
        const ch = t === 1 && b === 1 ? '█' : t === 1 ? '▀' : b === 1 ? '▄' : t || b ? '░' : ' ';
        s += level === 1 && ch !== ' ' ? `${third(x)}${ch}${RESET}` : ch;
      }
    }
    lines.push(s.replace(/\s+$/, ''));
  }
  return lines;
}

// The one-line fallback: gradient text on truecolor, bold on 16 colours, plain otherwise.
function textBanner(level) {
  const label = '> AI-SDLC';
  if (level === 3) return [...label].map((ch, i) => `\x1b[1m${fg(gradientAt(BLUE_PURPLE_PINK, i / (label.length - 1)))}${ch}${RESET}`).join('');
  return level === 1 ? `\x1b[1;94m${label}${RESET}` : label;
}

function bannerFor(columns = 80, level = colorLevel(), { unicode = true } = {}) {
  if (!level || !unicode || columns < 50) return [textBanner(level)];
  if (columns >= 120) return renderLogo({ font: THICK, scale: 2, level });
  if (columns >= 100) return renderLogo({ scale: 2, level });
  return renderLogo({ scale: 1, level });
}

module.exports = { renderLogo, bannerFor, pixels, textBanner };

if (require.main === module) {
  const cols = process.stdout.columns || 80;
  console.log(`\n${bannerFor(process.argv.includes('--compact') ? 60 : cols, colorLevel()).join('\n')}\n`);
}
