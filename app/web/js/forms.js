// Formulaires de l'inspecteur : media d'une case, lecture, sons, reglages de page.
import { h, toast } from "./api.js";
import { FORMATS, pageSize } from "./geometry.js";
import { icon } from "./editor.js";

const field = (label, input, hint) => h("label.field", h("span.lab", label), input, hint ? h("small.hint", hint) : null);

function select(options, value, onChange) {
  const el = h("select", options.map(o => h("option", { value: o.id }, o.label)));
  el.value = value;
  el.addEventListener("change", () => onChange(el.value));
  return el;
}

function check(label, value, onChange, title) {
  const cb = h("input", { type: "checkbox" });
  cb.checked = !!value;
  cb.addEventListener("change", () => onChange(cb.checked));
  return h("label.check", { title: title || "" }, cb, " " + label);
}

function range(label, value, min, max, step, show, onInput) {
  const el = h("input", { type: "range", min, max, step, value });
  const out = h("output", show(value));
  el.addEventListener("input", () => { out.textContent = show(+el.value); onInput(+el.value); });
  return field(label, h("div.range", el, out));
}

export function seg(modes, cur, onPick) {
  return h("div.seg", modes.map(([m, l]) => h("button" + (cur === m ? ".on" : ""), { on: { click: () => onPick(m) } }, l)));
}

export const fmtSec = (s) => {
  if (!isFinite(s)) return "—";
  const m = Math.floor(s / 60), r = s - m * 60;
  return m ? `${m} min ${Math.round(r)} s` : `${(Math.round(r * 10) / 10).toLocaleString("fr-FR")} s`;
};

// ------------------------------------------------------------------ media de la case (video ou image)
export function mediaForm(app, pid) {
  const panel = app.panel(pid);
  const box = h("div.form");
  const v = panel.video, im = panel.image;
  if (v || im) {
    const z = h("input", { type: "range", min: 100, max: 600, value: Math.round((panel.view?.zoom || 1) * 100) });
    z.addEventListener("input", () => { panel.view = Object.assign({}, panel.view, { zoom: z.value / 100 }); app.editor.render(); app.commitSoon("image"); });
    if (v) {
      box.append(h("div.minfo", h("b", v.name || "vidéo"),
        h("span", `${v.w} × ${v.h} · ${fmtSec(v.duration)} · ${Math.round(v.fps_f * 100) / 100} im/s` + (v.audio ? " · son" : " · muette"))));
    } else {
      box.append(h("div.minfo", h("b", im.name || "image"), h("span", `${im.w} × ${im.h}`)));
    }
    box.append(h("div.row",
      h("button", { on: { click: () => app.pickMedia(pid) } }, icon(v ? "video" : "image"), " Remplacer"),
      h("button", { on: { click: () => { panel.view = { zoom: 1, ox: 0, oy: 0 }; app.editor.render(); app.commit("image"); app.refreshInspector(); } } }, "Recentrer"),
      h("button.danger", { on: { click: () => { delete panel.video; delete panel.image; app.editor.render(); app.commit("image"); app.refreshInspector(); } } }, "Retirer")),
      h("label.field", h("span.lab", "Cadrage : molette sur la case pour zoomer, glisser pour déplacer"), z));
  } else {
    box.append(h("div.row",
      h("button.primary", { on: { click: () => app.pickMedia(pid, "video") } }, icon("video"), " Importer une vidéo"),
      h("button", { on: { click: () => app.pickMedia(pid, "image") } }, icon("image"), " Une image")),
      h("p.muted", "Ou glisse le fichier directement sur la case. Une vidéo par case."));
  }
  return box;
}

// ------------------------------------------------------------------ lecture (memes reglages que l'onglet Filtres de l'apercu)
export function playForm(app, pid) {
  const panel = app.panel(pid);
  const e = panel.edit || {};
  const box = h("div.form");
  const set = (k, v, neutral) => app.setEdit(pid, (ed) => { if (v === neutral) delete ed[k]; else ed[k] = v; });
  if (panel.video) {
    const v = panel.video, fps = v.fps_f || 25;
    const n = v.frames || 1, r = Array.isArray(e.range) ? e.range : [0, n - 1];
    const pass = (r[1] - r[0] + 1) / fps;
    box.append(range("Vitesse", e.speed || 1, 0.25, 4, 0.05, (x) => "× " + x.toLocaleString("fr-FR"), (x) => set("speed", Math.round(x * 100) / 100, 1)));
    box.append(h("div.row",
      check("En boucle", e.loop !== false, (x) => set("loop", x ? true : false, true), "Décoché : une fois, puis l'image reste figée sur la fin"),
      check("À l'envers", !!e.reverse, (x) => set("reverse", x, false), "Lecture inversée (son compris)")));
    if (v.audio) box.append(range("Volume du son", e.volume ?? 1, 0, 1, 0.01, (x) => Math.round(x * 100) + " %", (x) => set("volume", x, 1)));
    box.append(h("p.muted", `Passage : ${fmtSec(pass)} de vidéo` + (Array.isArray(e.range) ? " (début et fin réglés)" : "") +
                            `, ${fmtSec(pass / (e.speed || 1))} à l'écran.`));
  }
  box.append(range("Opacité", e.opacity ?? 1, 0, 1, 0.01, (x) => Math.round(x * 100) + " %", (x) => set("opacity", x, 1)));
  const fl = (e.filters || []);
  const names = { blur: "Flou", colour: "Couleur", mono: "N&B · sépia · teinte", vignette: "Vignette", grain: "Grain",
                  halation: "Halation", chroma: "Aberration chromatique" };
  box.append(h("p.fxsum", fl.length ? "Effets : " + fl.map(f => (f.on === false ? "(" : "") + (names[f.type] || f.type) + (f.on === false ? ")" : "")).join(" → ")
                                    : "Aucun effet."),
    h("button.primary", { title: "Ouvre l'aperçu en mode édition sur cette case : lecture, couleur, cadrage, filtres, sons",
                          on: { click: () => app.editInPreview(pid) } }, icon("filters"), " Filtres et retouches (aperçu)"));
  return box;
}

