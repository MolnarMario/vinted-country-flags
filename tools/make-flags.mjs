// Generates the bundled flag SVGs from a compact spec.
// Run: node tools/make-flags.mjs
//
// Flags are drawn on a 3:2 viewBox (60x40) so they all line up in the badge,
// which renders them about 18 pixels wide. At that size the bands and the
// colours are the whole picture and an emblem is two pixels of noise, so the
// drawings below stop at the bands.
//
// Every ISO 3166-1 alpha-2 code gets a file. Vinted has 27 markets but a seller
// registered in one can live anywhere, and /api/v2/users/{id} hands back
// whatever country_iso_code they picked, so 34 flags would have left holes. The
// codes with no drawing get a letter tile, which is legible and honest. Nothing
// 404s.
import { writeFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';

const W = 60, H = 40;
const wrap = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}">${body}</svg>\n`;

const rect = (x, y, w, h, fill) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}"/>`;

// Three equal vertical bands, left to right.
const vert3 = ([a, b, c]) =>
  rect(0, 0, 20, H, a) + rect(20, 0, 20, H, b) + rect(40, 0, 20, H, c);

// Horizontal bands. Pass [[color, weight], ...]; weights are relative.
const bands = (spec) => {
  const total = spec.reduce((s, [, w]) => s + w, 0);
  let y = 0;
  return spec
    .map(([color, w]) => {
      const h = (H * w) / total;
      const r = rect(0, +y.toFixed(3), W, +h.toFixed(3), color);
      y += h;
      return r;
    })
    .join('');
};

const horiz3 = ([a, b, c]) => bands([[a, 1], [b, 1], [c, 1]]);

// Nordic cross: offset left of centre, per the real proportions.
const nordic = (bg, cross, inner) => {
  const cx = 22, cw = 6, ch = 6, cy = 17;
  let s = rect(0, 0, W, H, bg);
  s += rect(cx, 0, cw, H, cross) + rect(0, cy, W, ch, cross);
  if (inner) {
    s += rect(cx + 2, 0, cw - 4, H, inner) + rect(0, cy + 2, W, ch - 4, inner);
  }
  return s;
};

// A five pointed star, radius r, pointing up.
const star = (cx, cy, r, fill) => {
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const rad = i % 2 ? r * 0.382 : r;
    const a = (Math.PI / 5) * i - Math.PI / 2;
    pts.push(`${(cx + rad * Math.cos(a)).toFixed(2)},${(cy + rad * Math.sin(a)).toFixed(2)}`);
  }
  return `<polygon points="${pts.join(' ')}" fill="${fill}"/>`;
};

// Crescent opening right, drawn as one disc minus a smaller offset disc.
const crescent = (cx, cy, r, fill, bg) =>
  `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}"/>` +
  `<circle cx="${cx + r * 0.3}" cy="${cy}" r="${r * 0.8}" fill="${bg}"/>`;

const UNION_JACK =
  rect(0, 0, W, H, '#012169') +
  `<path d="M0,0 L60,40 M60,0 L0,40" stroke="#FFFFFF" stroke-width="8"/>` +
  `<path d="M0,0 L60,40 M60,0 L0,40" stroke="#C8102E" stroke-width="4"/>` +
  rect(0, 14, W, 12, '#FFFFFF') + rect(24, 0, 12, H, '#FFFFFF') +
  rect(0, 16, W, 8, '#C8102E') + rect(26, 0, 8, H, '#C8102E');

// The canton flags put a half scale Union Jack in the top left quarter.
const canton = (field, starColor) =>
  rect(0, 0, W, H, field) +
  `<g transform="scale(0.5)">${UNION_JACK}</g>` +
  star(42, 12, 4, starColor) + star(48, 22, 4, starColor) +
  star(38, 28, 4, starColor) + star(50, 33, 3, starColor);

