/**
 * Generator for the rendered UI mockup images (P1/P2/P3 of the
 * ui-modernization-and-setup-fix design).
 *
 * Presentational only. Reproduces the tsx mockups under
 * apps/mobile/src/ui/mockups/*.tsx using the REAL light-mode palette from
 * apps/mobile/src/ui/theme.ts so the visuals match the shipping app.
 *
 * Run:  node docs/ui-mockups/_generate.mjs
 * Emits hand-crafted SVG screen images into docs/ui-mockups/.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = dirname(fileURLToPath(import.meta.url));

/* ----- real light-mode palette (apps/mobile/src/ui/theme.ts) ----- */
const C = {
  bg: '#FAFAF9',
  surface: '#FFFFFF',
  field: '#F1F2F4',
  divider: '#ECEDEF',
  text: '#1F2430',
  subtext: '#5C6470',
  faint: '#98A0AB',
  brand: '#2F5FE8',
  brandSoft: '#5B82EE',
  onBrand: '#FFFFFF',
  bubbleIn: '#FFFFFF',
  secure: '#2E7D55',
  danger: '#D4493E',
  brandFill: '#EDF2FD',
  bezel: '#0F1116',
};
// avatarColor() results (computed from theme.ts hash):
const AV = { maya: '#4A7D6D', leo: '#4A6FA8', aria: '#508487', sam: '#A86487', team: '#B07A4F', dad: '#A86487' };

const FF = `font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif"`;

const SW = 394;   // screen width
const SH = 904;   // screen height
const BZ = 14;    // bezel thickness

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function txt(x, y, s, { size = 14, color = C.text, weight = 400, anchor = 'start', italic = false, opacity = 1 } = {}) {
  const st = italic ? ' font-style="italic"' : '';
  const op = opacity !== 1 ? ` opacity="${opacity}"` : '';
  return `<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" fill="${color}" text-anchor="${anchor}"${st}${op} ${FF}>${esc(s)}</text>`;
}