// ------------------------------------------------------------------ sons ajoutes a la case
export function soundsForm(app, pid) {
  const panel = app.panel(pid);
  const box = h("div.form");
  const extras = panel.extraSounds || [];
  if (panel.video?.audio) box.append(h("p.muted", "Le son de la vidéo est joué et mixé dans l'export (volume dans « Lecture »)."));
  extras.forEach((x, i) => {
    const name = (x.name || (x.file || "").split("/").pop().replace(/^\d{8}-\d{6}-[0-9a-f]{4}-/, ""));
    const vol = range("Volume", x.volume ?? 0.8, 0, 1, 0.01, (v) => Math.round(v * 100) + " %", (v) => {
      x.volume = v; app.saveExtras(pid);
    });
    box.append(h("div.form.layer",
      h("div.row", h("b.sname", name), h("button.mini", { on: { click: () => { extras.splice(i, 1); app.saveExtras(pid, true); } } }, "✕")),
      h("audio", { controls: true, src: `/projects/${app.project.id}/${x.file}`, preload: "none" }),
      vol, check("En boucle (sinon : une fois, depuis le début)", x.loop !== false, (v) => { x.loop = v; app.saveExtras(pid); })));
  });
  box.append(h("button", { on: { click: () => app.pickAudio(pid) } }, icon("audio"), " Ajouter un son (ambiance, voix, bruitage)"));
  return box;
}

// ------------------------------------------------------------------ reglages de page
export function pageForm(app) {
  const P = app.project, pg = P.page;
  const box = h("div.form");
  const resize = () => {
    const [w, hh] = pageSize(pg.format, pg.orientation);
    pg.width = w; pg.height = hh;
    app.commit("page"); app.editor.render(); app.renderLeft();
  };
  box.append(h("div.row",
    field("Format", select(FORMATS, pg.format, (v) => { pg.format = v; resize(); })),
    field("Sens", h("div.seg", [["portrait", "Vertical"], ["paysage", "Horizontal"]].map(([k, l]) =>
      h("button" + ((pg.orientation || "portrait") === k ? ".on" : ""), { on: { click: () => { pg.orientation = k; resize(); app.refreshInspector(); } } }, l))))));
  // un reglage anime (module « Style de page » de la timeline) se regle dans la timeline
  const animated = (k) => ((P.anim && P.anim.tracks && P.anim.tracks["page." + k]) || []).length > 0;
  const badge = (k) => animated(k) ? h("small.animated", { title: "Animé : se règle dans la timeline (Animate framing › Style de page)" }, " 🎞 animé") : null;
  const color = (k, label) => {
    const el = h("input", { type: "color", value: pg[k] || (k === "stroke" ? "#111111" : "#ffffff"), disabled: animated(k) });
    el.addEventListener("input", () => { pg[k] = el.value; app.editor.render(); app.commitSoon("page"); });
    return h("label.field", h("span.lab", label, badge(k)), el);
  };
  box.append(h("div.row", color("bg", "Fond (autour des cases)"), color("fill", "Cases"), color("stroke", "Traits")));
  const num = (k, label, min, max) => {
    const el = h("input", { type: "range", min, max, value: pg[k], disabled: animated(k) });
    const out = h("output", String(pg[k]));
    el.addEventListener("input", () => { pg[k] = +el.value; out.textContent = el.value; app.editor.render(); app.commitSoon("page"); });
    return h("label.field", h("span.lab", label, badge(k)), h("div.range", el, out));
  };
  box.append(num("strokeWidth", "Épaisseur des traits", 0, 16), num("gutter", "Gouttière", 0, 80), num("margin", "Marge", 0, 200));
  box.append(h("h5", "Musique de la page"), pageSoundForm(app));
  const ex = P.export || {};
  box.append(h("h5", "Vidéo exportée"),
    h("p.muted", `${ex.duration ? fmtSec(ex.duration) : "durée automatique"} · ${ex.height || 1080}p · ${ex.fps || 30} images/s`),
    h("button.primary", { on: { click: () => app.exportDialog() } }, icon("video"), " Exporter la vidéo…"));
  return box;
}

// musique de la page : joue en boucle sous toute la page (et dans l'export)
function pageSoundForm(app) {
  const P = app.project;
  const ps = P.pageSound = P.pageSound || { mode: "none" };
  const box = h("div.form.layer");
  const on = ps.mode === "file" && ps.file;
  if (on) {
    box.append(h("b.sname", ps.name || (ps.file || "").split("/").pop()),
      h("audio", { controls: true, src: `/projects/${P.id}/${ps.file}`, preload: "none" }),
      range("Volume", ps.volume ?? 0.7, 0, 1, 0.01, (v) => Math.round(v * 100) + " %", (v) => { ps.volume = v; ps.rev = Date.now() / 1000; app.commitSoon("panel"); }));
  }
  box.append(h("div.row",
    h("button", { on: { click: () => app.pickPageSound() } }, icon("audio"), on ? " Remplacer…" : " Importer une musique…"),
    on ? h("button.mini", { on: { click: () => { Object.assign(ps, { mode: "none", rev: Date.now() / 1000 }); app.commit("page"); app.refreshInspector(); } } }, "Retirer") : null));
  return box;
}

export function toastErr(e) { toast(e.message || String(e), "error", 8000); }
