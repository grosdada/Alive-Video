/* Alive-Video : lecteur de pages video.
 *
 * Une page = une image de fond (page.jpg : fond, cases, affiches) + un canevas WebGL ou chaque case qui a une video
 * (ou une image) est calculee, + les traits des cadres (frames.png) par-dessus. Toutes les cases suivent l'horloge de
 * la page (lecture, pause, boucle a la duree de la page) : l'apercu montre exactement ce que donnera l'export video.
 * Mode « au survol » (lecture: "hover") : une case ne joue que sous la souris, avec son son.
 *
 * Donnees d'une page (produites par app/assemble.py) :
 *   { page: "page.jpg", frames: "frames.png", size: [W, H], fps, duration, bg: "#rrggbb", sound?: {src, vol},
 *     panels: [{ id, rect: [x0,y0,x1,y1], poly, view: {zoom, ox, oy},
 *                media?: {kind: "video", src, rev?, w, h, fps, frames, audio} | {kind: "image", src, w, h},
 *                fx?: {grade, range, loop, speed, reverse, opacity, volume, filters}, more?: [{src, vol, loop}] }] }
 *
 * Chaine d'une case (IDENTIQUE a l'export, app/effects.py et app/videoexport.py) :
 *   grille de calcul alignee sur les pixels du canevas (X0 = floor(x0 * echelle) ... ceil(x1 * echelle)) ;
 *   passe 0 : la source placee (cadrage : couverture * zoom, decalage) + couleur de base ; puis un passage par effet
 *   (flou en deux passes, reduit puis agrandi au-dela de 6 px ; halation : seuil, flou, ajout) ; chaque passe dans une
 *   texture RGBA 8 bits ; enfin la case est posee dans son polygone, opacite = melange avec la couleur du fond.
 *   Tailles des effets en millemes de la hauteur de la page : meme rendu a toute resolution.
 * Temps : image montree = sourceFrame(fx, media, t), meme regle que l'export (debut / fin, vitesse, envers, boucle).
 *
 * Cadrage anime (donnees : layout, anim, pagep) : le decoupage suit des images cles ; la page entiere (fond, cases vides,
 * videos, traits) est alors dessinee dans le canevas a chaque instant (page.jpg et frames.png caches).
 *
 * API : AlivePlayer.mount(conteneur, donnees, { base, stamp, mode: "all" | "hover", autoplay }) -> instance
 *       AlivePlayer.play(inst, bool), seek(inst, t), setMode(inst, mode), setBW(bool), setSound(bool), resetAll()
 *       Mode edition : setEditHook, addView, setFx, setView, updatePanel, setLayerVolume, setGlobalVolume, setPageSound,
 *       scrub, frameOf, setPinned, setPanelSound, capture (controle lecteur / export).
 */
