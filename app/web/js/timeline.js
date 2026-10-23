// « Animate framing » : timeline du cadrage anime, sous la planche.
// Une ligne par point d'attache (chaque trait a deux bouts : a et b) ; les losanges sont les images cles. Toucher une
// attache dans la planche selectionne sa ligne (le trait entier : ses deux lignes). Glisser l'attache pose une cle a
// l'instant de la tete de lecture. Les cles se deplacent au glisser, se suppriment (Suppr), changent de courbe.
import { h } from "./api.js";
import { EASES, cutIdsOf, nodeAt, trackValue } from "./geometry.js";

const fmt = (s) => (Math.round(s * 100) / 100).toLocaleString("fr-FR", { minimumFractionDigits: 2 }) + " s";

export class Timeline {
  constructor(app, host) {
    this.app = app;
    this.host = host;
    this.sel = null;                 // {track, i} : cle selectionnee
    this.el = h("div.tl");
    host.append(this.el);
    this.render();
  }

  get P() { return this.app.project; }
  get tracks() { return (this.P.anim = this.P.anim || { tracks: {} }).tracks || (this.P.anim.tracks = {}); }

  // les traits dans l'ordre de l'arbre (stable) : [{id, n, dir, path}]
  cuts() {
    const out = [];
    (function walk(x, path) {
      if (!x || x.t !== "split") return;
      out.push({ id: x.id, dir: x.dir, path });
      walk(x.c[0], path.concat(0)); walk(x.c[1], path.concat(1));
    })(this.P.layout, []);
    return out.map((c, i) => Object.assign(c, { n: i + 1 }));
  }

  destroy() { this.el.remove(); }

  render() {
    const app = this.app, dur = app.timelineLength();
    this.el.textContent = "";
    const play = h("button.tl-btn", { title: "Lecture / pause (barre espace)", on: { click: () => app.animToggle() } }, app.animPlaying ? "⏸" : "▶");
    this.playBtn = play;
    this.timeEl = h("span.tl-time");
    const ease = h("select.tl-ease", { title: "Courbe entre cette clé et la suivante" }, EASES.map(([v, l]) => h("option", { value: v }, l)));
    ease.onchange = () => { const k = this.selKey(); if (k) { k.e = ease.value; app.animChanged(); } };
    this.easeEl = ease;
    const bar = h("div.tl-bar",
      h("b.tl-title", "🎞 Animate framing"),
      h("button.tl-btn", { title: "Début", on: { click: () => app.animSeek(0) } }, "⏮"), play, this.timeEl,
      h("span.tl-sep"),
      h("button.tl-btn", { title: "Poser une clé ici sur la ligne choisie (valeur actuelle)", on: { click: () => this.addKeyHere() } }, "◆ Clé ici"),
      h("label.tl-lab", "Courbe ", ease),
      h("button.tl-btn", { title: "Supprimer la clé choisie (Suppr)", on: { click: () => this.deleteKey() } }, "✕ Clé"),
      h("button.tl-btn", { title: "Retirer toute l'animation du trait choisi", on: { click: () => this.clearCut() } }, "Effacer le trait"),
      h("span.sp"),
      h("small.muted", `durée de la page ${fmt(dur)}`),
      h("button.tl-btn", { title: "Fermer la timeline (l'animation reste)", on: { click: () => app.setAnimMode(false) } }, "✕"));
    const grid = h("div.tl-grid");
    // regle
    const ruler = h("div.tl-row.tl-ruler", h("div.tl-label", ""), h("div.tl-lane"));
    const lane0 = ruler.lastChild;
    const step = dur > 30 ? 5 : dur > 12 ? 2 : dur > 4 ? 1 : 0.5;
    for (let t = 0; t <= dur + 1e-6; t += step) {
      lane0.append(h("span.tl-tick", { style: { left: (t / dur * 100) + "%" } }, String(Math.round(t * 10) / 10).replace(".", ",")));
    }
    this.bindLane(lane0, null);
    grid.append(ruler);
    this.rows = {};
    const cuts = this.cuts();
    if (!cuts.length) grid.append(h("p.muted.tl-empty", "Aucun trait : coupe d'abord des cases."));
    for (const c of cuts) {
      for (const end of ["a", "b"]) {
        const key = `${c.id}.${end}`;
        const side = c.dir === "h" ? (end === "a" ? "bout gauche" : "bout droit") : (end === "a" ? "bout haut" : "bout bas");
        const val = h("small.tl-val");
        const label = h("div.tl-label", { title: "Choisir cette attache", on: { click: () => this.selectCut(c.id, end === "a" ? "end0" : "end1") } },
          h("span", `Trait ${c.n} · ${side}`, h("small.muted", c.dir === "h" ? " (horizontal)" : " (vertical)")), val);
        const lane = h("div.tl-lane");
        const row = h("div.tl-row", { "data-track": key, "data-cut": c.id }, label, lane);
        (this.tracks[key] || []).forEach((k, i) => lane.append(this.diamond(key, i, k, dur)));
        this.bindLane(lane, key);
        this.rows[key] = { row, val, lane };
        grid.append(row);
      }
    }
    this.head = h("div.tl-head");
    grid.append(this.head);
    this.grid = grid;
    this.el.append(bar, grid);
    this.paintSel();
    this.update();
  }

