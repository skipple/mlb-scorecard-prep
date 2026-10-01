// Builds stadiums.json: an outline drawing of each MLB park, keyed by MLB venue id.
//
// The drawings come from Baseball Savant, which bundles one SVG per park (named by venue id) into
// the player page's script. This pulls them out, keeps the field geometry and fence distances, and
// drops Savant's colors, compass and grid so the page can draw them in its own style.
//
// Run with Node 18+ from the project root:  node tools/build-stadiums.js
const fs = require('fs');
const path = require('path');

const SAVANT = 'https://baseballsavant.mlb.com';
const PLAYER_PAGE = `${SAVANT}/savant-player/660271`; // any player page loads the bundle
const OUT = path.join(__dirname, '..', 'stadiums.json');

// Element ids in Savant's drawings, matched on their prefix (they get suffixes like "_1_").
const KINDS = [
  [/^(outfield|warning_track)/i, 'wall'],
  [/^grass/i, 'grass'],
  [/^(infield_sand|pitching-mound|pitchers_mound)/i, 'dirt'],
  [/^(left|right)-foul-line/i, 'line'],
  [/^(bases|home|pitching-rubber)/i, 'base'],
];
const SKIP = /^(compass|grid|numbers|surface)/i;
const GEOMETRY = ['d', 'points', 'x', 'y', 'width', 'height', 'cx', 'cy', 'r', 'rx', 'ry', 'x1', 'y1', 'x2', 'y2', 'transform'];
const SHAPES = new Set(['path', 'polygon', 'polyline', 'rect', 'circle', 'ellipse', 'line']);
// Fence labels are pushed away from this point, the middle of the outfield in every Savant park.
// (Pushing from home plate would slide the foul-pole labels along the foul line into the wall.)
const FIELD_CENTER = [125, 115];
// How far to push fence labels off the wall, in drawing units (the page shows 250 units in 160px).
const LABEL_PUSH = 8;

async function text(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.text();
}