const FLAGS = {
  // ---- the 27 Vinted markets
  ro: vert3(['#002B7F', '#FCD116', '#CE1126']),
  hu: horiz3(['#CE2939', '#FFFFFF', '#477050']),
  pl: bands([['#FFFFFF', 1], ['#DC143C', 1]]),
  cz: rect(0, 0, W, 20, '#FFFFFF') + rect(0, 20, W, 20, '#D7141A') +
      `<polygon points="0,0 30,20 0,40" fill="#11457E"/>`,
  sk: horiz3(['#FFFFFF', '#0B4EA2', '#EE1C25']),
  si: horiz3(['#FFFFFF', '#005DA4', '#ED1C24']),
  hr: horiz3(['#FF0000', '#FFFFFF', '#171796']),
  de: horiz3(['#000000', '#DD0000', '#FFCE00']),
  at: horiz3(['#ED2939', '#FFFFFF', '#ED2939']),
  fr: vert3(['#002395', '#FFFFFF', '#ED2939']),
  it: vert3(['#008C45', '#F4F5F0', '#CD212A']),
  be: vert3(['#000000', '#FAE042', '#ED2939']),
  nl: horiz3(['#AE1C28', '#FFFFFF', '#21468B']),
  lu: horiz3(['#ED2939', '#FFFFFF', '#00A1DE']),
  ie: vert3(['#169B62', '#FFFFFF', '#FF883E']),
  es: bands([['#AA151B', 1], ['#F1BF00', 2], ['#AA151B', 1]]),
  pt: rect(0, 0, 24, H, '#006600') + rect(24, 0, 36, H, '#FF0000') +
      `<circle cx="24" cy="20" r="8" fill="#FFFF00" stroke="#FFFFFF" stroke-width="1"/>`,
  lt: horiz3(['#FDB913', '#006A44', '#C1272D']),
  lv: bands([['#9E3039', 2], ['#FFFFFF', 1], ['#9E3039', 2]]),
  ee: horiz3(['#0072CE', '#000000', '#FFFFFF']),
  fi: nordic('#FFFFFF', '#003580'),
  se: nordic('#006AA7', '#FECC00'),
  dk: nordic('#C60C30', '#FFFFFF'),
  gr: bands([['#0D5EAF', 1], ['#FFFFFF', 1], ['#0D5EAF', 1], ['#FFFFFF', 1],
             ['#0D5EAF', 1], ['#FFFFFF', 1], ['#0D5EAF', 1], ['#FFFFFF', 1],
             ['#0D5EAF', 1]]) +
      rect(0, 0, 22, 22, '#0D5EAF') + rect(9, 0, 4, 22, '#FFFFFF') +
      rect(0, 9, 22, 4, '#FFFFFF'),
  gb: UNION_JACK,
  us: bands(Array.from({ length: 13 }, (_, i) => [i % 2 ? '#FFFFFF' : '#B22234', 1])) +
      rect(0, 0, 24, 22, '#3C3B6E'),
  au: canton('#00008B', '#FFFFFF'),

  // ---- everywhere else a seller plausibly lives
  ch: rect(0, 0, W, H, '#D52B1E') + rect(26, 10, 8, 20, '#FFFFFF') +
      rect(20, 16, 20, 8, '#FFFFFF'),
  no: nordic('#BA0C2F', '#FFFFFF', '#00205B'),
  is: nordic('#02529C', '#FFFFFF', '#DC1E35'),
  bg: horiz3(['#FFFFFF', '#00966E', '#D62612']),
  ua: bands([['#0057B7', 1], ['#FFD700', 1]]),
  cy: rect(0, 0, W, H, '#FFFFFF') +
      `<path d="M22 12 l7 -2 l9 4 l-4 6 l-8 2 l-6 -5 z" fill="#D57800"/>` +
      `<path d="M25 24 q5 6 10 4" stroke="#4E5B31" stroke-width="1.4" fill="none"/>`,
  mt: rect(0, 0, 30, H, '#FFFFFF') + rect(30, 0, 30, H, '#CF142B'),
  rs: horiz3(['#C6363C', '#0C4076', '#FFFFFF']),
  ru: horiz3(['#FFFFFF', '#0039A6', '#D52B1E']),
  by: bands([['#CE1720', 2], ['#007C30', 1]]) + rect(0, 0, 8, H, '#FFFFFF'),
  md: vert3(['#0046AE', '#FFD200', '#CC092F']),
  ba: rect(0, 0, W, H, '#002F6C') + `<polygon points="16,0 46,40 16,40" fill="#FECB00"/>`,
  al: rect(0, 0, W, H, '#E41E20') +
      `<path d="M22 14 l8 -4 l8 4 l-4 12 l-4 4 l-4 -4 z" fill="#000000"/>`,
  mk: rect(0, 0, W, H, '#D20000') + `<circle cx="30" cy="20" r="7" fill="#FFE600"/>` +
      `<path d="M30,20 L0,0 M30,20 L60,0 M30,20 L0,40 M30,20 L60,40 M30,20 L0,20 M30,20 L60,20"` +
      ` stroke="#FFE600" stroke-width="4"/>` + `<circle cx="30" cy="20" r="7" fill="#FFE600"/>`,
  me: rect(0, 0, W, H, '#C40308') + rect(3, 2, 54, 36, '#D4AF37') + rect(5, 4, 50, 32, '#C40308'),
  xk: rect(0, 0, W, H, '#244AA5') +
      `<path d="M18 26 l6 -12 l6 8 l6 -8 l6 12 z" fill="#D0A650"/>` +
      Array.from({ length: 6 }, (_, i) => star(18 + i * 4.8, 9, 2, '#FFFFFF')).join(''),
  tr: rect(0, 0, W, H, '#E30A17') + crescent(24, 20, 9, '#FFFFFF', '#E30A17') +
      star(38, 20, 4.5, '#FFFFFF'),
  il: rect(0, 0, W, H, '#FFFFFF') + rect(0, 5, W, 5, '#0038B8') + rect(0, 30, W, 5, '#0038B8') +
      `<path d="M30,12 L36,22 L24,22 Z M30,28 L24,18 L36,18 Z" fill="none" stroke="#0038B8"` +
      ` stroke-width="1.6"/>`,
  ma: rect(0, 0, W, H, '#C1272D') + star(30, 20, 9, 'none') +
      `<polygon points="30,11 32.6,19 41,19 34.2,24 36.8,32 30,27 23.2,32 25.8,24 19,19 27.4,19"` +
      ` fill="none" stroke="#006233" stroke-width="1.6"/>`,
  dz: rect(0, 0, 30, H, '#006233') + rect(30, 0, 30, H, '#FFFFFF') +
      crescent(28, 20, 8, '#D21034', '#FFFFFF') + star(38, 20, 4, '#D21034'),
  tn: rect(0, 0, W, H, '#E70013') + `<circle cx="30" cy="20" r="11" fill="#FFFFFF"/>` +
      crescent(29, 20, 7, '#E70013', '#FFFFFF') + star(33, 20, 3.5, '#E70013'),
  eg: horiz3(['#CE1126', '#FFFFFF', '#000000']),
  ca: rect(0, 0, 15, H, '#D80621') + rect(45, 0, 15, H, '#D80621') +
      `<path d="M30 8 l2.5 6 l4 -2 l-1.5 6 l6 -1 l-2 3 l7 4 l-2 2 l1 4 l-8 -1.5 l.5 6 l-3.5 -3.5` +
      ` l-2 4 l-2 -4 l-3.5 3.5 l.5 -6 l-8 1.5 l1 -4 l-2 -2 l7 -4 l-2 -3 l6 1 l-1.5 -6 l4 2 z"` +
      ` fill="#D80621"/>`,
  mx: vert3(['#006847', '#FFFFFF', '#CE1126']),
  br: rect(0, 0, W, H, '#009C3B') +
      `<polygon points="30,4 56,20 30,36 4,20" fill="#FFDF00"/>` +
      `<circle cx="30" cy="20" r="8" fill="#002776"/>`,
  ar: horiz3(['#74ACDF', '#FFFFFF', '#74ACDF']) + `<circle cx="30" cy="20" r="4" fill="#F6B40E"/>`,
  jp: rect(0, 0, W, H, '#FFFFFF') + `<circle cx="30" cy="20" r="11" fill="#BC002D"/>`,
  cn: rect(0, 0, W, H, '#DE2910') + star(12, 11, 6, '#FFDE00') +
      star(23, 5, 2.4, '#FFDE00') + star(27, 10, 2.4, '#FFDE00') +
      star(27, 16, 2.4, '#FFDE00') + star(23, 21, 2.4, '#FFDE00'),
  kr: rect(0, 0, W, H, '#FFFFFF') + `<circle cx="30" cy="20" r="9" fill="#CD2E3A"/>` +
      `<path d="M21 20 a4.5 4.5 0 0 1 9 0 a4.5 4.5 0 0 0 9 0 a9 9 0 0 1 -18 0"` +
      ` fill="#0047A0"/>`,
  in: horiz3(['#FF9933', '#FFFFFF', '#138808']) +
      `<circle cx="30" cy="20" r="5" fill="none" stroke="#000088" stroke-width="1.4"/>`,
  th: bands([['#A51931', 1], ['#F4F5F8', 1], ['#2D2A4A', 2], ['#F4F5F8', 1], ['#A51931', 1]]),
  id: bands([['#FF0000', 1], ['#FFFFFF', 1]]),
  vn: rect(0, 0, W, H, '#DA251D') + star(30, 20, 10, '#FFFF00'),
  ph: rect(0, 0, W, 20, '#0038A8') + rect(0, 20, W, 20, '#CE1126') +
      `<polygon points="0,0 26,20 0,40" fill="#FFFFFF"/>` + star(9, 20, 4, '#FCD116'),
  nz: canton('#00247D', '#CC142B'),
  za: rect(0, 0, W, 20, '#DE3831') + rect(0, 20, W, 20, '#002395') +
      `<polygon points="0,0 30,20 0,40" fill="#007A4D"/>` +
      `<path d="M0,4 L22,20 L0,36" fill="none" stroke="#FFFFFF" stroke-width="4"/>`,
  ae: rect(0, 0, 16, H, '#FF0000') + rect(16, 0, 44, 13.33, '#00732F') +
      rect(16, 13.33, 44, 13.34, '#FFFFFF') + rect(16, 26.67, 44, 13.33, '#000000'),
  pe: vert3(['#D91023', '#FFFFFF', '#D91023']),
  co: bands([['#FCD116', 2], ['#003893', 1], ['#CE1126', 1]]),
  cl: rect(0, 0, W, 20, '#FFFFFF') + rect(0, 20, W, 20, '#D52B1E') +
      rect(0, 0, 20, 20, '#0039A6') + star(10, 10, 6, '#FFFFFF'),
  mc: bands([['#CE1126', 1], ['#FFFFFF', 1]]),
  sm: bands([['#FFFFFF', 1], ['#5EB6E4', 1]]),
  li: bands([['#002B7F', 1], ['#CE1126', 1]]),
  ad: vert3(['#10069F', '#FED100', '#D50032']),
  am: horiz3(['#D90012', '#0033A0', '#F2A800']),
  ge: rect(0, 0, W, H, '#FFFFFF') + rect(24, 0, 12, H, '#FF0000') + rect(0, 14, W, 12, '#FF0000'),
  az: horiz3(['#0092BC', '#E8112D', '#00AE65']),
  kz: rect(0, 0, W, H, '#00AFCA') + `<circle cx="32" cy="19" r="6" fill="#FEC50C"/>`,
  tw: rect(0, 0, W, H, '#FE0000') + rect(0, 0, 30, 20, '#000095') + star(15, 10, 7, '#FFFFFF'),

  // ---- markers, not countries
  // A seller we could not place, or one who hides their location.
  xx: rect(0, 0, W, H, '#E4E6EA') +
      `<text x="30" y="27" font-family="Helvetica,Arial,sans-serif" font-size="18"` +
      ` font-weight="600" fill="#8B9098" text-anchor="middle">?</text>`,
  // Somewhere in the eurozone: the currency answered, the lookup has not.
  eu: rect(0, 0, W, H, '#003399') +
      Array.from({ length: 12 }, (_, i) => {
        const a = (i * Math.PI) / 6;
        const x = (30 + 12 * Math.sin(a)).toFixed(2);
        const y = (20 - 12 * Math.cos(a)).toFixed(2);
        return `<circle cx="${x}" cy="${y}" r="1.7" fill="#FFCC00"/>`;
      }).join(''),
};