/* ---------------- vector icons (stroke based, centered) ---------------- */
function icon(name, cx, cy, size, color, sw = 2) {
  const h = size / 2;
  const L = `stroke="${color}" stroke-width="${sw}" fill="none" stroke-linecap="round" stroke-linejoin="round"`;
  switch (name) {
    case 'back':
      return `<polyline points="${cx + h * 0.5},${cy - h} ${cx - h * 0.5},${cy} ${cx + h * 0.5},${cy + h}" ${L}/>`;
    case 'chevron-right':
      return `<polyline points="${cx - h * 0.5},${cy - h} ${cx + h * 0.5},${cy} ${cx - h * 0.5},${cy + h}" ${L}/>`;
    case 'more-vert':
      return `<g fill="${color}">
        <circle cx="${cx}" cy="${cy - size * 0.42}" r="${sw * 1.15}"/>
        <circle cx="${cx}" cy="${cy}" r="${sw * 1.15}"/>
        <circle cx="${cx}" cy="${cy + size * 0.42}" r="${sw * 1.15}"/></g>`;
    case 'shield':
      return `<path d="M ${cx} ${cy - h} L ${cx + h} ${cy - h * 0.5} L ${cx + h} ${cy + h * 0.1} Q ${cx + h} ${cy + h * 0.8} ${cx} ${cy + h} Q ${cx - h} ${cy + h * 0.8} ${cx - h} ${cy + h * 0.1} L ${cx - h} ${cy - h * 0.5} Z" ${L}/>`;
    case 'verified': // check mark
      return `<polyline points="${cx - h * 0.7},${cy} ${cx - h * 0.1},${cy + h * 0.6} ${cx + h * 0.8},${cy - h * 0.6}" ${L}/>`;
    case 'timer':
      return `<g ${L}><circle cx="${cx}" cy="${cy + h * 0.15}" r="${h * 0.85}"/><line x1="${cx - h * 0.4}" y1="${cy - h}" x2="${cx + h * 0.4}" y2="${cy - h}"/><line x1="${cx}" y1="${cy + h * 0.15}" x2="${cx}" y2="${cy - h * 0.35}"/></g>`;
    case 'hide': // eye-off
      return `<g ${L}><path d="M ${cx - h} ${cy} Q ${cx} ${cy - h * 0.9} ${cx + h} ${cy} Q ${cx} ${cy + h * 0.9} ${cx - h} ${cy}"/><circle cx="${cx}" cy="${cy}" r="${h * 0.32}"/><line x1="${cx - h}" y1="${cy + h}" x2="${cx + h}" y2="${cy - h}"/></g>`;
    case 'search':
      return `<g ${L}><circle cx="${cx - h * 0.2}" cy="${cy - h * 0.2}" r="${h * 0.6}"/><line x1="${cx + h * 0.35}" y1="${cy + h * 0.35}" x2="${cx + h}" y2="${cy + h}"/></g>`;
    case 'compose':
      return `<g ${L}><path d="M ${cx - h} ${cy + h} L ${cx - h} ${cy + h - 0.0} Z"/><path d="M ${cx - h} ${cy + h} L ${cx + h * 0.2} ${cy - h * 0.6} L ${cx + h} ${cy + h * 0.2} L ${cx - h * 0.4} ${cy + h} Z"/><line x1="${cx + h * 0.2}" y1="${cy - h * 0.6}" x2="${cx + h}" y2="${cy + h * 0.2}"/></g>`;
    case 'send':
      return `<path d="M ${cx - h} ${cy - h} L ${cx + h} ${cy} L ${cx - h} ${cy + h} L ${cx - h * 0.2} ${cy} Z" fill="${color}" stroke="${color}" stroke-width="${sw}" stroke-linejoin="round"/>`;
    case 'plus':
      return `<g ${L}><line x1="${cx - h}" y1="${cy}" x2="${cx + h}" y2="${cy}"/><line x1="${cx}" y1="${cy - h}" x2="${cx}" y2="${cy + h}"/></g>`;
    case 'lock':
      return `<g ${L}><rect x="${cx - h * 0.7}" y="${cy - h * 0.1}" width="${h * 1.4}" height="${h}" rx="2"/><path d="M ${cx - h * 0.4} ${cy - h * 0.1} L ${cx - h * 0.4} ${cy - h * 0.5} Q ${cx} ${cy - h * 1.1} ${cx + h * 0.4} ${cy - h * 0.5} L ${cx + h * 0.4} ${cy - h * 0.1}"/></g>`;
    default:
      return '';
  }
}

/* ---------------- phone frame ---------------- */
function statusBar(ox, oy) {
  return `
  <g transform="translate(${ox},${oy})">
    ${txt(28, 22, '9:41', { size: 13, weight: 700, color: C.text })}
    <g fill="${C.text}">
      <rect x="${SW - 92}" y="13" width="3" height="9" rx="1"/>
      <rect x="${SW - 86}" y="10" width="3" height="12" rx="1"/>
      <rect x="${SW - 80}" y="7" width="3" height="15" rx="1"/>
      <rect x="${SW - 74}" y="4" width="3" height="18" rx="1"/>
    </g>
    <g ${`stroke="${C.text}"`} stroke-width="1.5" fill="none">
      <path d="M ${SW - 60} 14 Q ${SW - 52} 6 ${SW - 44} 14"/>
      <path d="M ${SW - 57} 17 Q ${SW - 52} 12 ${SW - 47} 17"/>
    </g>
    <circle cx="${SW - 52}" cy="20" r="1.4" fill="${C.text}"/>
    <rect x="${SW - 36}" y="7" width="26" height="13" rx="3.5" fill="none" stroke="${C.text}" stroke-width="1.3"/>
    <rect x="${SW - 9}" y="10" width="2.5" height="7" rx="1" fill="${C.text}"/>
    <rect x="${SW - 34}" y="9" width="20" height="9" rx="2" fill="${C.text}"/>
  </g>`;
}

