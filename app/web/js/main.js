// Alive-Video : application (etat, projets, edition des planches, videos dans les cases, export video, livres).
import { get, post, put, upload, uploadSound, h, toast, debounce, modal } from "./api.js";
import { compute, PRESETS, PAGE_DEFAULTS, FORMATS, pageSize, transpose, randomLayout, removeLeaf, splitLeaf, leaves,
         layoutAt, ensureCutIds, animEnd, cutIdsOf } from "./geometry.js";
import { Timeline } from "./timeline.js";
import { Editor, icon, media } from "./editor.js";
import { pageImages } from "./exporter.js";
import { mediaForm, playForm, soundsForm, pageForm, fmtSec } from "./forms.js";

const NEW_PANEL = () => ({ view: { zoom: 1, ox: 0, oy: 0 } });
const VIDEO_EXT = /\.(mp4|mov|m4v|mkv|webm|avi|mpe?g|mts|m2ts|wmv|ogv|gif)$/i;

class App {
  constructor() {
    this.project = null;
    this.selected = null;
    this.exports = [];
    this.undo = [];
    this.redo = [];
    this.saveSoon = debounce(() => this.save(), 700);
    this.pageSoon = debounce(() => this.uploadPage(), 2500);
    this.commitSoon = debounce((k) => this.commit(k), 350);
    this.editSoon = new Map();
    this.animMode = false;          // « Animate framing » : timeline ouverte, les attaches posent des cles
    this.animT = 0;
    this.animPlaying = false;
    this.selectedCut = null;
  }

  async init() {
    [this.presets, this.settings, this.info] = await Promise.all([get("presets"), get("settings"), get("info")]);
    this.root = document.getElementById("app");
    window.addEventListener("hashchange", () => this.route());
    document.addEventListener("keydown", (e) => this.keys(e));
    setInterval(() => this.poll(), 2000);
    this.route();
    if (!this.info.ffmpeg) toast("ffmpeg introuvable : il faut ffmpeg dans le PATH pour les vidéos et l'export.", "error", 15000);
  }

