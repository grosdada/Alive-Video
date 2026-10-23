// Images de la page cote navigateur : page.jpg (fond, cases, images et affiches des videos, traits), frames.png
// (traits seuls), vignette. Le lecteur pose page.jpg sous les videos et frames.png par-dessus.
import { loadImage, upload } from "./api.js";
import { media } from "./editor.js";

// placement de l'image dans la boite de la case : couverture * zoom, decalage (ox, oy) en fraction de la boite
// (meme calcul que app/geometry.py placement et que le lecteur)
export function placement(bb, iw, ih, view) {
  const v = view || {};
  const zoom = Math.max(1, v.zoom || 1);
  const s = Math.max(bb.w / iw, bb.h / ih) * zoom;
  const dw = iw * s, dh = ih * s;
  const mx = (dw - bb.w) / (2 * bb.w), my = (dh - bb.h) / (2 * bb.h);
  const ox = Math.max(-mx, Math.min(mx, v.ox || 0)), oy = Math.max(-my, Math.min(my, v.oy || 0));
  return { x: bb.x0 + bb.w / 2 - dw / 2 + ox * bb.w, y: bb.y0 + bb.h / 2 - dh / 2 + oy * bb.h, w: dw, h: dh, ox, oy, mx, my };
}

const cache = new Map();
async function img(url) {
  if (!cache.has(url)) cache.set(url, loadImage(url));
  return cache.get(url);
}

const toBlob = (cv, type, q) => new Promise((ok) => cv.toBlob(ok, type, q));

function polyPath(ctx, poly) {
  ctx.beginPath();
  poly.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
}

// page.jpg (fond, images, traits), frames.png (traits seuls), thumb.jpg
export async function pageImages(project, geom, page) {
  const pg = page || project.page;                     // page animee : son style a la fin de l'animation
  const cv = Object.assign(document.createElement("canvas"), { width: pg.width, height: pg.height });
  const ctx = cv.getContext("2d");
  ctx.fillStyle = pg.bg; ctx.fillRect(0, 0, pg.width, pg.height);
  for (const g of geom.panels) {
    const pic = media(project.panels[g.id]);
    ctx.save(); polyPath(ctx, g.poly); ctx.clip();
    ctx.fillStyle = pg.fill || "#ffffff"; ctx.fill();                  // couleur des cases
    if (pic) {
      const im = await img(pic.url);
      const pl = placement(g.bbox, pic.w, pic.h, project.panels[g.id].view);
      ctx.drawImage(im, pl.x, pl.y, pl.w, pl.h);
    }
    ctx.restore();
  }
  const strokes = (c) => {
    c.lineJoin = "miter"; c.strokeStyle = pg.stroke; c.lineWidth = pg.strokeWidth;
    for (const g of geom.panels) { polyPath(c, g.poly); c.stroke(); }
  };
  if (pg.strokeWidth > 0) strokes(ctx);
  const fr = Object.assign(document.createElement("canvas"), { width: pg.width, height: pg.height });
  if (pg.strokeWidth > 0) strokes(fr.getContext("2d"));
  const th = Object.assign(document.createElement("canvas"), { width: 360, height: Math.round(360 * pg.height / pg.width) });
  th.getContext("2d").drawImage(cv, 0, 0, th.width, th.height);
  const base = `projects/${project.id}/page?name=`;
  await upload(base + "page.jpg", await toBlob(cv, "image/jpeg", 0.92));
  await upload(base + "frames.png", await toBlob(fr, "image/png"));
  await upload(base + "thumb.jpg", await toBlob(th, "image/jpeg", 0.8));
}