function phone(ox, oy, inner, id) {
  const clip = `clip-${id}`;
  return `
  <g>
    <rect x="${ox - BZ}" y="${oy - BZ}" width="${SW + 2 * BZ}" height="${SH + 2 * BZ}" rx="54" fill="${C.bezel}"/>
    <rect x="${ox - BZ + 2}" y="${oy - BZ + 2}" width="${SW + 2 * BZ - 4}" height="${SH + 2 * BZ - 4}" rx="52" fill="none" stroke="#2A2E36" stroke-width="1.5"/>
    <clipPath id="${clip}"><rect x="${ox}" y="${oy}" width="${SW}" height="${SH}" rx="40"/></clipPath>
    <rect x="${ox}" y="${oy}" width="${SW}" height="${SH}" rx="40" fill="${C.bg}"/>
    <g clip-path="url(#${clip})">
      ${statusBar(ox, oy)}
      <g transform="translate(${ox},${oy})">${inner}</g>
      <rect x="${ox + SW / 2 - 60}" y="${oy + SH - 18}" width="120" height="5" rx="2.5" fill="${C.text}" opacity="0.25"/>
    </g>
  </g>`;
}

function svgDoc(w, h, body, title) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(title)}">
  <rect width="${w}" height="${h}" fill="#EEF0F3"/>
  ${body}