  diamond(key, i, k, dur) {
    const d = h("span.tl-key", { title: `${fmt(k.t)} · ${Math.round(k.v * 100)} %`, style: { left: (k.t / dur * 100) + "%" },
                                 "data-track": key, "data-i": String(i) });
    if (this.sel && this.sel.track === key && this.sel.i === i) d.classList.add("on");
    d.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      this.sel = { track: key, i };
      this.selectRow(key);
      const lane = d.parentNode, r = lane.getBoundingClientRect(), dur2 = this.app.timelineLength();
      const keys = this.tracks[key], kk = keys[i];
      try { d.setPointerCapture(e.pointerId); } catch (_) { /* pointeur deja relache */ }
      let moved = false;
      const move = (ev) => {
        const t = this.app.snap(Math.max(0, Math.min(dur2, (ev.clientX - r.left) / r.width * dur2)));
        if (Math.abs(t - kk.t) < 1e-6) return;
        moved = true;
        kk.t = t;
        d.style.left = (t / dur2 * 100) + "%";
        this.app.animSeek(t, true);
      };
      const up = () => {
        d.removeEventListener("pointermove", move); d.removeEventListener("pointerup", up);
        if (moved) {                         // remettre dans l'ordre, une cle par instant
          keys.sort((x, y) => x.t - y.t);
          for (let j = keys.length - 1; j > 0; j--) if (Math.abs(keys[j].t - keys[j - 1].t) < 1e-6) keys.splice(j - 1, 1);
          this.sel = { track: key, i: keys.indexOf(kk) };
          this.app.animChanged();
        } else this.app.animSeek(kk.t);
        this.paintSel();
      };
      d.addEventListener("pointermove", move); d.addEventListener("pointerup", up);
      this.paintSel();
    });
    d.addEventListener("dblclick", (e) => e.stopPropagation());
    return d;
  }

  // une ligne : clic = choisir la ligne et placer la tete de lecture ; double-clic = une cle a cet instant
  bindLane(lane, key) {
    lane.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      const r = lane.getBoundingClientRect(), dur = this.app.timelineLength();
      const at = (ev) => this.app.snap(Math.max(0, Math.min(dur, (ev.clientX - r.left) / r.width * dur)));
      if (key) this.selectRow(key);
      this.sel = null;
      this.paintSel();
      this.app.animSeek(at(e));
      try { lane.setPointerCapture(e.pointerId); } catch (_) { /* pointeur deja relache */ }
      const move = (ev) => this.app.animSeek(at(ev), true);
      const up = () => { lane.removeEventListener("pointermove", move); lane.removeEventListener("pointerup", up); };
      lane.addEventListener("pointermove", move); lane.addEventListener("pointerup", up);
    });
    if (key) lane.addEventListener("dblclick", () => { this.selectRow(key); this.addKeyHere([key]); });
  }

  selKey() { return this.sel ? (this.tracks[this.sel.track] || [])[this.sel.i] : null; }

  // l'attache touchee dans la planche : sa ligne (ou les deux lignes du trait pour la poignee du milieu)
  selectCut(id, mode) {
    this.app.selectedCut = id;
    this.selRows = mode === "end0" ? [`${id}.a`] : mode === "end1" ? [`${id}.b`] : [`${id}.a`, `${id}.b`];
    this.sel = null;
    this.paintSel();
    const r = this.rows && this.rows[this.selRows[0]];
    if (r) r.row.scrollIntoView({ block: "nearest" });
    this.app.editor?.render();
  }
  selectRow(key) {
    this.app.selectedCut = key.split(".")[0];
    this.selRows = [key];
    this.paintSel();
    this.app.editor?.render();
  }

  paintSel() {
    for (const [key, r] of Object.entries(this.rows || {})) {
      r.row.classList.toggle("sel", !!this.selRows && this.selRows.includes(key));
      r.row.classList.toggle("cut", r.row.dataset.cut === this.app.selectedCut);
    }
    for (const d of this.el.querySelectorAll(".tl-key")) {
      d.classList.toggle("on", !!this.sel && this.sel.track === d.dataset.track && this.sel.i === +d.dataset.i);
    }
    const k = this.selKey();
    this.easeEl.disabled = !k;
    if (k) this.easeEl.value = k.e || "ease";
  }

  // valeur actuelle d'une attache (dans l'arbre et ses cles)
  valueOf(track, t) {
    const [id, end] = track.split(".");
    const c = this.cuts().find(x => x.id === id);
    if (!c) return 0;
    const node = nodeAt(this.P.layout, c.path);
    return trackValue(this.tracks[track], t, node[end]);
  }

  addKeyHere(list) {
    const rows = list || this.selRows;
    if (!rows || !rows.length) { this.app.toast("Choisis d'abord une ligne (ou touche une attache dans la planche)."); return; }
    const t = this.app.snap(this.app.animT);
    for (const track of rows) this.app.setKey(track, t, this.valueOf(track, t));
    this.app.animChanged();
  }

  deleteKey() {
    const k = this.selKey();
    if (!k) { this.app.toast("Choisis d'abord une clé (un losange)."); return; }
    const keys = this.tracks[this.sel.track];
    keys.splice(this.sel.i, 1);
    if (!keys.length) delete this.tracks[this.sel.track];
    this.sel = null;
    this.app.animChanged();
  }

  clearCut() {
    const id = this.app.selectedCut;
    if (!id) { this.app.toast("Choisis d'abord un trait."); return; }
    const t = this.app.animT;
    for (const end of ["a", "b"]) {                // le trait garde la position qu'il a a cet instant
      const track = `${id}.${end}`;
      if (!this.tracks[track]) continue;
      const c = this.cuts().find(x => x.id === id);
      if (c) nodeAt(this.P.layout, c.path)[end] = this.valueOf(track, t);
      delete this.tracks[track];
    }
    this.sel = null;
    this.app.animChanged();
  }

  // tete de lecture, temps, valeurs (sans tout redessiner)
  update() {
    const dur = this.app.timelineLength(), t = this.app.animT;
    if (this.head) this.head.style.left = `calc(var(--tl-label) + var(--tl-pad) + (100% - var(--tl-label) - 2 * var(--tl-pad)) * ${Math.min(1, t / dur)})`;
    if (this.head && this.grid) this.head.style.height = this.grid.scrollHeight + "px";
    if (this.timeEl) this.timeEl.textContent = `${fmt(t)} / ${fmt(dur)}`;
    if (this.playBtn) this.playBtn.textContent = this.app.animPlaying ? "⏸" : "▶";
    for (const [key, r] of Object.entries(this.rows || {})) {
      r.val.textContent = Math.round(this.valueOf(key, t) * 100) + " %" + ((this.tracks[key] || []).length ? "" : " · fixe");
    }
  }

  ids() { return cutIdsOf(this.P.layout); }
}