// Each park is a compiled React component. Evaluate it with a jsx() that just records the tree;
// some components hand back a raw SVG string instead, which parseSvg() turns into the same shape.
function extractComponents(bundle) {
  const jsx = (tag, props) => ({ tag, props });
  const W = { jsxDEV: jsx, jsx, jsxs: jsx };
  // Free variables in a component (dev-build file names and such) resolve to undefined.
  const scope = new Proxy({}, {
    has: (t, k) => typeof k === 'string' && k !== 'W' && !(k in globalThis),
    get: () => undefined,
  });
  const re = /StadiumComponents\/(\d+)\.jsx`;(function \w+\(e\)\{)/g;
  const parks = {};
  let m;
  while ((m = re.exec(bundle))) {
    const start = m.index + m[0].length - m[2].length;
    // The component ends at the first closing brace that makes it parse.
    for (let end = bundle.indexOf('}', re.lastIndex); end !== -1 && end - start < 500000; end = bundle.indexOf('}', end + 1)) {
      let fn;
      try { fn = new Function('W', 'P', `with (P) { return (${bundle.slice(start, end + 1)}) }`)(W, scope); } catch { continue; }
      parks[m[1]] = toTree(fn({}));
      break;
    }
  }
  return parks;
}

function toTree(node) {
  if (node == null || node === false) return [];
  if (typeof node === 'string') return parseSvg(node);
  if (Array.isArray(node)) return node.flatMap(toTree);
  if (typeof node !== 'object') return [String(node)];
  const { children, dangerouslySetInnerHTML, ...props } = node.props ?? {};
  const kids = dangerouslySetInnerHTML ? parseSvg(dangerouslySetInnerHTML.__html) : toTree(children);
  return [{ tag: node.tag, attrs: { ...props, class: props.className }, children: kids }];
}

function parseSvg(s) {
  const root = { children: [] };
  const stack = [root];
  const re = /<(\/?)([\w:-]+)((?:\s+[\w:-]+\s*=\s*"[^"]*")*)\s*(\/?)>|([^<]+)|<!--[\s\S]*?-->|<[?!][^>]*>/g;
  let m;
  while ((m = re.exec(s))) {
    const [, close, tag, attrText, selfClose, textNode] = m;
    const top = stack.at(-1);
    if (textNode !== undefined) { if (textNode.trim()) top.children.push(textNode.trim()); continue; }
    if (!tag) continue;
    if (close) { stack.pop(); continue; }
    const attrs = Object.fromEntries([...attrText.matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)].map(a => [a[1], a[2]]));
    const el = { tag, attrs, children: [] };
    top.children.push(el);
    if (!selfClose) stack.push(el);
  }
  return root.children;
}

// Classes that Savant's own stylesheet hides (alternate walls, hidden labels).
function hiddenClasses(tree) {
  const css = [];
  const walk = n => { if (typeof n === 'string') return; if (n.tag === 'style') css.push(n.children.join('')); n.children.forEach(walk); };
  tree.forEach(walk);
  const hidden = new Set();
  for (const [, selectors, body] of css.join('').matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    if (/display\s*:\s*none/.test(body)) for (const c of selectors.matchAll(/\.([\w-]+)/g)) hidden.add(c[1]);
  }
  return hidden;
}

// One decimal is plenty for coordinates at this size. Transforms keep full precision: rounding a
// scale factor would shrink the whole field.
const num = v => String(v).replace(/(\.\d)\d+/g, '$1');

function simplify(tree) {
  const hidden = hiddenClasses(tree);
  const out = [];
  let north = null;
  const walk = (n, kind, transforms) => {
    if (typeof n === 'string') {
      // Any visible three-digit label is a fence distance.
      if (/^\d{3}$/.test(n)) out.push({ text: n, transforms });
      return;
    }
    const a = n.attrs ?? {};
    if (n.tag === 'style' || n.tag === 'defs' || n.tag === 'clipPath') return;
    if (a.display === 'none' || /display\s*:\s*none/.test(a.style ?? '')) return;
    if (String(a.class ?? '').split(/\s+/).some(c => hidden.has(c))) return;
    const id = a.id ?? '';
    if (/^compass/i.test(id)) { north ??= northAngle(n, transforms); return; }
    if (SKIP.test(id)) return;
    kind = KINDS.find(([re]) => re.test(id))?.[1] ?? kind;
    const t = [...transforms];
    // A text's own position (x/y and its tspan's) folds into its transform list.
    if (a.transform) t.push(a.transform);
    if (n.tag === 'text' || n.tag === 'tspan') {
      if (a.x || a.y) t.push(`translate(${a.x ?? 0} ${a.y ?? 0})`);
      n.children.forEach(c => walk(c, kind, t));
      return;
    }
    if (SHAPES.has(n.tag)) {
      if (!kind) return;
      const geo = GEOMETRY.filter(k => k !== 'transform' && a[k] != null).map(k => `${k}="${num(a[k])}"`).join(' ');
      out.push({ shape: `<${n.tag} ${geo}/>`, kind, transforms: t, tag: n.tag, attrs: a });
      return;
    }
    n.children.forEach(c => walk(c, kind, t));
  };
  tree.forEach(n => walk(n, null, []));
  trimFoulLines(out);
  // Wall first, then the rest, so later lines sit on top.
  const order = ['wall', 'grass', 'dirt', 'line', 'base'];
  const wrap = (inner, transforms) => transforms.reduceRight((acc, tr) => `<g transform="${tr}">${acc}</g>`, inner);
  const shapes = order.flatMap(k => out.filter(o => o.kind === k)
    .map(o => wrap(o.shape.replace(/^<(\w+)/, `<$1 class="${k}"`), o.transforms)));
  const labels = out.filter(o => o.text).map(o => {
    // Savant sets labels at 11px from their left baseline; anchor at the label's center instead so
    // the page can pick its own font size. Then nudge it out from the middle of the field so it clears
    // the wall.
    const [x, y] = place(o.transforms, 9.2, -3.9);
    const dx = x - FIELD_CENTER[0], dy = y - FIELD_CENTER[1], d = Math.hypot(dx, dy) || 1;
    return `<text x="${(x + dx / d * LABEL_PUSH).toFixed(1)}" y="${(y + dy / d * LABEL_PUSH).toFixed(1)}">${o.text}</text>`;
  });
  return shapes.join('') + labels.join('') + (north == null ? '' : compassRose(north));
}

// Most parks outline the dirt with a straight edge down each baseline, a stroke's width outside the
// foul line, so the two read as one thick line. Start each foul line where that edge ends instead.
function trimFoulLines(out) {
  const local = o => o.tag === 'line' ? [[+o.attrs.x1, +o.attrs.y1], [+o.attrs.x2, +o.attrs.y2]]
    : o.tag === 'path' ? pathPoints(o.attrs.d)[0] : null;
  const global = o => { try { return local(o)?.map(([x, y]) => place(o.transforms, x, y)); } catch { return null; } };
  const edges = out.filter(o => o.kind === 'dirt' && o.tag === 'path').flatMap(o => {
    try { return pathPoints(o.attrs.d).map(pts => pts.map(([x, y]) => place(o.transforms, x, y))); } catch { return []; }
  }).flatMap(pts => pts.slice(1).map((q, i) => [pts[i], q]));
  for (const o of out.filter(o => o.kind === 'line')) {
    const pts = global(o);
    if (!pts || pts.length < 2) continue;
    const [[ax, ay], [bx, by]] = pts;
    const len = Math.hypot(bx - ax, by - ay), ux = (bx - ax) / len, uy = (by - ay) / len;
    const along = ([x, y]) => (x - ax) * ux + (y - ay) * uy;
    const off = ([x, y]) => Math.abs((x - ax) * uy - (y - ay) * ux);
    // A long dirt edge running alongside the line (within ~5 degrees and a few units of it).
    const t = Math.max(0, ...edges.filter(([p, q]) => {
      const el = Math.hypot(q[0] - p[0], q[1] - p[1]);
      return el > 10 && Math.abs((q[0] - p[0]) * uy - (q[1] - p[1]) * ux) / el < 0.09 && off(p) < 4 && off(q) < 4;
    }).flat().map(along));
    if (t <= 0 || t >= len) continue;
    // Transforms are affine, so the same fraction of the first segment works in local coordinates.
    const [[lx, ly], [mx, my], ...rest] = local(o), f = t / len;
    const start = [lx + (mx - lx) * f, ly + (my - ly) * f].map(v => v.toFixed(1));
    o.shape = o.tag === 'line'
      ? `<line x1="${start[0]}" y1="${start[1]}" x2="${num(mx)}" y2="${num(my)}"/>`
      : `<path d="M${start.join(',')}L${[[mx, my], ...rest].map(p => p.map(v => +v.toFixed(1)).join(',')).join(' ')}"/>`;
  }
}

// Savant's compass is a ring with an "N" set outside it in the direction of true north. Returns
// that direction in degrees clockwise from straight up the page.
function northAngle(node, transforms) {
  const subpaths = [];
  const walk = (n, t) => {
    if (typeof n === 'string') return;
    t = [...t, n.attrs?.transform].filter(Boolean);
    if (n.tag === 'path') subpaths.push(...pathPoints(n.attrs.d).map(pts => pts.map(([x, y]) => place(t, x, y))));
    n.children.forEach(c => walk(c, t));
  };
  walk(node, transforms);
  const boxes = subpaths.map(pts => {
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, size: Math.max(x1 - x0, y1 - y0) };
  });
  // The ring is the biggest piece; the "N" is the small piece farthest from its center.
  const ring = boxes.reduce((a, b) => (b.size > a.size ? b : a));
  const dist = b => Math.hypot(b.cx - ring.cx, b.cy - ring.cy);
  const n = boxes.filter(b => b.size < 6).reduce((a, b) => (dist(b) > dist(a) ? b : a));
  if (dist(n) < 5) throw new Error('Could not find the N on a Savant compass');
  return Math.atan2(n.cx - ring.cx, ring.cy - n.cy) * 180 / Math.PI;
}

// Points (ends and control points, absolute) of each subpath in an SVG path. Arcs contribute only
// their end points, which is close enough for finding where a piece sits.
function pathPoints(d) {
  const tokens = d.match(/[a-zA-Z]|-?(?:\d*\.\d+|\d+\.?)(?:e[-+]?\d+)?/gi) ?? [];
  const ARGS = { m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0 };
  const subpaths = [];
  let pts = null, x = 0, y = 0, sx = 0, sy = 0, cmd = null, i = 0;
  while (i < tokens.length) {
    if (/[a-z]/i.test(tokens[i])) cmd = tokens[i++];
    const lc = cmd.toLowerCase(), rel = cmd !== cmd.toUpperCase();
    if (lc === 'z') { x = sx; y = sy; cmd = null; continue; }
    const n = tokens.slice(i, i + ARGS[lc]).map(Number);
    i += ARGS[lc];
    const ox = rel ? x : 0, oy = rel ? y : 0;
    if (lc === 'm') { pts = []; subpaths.push(pts); x = sx = n[0] + ox; y = sy = n[1] + oy; pts.push([x, y]); cmd = rel ? 'l' : 'L'; continue; }
    if (lc === 'h') x = n[0] + ox;
    else if (lc === 'v') y = n[0] + oy;
    else if (lc === 'a') { x = n[5] + ox; y = n[6] + oy; }
    else {
      for (let k = 0; k < n.length - 2; k += 2) pts.push([n[k] + ox, n[k + 1] + oy]);
      x = n.at(-2) + ox; y = n.at(-1) + oy;
    }
    pts.push([x, y]);
  }
  return subpaths;
}

// A compass in the corner where Savant keeps its own: a ring with ticks at east, south and west, a
// solid arrowhead on the ring pointing north, and an upright N just past it.
function compassRose(deg) {
  const [cx, cy] = [224, 200];
  const rad = deg * Math.PI / 180;
  const nx = (cx + Math.sin(rad) * 25).toFixed(1), ny = (cy - Math.cos(rad) * 25).toFixed(1);
  const ticks = [90, 180, 270].map(k => `<path class="tick" d="M0-8V-14" transform="rotate(${k})"/>`).join('');
  return `<g class="compass"><g transform="translate(${cx} ${cy}) rotate(${deg.toFixed(1)})">`
    + `<circle r="11"/>${ticks}<path class="arrow" d="M0-18.5 4.5-10H-4.5Z"/></g>`
    + `<text x="${nx}" y="${ny}">N</text></g>`;
}

// Apply a list of translate()/matrix() transforms (outermost first) to a point.
function place(transforms, x, y) {
  for (const tr of [...transforms].reverse()) {
    const [, fn, args] = tr.match(/^\s*(\w+)\(([^)]*)\)\s*$/) ?? [];
    const n = (args ?? '').split(/[\s,]+/).filter(Boolean).map(Number);
    const [a, b, c, d, e, f] = fn === 'translate' ? [1, 0, 0, 1, n[0], n[1] ?? 0] : fn === 'matrix' ? n : [];
    if (a === undefined) throw new Error(`Unexpected label transform: ${tr}`);
    [x, y] = [a * x + c * y + e, b * x + d * y + f];
  }
  return [x, y];
}

(async () => {
  const page = await text(PLAYER_PAGE);
  const src = page.match(/https:\/\/[^"]+\/sections\/player-update\/builds\/[^"]+\/index\.js/)?.[0];
  if (!src) throw new Error('Could not find the Savant player-page script');
  const parks = extractComponents(await text(src));
  const ids = Object.keys(parks);
  if (ids.length < 30) throw new Error(`Only found ${ids.length} parks; Savant's bundle may have changed`);
  // Some retired parks are drawn differently; only keep ones with a wall.
  const result = Object.fromEntries(ids.map(id => [id, simplify(parks[id])])
    .filter(([, svg]) => svg.includes('class="wall"')));
  fs.writeFileSync(OUT, JSON.stringify(result) + '\n');
  console.log(`Wrote ${Object.keys(result).length} parks (${Math.round(fs.statSync(OUT).size / 1024)} KB) to ${path.relative(process.cwd(), OUT)}`);
})().catch(e => { console.error(e.message); process.exit(1); });
