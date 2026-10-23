/* Alive-Video : mode edition de l'apercu (« l'editeur de case »).
 *
 * Charge par book.html seulement quand la page est servie par l'application (jamais en ligne).
 * « ✏️ Éditer » puis clic sur une case : une fenetre de retouche, avec la case agrandie (meme rendu que la page).
 *   - Lecture (video) : bande d'images, debut / fin, en boucle ou une fois, vitesse ;
 *   - Couleur : saturation, luminosite, contraste, temperature, teinte (avant les effets) ;
 *   - Cadrage : zoom et position de la video dans la case ;
 *   - Filtres : opacite, vitesse, lecture inversee, volume, et la pile d'effets (flou, couleur, N&B / sepia / teinte,
 *     vignette, grain, halation, aberration chromatique), ajoutes a la demande, regles, empiles, coupes, reordonnes ;
 *     piles enregistrables en prereglages ; « copier sur toute la page » ;
 *   - Son : volume du son de la video, sons ajoutes, musique de la page.
 * Tout est enregistre au fil de l'eau (panel.edit, panel.view...) ; l'export video applique exactement les memes reglages.
 * Ouvrir directement en edition : ?edit=1 ; sur une case : ?edit=1&case=p2.
 */
(function () {
  "use strict";
  const C = window.AliveBookCtl, P = window.AlivePlayer;
  if (!C || !P) return;
  let on = false, cur = null, pop = null, lastTab = "filters", userPos = null, spec = null, userPresets = null;
  const projects = new Map();          // projet -> json
  const thumbsCache = new Map();       // video -> vignettes
  const prepared = {};                 // page -> promesse (export remis a jour)
  const clone = (o) => o == null ? o : JSON.parse(JSON.stringify(o));
  const fmt = (v, d = 2) => (Math.round(v * 10 ** d) / 10 ** d).toLocaleString("fr-FR");
  const newId = () => Math.random().toString(16).slice(2, 8);

  // ------------------------------------------------------------------ outils
  function h(sel, attrs, ...kids) {
    const m = sel.match(/^([a-z0-9]+)?((?:[.#][\w-]+)*)$/i);
    const el = document.createElement(m[1] || "div");
    for (const part of (m[2] || "").match(/[.#][\w-]+/g) || []) {
      if (part[0] === ".") el.classList.add(part.slice(1)); else el.id = part.slice(1);
    }
    if (attrs != null && (typeof attrs !== "object" || attrs instanceof Node || Array.isArray(attrs))) { kids.unshift(attrs); attrs = null; }
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === "on") for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
      else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
      else if (k === "dataset") Object.assign(el.dataset, v);
      else if (k in el && !["list", "form"].includes(k)) el[k] = v;
      else el.setAttribute(k, v);
    }
    for (const k of kids.flat()) if (k != null && k !== false) el.append(k instanceof Node ? k : String(k));
    return el;
  }
  async function api(url, body) {
    const r = await fetch(url, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" },
                                                          body: JSON.stringify(body) });
    let j = {};
    try { j = await r.json(); } catch (_) { /* reponse vide */ }
    if (!r.ok) throw new Error(j.error || "erreur " + r.status);
    return j;
  }
  function toast(msg, ms) {
    const t = h("div.ae-toast", msg);
    document.body.append(t);
    setTimeout(() => t.classList.add("off"), ms || 3500);
    setTimeout(() => t.remove(), (ms || 3500) + 600);
  }
  let bannerEl = null;
  function banner(msg) {
    if (!msg) { if (bannerEl) bannerEl.remove(); bannerEl = null; return; }
    if (!bannerEl) { bannerEl = h("div.ae-banner"); document.body.append(bannerEl); }
    bannerEl.textContent = msg;
  }
  const once = (el, ev) => new Promise((res, rej) => {
    const ok = () => { el.removeEventListener("error", ko); res(); };
    const ko = () => { el.removeEventListener(ev, ok); rej(new Error("vidéo illisible")); };
    el.addEventListener(ev, ok, { once: true });
    el.addEventListener("error", ko, { once: true });
  });
  async function loadSpec() {
    if (!spec) spec = await api("/api/presets");
    return spec;
  }

  // ------------------------------------------------------------------ projet de chaque page
  let bookPages = null;
  async function projectOf(i) {
    const pg = C.B.pages[i];
    if (pg.project) return pg.project;
    if (C.kind === "project") return C.id;
    if (!bookPages) bookPages = ((await api("/api/books")).find(b => b.id === C.id) || {}).pages || [];
    return bookPages[i];
  }
  async function project(pid, fresh) {
    if (fresh || !projects.has(pid)) projects.set(pid, await api(`/api/projects/${pid}`));
    return projects.get(pid);
  }

  // enregistre (retouches, cadrage, volumes...) puis remet la page jouable a jour ; une requete a la fois, dans l'ordre
  let chain = Promise.resolve();
  function saveEdit(i, panelId, body, opts) {
    opts = opts || {};
    const run = async () => {
      const pid = await projectOf(i);
      const payload = Object.keys(body).length ? body : { refresh: 1 };
      const res = await api(`/api/projects/${pid}/edit/${panelId}`, Object.assign({}, payload, C.kind === "book" ? { book: C.id } : {}));
      projects.set(pid, res.project);
      const pg = C.B.pages[i], old = pg.data;
      pg.data = res.page;
      if (cur && cur.pid === pid) { cur.project = res.project; cur.panel = res.project.panels[cur.id] || {}; }
      if (i !== C.cur() || opts.noApply) {
        return Object.assign(res, { changed: JSON.stringify(old) !== JSON.stringify(res.page) });
      }
      const inst = C.inst();
      const stamp = opts.sounds ? String(Date.now()) : null;
      if (stamp) pg.stamp = stamp;
      inst.duration = Math.max(0.2, res.page.duration || inst.duration);
      inst.data.duration = res.page.duration; inst.data.fps = res.page.fps; inst.fps = res.page.fps || inst.fps;
      for (const e of res.page.panels) {
        const st = inst.panels.find(s => s.p.id === e.id);
        if (!st) continue;
        const mine = cur && cur.st === st;
        const sameMedia = JSON.stringify(st.p.media || null) === JSON.stringify(e.media || null);
        const sameMore = JSON.stringify(st.p.more || null) === JSON.stringify(e.more || null);
        if (!sameMedia || !sameMore || (opts.sounds === e.id)) {
          const entry = mine ? Object.assign({}, e, { fx: clone(cur.fx), view: clone(cur.view) }) : e;
          P.updatePanel(st, entry, stamp);
        } else if (!mine) {
          P.setFx(st, e.fx); P.setView(st, e.view);
        }
      }
      if (cur && opts.sounds === cur.id && lastTab === "sound") renderTab();
      return res;
    };
    chain = chain.then(run, run);
    return chain;
  }

  // la premiere fois qu'une page passe en edition : la page jouable est remise a jour (reglages du projet)
  function prepare(i) {
    if (!prepared[i]) {
      prepared[i] = (async () => {
        banner("Préparation de la page pour l'édition…");
        try {
          const res = await saveEdit(i, "_", {}, { noApply: true });
          if (res.changed && i === C.cur()) C.remount(String(Date.now()));
        } finally { banner(null); }
      })().catch((e) => { prepared[i] = null; toast("⚠ " + e.message, 6000); throw e; });
    }
    return prepared[i];
  }

  // ------------------------------------------------------------------ mode edition
  function setMode(v) {
    on = !!v;
    C.button.setAttribute("aria-pressed", String(on));
    document.body.classList.toggle("ae-on", on);
    P.setEditHook(on ? pick : null);
    if (!on) { close(); banner(null); removeDots(); return; }
    const hint = document.getElementById("hint");
    if (hint) hint.classList.add("off");
    prepare(C.cur()).then(() => {
      renderDots();
      const want = (location.search.match(/[?&]case=([\w-]+)/) || [])[1];
      const st = want && C.inst().panels.find(s => s.p.id === want);
      if (st) { pick(st); history.replaceState(null, "", location.href.replace(/([?&])case=[\w-]+&?/, "$1").replace(/[?&]$/, "")); }
      else toast("Cliquez sur une case pour la retoucher. Pastille en haut à droite : à voir / OK / à retoucher.", 5000);
    }).catch(() => {});
  }
  C.button.addEventListener("click", () => setMode(!on));
  if (/[?&]edit=1\b/.test(location.search)) setTimeout(() => setMode(true), 300);     // ouvert depuis l'application
  document.addEventListener("alive-page", (e) => {
    close();
    removeDots();
    if (on) prepare(e.detail.index).then(renderDots).catch(() => {});
  });

  // ------------------------------------------------------------------ pastilles de suivi : a voir / OK / a retoucher
  const REVIEW = { todo: ["#f2a33c", "À voir"], ok: ["#45b56a", "OK"], redo: ["#e0483e", "À retoucher"] };
  let dotsEl = null, menuEl = null, sumEl = null;
  const pidOf = {};
  const reviewOf = (pid, id) => (((projects.get(pid) || {}).panels || {})[id] || {}).review || "todo";

  async function renderDots() {
    removeDots();
    const i = C.cur(), inst = C.inst(), pg = C.B.pages[i];
    let pid;
    try { pid = await projectOf(i); await project(pid); } catch (_) { return; }
    if (!on || C.inst() !== inst) return;
    const [PW, PH] = pg.data.size;
    dotsEl = h("div.ae-dots");
    for (const e of pg.data.panels) {
      const pts = e.poly || [[e.rect[0], e.rect[1]], [e.rect[2], e.rect[1]], [e.rect[2], e.rect[3]], [e.rect[0], e.rect[3]]];
      const [x, y] = pts.reduce((m, q) => (q[0] - q[1] > m[0] - m[1] ? q : m));        // coin en haut a droite
      const d = h("button.ae-dot", { type: "button", dataset: { panel: e.id },
                                     style: { left: x / PW * 100 + "%", top: y / PH * 100 + "%" } });
      paintDot(d, reviewOf(pid, e.id));
      d.addEventListener("click", (ev) => { ev.stopPropagation(); reviewMenu(d, i, pid, e.id); });
      dotsEl.append(d);
    }
    inst.pageEl.append(dotsEl);
    summary();
  }
  function removeDots() {
    if (dotsEl) dotsEl.remove();
    dotsEl = null;
    closeMenu();
    if (sumEl) sumEl.hidden = true;
  }
  function paintDot(d, v) {
    d.dataset.v = v;
    d.title = `Case ${d.dataset.panel} : ${REVIEW[v][1]} (cliquer pour changer)`;
  }
  function closeMenu() {
    if (menuEl) menuEl.remove();
    menuEl = null;
  }
  function reviewMenu(anchor, i, pid, id) {
    closeMenu();
    const r = anchor.getBoundingClientRect();
    menuEl = h("div.ae-revmenu", Object.entries(REVIEW).map(([v, [color, label]]) =>
      h("button" + (reviewOf(pid, id) === v ? ".on" : ""), { type: "button", on: { click: () => { closeMenu(); setReview(i, pid, id, v); } } },
        h("i", { style: { background: color } }), label)));
    document.body.append(menuEl);
    menuEl.style.left = Math.max(8, Math.min(innerWidth - menuEl.offsetWidth - 8, r.right - menuEl.offsetWidth)) + "px";
    menuEl.style.top = Math.min(innerHeight - menuEl.offsetHeight - 8, r.bottom + 6) + "px";
    const away = (e) => {
      if (menuEl && !menuEl.contains(e.target) && e.target !== anchor) { closeMenu(); document.removeEventListener("pointerdown", away, true); }
      if (!menuEl) document.removeEventListener("pointerdown", away, true);
    };
    document.addEventListener("pointerdown", away, true);
  }
  function setReview(i, pid, id, v) {
    const pj = projects.get(pid);
    if (pj && pj.panels[id]) pj.panels[id].review = v;
    for (const d of document.querySelectorAll(`.ae-dot[data-panel="${id}"]`)) paintDot(d, v);
    summary();
    saveEdit(i, id, { review: v }, { noApply: true }).catch((e) => toast("⚠ " + e.message));
  }
  async function summary() {
    if (!sumEl) {
      sumEl = h("span.ae-sum", { title: "Suivi des cases : OK · à voir · à retoucher" });
      (document.getElementById("where") || C.button).after(sumEl);
    }
    const count = (k) => {
      const pid = pidOf[k];
      const n = { ok: 0, todo: 0, redo: 0 };
      const pj = pid ? projects.get(pid) : null;
      for (const e of C.B.pages[k].data.panels) n[pj ? reviewOf(pid, e.id) : "todo"]++;
      return n;
    };
    const chip = (n) => h("span", ["ok", "todo", "redo"].map(v => h("span.ae-n", { title: REVIEW[v][1] },
                                                                  h("i", { style: { background: REVIEW[v][0] } }), n[v])));
    const i = C.cur();
    pidOf[i] = await projectOf(i);
    sumEl.hidden = false;
    sumEl.textContent = "";
    sumEl.append(chip(count(i)));
    if (C.B.pages.length > 1) {
      try {
        await Promise.all(C.B.pages.map((_, k) => projectOf(k).then((pid) => { pidOf[k] = pid; return project(pid); })));
      } catch (_) { return; }
      const tot = { ok: 0, todo: 0, redo: 0 };
      C.B.pages.forEach((_, k) => { const n = count(k); for (const v in tot) tot[v] += n[v]; });
      sumEl.textContent = "";
      sumEl.append(h("small", "page"), chip(count(i)), h("small", "livre"), chip(tot));
    }
  }
  document.addEventListener("keydown", (e) => {
    const t = e.target instanceof Element ? e.target : document.body;
    if (e.key === "Escape" && cur && !t.closest("input, textarea, select")) close();
  }, true);

  // retour a l'accueil de l'application, et la planche affichee dans l'application
  (function nav() {
    const header = document.querySelector("header");
    if (!header) return;
    const home = h("a.ae-nav", { href: "/", title: "Accueil de l'application (planches et livres)" }, "🏠 Accueil");
    const open = h("a.ae-nav", { href: "/", title: "Ouvrir cette planche dans l'application" }, "✎ Planche");
    header.insertBefore(open, header.firstChild);
    header.insertBefore(home, open);
    const upd = () => projectOf(C.cur()).then((pid) => { if (pid) open.href = "/#p=" + pid; }).catch(() => {});
    document.addEventListener("alive-page", upd);
    upd();
  })();

  async function pick(st) {
    if (!st.kind) { toast("Case vide : y déposer une vidéo ou une image dans l'application (✎ Planche)."); return; }
    try { await prepare(C.cur()); } catch (_) { return; }
    if (cur && cur.st === st) return;
    close();
    const i = C.cur();
    const pid = await projectOf(i);
    let pj;
    try { [pj] = await Promise.all([project(pid), loadSpec()]); } catch (e) { toast("⚠ " + e.message); return; }
    if (!st.el.isConnected) return;
    cur = { st, i, pid, id: st.p.id, project: pj, panel: pj.panels[st.p.id] || {}, fx: clone(st.p.fx || {}),
            view: clone(st.p.view || { zoom: 1, ox: 0, oy: 0 }), fx0: clone(st.p.fx || {}),
            view0: clone(st.p.view || { zoom: 1, ox: 0, oy: 0 }), pending: {}, timer: null };
    st.el.classList.add("ac-sel");
    P.setPinned(st, true);
    if (st.kind !== "video" && lastTab === "play") lastTab = "filters";
    build();
  }

  function close() {
    if (!cur) return;
    flush();
    const c = cur;
    cur = null;
    P.setPinned(c.st, false);
    P.scrub(c.st, null);
    if (c.view3) c.view3.remove();
    c.st.el.classList.remove("ac-sel");
    cancelAnimationFrame(c.raf);
    if (pop) pop.remove();
    pop = null;
  }

  // ------------------------------------------------------------------ retouches
  function change(fn) {
    fn(cur.fx);
    P.setFx(cur.st, clone(cur.fx));
    queue({ edit: true });
    drawTimeline();
  }
  function changeView(fn) {
    fn(cur.view);
    P.setView(cur.st, clone(cur.view));
    queue({ view: true });
  }
  function queue(part) {
    Object.assign(cur.pending, part);
    clearTimeout(cur.timer);
    status("…");
    cur.timer = setTimeout(flush, 700);
  }
  function flush() {
    const c = cur;
    if (!c || !Object.keys(c.pending).length) return;
    clearTimeout(c.timer);
    const body = {};
    if (c.pending.edit) body.edit = clone(c.fx);
    if (c.pending.view) body.view = clone(c.view);
    if (c.pending.extra) body.extra = c.pending.extra;
    if (c.pending.pageVolume != null) body.pageVolume = c.pending.pageVolume;
    const sounds = c.pending.extra ? c.id : null;
    const reverseNow = !!(c.fx.reverse && !(c.st.p.media || {}).rev);
    c.pending = {};
    status(reverseNow ? "préparation de la lecture à l'envers…" : "enregistrement…");
    saveEdit(c.i, c.id, body, { sounds }).then(() => { if (cur === c) status("✓ enregistré"); })
      .catch((e) => { if (cur === c) status("⚠ " + e.message, true); else toast("⚠ " + e.message); });
  }
  function status(msg, err) {
    if (!pop) return;
    const s = pop.querySelector(".ae-status");
    s.textContent = msg;
    s.classList.toggle("err", !!err);
  }
  function revert() {
    const c = cur;
    c.fx = clone(c.fx0); c.view = clone(c.view0);
    P.setFx(c.st, clone(c.fx)); P.setView(c.st, clone(c.view));
    clearTimeout(c.timer);
    c.pending = {};
    status("enregistrement…");
    saveEdit(c.i, c.id, { edit: clone(c.fx0), view: clone(c.view0) }).then(() => { if (cur === c) status("✓ retouches annulées"); })
      .catch((e) => status("⚠ " + e.message, true));
    renderTab();
    drawTimeline();
  }

  // ------------------------------------------------------------------ fenetre
  function build() {
    const st = cur.st, p = st.p, pg = C.B.pages[cur.i], video = st.kind === "video";
    const dot = h("button.ae-dot.ae-dot-head", { type: "button", dataset: { panel: p.id } });
    paintDot(dot, reviewOf(cur.pid, p.id));
    dot.addEventListener("click", () => reviewMenu(dot, cur.i, cur.pid, p.id));
    const bigBtn = h("button.ae-ib", { title: "Agrandir / réduire la fenêtre (on peut aussi tirer le coin en bas à droite)" }, "⤢");
    const head = h("div.ae-head", dot, h("b", `Case ${p.id}`), h("span.ae-sub", (p.media && p.media.kind === "image") ? "image" : "vidéo"),
                   h("span.ae-sp"), bigBtn, h("button.ae-ib", { title: "Fermer (Échap)", on: { click: close } }, "✕"));
    // apercu agrandi : la case calculee dans son propre canevas (memes passes que la page et que l'export)
    const ar = (p.rect[2] - p.rect[0]) / Math.max(1, p.rect[3] - p.rect[1]);
    const stage = h("div.ac-view.ae-stage");
    cur.view3 = P.addView(st, stage);
    const playBtn = h("button.ae-btn", { title: "Lecture / pause de toute la page (barre espace)" });
    const inst = C.inst();
    const syncPlay = () => { playBtn.textContent = inst.playing ? "⏸ Pause" : "▶ Lecture"; };
    playBtn.onclick = () => { P.scrub(st, null); C.togglePlay(); syncPlay(); };
    const restart = h("button.ae-btn", { title: "Revenir au début de la page", on: { click: () => P.seek(inst, 0) } }, "⏮");
    const info = h("span.ae-info");
    const canvas = video ? h("canvas.ae-tl", { width: 864, height: 120 }) : null;
    if (canvas) { canvas.style.width = "100%"; canvas.style.height = "60px"; }
    const tabs = h("div.ae-tabs");
    const tabBody = h("div.ae-tab");
    const NAMES = video ? { play: "Lecture", color: "Couleur", frame: "Cadrage", filters: "Filtres", sound: "Son" }
                        : { color: "Couleur", frame: "Cadrage", filters: "Filtres", sound: "Son" };
    for (const [k, label] of Object.entries(NAMES)) {
      tabs.append(h("button", { dataset: { tab: k }, on: { click: () => { lastTab = k; renderTab(); } } }, label));
    }
    if (!NAMES[lastTab]) lastTab = "filters";
    const foot = h("div.ae-foot", h("span.ae-status", "retouches enregistrées automatiquement"), h("span.ae-sp"),
                   h("button.ae-btn", { title: "Remettre la case comme à l'ouverture de la fenêtre", on: { click: revert } }, "↺ Annuler mes retouches"),
                   h("button.ae-btn.ae-main", { on: { click: close } }, "Fermer"));
    pop = h("div.ae-pop", head,
            h("div.ae-body", h("div.ae-stagebox", stage), h("div.ae-row", playBtn, restart, info), canvas, tabs, tabBody), foot);
    document.body.append(pop);
    Object.assign(cur, { canvas, info, tabBody, tabs });
    try {
      const sz = JSON.parse(localStorage.getItem("ae-size") || "null");
      if (sz) { pop.style.width = Math.min(sz[0], innerWidth - 16) + "px"; pop.style.height = Math.min(sz[1], innerHeight - 24) + "px"; }
    } catch (_) { /* stockage indisponible */ }
    const fitStage = () => {
      if (!pop) return;
      const body = pop.querySelector(".ae-body");
      const W = Math.max(200, body.clientWidth - 30);
      const H = pop.style.height ? Math.max(160, pop.clientHeight * 0.42) : 240;
      let ph = Math.min(H, W / ar), pw = ph * ar;
      if (pw > W) { pw = W; ph = W / ar; }
      stage.style.width = pw + "px"; stage.style.height = ph + "px";
    };
    fitStage();
    const me = pop;
    let saveT = null;
    new ResizeObserver(() => {
      if (pop !== me) return;
      fitStage();
      clearTimeout(saveT);
      saveT = setTimeout(() => {
        try {
          if (pop && pop.style.width) localStorage.setItem("ae-size", JSON.stringify([pop.offsetWidth, pop.offsetHeight]));
        } catch (_) { /* stockage indisponible */ }
      }, 400);
    }).observe(pop);
    bigBtn.onclick = () => {
      if (pop.style.width && pop.offsetWidth > 700) {
        pop.style.width = pop.style.height = "";
        try { localStorage.removeItem("ae-size"); } catch (_) { /* rien */ }
      } else {
        const w = Math.min(1000, innerWidth - 24);
        pop.style.width = w + "px";
        pop.style.left = Math.max(12, Math.min(pop.offsetLeft, innerWidth - w - 12)) + "px";
        pop.style.top = "56px";
        pop.style.height = (innerHeight - 68) + "px";
        pop.style.maxHeight = "";
      }
      fitStage();
    };
    placePop(head);
    if (video) { bindTimeline(canvas); loadThumbs(); }
    renderTab();
    const loop = () => {                  // tete de lecture et compteur
      if (!cur || !pop) return;
      syncPlay();
      const m = st.p.media || {};
      if (video) {
        const f = P.frameOf(st);
        const key = f + "|" + inst.t.toFixed(2);
        if (key !== cur.lastKey) {
          cur.lastKey = key;
          info.textContent = `image ${f} · ${fmt(f / (m.fps || 25), 2)} s de la vidéo · page ${fmt(inst.t, 1)} s / ${fmt(inst.duration, 1)} s`;
          drawTimeline();
        }
      } else info.textContent = `page ${fmt(inst.t, 1)} s / ${fmt(inst.duration, 1)} s`;
      cur.raf = requestAnimationFrame(loop);
    };
    loop();
  }

  function placePop(head) {
    const r = cur.st.el.getBoundingClientRect();
    const w = pop.offsetWidth || Math.min(480, innerWidth - 16);
    let x = r.left + r.width / 2 > innerWidth / 2 ? 12 : innerWidth - w - 12;
    let y = 64;
    if (userPos) { x = userPos[0]; y = userPos[1]; }
    pop.style.left = Math.max(0, Math.min(innerWidth - 120, x)) + "px";
    pop.style.top = Math.max(0, Math.min(innerHeight - 80, y)) + "px";
    const me = pop;
    const fit = () => {
      if (pop !== me) { removeEventListener("resize", fit); return; }
      pop.style.maxHeight = Math.max(240, innerHeight - pop.offsetTop - 10) + "px";
    };
    fit();
    addEventListener("resize", fit);
    let d = null;
    head.addEventListener("pointerdown", (e) => {
      if (e.target.closest("button")) return;
      d = { x: e.clientX, y: e.clientY, l: pop.offsetLeft, t: pop.offsetTop };
      head.setPointerCapture(e.pointerId);
    });
    head.addEventListener("pointermove", (e) => {
      if (!d) return;
      const nx = d.l + e.clientX - d.x, ny = d.t + e.clientY - d.y;
      pop.style.left = Math.max(-300, Math.min(innerWidth - 80, nx)) + "px";
      pop.style.top = Math.max(0, Math.min(innerHeight - 40, ny)) + "px";
      pop.style.maxHeight = Math.max(240, innerHeight - pop.offsetTop - 10) + "px";
      userPos = [pop.offsetLeft, pop.offsetTop];
    });
    head.addEventListener("pointerup", () => { d = null; });
  }

  // ------------------------------------------------------------------ bande d'images (video)
  async function thumbs(st, onProgress) {
    const m = st.p.media, src = st.inst.base + m.src;
    if (thumbsCache.has(src)) return thumbsCache.get(src);
    const v = document.createElement("video");
    v.muted = true; v.preload = "auto"; v.src = src;
    await once(v, "loadeddata");
    const n = m.frames, fps = m.fps || 25, ar = m.w / Math.max(1, m.h), NT = 12, out = [];
    for (let k = 0; k < NT; k++) {
      const i = Math.round(k * (n - 1) / (NT - 1));
      v.currentTime = (i + 0.5) / fps;
      await once(v, "seeked");
      const t = document.createElement("canvas");
      t.width = 120; t.height = Math.max(8, Math.round(120 / ar));
      t.getContext("2d").drawImage(v, 0, 0, t.width, t.height);
      out.push({ i, c: t });
      if (onProgress) onProgress((k + 1) / NT);
    }
    v.removeAttribute("src"); v.load();
    thumbsCache.set(src, out);
    return out;
  }
  function loadThumbs() {
    const c = cur;
    c.thumbs = null;
    drawTimeline();
    thumbs(c.st, (f) => { if (cur === c) { c.progress = f; drawTimeline(); } })
      .then((t) => { if (cur === c) { c.thumbs = t; drawTimeline(); } })
      .catch((e) => { if (cur === c) { c.progress = -1; drawTimeline(); } });
  }
  const PAD = 12;
  function nFrames() { return Math.max(2, (cur.st.p.media || {}).frames || 2); }
  function xOf(i) { const cv = cur.canvas; return PAD + i / Math.max(1, nFrames() - 1) * (cv.width - 2 * PAD); }
  function frameAt(x) {
    const cv = cur.canvas, n = nFrames();
    return Math.max(0, Math.min(n - 1, Math.round((x - PAD) / (cv.width - 2 * PAD) * (n - 1))));
  }
  function rangeOf() {
    const n = nFrames(), r = cur.fx.range;
    return Array.isArray(r) ? [Math.max(0, Math.min(n - 1, r[0])), Math.max(0, Math.min(n - 1, r[1]))] : [0, n - 1];
  }
  function drawTimeline() {
    if (!cur || !cur.canvas) return;
    const cv = cur.canvas, g = cv.getContext("2d"), Wd = cv.width, Hs = cv.height - 16, top = 8;
    g.fillStyle = "#0d0d0d"; g.fillRect(0, 0, Wd, cv.height);
    if (cur.thumbs) {
      const cw = (Wd - 2 * PAD) / cur.thumbs.length;
      cur.thumbs.forEach((t, k) => {
        const sx = t.c.width, sy = t.c.height, r = cw / Hs;
        let w = sx, hh = sx / r;
        if (hh > sy) { hh = sy; w = sy * r; }
        g.drawImage(t.c, (sx - w) / 2, (sy - hh) / 2, w, hh, PAD + k * cw, top, cw - 2, Hs);
      });
    } else {
      g.fillStyle = "#9a948a"; g.font = "24px system-ui, sans-serif";
      g.fillText(cur.progress === -1 ? "vignettes impossibles" : `vignettes… ${Math.round((cur.progress || 0) * 100)} %`, PAD + 8, 60);
    }
    const [a, b] = rangeOf(), xa = xOf(a), xb = xOf(b);
    g.fillStyle = "rgba(0,0,0,.66)";
    g.fillRect(0, 0, xa, cv.height); g.fillRect(xb, 0, Wd - xb, cv.height);
    for (const x of [xa, xb]) {
      g.fillStyle = "#b36bff"; g.fillRect(x - 3, 0, 6, cv.height);
      g.fillRect(x - 9, cv.height / 2 - 16, 18, 32);
    }
    const xp = xOf(P.frameOf(cur.st));
    g.fillStyle = "#fff"; g.fillRect(xp - 1.5, 0, 3, cv.height);
    if (cur.fx.reverse) { g.fillStyle = "#fff"; g.font = "bold 22px system-ui"; g.fillText("◀ à l'envers", Wd - 160, cv.height - 14); }
  }
  // glisser sur la bande : voir une image ; poignees : debut et fin du passage
  function bindTimeline(cv) {
    let mode = null;
    const pos = (e) => (e.clientX - cv.getBoundingClientRect().left) * cv.width / cv.getBoundingClientRect().width;
    cv.addEventListener("pointerdown", (e) => {
      const x = pos(e), [a, b] = rangeOf();
      cv.setPointerCapture(e.pointerId);
      if (Math.abs(x - xOf(a)) < 14) mode = "a";
      else if (Math.abs(x - xOf(b)) < 14) mode = "b";
      else mode = "scrub";
      move(e);
    });
    const move = (e) => {
      if (!mode || !cur) return;
      const f = frameAt(pos(e)), st = cur.st;
      if (mode === "scrub") { P.scrub(st, f); drawTimeline(); return; }
      const r = rangeOf();
      if (mode === "a") r[0] = Math.min(f, r[1]); else r[1] = Math.max(f, r[0]);
      cur.fx.range = r;
      P.setFx(st, clone(cur.fx));
      P.scrub(st, mode === "a" ? r[0] : r[1]);
      drawTimeline();
    };
    cv.addEventListener("pointermove", move);
    const up = () => {
      if (!mode || !cur) return;
      const st = cur.st;
      if (mode === "a" || mode === "b") {
        const n = nFrames(), r = cur.fx.range;
        if (r && r[0] <= 0 && r[1] >= n - 1) delete cur.fx.range;
        change(() => {});
        if (lastTab === "play") renderTab();
      }
      // la page se cale sur l'image choisie (si elle est dans le premier passage)
      const f = st.scrubFrame;
      if (f != null) {
        const m = st.p.media, [a, b] = rangeOf(), sp = cur.fx.speed || 1;
        const k = cur.fx.reverse ? b - f : f - a;
        if (k >= 0) P.seek(st.inst, Math.min(st.inst.duration - 1e-3, k / ((m.fps || 25) * sp)));
        P.scrub(st, null);
      }
      mode = null;
    };
    cv.addEventListener("pointerup", up);
    cv.addEventListener("pointercancel", up);
  }

  // ------------------------------------------------------------------ onglets
  function slider(label, get, set, o) {
    const val = h("span.ae-val");
    const lg = !!o.log;
    const to = (v) => lg ? Math.log(v / o.min) / Math.log(o.max / o.min) * 1000 : v;
    const from = (t) => lg ? o.min * Math.pow(o.max / o.min, t / 1000) : t;
    const inp = h("input", { type: "range", min: lg ? 0 : o.min, max: lg ? 1000 : o.max, step: lg ? 1 : o.step });
    const show = () => { val.textContent = (o.fmt || ((v) => fmt(v)))(get()); };
    inp.value = to(get());
    show();
    inp.addEventListener("input", () => {
      let v = from(+inp.value);
      if (lg) v = Math.round(v * 100) / 100;
      set(v); show();
    });
    inp.addEventListener("dblclick", () => {
      if (o.neutral == null) return;
      set(o.neutral); inp.value = to(o.neutral); show();
    });
    if (o.disabled) inp.disabled = true;
    return h("label.ae-sl", { title: o.neutral != null ? "Double-clic : valeur neutre" : "" }, h("span.ae-lab", label), inp, val);
  }
  function check(label, value, onChange, title) {
    const cb = h("input", { type: "checkbox", checked: !!value });
    cb.onchange = () => onChange(cb.checked);
    return h("label.ae-chk", { title: title || "" }, cb, label);
  }

  function renderTab() {
    if (!cur || !pop) return;
    for (const b of cur.tabs.children) b.classList.toggle("on", b.dataset.tab === lastTab);
    const box = cur.tabBody;
    box.textContent = "";
    ({ play: tabPlay, color: tabColor, frame: tabFrame, filters: tabFilters, sound: tabSound })[lastTab](box);
  }

  const speedRow = () => slider("Vitesse", () => cur.fx.speed || 1,
    (v) => change((fx) => { if (Math.abs(v - 1) > 1e-3) fx.speed = v; else delete fx.speed; }),
    { min: 0.25, max: 4, log: true, neutral: 1, fmt: (v) => "× " + fmt(v) });

  function tabPlay(box) {
    const st = cur.st, m = st.p.media, fps = m.fps || 25;
    const here = () => P.frameOf(st);
    box.append(h("p.ae-note", "Bande d'images : glisser pour voir une image ; poignées violettes = début et fin du passage. " +
                 "La page entière suit une seule horloge, comme la vidéo exportée."));
    box.append(h("div.ae-row",
      h("button.ae-btn", { on: { click: () => change((fx) => { const r = rangeOf(); r[0] = Math.min(here(), r[1]); fx.range = r; }) } }, "⟦ Début ici"),
      h("button.ae-btn", { on: { click: () => change((fx) => { const r = rangeOf(); r[1] = Math.max(here(), r[0]); fx.range = r; }) } }, "Fin ici ⟧"),
      h("button.ae-btn", { title: "Toute la vidéo", on: { click: () => { change((fx) => { delete fx.range; }); renderTab(); } } }, "↺ Tout le clip")));
    const sel = h("select", {}, h("option", { value: "loop" }, "En boucle"), h("option", { value: "once" }, "Une fois, puis image figée"));
    sel.value = cur.fx.loop === false ? "once" : "loop";
    sel.onchange = () => { change((fx) => { if (sel.value === "once") fx.loop = false; else delete fx.loop; }); renderTab(); };
    box.append(h("label.ae-sl", h("span.ae-lab", "Lecture"), sel, h("span.ae-val")));
    box.append(speedRow());
    const [a, b] = rangeOf(), sec = (b - a + 1) / fps;
    box.append(h("p.ae-note", `Passage : ${fmt(sec)} s de vidéo, ${fmt(sec / (cur.fx.speed || 1))} s à l'écran · ` +
                 `durée de la page : ${fmt(C.inst().duration, 1)} s (réglable à l'export).`));
  }

  function tabColor(box) {
    const g = () => cur.fx.grade || {};
    const set = (k, v, neutral) => change((fx) => {
      const gg = Object.assign({}, fx.grade);
      if (v === neutral) delete gg[k]; else gg[k] = v;
      if (Object.keys(gg).length) fx.grade = gg; else delete fx.grade;
    });
    const row = (label, k, min, max, step, neutral, f) =>
      slider(label, () => g()[k] ?? neutral, (v) => set(k, v, neutral), { min, max, step, neutral, fmt: f });
    box.append(row("Saturation", "sat", 0, 2, 0.01, 1, (v) => Math.round(v * 100) + " %"));
    box.append(row("Luminosité", "bright", 0.5, 1.5, 0.01, 1, (v) => Math.round(v * 100) + " %"));
    box.append(row("Contraste", "contrast", 0.5, 1.5, 0.01, 1, (v) => Math.round(v * 100) + " %"));
    box.append(row("Température", "temp", -1, 1, 0.01, 0, (v) => v > 0 ? "chaud " + Math.round(v * 100) : v < 0 ? "froid " + Math.round(-v * 100) : "neutre"));
    box.append(row("Teinte", "hue", -30, 30, 1, 0, (v) => (v > 0 ? "+" : "") + v + "°"));
    box.append(h("div.ae-row",
      h("button.ae-btn", { on: { click: () => { change((fx) => { delete fx.grade; }); renderTab(); } } }, "↺ Neutre"),
      h("button.ae-btn", { title: "Mêmes couleurs pour toutes les cases de cette page", on: { click: () => applyAll("grade") } },
        "Appliquer à toute la page")));
    box.append(h("p.ae-note", "Ces couleurs passent avant les effets de l'onglet Filtres."));
  }

  // meme reglage (couleurs, pile d'effets) sur toutes les cases de la page qui ont une image ou une video
  async function applyAll(key) {
    const c = cur, inst = C.inst(), others = inst.panels.filter(x => x !== c.st && x.kind);
    const val = clone(c.fx[key]);
    status(`${key === "grade" ? "couleurs" : "filtres"} : toute la page…`);
    try {
      for (const st of others) {
        const fx = clone(st.p.fx || {});
        if (val && (!Array.isArray(val) || val.length)) fx[key] = key === "filters" ? val.map(f => Object.assign({}, f, { id: newId() })) : clone(val);
        else delete fx[key];
        P.setFx(st, fx);
        await saveEdit(c.i, st.p.id, { edit: fx });
      }
      if (cur === c) status(`✓ appliqué aux ${others.length + 1} cases de la page`);
    } catch (e) { status("⚠ " + e.message, true); }
  }

  function tabFrame(box) {
    const st = cur.st, m = st.p.media || {}, [x0, y0, x1, y1] = st.p.rect, bw = x1 - x0, bh = y1 - y0;
    const margins = () => {
      const s = Math.max(bw / m.w, bh / m.h) * Math.max(1, cur.view.zoom || 1);
      return [(m.w * s - bw) / (2 * bw), (m.h * s - bh) / (2 * bh)];
    };
    const norm = (k) => { const [mx, my] = margins(), M = k === "ox" ? mx : my; return M > 1e-6 ? Math.max(-1, Math.min(1, (cur.view[k] || 0) / M)) : 0; };
    const setPos = (k, t) => changeView((v) => { const [mx, my] = margins(); v[k] = Math.round(t * (k === "ox" ? mx : my) * 10000) / 10000; });
    const redraw = () => { renderTab(); };
    box.append(slider("Zoom", () => cur.view.zoom || 1, (v) => changeView((w) => {
      const nx = norm("ox"), ny = norm("oy");
      w.zoom = v;
      const [mx, my] = margins();
      w.ox = nx * mx; w.oy = ny * my;
    }), { min: 1, max: 4, step: 0.01, neutral: 1, fmt: (v) => "× " + fmt(v) }));
    const [mx, my] = margins();
    box.append(slider("Horizontal", () => norm("ox"), (v) => setPos("ox", v), { min: -1, max: 1, step: 0.01, neutral: 0, fmt: (v) => fmt(v), disabled: mx < 1e-4 }));
    box.append(slider("Vertical", () => norm("oy"), (v) => setPos("oy", v), { min: -1, max: 1, step: 0.01, neutral: 0, fmt: (v) => fmt(v), disabled: my < 1e-4 }));
    box.append(h("div.ae-row", h("button.ae-btn", { on: { click: () => { changeView((v) => { v.zoom = 1; v.ox = 0; v.oy = 0; }); redraw(); } } }, "↺ Cadre d'origine")));
    box.append(h("p.ae-note", "La vidéo couvre toute la case ; zoomer pour recadrer, puis déplacer (on ne sort jamais de l'image). " +
                 "Le même cadrage se règle dans l'application en glissant dans la case, molette pour zoomer."));
  }

  // ------------------------------------------------------------------ filtres
  function fmtParam(p, v) {
    switch (p.fmt) {
      case "pct": return Math.round(v * 100) + " %";
      case "ev": return (v > 0 ? "+" : "") + fmt(v) + " IL";
      case "deg": return (v > 0 ? "+" : "") + Math.round(v) + "°";
      case "temp": return v > 0 ? "chaud " + Math.round(v * 100) : v < 0 ? "froid " + Math.round(-v * 100) : "neutre";
      case "tint": return v > 0 ? "magenta " + Math.round(v * 100) : v < 0 ? "vert " + Math.round(-v * 100) : "neutre";
      case "u": return fmt(v, 1);
      default: return fmt(v);
    }
  }
  function newFilter(type) {
    const def = spec.effects.find(e => e.type === type);
    const f = { id: newId(), type, on: true };
    for (const p of def.params) f[p.k] = p.def;
    return f;
  }

  function tabFilters(box) {
    const st = cur.st, m = st.p.media || {}, video = st.kind === "video";
    box.append(slider("Opacité", () => cur.fx.opacity ?? 1,
      (v) => change((fx) => { if (v < 0.999) fx.opacity = v; else delete fx.opacity; }),
      { min: 0, max: 1, step: 0.01, neutral: 1, fmt: (v) => Math.round(v * 100) + " %" }));
    if (video) {
      box.append(speedRow());
      box.append(h("div.ae-row",
        check("Lecture inversée", cur.fx.reverse, (v) => { change((fx) => { if (v) fx.reverse = true; else delete fx.reverse; }); },
              "La vidéo joue à l'envers (son compris)"),
        m.audio ? null : h("span.ae-note", "· vidéo sans son")));
      if (m.audio) {
        box.append(slider("Volume", () => cur.fx.volume ?? 1,
          (v) => change((fx) => { if (v < 0.999) fx.volume = v; else delete fx.volume; }),
          { min: 0, max: 1, step: 0.01, neutral: 1, fmt: (v) => v ? Math.round(v * 100) + " %" : "muet" }));
      }
    }
    const list = cur.fx.filters || [];
    const head = h("div.ae-fxhead", h("b", "Effets"), h("span.ae-note", list.length ? "appliqués de haut en bas" : "aucun pour l'instant"));
    const add = h("button.ae-btn.ae-main", "＋ Ajouter un effet");
    add.onclick = () => addMenu(add);
    head.append(h("span.ae-sp"), add);
    box.append(head);
    list.forEach((f, i) => box.append(filterCard(f, i, list.length)));
    // prereglages et copie
    const presets = h("div.ae-row.ae-presets");
    const fill = () => {
      presets.textContent = "";
      for (const p of (userPresets || [])) {
        presets.append(h("span.ae-chip",
          h("button.ae-btn", { title: p.filters.map(f => (spec.effects.find(e => e.type === f.type) || {}).label).join(" + "),
                               on: { click: () => { change((fx) => { fx.filters = p.filters.map(f => Object.assign({}, f, { id: newId() })); }); renderTab(); } } },
            "★ " + p.name),
          h("button.ae-x", { title: "Supprimer ce préréglage", on: { click: async () => {
            try { userPresets = (await api("/api/userpresets", { kind: "filters", name: p.name, delete: true })).filters; fill(); }
            catch (e) { toast("⚠ " + e.message); }
          } } }, "✕")));
      }
    };
    if (userPresets) fill();
    else api("/api/userpresets").then((r) => { userPresets = r.filters || []; fill(); }).catch(() => {});
    box.append(presets);
    const name = h("input.ae-txt", { placeholder: "nom du préréglage", maxLength: 40 });
    const save = async () => {
      const n = name.value.trim();
      if (!n) { name.focus(); return; }
      if (!(cur.fx.filters || []).length) { toast("Ajoute d'abord des effets."); return; }
      try {
        userPresets = (await api("/api/userpresets", { kind: "filters", name: n, value: cur.fx.filters })).filters;
        name.value = ""; fill();
        toast(`Préréglage « ${n} » enregistré : disponible dans toutes les planches.`);
      } catch (e) { toast("⚠ " + e.message); }
    };
    name.addEventListener("keydown", (e) => { if (e.key === "Enter") save(); });
    box.append(h("div.ae-row", name, h("button.ae-btn", { on: { click: save } }, "💾 Enregistrer la pile")),
               h("div.ae-row", h("button.ae-btn", { title: "Mêmes effets sur toutes les cases de la page (chaque case garde son grain)",
                                                   on: { click: () => applyAll("filters") } }, "Copier les effets sur toute la page")));
    box.append(h("p.ae-note", "Les effets sont calculés de la même façon ici et dans la vidéo exportée. " +
                 "Les tailles (flou, grain, halation, décalage) sont en millièmes de la hauteur de la page."));
  }

  function addMenu(anchor) {
    document.querySelector(".ae-addmenu")?.remove();
    const r = anchor.getBoundingClientRect();
    const menu = h("div.ae-addmenu", spec.effects.map(e => h("button", { type: "button", on: { click: () => {
      menu.remove();
      change((fx) => { fx.filters = (fx.filters || []).concat([newFilter(e.type)]); });
      renderTab();
    } } }, h("b", e.label), h("small", e.hint || ""))));
    document.body.append(menu);
    menu.style.left = Math.max(8, Math.min(innerWidth - menu.offsetWidth - 8, r.right - menu.offsetWidth)) + "px";
    menu.style.top = Math.max(8, Math.min(innerHeight - menu.offsetHeight - 8, r.bottom + 6)) + "px";
    const away = (e) => { if (!menu.contains(e.target) && e.target !== anchor) { menu.remove(); document.removeEventListener("pointerdown", away, true); } };
    setTimeout(() => document.addEventListener("pointerdown", away, true), 0);
  }

  function filterCard(f, i, n) {
    const def = spec.effects.find(e => e.type === f.type) || { label: f.type, params: [] };
    const edit = (fn) => change((fx) => { const g = fx.filters.find(x => x.id === f.id); if (g) fn(g); });
    const move = (d) => { change((fx) => { const a = fx.filters; const j = i + d; [a[i], a[j]] = [a[j], a[i]]; }); renderTab(); };
    const eye = h("button.ae-eye" + (f.on === false ? "" : ".on"), { title: f.on === false ? "Effet coupé : cliquer pour le remettre" : "Couper l'effet (sans le retirer)" },
                  f.on === false ? "○" : "●");
    eye.onclick = () => { edit((g) => { g.on = g.on === false; }); renderTab(); };
    const card = h("div.ae-fx" + (f.on === false ? ".off" : ""),
      h("div.ae-fxbar",
        h("button.ae-mv", { title: "Monter", disabled: i === 0, on: { click: () => move(-1) } }, "▲"),
        h("button.ae-mv", { title: "Descendre", disabled: i === n - 1, on: { click: () => move(1) } }, "▼"),
        h("b", def.label), h("span.ae-sp"), eye,
        h("button.ae-x", { title: "Retirer l'effet", on: { click: () => { change((fx) => { fx.filters = fx.filters.filter(x => x.id !== f.id); if (!fx.filters.length) delete fx.filters; }); renderTab(); } } }, "✕")));
    const body = h("div.ae-fxbody");
    for (const p of def.params) {
      if (p.show && f[p.show[0]] !== p.show[1]) continue;
      if (p.choices) {
        const sel = h("select", {}, p.choices.map(([v, l]) => h("option", { value: v }, l)));
        sel.value = f[p.k] ?? p.def;
        sel.onchange = () => { edit((g) => { g[p.k] = sel.value; }); renderTab(); };
        body.append(h("label.ae-sl", h("span.ae-lab", p.label), sel, h("span.ae-val")));
      } else if (p.color) {
        const inp = h("input", { type: "color", value: f[p.k] || p.def });
        inp.oninput = () => edit((g) => { g[p.k] = inp.value; });
        body.append(h("label.ae-sl", h("span.ae-lab", p.label), inp, h("span.ae-val", "")));
      } else if (p.bool) {
        body.append(check(p.label, f[p.k] ?? p.def, (v) => edit((g) => { g[p.k] = v; })));
      } else {
        body.append(slider(p.label, () => f[p.k] ?? p.def, (v) => { f[p.k] = v; edit((g) => { g[p.k] = v; }); },
                           { min: p.min, max: p.max, step: p.step, neutral: p.def, fmt: (v) => fmtParam(p, v) }));
      }
    }
    if (f.on !== false) card.append(body);
    return card;
  }

  // ------------------------------------------------------------------ sons
  function confirmBox(title, lines, okLabel, note) {
    return new Promise((done) => {
      const back = h("div.ae-modal-back");
      const end = (v) => { back.remove(); done(v); };
      back.append(h("div.ae-modal", h("b", title), h("ul", lines.map(l => h("li", l))), note ? h("p.ae-note", note) : null,
        h("div.ae-row", h("span.ae-sp"), h("button.ae-btn", { on: { click: () => end(false) } }, "Annuler"),
          h("button.ae-btn.ae-main", { on: { click: () => end(true) } }, okLabel || "Utiliser quand même"))));
      back.addEventListener("pointerdown", (e) => { if (e.target === back) end(false); });
      document.body.append(back);
    });
  }
  async function sendSound(url, file) {
    const go = async (force) => {
      const r = await fetch(url + (force ? "&force=1" : ""), { method: "POST", body: file });
      let j = {};
      try { j = await r.json(); } catch (_) { /* reponse vide */ }
      if (r.status === 409 && j.used && !force) {
        if (!(await confirmBox("Ce son est déjà utilisé", j.used.map(u => u.where), null,
                               "S'il est utilisé quand même, le fichier déjà importé est repris : il n'est pas copié une deuxième fois."))) {
          throw new Error("import annulé");
        }
        return go(true);
      }
      if (!r.ok) throw new Error(j.error || "envoi refusé");
      if (j.reused) toast("Son déjà importé : le fichier existant est réutilisé (pas de doublon).", 4500);
      return j;
    };
    return go(false);
  }
  function pickAudio(fn) {
    const inp = h("input", { type: "file", accept: "audio/*,.mp3,.wav,.ogg,.m4a,.flac,.aac" });
    inp.onchange = () => { if (inp.files[0]) fn(inp.files[0]); };
    inp.click();
  }
  async function refreshPage(c) {
    const res = await saveEdit(c.i, "_", {}, { noApply: true });
    if (C.cur() === c.i) P.setPageSound(C.inst(), res.page.sound || null, String(Date.now()));
    if (cur === c) renderTab();
  }
  const niceName = (o) => (o && (o.name || (o.file || "").split("/").pop().replace(/^\d{8}-\d{6}-[0-9a-f]{4}-/, ""))) || "";

  function tabSound(box) {
    const c = cur, st = c.st, p = st.p, panel = c.panel || {}, pg = C.B.pages[c.i], m = p.media || {};
    const block = (title, name, ...kids) => h("div.ae-snd", h("div.ae-sndh", h("b", title), h("small", name || "")), ...kids);
    const dropTarget = (el, fn) => {
      el.addEventListener("dragover", (e) => { e.preventDefault(); el.classList.add("over"); });
      el.addEventListener("dragleave", () => el.classList.remove("over"));
      el.addEventListener("drop", (e) => { e.preventDefault(); el.classList.remove("over"); fn(e.dataTransfer.files[0]); });
    };
    if (st.kind === "video") {
      box.append(block("Son de la vidéo", m.audio ? "" : "aucun (vidéo muette)",
        m.audio ? slider("Volume", () => c.fx.volume ?? 1,
          (v) => change((fx) => { if (v < 0.999) fx.volume = v; else delete fx.volume; }),
          { min: 0, max: 1, step: 0.01, neutral: 1, fmt: (v) => v ? Math.round(v * 100) + " %" : "muet" }) : null,
        m.audio ? h("p.ae-note", "Il suit la vitesse (hauteur gardée) et la lecture inversée, ici comme dans l'export.") : null));
    }
    const extras = panel.extraSounds || [];
    const extraList = (skip) => extras.filter((_, k) => k !== skip).map((e) => ({ file: e.file, volume: e.volume, loop: e.loop }));
    (p.more || []).forEach((x, i) => {
      const ex = extras[i] || {};
      const loop = h("input", { type: "checkbox", checked: x.loop });
      const send = () => queue({ extra: extras.map((e, k) => ({ file: e.file, volume: k === i ? x.vol : (p.more[k] || {}).vol ?? e.volume,
                                                               loop: k === i ? loop.checked : e.loop })) });
      loop.onchange = () => { x.loop = loop.checked; send(); };
      box.append(block(`Son ajouté ${i + 1}`, niceName(ex),
        slider("Volume", () => x.vol, (v2) => { x.vol = v2; P.setLayerVolume(st, "more" + i, v2); send(); },
               { min: 0, max: 1, step: 0.01, fmt: (v2) => Math.round(v2 * 100) + " %" }),
        h("label.ae-chk", loop, "en boucle (sinon : une fois, depuis le début de la page)"),
        h("div.ae-row", h("button.ae-btn", { on: { click: () => { queue({ extra: extraList(i) }); flush(); } } }, "✕ Retirer"))));
    });
    const drop = h("div.ae-drop", "＋ Ajouter un son à cette case (ambiance, voix, bruitage) : glisser un fichier ici, ou cliquer");
    const upload = async (f2) => {
      if (!f2) return;
      drop.textContent = "envoi de " + f2.name + "…";
      try {
        await sendSound(`/api/projects/${c.pid}/panels/${c.id}/sound?name=${encodeURIComponent(f2.name)}`, f2);
        await saveEdit(c.i, c.id, {}, { sounds: c.id });
        toast("Son ajouté : il joue avec la case, et dans l'export.");
      } catch (e) { drop.textContent = "⚠ " + e.message; }
    };
    drop.onclick = () => pickAudio(upload);
    dropTarget(drop, upload);
    box.append(drop);
    // musique de la page
    const ps = (c.project && c.project.pageSound) || {}, inst = C.inst();
    const replacePage = h("button.ae-btn", { on: { click: () => pickAudio(async (f) => {
      try {
        await sendSound(`/api/projects/${c.pid}/upload?kind=page&name=${encodeURIComponent(f.name)}`, f);
        await refreshPage(c);
        toast("Musique de la page en place.");
      } catch (e) { toast("⚠ " + e.message); }
    }) } }, pg.data.sound ? "📁 Remplacer la musique" : "📁 Importer une musique");
    const removePage = h("button.ae-btn", { on: { click: async () => {
      if (!(await confirmBox("Retirer la musique de la page ?", ["Le fichier reste dans le projet."], "Retirer"))) return;
      try {
        await api(`/api/projects/${c.pid}/update`, { pageSound: { mode: "none" } });
        await refreshPage(c);
      } catch (e) { toast("⚠ " + e.message); }
    } } }, "✕ Retirer");
    if (pg.data.sound && inst.music) {
      box.append(block("Musique de la page", ps.name || "",
        slider("Volume", () => inst.music.vol, (x) => { P.setGlobalVolume(inst, x); pg.data.sound.vol = x; queue({ pageVolume: x }); },
               { min: 0, max: 1, step: 0.01, fmt: (x) => Math.round(x * 100) + " %" }),
        h("div.ae-row", replacePage, removePage),
        h("p.ae-note", "Elle joue en boucle sous toute la page, et dans l'export.")));
    } else {
      box.append(block("Musique de la page", "aucune", h("div.ae-row", replacePage)));
    }
  }
})();
