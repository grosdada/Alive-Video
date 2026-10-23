// Editeur de planche : SVG (fond, images et affiches des videos decoupees, traits) + poignees des decoupes + icones par case.
import { compute, nodeAt, area } from "./geometry.js";
import { placement } from "./exporter.js";
import { h } from "./api.js";

const NS = "http://www.w3.org/2000/svg";
const s = (tag, attrs = {}) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v);
  return el;
};
const pts = (poly) => poly.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");

export const ICONS = {
  image: '<path d="M4 5h16v14H4z M4 16l5-5 4 4 3-3 4 4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><circle cx="15.5" cy="9" r="1.6" fill="currentColor"/>',
  video: '<path d="M3 7h12v10H3z M15 10.5l6-3.5v10l-6-3.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>',
  filters: '<path d="M4 6h9 M17 6h3 M4 12h3 M11 12h9 M4 18h11 M19 18h1" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="15" cy="6" r="2" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="9" cy="12" r="2" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="17" cy="18" r="2" fill="none" stroke="currentColor" stroke-width="1.8"/>',
  audio: '<path d="M9 18V6l11-2v12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><circle cx="6.5" cy="18" r="2.5" fill="currentColor"/><circle cx="17.5" cy="16" r="2.5" fill="currentColor"/>',
};
export const icon = (name) => {
  const el = document.createElementNS(NS, "svg");
  el.setAttribute("viewBox", "0 0 24 24"); el.setAttribute("aria-hidden", "true"); el.classList.add("ico");
  el.innerHTML = ICONS[name];
  return el;
};

export class Editor {
  constructor(host, app) {
    this.app = app;
    this.host = host;
    this.wrap = h("div.page-wrap");
    this.svg = s("svg", { class: "page-svg" });
    this.overlay = h("div.overlay");
    this.wrap.append(this.svg, this.overlay);
    host.append(this.wrap);
    this.geom = null;
    this.drag = null;
    this.imgs = new Map();
    this.svg.addEventListener("pointerdown", (e) => this.down(e));
    window.addEventListener("pointermove", (e) => this.move(e));
    window.addEventListener("pointerup", (e) => this.up(e));
    this.svg.addEventListener("wheel", (e) => this.wheel(e), { passive: false });
    this.wrap.addEventListener("dragover", (e) => this.dragover(e));
    this.wrap.addEventListener("dragleave", () => this.hoverDrop(null));
    this.wrap.addEventListener("drop", (e) => this.drop(e));
  }

  get project() { return this.app.project; }

  pagePt(e) {
    const p = this.svg.createSVGPoint();
    p.x = e.clientX; p.y = e.clientY;
    return p.matrixTransform(this.svg.getScreenCTM().inverse());
  }

  panelAt(pt) {
    if (!this.geom) return null;
    for (const g of this.geom.panels) if (inside([pt.x, pt.y], g.poly)) return g;
    return null;
  }