(function () {
  "use strict";
  const pages = new Set();
  const renderers = new Set();
  let bwOn = false, soundOn = true, unlocked = false, ticking = false, lastTick = performance.now();
  let editHook = null;
  const LUMA = "vec3(0.2126, 0.7152, 0.0722)";
  const BLUR_DIRECT = 6, BLUR_MIN = 0.3, GRAIN_GAIN = 0.6, MAXR = 18;

  function node(tag, cls, parent) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (parent) parent.appendChild(e);
    return e;
  }
  const withStamp = (url, stamp) => stamp ? url + (url.includes("?") ? "&" : "?") + "v=" + stamp : url;
  const hexRgb = (s) => { s = String(s || "#ffffff").replace("#", ""); return [0, 2, 4].map(i => (parseInt(s.slice(i, i + 2), 16) || 0) / 255); };

  // ---------------------------------------------------------------- temps et geometrie (identiques a l'export)
  function clipRange(fx, n) {
    let a = 0, b = n - 1;
    const r = fx.range;
    if (Array.isArray(r) && r.length === 2) {
      a = Math.max(0, Math.min(n - 1, r[0] | 0));
      b = Math.max(a, Math.min(n - 1, r[1] | 0));
    }
    return [a, b];
  }
  // position dans la video a l'instant t de la case : image montree (idx), position continue dans le fichier lu
  // (copie, ou copie a l'envers), et si la case est figee sur sa derniere image
  function sourcePos(fx, m, t) {
    const n = Math.max(1, m.frames | 0), fps = m.fps || 25, [a, b] = clipRange(fx, n), span = b - a + 1;
    const pos = t * (fx.speed || 1) * fps + 1e-6;
    let k = Math.floor(pos), frac = pos - k, hold = false;
    if (fx.loop !== false) k = ((k % span) + span) % span;
    else if (k >= span - 1) { k = span - 1; frac = 0; hold = true; } else if (k < 0) { k = 0; frac = 0; }
    const rev = !!fx.reverse;
    const idx = rev ? b - k : a + k;
    const fileFrame = rev ? (n - 1 - b) + k : a + k;          // dans la copie a l'envers, l'image r = n - 1 - idx
    return { idx, hold, file: (fileFrame + (hold ? 0.5 : frac)) / fps, exact: (fileFrame + 0.5) / fps };
  }
  function placement(bb, iw, ih, view) {
    const v = view || {};
    const zoom = Math.max(1, v.zoom || 1);
    const s = Math.max(bb.w / iw, bb.h / ih) * zoom;
    const dw = iw * s, dh = ih * s;
    const mx = (dw - bb.w) / (2 * bb.w), my = (dh - bb.h) / (2 * bb.h);
    const ox = Math.max(-mx, Math.min(mx, v.ox || 0)), oy = Math.max(-my, Math.min(my, v.oy || 0));
    return { x: bb.x0 + bb.w / 2 - dw / 2 + ox * bb.w, y: bb.y0 + bb.h / 2 - dh / 2 + oy * bb.h, w: dw, h: dh };
  }
  function bboxOf(p) { const [x0, y0, x1, y1] = p.rect; return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 }; }
  function panelSeed(id) {
    let s = 0;
    for (const ch of String(id)) s = (s * 31 + ch.charCodeAt(0)) % 1000003;
    return s % 997;
  }
  function grainOffset(k, seed) {
    const fr = (x) => x - Math.floor(x);
    return [fr(k * 0.7548776662466927 + seed * 0.3819660112501051) * 256, fr(k * 0.5698402909980532 + seed * 0.6180339887498949) * 256];
  }

  // ---------------------------------------------------------------- cadrage anime (« Animate framing »)
  // Le decoupage de la page bouge avec le temps : chaque bout de trait a sa piste d'images cles. Memes calculs que
  // app/web/js/geometry.js (editeur) et app/geometry.py (export video) : decoupe, courbes, traits en onglet.
  function ease(e, u) {                    // memes courbes que app/geometry.py et app/web/js/geometry.js
    if (e === "linear") return u;
    if (e === "in") return u ** 3;
    if (e === "out") return 1 - (1 - u) ** 3;
    if (e === "in2") return u ** 5;
    if (e === "out2") return 1 - (1 - u) ** 5;
    if (e === "ease2") return u < 0.5 ? 16 * u ** 5 : 1 - (-2 * u + 2) ** 5 / 2;
    if (e === "hold") return 0;
    return u < 0.5 ? 4 * u ** 3 : 1 - (-2 * u + 2) ** 3 / 2;
  }
  function trackValue(keys, t, fb) {
    if (!keys || !keys.length) return fb;
    if (t <= keys[0].t) return keys[0].v;
    for (let i = 0; i < keys.length - 1; i++) {
      const k0 = keys[i], k1 = keys[i + 1];
      if (t < k1.t) return k0.v + (k1.v - k0.v) * ease(k0.e, (t - k0.t) / Math.max(1e-9, k1.t - k0.t));
    }
    return keys[keys.length - 1].v;
  }
  const hasAnim = (a) => !!a && Object.values(a.tracks || {}).some(k => k && k.length);
  // style de page anime : couleurs interpolees composante par composante (= colorValue de geometry.js)
  function colorValue(keys, t, fb) {
    if (!keys || !keys.length) return hexRgb(fb);
    if (t <= keys[0].t) return hexRgb(keys[0].v);
    for (let i = 0; i < keys.length - 1; i++) {
      const k0 = keys[i], k1 = keys[i + 1];
      if (t < k1.t) {
        const e = ease(k0.e, (t - k0.t) / Math.max(1e-9, k1.t - k0.t)), a = hexRgb(k0.v), b = hexRgb(k1.v);
        return a.map((x, j) => x + (b[j] - x) * e);
      }
    }
    return hexRgb(keys[keys.length - 1].v);
  }
  function pageAt(pg, anim, t) {
    const T = (anim && anim.tracks) || {}, out = Object.assign({}, pg);
    for (const k of ["strokeWidth", "gutter", "margin"]) out[k] = trackValue(T["page." + k], t, +pg[k] || 0);
    out.rgb = { bg: colorValue(T["page.bg"], t, pg.bg || "#ffffff"), fill: colorValue(T["page.fill"], t, pg.fill || "#ffffff"),
                stroke: colorValue(T["page.stroke"], t, pg.stroke || "#111111") };
    return out;
  }
  function layoutAt(layout, anim, t) {
    const T = anim.tracks;
    const walk = (n) => n.t === "leaf" ? n : Object.assign({}, n, {
      a: trackValue(T[n.id + ".a"], t, n.a), b: trackValue(T[n.id + ".b"], t, n.b), c: [walk(n.c[0]), walk(n.c[1])] });
    return walk(layout);
  }
  function gbbox(poly) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of poly) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
  }
  function clipHalf(poly, f) {
    const out = [];
    for (let i = 0; i < poly.length; i++) {
      const P = poly[i], Q = poly[(i + 1) % poly.length], fp = f(P), fq = f(Q);
      if (fp <= 0) out.push(P);
      if ((fp < 0 && fq > 0) || (fp > 0 && fq < 0)) { const t = fp / (fp - fq); out.push([P[0] + (Q[0] - P[0]) * t, P[1] + (Q[1] - P[1]) * t]); }
    }
    return out;
  }
  // cases de la page : { id: polygone } (les cases refermees n'y sont pas)
  function computeLayout(pg, layout) {
    const m = +pg.margin, W = +pg.width, H = +pg.height, g = +pg.gutter, out = {};
    (function walk(node, poly) {
      if (!node) return;
      if (node.t === "leaf") { if (poly.length >= 3) out[node.id] = poly; return; }
      if (poly.length < 3) { walk(node.c[0], []); walk(node.c[1], []); return; }
      const bb = gbbox(poly);
      let P, Q;
      if (node.dir === "h") { P = [bb.x0, bb.y0 + node.a * bb.h]; Q = [bb.x1, bb.y0 + node.b * bb.h]; }
      else { P = [bb.x0 + node.a * bb.w, bb.y0]; Q = [bb.x0 + node.b * bb.w, bb.y1]; }
      const dx = Q[0] - P[0], dy = Q[1] - P[1], L = Math.hypot(dx, dy) || 1;
      let n = [-dy / L, dx / L];
      if (node.dir === "h" && n[1] < 0) n = [-n[0], -n[1]];
      if (node.dir === "v" && n[0] < 0) n = [-n[0], -n[1]];
      const f = (X) => n[0] * (X[0] - P[0]) + n[1] * (X[1] - P[1]);
      const A = clipHalf(poly, (X) => f(X) + g / 2), B = clipHalf(poly, (X) => -f(X) + g / 2);
      walk(node.c[0], A.length >= 3 ? A : []);
      walk(node.c[1], B.length >= 3 ? B : []);
    })(layout, [[m, m], [W - m, m], [W - m, H - m], [m, H - m]]);
    return out;
  }
  // polygone elargi depuis son centre (la video passe sous le trait), arrondi au dixieme comme app/geometry.py grow
  function grow(poly, px) {
    let cx = 0, cy = 0;
    for (const [x, y] of poly) { cx += x; cy += y; }
    cx /= poly.length; cy /= poly.length;
    return poly.map(([x, y]) => {
      const dx = x - cx, dy = y - cy, d = Math.hypot(dx, dy) || 1;
      return [Math.round((x + dx / d * px) * 10) / 10, Math.round((y + dy / d * px) * 10) / 10];
    });
  }
  // polygone convexe decale de d vers l'exterieur (coins en onglet) : un trait = decale(+w/2) moins decale(-w/2)
  function offsetPoly(poly, d) {
    const n = poly.length;
    let s2 = 0;
    for (let i = 0; i < n; i++) { const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % n]; s2 += x1 * y2 - x2 * y1; }
    const sign = s2 > 0 ? 1 : -1, lines = [];
    for (let i = 0; i < n; i++) {
      const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % n], dx = x2 - x1, dy = y2 - y1, L = Math.hypot(dx, dy) || 1;
      lines.push([[x1 + dy / L * sign * d, y1 - dx / L * sign * d], [dx, dy]]);
    }
    return lines.map((cur, i) => {
      const [p, r] = lines[(i - 1 + n) % n], [q, s] = cur, den = r[0] * s[1] - r[1] * s[0];
      if (Math.abs(den) < 1e-9) return [q[0], q[1]];
      const t = ((q[0] - p[0]) * s[1] - (q[1] - p[1]) * s[0]) / den;
      return [p[0] + r[0] * t, p[1] + r[1] * t];
    });
  }
  // la page a l'instant de son horloge : cases (boite, polygone elargi), cases vides, traits
  function updateGeometry(inst) {
    if (!inst.anim) return;
    const M = inst.data, pg = pageAt(M.pagep, M.anim, inst.t), sw = Math.max(0, +pg.strokeWidth || 0);
    const polys = computeLayout(pg, layoutAt(M.layout, M.anim, inst.t));
    const key = JSON.stringify([polys, pg.rgb, sw]);
    if (key === inst.geoKey) return;
    inst.geoKey = key;
    inst.exact = polys;
    inst.bg = pg.rgb.bg; inst.fill = pg.rgb.fill; inst.strokeRgb = pg.rgb.stroke;   // fond, cases vides, traits
    inst.strokes = sw > 0 ? Object.values(polys).map(p => [offsetPoly(p, sw / 2), offsetPoly(p, -sw / 2)]) : [];
    for (const st of inst.panels) {
      const poly = polys[st.p.id];
      st.live = !!poly;
      if (poly) { const b = gbbox(poly); st.p.rect = [b.x0, b.y0, b.x1, b.y1]; st.p.poly = grow(poly, sw / 2 + 1); }
      placeEl(st);
    }
    for (const R of renderers) if (R.owner === inst || R.items.size) R.dirty = true;
  }
  // l'element de la case (gestes, survol) suit sa forme
  function placeEl(st) {
    const el = st.el, [PW, PH] = st.inst.data.size, [x0, y0, x1, y1] = st.p.rect;
    el.hidden = st.live === false;
    if (st.live === false) return;
    Object.assign(el.style, { left: x0 / PW * 100 + "%", top: y0 / PH * 100 + "%",
                              width: (x1 - x0) / PW * 100 + "%", height: (y1 - y0) / PH * 100 + "%" });
    if (st.p.poly) {
      const w = Math.max(1e-6, x1 - x0), hh = Math.max(1e-6, y1 - y0);
      el.style.clipPath = `polygon(${st.p.poly.map(([x, y]) => `${(x - x0) / w * 100}% ${(y - y0) / hh * 100}%`).join(", ")})`;
    }
  }

  // ---------------------------------------------------------------- une page
  function mount(container, M, opts) {
    opts = opts || {};
    const base = opts.base || "";
    const [PW, PH] = M.size;
    const pageEl = node("div", "ac-page", container);
    pageEl.classList.toggle("bw", bwOn);
    pageEl.classList.toggle("ac-editing", !!editHook);
    pageEl.style.aspectRatio = PW + " / " + PH;
    pageEl.style.setProperty("--ac-ratio", String(PW / PH));
    pageEl.style.background = M.bg || "#fff";
    const bg = node("img", "ac-bg", pageEl);
    bg.src = withStamp(base + M.page, opts.stamp); bg.alt = opts.alt || ""; bg.draggable = false;
    const canvas = node("canvas", "ac-canvas", pageEl);
    const inst = { pageEl, canvas, panels: [], data: M, base, stamp: opts.stamp || "", fps: M.fps || 30,
                   duration: Math.max(0.2, M.duration || 5), t: 0, playing: opts.autoplay !== false,
                   mode: opts.mode || "all", bg: hexRgb(M.bg), sounds: [],
                   anim: !!(M.layout && M.pagep && hasAnim(M.anim)) };
    for (const p of M.panels) makePanel(inst, p);
    if (M.frames) {
      const fr = node("img", "ac-frames", pageEl);
      fr.src = withStamp(base + M.frames, opts.stamp); fr.alt = ""; fr.draggable = false;
    }
    inst.R = makeRenderer(canvas, "page", inst);
    if (inst.R) {
      for (const st of inst.panels) if (st.kind) inst.R.add(st);
      if (inst.anim) { pageEl.classList.add("ac-anim"); updateGeometry(inst); }   // le canevas dessine toute la page
      const ro = new ResizeObserver(() => inst.R && inst.R.fit());
      ro.observe(pageEl);
      inst.ro = ro;
    } else canvas.remove();
    if (M.sound) inst.music = makeSound(withStamp(base + M.sound.src, inst.stamp), M.sound.vol ?? 0.7, true);
    inst.destroy = () => destroyPage(inst);
    inst.reset = () => seek(inst, 0);
    pages.add(inst);
    startTick();
    return inst;
  }

  function makePanel(inst, p) {
    const el = node("div", "ac-panel", inst.pageEl);
    const st = { p, inst, el, kind: p.media ? p.media.kind : null, serial: 0, fxv: 1, clock: 0, over: false,
                 pinned: false, pinSound: false, scrubFrame: null, sounds: [], views: [] };
    placeEl(st);
    if (!st.kind) el.classList.add("empty");
    loadMedia(st);
    buildSounds(st);
    el.addEventListener("pointerenter", (e) => { if (e.pointerType !== "touch") setOver(st, true); });
    el.addEventListener("pointerleave", (e) => { if (e.pointerType !== "touch") setOver(st, false); });
    el.addEventListener("pointerdown", (e) => {
      if (e.pointerType !== "touch" || inst.mode !== "hover") return;
      for (const i2 of pages) for (const o of i2.panels) if (o !== st) setOver(o, false);
      setOver(st, !st.over);
    });
    el.addEventListener("click", () => { if (editHook) editHook(st); });
    el.addEventListener("dblclick", () => { if (!editHook && st.kind) openLightbox(st); });
    inst.panels.push(st);
  }

  function setOver(st, on) {
    st.over = on;
    for (const S of st.sounds) S.want = null;
  }

  // ---------------------------------------------------------------- medias (video cachee : sa texture est dessinee)
  function loadMedia(st) {
    const m = st.p.media;
    if (st.v) { st.v.pause(); st.v.removeAttribute("src"); st.v.load(); st.v.remove(); st.v = null; }
    st.img = null; st.ready = false;
    if (!m) { st.kind = null; return; }
    st.kind = m.kind;
    const fx = st.p.fx || {};
    if (m.kind === "image") {
      const im = new Image();
      im.onload = () => { st.img = im; st.ready = true; st.serial++; };
      im.src = withStamp(st.inst.base + m.src, st.inst.stamp);
      return;
    }
    const rev = !!(fx.reverse && m.rev);
    const v = document.createElement("video");
    v.className = "ac-src";
    v.muted = true; v.playsInline = true; v.preload = "auto"; v.setAttribute("playsinline", "");
    v.src = withStamp(st.inst.base + (rev ? m.rev : m.src), st.inst.stamp);
    st.el.appendChild(v);
    st.v = v; st.rev = rev;
    const bump = () => { st.serial++; };
    v.addEventListener("loadeddata", () => { st.ready = true; bump(); });
    v.addEventListener("seeked", bump);
    if ("requestVideoFrameCallback" in v) {
      const cb = () => { if (st.v !== v) return; bump(); v.requestVideoFrameCallback(cb); };
      v.requestVideoFrameCallback(cb);
      st.rvfc = true;
    }
  }

  function clockOf(st) { return st.inst.mode === "hover" ? st.clock : st.inst.t; }
  function active(st) {
    const inst = st.inst;
    if (!inst.playing) return false;
    return inst.mode !== "hover" || st.over || st.pinned || lb.st === st;
  }

  // la video suit l'horloge : lecture native (son compris) recalee si elle derive ; en pause, l'image exacte
  function syncVideo(st) {
    const v = st.v, m = st.p.media, fx = st.p.fx || {};
    if (!v || !st.ready) return;
    const wantRev = !!(fx.reverse && m.rev);
    if (wantRev !== st.rev) { loadMedia(st); return; }
    const P = sourcePos(fx, m, clockOf(st));
    st.idx = P.idx;
    const playing = active(st) && !P.hold && st.scrubFrame == null;
    const fps = m.fps || 25;
    if (!playing) {
      if (!v.paused) v.pause();
      let target = P.exact;
      if (st.scrubFrame != null) {
        const n = m.frames | 0, f = Math.max(0, Math.min(n - 1, st.scrubFrame));
        target = ((st.rev ? n - 1 - f : f) + 0.5) / fps;
        st.idx = f;
      }
      if (Math.abs(v.currentTime - target) > 0.45 / fps && !v.seeking) v.currentTime = target;
    } else {
      const rate = fx.speed || 1;
      if (v.playbackRate !== rate) v.playbackRate = rate;
      if (v.paused || v.ended) v.play().catch(() => {});
      if (Math.abs(v.currentTime - P.file) > 0.25 && !v.seeking) v.currentTime = P.file;
      if (!st.rvfc) st.serial++;
    }
    const audible = playing && unlocked && soundOn && m.audio && (st.inst.mode !== "hover" || st.over || st.pinSound);
    const vol = Math.max(0, Math.min(1, fx.volume ?? 1));
    if (v.muted !== !audible) v.muted = !audible;
    if (Math.abs(v.volume - vol) > 1e-3) v.volume = vol;
  }

  // ---------------------------------------------------------------- sons ajoutes et musique de la page
  function makeSound(src, vol, loop) {
    const a = new Audio(src);
    a.preload = "auto"; a.loop = false;
    return { a, vol: Math.max(0, Math.min(1, vol)), loop, want: null };
  }
  function buildSounds(st) {
    for (const S of st.sounds) { S.a.pause(); S.a.src = ""; }
    st.sounds = (st.p.more || []).map((x, i) => Object.assign(makeSound(withStamp(st.inst.base + x.src, st.inst.stamp), x.vol ?? 0.8,
                                                                         x.loop !== false), { key: "more" + i }));
  }
  // un son suit une horloge : en boucle (t modulo sa duree) ou une fois depuis 0
  function syncSound(S, t, on) {
    const a = S.a, d = a.duration;
    if (!on || !d || !isFinite(d)) { if (!a.paused) a.pause(); return; }
    let want = t;
    if (S.loop) want = t % d;
    else if (t >= d) { if (!a.paused) a.pause(); return; }
    if (a.paused) { a.currentTime = want; a.play().catch(() => {}); }
    else if (Math.abs(a.currentTime - want) > 0.3) a.currentTime = want;
    a.volume = S.vol;
  }

  // ---------------------------------------------------------------- horloge
  function startTick() {
    if (ticking) return;
    ticking = true; lastTick = performance.now();
    requestAnimationFrame(tick);
  }
  function tick(now) {
    const dt = Math.min(0.5, (now - lastTick) / 1000); lastTick = now;
    for (const inst of pages) stepPage(inst, dt);
    for (const R of renderers) R.draw();
    if (pages.size || renderers.size) requestAnimationFrame(tick); else ticking = false;
  }
  function stepPage(inst, dt) {
    if (inst.playing) inst.t = (inst.t + dt) % inst.duration;
    updateGeometry(inst);
    for (const st of inst.panels) {
      if (inst.mode === "hover" && active(st)) st.clock = (st.clock + dt) % inst.duration;
      if (st.kind === "video") syncVideo(st);
      const on = unlocked && soundOn && active(st) && (inst.mode !== "hover" || st.over || st.pinSound);
      for (const S of st.sounds) syncSound(S, clockOf(st), on);
    }
    if (inst.music) syncSound(inst.music, inst.t, unlocked && soundOn && inst.playing);
  }
  function play(inst, on) { inst.playing = !!on; }
  function seek(inst, t) {
    inst.t = ((t % inst.duration) + inst.duration) % inst.duration;
    for (const st of inst.panels) { st.clock = inst.t; st.scrubFrame = null; }
    updateGeometry(inst);
  }
  function setMode(inst, mode) {
    inst.mode = mode === "hover" ? "hover" : "all";
    for (const st of inst.panels) st.clock = inst.t;
  }

  function destroyPage(inst) {
    if (lb.st && lb.st.inst === inst) closeLightbox();
    if (inst.ro) inst.ro.disconnect();
    if (inst.R) inst.R.destroy();
    for (const st of inst.panels) {
      for (const vw of st.views.slice()) vw.remove();
      if (st.v) { st.v.pause(); st.v.removeAttribute("src"); st.v.load(); }
      for (const S of st.sounds) { S.a.pause(); S.a.src = ""; }
    }
    if (inst.music) { inst.music.a.pause(); inst.music.a.src = ""; }
    inst.pageEl.remove();
    pages.delete(inst);
  }

  // iOS / Android et regle des navigateurs : le son n'est permis qu'apres un premier geste
  document.addEventListener("pointerdown", () => {
    if (unlocked) return;
    unlocked = true;
    document.dispatchEvent(new Event("alive-unlocked"));
  }, { capture: true });

  // ---------------------------------------------------------------- WebGL : programmes
  const VS_QUAD = "attribute vec2 aP; varying vec2 v; void main(){ v = aP * 0.5 + 0.5; gl_Position = vec4(aP, 0.0, 1.0); }";
  const VS_POLY = "attribute vec2 aP; attribute vec2 aT; varying vec2 v; void main(){ v = aT; gl_Position = vec4(aP, 0.0, 1.0); }";
  const VS_SOLID = "attribute vec2 aP; varying vec2 v; void main(){ v = vec2(0.0); gl_Position = vec4(aP, 0.0, 1.0); }";
  const HEAD = `#ifdef GL_FRAGMENT_PRECISION_HIGH
    precision highp float;
    #else
    precision mediump float;
    #endif
    varying vec2 v; uniform sampler2D uT;
    float luma(vec3 c){ return dot(c, ${LUMA}); }
    // couleur : gain, contraste autour du gris, saturation, temperature, vert <-> magenta, teinte (= app/effects.py)
    vec3 grade(vec3 c, vec4 a, vec2 b){
      c *= a.x;
      c = (c - 0.5) * a.y + 0.5;
      float l = luma(c);
      c = mix(vec3(l), c, a.z);
      c += vec3(0.07, 0.0, -0.07) * a.w + vec3(0.05, -0.06, 0.05) * b.x;
      if (b.y != 0.0) {
        float r = radians(b.y), co = cos(r), si = sin(r);
        vec3 k = vec3(0.57735026919);
        c = c * co + cross(k, c) * si + k * dot(k, c) * (1.0 - co);
      }
      return clamp(c, 0.0, 1.0);
    }
  `;
  const FS = {
    // passe 0 : source placee dans la case + couleur de base
    src: `uniform vec2 uS, uO; uniform vec4 uA; uniform vec2 uB;
      void main(){ gl_FragColor = vec4(grade(texture2D(uT, v * uS + uO).rgb, uA, uB), 1.0); }`,
    copy: `void main(){ gl_FragColor = vec4(texture2D(uT, v).rgb, 1.0); }`,
    colour: `uniform vec4 uA; uniform vec2 uB;
      void main(){ gl_FragColor = vec4(grade(texture2D(uT, v).rgb, uA, uB), 1.0); }`,
    mono: `uniform float uMode, uAmt; uniform vec3 uCol;
      void main(){
        vec3 c = texture2D(uT, v).rgb; float l = luma(c); vec3 m;
        if (uMode < 0.5) m = vec3(l);
        else if (uMode < 1.5) m = clamp(vec3(dot(c, vec3(0.393, 0.769, 0.189)), dot(c, vec3(0.349, 0.686, 0.168)),
                                             dot(c, vec3(0.272, 0.534, 0.131))), 0.0, 1.0);
        else m = l < 0.5 ? uCol * (2.0 * l) : uCol + (1.0 - uCol) * (2.0 * l - 1.0);
        gl_FragColor = vec4(c + (m - c) * uAmt, 1.0);
      }`,
    vignette: `uniform float uAmt, uSize, uSoft;
      void main(){
        float d = length((v - 0.5) * 2.0) / 1.41421356237;
        float x = clamp((d - uSize) / uSoft, 0.0, 1.0);
        gl_FragColor = vec4(texture2D(uT, v).rgb * (1.0 - uAmt * x * x * (3.0 - 2.0 * x)), 1.0);
      }`,
    grain: `uniform sampler2D uG; uniform vec2 uSc, uOff; uniform float uAmt;
      void main(){
        vec2 q = v * uSc + uOff;
        float g = texture2D(uG, q / 256.0).r - 0.5;
        gl_FragColor = vec4(texture2D(uT, v).rgb + g * uAmt, 1.0);
      }`,
    blur: `uniform vec2 uD; uniform float uR, uS2;
      void main(){
        vec3 s = vec3(0.0); float ws = 0.0;
        for (int i = -${MAXR}; i <= ${MAXR}; i++) {
          float fi = float(i);
          if (abs(fi) > uR) continue;
          float w = exp(-fi * fi / uS2);
          s += w * texture2D(uT, v + uD * fi).rgb; ws += w;
        }
        gl_FragColor = vec4(s / ws, 1.0);
      }`,
    thresh: `uniform float uThr;
      void main(){ float h = clamp((luma(texture2D(uT, v).rgb) - uThr) / (1.0 - uThr), 0.0, 1.0); gl_FragColor = vec4(vec3(h), 1.0); }`,
    halo: `uniform sampler2D uG; uniform vec3 uCol; uniform float uAmt;
      void main(){ gl_FragColor = vec4(texture2D(uT, v).rgb + uCol * texture2D(uG, v).r * uAmt, 1.0); }`,
    chroma: `uniform float uK;
      void main(){
        vec2 d = v - 0.5;
        gl_FragColor = vec4(texture2D(uT, 0.5 + d * (1.0 + uK)).r, texture2D(uT, v).g, texture2D(uT, 0.5 + d * (1.0 - uK)).b, 1.0);
      }`,
    // page animee : cases vides (blanc) et traits, en couleur unie
    solid: `uniform vec3 uC; void main(){ gl_FragColor = vec4(uC, 1.0); }`,
    // pose de la case dans la page : opacite = melange avec la couleur du fond
    final: `uniform float uOp; uniform vec3 uBg;
      void main(){ gl_FragColor = vec4(mix(uBg, texture2D(uT, v).rgb, uOp), 1.0); }`,
  };

  let grainImg = null;
  function grainImage() {
    if (!grainImg) {
      grainImg = new Image();
      grainImg.src = (window.ALIVE_GRAIN_URL || "grain.png");
    }
    return grainImg;
  }

  function makeRenderer(canvas, kind, owner) {
    const attrs = { antialias: kind === "page", premultipliedAlpha: false, alpha: true, preserveDrawingBuffer: false };
    let gl = canvas.getContext("webgl2", attrs), gl2 = !!gl;
    if (!gl) gl = canvas.getContext("webgl", attrs) || canvas.getContext("experimental-webgl", attrs);
    if (!gl) return null;
    const compile = (vs, fs) => {
      const sh = (type, src) => { const o = gl.createShader(type); gl.shaderSource(o, src); gl.compileShader(o);
                                  if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) console.warn(gl.getShaderInfoLog(o)); return o; };
      const p = gl.createProgram();
      gl.attachShader(p, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, HEAD + fs));
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) { console.warn(gl.getProgramInfoLog(p)); return null; }
      const u = {}, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
      for (let i = 0; i < n; i++) { const a = gl.getActiveUniform(p, i); u[a.name] = gl.getUniformLocation(p, a.name); }
      return { p, u, aP: gl.getAttribLocation(p, "aP"), aT: gl.getAttribLocation(p, "aT") };
    };
    const P = {};
    for (const [k, fs] of Object.entries(FS)) {
      P[k] = compile(k === "final" ? VS_POLY : k === "solid" ? VS_SOLID : VS_QUAD, fs);
      if (!P[k]) return null;
    }
    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    const polyBuf = gl.createBuffer();
    const R = { gl, gl2, canvas, kind, owner, items: new Map(), dirty: true };

    function texture(filter, wrap) {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter || gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap || gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap || gl.CLAMP_TO_EDGE);
      return t;
    }
    // textures de calcul d'une case (RGBA 8 bits), gardees par taille et par role
    function target(it, key, w, h) {
      let o = it.pool[key];
      if (o && o.w === w && o.h === h) return o;
      if (o) { gl.deleteTexture(o.t); gl.deleteFramebuffer(o.fb); }
      const t = texture();
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
      o = it.pool[key] = { t, fb, w, h };
      return o;
    }
    function pass(prog, src, dst, set) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fb);
      gl.viewport(0, 0, dst.w, dst.h);
      gl.useProgram(prog.p);
      gl.bindBuffer(gl.ARRAY_BUFFER, quad);
      gl.enableVertexAttribArray(prog.aP);
      gl.vertexAttribPointer(prog.aP, 2, gl.FLOAT, false, 0, 0);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, src.t);
      if (prog.u.uT) gl.uniform1i(prog.u.uT, 0);
      if (set) set(prog.u);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      return dst;
    }
    // flou gaussien separable ; au-dela de 6 px, sur une image reduite (meme regle que app/effects.py : blur)
    function blur(it, src, sigma, tag) {
      if (sigma < BLUR_MIN) return src;
      const w = src.w, h = src.h;
      const f = sigma > BLUR_DIRECT ? Math.ceil(sigma / BLUR_DIRECT) : 1, s = sigma / f;
      let low = src;
      if (f > 1) low = pass(P.copy, src, target(it, tag + "l0", Math.max(1, Math.ceil(w / f)), Math.max(1, Math.ceil(h / f))));
      const r = Math.ceil(3 * s), s2 = 2 * s * s;
      const hpass = pass(P.blur, low, target(it, tag + "l1", low.w, low.h), (u) => {
        gl.uniform2f(u.uD, 1 / low.w, 0); gl.uniform1f(u.uR, r); gl.uniform1f(u.uS2, s2); });
      const vpass = pass(P.blur, hpass, target(it, tag + "l2", low.w, low.h), (u) => {
        gl.uniform2f(u.uD, 0, 1 / low.h); gl.uniform1f(u.uR, r); gl.uniform1f(u.uS2, s2); });
      return f > 1 ? pass(P.copy, vpass, target(it, tag + "up", w, h)) : vpass;
    }
    let gTex = null;
    function grainTex() {
      if (gTex) return gTex;
      const im = grainImage();
      if (!im.complete || !im.naturalWidth) return null;
      gTex = texture(gl.LINEAR, gl.REPEAT);
      gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, im);
      gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.BROWSER_DEFAULT_WEBGL);
      return gTex;
    }

    // grille d'une case : alignee sur les pixels du canevas (page) ou tout le canevas (vue agrandie de l'editeur)
    function layout(it) {
      const st = it.st, bb = bboxOf(st.p), [PW, PH] = st.inst.data.size;
      if (kind === "page") {
        const sx = canvas.width / PW, sy = canvas.height / PH;
        const X0 = Math.floor(bb.x0 * sx), Y0 = Math.floor(bb.y0 * sy);
        return { sx, sy, X0, Y0, w: Math.max(1, Math.ceil(bb.x1 * sx) - X0), h: Math.max(1, Math.ceil(bb.y1 * sy) - Y0), PH };
      }
      const sx = canvas.width / bb.w, sy = canvas.height / bb.h;
      return { sx, sy, X0: bb.x0 * sx, Y0: bb.y0 * sy, w: canvas.width, h: canvas.height, PH };
    }

    function upload(it) {
      const st = it.st, src = st.kind === "image" ? st.img : st.v;
      if (!src) return false;
      if (!it.media) it.media = texture(gl2 ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
      gl.bindTexture(gl.TEXTURE_2D, it.media);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src); }
      catch (e) { return false; }
      if (gl2) gl.generateMipmap(gl.TEXTURE_2D);
      it.mediaSize = st.kind === "image" ? [src.naturalWidth, src.naturalHeight] : [src.videoWidth, src.videoHeight];
      return true;
    }

    function chain(it, L) {
      const st = it.st, m = st.p.media, fx = st.p.fx || {}, bb = bboxOf(st.p);
      const pl = placement(bb, m.w || it.mediaSize[0], m.h || it.mediaSize[1], st.p.view);
      const g = fx.grade || {};
      const A = target(it, "A", L.w, L.h), B = target(it, "B", L.w, L.h);
      let cur = pass(P.src, { t: it.media }, A, (u) => {
        gl.uniform2f(u.uS, L.w / (L.sx * pl.w), L.h / (L.sy * pl.h));
        gl.uniform2f(u.uO, (L.X0 / L.sx - pl.x) / pl.w, (L.Y0 / L.sy - pl.y) / pl.h);
        gl.uniform4f(u.uA, g.bright ?? 1, g.contrast ?? 1, g.sat ?? 1, g.temp || 0);
        gl.uniform2f(u.uB, 0, g.hue || 0);
      });
      const other = () => (cur === A ? B : A);
      const unit = L.sy * L.PH / 1000;                      // pixels par unite (millieme de la hauteur de page)
      const units = [L.w / L.sx / L.PH * 1000, L.h / L.sy / L.PH * 1000];
      for (const f of fx.filters || []) {
        if (f.on === false) continue;
        if (f.type === "colour") {
          cur = pass(P.colour, cur, other(), (u) => {
            gl.uniform4f(u.uA, Math.pow(2, f.exposure), f.contrast, f.saturation, f.temperature);
            gl.uniform2f(u.uB, f.tint, f.hue); });
        } else if (f.type === "mono") {
          const col = hexRgb(f.color);
          cur = pass(P.mono, cur, other(), (u) => {
            gl.uniform1f(u.uMode, f.mode === "bw" ? 0 : f.mode === "sepia" ? 1 : 2); gl.uniform1f(u.uAmt, f.amount);
            gl.uniform3f(u.uCol, col[0], col[1], col[2]); });
        } else if (f.type === "vignette") {
          cur = pass(P.vignette, cur, other(), (u) => {
            gl.uniform1f(u.uAmt, f.amount); gl.uniform1f(u.uSize, f.size); gl.uniform1f(u.uSoft, f.softness); });
        } else if (f.type === "grain") {
          const gt = grainTex();
          if (!gt || !(f.amount > 0)) continue;
          const k = f.animated === false ? 0 : Math.floor(clockOf(st) * st.inst.fps + 1e-6);
          const off = grainOffset(k, panelSeed(st.p.id)), size = Math.max(0.05, f.size);
          cur = pass(P.grain, cur, other(), (u) => {
            gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, gt); gl.uniform1i(u.uG, 1);
            gl.uniform2f(u.uSc, units[0] / size, units[1] / size); gl.uniform2f(u.uOff, off[0], off[1]);
            gl.uniform1f(u.uAmt, f.amount * GRAIN_GAIN); });
        } else if (f.type === "blur") {
          const out = blur(it, cur, f.amount * unit, "b");
          if (out !== cur) cur = pass(P.copy, out, other());
        } else if (f.type === "halation") {
          const thr = Math.min(0.95, f.threshold), col = hexRgb(f.color);
          const hl = pass(P.thresh, cur, target(it, "H", L.w, L.h), (u) => gl.uniform1f(u.uThr, thr));
          const glow = blur(it, hl, f.radius * unit, "h");
          cur = pass(P.halo, cur, other(), (u) => {
            gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, glow.t); gl.uniform1i(u.uG, 1);
            gl.uniform3f(u.uCol, col[0], col[1], col[2]); gl.uniform1f(u.uAmt, f.amount * 2); });
        } else if (f.type === "chroma") {
          if (!(f.amount > 0)) continue;
          const k = f.amount / (0.5 * Math.hypot(units[0], units[1]));
          cur = pass(P.chroma, cur, other(), (u) => gl.uniform1f(u.uK, k));
        }
      }
      it.out = cur;
    }

    R.add = (st) => {
      const it = { st, pool: {}, media: null, key: "", out: null };
      R.items.set(st, it);
      R.dirty = true;
      return it;
    };
    R.remove = (st) => {
      const it = R.items.get(st);
      if (!it) return;
      for (const o of Object.values(it.pool)) { gl.deleteTexture(o.t); gl.deleteFramebuffer(o.fb); }
      if (it.media) gl.deleteTexture(it.media);
      R.items.delete(st);
      R.dirty = true;
    };
    R.fit = (w, h) => {
      const host = kind === "page" ? owner.pageEl : canvas.parentNode;
      if (!host) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      let W = w || Math.round(host.clientWidth * dpr), H = h || Math.round(host.clientHeight * dpr);
      const k = Math.min(1, 4096 / Math.max(W, H, 1));
      W = Math.max(1, Math.round(W * k)); H = Math.max(1, Math.round(H * k));
      if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; R.dirty = true; }
    };
    R.draw = (force) => {
      if (gl.isContextLost()) return;
      let changed = false;
      for (const it of R.items.values()) {
        const st = it.st;
        if (!st.ready || !st.kind || st.live === false) continue;
        const L = layout(it), fx = st.p.fx || {};
        const grainOn = (fx.filters || []).some(f => f.on !== false && f.type === "grain" && f.animated !== false && f.amount > 0);
        const key = [st.serial, st.fxv, L.w, L.h, L.X0, L.Y0, st.p.rect.join(","), grainOn ? Math.floor(clockOf(st) * st.inst.fps + 1e-6) : 0,
                     grainImage().complete].join("|");
        if (key === it.key && !force) continue;
        if (it.serial !== st.serial || !it.media) { if (!upload(it)) continue; it.serial = st.serial; }
        chain(it, L);
        it.key = key; it.L = L;
        changed = true;
      }
      if (!changed && !R.dirty && !force) return;
      R.dirty = false;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, canvas.width, canvas.height);
      const animPage = kind === "page" && owner.anim, [PW0, PH0] = kind === "page" ? owner.data.size : [1, 1];
      const toClip = (pts) => pts.map(([x, y]) => [x / PW0 * 2 - 1, 1 - y / PH0 * 2]);
      const solid = (tris, rgb) => {                // triangles en couleur unie (coordonnees de page)
        if (!tris.length) return;
        gl.useProgram(P.solid.p);
        gl.bindBuffer(gl.ARRAY_BUFFER, polyBuf);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(tris), gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(P.solid.aP); gl.vertexAttribPointer(P.solid.aP, 2, gl.FLOAT, false, 8, 0);
        gl.uniform3f(P.solid.u.uC, rgb[0], rgb[1], rgb[2]);
        gl.drawArrays(gl.TRIANGLES, 0, tris.length / 2);
      };
      const fan = (pts) => { const V = toClip(pts), out = []; for (let i = 1; i < V.length - 1; i++) out.push(...V[0], ...V[i], ...V[i + 1]); return out; };
      if (animPage) {                               // fond, puis cases vides en blanc (comme page.jpg)
        const bg = owner.bg;
        gl.clearColor(bg[0], bg[1], bg[2], 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        const tris = [];
        for (const st of owner.panels) {
          const poly = (owner.exact || {})[st.p.id];
          if (poly && !(st.kind && st.ready)) tris.push(...fan(poly));
        }
        solid(tris, owner.fill || [1, 1, 1]);
      } else {
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
      const prog = P.final;
      gl.useProgram(prog.p);
      for (const it of R.items.values()) {
        if (!it.out || !it.L || it.st.live === false) continue;
        const st = it.st, L = it.L, fx = st.p.fx || {}, [PW, PH] = st.inst.data.size;
        let verts;
        if (kind === "page") {
          const pts = st.p.poly || [[st.p.rect[0], st.p.rect[1]], [st.p.rect[2], st.p.rect[1]], [st.p.rect[2], st.p.rect[3]], [st.p.rect[0], st.p.rect[3]]];
          const V = pts.map(([x, y]) => [x / PW * 2 - 1, 1 - y / PH * 2, (x * L.sx - L.X0) / L.w, (y * L.sy - L.Y0) / L.h]);
          verts = [];
          for (let i = 1; i < V.length - 1; i++) verts.push(...V[0], ...V[i], ...V[i + 1]);    // eventail (cases convexes)
        } else {
          verts = [-1, 1, 0, 0, 1, 1, 1, 0, -1, -1, 0, 1, -1, -1, 0, 1, 1, 1, 1, 0, 1, -1, 1, 1];
        }
        gl.bindBuffer(gl.ARRAY_BUFFER, polyBuf);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(prog.aP); gl.vertexAttribPointer(prog.aP, 2, gl.FLOAT, false, 16, 0);
        gl.enableVertexAttribArray(prog.aT); gl.vertexAttribPointer(prog.aT, 2, gl.FLOAT, false, 16, 8);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, it.out.t);
        gl.uniform1i(prog.u.uT, 0);
        gl.uniform1f(prog.u.uOp, Math.max(0, Math.min(1, fx.opacity ?? 1)));
        const bg = st.inst.bg;
        gl.uniform3f(prog.u.uBg, bg[0], bg[1], bg[2]);
        gl.drawArrays(gl.TRIANGLES, 0, verts.length / 4);
      }
      gl.disableVertexAttribArray(prog.aT);
      if (animPage && (owner.strokes || []).length) {   // traits des cadres : bande entre les deux polygones decales
        const tris = [], stroke = owner.strokeRgb || hexRgb(owner.data.pagep.stroke || "#111111");
        for (const [outer, inner] of owner.strokes) {
          const O = toClip(outer), I = toClip(inner), n = O.length;
          for (let i = 0; i < n; i++) { const j = (i + 1) % n; tris.push(...O[i], ...O[j], ...I[j], ...O[i], ...I[j], ...I[i]); }
        }
        solid(tris, stroke);
      }
      if (R.onDraw) R.onDraw();
    };
    R.destroy = () => {
      renderers.delete(R);
      for (const st of [...R.items.keys()]) R.remove(st);
      const lose = gl.getExtension("WEBGL_lose_context");
      if (lose) lose.loseContext();
      canvas.remove();
    };
    renderers.add(R);
    R.fit();
    return R;
  }

  // ---------------------------------------------------------------- vue supplementaire d'une case (editeur, agrandi)
  function addView(st, host) {
    const cv = node("canvas", "ac-view-canvas", host);
    const R = makeRenderer(cv, "view", st);
    if (!R) { cv.remove(); return { remove() {}, ok: false }; }
    R.add(st);
    const ro = new ResizeObserver(() => R.fit());
    ro.observe(host);
    const vw = { ok: true, canvas: cv, R, remove() { ro.disconnect(); R.destroy(); st.views = st.views.filter(x => x !== vw); } };
    st.views.push(vw);
    startTick();
    return vw;
  }

  const lb = { el: null, stage: null, vw: null, st: null };
  function ensureLightbox() {
    if (lb.el) return;
    lb.el = node("div", "ac-lightbox", document.body);
    lb.el.setAttribute("aria-hidden", "true");
    lb.stage = node("div", "ac-stage", lb.el);
    const hint = node("p", "", lb.el);
    hint.textContent = "Échap ou clic à côté pour fermer";
    lb.el.addEventListener("click", (e) => { if (e.target === lb.el) closeLightbox(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeLightbox(); });
  }
  function openLightbox(st) {
    ensureLightbox();
    closeLightbox();
    const [x0, y0, x1, y1] = st.p.rect, ar = (x1 - x0) / Math.max(1, y1 - y0);
    const W = Math.min(innerWidth - 32, (innerHeight - 90) * ar);
    lb.stage.style.width = W + "px"; lb.stage.style.height = W / ar + "px";
    lb.stage.classList.toggle("bw", bwOn);
    lb.st = st; lb.vw = addView(st, lb.stage);
    lb.el.classList.add("open"); lb.el.setAttribute("aria-hidden", "false");
  }
  function closeLightbox() {
    if (!lb.st) return;
    lb.vw.remove();
    lb.st = lb.vw = null;
    lb.el.classList.remove("open"); lb.el.setAttribute("aria-hidden", "true");
  }

  // ---------------------------------------------------------------- mode edition (apercu de l'application)
  function setEditHook(fn) {
    editHook = fn || null;
    for (const inst of pages) inst.pageEl.classList.toggle("ac-editing", !!editHook);
  }
  function touch(st) { st.fxv++; }
  function setFx(st, fx) { st.p.fx = fx || undefined; touch(st); }
  function setView(st, view) { st.p.view = view; touch(st); }
  // nouvelle version de la case (video remplacee, version a l'envers prete, sons changes) sans demonter la page
  function updatePanel(st, entry, stamp) {
    const old = st.p;
    st.p = entry;
    const srcChanged = JSON.stringify(old.media || null) !== JSON.stringify(entry.media || null);
    if (stamp) st.inst.stamp = stamp;
    if (srcChanged) {
      loadMedia(st);
      for (const R of renderers) { const it = R.items.get(st); if (it) it.serial = -1; }
      if (st.kind && st.inst.R && !st.inst.R.items.has(st)) st.inst.R.add(st);
    }
    st.el.classList.toggle("empty", !st.kind);
    if (JSON.stringify(old.more || null) !== JSON.stringify(entry.more || null) || stamp) buildSounds(st);
    touch(st);
  }
  function setLayerVolume(st, key, vol) {
    const S = st.sounds.find(o => o.key === key);
    if (S) S.vol = Math.max(0, Math.min(1, vol));
  }
  function setPageSound(inst, snd, stamp) {
    if (inst.music) { inst.music.a.pause(); inst.music.a.src = ""; inst.music = null; }
    inst.data.sound = snd || undefined;
    if (snd) inst.music = makeSound(withStamp(inst.base + snd.src, stamp), snd.vol ?? 0.7, true);
  }
  function setGlobalVolume(inst, vol) { if (inst.music) inst.music.vol = Math.max(0, Math.min(1, vol)); }
  function scrub(st, frame) { st.scrubFrame = frame == null ? null : frame | 0; }
  function setPinned(st, on) { st.pinned = !!on; }
  function setPanelSound(st, on) { st.pinSound = !!on; }

  // controle lecteur / export : la page a l'instant t, a la taille W x H (fond, cases, traits), en image
  async function capture(inst, t, W, H) {
    const wasPlaying = inst.playing;
    inst.playing = false;
    for (let i = 0; i < 100 && (inst.panels.some(st => st.kind && !st.ready) || !grainImage().complete ||
                                  inst.pageEl.querySelector(".ac-bg")?.complete === false); i++) {
      await new Promise((ok) => setTimeout(ok, 100));      // medias et bruit du grain charges
    }
    seek(inst, t);
    inst.geoKey = null;
    updateGeometry(inst);
    inst.R.fit(W, H);
    inst.R.frozen = true;
    const waits = [];
    for (const st of inst.panels) {
      if (st.kind !== "video" || !st.v) continue;
      const P = sourcePos(st.p.fx || {}, st.p.media, t), v = st.v;
      v.pause();
      waits.push(new Promise((ok) => {
        const done = () => { st.serial++; ok(); };
        if (Math.abs(v.currentTime - P.exact) < 1e-4 && v.readyState >= 2) { done(); return; }
        v.addEventListener("seeked", () => setTimeout(done, 60), { once: true });
        v.currentTime = P.exact;
      }));
    }
    await Promise.all(waits);
    await new Promise((ok) => setTimeout(ok, 120));
    const out = document.createElement("canvas");
    out.width = W; out.height = H;
    const g = out.getContext("2d");
    const R = inst.R;
    R.onDraw = () => {
      if (!inst.anim) g.drawImage(inst.pageEl.querySelector(".ac-bg"), 0, 0, W, H);
      g.drawImage(R.canvas, 0, 0, W, H);
      if (!inst.anim) g.drawImage(inst.pageEl.querySelector(".ac-frames"), 0, 0, W, H);
    };
    R.draw(true);
    R.onDraw = null;
    R.frozen = false;
    inst.playing = wasPlaying;
    R.fit();
    return out;
  }

  // ---------------------------------------------------------------- reglages globaux
  function setBW(on) {
    bwOn = !!on;
    for (const inst of pages) inst.pageEl.classList.toggle("bw", bwOn);
    if (lb.stage) lb.stage.classList.toggle("bw", bwOn);
  }
  function setSound(on) { soundOn = !!on; }
  function resetAll() { for (const inst of pages) seek(inst, 0); }
  function hasAudio(M) {
    return !!M.sound || M.panels.some(p => (p.media && p.media.audio) || (p.more || []).length);
  }

  window.AlivePlayer = { isUnlocked: () => unlocked, mount, play, seek, setMode, setBW, setSound, resetAll, hasAudio,
                         isLightboxOpen: () => !!lb.st, setEditHook, addView, setFx, setView, updatePanel, setLayerVolume,
                         setGlobalVolume, setPageSound, scrub, setPinned, setPanelSound, capture, _pages: pages,
                         frameOf: (st) => st.idx ?? 0, clockOf, sourcePos, placement };
})();