  route() {
    const m = location.hash.match(/^#p=([a-z0-9-]+)/);
    if (m) this.open(m[1]); else this.home();
  }

  // ================================================================ accueil : projets et livres
  async home() {
    this.project = null; this.selected = null;
    const [projects, books, fdata] = await Promise.all([get("projects"), get("books"),
                                                        get("folders").catch(() => ({ folders: [], assign: {} }))]);
    const folders = fdata.folders, assign = fdata.assign;            // projets de rangement : une planche dans un seul projet
    const saveFolders = () => put("folders", { folders, assign });
    let cur = pref("ac-folder", "all");                               // all | none | <id d'un projet>
    if (cur !== "all" && cur !== "none" && !folders.some(f => f.id === cur)) cur = "all";
    const selected = new Set();                                       // planches cochees (ctrl / cmd + clic) pour un deplacement groupe
    this.root.textContent = "";
    this.root.append(this.topbar(true));
    let view = pref("ac-home-view", "grid"), sort = pref("ac-home-sort", "updated"), q = "";
    const inBooks = (pid) => books.filter(b => b.pages.includes(pid)).map(b => b.title);
    const CMP = {
      updated: (a, b) => b.updated - a.updated,
      created: (a, b) => (b.created || 0) - (a.created || 0),
      created_asc: (a, b) => (a.created || 0) - (b.created || 0),
      alpha: (a, b) => a.name.localeCompare(b.name, "fr", { numeric: true, sensitivity: "base" }),
      best: (a, b) => (score(b.review) ?? 0) - (score(a.review) ?? 0) || b.updated - a.updated,
      worst: (a, b) => (score(a.review) ?? 9) - (score(b.review) ?? 9) || b.updated - a.updated,
    };
    const holder = h("div");
    const draw = () => {
      const inCur = (p) => cur === "all" || (cur === "none" ? !assign[p.id] : assign[p.id] === cur);
      const pool = projects.filter(inCur);
      const list = pool.filter(p => !q || p.name.toLowerCase().includes(q)).sort(CMP[sort] || CMP.updated);
      holder.textContent = "";
      holder.append(view === "list" ? this.projectList(list, inBooks) : this.projectGrid(list));
      count.textContent = q ? `${list.length} / ${pool.length}` : String(pool.length);
      this.paintCalc();
      this.dragSetup(holder, selected, async (pids, fid) => {       // glisse-depose : vers un projet, ou « sans projet »
        for (const pid of pids) { if (fid) assign[pid] = fid; else delete assign[pid]; }
        selected.clear(); await saveFolders(); drawBar(); draw();
        const n = pids.length, s = n > 1 ? "s" : "";
        toast(fid ? `${n} planche${s} rangée${s} dans « ${folders.find(f => f.id === fid).name} »` : `${n} planche${s} sortie${s} de leur projet`);
      });
    };
    const count = h("span.muted");
    // barre des projets : Toutes / Sans projet / un bouton par projet (cible de glisse-depose) / + Nouveau projet
    const bar = h("div.fbar");
    const nOf = (k) => k === "all" ? projects.length : k === "none" ? projects.filter(p => !assign[p.id]).length
                                                     : projects.filter(p => assign[p.id] === k).length;
    const drawBar = () => {
      bar.textContent = "";
      const chip = (key, label, color, fid) => {
        const b = h("button.fchip" + (cur === key ? ".on" : ""), { "data-folder": fid === undefined ? null : fid,
          title: fid ? "Clic : afficher · double-clic : renommer / supprimer · glisse des planches dessus pour les ranger"
                     : key === "none" ? "Glisse des planches ici pour les sortir de leur projet" : "",
          on: { click: () => { cur = key; setPref("ac-folder", key); drawBar(); draw(); },
                dblclick: fid ? () => this.folderMenu(fid, folders, assign, saveFolders, () => { drawBar(); draw(); }) : null } },
          color ? h("i.fdot", { style: "background:" + color }) : null, h("span", label), h("small", String(nOf(key))));
        return b;
      };
      bar.append(chip("all", "Toutes", null), chip("none", "Sans projet", null, ""));
      for (const f of folders) bar.append(chip(f.id, f.name, f.color, f.id));
      if (folders.some(f => f.id === cur)) bar.append(h("button.fchip.fedit", { title: "Renommer, changer la couleur ou supprimer ce projet",
        on: { click: () => this.folderMenu(cur, folders, assign, saveFolders, () => { drawBar(); draw(); }) } }, "✎ Modifier ce projet"));
      bar.append(h("button.fchip.fnew", { on: { click: () => this.folderMenu(null, folders, assign, saveFolders, () => { drawBar(); draw(); },
        (id) => { cur = id; setPref("ac-folder", id); }) } }, "+ Nouveau projet"));
    };
    const search = h("input.search", { type: "search", placeholder: "Rechercher une planche…" });
    search.addEventListener("input", () => { q = search.value.trim().toLowerCase(); draw(); });
    const sortSel = h("select", { title: "Ordre des planches" },
      [["updated", "Modifiées récemment"], ["created", "Créées récemment"], ["created_asc", "Plus anciennes d'abord"],
       ["alpha", "Ordre alphabétique"], ["best", "Mieux notées"], ["worst", "À retoucher d'abord"]].map(([v, l]) => h("option", { value: v }, l)));
    sortSel.value = sort;
    sortSel.addEventListener("change", () => { sort = sortSel.value; setPref("ac-home-sort", sort); draw(); });
    const seg = h("div.seg", [["grid", "Vignettes"], ["list", "Liste"]].map(([k, l]) => {
      const b = h("button" + (k === view ? ".on" : ""), { on: { click: () => {
        view = k; setPref("ac-home-view", k);
        seg.querySelectorAll("button").forEach(x => x.classList.toggle("on", x === b)); draw();
      } } }, l);
      return b;
    }));
    // livres : replies (titre seulement) ou deplies (pages, ajout, apercu, publication)
    const open = new Set(JSON.parse(pref("ac-books-open", "[]")));
    this.bookOpen = (id, on) => { if (on) open.add(id); else open.delete(id); setPref("ac-books-open", JSON.stringify([...open])); };
    const bookList = h("div.books", books.length ? books.map(b => this.bookRow(b, books, projects, open.has(b.id)))
                                                 : h("p.muted", "Aucun livre pour l'instant."));
    const allBooks = (on) => { for (const b of books) this.bookOpen(b.id, on); this.home(); };
    // onglets Planches | Livres : on passe de l'un a l'autre sans faire defiler la page ; l'onglet est retenu
    const newPlanche = h("button.primary", { on: { click: () => this.newProjectDialog(cur !== "all" && cur !== "none" ? cur : null) } }, "+ Nouvelle planche");
    const newBook = h("button.primary", { on: { click: async () => {
      const id = Math.random().toString(36).slice(2, 8);
      books.push({ id, title: "Nouveau livre", pages: [] });
      this.bookOpen(id, true);
      setPref("ac-tab", "livres");
      await put("books", books); this.home();
    } } }, "+ Nouveau livre");
    const bookTools = [h("button.mini", { on: { click: () => allBooks(true) } }, "Tout déplier"),
                       h("button.mini", { on: { click: () => allBooks(false) } }, "Tout replier")];
    drawBar();
    let tab = pref("ac-tab", "planches");
    const planchesPane = h("div", h("div.home-tools", count, h("span.sp"), search, sortSel, seg, newPlanche), bar, holder);
    const livresPane = h("div", h("div.home-tools", h("span.sp"), ...bookTools, newBook), bookList);
    const tabsEl = h("div.tabs");
    const syncTabs = () => {
      tabsEl.textContent = "";
      for (const [k, label, n] of [["planches", "Planches", h("small", String(projects.length))], ["livres", "Livres", h("small", String(books.length))]]) {
        const t = h("button.tab" + (tab === k ? ".on" : ""), { on: { click: () => { tab = k; setPref("ac-tab", k); syncTabs(); } } }, label, " ", n);
        tabsEl.append(t);
      }
      planchesPane.hidden = tab !== "planches"; livresPane.hidden = tab !== "livres";
    };
    syncTabs();
    this.root.append(h("main.home", tabsEl, planchesPane, livresPane));
    draw();
  }

  projectGrid(list) {
    return h("div.cards",
      list.map(p => h("a.card", { href: "#p=" + p.id, "data-pid": p.id },
        h("div.thumb", p.thumb ? h("img", { src: p.thumb + "?t=" + Math.round(p.updated), loading: "lazy" })
                               : h("div.noimg", { style: ratio(p) }), h("span.calc")),
        h("div", h("b", p.name), stars(p.review),
          h("small", `${p.panels} cases · ${p.videos || 0} vidéo${(p.videos || 0) > 1 ? "s" : ""} · ${fmtDate(p.updated)}`)))));
  }

  projectList(list, inBooks) {
    return h("div.plist",
      h("div.prow.head", h("span"), h("span", "Planche"), h("span", "Note"), h("span", "Cases"), h("span", "Créée"), h("span", "Modifiée"),
        h("span", "Livres")),
      list.map(p => h("a.prow", { href: "#p=" + p.id, "data-pid": p.id },
        h("span.lthumb", p.thumb ? h("img", { src: p.thumb + "?t=" + Math.round(p.updated), loading: "lazy" }) : h("i")),
        h("span.lname", h("b", p.name), h("span.calc")),
        stars(p.review),
        h("span", String(p.panels)),
        h("span.muted", p.created ? fmtDate(p.created) : "—"),
        h("span.muted", fmtDate(p.updated)),
        h("span.muted.lbooks", inBooks(p.id).join(", ") || "—"))),
      list.length ? null : h("p.muted", "Aucune planche."));
  }

  // pastilles « export en cours » sur les planches et les livres de l'accueil
  paintCalc() {
    if (!this.root) return;
    const by = {};
    for (const t of this.exports || []) by[t.project] = t;
    const paint = (badge, t) => {
      if (!badge) return;
      if (!t) { badge.className = "calc"; badge.textContent = ""; badge.title = ""; return; }
      badge.className = "calc " + (t.status === "running" ? "run" : "wait");
      badge.textContent = t.status === "running" ? `● export ${Math.round((t.progress || 0) * 100)} %` : "export en file";
      badge.title = t.message || "";
    };
    for (const el of this.root.querySelectorAll("[data-pid]")) paint(el.querySelector(".calc"), by[el.dataset.pid]);
    for (const el of this.root.querySelectorAll("[data-book]")) {
      const t = (el.dataset.pages || "").split(",").map(pid => by[pid]).find(Boolean);
      paint(el.querySelector(".bhead .calc"), t);
    }
  }

  bookRow(b, books, projects, open) {
    const save = async () => { await put("books", books); };
    let el = null;
    const redraw = (o = open) => { const n = this.bookRow(b, books, projects, o); el.replaceWith(n); this.paintCalc(); };
    const toggle = () => { this.bookOpen(b.id, !open); redraw(!open); };
    const n = b.pages.length;
    const head = h("div.bhead",
      h("button.icon.chev", { title: open ? "Replier" : "Déplier", on: { click: toggle } }, open ? "▾" : "▸"));
    if (open) {
      const title = h("input.btitle", { value: b.title });
      title.addEventListener("change", () => { b.title = title.value; save(); });
      head.append(title);
    } else {
      head.append(h("b.btitle-ro", { on: { click: toggle } }, b.title));
    }
    const tot = { ok: 0, todo: 0, redo: 0 };
    for (const pid of b.pages) { const r = projects.find(x => x.id === pid)?.review; if (r) for (const k in tot) tot[k] += r[k] || 0; }
    head.append(h("span.muted", `${n} page${n > 1 ? "s" : ""}`), n ? stars(tot) : h("span"), h("span.calc"));
    el = h("div.book" + (open ? ".open" : ""), { "data-book": b.id, "data-pages": b.pages.join(",") }, head);
    if (!open) return el;
    // les pages du livre, en vignettes numerotees (ordre de lecture) ; clic = ouvrir / apercu / edition
    const move = (i, d) => { [b.pages[i + d], b.pages[i]] = [b.pages[i], b.pages[i + d]]; save().then(() => redraw()); };
    const pages = h("div.bpages", n ? b.pages.map((pid, i) => {
      const p = projects.find(x => x.id === pid);
      return h("div.bpage", { "data-pid": pid },
        h("span.bnum", String(i + 1)),
        h("button.bthumb", { title: "Ouvrir la planche, aperçu, édition…", on: { click: (e) => this.pageMenu(e.currentTarget, b, i, pid) } },
          p?.thumb ? h("img", { src: p.thumb + "?t=" + Math.round(p.updated), loading: "lazy" }) : h("div.noimg", { style: ratio(p) }),
          h("span.calc")),
        h("small", { title: p ? p.name : pid }, p ? p.name : pid + " (supprimée)"),
        p ? stars(p.review) : null,
        h("div.row",
          h("button.mini", { title: "Avancer d'une place", disabled: i === 0, on: { click: () => move(i, -1) } }, "◀"),
          h("button.mini", { title: "Reculer d'une place", disabled: i === n - 1, on: { click: () => move(i, 1) } }, "▶"),
          h("button.mini", { title: "Retirer du livre", on: { click: () => { b.pages.splice(i, 1); save().then(() => redraw()); } } }, "✕")));
    }) : h("p.muted", "Aucune page : ajoute des planches ci-dessous."));
    const add = h("select", projects.slice().sort((x, y) => x.name.localeCompare(y.name, "fr", { numeric: true }))
                                    .map(p => h("option", { value: p.id }, p.name)));
    const addBtn = h("button", { on: { click: async () => {
      if (!add.value) return;
      b.pages.push(add.value); await save();
      toast(`« ${add.selectedOptions[0].textContent} » ajoutée : le livre a ${b.pages.length} page${b.pages.length > 1 ? "s" : ""}.`, "ok");
      redraw();
    } } }, "+ Ajouter cette planche");
    const act = async (what) => {
      if (what === "publish" && b.pages.length < 2 && !confirm(`Ce livre n'a que ${b.pages.length} page : on ne pourra pas tourner les pages. Publier quand même ?`)) return;
      const tab = what === "export" ? openPending("Assemblage du livre…") : null;
      if (what === "publish") toast("Publication du livre…");
      try {
        const res = await post(`books/${b.id}/${what}`);
        if (what === "export") showIn(tab, res.url);
        else this.publishedDialog(res.url);
      } catch (e) { if (tab) tab.close(); toast(e.message, "error", 9000); }
    };
    el.append(pages, h("div.row", add, addBtn),
      h("div.row",
        h("button", { on: { click: () => act("export") } }, "Aperçu"),
        h("button.primary", { on: { click: () => act("publish") } }, "Publier le livre"),
        h("button.mini", { on: { click: async () => {
          if (!confirm("Supprimer ce livre (les planches restent) ?")) return;
          books.splice(books.indexOf(b), 1); await save(); el.remove();
        } } }, "Supprimer le livre")));
    return el;
  }

  // clic sur une page d'un livre : l'ouvrir dans l'application, son apercu, ou l'apercu en mode edition
  pageMenu(anchor, b, i, pid) {
    document.querySelector(".popmenu")?.remove();
    const go = async (what) => {
      menu.remove();
      if (what === "open") { location.hash = "#p=" + pid; return; }
      const tab = openPending(what.startsWith("book") ? "Assemblage du livre…" : "Assemblage de la page…");
      try {
        if (what.startsWith("book")) {
          const res = await post(`books/${b.id}/export`);
          showIn(tab, res.url + (what === "book-edit" ? "?edit=1" : "") + "#" + (i + 1));
        } else {
          const res = await post(`projects/${pid}/export`);
          showIn(tab, res.url + "?t=" + Date.now() + (what === "edit" ? "&edit=1" : ""));
        }
      } catch (e) { if (tab) tab.close(); toast(e.message, "error", 9000); }
    };
    const menu = h("div.popmenu",
      h("button", { on: { click: () => go("open") } }, "✎ Ouvrir la planche"),
      h("button", { on: { click: () => go("preview") } }, "▶ Aperçu de la page"),
      h("button", { on: { click: () => go("edit") } }, "✏️ Éditer la page (aperçu)"),
      h("button", { on: { click: () => go("book") } }, `📖 Voir dans le livre (page ${i + 1})`),
      h("button", { on: { click: () => go("book-edit") } }, "✏️ Éditer dans le livre"));
    document.body.append(menu);
    const r = anchor.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(innerWidth - menu.offsetWidth - 8, r.left)) + "px";
    menu.style.top = Math.min(innerHeight - menu.offsetHeight - 8, r.bottom + 4) + "px";
    const away = (e) => { if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener("pointerdown", away, true); } };
    setTimeout(() => document.addEventListener("pointerdown", away, true), 0);
  }

  newProjectDialog(folderId) {
    const name = h("input", { value: "Planche " + new Date().toLocaleDateString("fr-FR") });
    const fmt = h("select", FORMATS.map(f => h("option", { value: f.id }, f.label)));
    let preset = "david", orient = "portrait";
    const thumbs = h("div.preset-grid", PRESETS.map(p => {
      const b = h("button.preset" + (p.id === preset ? ".on" : ""), { title: p.label, on: { click: () => {
        preset = p.id; thumbs.querySelectorAll(".preset").forEach(x => x.classList.toggle("on", x === b));
      } } }, presetThumb(p, FORMATS[0]), h("span", p.label));
      return b;
    }));
    const redrawThumbs = () => {
      const [w, hh] = pageSize(fmt.value, orient);
      thumbs.querySelectorAll(".preset").forEach((b, i) => b.firstChild.replaceWith(presetThumb(PRESETS[i], { w, h: hh })));
    };
    fmt.addEventListener("change", redrawThumbs);
    const sens = h("div.seg", [["portrait", "Vertical"], ["paysage", "Horizontal"]].map(([k, l]) => {
      const b = h("button" + (k === orient ? ".on" : ""), { on: { click: () => {
        orient = k; sens.querySelectorAll("button").forEach(x => x.classList.toggle("on", x === b)); redrawThumbs();
      } } }, l);
      return b;
    }));
    modal("Nouvelle planche", h("div.form", h("label.field", h("span.lab", "Nom"), name), h("div.row", h("label.field", h("span.lab", "Format"), fmt), h("label.field", h("span.lab", "Sens"), sens)),
                                h("span.lab", "Découpage de départ (modifiable ensuite)"), thumbs), [
      { label: "Annuler" },
      { label: "Créer", primary: true, click: async () => {
        const [w, hh] = pageSize(fmt.value, orient);
        const page = Object.assign({}, PAGE_DEFAULTS, { format: fmt.value, orientation: orient, width: w, height: hh });
        let n = 0;
        const layout = PRESETS.find(p => p.id === preset).make(() => ({ t: "leaf", id: "p" + (++n) }));
        const p = await post("projects", { name: name.value, page, layout });
        p.nextId = n + 1;
        for (const id of leaves(layout)) p.panels[id] = NEW_PANEL();
        await put("projects/" + p.id, p);
        if (folderId) {                                              // planche creee depuis un projet : rangee dedans
          const fd = await get("folders").catch(() => ({ folders: [], assign: {} }));
          fd.assign[p.id] = folderId; await put("folders", fd);
        }
        location.hash = "#p=" + p.id;
      } }]);
  }

  // dialogue d'un projet : creer (fid null) / renommer / couleur / supprimer (les planches restent, « sans projet »)
  folderMenu(fid, folders, assign, save, redraw, onCreated) {
    const f = fid ? folders.find(x => x.id === fid) : { id: Math.random().toString(36).slice(2, 8), name: "", color: "#b36bff" };
    const name = h("input", { value: f.name, placeholder: "Nom du projet (ex. Mariage Provence)" });
    const color = h("input", { type: "color", value: f.color });
    modal(fid ? "Projet" : "Nouveau projet", h("div.form", h("label.field", h("span.lab", "Nom"), name), h("label.field", h("span.lab", "Couleur"), color)), [
      { label: "Annuler" },
      fid ? { label: "Supprimer le projet", click: async () => {
        if (!confirm(`Supprimer le projet « ${f.name} » ? Les planches ne sont pas supprimées : elles passent « sans projet ».`)) return false;
        folders.splice(folders.indexOf(f), 1);
        for (const k of Object.keys(assign)) if (assign[k] === fid) delete assign[k];
        await save(); this.home();
      } } : null,
      { label: fid ? "Enregistrer" : "Créer", primary: true, click: async () => {
        f.name = name.value.trim() || "Projet"; f.color = color.value;
        if (!fid) { folders.push(f); onCreated?.(f.id); }
        await save(); redraw();
      } }].filter(Boolean));
    setTimeout(() => name.focus(), 50);
  }

  // glisse-depose des planches (cartes ou lignes de liste) vers les boutons de projet ; ctrl / cmd + clic = selection multiple
  dragSetup(holder, selected, onDrop) {
    for (const el of holder.querySelectorAll("[data-pid]")) {
      el.draggable = true;
      el.classList.toggle("sel", selected.has(el.dataset.pid));
      el.addEventListener("click", (e) => {
        if (!(e.ctrlKey || e.metaKey)) return;
        e.preventDefault();
        const pid = el.dataset.pid;
        if (selected.has(pid)) selected.delete(pid); else selected.add(pid);
        el.classList.toggle("sel", selected.has(pid));
      });
      el.addEventListener("dragstart", (e) => {
        const pid = el.dataset.pid;
        e.dataTransfer.setData("text/ac-planches", JSON.stringify(selected.has(pid) ? [...selected] : [pid]));
        e.dataTransfer.effectAllowed = "move";
        el.classList.add("dragging");
        document.body.classList.add("dragging-planche");
      });
      el.addEventListener("dragend", () => { el.classList.remove("dragging"); document.body.classList.remove("dragging-planche"); });
    }
    for (const chip of this.root.querySelectorAll(".fchip[data-folder]")) {
      chip.ondragover = (e) => { if ([...e.dataTransfer.types].includes("text/ac-planches")) { e.preventDefault(); chip.classList.add("over"); } };
      chip.ondragleave = () => chip.classList.remove("over");
      chip.ondrop = (e) => {
        e.preventDefault(); chip.classList.remove("over");
        const pids = JSON.parse(e.dataTransfer.getData("text/ac-planches") || "[]");
        if (pids.length) onDrop(pids, chip.dataset.folder || null);
      };
    }
  }


  // ================================================================ espace de travail
  async open(pid) {
    try { this.project = await get("projects/" + pid); this._rev = this.project.rev; this._savedSig = null; }
    catch (e) { toast(e.message, "error"); location.hash = ""; return; }
    const P = this.project;
    P.page = Object.assign({}, PAGE_DEFAULTS, P.page);
    if (P.page.format === "paysage") Object.assign(P.page, { format: "ecran", orientation: "paysage" });
    P.nextId = P.nextId || (Math.max(0, ...leaves(P.layout).map(id => +id.slice(1) || 0)) + 1);
    for (const id of leaves(P.layout)) P.panels[id] = Object.assign(NEW_PANEL(), P.panels[id] || {});
    ensureCutIds(P.layout);                              // chaque trait a un identifiant (pistes d'animation)
    P.anim = P.anim && P.anim.tracks ? P.anim : { tracks: {} };
    const keepAnim = this.animMode && this._reloading;
    this.selected = null; this.undo = []; this.redo = [];
    this.animPlaying = false;
    if (!keepAnim) { this.animMode = false; this.animT = 0; this.selectedCut = null; }
    this.timeline = null;
    this.root.textContent = "";
    this.root.append(this.topbar(false));
    this.left = h("aside.left");
    this.center = h("section.center");
    this.right = h("aside.right");
    this.tlHost = h("div.tlhost", { hidden: true });
    this.root.append(h("div.work", this.left, this.center, this.right), this.tlHost);
    this.editor = new Editor(this.center, this);
    this.editor.render();
    this.renderLeft();
    this.refreshInspector();
    if (keepAnim) this.setAnimMode(true);
    this.save(true);
  }

  topbar(home) {
    const P = this.project;
    const bar = h("header.top",
      h("a.logo", { href: "#" }, "ALIVE ", h("b", "VIDEO")),
      home ? h("span.muted", "Planches de BD en vidéo") : null);
    if (!home) {
      const name = h("input.pname", { value: P.name, title: "Nom de la planche" });
      name.addEventListener("change", () => { P.name = name.value; this.save(); });
      bar.append(name,
        h("button.icon", { title: "Annuler (Ctrl+Z)", on: { click: () => this.doUndo() } }, "↶"),
        h("button.icon", { title: "Rétablir (Ctrl+Y)", on: { click: () => this.doRedo() } }, "↷"));
      this.animBtn = h("button.animbtn" + (this.animMode ? ".on" : ""), {
        title: "Animer le cadrage : une timeline s'ouvre, chaque attache des traits a sa ligne ; glisser une attache pose une clé",
        on: { click: () => this.setAnimMode(!this.animMode) } }, "🎞 Animate framing");
      bar.append(this.animBtn);
    }
    this.exportChip = h("span.calc.top-calc");
    bar.append(h("span.sp"), this.exportChip);
    if (!home) {
      bar.append(
        h("button.primary", { on: { click: () => this.exportDialog() } }, icon("video"), " Exporter la vidéo"),
        h("button", { on: { click: () => this.preview() } }, "Aperçu"),
        h("button", { title: "Aperçu en mode édition : lecture, couleur, cadrage, filtres, sons de chaque case",
                      on: { click: () => this.preview(true) } }, "✏️ Éditer"),
        h("button", { title: "Ouvrir le dossier de la page (index.html, vidéos, sons)", on: { click: () => this.revealFolder() } }, "📁 Dossier"),
        h("button", { on: { click: () => this.publishDialog() } }, "Publier"));
    }
    bar.append(h("button.icon", { title: "Réglages", on: { click: () => this.settingsDialog() } }, "⚙"));
    return bar;
  }

  // ---------------------------------------------------------------- colonne gauche : decoupage
  renderLeft() {
    const P = this.project;
    const f = { w: P.page.width, h: P.page.height };
    const grid = h("div.preset-grid.small", PRESETS.map(p =>
      h("button.preset", { title: p.label, on: { click: () => this.applyPreset(p.make) } }, presetThumb(p, f), h("span", p.label))));
    const count = h("input", { type: "range", min: 2, max: 9, value: 5 });
    const tilt = h("input", { type: "range", min: 0, max: 12, value: 5 });
    const rnd = h("button", { on: { click: () => {
      this.applyPreset((L) => randomLayout(Math.random() * 1e9 | 0, +count.value, tilt.value / 100, () => L().id));
    } } }, "🎲 Variante au hasard");
    const sel = this.selected;
    this.left.textContent = "";
    this.left.append(
      h("h3", "Découpage"), grid,
      h("div.form", h("label.field", h("span.lab", "Cases (hasard)"), count), h("label.field", h("span.lab", "Inclinaison"), tilt), rnd,
        h("button", { title: "Les bandes deviennent des colonnes et inversement", on: { click: () => {
          const before = this.snapshot(); P.layout = transpose(P.layout); this.pushUndo(before);
          this.editor.render(); this.save(); this.pageSoon();
        } } }, "↻ Pivoter le découpage")),
      h("h3", "Case sélectionnée"),
      sel ? h("div.form",
        h("button", { on: { click: () => this.splitSelected("h") } }, "Couper en deux ━"),
        h("button", { on: { click: () => this.splitSelected("v") } }, "Couper en deux ┃"),
        h("button.danger", { on: { click: () => this.deleteSelected() } }, "Supprimer la case"))
        : h("p.muted", "Clique une case. Glisse un trait pour le déplacer, ses bouts pour l'incliner (Maj : trait droit)."));
  }

  applyPreset(make) {
    const P = this.project;
    const before = this.snapshot();
    const order = compute(P.page, P.layout).panels.map(g => g.id);
    const layout = ensureCutIds(make(() => ({ t: "leaf", id: "p" + (P.nextId++) })));
    const fresh = compute(P.page, layout).panels.map(g => g.id);
    const panels = {};
    fresh.forEach((id, i) => {        // les videos et images suivent l'ordre de lecture
      const old = order[i] ? P.panels[order[i]] : null;
      panels[id] = old ? Object.assign({}, old) : NEW_PANEL();
    });
    if (Object.keys(P.anim.tracks || {}).length) toast("Nouveau découpage : l'animation du cadrage est retirée (Ctrl+Z pour revenir).");
    P.layout = layout; P.panels = panels; P.anim = { tracks: {} };
    this.selected = null; this.selectedCut = null;
    this.pushUndo(before);
    this.timeline?.render();
    this.editor.render(); this.renderLeft(); this.refreshInspector();
    this.save(); this.pageSoon();
  }

  splitSelected(dir) {
    const P = this.project, id = this.selected;
    const before = this.snapshot();
    const nid = "p" + (P.nextId++);
    P.layout = splitLeaf(P.layout, id, dir, nid);
    P.panels[nid] = NEW_PANEL();
    this.pushUndo(before);
    this.editor.render(); this.renderLeft(); this.save(); this.pageSoon();
  }

  deleteSelected() {
    const P = this.project, id = this.selected;
    if (leaves(P.layout).length < 2) return toast("Il faut garder au moins une case.");
    const before = this.snapshot();
    P.layout = removeLeaf(P.layout, id);
    delete P.panels[id];
    this.selected = null;
    this.pushUndo(before);
    this.editor.render(); this.renderLeft(); this.refreshInspector(); this.save(); this.pageSoon();
    toast("Case supprimée (Ctrl+Z pour annuler).");
  }

  // ---------------------------------------------------------------- inspecteur
  select(id) {
    this.selected = id;
    this.editor.render();
    this.renderLeft();
    this.refreshInspector();
  }

  panel(id) { return this.project.panels[id] = this.project.panels[id] || NEW_PANEL(); }

  refreshInspector() {
    if (!this.right) return;
    const id = this.selected;
    this.right.textContent = "";
    if (!id) {
      this.right.append(h("h3", "Page"), pageForm(this),
        h("p.muted", "Astuce : glisse une vidéo directement sur une case. Chaque case a ses icônes : média, filtres, sons."));
      return;
    }
    const g = this.editor.geom.panels.find(x => x.id === id);
    const panel = this.panel(id);
    this.right.append(...[
      h("h3", `Case ${g ? g.order : ""}`),
      section(panel.image ? "Image" : "Vidéo", panel.image ? "image" : "video", mediaForm(this, id)),
      media(panel) ? section(panel.video ? "Lecture et effets" : "Effets", "filters", playForm(this, id)) : null,
      section("Sons", "audio", soundsForm(this, id))].filter(Boolean));
  }

  audioLabel(panel) {
    const parts = [];
    if (panel.video?.audio) parts.push("son de la vidéo" + ((panel.edit || {}).volume === 0 ? " (muet)" : ""));
    const n = (panel.extraSounds || []).length;
    if (n) parts.push(`${n} son${n > 1 ? "s" : ""} ajouté${n > 1 ? "s" : ""}`);
    return parts.join(" + ") || "aucun";
  }

  hasSound(panel) { return (panel.extraSounds || []).length > 0; }

  panelTag(panel) {
    const e = panel.edit || {}, parts = [];
    if (panel.video) {
      const v = panel.video, n = v.frames || 1, r = Array.isArray(e.range) ? e.range : [0, n - 1];
      parts.push("▶ " + fmtSec((r[1] - r[0] + 1) / (v.fps_f || 25) / (e.speed || 1)));
      if (e.speed && e.speed !== 1) parts.push("× " + String(e.speed).replace(".", ","));
      if (e.reverse) parts.push("◀ envers");
      if (e.loop === false) parts.push("une fois");
    } else parts.push("image");
    const fl = (e.filters || []).filter(f => f.on !== false).length;
    if (fl) parts.push(`${fl} effet${fl > 1 ? "s" : ""}`);
    return parts.join(" · ");
  }

  panelStatus() { return null; }

  // menu d'une icone dans la case
  panelMenu(id, kind, anchor) {
    document.querySelectorAll(".popover").forEach(p => p.remove());
    const r = anchor.getBoundingClientRect();            // avant select() : il redessine les icones
    if (this.selected !== id) this.select(id);
    if (kind === "image" || kind === "video") return this.pickMedia(id);
    if (kind === "filters") return this.editInPreview(id);
    const pop = h("div.popover", h("div.pop-head", icon(kind), h("b", "Sons de la case"),
                                   h("button.icon", { on: { click: () => pop.remove() } }, "✕")), soundsForm(this, id));
    document.body.append(pop);
    pop.style.left = Math.min(window.innerWidth - 340, Math.max(8, r.left)) + "px";
    pop.style.top = Math.min(window.innerHeight - 80, r.bottom + 6) + "px";
    const close = (e) => { if (!pop.contains(e.target) && e.target !== anchor) { pop.remove(); document.removeEventListener("pointerdown", close, true); } };
    setTimeout(() => document.addEventListener("pointerdown", close, true));
  }

  // ---------------------------------------------------------------- import
  pickMedia(id, kind) {
    const accept = kind === "image" ? "image/*" : kind === "video" ? "video/*" : "video/*,image/*";
    pickFile(accept, (f) => (f.type.startsWith("video/") || VIDEO_EXT.test(f.name) ? this.importVideo(id, f) : this.importImage(id, f)));
  }
  pickAudio(id) { pickFile("audio/*", (f) => this.importAudio(id, f)); }

  async importImage(id, file) {
    try {
      await this.flushAll();
      await upload(`projects/${this.project.id}/panels/${id}/image?name=${encodeURIComponent(file.name)}`, file);
      await this.reloadPanel(id);
      toast("Image posée dans la case.", "ok");
    } catch (e) { toast(e.message, "error"); }
  }

  // video : l'original est garde, le serveur fait la copie de lecture et l'affiche (quelques secondes)
  async importVideo(id, file) {
    const mb = Math.round(file.size / 1e5) / 10;
    const veil = h("div.veil", h("div", h("b", "Vidéo : " + file.name), h("p.muted", `Envoi (${mb} Mo) et préparation de la copie de lecture…`)));
    document.body.append(veil);
    try {
      await this.flushAll();
      await upload(`projects/${this.project.id}/panels/${id}/video?name=${encodeURIComponent(file.name)}`, file);
      await this.reloadPanel(id);
      const v = this.panel(id).video;
      toast(`Vidéo posée : ${v.w} × ${v.h}, ${fmtSec(v.duration)}${v.audio ? ", avec son" : ", sans son"}.`, "ok");
    } catch (e) { toast(e.message, "error", 9000); }
    finally { veil.remove(); }
  }

  // la case a ete changee par le serveur (media importe) : on reprend sa version, le reste de la planche ne bouge pas
  async reloadPanel(id) {
    const before = this.snapshot();
    const server = await get("projects/" + this.project.id);
    this.project.panels[id] = Object.assign(NEW_PANEL(), server.panels[id] || {});
    this._rev = server.rev;
    this.pushUndo(before);
    this.select(id);
    this.save(); this.pageSoon();
  }

  async importAudio(id, file) {
    try {
      const res = await uploadSound(`projects/${this.project.id}/panels/${id}/sound?name=${encodeURIComponent(file.name)}`, file);
      this.panel(id).extraSounds = res.extra;
      this.refreshInspector(); this.editor.renderOverlay();
      toast(res.reused ? "Son déjà importé : le fichier existant est réutilisé." : "Son ajouté à la case.", "ok");
    } catch (e) { toast(e.message, "error"); }
  }

  // retouches (lecture, effets) : ecrites par le serveur (comme dans l'apercu), jamais par l'enregistrement de la planche
  setEdit(id, fn) {
    const panel = this.panel(id);
    panel.edit = Object.assign({}, panel.edit);
    fn(panel.edit);
    this.editor.renderOverlay();
    clearTimeout(this.editSoon.get(id));
    this.editSoon.set(id, setTimeout(async () => {
      try {
        const res = await post(`projects/${this.project.id}/edit/${id}`, { edit: panel.edit });
        panel.edit = res.project.panels[id].edit || {};
        this._rev = res.project.rev;
      } catch (e) { toast(e.message, "error"); }
    }, 500));
  }

  async saveExtras(id, redraw) {
    const panel = this.panel(id);
    try {
      const res = await post(`projects/${this.project.id}/edit/${id}`,
                             { extra: (panel.extraSounds || []).map(x => ({ file: x.file, volume: x.volume, loop: x.loop })) });
      panel.extraSounds = res.project.panels[id].extraSounds || [];
      this._rev = res.project.rev;
      if (redraw) { this.refreshInspector(); this.editor.renderOverlay(); }
    } catch (e) { toast(e.message, "error"); }
  }

  // ---------------------------------------------------------------- historique et enregistrement
  snapshot() {
    const P = this.project;
    return JSON.stringify({ page: P.page, layout: P.layout, panels: P.panels, nextId: P.nextId, pageSound: P.pageSound, anim: P.anim });
  }
  pushUndo(snap) { this.undo.push(snap); if (this.undo.length > 80) this.undo.shift(); this.redo = []; }
  restore(snap) {
    Object.assign(this.project, JSON.parse(snap));
    if (this.selected && !this.project.panels[this.selected]) this.selected = null;
    this.timeline?.render();
    this.editor.render(); this.renderLeft(); this.refreshInspector(); this.save(); this.pageSoon();
  }
  doUndo() { if (this.undo.length) { this.redo.push(this.snapshot()); this.restore(this.undo.pop()); } }
  doRedo() { if (this.redo.length) { this.undo.push(this.snapshot()); this.restore(this.redo.pop()); } }

  commit(kind) {
    if (this._last && this._lastKind === kind && Date.now() - this._lastT < 1200) { /* meme geste : une seule etape */ }
    else if (this._last) this.pushUndo(this._last);
    this._last = this.snapshot(); this._lastKind = kind; this._lastT = Date.now();
    this.editor?.renderOverlay();
    this.save();
    if (kind !== "panel") this.pageSoon();
  }

  // la page finie : le decoupage a la fin de l'animation du cadrage (le decoupage tout court s'il n'y en a pas)
  finalGeom() {
    const P = this.project;
    return compute(P.page, layoutAt(P.layout, P.anim, animEnd(P.anim)));
  }

  geometryForSave() {
    const g = this.finalGeom();
    return { size: [this.project.page.width, this.project.page.height],
             panels: g.panels.map(p => ({ id: p.id, order: p.order, rect: [p.bbox.x0, p.bbox.y0, p.bbox.x1, p.bbox.y1].map(v => Math.round(v * 10) / 10),
                                          poly: p.poly.map(([x, y]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10]) })) };
  }

  async save(first) {
    if (!this.project) return;
    this.cleanAnim();
    this.project.geometry = this.geometryForSave();
    if (!this._last) this._last = this.snapshot();
    const sig = this.snapshot();
    try {
      const saved = await put("projects/" + this.project.id, this.project);
      this._rev = saved.rev;
      const untouched = this.snapshot() === sig;
      this.absorb(saved);
      this._savedSig = untouched ? this.snapshot() : sig;
      if (first && !saved.thumb) this.pageSoon();
    } catch (e) {
      if (!this._retrySave) toast("Serveur injoignable : l'enregistrement sera retenté automatiquement.", "error", 6000);
      clearTimeout(this._retrySave);
      this._retrySave = setTimeout(() => { this._retrySave = null; this.save(); }, 3000);
      return;
    }
    if (this._retrySave) { clearTimeout(this._retrySave); this._retrySave = null; }
  }

  // reprend ce que le serveur et l'apercu ecrivent (retouches, sons ajoutes, suivi, reglages d'export)
  absorb(server) {
    for (const [id, sp] of Object.entries(server.panels || {})) {
      const lp = this.project.panels[id];
      if (!lp) continue;
      for (const k of ["edit", "extraSounds", "review"]) { if (k in sp) lp[k] = sp[k]; else delete lp[k]; }
    }
    this.project.published = server.published;
    this.project.export = server.export;
    if (server.pageSound) {
      const ps = this.project.pageSound = this.project.pageSound || {};
      if ((server.pageSound.rev || 0) > (ps.rev || 0)) Object.assign(ps, server.pageSound);
    }
  }

  async uploadPage(strict) {
    if (!this.project) return;
    const sig = this.pageSig();
    try { await pageImages(this.project, this.finalGeom()); this._pageSig = sig; }
    catch (e) { if (strict) throw e; console.warn(e); }
  }

  // planche modifiee ailleurs (apercu en mode edition, pilotage par API) : on recharge si rien n'est en cours ici
  async watchRev() {
    if (!this.project || this._reloading) return;
    try {
      const r = await get(`projects/${this.project.id}/rev`);
      if (this._rev == null) { this._rev = r.rev; return; }
      if (r.rev > this._rev && this.snapshot() === this._savedSig && !this.animPlaying && !this.editor?.drag
          && !document.querySelector(".popover, .modal-back, .veil")) {
        this._reloading = true;
        const keep = this.selected;
        await this.open(this.project.id);
        if (keep && this.project.panels[keep]) this.select(keep);
        this._reloading = false;
      }
      this._rev = Math.max(this._rev, r.rev);
    } catch (e) { this._reloading = false; }
  }

  // exports en cours : pastilles de l'accueil, pastille de la barre du haut
  async poll() {
    try { this.exports = await get("exports"); } catch (e) { return; }
    if (this.project) {
      this.watchRev();
      const t = this.exports.find(x => x.project === this.project.id);
      if (this.exportChip) {
        this.exportChip.className = "calc top-calc" + (t ? (t.status === "running" ? " run" : " wait") : "");
        this.exportChip.textContent = t ? (t.status === "running" ? `● export ${Math.round(t.progress * 100)} %` : "export en file") : "";
        this.exportChip.onclick = t ? () => this.exportDialog() : null;
      }
    } else this.paintCalc();
  }

  // ---------------------------------------------------------------- apercu, export, publication
  pageSig() {
    const P = this.project;
    return JSON.stringify({ page: P.page, layout: P.layout, anim: P.anim,
                            imgs: Object.fromEntries(Object.entries(P.panels).map(([k, v]) => [k, [media(v)?.url, v.view]])) });
  }

  async flushAll() {
    if (this.snapshot() !== this._savedSig) await this.save();
    if (this.pageSig() !== this._pageSig) await this.uploadPage(true);
  }

  async preview(edit, caseId) {
    // l'onglet s'ouvre AU CLIC : ouvert apres l'assemblage (plusieurs secondes), le navigateur le bloquerait
    const tab = openPending("Assemblage de la page…");
    try {
      await this.flushAll();
      const res = await post(`projects/${this.project.id}/export`);
      showIn(tab, res.url + "?t=" + Date.now() + (edit ? "&edit=1" : "") + (caseId ? "&case=" + caseId : ""));
    } catch (e) { if (tab) tab.close(); toast(e.message, "error", 9000); }
  }

  editInPreview(id) { this.preview(true, id); }

  async revealFolder() {
    try { await this.flushAll(); await post(`projects/${this.project.id}/reveal`); }
    catch (e) { toast(e.message, "error"); }
  }

  // export video de la page : duree, resolution (petit cote), images par seconde ; suivi de l'avancement
  async exportDialog() {
    const P = this.project;
    await this.flushAll().catch(() => {});
    let info;
    try { info = await get(`projects/${P.id}/video`); } catch (e) { return toast(e.message, "error"); }
    const s = info.settings;
    const auto = h("input", { type: "checkbox", checked: !s.duration });
    const dur = h("input", { type: "number", min: 0.5, max: 600, step: 0.1, value: s.duration || info.auto, disabled: !s.duration, style: { width: "90px" } });
    auto.addEventListener("change", () => { dur.disabled = auto.checked; if (auto.checked) dur.value = info.auto; });
    const [PW, PH] = [P.page.width, P.page.height];
    const sizeOf = (short) => {
      const k = short / Math.min(PW, PH), ev = (x) => Math.max(2, Math.round(x / 2) * 2);
      return `${ev(PW * k)} × ${ev(PH * k)}`;
    };
    const res = h("select", this.presets.export.heights.map(x => h("option", { value: x }, `${x === 2160 ? "4K" : x + "p"} · ${sizeOf(x)}`)));
    res.value = s.height;
    const fps = h("select", this.presets.export.fps.map(x => h("option", { value: x }, `${x} images/s`)));
    fps.value = s.fps;
    const bar = h("div.pbar2", h("i"));
    const msg = h("p.muted", "");
    const done = h("div.form");
    const list = h("div.vlist");
    const paintList = (videos) => {
      list.textContent = "";
      for (const v of videos.slice(0, 6)) {
        list.append(h("div.vrow", h("a", { href: v.url, target: "_blank" }, v.name),
          h("small.muted", `${Math.round(v.size / 1e5) / 10} Mo · ${new Date(v.time * 1000).toLocaleString("fr-FR")}`)));
      }
    };
    paintList(info.videos);
    let timer = null;
    const watch = () => {
      clearInterval(timer);
      timer = setInterval(async () => {
        if (!document.body.contains(bar)) { clearInterval(timer); return; }
        let st;
        try { st = await get(`projects/${P.id}/video`); } catch (e) { return; }
        const t = st.task;
        if (!t) return;
        bar.firstChild.style.width = Math.round((t.progress || 0) * 100) + "%";
        msg.textContent = t.status === "error" ? "⚠ " + (t.error || "erreur") : `${Math.round((t.progress || 0) * 100)} % · ${t.message || ""}`;
        msg.className = t.status === "error" ? "err" : "muted";
        if (t.status === "done" || t.status === "error") {
          clearInterval(timer);
          go.disabled = false;
          paintList(st.videos);
          if (t.status === "done") {
            done.textContent = "";
            const m = t.meta || {};
            done.append(h("p", "✓ Vidéo prête : ", h("a", { href: t.url, target: "_blank" }, t.url.split("/").pop())),
              h("p.muted", `${m.width} × ${m.height}, ${m.fps} images/s, ${fmtSec(m.seconds)}${m.audio ? ", avec le son" : ", sans son"}.`),
              h("div.row", h("button", { on: { click: () => window.open(t.url, "_blank") } }, "▶ Ouvrir la vidéo"),
                h("button", { on: { click: () => post(`projects/${P.id}/video/reveal`).catch((e) => toast(e.message, "error")) } }, "📁 Dossier des vidéos")));
          }
        }
      }, 1000);
    };
    const go = h("button.primary", { on: { click: async () => {
      go.disabled = true;
      done.textContent = "";
      try {
        await this.flushAll();
        const body = { duration: auto.checked ? null : +dur.value, height: +res.value, fps: +fps.value };
        await post(`projects/${P.id}/video`, body);
        P.export = { duration: body.duration, height: body.height, fps: body.fps };
        msg.textContent = "en file…";
        watch();
      } catch (e) { go.disabled = false; toast(e.message, "error", 9000); }
    } } }, icon("video"), " Exporter");
    if (info.task && ["queued", "running"].includes(info.task.status)) { go.disabled = true; watch(); }
    modal("Exporter la vidéo", h("div.form",
      h("p.muted", "Toute la page, les vidéos jouant dans leurs cases, avec leurs effets et leurs sons mélangés, en un fichier MP4 (H.264, AAC)."),
      h("div.row",
        h("label.field", h("span.lab", "Durée"), h("div.row", h("label.check", auto, ` auto (${fmtSec(info.auto)} : le plus long passage)`), dur, h("span.muted", "s"))),
        h("label.field", h("span.lab", "Résolution"), res),
        h("label.field", h("span.lab", "Fréquence"), fps)),
      h("div.row", go), bar, msg, done,
      h("span.lab", "Vidéos déjà exportées"), list), [{ label: "Fermer" }]);
  }

  publishDialog() {
    const P = this.project;
    const name = h("input", { value: P.published?.name || slugify(P.name) });
    modal("Publier la planche", h("div.form",
      h("label.field", h("span.lab", "Adresse"), h("div.row", h("span.muted", (this.settings.deploy?.url || "") + "/"), name, h("span.muted", "/"))),
      h("p.muted", "La page jouable est publique pour qui a le lien, non indexée par les moteurs de recherche."),
      P.published ? h("p", "Déjà publiée : ", h("a", { href: P.published.url, target: "_blank" }, P.published.url)) : null), [
      { label: "Annuler" },
      { label: "Publier", primary: true, click: async () => {
        toast("Publication en cours (envoi des vidéos)…", "info", 8000);
        try {
          await this.flushAll();
          const res = await post(`projects/${P.id}/publish`, { name: name.value });
          P.published = { name: name.value, url: res.url };
          this.publishedDialog(res.url);
        } catch (e) { toast(e.message, "error", 10000); }
      } }]);
  }

  publishedDialog(url) {
    modal("C'est en ligne", h("div.form", h("p", h("a", { href: url, target: "_blank" }, url)),
      h("button", { on: { click: () => { navigator.clipboard?.writeText(url); toast("Lien copié.", "ok"); } } }, "Copier le lien")), [{ label: "Fermer", primary: true }]);
  }

  // ---------------------------------------------------------------- reglages
  async settingsDialog() {
    const S = await get("settings");
    const D = S.deploy;
    const inp = (k, ph) => { const e = h("input", { value: D[k] ?? "", placeholder: ph }); e.addEventListener("input", () => { D[k] = k === "port" ? +e.value : e.value; }); return e; };
    const keyBox = h("pre.key", "…");
    const body = h("div.form",
      h("h4", "Publication (hébergement SSH)"),
      h("label.field", h("span.lab", "Adresse du site"), inp("url", "https://…")),
      h("div.row", h("label.field", h("span.lab", "Hôte SSH"), inp("host", "46.202.158.181")), h("label.field", h("span.lab", "Port"), inp("port", "65002")),
        h("label.field", h("span.lab", "Utilisateur"), inp("user", "u335969729"))),
      h("label.field", h("span.lab", "Dossier du site sur le serveur"), inp("root", "domains/…/public_html")),
      h("span.lab", "Clé de ce poste (à coller dans hPanel › Avancé › Accès SSH › Ajouter une clé SSH)"), keyBox,
      h("div.row",
        h("button", { on: { click: async () => { keyBox.textContent = (await get("publish/key")).public_key; } } }, "Créer / afficher la clé de ce poste"),
        h("button", { on: { click: () => { navigator.clipboard?.writeText(keyBox.textContent); toast("Clé copiée.", "ok"); } } }, "Copier"),
        h("button", { on: { click: async () => {
          try { await put("settings", { deploy: D }); const t = await post("publish/test"); toast(t.ok ? "Connexion OK." : "Dossier introuvable sur le serveur.", t.ok ? "ok" : "error"); }
          catch (e) { toast(e.message, "error", 9000); }
        } } }, "Tester la connexion")),
      h("p.muted", `Serveur : port ${S.server?.port || 8792} (local_settings.json). ffmpeg : ${this.info.ffmpeg ? "trouvé" : "INTROUVABLE"}.`));
    modal("Réglages", body, [
      { label: "Annuler" },
      { label: "Enregistrer", primary: true, click: async () => {
        this.settings = await put("settings", S); this.info = await get("info"); toast("Réglages enregistrés.", "ok");
      } }]);
  }

  pickPageSound() {
    pickFile("audio/*", async (file) => {
      try {
        const res = await uploadSound(`projects/${this.project.id}/upload?kind=page&name=${encodeURIComponent(file.name)}`, file);
        Object.assign(this.project.pageSound = this.project.pageSound || {}, { mode: "file", file: res.file, name: file.name, rev: Date.now() / 1000 });
        this.refreshInspector(); this.save();
        toast(res.reused ? "Musique déjà importée : le fichier existant est réutilisé." : "Musique de la page importée.", "ok");
      } catch (e) { toast(e.message, "error"); }
    });
  }

  keys(e) {
    const tgt = e.target instanceof Element ? e.target : document.body;
    if (!this.project || tgt.closest("input, textarea, select")) return;
    if (this.animMode && e.code === "Space") { e.preventDefault(); this.animToggle(); return; }
    if (this.animMode && (e.key === "Delete" || e.key === "Backspace") && this.timeline?.sel) { e.preventDefault(); this.timeline.deleteKey(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? this.doRedo() : this.doUndo(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") { e.preventDefault(); this.doRedo(); }
    else if (e.key === "Delete" && this.selected) this.deleteSelected();
    else if (e.key === "Escape") { document.querySelectorAll(".popover").forEach(p => p.remove()); this.select(null); }
  }
}

// ================================================================ Animate framing (cadrage anime)
Object.assign(App.prototype, {
  // le decoupage montre dans l'editeur : a la tete de lecture en mode animation, sinon la page finie
  viewLayout() {
    const P = this.project;
    return layoutAt(P.layout, P.anim, this.animMode ? this.animT : animEnd(P.anim));
  },

  // duree de la page (meme regle que app/videoexport.py auto_duration)
  pageSeconds() {
    const P = this.project, ex = P.export || {};
    if (ex.duration) return ex.duration;
    let d = 0;
    for (const pn of Object.values(P.panels || {})) {
      const v = pn.video, e = pn.edit || {};
      if (!v || !v.frames) continue;
      const n = v.frames, r = Array.isArray(e.range) ? e.range : [0, n - 1];
      const a = Math.max(0, Math.min(n - 1, r[0] | 0)), b = Math.max(a, Math.min(n - 1, r[1] | 0));
      d = Math.max(d, (b - a + 1) / (v.fps_f || 25) / (e.speed || 1));
    }
    if (d <= 0.2) d = 5;
    const end = animEnd(P.anim);
    if (end > 0 && end + 1 > d) d = end + 1;
    return Math.min(600, d);
  },

  timelineLength() { return Math.max(1, this.pageSeconds(), animEnd(this.project.anim) + 0.5); },

  // les cles tombent sur les images de la video exportee
  snap(t) { const fps = (this.project.export || {}).fps || 30; return Math.round(t * fps) / fps; },

  setAnimMode(on) {
    this.animMode = !!on;
    this.animPlaying = false;
    if (on) {
      if (!this.timeline) this.timeline = new Timeline(this, this.tlHost);
      this.tlHost.hidden = false;
    } else {
      this.timeline?.destroy();
      this.timeline = null;
      this.tlHost.hidden = true;
      this.selectedCut = null;
    }
    document.body.classList.toggle("anim-on", this.animMode);
    this.animBtn?.classList.toggle("on", this.animMode);
    this.editor.render();
  },

  animSeek(t, live) {
    this.animT = Math.max(0, Math.min(this.timelineLength(), t));
    this.editor.render(live);
    this.timeline?.update();
  },

  animToggle() {
    this.animPlaying = !this.animPlaying;
    this.editor.wrap.classList.toggle("playing", this.animPlaying);
    if (!this.animPlaying) { this.editor.render(); this.timeline?.update(); return; }
    let last = performance.now();
    const step = (now) => {
      if (!this.animPlaying || !this.animMode || !this.project) {
        this.animPlaying = false;
        this.editor?.wrap.classList.remove("playing");
        if (this.project) { this.editor.render(); this.timeline?.update(); }
        return;
      }
      this.animT = (this.animT + (now - last) / 1000) % this.timelineLength();
      last = now;
      this.editor.render(true);
      this.timeline?.update();
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  },

  // une attache touchee dans la planche : la timeline se met sur sa ligne
  touchCut(id, mode) {
    this.selectedCut = id;
    if (this.timeline) this.timeline.selectCut(id, mode);
  },

  cutAnimated(id) {
    const T = (this.project.anim && this.project.anim.tracks) || {};
    return !!((T[id + ".a"] || []).length || (T[id + ".b"] || []).length);
  },

  // pose (ou met a jour) une cle ; une cle par image de la video exportee
  setKey(track, t, v) {
    const T = this.project.anim.tracks, keys = T[track] = T[track] || [];
    const fps = (this.project.export || {}).fps || 30;
    const k = keys.find(x => Math.abs(x.t - t) < 0.5 / fps);
    if (k) k.v = v;
    else { keys.push({ t, v, e: "ease" }); keys.sort((a, b) => a.t - b.t); }
  },

  // glisser une attache en mode animation : cle(s) a la tete de lecture ; la premiere cle d'une piste en ajoute une
  // a 0 s avec la position de depart (le trait part de la ou il etait)
  keyCut(d, a, b) {
    const P = this.project;
    P.anim.tracks = JSON.parse(JSON.stringify(d.keys0));
    const t = this.snap(this.animT);
    const ends = d.mode === "move" ? ["a", "b"] : d.mode === "end0" ? ["a"] : ["b"];
    for (const end of ends) {
      const track = `${d.id}.${end}`, start = end === "a" ? d.a : d.b;
      if (!(P.anim.tracks[track] || []).length && t > 1e-6) this.setKey(track, 0, start);
      this.setKey(track, t, end === "a" ? a : b);
    }
  },

  // glisser un trait anime hors du mode animation : toute son animation se decale d'autant
  shiftCut(d, a, b) {
    const P = this.project;
    P.anim.tracks = JSON.parse(JSON.stringify(d.keys0));
    const node = this.nodeOfCut(d.id);
    const ends = d.mode === "move" ? ["a", "b"] : d.mode === "end0" ? ["a"] : ["b"];
    for (const end of ends) {
      const delta = end === "a" ? a - d.a : b - d.b, keys = P.anim.tracks[`${d.id}.${end}`];
      if (keys && keys.length) for (const k of keys) k.v = Math.max(0, Math.min(1, k.v + delta));
      else if (node) node[end] = Math.max(0.04, Math.min(0.96, node[end] + delta));
    }
  },

  nodeOfCut(id) {
    let found = null;
    (function walk(x) { if (!x || x.t !== "split" || found) return; if (x.id === id) found = x; walk(x.c[0]); walk(x.c[1]); })(this.project.layout);
    return found;
  },

  // pistes des traits disparus (case supprimee, nouveau decoupage) retirees
  cleanAnim() {
    const P = this.project;
    if (!P.anim || !P.anim.tracks) { P.anim = { tracks: {} }; return; }
    const ids = new Set(cutIdsOf(P.layout));
    for (const k of Object.keys(P.anim.tracks)) {
      if (!ids.has(k.split(".")[0]) || !(P.anim.tracks[k] || []).length) delete P.anim.tracks[k];
    }
  },

  animChanged() {
    this.cleanAnim();
    this.timeline?.render();
    this.editor.render();
    this.commit("anim");
  },

  toast(msg, kind, ms) { toast(msg, kind, ms); },
});

function section(title, ico, body) {
  return h("section.insp", h("h4", ico ? icon(ico) : null, " ", title), body);
}

function pickFile(accept, cb) {
  const inp = h("input", { type: "file", accept, style: { display: "none" } });
  inp.addEventListener("change", () => { if (inp.files[0]) cb(inp.files[0]); inp.remove(); });
  document.body.append(inp);
  inp.click();
}

function pref(k, d) { try { return localStorage.getItem(k) || d; } catch (e) { return d; } }
function setPref(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* stockage indisponible */ } }
function fmtDate(t) {
  return new Date(t * 1000).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}
// note d'une planche d'apres ses pastilles : vert 1, orange 0,4, rouge 0 -> de 1 a 5 etoiles, par demi-etoile
function score(r) {
  const n = r ? (r.ok || 0) + (r.todo || 0) + (r.redo || 0) : 0;
  if (!n) return null;
  return Math.round((1 + 4 * ((r.ok || 0) + 0.4 * (r.todo || 0)) / n) * 2) / 2;
}
function stars(r) {
  const sc = score(r);
  if (sc == null) return h("span.stars.none", "");
  const el = h("span.stars", { title: `${String(sc).replace(".", ",")} / 5 · ${r.ok || 0} OK, ${r.todo || 0} à voir, ${r.redo || 0} à retoucher` });
  for (let i = 1; i <= 5; i++) el.append(h("i" + (sc >= i ? ".full" : sc >= i - 0.5 ? ".half" : ""), "★"));
  return el;
}
function ratio(p) { return { aspectRatio: p && p.w && p.h ? `${p.w} / ${p.h}` : "16 / 9" }; }

// onglet ouvert tout de suite (geste de l'utilisateur), rempli quand la page est prete
function openPending(message) {
  const tab = window.open("", "_blank");
  if (tab) {
    tab.document.write(`<!doctype html><meta charset="utf-8"><title>Alive Video</title>
      <body style="margin:0;background:#141414;color:#ece8e1;font:16px system-ui;display:grid;place-items:center;height:100vh">
      <p>${message}</p></body>`);
    tab.document.close();
  }
  return tab;
}

function showIn(tab, url) {
  if (tab && !tab.closed) { tab.location.href = url; return; }
  const a = h("a", { href: url, target: "_blank" }, "Ouvrir l'aperçu");
  toast(h("span", "La page est prête : ", a), "ok", 15000);
}

function slugify(t) {
  return (t || "planche").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "planche";
}

function presetThumb(p, f) {
  let n = 0;
  const layout = p.make(() => ({ t: "leaf", id: "t" + (++n) }));
  const W = f.w || f.width, H = f.h || f.height;
  const geo = compute({ width: W, height: H, margin: W * 0.04, gutter: W * 0.018 }, layout);
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.classList.add("thumb");
  for (const g of geo.panels) {
    const poly = document.createElementNS(NS, "polygon");
    poly.setAttribute("points", g.poly.map(q => q.join(",")).join(" "));
    svg.append(poly);
  }
  return svg;
}

const app = new App();
window.__alive = app;          // debogage depuis la console
app.init();