  // ---------------------------------------------------------------- dessin
  render(light) {                  // light : sans les barres d'outils des cases (lecture de l'animation)
    const P = this.project;
    if (!P) return;
    const pg = P.page;
    this.geom = compute(pg, this.app.viewLayout());          // cadrage anime : la page a l'instant affiche
    this.wrap.style.aspectRatio = `${pg.width} / ${pg.height}`;
    this.wrap.style.setProperty("--ratio", pg.width / pg.height);
    const svg = this.svg;
    svg.setAttribute("viewBox", `0 0 ${pg.width} ${pg.height}`);
    svg.textContent = "";
    const defs = s("defs");
    svg.append(defs, s("rect", { x: 0, y: 0, width: pg.width, height: pg.height, fill: pg.bg }));
    const sel = this.app.selected;
    for (const g of this.geom.panels) {
      const panel = P.panels[g.id] || {};
      const cp = s("clipPath", { id: "cp-" + g.id });
      cp.append(s("polygon", { points: pts(g.poly) }));
      defs.append(cp);
      const grp = s("g", { "clip-path": `url(#cp-${g.id})` });
      const pic = media(panel);
      grp.append(s("polygon", { points: pts(g.poly), fill: pic ? "#fff" : "var(--empty)" }));
      if (pic) {
        // on garde les elements <image> d'un rendu a l'autre : pas de clignotement pendant les glisser
        const pl = placement(g.bbox, pic.w, pic.h, panel.view);
        let im = this.imgs.get(g.id);
        if (!im || im.getAttribute("href") !== pic.url) {
          im = s("image", { href: pic.url, preserveAspectRatio: "none" });
          this.imgs.set(g.id, im);
        }
        im.setAttribute("x", pl.x); im.setAttribute("y", pl.y);
        im.setAttribute("width", pl.w); im.setAttribute("height", pl.h);
        grp.append(im);
      }
      svg.append(grp);
    }
    for (const g of this.geom.panels) {
      svg.append(s("polygon", { points: pts(g.poly), fill: "none", stroke: pg.stroke, "stroke-width": pg.strokeWidth,
                                "stroke-linejoin": "miter", class: "panel-stroke" }));
    }
    for (const g of this.geom.panels) {
      if (g.id === sel) svg.append(s("polygon", { points: pts(g.poly), class: "sel-outline" }));
      if (g.id === this.dropTarget) svg.append(s("polygon", { points: pts(g.poly), class: "drop-outline" }));
    }
    // poignees des decoupes : le trait entier deplace, les bouts inclinent
    const k = pg.width / 900;
    const tracks = (P.anim && P.anim.tracks) || {}, animOn = this.app.animMode;
    this.geom.cuts.forEach((c, i) => {
      if (!c.seg) return;
      const [E0, E1] = c.seg;
      const id = c.node.id, keyed = (end) => (tracks[`${id}.${end}`] || []).length > 0;
      const cls = "cut" + (animOn ? " anim" : "") + (id && id === this.app.selectedCut ? " sel" : "");
      const gl = s("g", { class: cls, "data-cut": i });
      gl.append(s("line", { x1: E0[0], y1: E0[1], x2: E1[0], y2: E1[1], class: "cut-hit",
                            "stroke-width": Math.max(pg.gutter + 8, 20 * k), "data-cut": i, "data-mode": "move" }));
      gl.append(s("line", { x1: E0[0], y1: E0[1], x2: E1[0], y2: E1[1], class: "cut-line", "stroke-width": 3 * k }));
      const mid = [(E0[0] + E1[0]) / 2, (E0[1] + E1[1]) / 2];
      gl.append(s("circle", { cx: mid[0], cy: mid[1], r: 9 * k, class: "cut-mid", "data-cut": i, "data-mode": "move" }));
      // attache animee (elle a des cles) : en pourpre
      gl.append(s("circle", { cx: E0[0], cy: E0[1], r: 8 * k, class: "cut-end" + (keyed("a") ? " keyed" : ""), "data-cut": i, "data-mode": "end0" }));
      gl.append(s("circle", { cx: E1[0], cy: E1[1], r: 8 * k, class: "cut-end" + (keyed("b") ? " keyed" : ""), "data-cut": i, "data-mode": "end1" }));
      svg.append(gl);
    });
    if (!light) this.renderOverlay();
  }