</svg>\n`;
}

/* ---------------- conversation header (shared) ---------------- */
function convHeader(overflowOpen) {
  return `
  <rect x="0" y="32" width="${SW}" height="86" fill="${C.surface}"/>
  <line x1="0" y1="118" x2="${SW}" y2="118" stroke="${C.divider}" stroke-width="1"/>
  ${icon('back', 34, 84, 22, C.brandSoft, 2.4)}
  <circle cx="78" cy="84" r="20" fill="${AV.maya}"/>
  ${txt(78, 89, 'MP', { size: 14, weight: 700, color: '#fff', anchor: 'middle' })}
  ${txt(108, 80, 'Maya Patel', { size: 17, weight: 700, color: C.text })}
  ${txt(108, 98, 'online', { size: 11, weight: 600, color: C.secure })}
  ${icon('more-vert', 366, 84, 16, overflowOpen ? C.brand : C.subtext, 2.3)}`;
}

/* ---------------- bubble ---------------- */
function bubble({ dir, x, y, w, h, lines, footer, deleted = false, sending = false, tail = false, reaction = null }) {
  const out = dir === 'out';
  const fill = out ? C.brand : C.bubbleIn;
  const stroke = out ? 'none' : C.divider;
  const op = sending ? 0.6 : 1;
  const txtColor = deleted ? C.faint : out ? C.onBrand : C.text;
  const footColor = out ? C.onBrand : C.faint;
  let s = `<g opacity="${op}">`;
  s += `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="16" fill="${fill}"${out ? '' : ` stroke="${stroke}" stroke-width="1"`}/>`;
  if (tail) {
    if (out) {
      s += `<path d="M ${x + w - 14} ${y + h - 14} L ${x + w + 6} ${y + h} L ${x + w - 14} ${y + h} Z" fill="${fill}"/>`;
    } else {
      s += `<path d="M ${x + 14} ${y + h - 14} L ${x - 6} ${y + h} L ${x + 14} ${y + h} Z" fill="${fill}" stroke="${stroke}" stroke-width="1"/>`;
    }
  }
  const tx = x + 16;
  let ly = y + 26;
  for (const ln of lines) {
    s += txt(tx, ly, ln, { size: 14, color: txtColor, weight: 400, italic: deleted });
    ly += 19;
  }
  if (footer) {
    s += txt(x + w - 12, y + h - 9, footer, { size: 10, color: footColor, anchor: 'end', opacity: 0.9, weight: 500 });
  }
  s += `</g>`;
  if (reaction) {
    const rx = out ? x + w - 44 : x + 8;
    s += `<rect x="${rx}" y="${y + h - 10}" width="40" height="22" rx="11" fill="${C.field}" stroke="${C.divider}" stroke-width="1"/>`;
    s += txt(rx + 20, y + h + 5, reaction, { size: 12, anchor: 'middle' });
  }
  return s;
}

function dayPill(label, cy) {
  const w = 12 + label.length * 6.5;
  const x = SW / 2 - w / 2;
  return `<rect x="${x}" y="${cy - 12}" width="${w}" height="22" rx="11" fill="${C.field}"/>` +
    txt(SW / 2, cy + 4, label, { size: 11, color: C.subtext, weight: 600, anchor: 'middle' });
}

function conversationBody(overflow) {
  let s = convHeader(overflow);
  // messages
  s += dayPill('Yesterday', 142);
  s += bubble({ dir: 'out', x: 144, y: 162, w: 250, h: 70, lines: ['Hey! Are we still on for', 'lunch tomorrow?'], footer: '09:30  \u2713\u2713', tail: true });
  s += bubble({ dir: 'in', x: 24, y: 248, w: 214, h: 70, lines: ['Yes \u2014 12:30 at the', 'usual place?'], footer: '09:32', tail: true });
  s += bubble({ dir: 'out', x: 218, y: 332, w: 176, h: 44, lines: ['Perfect, see you then'], footer: '09:33  \u2713\u2713', tail: true, reaction: '\uD83D\uDC4D' });
  s += dayPill('Today', 408);
  s += bubble({ dir: 'in', x: 24, y: 432, w: 228, h: 44, lines: ['Morning! Running 10 min late'], footer: '09:05' });
  s += bubble({ dir: 'in', x: 24, y: 484, w: 150, h: 44, lines: ['Grab us a table?'], footer: '09:05', tail: true });
  s += bubble({ dir: 'out', x: 144, y: 540, w: 250, h: 44, lines: ['No worries \u2014 got the corner booth'], footer: '09:06  \u2713\u2713' });
  s += bubble({ dir: 'out', x: 190, y: 592, w: 204, h: 44, lines: ['Ordered you a coffee'], footer: 'edited \u00b7 09:06  \u2713\u2713', tail: true });
  s += bubble({ dir: 'in', x: 24, y: 648, w: 168, h: 40, lines: ['message deleted'], footer: '09:08', deleted: true });
  s += bubble({ dir: 'in', x: 24, y: 696, w: 232, h: 44, lines: ['You are the best, thank you'], footer: '09:09', tail: true });
  s += bubble({ dir: 'out', x: 234, y: 748, w: 160, h: 44, lines: ['See you in a few!'], footer: '09:10  \uD83D\uDD53', sending: true, tail: true });
  // composer
  s += `<line x1="0" y1="812" x2="${SW}" y2="812" stroke="${C.divider}" stroke-width="1"/>`;
  s += `<rect x="0" y="812" width="${SW}" height="76" fill="${C.surface}"/>`;
  s += `<rect x="20" y="826" width="316" height="46" rx="23" fill="${C.field}"/>`;
  s += txt(40, 854, 'Message\u2026', { size: 15, color: C.faint });
  s += `<circle cx="360" cy="849" r="23" fill="${C.brand}"/>`;
  s += icon('send', 360, 849, 18, C.onBrand, 2);
  if (overflow) {
    // dim scrim over message area
    s += `<rect x="0" y="118" width="${SW}" height="${SH - 118}" fill="#0F1116" opacity="0.18"/>`;
    const items = ['Disappearing messages', 'Verify identity', 'Safety number', 'Hide chat'];
    const mx = SW - 234, my = 126, mw = 218, ih = 48;
    s += `<rect x="${mx}" y="${my}" width="${mw}" height="${ih * items.length + 12}" rx="14" fill="${C.surface}" stroke="${C.divider}" stroke-width="1"/>`;
    items.forEach((it, i) => {
      const ry = my + 6 + i * ih;
      if (i > 0) s += `<line x1="${mx + 14}" y1="${ry}" x2="${mx + mw - 14}" y2="${ry}" stroke="${C.divider}" stroke-width="1"/>`;
      s += txt(mx + 18, ry + 30, it, { size: 14, color: it === 'Hide chat' ? C.danger : C.text });
    });
  }
  return s;
}

/* ---------------- profile ---------------- */
function profileBody() {
  let s = `<rect x="0" y="32" width="${SW}" height="68" fill="${C.surface}"/>`;
  s += `<line x1="0" y1="100" x2="${SW}" y2="100" stroke="${C.divider}" stroke-width="1"/>`;
  s += icon('back', 34, 66, 22, C.brandSoft, 2.4);
  s += txt(64, 71, 'Contact info', { size: 17, weight: 700, color: C.text });
  // identity
  const cx = SW / 2;
  s += `<circle cx="${cx}" cy="180" r="48" fill="${AV.maya}"/>`;
  s += txt(cx, 193, 'MP', { size: 34, weight: 700, color: '#fff', anchor: 'middle' });
  s += txt(cx, 262, 'Maya Patel', { size: 28, weight: 800, color: C.text, anchor: 'middle' });
  // badges
  const b1w = 108, b2w = 92, gap = 10;
  const total = b1w + b2w + gap, bx = cx - total / 2, by = 286;
  s += `<rect x="${bx}" y="${by}" width="${b1w}" height="28" rx="14" fill="${C.brandFill}"/>`;
  s += icon('shield', bx + 20, by + 14, 13, C.brand, 1.6);
  s += txt(bx + 34, by + 19, 'Encrypted', { size: 12, weight: 600, color: C.brand });
  const b2x = bx + b1w + gap;
  s += `<rect x="${b2x}" y="${by}" width="${b2w}" height="28" rx="14" fill="${C.brandFill}"/>`;
  s += icon('verified', b2x + 18, by + 14, 13, C.secure, 1.8);
  s += txt(b2x + 32, by + 19, 'Verified', { size: 12, weight: 600, color: C.secure });
  // action group card
  const rows = [
    { ic: 'timer', label: 'Disappearing messages', value: '1 day', danger: false },
    { ic: 'verified', label: 'Verify identity', value: 'Verified', danger: false },
    { ic: 'shield', label: 'View safety number', value: null, danger: false },
    { ic: 'hide', label: 'Hide chat', value: null, danger: true },
  ];
  const gx = 24, gw = SW - 48, gy = 350, rh = 58;
  s += `<rect x="${gx}" y="${gy}" width="${gw}" height="${rh * rows.length}" rx="14" fill="${C.surface}" stroke="${C.divider}" stroke-width="1"/>`;
  rows.forEach((r, i) => {
    const ry = gy + i * rh;
    if (i > 0) s += `<line x1="${gx + 56}" y1="${ry}" x2="${gx + gw}" y2="${ry}" stroke="${C.divider}" stroke-width="1"/>`;
    const col = r.danger ? C.danger : C.subtext;
    s += icon(r.ic, gx + 30, ry + rh / 2, 19, col, 1.9);
    s += txt(gx + 56, ry + rh / 2 + 5, r.label, { size: 15, color: r.danger ? C.danger : C.text });
    if (r.value) s += txt(gx + gw - 32, ry + rh / 2 + 5, r.value, { size: 12, color: C.faint, anchor: 'end', weight: 500 });
    s += icon('chevron-right', gx + gw - 18, ry + rh / 2, 14, C.faint, 2);
  });
  // footnote
  const fy = gy + rh * rows.length + 40;
  ['Messages and calls are end-to-end encrypted.', 'Tap \u201cView safety number\u201d to confirm Maya', 'Patel\u2019s identity on a trusted channel.'].forEach((ln, i) => {
    s += txt(cx, fy + i * 18, ln, { size: 12, color: C.faint, anchor: 'middle', weight: 500 });
  });
  return s;
}

/* ---------------- chats list ---------------- */
function chatsBody() {
  let s = txt(40, 88, 'Chats', { size: 28, weight: 800, color: C.text });
  // search
  s += `<rect x="24" y="104" width="${SW - 48}" height="44" rx="12" fill="${C.field}"/>`;
  s += icon('search', 44, 126, 16, C.faint, 1.8);
  s += txt(62, 131, 'Search', { size: 15, color: C.faint });
  const chats = [
    { c: AV.maya, ini: 'MP', name: 'Maya Patel', prev: 'See you in a few!', time: '09:10', unread: 0, lock: false },
    { c: AV.leo, ini: 'LN', name: 'Leo Nguyen', prev: 'You: sent the files', time: '08:42', unread: 0, lock: true },
    { c: AV.aria, ini: 'AC', name: 'Aria Costa', prev: 'Can you call me later?', time: 'Yesterday', unread: 3, lock: false },
    { c: AV.sam, ini: 'SO', name: 'Sam Okoye', prev: 'Encrypted message', time: 'Yesterday', unread: 1, lock: true },
    { c: AV.team, ini: 'DS', name: 'Design Sync', prev: 'Priya: pushed the mockups', time: 'Mon', unread: 0, lock: false },
    { c: AV.dad, ini: 'D', name: 'Dad', prev: 'Thanks!', time: 'Sun', unread: 0, lock: false },
  ];
  const rh = 76;
  let y = 172;
  chats.forEach((ch, i) => {
    const cy = y + rh / 2;
    if (i > 0) s += `<line x1="86" y1="${y}" x2="${SW - 20}" y2="${y}" stroke="${C.divider}" stroke-width="1"/>`;
    s += `<circle cx="52" cy="${cy}" r="26" fill="${ch.c}"/>`;
    s += txt(52, cy + 6, ch.ini, { size: 18, weight: 700, color: '#fff', anchor: 'middle' });
    s += txt(90, cy - 6, ch.name, { size: 17, weight: 700, color: C.text });
    let px = 90;
    if (ch.lock) { s += icon('lock', 97, cy + 14, 11, C.faint, 1.4); px = 110; }
    s += txt(px, cy + 18, ch.prev, { size: 12, color: C.subtext, weight: 500 });
    s += txt(SW - 22, cy - 10, ch.time, { size: 11, color: ch.unread > 0 ? C.brand : C.faint, anchor: 'end', weight: 500 });
    if (ch.unread > 0) {
      s += `<rect x="${SW - 44}" y="${cy + 2}" width="24" height="22" rx="11" fill="${C.brand}"/>`;
      s += txt(SW - 32, cy + 17, String(ch.unread), { size: 11, weight: 700, color: '#fff', anchor: 'middle' });
    }
    y += rh;
  });
  // FAB
  s += `<circle cx="${SW - 50}" cy="${SH - 70}" r="29" fill="${C.brand}"/>`;
  s += icon('compose', SW - 50, SH - 70, 22, C.onBrand, 2);
  return s;
}

/* ---------------- app lock (two states) ---------------- */
function appLockBody(verifying) {
  let s = '';
  const cx = SW / 2;
  s += txt(cx, 330, 'Enter PIN', { size: 28, weight: 800, color: C.text, anchor: 'middle' });
  s += txt(cx, 360, 'Your PIN unlocks the app.', { size: 15, color: C.faint, anchor: 'middle' });
  // pin dots field
  s += `<rect x="40" y="400" width="${SW - 80}" height="58" rx="12" fill="${C.field}"${verifying ? ' opacity="0.6"' : ''}/>`;
  for (let i = 0; i < 4; i++) {
    s += `<circle cx="${cx - 33 + i * 22}" cy="429" r="6" fill="${C.text}" opacity="${verifying ? 0.5 : 0.85}"/>`;
  }
  // button
  const by = 484, bh = 56;
  s += `<rect x="40" y="${by}" width="${SW - 80}" height="${bh}" rx="12" fill="${C.brand}"${verifying ? ' opacity="0.45"' : ''}/>`;
  if (verifying) {
    // spinner ring
    const sx = cx - 44, sy = by + bh / 2;
    s += `<circle cx="${sx}" cy="${sy}" r="9" fill="none" stroke="#ffffff" stroke-width="2.5" opacity="0.35"/>`;
    s += `<path d="M ${sx + 9} ${sy} A 9 9 0 0 1 ${sx} ${sy + 9}" fill="none" stroke="#ffffff" stroke-width="2.5" stroke-linecap="round"/>`;
    s += txt(cx + 4, by + bh / 2 + 6, 'Verifying\u2026', { size: 17, weight: 700, color: '#fff', anchor: 'middle' });
    s += txt(cx, by + bh + 30, 'Checking your PIN securely \u2014 the app stays responsive.', { size: 11, color: C.faint, anchor: 'middle', weight: 500 });
  } else {
    s += txt(cx, by + bh / 2 + 6, 'Unlock', { size: 17, weight: 700, color: '#fff', anchor: 'middle' });
  }
  return s;
}

/* ---------------- header before/after ---------------- */
function headerBeforeAfter() {
  const W = 760, H = 470;
  const cardW = 680, cardX = (W - cardW) / 2;
  let s = '';
  // BEFORE
  let by = 70;
  s += txt(cardX, by - 14, 'BEFORE  \u2014  cluttered 5-icon header', { size: 15, weight: 700, color: C.danger });
  s += `<rect x="${cardX}" y="${by}" width="${cardW}" height="74" rx="14" fill="${C.surface}" stroke="${C.divider}" stroke-width="1.5"/>`;
  s += icon('back', cardX + 26, by + 37, 20, C.brandSoft, 2.4);
  s += txt(cardX + 52, by + 42, 'Maya Patel', { size: 17, weight: 700, color: C.text });
  // 5 cramped emoji-style icons on the right
  const beIcons = ['timer', 'shield', 'verified', 'hide', 'plus'];
  beIcons.forEach((ic, i) => {
    const ix = cardX + cardW - 30 - (beIcons.length - 1 - i) * 34;
    s += `<rect x="${ix - 14}" y="${by + 23}" width="28" height="28" rx="7" fill="${C.field}"/>`;
    s += icon(ic, ix, by + 37, 15, C.subtext, 1.8);
  });
  s += txt(cardX + cardW - 86, by + 70, '5 actions crammed in', { size: 10, color: C.danger, anchor: 'middle', weight: 600 });
  // AFTER
  by = 300;
  s += txt(cardX, by - 14, 'AFTER  \u2014  clean header + overflow', { size: 15, weight: 700, color: C.secure });
  s += `<rect x="${cardX}" y="${by}" width="${cardW}" height="74" rx="14" fill="${C.surface}" stroke="${C.divider}" stroke-width="1.5"/>`;
  s += icon('back', cardX + 26, by + 37, 20, C.brandSoft, 2.4);
  s += `<circle cx="${cardX + 66}" cy="${by + 37}" r="19" fill="${AV.maya}"/>`;
  s += txt(cardX + 66, by + 42, 'MP', { size: 13, weight: 700, color: '#fff', anchor: 'middle' });
  s += txt(cardX + 94, by + 33, 'Maya Patel', { size: 17, weight: 700, color: C.text });
  s += txt(cardX + 94, by + 51, 'online', { size: 11, weight: 600, color: C.secure });
  s += icon('more-vert', cardX + cardW - 30, by + 37, 16, C.subtext, 2.3);
  s += txt(cardX + cardW - 30, by + 70, 'one \u22ee menu', { size: 10, color: C.secure, anchor: 'middle', weight: 600 });
  return svgDoc(W, H, `<rect width="${W}" height="${H}" fill="${C.bg}"/>` + s, 'Conversation header: before vs after');
}

/* ---------------- emit ---------------- */
const single = (inner, id, title) => svgDoc(SW + 2 * BZ + 40, SH + 2 * BZ + 40, phone(BZ + 20, BZ + 20, inner, id), title);

const files = {
  'conversation.svg': single(conversationBody(false), 'conv', 'Redesigned conversation screen'),
  'conversation-overflow.svg': single(conversationBody(true), 'convof', 'Conversation screen with overflow menu open'),
  'profile.svg': single(profileBody(), 'prof', 'Contact / profile screen'),
  'chats-list.svg': single(chatsBody(), 'chats', 'Modern chats list'),
};

// app lock: two phones side by side
{
  const gap = 50;
  const W = (SW + 2 * BZ) * 2 + gap + 80;
  const H = SH + 2 * BZ + 100;
  let body = `<rect width="${W}" height="${H}" fill="#EEF0F3"/>`;
  body += txt(40 + (SW + 2 * BZ) / 2, 44, 'Idle', { size: 16, weight: 700, color: C.subtext, anchor: 'middle' });
  body += txt(40 + (SW + 2 * BZ) + gap + (SW + 2 * BZ) / 2, 44, 'Verifying\u2026', { size: 16, weight: 700, color: C.brand, anchor: 'middle' });
  body += phone(40 + BZ, 70 + BZ, appLockBody(false), 'lockA');
  body += phone(40 + (SW + 2 * BZ) + gap + BZ, 70 + BZ, appLockBody(true), 'lockB');
  files['applock.svg'] = svgDoc(W, H, body, 'App lock: idle vs verifying (non-freezing)');
}

files['header-before-after.svg'] = headerBeforeAfter();

for (const [name, content] of Object.entries(files)) {
  writeFileSync(join(OUT, name), content);
  console.log('wrote', name, content.length, 'bytes');
}