// Every ISO 3166-1 alpha-2 code, plus XK for Kosovo, which is not in the
// standard but is what services hand back for it.
const ISO = `
AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ
BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ
CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ
DE DJ DK DM DO DZ EC EE EG EH ER ES ET
FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY
HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP
KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY
MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ
NA NC NE NF NG NI NL NO NP NR NU NZ OM
PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW
SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ
TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ
UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS XK YE YT ZA ZM ZW
`.trim().split(/\s+/);

// The tile for a country with no drawing: its code, set in the same grey as
// the unknown marker so a screenful of them reads as "not placed yet" rather
// than as a broken image.
const tile = (code) =>
  rect(0, 0, W, H, '#EDEFF2') +
  `<text x="30" y="26" font-family="Helvetica,Arial,sans-serif" font-size="17"` +
  ` font-weight="600" letter-spacing="1" fill="#6B7280" text-anchor="middle">${code}</text>`;

mkdirSync('flags', { recursive: true });

// Start clean so a code dropped from the list does not leave a stale file
// behind for the next run to ship.
for (const file of readdirSync('flags')) {
  if (file.endsWith('.svg')) unlinkSync(`flags/${file}`);
}

let drawn = 0, tiles = 0;
for (const code of ISO) {
  const key = code.toLowerCase();
  if (FLAGS[key]) drawn++;
  else {
    FLAGS[key] = tile(code);
    tiles++;
  }
}

for (const [code, body] of Object.entries(FLAGS)) {
  writeFileSync(`flags/${code}.svg`, wrap(body));
}
console.log(`wrote ${Object.keys(FLAGS).length} flags: ${drawn} drawn, ${tiles} letter tiles`);