  renderOverlay() {
    const P = this.project, pg = P.page;
    this.overlay.textContent = "";
    for (const g of this.geom.panels) {
      const panel = P.panels[g.id] || {};
      const st = this.app.panelStatus(g.id);
      const box = h("div.ptools", { style: { left: (g.bbox.x0 / pg.width * 100) + "%", top: (g.bbox.y0 / pg.height * 100) + "%",
                                              width: (g.bbox.w / pg.width * 100) + "%", height: (g.bbox.h / pg.height * 100) + "%" } });
      const fl = ((panel.edit || {}).filters || []).filter(f => f.on !== false).length;
      const bar = h("div.pbar",
        h("span.num", String(g.order)),
        this.tool(g.id, panel.image ? "image" : "video", panel.video ? "Remplacer la vidéo" : panel.image ? "Remplacer l'image" : "Importer une vidéo ou une image"),
        media(panel) ? this.tool(g.id, "filters", "Filtres et retouches (aperçu)" + (fl ? ` : ${fl} effet${fl > 1 ? "s" : ""}` : ""), fl > 0) : null,
        this.tool(g.id, "audio", "Sons : " + this.app.audioLabel(panel), this.app.hasSound(panel)),
        st ? h("span.dot." + st.kind, { title: st.text }) : null);
      box.append(bar);
      if (!media(panel)) {
        box.append(h("button.empty-cta", { on: { click: () => this.app.pickMedia(g.id) } },
                     icon("video"), h("span", "Glisser une vidéo (ou une image) ici, ou cliquer")));
      } else {
        box.append(h("div.ptag", this.app.panelTag(panel)));
      }
      this.overlay.append(box);
    }
  }

  tool(id, kind, title, on) {
    const b = h("button.ptool" + (on ? ".on" : ""), { title, on: { click: (e) => { e.stopPropagation(); this.app.panelMenu(id, kind, b); } } },
                icon(kind));
    return b;
  }

  // ---------------------------------------------------------------- gestes
  down(e) {
    if (e.button !== 0) return;
    const t = e.target;
    const pt = this.pagePt(e);
    if (t.dataset && t.dataset.cut != null) {
      const cut = this.geom.cuts[+t.dataset.cut];
      this.drag = { kind: "cut", mode: t.dataset.mode, path: cut.path, bb: cut.bb, seg: cut.seg, start: pt, id: cut.node.id,
                    a: cut.node.a, b: cut.node.b, before: JSON.stringify(this.project.layout),
                    keys0: JSON.parse(JSON.stringify((this.project.anim && this.project.anim.tracks) || {})) };
      this.app.touchCut(cut.node.id, t.dataset.mode);   // la timeline se met sur la ligne de cette attache
      e.preventDefault();
      return;
    }
    const g = this.panelAt(pt);
    if (!g) { this.app.select(null); return; }
    if (this.app.selected !== g.id) this.app.select(g.id);
    const panel = this.project.panels[g.id];
    const pic = media(panel);
    if (pic) {
      const pl = placement(g.bbox, pic.w, pic.h, panel.view);
      this.drag = { kind: "pan", id: g.id, bb: g.bbox, start: pt, ox: pl.ox, oy: pl.oy, moved: false };
      e.preventDefault();
    }
  }

  move(e) {
    const d = this.drag;
    if (!d) return;
    const pt = this.pagePt(e);
    if (d.kind === "pan") {
      const panel = this.project.panels[d.id];
      const pic = media(panel);
      panel.view = Object.assign({}, panel.view, { ox: d.ox + (pt.x - d.start.x) / d.bb.w, oy: d.oy + (pt.y - d.start.y) / d.bb.h });
      const pl = placement(d.bb, pic.w, pic.h, panel.view);
      panel.view.ox = pl.ox; panel.view.oy = pl.oy;
      d.moved = true;
      this.render();
      return;
    }
    const node = nodeAt(this.project.layout, d.path);
    const bb = d.bb, horiz = node.dir === "h";
    const len = horiz ? bb.h : bb.w;
    const along = (p) => horiz ? (p.y - bb.y0) / bb.h : (p.x - bb.x0) / bb.w;
    const tOf = (E) => horiz ? (E[0] - bb.x0) / bb.w : (E[1] - bb.y0) / bb.h;
    let a = d.a, b = d.b;
    if (d.mode === "move") {
      const delta = (horiz ? pt.y - d.start.y : pt.x - d.start.x) / len;
      a = d.a + delta; b = d.b + delta;
    } else if (d.mode === "end0") {
      const t = Math.min(0.9, Math.max(0, tOf(d.seg[0])));
      a = (along(pt) - d.b * t) / (1 - t);
    } else {
      const t = Math.max(0.1, Math.min(1, tOf(d.seg[1])));
      b = (along(pt) - d.a * (1 - t)) / t;
    }
    if (e.shiftKey && d.mode !== "move") { if (d.mode === "end0") a = b; else b = a; }   // Maj : trait droit
    if (this.app.animMode) {                       // Animate framing : une cle a l'instant de la tete de lecture
      a = Math.max(0, Math.min(1, a)); b = Math.max(0, Math.min(1, b));   // une case peut se refermer entierement
      this.app.keyCut(d, a, b);
      d.moved = d.anim = true;
      this.render();
      return;
    }
    if (this.app.cutAnimated(d.id)) {              // trait anime, hors du mode : toute son animation se decale
      this.app.shiftCut(d, Math.max(0, Math.min(1, a)), Math.max(0, Math.min(1, b)));
      d.moved = d.anim = true;
      this.render();
      return;
    }
    a = Math.max(0.04, Math.min(0.96, a)); b = Math.max(0.04, Math.min(0.96, b));
    const keep = [node.a, node.b];
    node.a = a; node.b = b;
    const geo = compute(this.project.page, this.project.layout);
    const minA = this.project.page.width * this.project.page.height * 0.004;
    if (geo.panels.length !== this.geom.panels.length || geo.panels.some(p => area(p.poly) < minA)) {
      node.a = keep[0]; node.b = keep[1];          // une case deviendrait trop petite : on refuse
    }
    d.moved = true;
    this.render();
  }

  up() {
    const d = this.drag;
    this.drag = null;
    if (!d || !d.moved) return;
    if (d.anim) { this.app.animChanged(); return; }
    this.app.commit(d.kind === "pan" ? "image" : "layout");
  }

  wheel(e) {
    const g = this.panelAt(this.pagePt(e));
    if (!g || g.id !== this.app.selected) return;
    const panel = this.project.panels[g.id];
    if (!media(panel)) return;
    e.preventDefault();
    const v = Object.assign({ zoom: 1, ox: 0, oy: 0 }, panel.view);
    v.zoom = Math.max(1, Math.min(6, v.zoom * Math.exp(-e.deltaY * 0.0015)));
    panel.view = v;
    this.render();
    this.app.commitSoon("image");
  }

  dragover(e) {
    if (![...(e.dataTransfer?.types || [])].includes("Files")) return;
    e.preventDefault();
    const g = this.panelAt(this.pagePt(e));
    this.hoverDrop(g ? g.id : null);
  }

  hoverDrop(id) {
    if (this.dropTarget === id) return;
    this.dropTarget = id;
    this.render();
  }

  drop(e) {
    e.preventDefault();
    const g = this.panelAt(this.pagePt(e));
    this.hoverDrop(null);
    const f = [...(e.dataTransfer?.files || [])][0];
    if (!g || !f) return;
    if (f.type.startsWith("video/") || /\.(mp4|mov|m4v|mkv|webm|avi|mpe?g|mts|m2ts|wmv|ogv)$/i.test(f.name)) this.app.importVideo(g.id, f);
    else if (f.type.startsWith("image/")) this.app.importImage(g.id, f);
    else if (f.type.startsWith("audio/")) this.app.importAudio(g.id, f);
  }
}

// ce qu'on montre dans la case de l'editeur : l'image, ou l'affiche (premiere image) de la video
export function media(panel) {
  if (panel?.video) return { url: panel.video.poster_url, w: panel.video.w, h: panel.video.h };
  if (panel?.image) return { url: panel.image.url, w: panel.image.w, h: panel.image.h };
  return null;
}

function inside([x, y], poly) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c;
  }
  return c;
}
