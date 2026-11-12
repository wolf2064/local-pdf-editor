import * as pdfjsLib from './lib/pdf.min.mjs';
import { createContentEditor } from './pdfedit.js';
import { createPdfUnlocker } from './pdfcrypt.js';
/* ローカルPDFエディター v4.11 — ビューア本体（viewer.html から読み込まれる）
 *
 * 使っているライブラリ（すべて lib/ に同梱。インターネットには接続しない）
 *   - PDF.js  : 表示・文字の選択・暗号化PDFの読み込み（lib/pdf.min.mjs は2か所だけ改変: 細線の最小線幅、タイリングパターンのキャッシュ。lib/PATCH-NOTE.txt）
 *   - pdf-lib : 注釈の書き込み・ページ操作・保存
 *   - pdfedit.js  : PDF内の文字・図形（ベクター）を直接書き換えるエンジン（「内容を編集」）
 *   - pdfcrypt.js : 編集ロック（権限パスワード）の解除
 *
 * データの持ち方
 *   - S.baseBytes : 今のPDF本体（ページ操作や「内容を編集」をするたびに作り直す）
 *   - S.annots    : このアドオンで追加した注釈（保存するまではPDFに書かず、SVGで重ねて表示する）
 *   - S.natives   : PDFにもともとあった注釈
 *   - 元に戻す／やり直しは、S.annots と S.baseBytes のスナップショットで行う（takeSnap / restoreSnap）
 *
 * 主な区切り（「/* ----」で検索）
 *   状態・共通処理 → 注釈の形と外観 → 保存 → 読み込み → ズーム・ページ切り替え → 描画 → SVGオーバーレイ・選択
 *   → 履歴 → プロパティ欄 → ポインタ操作 → テキストコメント・スタンプ → 内容の編集 → キー操作 → 保存・開く
 *   → コメント一覧 → ページの整理 → 周辺UI → 文書プロパティ → 印刷 → 注釈埋め込み → 起動
 *
 * window.__EPA / window.__CE / window.__EPA_printHook は動作確認（自動テスト）用の入口で、通常の操作では使わない。 */
const MARKER = 'EdgePDFShapes';
const LIB = new URL('./lib/', import.meta.url).href;
pdfjsLib.GlobalWorkerOptions.workerSrc = LIB + 'pdf.worker.min.mjs';
// v4.11.1: PDF.js の作業スレッドは、起動時に1つだけ作り、すべての文書で使い回す
// （PDFファイルを読んでいる間に作業スレッドの準備が済む。編集のたびの読み直しでも、変換済みのフォントなどが再利用されて速い）
const PDFW = new pdfjsLib.PDFWorker();
const { PDFDocument, PDFName, PDFString, PDFHexString, PDFDict, PDFArray, PDFStream, PDFRef, degrees, StandardFonts } = window.PDFLib;
const CE = createContentEditor(window.PDFLib);
const UNLOCK = createPdfUnlocker(window.PDFLib);
const $ = (s) => document.querySelector(s);
const NS = 'http://www.w3.org/2000/svg';
const hasChrome = typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id;
const LS = {
  get(k, d) { try { const v = localStorage.getItem('epa.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('epa.' + k, JSON.stringify(v)); } catch { /* ignore */ } },
};
/* ---------------------------------------------------------------- state */
const DEFAULTS = { start: 'None', end: 'None', style: 'solid', width: 1, color: '#e03a2a', fill: null, opacity: 100, intensity: 1, radius: 0, startSize: 100, endSize: 100 };
const TEXT_DEFAULTS = { start: 'None', end: 'None', style: 'solid', width: 0, color: '#000000', fill: null, opacity: 100, fontSize: 12, face: 'gothic', intensity: 1 };
const savedZoom = LS.get('zoom', { fit: 'width', scale: 1.25 });
const S = {
  pdf: null, baseBytes: null, fileName: 'document.pdf', fileHandle: null, sourceUrl: null,
  scale: savedZoom.scale || 1.25,
  fit: savedZoom.fit === undefined ? 'width' : savedZoom.fit,
  paged: savedZoom.paged ?? (savedZoom.fit === 'height' || savedZoom.fit === 'page'),
  fitMem: (savedZoom.mem === 'height' || savedZoom.mem === 'page') ? savedZoom.mem : null, fitMemScale: 0,   // 「縦に収める／ページ全体」から拡大したとき、その選択を覚えておく（縮小で元に戻す）
  textMode: LS.get('textMode', 'outline'),
  gamma: LS.get('gamma', 100),
  aa: LS.get('aa', 'auto'),
  libErr: null, zooming: false, lock: { enc: false, annot: true, print: true }, outline: [], bmSel: null,
  cur: 1, want: 1, keep: new Set(), dirNav: 1,
  pages: [], firstView1: null, loadGen: 0,
  annots: [], natives: [], nmap: new Map(), images: new Map(),
  selId: null, tool: 'select', defaults: { ...DEFAULTS }, textDefaults: { ...TEXT_DEFAULTS },
  undo: [], redo: [], dirty: false, drag: null, draft: null, ghost: null, propSnap: null,
  editing: null, busy: false, author: LS.get('author', ''),
};
globalThis.__EPA_MINW = 0;
globalThis.__epaMeshId = 0;                 // pdf.min.mjs の改変（メッシュのグラデーションの使い回し）で使う番号
window.__EPA = S;
/* 注釈の選択（v3.1: 複数選択）。S.sel に選択中のキー（自前の注釈id / 既存注釈 'n:…'）。S.selId は1つだけ選択しているときのキー */
S.sel = new Set();
Object.defineProperty(S, 'selId', {
  get() { return this.sel.size === 1 ? this.sel.values().next().value : null; },
  set(v) { this.sel = v ? new Set([v]) : new Set(); }, enumerable: true, configurable: true,
});
const LINE_ENDS = [               // 並び: なし → 矢印 → 線 → 斜線 → 図形（v3.3）
  ['None', 'なし'],
  ['FilledArrow', '矢印（塗りつぶし）'], ['OpenArrow', '矢印（開く）'], ['ClosedArrow', '矢印（閉じる）'],
  ['ROpenArrow', '矢印（開く・逆）'], ['RClosedArrow', '矢印（閉じる・逆）'],
  ['Butt', '線（棒）'], ['Slash', '斜線'],
  ['Square', '正方形'], ['Circle', '円'], ['Diamond', 'ひし形'],
];
/** PDFの線端の名前（塗りつぶし矢印は ClosedArrow として保存し、元の種類は EPAGeom に記録） */
const pdfLE = (v) => (v === 'FilledArrow' ? 'ClosedArrow' : v);
for (const sel of [$('#pStart'), $('#pEnd')]) for (const [v, t] of LINE_ENDS) sel.add(new Option(t, v));
const NATIVE_TYPES = new Set(['Text', 'FreeText', 'Line', 'Square', 'Circle', 'Polygon', 'PolyLine', 'Highlight',
  'Underline', 'Squiggly', 'StrikeOut', 'Stamp', 'Caret', 'Ink', 'FileAttachment', 'Sound']);
const NATIVE_LABEL = { Text: 'ノート', FreeText: 'テキストボックス', Line: '直線', Square: '四角形', Circle: '楕円', Polygon: '多角形/雲形',
  PolyLine: '折れ線', Highlight: 'ハイライト', Underline: '下線', Squiggly: '波線', StrikeOut: '取り消し線', Stamp: 'スタンプ',
  Caret: '挿入記号', Ink: '手描き', FileAttachment: '添付ファイル', Sound: '音声' };
const NATIVE_RESIZABLE = new Set(['FreeText', 'Square', 'Circle', 'Stamp', 'Ink', 'Line', 'PolyLine', 'Polygon']);
const NATIVE_VERTEX = new Set(['Line', 'PolyLine', 'Polygon']);      // 頂点を編集できる既存の注釈（Polygon は雲形も含む）
// 既存の注釈の頂点。Acrobat の多角形は、最後に最初の頂点をもう一度入れる（dup）ので、編集中はそれを除いて扱う
function nativePts(n) {
  if (!NATIVE_VERTEX.has(n.subtype)) return null;
  if (n.subtype === 'Line') return n.line && n.line.length >= 4 ? { pts: [[n.line[0], n.line[1]], [n.line[2], n.line[3]]], dup: false } : null;
  if (!n.verts || n.verts.length < 2) return null;
  const pts = n.verts.map((q) => q.slice()); let dup = false;
  if (n.subtype === 'Polygon' && pts.length > 3) {
    const a = pts[0], b = pts[pts.length - 1];
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.01) { pts.pop(); dup = true; }
  }
  return { pts, dup };
}
const nativeMinPts = (n) => (n.subtype === 'Polygon' ? 3 : 2);
const OURS_LABEL = { edit: '内容の編集', asel: '注釈選択', ink: '手書き', line: '直線', rect: '四角形', ellipse: '円・楕円', polyline: '折れ線', polygon: '多角形', cloud: '雲形', text: 'テキストコメント', stamp: 'スタンプ（画像）' };
const isMulti = (t) => t === 'polyline' || t === 'polygon' || t === 'cloud';
const isClosedT = (t) => t === 'polygon' || t === 'cloud';            // 閉じた図形（最後の頂点と最初の頂点をつなぐ）
const minPts = (t) => (isClosedT(t) ? 3 : 2);
/* ---------------------------------------------------------------- utils */
const n3 = (v) => String(+Number(v).toFixed(3));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const newId = () => 'epa-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const hex2rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
const rgb2hex = (a) => '#' + a.slice(0, 3).map((v) => Math.round(clamp(v, 0, 1) * 255).toString(16).padStart(2, '0')).join('');
const vadd = (a, b, k = 1) => [a[0] + b[0] * k, a[1] + b[1] * k];
const vlen = (a) => Math.hypot(a[0], a[1]);
const vunit = (a) => { const l = vlen(a) || 1; return [a[0] / l, a[1] / l]; };
const clone = (o) => JSON.parse(JSON.stringify(o));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const normRot = (r) => (((Math.round((r || 0) / 90) * 90) % 360) + 360) % 360;
let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}
/* 処理中の表示（v3.8）: すぐに終わる処理では画面を暗くしない。入力だけ止め、0.7秒以上かかったときに「処理中…」を表示する */
let busyTimer = 0;
function setBusy(b, msg = '処理中…') {
  S.busy = b; $('#busyMsg').textContent = msg;
  const el = $('#busy'); clearTimeout(busyTimer);
  if (!b) { el.classList.remove('on', 'show'); return; }
  el.classList.add('on');
  if (!el.classList.contains('show')) busyTimer = setTimeout(() => { if (S.busy) el.classList.add('show'); }, 700);
}
function parsePdfDate(s) {
  const m = /D:(\d{4})(\d\d)?(\d\d)?(\d\d)?(\d\d)?(\d\d)?/.exec(s || '');
  return m ? new Date(+m[1], (+m[2] || 1) - 1, +m[3] || 1, +m[4] || 0, +m[5] || 0, +m[6] || 0).toISOString() : '';
}
function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso); if (isNaN(d)) return '';
  const z = (v) => String(v).padStart(2, '0');
  return `${d.getFullYear()}/${z(d.getMonth() + 1)}/${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}`;
}
function friendlyError(e) {
  const m = (e && e.message) || String(e);
  if (/encrypt/i.test(m)) return 'このPDFは暗号化（セキュリティ設定）されているため、この方法では編集・保存できません。';
  if (/Failed to parse PDF|No PDF header|Invalid object ref|Expected instance of/i.test(m)) return 'このPDFの内部構造を、保存用のライブラリが読み取れませんでした。';
  return m;
}
/* ------------------------------------------------- shape geometry (PDF座標系) */
function dashArr(p) {
  const u = Math.max(1, p.width);
  switch (p.style) {
    case 'dashed': return [4 * u, 3 * u];
    case 'dotted': return [u, 2 * u];
    case 'dashdot': return [6 * u, 2 * u, u, 2 * u];
    default: return null;
  }
}
const headLen = (w) => 6 + 3 * w;
function endShape(P, Q, type, w, scale = 1) {
  const L = headLen(w) * scale, hw = L * 0.4;          // scale: 始点・終点の大きさ（v3.5。100% = 1）
  const d = vunit([P[0] - Q[0], P[1] - Q[1]]);
  const nrm = [-d[1], d[0]];
  const at = (a, b) => vadd(vadd(P, d, a), nrm, b);
  const prims = []; let trim = 0;
  switch (type) {
    case 'OpenArrow': prims.push({ k: 'path', pts: [at(-L, hw), P, at(-L, -hw)], closed: false }); break;
    case 'ClosedArrow': prims.push({ k: 'path', pts: [P, at(-L, hw), at(-L, -hw)], closed: true }); trim = L * 0.9; break;
    case 'FilledArrow': prims.push({ k: 'path', pts: [P, at(-L, hw), at(-L, -hw)], closed: true, solid: true }); trim = L * 0.9; break;
    case 'ROpenArrow': prims.push({ k: 'path', pts: [at(L, hw), P, at(L, -hw)], closed: false }); break;
    case 'RClosedArrow': prims.push({ k: 'path', pts: [P, at(L, hw), at(L, -hw)], closed: true }); break;
    case 'Butt': prims.push({ k: 'path', pts: [at(0, hw), at(0, -hw)], closed: false }); break;
    case 'Slash': { const v = vunit([nrm[0] * 0.866 + d[0] * 0.5, nrm[1] * 0.866 + d[1] * 0.5]);
      prims.push({ k: 'path', pts: [vadd(P, v, L * 0.5), vadd(P, v, -L * 0.5)], closed: false }); break; }
    case 'Square': { const s = L * 0.5; prims.push({ k: 'path', pts: [at(s, s), at(s, -s), at(-s, -s), at(-s, s)], closed: true }); break; }
    case 'Diamond': { const s = L * 0.55; prims.push({ k: 'path', pts: [at(s, 0), at(0, s), at(-s, 0), at(0, -s)], closed: true }); break; }
    case 'Circle': prims.push({ k: 'circle', c: P, r: L * 0.4, closed: true }); break;
    default: break;
  }
  return { prims, trim };
}
/** 雲形: 多角形の各辺を、外側に膨らむ半円に置き換える（v3.4）。
 *  半円どうしは継ぎ目で接するので、内側の先端は細く入り込み、線のつなぎ目（丸）で先だけが丸くなる */
function cloudPath(pts, inten = 1) {
  const n = pts.length; let A = 0;
  for (let i = 0; i < n; i++) { const a = pts[i], b = pts[(i + 1) % n]; A += a[0] * b[1] - b[0] * a[1]; }
  const ccw = A > 0, chord = 10 * (inten >= 2 ? 1.7 : 1), segs = [];
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n], len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 0.01) continue;
    const m = Math.max(1, Math.round(len / chord)), c = len / m, u = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
    const nrm = ccw ? [u[1], -u[0]] : [-u[1], u[0]], r = c / 2;
    for (let j = 0; j < m; j++) {
      const P = [a[0] + u[0] * c * j, a[1] + u[1] * c * j], M = [P[0] + u[0] * r, P[1] + u[1] * r];
      const aP = Math.atan2(P[1] - M[1], P[0] - M[0]);
      // 半円の向き: 真ん中が外側（nrm 側）に来るほう
      const sw = Math.cos(aP + Math.PI / 2) * nrm[0] + Math.sin(aP + Math.PI / 2) * nrm[1] > 0 ? Math.PI : -Math.PI;
      for (let k = 0; k < 2; k++) {
        const t0 = aP + sw / 2 * k, t1 = t0 + sw / 2, kk = 4 / 3 * Math.tan(sw / 8) * r;
        const p0 = [M[0] + r * Math.cos(t0), M[1] + r * Math.sin(t0)], p3 = [M[0] + r * Math.cos(t1), M[1] + r * Math.sin(t1)];
        segs.push([[p0[0] - Math.sin(t0) * kk, p0[1] + Math.cos(t0) * kk], [p3[0] + Math.sin(t1) * kk, p3[1] - Math.cos(t1) * kk], p3]);
      }
    }
  }
  return { start: pts[0].slice(), segs };
}
/** 楕円（外接する四角形の2頂点から）: 4本の3次ベジェで近似 */
function ellipsePath(p0, p1) {
  const cx = (p0[0] + p1[0]) / 2, cy = (p0[1] + p1[1]) / 2, rx = Math.abs(p1[0] - p0[0]) / 2, ry = Math.abs(p1[1] - p0[1]) / 2, k = 0.5522847498;
  return { start: [cx + rx, cy], segs: [
    [[cx + rx, cy + k * ry], [cx + k * rx, cy + ry], [cx, cy + ry]],
    [[cx - k * rx, cy + ry], [cx - rx, cy + k * ry], [cx - rx, cy]],
    [[cx - rx, cy - k * ry], [cx - k * rx, cy - ry], [cx, cy - ry]],
    [[cx + k * rx, cy - ry], [cx + rx, cy - k * ry], [cx + rx, cy]] ] };
}
/* ---- 回転（v3.1）: a.rot（度・反時計回り）。四角形・楕円・スタンプは中心、テキストは左上の基点を中心に回す */
const rotPt = (q, c, deg) => { if (!deg) return [q[0], q[1]]; const t = deg * Math.PI / 180, cs = Math.cos(t), sn = Math.sin(t), dx = q[0] - c[0], dy = q[1] - c[1]; return [c[0] + dx * cs - dy * sn, c[1] + dx * sn + dy * cs]; };
const normDeg = (d) => { let v = ((d % 360) + 360) % 360; if (v > 180) v -= 360; return Math.abs(v) < 1e-6 ? 0 : v; };
function localBox(a) {
  if (a.type === 'text') { const L = layoutText(a.text, a.p.fontSize, a.w, { face: a.p.face }); return [a.pts[0][0], a.pts[0][1] - L.h, a.pts[0][0] + a.w, a.pts[0][1]]; }
  const [p0, p1] = a.pts;
  return [Math.min(p0[0], p1[0]), Math.min(p0[1], p1[1]), Math.max(p0[0], p1[0]), Math.max(p0[1], p1[1])];
}
function pivotOf(a) { if (a.type === 'text') return a.pts[0]; const b = localBox(a); return [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]; }
/** テキスト・スタンプ・四角形・楕円の外形（回転込みの4隅） */
function annotQuad(a) {
  const b = localBox(a), c = pivotOf(a);
  return [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]].map((q) => rotPt(q, c, a.rot || 0));
}
const rotPrim = (pr, c, deg) => {
  if (!deg) return pr;
  if (pr.k === 'bez') return { ...pr, start: rotPt(pr.start, c, deg), segs: pr.segs.map((s) => s.map((q) => rotPt(q, c, deg))) };
  if (pr.k === 'circle') return { ...pr, c: rotPt(pr.c, c, deg) };
  return { ...pr, pts: pr.pts.map((q) => rotPt(q, c, deg)) };
};
/** 角を丸めた四角形（円弧の近似） */
function roundRectPath(x0, y0, x1, y1, r) {
  r = Math.min(r, (x1 - x0) / 2, (y1 - y0) / 2); const k = 0.5522847498 * r, segs = [];
  let cur = [x0 + r, y0];
  const L = (q) => { segs.push([cur.slice(), q.slice(), q.slice()]); cur = q; };
  const C = (c1, c2, q) => { segs.push([c1, c2, q]); cur = q; };
  L([x1 - r, y0]); C([x1 - r + k, y0], [x1, y0 + r - k], [x1, y0 + r]);
  L([x1, y1 - r]); C([x1, y1 - r + k], [x1 - r + k, y1], [x1 - r, y1]);
  L([x0 + r, y1]); C([x0 + r - k, y1], [x0, y1 - r + k], [x0, y1 - r]);
  L([x0, y0 + r]); C([x0, y0 + r - k], [x0 + r - k, y0], [x0 + r, y0]);
  return { start: [x0 + r, y0], segs };
}
/** 折れ線の角を丸める（各頂点の前後を r だけ切り、頂点を制御点にした曲線でつなぐ） */
function roundPolyPath(pts, r) {
  const segs = []; let cur = pts[0].slice();
  for (let i = 1; i < pts.length; i++) {
    const V = pts[i];
    if (i === pts.length - 1) { segs.push([cur.slice(), V.slice(), V.slice()]); cur = V.slice(); break; }
    const P = pts[i - 1], Nx = pts[i + 1];
    const lp = Math.hypot(P[0] - V[0], P[1] - V[1]), ln = Math.hypot(Nx[0] - V[0], Nx[1] - V[1]);
    const t = Math.min(r, lp / 2, ln / 2);
    if (t < 0.01) { segs.push([cur.slice(), V.slice(), V.slice()]); cur = V.slice(); continue; }
    const A = [V[0] + (P[0] - V[0]) / lp * t, V[1] + (P[1] - V[1]) / lp * t], B = [V[0] + (Nx[0] - V[0]) / ln * t, V[1] + (Nx[1] - V[1]) / ln * t];
    segs.push([cur.slice(), A.slice(), A.slice()]);
    segs.push([[A[0] + (V[0] - A[0]) * 2 / 3, A[1] + (V[1] - A[1]) * 2 / 3], [B[0] + (V[0] - B[0]) * 2 / 3, B[1] + (V[1] - B[1]) * 2 / 3], B.slice()]);
    cur = B.slice();
  }
  return { start: pts[0].slice(), segs };
}
// 注釈を描画用の部品（パス・楕円・文字など）に分解する。画面表示とPDF保存の両方で使う
function shapePrims(a) {
  const fill = !!a.p.fill;
  if (a.type === 'ink') {
    return (a.strokes || []).map((st, i) => ({ k: 'path', pts: st.pts.map((q) => q.slice()), closed: !!st.closed, fill: !!st.fill, main: i === 0,
      style: { color: st.color, width: st.width, fill: st.fill || null, dash: st.dash || null, op: st.op ?? 1 } }));
  }
  if (a.type === 'ellipse') { const e = ellipsePath(a.pts[0], a.pts[1]); return [rotPrim({ k: 'bez', start: e.start, segs: e.segs, closed: true, fill, main: true }, pivotOf(a), a.rot || 0)]; }
  if (a.type === 'rect') {
    const [x1, y1] = a.pts[0], [x2, y2] = a.pts[1], r = a.p.radius || 0;
    const pr = r > 0 && Math.abs(x2 - x1) > 0.01 && Math.abs(y2 - y1) > 0.01
      ? (() => { const e = roundRectPath(Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2), r); return { k: 'bez', start: e.start, segs: e.segs, closed: true, fill, main: true }; })()
      : { k: 'path', pts: [[x1, y1], [x2, y1], [x2, y2], [x1, y2]], closed: true, fill, main: true };
    return [rotPrim(pr, pivotOf(a), a.rot || 0)];
  }
  if (a.type === 'cloud') {
    if (a.pts.length < 3) return [{ k: 'path', pts: a.pts.map((p) => p.slice()), closed: false, fill: false, main: true }];
    const cp = cloudPath(a.pts, a.p.intensity || 1);
    return [{ k: 'bez', start: cp.start, segs: cp.segs, closed: true, fill, main: true }];
  }
  if (a.type === 'polygon') return [{ k: 'path', pts: a.pts.map((p) => p.slice()), closed: a.pts.length >= 3, fill: fill && a.pts.length >= 3, main: true }];
  const pts = a.pts.map((p) => p.slice());
  const ends = [];
  if (pts.length >= 2) {
    const s = endShape(pts[0], pts[1], a.p.start, a.p.width, (a.p.startSize ?? 100) / 100);
    const e = endShape(pts[pts.length - 1], pts[pts.length - 2], a.p.end, a.p.width, (a.p.endSize ?? 100) / 100);
    const trimEnd = (idx, nb, t) => {
      if (!t) return;
      const v = [pts[nb][0] - pts[idx][0], pts[nb][1] - pts[idx][1]];
      if (vlen(v) > t * 1.05) pts[idx] = vadd(pts[idx], vunit(v), t);
    };
    trimEnd(0, 1, s.trim); trimEnd(pts.length - 1, pts.length - 2, e.trim);
    ends.push(...s.prims, ...e.prims);
  }
  const out = [a.type === 'polyline' && (a.p.radius || 0) > 0 && pts.length >= 3
    ? (() => { const e = roundPolyPath(pts, a.p.radius); return { k: 'bez', start: e.start, segs: e.segs, closed: false, fill: false, main: true }; })()
    : { k: 'path', pts, closed: false, fill: false, main: true }];
  for (const p of ends) {
    if (p.solid) out.push({ ...p, fill: true, style: { color: a.p.color, width: a.p.width, fill: a.p.color, dash: null, op: 1 } });   // 線の色で塗りつぶす矢印
    else out.push({ ...p, fill: fill && p.closed });
  }
  return out;
}
/** 曲線を折れ線に（手書き注釈への変換用） */
function flattenPrim(pr) {
  if (pr.k === 'path') return pr.pts.map((q) => q.slice());
  if (pr.k === 'circle') { const o = []; for (let i = 0; i <= 32; i++) { const t = i / 32 * Math.PI * 2; o.push([pr.c[0] + pr.r * Math.cos(t), pr.c[1] + pr.r * Math.sin(t)]); } return o; }
  const o = [pr.start.slice()]; let c = pr.start;
  for (const [c1, c2, q] of pr.segs) {
    const straight = Math.hypot(c1[0] - c[0], c1[1] - c[1]) < 1e-6 && Math.hypot(c2[0] - q[0], c2[1] - q[1]) < 1e-6;
    const n = straight ? 1 : 12;
    for (let i = 1; i <= n; i++) {
      const t = i / n, u = 1 - t;
      o.push([u * u * u * c[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * q[0], u * u * u * c[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * q[1]]);
    }
    c = q;
  }
  return o;
}
/** 1つのプリミティブの描画スタイル（手書き注釈は線ごとに持つ） */
const primStyle = (a, pr) => pr.style || { color: a.p.color, width: a.p.width, fill: pr.fill && a.p.fill ? a.p.fill : null, dash: pr.main ? dashArr(a.p) : null, op: 1 };
function primsBBox(prims) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (x, y) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); };
  for (const p of prims) {
    if (p.k === 'circle') { add(p.c[0] - p.r, p.c[1] - p.r); add(p.c[0] + p.r, p.c[1] + p.r); }
    else if (p.k === 'bez') { add(...p.start); for (const s of p.segs) for (const q of s) add(q[0], q[1]); }
    else p.pts.forEach((q) => add(q[0], q[1]));
  }
  return [x0, y0, x1, y1];
}
/* ------------------------------------------------------- テキストのレイアウト（保存する実テキストと同じ字幅で改行） */
const FONT_LAT = 'Helvetica, Arial, "Liberation Sans", sans-serif';
const FONT_MINCHO_JP = '"Yu Mincho","YuMincho","MS Mincho","Hiragino Mincho ProN","Noto Serif CJK JP",serif';
const FONT_STACK = `Helvetica, Arial, "Liberation Sans", "MS Gothic", "Yu Gothic", "Meiryo", "Noto Sans CJK JP", sans-serif`;
const SCRATCH = await PDFDocument.create();
const HELV = SCRATCH.embedStandardFont(StandardFonts.Helvetica);
// テキスト注釈の書体（v4.11）。欧文は標準14フォント、和文は埋め込まないフォント（閲覧する側の明朝・ゴシックで表示される）
//  lat/jp: PDF内のフォント名（外観ストリームと /DA で使う）、std: 欧文の字幅の計算用、css: 画面表示用
const FACES = {
  gothic: { label: 'ゴシック', lat: 'Helv', jp: 'EPAJp', std: HELV, css: { l: FONT_LAT, j: '"MS Gothic","Yu Gothic","Meiryo","Hiragino Sans","Noto Sans CJK JP",sans-serif' } },
  mincho: { label: '明朝', lat: 'TiRo', jp: 'EPAJpM', std: SCRATCH.embedStandardFont(StandardFonts.TimesRoman), css: { l: '"Times New Roman",Times,"Liberation Serif",serif', j: FONT_MINCHO_JP } },
  mono: { label: '等幅', lat: 'Cour', jp: 'EPAJp', std: SCRATCH.embedStandardFont(StandardFonts.Courier), css: { l: '"Courier New",Courier,"Liberation Mono",monospace', j: '"MS Gothic","Noto Sans Mono CJK JP","Noto Sans CJK JP",monospace' } },
};
const faceOf = (f) => FACES[f] || FACES.gothic;
const latCache = new Map();
function latW1(ch, face = 'gothic') {
  const k = face + ch; let w = latCache.get(k);
  if (w === undefined) { try { w = faceOf(face).std.widthOfTextAtSize(ch, 1000) / 1000; } catch { w = 0.556; } latCache.set(k, w); }
  return w;
}
const isLat = (c) => (c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff);
const isHW = (c) => c >= 0xff61 && c <= 0xff9f;
const chW = (ch, fs, face) => { const c = ch.codePointAt(0); return isLat(c) ? latW1(ch, face) * fs : isHW(c) ? fs * 0.5 : fs; };
const strW = (s, fs, face) => { let w = 0; for (const ch of s) w += chW(ch, fs, face); return w; };
function wrapPara(para, fs, maxW, face) {
  const out = []; let cur = '', cw = 0;
  const toks = para.match(/[\x21-\x7e\xa1-\xff]+|[\s\S]/gu) || [];
  for (const t of toks) {
    const tw = strW(t, fs, face);
    if (cw + tw <= maxW) { cur += t; cw += tw; continue; }
    if (/^\s$/.test(t)) { out.push(cur.replace(/\s+$/, '')); cur = ''; cw = 0; continue; }
    if (cur !== '') { out.push(cur.replace(/\s+$/, '')); cur = ''; cw = 0; }
    if (tw <= maxW) { cur = t; cw = tw; continue; }
    for (const ch of t) { const w = chW(ch, fs, face); if (cw + w > maxW && cur !== '') { out.push(cur); cur = ''; cw = 0; } cur += ch; cw += w; }
  }
  out.push(cur.replace(/\s+$/, ''));
  return out;
}
function toRuns(line, fs, face) {
  const runs = []; let x = 0, cur = null;
  for (const ch of line) {
    const c = ch.codePointAt(0), f = isLat(c) ? 'l' : 'j', w = chW(ch, fs, face);
    if (cur && cur.f === f) { cur.t += ch; cur.w += w; } else { cur = { t: ch, f, x, w }; runs.push(cur); }
    x += w;
  }
  return { runs, w: x };
}
function layoutText(text, fs, w, o = {}) {
  const pad = o.pad ?? 2, q = o.q || 0, face = o.face || 'gothic';
  const maxW = Math.max(fs, w - pad * 2);
  const lines = [];
  for (const para of String(text || '').replace(/\t/g, '    ').split(/\r\n|\r|\n/)) {
    for (const ln of (para === '' ? [''] : wrapPara(para, fs, maxW, face))) {
      const r = toRuns(ln, fs, face);
      const dx = pad + (q === 1 ? (maxW - r.w) / 2 : q === 2 ? maxW - r.w : 0);
      r.runs.forEach((u) => { u.x += dx; });
      lines.push(r);
    }
  }
  const lh = fs * 1.25, b = (lh - fs) / 2 + fs * 0.86;
  return { lines, lh, b, pad, w, h: Math.max(lines.length, 1) * lh + pad * 2, maxLineW: Math.max(0, ...lines.map((l) => l.w)),
    hasJp: lines.some((l) => l.runs.some((r) => r.f === 'j' && r.t.trim() !== '')) };
}
function annotBBox(a) {
  if (a.rot && (a.type === 'rect' || a.type === 'ellipse')) return primsBBox(shapePrims(a));
  if (a.rot && (a.type === 'text' || a.type === 'stamp')) { const q = annotQuad(a); return [Math.min(...q.map((v) => v[0])), Math.min(...q.map((v) => v[1])), Math.max(...q.map((v) => v[0])), Math.max(...q.map((v) => v[1]))]; }
  if (a.type === 'text') {
    const L = layoutText(a.text, a.p.fontSize, a.w, { face: a.p.face });
    return [a.pts[0][0], a.pts[0][1] - L.h, a.pts[0][0] + a.w, a.pts[0][1]];
  }
  if (a.type === 'stamp' || a.type === 'rect' || a.type === 'ellipse') {
    const [p0, p1] = a.pts;
    return [Math.min(p0[0], p1[0]), Math.min(p0[1], p1[1]), Math.max(p0[0], p1[0]), Math.max(p0[1], p1[1])];
  }
  return primsBBox(shapePrims(a));
}
const isRectLike = (a) => a.type === 'rect' || a.type === 'ellipse' || a.type === 'stamp';
/* ------------------------------------------------------- PDF 外観ストリーム(図形) */
function buildAP(a, gsName = () => 'GS0') {
  const prims = shapePrims(a), ops = [];
  ops.push('/GS0 gs');
  ops.push(`0 J ${a.type === 'ink' || a.type === 'cloud' ? 1 : 0} j 10 M`);
  for (const p of prims) {
    const st = primStyle(a, p), d = st.dash;
    if (a.type === 'ink') ops.push(`/${gsName(st.op ?? 1)} gs`);
    ops.push(`${hex2rgb(st.color).map(n3).join(' ')} RG`, `${n3(st.width)} w`);
    if (st.fill) ops.push(`${hex2rgb(st.fill).map(n3).join(' ')} rg`);
    ops.push(d ? `[${d.map(n3).join(' ')}] 0 d` : '[] 0 d');
    if (p.k === 'circle') {
      const [cx, cy] = p.c, r = p.r, k = 0.5523 * r;
      ops.push(`${n3(cx + r)} ${n3(cy)} m`,
        `${n3(cx + r)} ${n3(cy + k)} ${n3(cx + k)} ${n3(cy + r)} ${n3(cx)} ${n3(cy + r)} c`,
        `${n3(cx - k)} ${n3(cy + r)} ${n3(cx - r)} ${n3(cy + k)} ${n3(cx - r)} ${n3(cy)} c`,
        `${n3(cx - r)} ${n3(cy - k)} ${n3(cx - k)} ${n3(cy - r)} ${n3(cx)} ${n3(cy - r)} c`,
        `${n3(cx + k)} ${n3(cy - r)} ${n3(cx + r)} ${n3(cy - k)} ${n3(cx + r)} ${n3(cy)} c h`);
    } else if (p.k === 'bez') {
      ops.push(`${n3(p.start[0])} ${n3(p.start[1])} m`);
      for (const s of p.segs) ops.push(`${s.map((q) => `${n3(q[0])} ${n3(q[1])}`).join(' ')} c`);
      if (p.closed !== false) ops.push('h');
    } else {
      p.pts.forEach((q, i) => ops.push(`${n3(q[0])} ${n3(q[1])} ${i ? 'l' : 'm'}`));
      if (p.closed) ops.push('h');
    }
    ops.push(p.fill && st.fill ? 'B' : 'S');
  }
  return `q\n${ops.join('\n')}\nQ\n`;
}
/* ------------------------------------------------- フォント / 実テキストの外観 (FreeText) */
const FONTMAP = new WeakMap();
function fontRefs(doc) {
  let r = FONTMAP.get(doc); if (r) return r;
  const ctx = doc.context;
  const helv = doc.embedStandardFont(StandardFonts.Helvetica);
  const desc = ctx.register(ctx.obj({ Type: 'FontDescriptor', FontName: 'MS-Gothic', Flags: 4, FontBBox: [0, -137, 1000, 859],
    ItalicAngle: 0, Ascent: 859, Descent: -140, CapHeight: 709, StemV: 80 }));
  const cid = ctx.register(ctx.obj({ Type: 'Font', Subtype: 'CIDFontType2', BaseFont: 'MS-Gothic',
    CIDSystemInfo: { Registry: PDFString.of('Adobe'), Ordering: PDFString.of('Japan1'), Supplement: 6 },
    FontDescriptor: desc, DW: 1000, W: [231, 632, 500] }));
  const jp = ctx.register(ctx.obj({ Type: 'Font', Subtype: 'Type0', BaseFont: 'MS-Gothic-UniJIS-UTF16-H',
    Encoding: 'UniJIS-UTF16-H', DescendantFonts: [cid] }));
  r = { helv: helv.ref, jp }; FONTMAP.set(doc, r);
  // 明朝・等幅の書体（使うときだけ作る）
  r.more = () => {
    if (r.all) return r.all;
    const descM = ctx.register(ctx.obj({ Type: 'FontDescriptor', FontName: 'MS-Mincho', Flags: 6, FontBBox: [0, -137, 1000, 859],
      ItalicAngle: 0, Ascent: 859, Descent: -140, CapHeight: 709, StemV: 80 }));
    const cidM = ctx.register(ctx.obj({ Type: 'Font', Subtype: 'CIDFontType2', BaseFont: 'MS-Mincho',
      CIDSystemInfo: { Registry: PDFString.of('Adobe'), Ordering: PDFString.of('Japan1'), Supplement: 6 }, FontDescriptor: descM, DW: 1000, W: [231, 632, 500] }));
    const jpM = ctx.register(ctx.obj({ Type: 'Font', Subtype: 'Type0', BaseFont: 'MS-Mincho-UniJIS-UTF16-H', Encoding: 'UniJIS-UTF16-H', DescendantFonts: [cidM] }));
    r.all = { Helv: r.helv, EPAJp: r.jp, EPAJpM: jpM, TiRo: doc.embedStandardFont(StandardFonts.TimesRoman).ref, Cour: doc.embedStandardFont(StandardFonts.Courier).ref };
    return r.all;
  };
  return r;
}
function ensureDR(doc) {
  const refs = fontRefs(doc), ctx = doc.context, root = doc.catalog, N = (k) => PDFName.of(k);
  let af = ctx.lookup(root.get(N('AcroForm')));
  if (!(af instanceof PDFDict)) { af = ctx.obj({ Fields: [], DA: PDFString.of('/Helv 0 Tf 0 g') }); root.set(N('AcroForm'), ctx.register(af)); }
  let dr = ctx.lookup(af.get(N('DR')));
  if (!(dr instanceof PDFDict)) { dr = ctx.obj({}); af.set(N('DR'), dr); }
  let fd = ctx.lookup(dr.get(N('Font')));
  if (!(fd instanceof PDFDict)) { fd = ctx.obj({}); dr.set(N('Font'), fd); }
  if (!fd.has(N('Helv'))) fd.set(N('Helv'), refs.helv);
  if (!fd.has(N('EPAJp'))) fd.set(N('EPAJp'), refs.jp);
  if (refs.all) for (const [k, v] of Object.entries(refs.all)) if (!fd.has(N(k))) fd.set(N(k), v);
}
const hexLat = (s) => [...s].map((ch) => ch.codePointAt(0).toString(16).padStart(2, '0')).join('');
const hexU16 = (s) => { let o = ''; for (let i = 0; i < s.length; i++) o += s.charCodeAt(i).toString(16).padStart(4, '0'); return o; };
const ROTM = { 0: [1, 0, 0, 1], 90: [0, 1, -1, 0], 180: [-1, 0, 0, -1], 270: [0, -1, 1, 0] };
const rotMatrix = (r) => [...ROTM[normRot(r)], 0, 0];
// スタンプの画像が正立するページの回転（貼ったときの回転。古いデータで不明なら pageRot）
const stampRot = (a, pageRot) => (a.prot === undefined || a.prot === null ? normRot(pageRot) : normRot(a.prot));
function buildTextAP(doc, s) {
  const ctx = doc.context, refs = fontRefs(doc), F = faceOf(s.face);
  const fonts = !s.face || s.face === 'gothic' ? { Helv: refs.helv, EPAJp: refs.jp } : refs.more();
  const L = layoutText(s.text, s.fs, s.w, { q: s.q || 0, pad: s.pad ?? 2, face: s.face });
  const ops = ['/GS0 gs', 'q', `0 0 ${n3(s.w)} ${n3(s.h)} re W n`];
  if (s.fill) ops.push(`${s.fill.map(n3).join(' ')} rg 0 0 ${n3(s.w)} ${n3(s.h)} re f`);
  if (s.bw > 0) ops.push(`${s.bcolor.map(n3).join(' ')} RG ${n3(s.bw)} w ${n3(s.bw / 2)} ${n3(s.bw / 2)} ${n3(s.w - s.bw)} ${n3(s.h - s.bw)} re S`);
  ops.push(`${s.rgb.map(n3).join(' ')} rg`);
  L.lines.forEach((ln, i) => {
    const y = s.h - L.pad - i * L.lh - L.b;
    for (const r of ln.runs) {
      if (r.t.trim() === '') continue;
      ops.push(`BT /${r.f === 'l' ? F.lat : F.jp} ${n3(s.fs)} Tf ${n3(r.x)} ${n3(y)} Td <${r.f === 'l' ? hexLat(r.t) : hexU16(r.t)}> Tj ET`);
    }
  });
  ops.push('Q');
  const op = s.opacity ?? 1;
  const dict = { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, s.w, s.h],
    Resources: { ExtGState: { GS0: { Type: 'ExtGState', CA: op, ca: op } }, Font: fonts } };
  if (s.rot) dict.Matrix = rotMatrix(s.rot);
  if (s.mat) dict.Matrix = s.mat;
  return { ref: ctx.register(ctx.stream(ops.join('\n'), dict)), hasJp: L.hasJp, daFont: L.hasJp ? F.jp : F.lat };
}
const daString = (font, fs, rgb) => `/${font} ${n3(fs)} Tf ${rgb.map(n3).join(' ')} rg`;
function parseDA(da) {
  da = String(da || '');
  const m = /\/\S+\s+([\d.]+)\s+Tf/.exec(da);
  const fs = m && +m[1] > 0 ? +m[1] : 12;
  let c, rgb = [0, 0, 0];
  if ((c = /([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+rg\b/.exec(da))) rgb = [+c[1], +c[2], +c[3]];
  else if ((c = /([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+k\b/.exec(da))) { const k = 1 - +c[4]; rgb = [(1 - +c[1]) * k, (1 - +c[2]) * k, (1 - +c[3]) * k]; }
  else if ((c = /([\d.]+)\s+g\b/.exec(da))) rgb = [+c[1], +c[1], +c[1]];
  return { fs, rgb };
}
/* ---------------------------------------------------- PDF 保存 / 読み込み */
const pdfDate = () => { const d = new Date(); const z = (v) => String(v).padStart(2, '0');
  return `D:${d.getUTCFullYear()}${z(d.getUTCMonth() + 1)}${z(d.getUTCDate())}${z(d.getUTCHours())}${z(d.getUTCMinutes())}${z(d.getUTCSeconds())}Z`; };
// 追加した注釈1つを、pdf-lib のページに本物のPDF注釈（外観ストリーム付き）として書き込む
async function addAnnotToPage(doc, page, a, cache) {
  const ctx = doc.context;
  const op = a.p.opacity / 100;
  const gs = { Type: 'ExtGState', CA: op, ca: op };
  const base = { Type: 'Annot', F: 4, NM: PDFString.of(a.id), M: PDFString.of(pdfDate()), P: page.ref, EPAType: a.type, CA: op };
  if (a.author) base.T = PDFHexString.fromText(a.author);
  if (a.date) base.CreationDate = PDFString.of(pdfDate());
  base.EPAGeom = PDFHexString.fromText(JSON.stringify({ pts: a.pts, w: a.w ?? null, rot: a.rot || 0, prot: a.prot ?? null, face: a.p.face || null, autoW: a.autoW || null, radius: a.p.radius || 0, ends: [a.p.start, a.p.end], endSizes: [a.p.startSize ?? 100, a.p.endSize ?? 100] }));
  const rotM = a.rot ? (() => { const t = a.rot * Math.PI / 180; return [Math.cos(t), Math.sin(t), -Math.sin(t), Math.cos(t), 0, 0]; })() : null;
  let dict, R;
  if (a.type === 'text') {
    R = annotBBox(a);
    const lb = localBox(a);
    const rgb = hex2rgb(a.p.color), bw = a.p.width || 0;
    const ap = buildTextAP(doc, { w: lb[2] - lb[0], h: lb[3] - lb[1], rot: 0, mat: rotM, text: a.text, fs: a.p.fontSize, rgb, face: a.p.face,
      fill: a.p.fill ? hex2rgb(a.p.fill) : null, bw, bcolor: rgb, opacity: op, q: 0, pad: 2 });
    ensureDR(doc);
    dict = { ...base, Subtype: 'FreeText', Rect: R, Contents: PDFHexString.fromText(a.text),
      DA: PDFString.of(daString(ap.daFont, a.p.fontSize, rgb)), Q: 0,
      BS: { Type: 'Border', W: bw, S: 'S' }, AP: { N: ap.ref } };
    if (bw > 0) dict.C = rgb;
    if (a.p.fill) dict.IC = hex2rgb(a.p.fill);
  } else if (a.type === 'stamp') {
    const im = S.images.get(a.img); if (!im) return;
    let c = cache.get(a.img);
    if (!c) {
      const img = await doc.embedPng(im.bytes);
      c = { img, png: ctx.register(ctx.stream(im.bytes, { Type: 'EPAImage' })) };
      cache.set(a.img, c);
    }
    const [x0, y0, x1, y1] = localBox(a); R = annotBBox(a);
    const rot = stampRot(a, cache.rot(a.page));
    const Wv = rot % 180 ? y1 - y0 : x1 - x0, Hv = rot % 180 ? x1 - x0 : y1 - y0;
    const form = { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, Wv, Hv], Resources: { ExtGState: { GS0: gs }, XObject: { Im0: c.img.ref } } };
    if (rot) form.Matrix = rotMatrix(rot);
    if (rotM) form.Matrix = CE.mul(rot ? rotMatrix(rot) : [1, 0, 0, 1, 0, 0], rotM);
    const ap = ctx.register(ctx.stream(`q\n/GS0 gs\nq ${n3(Wv)} 0 0 ${n3(Hv)} 0 0 cm /Im0 Do Q\nQ\n`, form));
    dict = { ...base, Subtype: 'Stamp', Rect: R, Name: 'EPAImage', AP: { N: ap }, EPAImage: c.png };
  } else if (a.type === 'ink') {
    const prims = shapePrims(a), gsMap = new Map();
    const gsName = (o) => { if (Math.abs(o - 1) < 1e-6) return 'GS0'; const k = o.toFixed(3); if (!gsMap.has(k)) gsMap.set(k, 'GS' + (gsMap.size + 1)); return gsMap.get(k); };
    const maxW = Math.max(1, ...prims.map((p) => primStyle(a, p).width));
    const [x0, y0, x1, y1] = primsBBox(prims), pad = maxW + 1;
    R = [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
    const apText = buildAP(a, gsName);
    const egs = { GS0: gs };
    for (const [k, nm] of gsMap) egs[nm] = { Type: 'ExtGState', CA: op * +k, ca: op * +k };
    const ap = ctx.register(ctx.stream(apText, { Type: 'XObject', Subtype: 'Form', BBox: R, Resources: { ExtGState: egs } }));
    const s0 = a.strokes[0] || { color: a.p.color, width: a.p.width };
    dict = { ...base, Subtype: 'Ink', Rect: R, C: hex2rgb(s0.color), BS: { Type: 'Border', W: s0.width, S: 'S' },
      InkList: a.strokes.map((st) => st.pts.flat()), AP: { N: ap }, EPAInk: PDFHexString.fromText(JSON.stringify(a.strokes)) };
  } else {
    const w = a.p.width, rect = a.type === 'rect' || a.type === 'ellipse', cloud = a.type === 'cloud';
    const [x0, y0, x1, y1] = primsBBox(shapePrims(a));
    const pad = rect ? w / 2 : Math.max(w * 1.5, 1) + 1;
    R = [x0 - pad, y0 - pad, x1 + pad, y1 + pad].map(Number);
    const ap = ctx.register(ctx.stream(buildAP(a), { Type: 'XObject', Subtype: 'Form', BBox: R, Resources: { ExtGState: { GS0: gs } } }));
    const dash = dashArr(a.p);
    dict = { ...base, Subtype: a.type === 'ellipse' ? 'Circle' : rect ? 'Square' : isClosedT(a.type) ? 'Polygon' : a.type === 'line' ? 'Line' : 'PolyLine', Rect: R,
      C: hex2rgb(a.p.color),
      BS: dash ? { Type: 'Border', W: w, S: 'D', D: dash } : { Type: 'Border', W: w, S: 'S' },
      EPAStyle: a.p.style, AP: { N: ap } };
    if (a.p.fill) dict.IC = hex2rgb(a.p.fill);
    if (rect && !a.rot) dict.RD = [pad, pad, pad, pad];
    else if (cloud) { dict.Vertices = a.pts.flat(); dict.BE = { S: 'C', I: a.p.intensity || 1 }; }
    else if (a.type === 'polygon') dict.Vertices = a.pts.flat();
    else {
      dict.LE = [pdfLE(a.p.start), pdfLE(a.p.end)];
      if (a.type === 'line') dict.L = [...a.pts[0], ...a.pts[1]];
      else dict.Vertices = a.pts.flat();
    }
  }
  const ref = ctx.register(ctx.obj(dict));
  let arr = page.node.Annots();
  if (!arr) { arr = ctx.obj([]); page.node.set(PDFName.of('Annots'), arr); }
  arr.push(ref);
}
async function buildViaPdfLib(base = S.baseBytes) {
  const doc = await PDFDocument.load(await baseAll(base), { updateMetadata: false });
  await writeAnnots(doc, S.annots);
  return await doc.save({ useObjectStreams: false });
}
// 追加した注釈（annots）を、pdf-lib の文書に本物のPDF注釈として書き込む
async function writeAnnots(doc, annots) {
  const pages = doc.getPages(), cache = new Map(), rots = new Map();
  for (const a of annots) if (a.type === 'stamp' && !rots.has(a.page)) rots.set(a.page, normRot((await S.pdf.getPage(a.page)).rotate));
  cache.rot = (n) => rots.get(n) || 0;
  for (const a of annots) if (pages[a.page - 1]) await addAnnotToPage(doc, pages[a.page - 1], a, cache);
}
/* ---- 代替の保存方法（暗号化PDFなど、pdf-libで読めないPDF用）: 図形・テキスト・スタンプを高解像度の画像として、暗号化を保ったまま追記する */
function rasterAnnot(a, k0 = 4) {
  const bb = annotBBox(a), pad = Math.max(2, (a.p.width || 0) * 2 + 8);
  const x0 = bb[0] - pad, y0 = bb[1] - pad, x1 = bb[2] + pad, y1 = bb[3] + pad, w = x1 - x0, h = y1 - y0;
  const k = Math.min(k0, 4096 / Math.max(w, h));
  const cv = document.createElement('canvas'); cv.width = Math.max(1, Math.ceil(w * k)); cv.height = Math.max(1, Math.ceil(h * k));
  const c = cv.getContext('2d');
  c.setTransform(k, 0, 0, -k, -x0 * k, y1 * k);
  c.globalAlpha = (a.p.opacity ?? 100) / 100;
  if (a.type === 'text') {
    const L = layoutText(a.text, a.p.fontSize, a.w, { face: a.p.face }), bw = a.p.width || 0, F = faceOf(a.p.face);
    c.save(); c.translate(a.pts[0][0], a.pts[0][1]); if (a.rot) c.rotate(a.rot * Math.PI / 180); c.scale(1, -1);
    if (a.p.fill) { c.fillStyle = a.p.fill; c.fillRect(0, 0, a.w, L.h); }
    if (bw > 0) { c.strokeStyle = a.p.color; c.lineWidth = bw; c.strokeRect(bw / 2, bw / 2, a.w - bw, L.h - bw); }
    c.fillStyle = a.p.color; c.textBaseline = 'alphabetic';
    L.lines.forEach((ln, i) => { for (const r of ln.runs) { if (r.t.trim() === '') continue; c.font = `${a.p.fontSize}px ${r.f === 'l' ? F.css.l : F.css.j}`; c.fillText(r.t, r.x, L.pad + i * L.lh + L.b); } });
    c.restore();
  } else {
    c.lineJoin = a.type === 'ink' || a.type === 'cloud' ? 'round' : 'miter';
    const base = c.globalAlpha;
    for (const pr of shapePrims(a)) {
      const st = primStyle(a, pr);
      const path = new Path2D();
      if (pr.k === 'circle') path.arc(pr.c[0], pr.c[1], pr.r, 0, Math.PI * 2);
      else if (pr.k === 'bez') { path.moveTo(pr.start[0], pr.start[1]); for (const s of pr.segs) path.bezierCurveTo(s[0][0], s[0][1], s[1][0], s[1][1], s[2][0], s[2][1]); if (pr.closed !== false) path.closePath(); }
      else { pr.pts.forEach((q, i) => (i ? path.lineTo(q[0], q[1]) : path.moveTo(q[0], q[1]))); if (pr.closed) path.closePath(); }
      c.globalAlpha = base * (st.op ?? 1); c.strokeStyle = st.color; c.lineWidth = st.width;
      c.setLineDash(st.dash || []);
      if (pr.fill && st.fill) { c.fillStyle = st.fill; c.fill(path); }
      c.stroke(path);
    }
    c.globalAlpha = base;
  }
  return { canvas: cv, rect: [x0, y0, x1, y1] };
}
// pdf-lib で読めないPDF（暗号化など）の保存: PDF.js の注釈保存機能で、暗号化を保ったまま追記する
async function buildViaPdfJs() {
  const perms = await S.pdf.getPermissions();
  if (perms && !perms.includes(0x20)) { const e = new Error('このPDFは編集ロックがかかっていて、注釈・スタンプの追加が禁止されているため、保存できません（元のファイルは変更していません）。左の「文書プロパティ」で編集ロックを解除すると保存できます。'); e.perm = true; throw e; }
  const st = S.pdf.annotationStorage, keys = [];
  try {
    let n = 0;
    for (const a of S.annots) {
      let bmp, rect;
      if (a.type === 'stamp') {
        const im = S.images.get(a.img); if (!im) continue;
        const src = await createImageBitmap(new Blob([im.bytes], { type: 'image/png' }));
        const rot = stampRot(a, normRot((await S.pdf.getPage(a.page)).rotate));
        const sw = src.width, sh = src.height, cv = document.createElement('canvas');
        cv.width = rot % 180 ? sh : sw; cv.height = rot % 180 ? sw : sh;
        const c = cv.getContext('2d'); c.translate(cv.width / 2, cv.height / 2); c.rotate(-rot * Math.PI / 180); c.drawImage(src, -sw / 2, -sh / 2);
        let out = cv;
        if (a.rot) {                       // 注釈そのものの回転
          const t = a.rot * Math.PI / 180, W = cv.width, H = cv.height;
          const W2 = Math.ceil(Math.abs(W * Math.cos(t)) + Math.abs(H * Math.sin(t))), H2 = Math.ceil(Math.abs(W * Math.sin(t)) + Math.abs(H * Math.cos(t)));
          out = document.createElement('canvas'); out.width = W2; out.height = H2;
          const c2 = out.getContext('2d'); c2.translate(W2 / 2, H2 / 2); c2.rotate(-t); c2.drawImage(cv, -W / 2, -H / 2);
        }
        bmp = await createImageBitmap(out); rect = annotBBox(a);
        if (src.close) src.close();
      } else { const r = rasterAnnot(a); bmp = await createImageBitmap(r.canvas); rect = r.rect; }
      const key = `pdfjs_internal_editor_epa${Date.now().toString(36)}${n++}`; keys.push(key);
      st.setValue(key, { annotationType: 13, bitmapId: key + '_img', bitmap: bmp, pageIndex: a.page - 1, rect, rotation: 0, isSvg: false, structTreeParentId: null });
    }
    if (!keys.length) return (await baseAll()).slice();
    return new Uint8Array(await S.pdf.saveDocument());
  } finally { for (const k of keys) { try { st.remove(k); } catch { /* ignore */ } } }
}
async function buildPdfBytes() {
  if (!S.annots.length) return (await baseAll()).slice();
  try { return await buildViaPdfLib(); }
  catch (e) {
    console.warn('pdf-lib での保存に失敗。PDF.js の追記保存を試します', e);
    try { return await buildViaPdfJs(); }
    catch (e2) { console.warn('PDF.js での保存も失敗', e2); throw e2.perm ? e2 : e; }
  }
}
// バイト列に文字列（ASCII）のどれかが含まれるか。先頭の1バイトは組み込みの lastIndexOf で探すので、大きなPDFでも速い
// （v4.11.1: 複数の文字列を1回の走査で探す。後ろから探す: このアドオンで保存したPDFは、注釈がファイルの後ろの方にあるので早く見つかる）
function bytesContain(bytes, ...strs) {
  const pats = strs.map((t) => new TextEncoder().encode(t)), c0 = pats[0][0];
  if (pats.some((q) => q[0] !== c0)) return pats.some((q, k) => bytesContain(bytes, strs[k]));
  for (let i = bytes.lastIndexOf(c0); i >= 0; i = i > 0 ? bytes.lastIndexOf(c0, i - 1) : -1) {
    for (const q of pats) {
      if (i + q.length > bytes.length) continue;
      let j = 1; while (j < q.length && bytes[i + j] === q[j]) j++;
      if (j === q.length) return true;
    }
  }
  return false;
}
async function registerImage(bytes) {
  const blob = new Blob([bytes], { type: 'image/png' });
  const bmp = await createImageBitmap(blob);
  const id = 'img-' + newId();
  S.images.set(id, { bytes, w: bmp.width, h: bmp.height, url: URL.createObjectURL(blob) });
  if (bmp.close) bmp.close();
  return id;
}
/** このツールで以前保存した図形・テキスト・スタンプを取り出して編集可能にする */
async function extractOurs(bytes) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const ctx = doc.context, out = [], stamps = [];
  const N = (k) => PDFName.of(k);
  const L = (o) => (o === undefined ? undefined : ctx.lookup(o));
  const nums = (o) => { const a = L(o); return a ? a.asArray().map((x) => L(x).asNumber()) : null; };
  const txt = (o) => { const s = L(o); return s && s.decodeText ? s.decodeText() : ''; };
  const TYPES = ['line', 'rect', 'ellipse', 'polyline', 'polygon', 'cloud', 'text', 'stamp', 'ink'];
  doc.getPages().forEach((page, pi) => {
    const arr = page.node.Annots();
    if (!arr) return;
    const keep = []; let changed = false;
    for (let i = 0; i < arr.size(); i++) {
      const ref = arr.get(i), d = ctx.lookupMaybe(ref, PDFDict);
      if (!d) { keep.push(ref); continue; }
      const epa = L(d.get(N('EPAType')));
      let type = epa ? epa.asString().slice(1) : null;
      const author = txt(d.get(N('T')));
      if (!type && author === MARKER) {
        const sub = L(d.get(N('Subtype'))).asString().slice(1);
        type = sub === 'Square' ? 'rect' : sub === 'Line' ? 'line' : sub === 'PolyLine' ? 'polyline' : null;
      }
      if (!type || !TYPES.includes(type)) { keep.push(ref); continue; }
      const R = nums(d.get(N('Rect')));
      const bs = L(d.get(N('BS'))); const bwObj = bs && L(bs.get(N('W')));
      const width = bwObj ? bwObj.asNumber() : (type === 'text' ? 0 : 1);
      const ca = L(d.get(N('CA'))), nm = L(d.get(N('NM')));
      const opacity = ca ? Math.round(ca.asNumber() * 100) : 100;
      const common = { id: nm && nm.decodeText ? nm.decodeText() : newId(), type, page: pi + 1,
        author: author === MARKER ? '' : author, date: parsePdfDate(txt(d.get(N('M')))) };
      let a;
      if (type === 'ink') {
        let strokes = [];
        try { strokes = JSON.parse(txt(d.get(N('EPAInk')))); } catch { strokes = []; }
        if (!Array.isArray(strokes) || !strokes.length) { keep.push(ref); continue; }
        a = { ...common, pts: [], strokes, p: { ...DEFAULTS, color: strokes[0].color || DEFAULTS.color, width: strokes[0].width || 1, opacity } };
      } else if (type === 'text') {
        const da = parseDA(txt(d.get(N('DA')))), fill = nums(d.get(N('IC'))) || nums(d.get(N('EPAFill')));
        const col = nums(d.get(N('EPAColor')));
        a = { ...common, pts: [[R[0], R[3]]], w: R[2] - R[0], text: txt(d.get(N('Contents'))),
          p: { ...TEXT_DEFAULTS, fontSize: da.fs, color: rgb2hex(col && !L(d.get(N('DA'))) ? col : da.rgb),
            fill: fill ? rgb2hex(fill) : null, width, opacity } };
      } else if (type === 'stamp') {
        const st = L(d.get(N('EPAImage')));
        if (!st || !st.getContents) { keep.push(ref); continue; }
        a = { ...common, pts: [[R[0], R[1]], [R[2], R[3]]], img: null, prot: normRot(page.getRotation().angle), p: { ...TEXT_DEFAULTS, opacity } };
        stamps.push({ a, bytes: st.getContents().slice() });
      } else {
        let pts;
        if (type === 'rect' || type === 'ellipse') {
          const rd = nums(d.get(N('RD'))) || [0, 0, 0, 0];
          pts = [[R[0] + rd[0], R[1] + rd[1]], [R[2] - rd[2], R[3] - rd[3]]];
        } else if (type === 'line') { const l = nums(d.get(N('L'))); pts = [[l[0], l[1]], [l[2], l[3]]]; }
        else { const v = nums(d.get(N('Vertices'))); pts = []; for (let k = 0; k + 1 < v.length; k += 2) pts.push([v[k], v[k + 1]]); }
        const le = L(d.get(N('LE')));
        const leN = le ? le.asArray().map((x) => L(x).asString().slice(1)) : ['None', 'None'];
        const c = nums(d.get(N('C'))), ic = nums(d.get(N('IC'))), st = L(d.get(N('EPAStyle')));
        a = { ...common, pts, p: { start: leN[0] || 'None', end: leN[1] || 'None', style: st ? st.asString().slice(1) : 'solid', width,
          color: c ? rgb2hex(c) : DEFAULTS.color, fill: ic ? rgb2hex(ic) : null, opacity, intensity: 1 } };
        if (type === 'cloud') { const be = L(d.get(N('BE'))), iv = be instanceof PDFDict ? L(be.get(N('I'))) : null; a.p.intensity = iv && iv.asNumber ? iv.asNumber() : 1; }
      }
      const geo = d.get(N('EPAGeom'));
      if (geo && type !== 'ink') {
        try {
          const gm = JSON.parse(txt(geo));
          if (Array.isArray(gm.pts) && gm.pts.length) a.pts = gm.pts;
          if (typeof gm.w === 'number') a.w = gm.w;
          if (gm.rot) a.rot = gm.rot;
          if (type === 'stamp' && typeof gm.prot === 'number') a.prot = normRot(gm.prot);
          if (gm.radius) a.p.radius = gm.radius;
          if (gm.face && FACES[gm.face]) a.p.face = gm.face;
          if (gm.autoW) a.autoW = true;
          if (Array.isArray(gm.ends) && a.p.start !== undefined) { a.p.start = gm.ends[0] || 'None'; a.p.end = gm.ends[1] || 'None'; }
          if (Array.isArray(gm.endSizes)) { a.p.startSize = +gm.endSizes[0] || 100; a.p.endSize = +gm.endSizes[1] || 100; }
        } catch { /* ignore */ }
      }
      out.push(a); changed = true;
    }
    if (changed) page.node.set(N('Annots'), ctx.obj(keep));
  });
  if (!out.length) return { bytes, annots: [] };
  for (const s of stamps) s.a.img = await registerImage(s.bytes);
  return { bytes: await doc.save({ useObjectStreams: false }), annots: out.filter((a) => a.type !== 'stamp' || a.img) };
}
/* ------------------------------------------------- 既存注釈(コメント)の取得・編集 */
function toPts(arr) {
  if (!arr || !arr.length) return [];
  if (typeof arr[0] === 'number') { const o = []; for (let i = 0; i + 1 < arr.length; i += 2) o.push([arr[i], arr[i + 1]]); return o; }
  return arr.map((v) => (Array.isArray(v) ? [v[0], v[1]] : [v.x, v.y]));
}
// PDFにもともとある注釈（コメント）を全ページから集める
async function collectNatives() {
  const gen = S.loadGen, pdf = S.pdf, out = [];
  try {
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const anns = await withLock(() => page.getAnnotations());
      for (const d of anns) {
        if (!NATIVE_TYPES.has(d.subtype) || !d.rect) continue;
        const r = d.rect;
        out.push({ key: 'n:' + d.id, id: d.id, page: i, subtype: d.subtype,
          rect: [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])],
          contents: (d.contentsObj && d.contentsObj.str) || d.contents || '',
          author: (d.titleObj && d.titleObj.str) || '',
          date: parsePdfDate(d.modificationDate || d.creationDate || ''),
          replyTo: d.inReplyTo ? 'n:' + d.inReplyTo : null, hasAP: !!d.hasAppearance,
          line: d.lineCoordinates || null,
          verts: d.vertices ? toPts(d.vertices) : null,
          ink: d.inkLists ? d.inkLists.map(toPts) : null });
      }
      if (gen !== S.loadGen || pdf !== S.pdf) return;
    }
  } catch (e) { console.warn('collectNatives', e); }
  if (gen !== S.loadGen || pdf !== S.pdf) return;
  S.natives = out; S.nmap = new Map(out.map((n) => [n.key, n]));
  pruneSel();
  redrawAll(); syncProps(); scheduleList(); updateButtons();
}
const refKey = (r) => `${r.objectNumber} ${r.generationNumber}`;
function refFromId(id) { const m = /^(\d+)R(\d*)$/.exec(id); if (!m) throw new Error('注釈IDを解釈できません: ' + id); return PDFRef.of(+m[1], m[2] ? +m[2] : 0); }
// 既存のテキスト注釈（FreeText）の外観を、変更後の文字で作り直す（v4.9）
//  ・元の外観（背景・枠線）が読めるときは、そのまま残して「文字だけ」を入れ替える。外観の /Matrix（平行移動・拡大縮小・回転）も正しく扱う
//  ・文字の色は、「実際に見えている色」を優先する。Acrobat・Edgeで作ったテキストボックスは、/DA・/DS に古い色（白など）が残り、
//    本当の色は外観ストリームや /RC（リッチテキスト）にだけ入っていることがある。順番: ①外観ストリームの文字の色 → ②/RC の色 → ③/DA の色
//  ・背景と同じ色の文字になって見えなくなる場合（白い箱に白い文字など）は、文字の色を黒に直す
//  ・元の外観が読めないときは、設定値から作る。/C は枠線の色（背景ではない）
const ftxLum = (c) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
const ftxSame = (a, b) => !!a && !!b && Math.abs(ftxLum(a) - ftxLum(b)) < 0.25 && Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 0.6;
const ftxMul = (a, b) => [a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3], a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3], a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5]];
// 外観ストリームの内容（文字列）。読めないときは null
function ftxApText(ctx, apObj) {
  try {
    const st = ctx.lookup(apObj); if (!st || !st.dict) return null;
    const bytes = st instanceof window.PDFLib.PDFRawStream ? window.PDFLib.decodePDFRawStream(st).decode() : st.getContents();
    if (!bytes || bytes.length > 2e6) return null;
    let s = ''; for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
    return s;
  } catch (e) { return null; }
}
const ftxBT = /(^|[\s>\]\)])BT(?=[\s<(\[\/])[\s\S]*?[\s>\]\)]ET(?=[\s]|$)/g;
// 外観ストリームから、文字（BT〜ET）の部分を取り除く。インライン画像を含むものは null
function ftxStripText(s) {
  if (s === null || /(^|[\s>\]])BI(\s|$)/.test(s)) return null;
  return s.replace(ftxBT, '$1');
}
// 外観ストリームの文字の色: 最初の文字を描く直前の「塗りの色」を、グラフィックス状態（q / Q）まで追って求める。なければ null
function ftxApColor(s) {
  if (s === null) return null;
  const bt = /(^|[\s>\]\)])BT(?=[\s<(\[\/])/.exec(s);
  if (!bt) return null;
  const from = bt.index + bt[0].length - 2, tail = s.slice(from);
  const sh = tail.search(/(<[0-9A-Fa-f\s]*>|\((?:\\.|[^\\)])*\)|\])\s*(Tj|TJ|'|")/);
  if (sh < 0) return null;
  const pre = s.slice(0, from + sh);
  let col = [0, 0, 0], c; const stack = [];
  const re = /(?:^|\s)(?:((?:-?[\d.]+\s+){1,4})(rg|g|k|sc|scn)|(q|Q))(?=\s|$)/g;
  while ((c = re.exec(pre))) {
    if (c[3] === 'q') { stack.push(col); continue; }
    if (c[3] === 'Q') { if (stack.length) col = stack.pop(); continue; }
    const v = c[1].trim().split(/\s+/).map(Number), n = v.length;
    if (c[2] === 'rg' || ((c[2] === 'sc' || c[2] === 'scn') && n === 3)) { if (n >= 3) col = v.slice(-3); }
    else if (c[2] === 'g' || ((c[2] === 'sc' || c[2] === 'scn') && n === 1)) { if (n >= 1) col = [v[n - 1], v[n - 1], v[n - 1]]; }
    else if (c[2] === 'k' || ((c[2] === 'sc' || c[2] === 'scn') && n === 4)) { if (n >= 4) { const w = v.slice(-4), k = 1 - w[3]; col = [(1 - w[0]) * k, (1 - w[1]) * k, (1 - w[2]) * k]; } }
  }
  return col.every((x) => Number.isFinite(x)) ? col.map((x) => Math.min(1, Math.max(0, x))) : null;
}
// リッチテキスト（/RC）の最初の文字の色（style="color:#RRGGBB"。span → 全体の順）
function ftxRcColor(rc) {
  if (!rc) return null;
  const all = [...String(rc).matchAll(/color\s*:\s*#([0-9a-fA-F]{6})/g)].map((m) => m[1]);
  if (!all.length) return null;
  const sp = /<span[^>]*color\s*:\s*#([0-9a-fA-F]{6})/.exec(rc), hex = sp ? sp[1] : all[0];
  return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
}
// 外観ストリーム（文字を除いたもの）で、最初に塗りつぶされる色（背景）。塗りがなければ null
function ftxFillOf(s) {
  let col = [0, 0, 0], c;
  const re = /(?:^|\s)(?:((?:-?[\d.]+\s+){1,4})(rg|g|k)|(f\*?|F|B\*?|b\*?))(?=\s|$)/g;
  while ((c = re.exec(s))) {
    if (c[3]) return col;
    const v = c[1].trim().split(/\s+/).map(Number);
    if (c[2] === 'rg' && v.length >= 3) col = v.slice(-3);
    else if (c[2] === 'g' && v.length >= 1) col = [v[v.length - 1], v[v.length - 1], v[v.length - 1]];
    else if (c[2] === 'k' && v.length >= 4) { const k = 1 - v[v.length - 1], w = v.slice(-4); col = [(1 - w[0]) * k, (1 - w[1]) * k, (1 - w[2]) * k]; }
  }
  return null;
}
function regenFreeText(doc, d, force = {}) {
  const ctx = doc.context, N = (k) => PDFName.of(k);
  const L = (o) => (o === undefined ? undefined : ctx.lookup(o));
  const nums = (o) => { const a = L(o); return a instanceof PDFArray ? a.asArray().map((x) => L(x).asNumber()) : null; };
  const str = (o) => { const s = L(o); return s && s.decodeText ? s.decodeText() : (s && s.asString ? s.asString() : ''); };
  const R0 = nums(d.get(N('Rect'))); if (!R0) return;
  const R = [Math.min(R0[0], R0[2]), Math.min(R0[1], R0[3]), Math.max(R0[0], R0[2]), Math.max(R0[1], R0[3])];
  const text = str(d.get(N('Contents')));
  const da = parseDA(str(d.get(N('DA'))));
  const qn = L(d.get(N('Q'))), q = qn && qn.asNumber ? qn.asNumber() : 0;
  const rn = L(d.get(N('Rotate'))), rot = rn && rn.asNumber ? normRot(rn.asNumber()) : 0;
  const ca = L(d.get(N('CA'))), opacity = ca && ca.asNumber ? ca.asNumber() : 1;
  const w = R[2] - R[0], h = R[3] - R[1];
  const col3 = (a) => (a && a.length >= 3 ? a.slice(0, 3) : a && a.length === 1 ? [a[0], a[0], a[0]] : null);
  const C = col3(nums(d.get(N('C')))), IC = col3(nums(d.get(N('IC'))));
  const apD = L(d.get(N('AP'))), apN = apD instanceof PDFDict ? apD.get(N('N')) : null, apS = apN ? L(apN) : null;
  const apTxt = apS && apS.dict ? ftxApText(ctx, apN) : null;
  // ---- 文字の色: 実際に見えている色を優先（外観ストリーム → /RC → /DA）
  let rgb = force.rgb || ftxApColor(apTxt) || ftxRcColor(str(d.get(N('RC')))) || da.rgb;
  let dict = null, hasJp = false;
  // ---- ① 元の外観を残して、文字だけ入れ替える
  const bb = apS && apS.dict ? nums(apS.dict.get(N('BBox'))) : null;
  const mt = apS && apS.dict ? nums(apS.dict.get(N('Matrix'))) : null;
  const res = apS && apS.dict ? L(apS.dict.get(N('Resources'))) : null;
  if (!force.rebuild && bb && bb.length === 4 && !rot && res instanceof PDFDict && w > 0 && h > 0) {
    const kept = ftxStripText(apTxt);
    if (kept !== null) {
      // 外観を注釈の枠（Rect）に合わせる変換（PDFの規格どおり）: 外観の座標 →（Matrix）→ BBoxをRectに合わせる
      const M = mt && mt.length === 6 ? mt : [1, 0, 0, 1, 0, 0];
      const xs = [], ys = [];
      for (const [x, y] of [[bb[0], bb[1]], [bb[2], bb[1]], [bb[0], bb[3]], [bb[2], bb[3]]]) { xs.push(M[0] * x + M[2] * y + M[4]); ys.push(M[1] * x + M[3] * y + M[5]); }
      const tx0 = Math.min(...xs), ty0 = Math.min(...ys), tw = Math.max(...xs) - tx0, th = Math.max(...ys) - ty0;
      if (tw > 1e-6 && th > 1e-6) {
        const sx = w / tw, sy = h / th, T = ftxMul(M, [sx, 0, 0, sy, -tx0 * sx, -ty0 * sy]);
        // 背景（塗り）が文字と同じ色で見えなくなるときは、文字を黒にする
        const bg = ftxFillOf(kept);
        if (bg && ftxSame(bg, rgb) && !force.rgb) rgb = [0, 0, 0];
        const refs = fontRefs(doc), Lo = layoutText(text, da.fs, w, { q, pad: 2 });
        hasJp = Lo.hasJp;
        const ops = [`q`, `${T.map(n3).join(' ')} cm`, kept, `Q`, `q`, `0 0 ${n3(w)} ${n3(h)} re W n`, `/EPAGS gs`, `${rgb.map(n3).join(' ')} rg`];
        Lo.lines.forEach((ln, i) => {
          const y = h - Lo.pad - i * Lo.lh - Lo.b;
          for (const r of ln.runs) { if (r.t.trim() === '') continue; ops.push(`BT /${r.f === 'l' ? 'Helv' : 'EPAJp'} ${n3(da.fs)} Tf ${n3(r.x)} ${n3(y)} Td <${r.f === 'l' ? hexLat(r.t) : hexU16(r.t)}> Tj ET`); }
        });
        ops.push('Q');
        const nres = ctx.obj({});                                           // 元の Resources を写し、文字用のフォントと透明度だけ足す（元の辞書は変更しない）
        for (const [k, v] of res.entries()) nres.set(k, v);
        const fo = L(res.get(N('Font'))), nf = ctx.obj({});
        if (fo instanceof PDFDict) for (const [k, v] of fo.entries()) nf.set(k, v);
        nf.set(N('Helv'), refs.helv); nf.set(N('EPAJp'), refs.jp); nres.set(N('Font'), nf);
        const eo = L(res.get(N('ExtGState'))), ne = ctx.obj({});
        if (eo instanceof PDFDict) for (const [k, v] of eo.entries()) ne.set(k, v);
        ne.set(N('EPAGS'), ctx.obj({ Type: 'ExtGState', CA: opacity, ca: opacity })); nres.set(N('ExtGState'), ne);
        const nref = ctx.register(ctx.stream(ops.join('\n'), { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, w, h] }));
        ctx.lookup(nref).dict.set(N('Resources'), nres);
        dict = nref;
      }
    }
  }
  // ---- ② 読めないときは、設定値から作る
  if (!dict) {
    const bs = L(d.get(N('BS'))), bwo = bs instanceof PDFDict ? L(bs.get(N('W'))) : null, bo = nums(d.get(N('Border')));
    const bw = bwo && bwo.asNumber ? bwo.asNumber() : (bo && bo.length >= 3 ? bo[2] : 1);       // 枠線の太さ: /BS → /Border → 既定の1
    let fill = IC, bcolor = null;
    if (bw > 0) bcolor = C || rgb;                                                          // 枠線の色は /C（背景ではない）
    else if (!IC && C && !force.rebuild) fill = C;                                          // 枠線がなく /IC もない: /C を背景色として使う作成ソフトがある
    if (fill && ftxSame(fill, rgb) && !force.rgb) rgb = [0, 0, 0];                                        // 背景と同じ色の文字は見えないので黒にする
    if (bcolor && fill && ftxSame(bcolor, fill)) bcolor = null;
    const ap = buildTextAP(doc, { w: rot % 180 ? h : w, h: rot % 180 ? w : h, rot, text, fs: da.fs, rgb, fill, bw: bcolor ? bw : 0, bcolor: bcolor || rgb, opacity, q, pad: 2 });
    hasJp = ap.hasJp; dict = ap.ref;
  }
  ensureDR(doc);
  d.set(N('AP'), ctx.obj({ N: dict }));
  d.set(N('DA'), PDFString.of(daString(hasJp ? 'EPAJp' : 'Helv', da.fs, rgb)));              // /DA も、実際の文字の色に直す（次に編集したときに、また白になるのを防ぐ）
  d.delete(N('RC')); d.delete(N('DS'));
}
// ---- 既存の注釈（Acrobat などで作ったもの）を、このアドオンの図形と同じ形のデータとして読む（v4.11）
//  プロパティ欄での変更・外観の作り直し・手書き注釈へのまとめ、に使う
const NATIVE_SHAPES = new Set(['Line', 'PolyLine', 'Polygon', 'Square', 'Circle', 'Ink']);      // 図形として読める種類
const NATIVE_MARKUP = new Set(['Highlight', 'Underline', 'StrikeOut', 'Squiggly']);
function pdfReader(doc) {
  const ctx = doc.context, N = (k) => PDFName.of(k), L = (o) => (o === undefined ? undefined : ctx.lookup(o));
  const num = (o) => { const v = L(o); return v && v.asNumber ? v.asNumber() : null; };
  const nums = (o) => { const a = L(o); return a instanceof PDFArray ? a.asArray().map((x) => num(x) ?? 0) : null; };
  const name = (o) => { const v = L(o); return v && v.asString ? v.asString().replace(/^\//, '') : ''; };
  const col = (a) => (!a || !a.length ? null : a.length >= 4 ? (() => { const k = 1 - a[3]; return [(1 - a[0]) * k, (1 - a[1]) * k, (1 - a[2]) * k]; })()
    : a.length >= 3 ? a.slice(0, 3) : [a[0], a[0], a[0]]);
  return { ctx, N, L, num, nums, name, col };
}
// 注釈の辞書 → { type, pts | strokes, p, sub }。図形として読めないときは null（pts を渡すと頂点をそれに置き換える）
function nativeShape(doc, d, pts) {
  const { N, L, num, nums, name, col } = pdfReader(doc);
  const sub = name(d.get(N('Subtype'))); if (!NATIVE_SHAPES.has(sub)) return null;
  const be = L(d.get(N('BE'))), cloud = be instanceof PDFDict && name(be.get(N('S'))) === 'C';
  let w = 1, style = 'solid';
  const bs = L(d.get(N('BS')));
  if (bs instanceof PDFDict) { const wv = num(bs.get(N('W'))); if (wv !== null) w = wv; if (name(bs.get(N('S'))) === 'D') style = 'dashed'; }
  else { const bo = nums(d.get(N('Border'))); if (bo && bo.length >= 3) w = bo[2]; }
  const ends = new Set(LINE_ENDS.map((x) => x[0]));
  const le = L(d.get(N('LE'))), leN = le instanceof PDFArray ? le.asArray().map((x) => name(x)) : [];
  const op = num(d.get(N('CA'))) ?? 1;
  const C = col(nums(d.get(N('C')))), IC = col(nums(d.get(N('IC'))));
  const p = { color: rgb2hex(C || [0, 0, 0]), width: Math.max(w, sub === 'Ink' ? 0.25 : 0.01), style, fill: IC && sub !== 'Line' && sub !== 'PolyLine' && sub !== 'Ink' ? rgb2hex(IC) : null,
    opacity: Math.round(op * 100), start: ends.has(leN[0]) ? leN[0] : 'None', end: ends.has(leN[1]) ? leN[1] : 'None', startSize: 100, endSize: 100,
    intensity: (be instanceof PDFDict ? num(be.get(N('I'))) : null) || 1, radius: 0 };
  const pairs = (a) => { const o = []; for (let i = 0; a && i + 1 < a.length; i += 2) o.push([a[i], a[i + 1]]); return o; };
  if (sub === 'Ink') {
    const il = L(d.get(N('InkList'))); if (!(il instanceof PDFArray)) return null;
    const strokes = il.asArray().map((x) => pairs(nums(x))).filter((q) => q.length).map((q) => ({ pts: q, color: p.color, width: p.width, op: 1 }));
    return strokes.length ? { sub, type: 'ink', pts: [], strokes, p } : null;
  }
  if (sub === 'Square' || sub === 'Circle') {
    const R0 = nums(d.get(N('Rect'))); if (!R0) return null;
    const R = [Math.min(R0[0], R0[2]), Math.min(R0[1], R0[3]), Math.max(R0[0], R0[2]), Math.max(R0[1], R0[3])];
    const rd = nums(d.get(N('RD'))), ins = rd && rd.length === 4 ? rd : [w / 2, w / 2, w / 2, w / 2];
    const x0 = R[0] + ins[0], y0 = R[1] + ins[1], x1 = Math.max(x0 + 0.1, R[2] - ins[2]), y1 = Math.max(y0 + 0.1, R[3] - ins[3]);
    if (sub === 'Square' && cloud) return { sub, type: 'cloud', pts: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], p, box: true };
    return { sub, type: sub === 'Square' ? 'rect' : 'ellipse', pts: [[x0, y0], [x1, y1]], p };
  }
  if (!pts) {
    if (sub === 'Line') { const l = nums(d.get(N('L'))); if (!l || l.length < 4) return null; pts = [[l[0], l[1]], [l[2], l[3]]]; }
    else {
      pts = pairs(nums(d.get(N('Vertices'))));
      if (sub === 'Polygon' && pts.length > 3) { const a = pts[0], b = pts[pts.length - 1]; if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.01) pts.pop(); }
    }
  }
  if (pts.length < (sub === 'Polygon' ? 3 : 2)) return null;
  return { sub, type: sub === 'Line' ? 'line' : sub === 'PolyLine' ? 'polyline' : cloud ? 'cloud' : 'polygon', pts, p };
}
// 既存の図形の注釈の外観（見た目）を、注釈の設定（色・太さ・破線・塗り・不透明度・線端・雲の大きさ）と形から作り直す
// 作成者・コメント・返信などはそのまま残し、/Rect と外観だけを変える
function regenNativeAP(doc, d, pts) {
  const a = nativeShape(doc, d, pts); if (!a) return;
  const { ctx, N } = pdfReader(doc), op = a.p.opacity / 100;
  const [x0, y0, x1, y1] = primsBBox(shapePrims(a)), pad = Math.max(a.p.width * 1.5, 1) + 1;
  const R = [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
  const ap = ctx.register(ctx.stream(buildAP(a), { Type: 'XObject', Subtype: 'Form', BBox: R, Resources: { ExtGState: { GS0: { Type: 'ExtGState', CA: op, ca: op } } } }));
  d.set(N('Rect'), ctx.obj(R)); d.set(N('AP'), ctx.obj({ N: ap }));
  if (a.sub === 'Square' || a.sub === 'Circle') {           // 枠（Rect）と図形の間の幅を /RD に書く（次に読んだときに、同じ大きさの図形になるように）
    const xs = a.pts.map((q) => q[0]), ys = a.pts.map((q) => q[1]);
    d.set(N('RD'), ctx.obj([Math.min(...xs) - R[0], Math.min(...ys) - R[1], R[2] - Math.max(...xs), R[3] - Math.max(...ys)].map((v) => Math.max(0, v))));
  } else d.delete(N('RD'));
}
const regenShapeAP = regenNativeAP;
// ハイライト・下線・取り消し線・波線の外観を、/QuadPoints・色・不透明度から作り直す
function regenMarkupAP(doc, d) {
  const { ctx, N, num, nums, name, col } = pdfReader(doc);
  const sub = name(d.get(N('Subtype'))), qp = nums(d.get(N('QuadPoints'))); if (!qp || qp.length < 8) return;
  const rgb = col(nums(d.get(N('C')))) || [1, 1, 0], op = num(d.get(N('CA'))) ?? 1, ops = ['/GS0 gs'];
  let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
  for (let i = 0; i + 7 < qp.length; i += 8) {
    const q = [[qp[i], qp[i + 1]], [qp[i + 2], qp[i + 3]], [qp[i + 4], qp[i + 5]], [qp[i + 6], qp[i + 7]]];   // 左上・右上・左下・右下
    for (const [x, y] of q) { bx0 = Math.min(bx0, x); by0 = Math.min(by0, y); bx1 = Math.max(bx1, x); by1 = Math.max(by1, y); }
    const h = Math.hypot(q[0][0] - q[2][0], q[0][1] - q[2][1]) || 1;
    const at = (t) => [[q[2][0] + (q[0][0] - q[2][0]) * t, q[2][1] + (q[0][1] - q[2][1]) * t], [q[3][0] + (q[1][0] - q[3][0]) * t, q[3][1] + (q[1][1] - q[3][1]) * t]];
    if (sub === 'Highlight') { ops.push(`${rgb.map(n3).join(' ')} rg`, `${n3(q[0][0])} ${n3(q[0][1])} m ${n3(q[1][0])} ${n3(q[1][1])} l ${n3(q[3][0])} ${n3(q[3][1])} l ${n3(q[2][0])} ${n3(q[2][1])} l h f`); continue; }
    const lw = Math.max(0.5, h / 14);
    ops.push(`${rgb.map(n3).join(' ')} RG`, `${n3(lw)} w`);
    if (sub === 'Squiggly') {
      const [A, B] = at(0.08), len = Math.hypot(B[0] - A[0], B[1] - A[1]) || 1, ux = (B[0] - A[0]) / len, uy = (B[1] - A[1]) / len, st = Math.max(1.5, h / 6), amp = h / 14;
      const pts = []; for (let t = 0, k = 0; t <= len; t += st, k++) { const o = k % 2 ? amp : -amp; pts.push([A[0] + ux * t - uy * o, A[1] + uy * t + ux * o]); }
      pts.forEach((p, k) => ops.push(`${n3(p[0])} ${n3(p[1])} ${k ? 'l' : 'm'}`)); ops.push('S');
    } else { const [A, B] = at(sub === 'StrikeOut' ? 0.45 : 0.07); ops.push(`${n3(A[0])} ${n3(A[1])} m ${n3(B[0])} ${n3(B[1])} l S`); }
  }
  const R = [bx0 - 1, by0 - 1, bx1 + 1, by1 + 1];
  const gs = { Type: 'ExtGState', CA: op, ca: op, ...(sub === 'Highlight' ? { BM: 'Multiply' } : {}) };
  const ap = ctx.register(ctx.stream(ops.join('\n'), { Type: 'XObject', Subtype: 'Form', BBox: R, Resources: { ExtGState: { GS0: gs } } }));
  d.set(N('Rect'), ctx.obj(R)); d.set(N('AP'), ctx.obj({ N: ap }));
}
// 既存の注釈の、プロパティ欄に出す値（読めないものは含めない）
function nativeProps(doc, d) {
  const { N, L, num, nums, name, col } = pdfReader(doc);
  const sub = name(d.get(N('Subtype')));
  const sh = nativeShape(doc, d); if (sh) return { ...sh.p, cloud: sh.type === 'cloud' };
  const op = Math.round((num(d.get(N('CA'))) ?? 1) * 100), C = col(nums(d.get(N('C'))));
  if (NATIVE_MARKUP.has(sub)) return { color: rgb2hex(C || [1, 1, 0]), opacity: op };
  if (sub === 'FreeText') {
    const str = (o) => { const v = L(o); return v && v.decodeText ? v.decodeText() : ''; };
    const da = parseDA(str(d.get(N('DA')))), apD = L(d.get(N('AP'))), apN = apD instanceof PDFDict ? apD.get(N('N')) : null;
    const rgb = (apN ? ftxApColor(ftxApText(doc.context, apN)) : null) || ftxRcColor(str(d.get(N('RC')))) || da.rgb;
    const bs = L(d.get(N('BS'))), bo = nums(d.get(N('Border')));
    const w = bs instanceof PDFDict && num(bs.get(N('W'))) !== null ? num(bs.get(N('W'))) : bo && bo.length >= 3 ? bo[2] : 1;
    const IC = col(nums(d.get(N('IC'))));
    return { color: rgb2hex(rgb), fontSize: Math.round(da.fs * 10) / 10, width: w, fill: IC ? rgb2hex(IC) : null, opacity: op, face: 'gothic' };
  }
  return {};
}
// 既存の注釈ごとに、プロパティ欄で変えられる項目
function nativeCaps(n) {
  const s = n.subtype;
  if (encLocked()) return [];
  if (s === 'Line' || s === 'PolyLine') return ['start', 'end', 'style', 'width', 'color', 'opacity'];
  if (s === 'Polygon') return ['style', 'width', 'color', 'fill', 'opacity', ...(n.props && n.props.cloud ? ['intensity'] : [])];
  if (s === 'Square' || s === 'Circle') return ['style', 'width', 'color', 'fill', 'opacity', ...(n.props && n.props.cloud ? ['intensity'] : [])];
  if (s === 'Ink') return ['width', 'color', 'opacity'];
  if (s === 'FreeText') return ['width', 'color', 'fill', 'opacity', 'font'];
  if (NATIVE_MARKUP.has(s)) return ['color', 'opacity'];
  return [];
}
// 元のPDF（S.baseBytes）を pdf-lib で読んだもの。読むだけに使う（変更しない）。元のPDFが変わったら読み直す
function baseDoc() {
  if (!S.baseDoc || S.baseDoc.bytes !== S.baseBytes) S.baseDoc = { bytes: S.baseBytes, p: baseAll().then((b) => PDFDocument.load(b, { updateMetadata: false })) };
  return S.baseDoc.p;
}
// 選択中の既存の注釈の、プロパティの値を読む（まだ読んでいないものだけ）。読み終えたらプロパティ欄を更新する
function loadNativeProps(list) {
  const need = list.filter((n) => n.props === undefined); if (!need.length) return;
  for (const n of need) n.props = null;
  baseDoc().then((doc) => {
    for (const n of need) { try { const d = doc.context.lookupMaybe(refFromId(n.id), PDFDict); n.props = d ? nativeProps(doc, d) : {}; } catch (e) { n.props = {}; } }
    if (need.some((n) => S.sel.has(n.key))) { syncProps(); updateButtons(); }
  }).catch(() => { for (const n of need) n.props = {}; });
}
function applyNativeProps(doc, d, pr) {
  const { ctx, N, L, num, nums, name } = pdfReader(doc), sub = name(d.get(N('Subtype')));
  const rgbArr = (h) => ctx.obj(hex2rgb(h));
  if (pr.opacity !== undefined) d.set(N('CA'), ctx.obj(clamp(pr.opacity, 0, 100) / 100));
  if (pr.width !== undefined || pr.style !== undefined) {
    const bs = L(d.get(N('BS'))), bo = nums(d.get(N('Border')));
    const cw = bs instanceof PDFDict && num(bs.get(N('W'))) !== null ? num(bs.get(N('W'))) : bo && bo.length >= 3 ? bo[2] : 1;
    const dashed = pr.style !== undefined ? pr.style !== 'solid' : bs instanceof PDFDict && name(bs.get(N('S'))) === 'D';
    const w = pr.width !== undefined ? pr.width : cw;
    d.set(N('BS'), ctx.obj({ Type: 'Border', W: w, S: dashed ? 'D' : 'S', ...(dashed ? { D: [3, 3] } : {}) }));
    d.delete(N('Border'));
  }
  if (pr.start !== undefined || pr.end !== undefined) {
    const le = L(d.get(N('LE'))), cur = le instanceof PDFArray ? le.asArray().map((x) => name(x)) : ['None', 'None'];
    d.set(N('LE'), ctx.obj([PDFName.of(pr.start ?? cur[0] ?? 'None'), PDFName.of(pr.end ?? cur[1] ?? 'None')]));
  }
  if (pr.intensity !== undefined) { const be = L(d.get(N('BE'))); if (be instanceof PDFDict) be.set(N('I'), ctx.obj(pr.intensity)); }
  if (sub === 'FreeText') {
    const str = (o) => { const v = L(o); return v && v.decodeText ? v.decodeText() : ''; };
    const da = parseDA(str(d.get(N('DA'))));
    const rgb = pr.color !== undefined ? hex2rgb(pr.color) : null, fs = pr.fontSize ?? da.fs;
    if (pr.fill !== undefined) { if (pr.fill) d.set(N('IC'), rgbArr(pr.fill)); else d.delete(N('IC')); }
    if (pr.width !== undefined && pr.width > 0 && !d.get(N('C'))) d.set(N('C'), rgbArr(pr.color || rgb2hex(da.rgb)));
    d.set(N('DA'), PDFString.of(daString('Helv', fs, rgb || da.rgb)));
    regenFreeText(doc, d, { rgb, rebuild: pr.fill !== undefined || pr.width !== undefined || pr.style !== undefined });
    return;
  }
  if (pr.color !== undefined) d.set(N('C'), rgbArr(pr.color));
  if (pr.fill !== undefined) { if (pr.fill) d.set(N('IC'), rgbArr(pr.fill)); else d.delete(N('IC')); }
  if (NATIVE_SHAPES.has(sub)) regenNativeAP(doc, d);
  else if (NATIVE_MARKUP.has(sub)) regenMarkupAP(doc, d);
}
/* ---- しおり（PDFのアウトライン）の編集（v4.11.1）
 *  しおりは、パス（同じ階層の中での番号を、上の階層から順に並べたもの。例 [0, 2]）で指す。PDF.js の getOutline と同じ順番になる。
 *  op: { type: 'bm', act: 'add' | 'rename' | 'del', path, title, page, top } */
function outlineEdit(doc, op) {
  const ctx = doc.context, N = (k) => PDFName.of(k), cat = doc.catalog;
  let rootRef = cat.get(N('Outlines')), root = rootRef ? ctx.lookup(rootRef) : null;
  if (!(root instanceof PDFDict)) {
    if (op.act !== 'add') return;
    root = ctx.obj({ Type: 'Outlines' }); rootRef = ctx.register(root); cat.set(N('Outlines'), rootRef);
  }
  if (!(rootRef instanceof PDFRef)) { rootRef = ctx.register(root); cat.set(N('Outlines'), rootRef); }
  const kids = (d) => {                                   // 子のしおり（参照）の一覧
    const o = [], seen = new Set(); let r = d.get(N('First'));
    while (r instanceof PDFRef && !seen.has(r.tag)) { seen.add(r.tag); o.push(r); const x = ctx.lookup(r); r = x instanceof PDFDict ? x.get(N('Next')) : null; }
    return o;
  };
  const relink = (pRef, pd, list) => {                   // 子の並びを書き直す（First / Last / Prev / Next / Parent）
    list.forEach((r, i) => {
      const d = ctx.lookup(r); d.set(N('Parent'), pRef);
      if (i > 0) d.set(N('Prev'), list[i - 1]); else d.delete(N('Prev'));
      if (i < list.length - 1) d.set(N('Next'), list[i + 1]); else d.delete(N('Next'));
    });
    if (list.length) { pd.set(N('First'), list[0]); pd.set(N('Last'), list[list.length - 1]); } else { pd.delete(N('First')); pd.delete(N('Last')); pd.delete(N('Count')); }
  };
  const at = (path) => {                                  // パスの位置の、親と兄弟の一覧と番号
    let pRef = rootRef, pd = root;
    for (let k = 0; k < path.length - 1; k++) { const ks = kids(pd); const r = ks[path[k]]; if (!r) return null; pRef = r; pd = ctx.lookup(r); }
    return { pRef, pd, list: kids(pd), i: path[path.length - 1] };
  };
  const num = (o) => { const v = ctx.lookup(o); return v && v.asNumber ? v.asNumber() : 0; };
  if (op.act === 'add') {
    const pg = doc.getPages()[op.page - 1]; if (!pg) return;
    const item = ctx.obj({ Title: PDFHexString.fromText(op.title), Dest: [pg.ref, 'XYZ', null, op.top == null ? null : op.top, null] });
    const ref = ctx.register(item);
    const pos = op.path ? at(op.path) : { pRef: rootRef, pd: root, list: kids(root), i: kids(root).length - 1 };
    if (!pos) return;
    pos.list.splice(pos.i + 1, 0, ref); relink(pos.pRef, pos.pd, pos.list);
  } else {
    const pos = at(op.path); if (!pos || !pos.list[pos.i]) return;
    const ref = pos.list[pos.i], d = ctx.lookup(ref);
    if (op.act === 'rename') d.set(N('Title'), PDFHexString.fromText(op.title));
    else if (op.act === 'del') {
      pos.list.splice(pos.i, 1); relink(pos.pRef, pos.pd, pos.list);
      const kill = (r) => { const x = ctx.lookup(r); if (x instanceof PDFDict) for (const c of kids(x)) kill(c); ctx.delete(r); };
      kill(ref);
    }
  }
  // 開いている数（Count）を数え直す。しおりの開閉（正: 開いている／負: 閉じている）はそのまま
  const recount = (d, isRoot) => {
    const ks = kids(d); let vis = 0;
    for (const r of ks) { const c = ctx.lookup(r); const open = num(c.get(N('Count'))) > 0; const sub = recount(c, false); vis += 1 + (open ? sub : 0); }
    if (isRoot) { if (vis) d.set(N('Count'), ctx.obj(vis)); else d.delete(N('Count')); }
    else if (ks.length) { const open = num(d.get(N('Count'))) > 0; d.set(N('Count'), ctx.obj(open ? vis : -vis)); }
    else d.delete(N('Count'));
    return vis;
  };
  recount(root, true);
  if (!kids(root).length) cat.delete(N('Outlines'));
}
// PDFにもともとあった注釈（コメント）の変更・削除・配置順の変更を、元のPDFに直接反映する
async function nativeEdit(ops) {
  const doc = await PDFDocument.load(await baseAll(), { updateMetadata: false });
  const ctx = doc.context, pages = doc.getPages(), N = (k) => PDFName.of(k);
  const mapFlat = (arr, fn) => {
    if (!(arr instanceof PDFArray)) return arr;
    const v = arr.asArray().map((x) => ctx.lookup(x));
    if (v.some((x) => x instanceof PDFArray)) return ctx.obj(v.map((x) => mapFlat(x, fn)));
    const nums = v.map((x) => x.asNumber()), o = [];
    for (let i = 0; i + 1 < nums.length; i += 2) o.push(...fn(nums[i], nums[i + 1]));
    return ctx.obj(o);
  };
  const KEYS = ['Rect', 'QuadPoints', 'Vertices', 'L', 'CL', 'InkList'];
  const moveDict = (d, dx, dy) => {
    for (const k of KEYS) { const v = ctx.lookup(d.get(N(k))); if (v instanceof PDFArray) d.set(N(k), mapFlat(v, (x, y) => [x + dx, y + dy])); }
  };
  const subOf = (d) => { const s = ctx.lookup(d.get(N('Subtype'))); return s && s.asString ? s.asString().slice(1) : ''; };
  for (const op of ops) {
    if (op.type === 'bm') { outlineEdit(doc, op); continue; }
    const page = pages[op.page - 1]; if (!page) continue;
    if (op.type === 'order') {                       // 配置順（v3.6）: 複数のidをまとめて扱う
      const arr = page.node.Annots(); if (!arr) continue;
      const want = new Set(op.ids.map((id) => refKey(refFromId(id))));
      const vis = [], pops = [];
      for (const r of arr.asArray()) { const dd = ctx.lookupMaybe(r, PDFDict); (dd && subOf(dd) === 'Popup' ? pops : vis).push(r); }
      const re = zReorder(vis, (r) => r instanceof PDFRef && want.has(refKey(r)), op.mode);
      page.node.set(N('Annots'), ctx.obj([...re, ...pops]));
      continue;
    }
    const ref = refFromId(op.id), d = ctx.lookupMaybe(ref, PDFDict);
    if (op.type === 'move') {
      if (!d) continue;
      moveDict(d, op.dx, op.dy);
      const pop = d.get(N('Popup'));
      if (pop instanceof PDFRef) { const pd = ctx.lookupMaybe(pop, PDFDict); if (pd) moveDict(pd, op.dx, op.dy); }
    } else if (op.type === 'contents') {
      if (!d) continue;
      d.set(N('Contents'), PDFHexString.fromText(op.text));
      d.delete(N('RC')); d.set(N('M'), PDFString.of(pdfDate()));
      if (subOf(d) === 'FreeText') regenFreeText(doc, d);
    } else if (op.type === 'verts') {          // 直線・折れ線・多角形（雲形）の頂点を変更し、外観を作り直す
      if (!d) continue;
      if (subOf(d) === 'Line') d.set(N('L'), ctx.obj([...op.pts[0], ...op.pts[1]]));
      else d.set(N('Vertices'), ctx.obj((op.dup ? [...op.pts, op.pts[0]] : op.pts).flat()));
      regenShapeAP(doc, d, op.pts);
      d.set(N('M'), PDFString.of(pdfDate()));
    } else if (op.type === 'props') {           // プロパティ欄での変更（v4.11）: 色・塗り・太さ・線の種類・不透明度・線端・文字の大きさ
      if (!d) continue;
      applyNativeProps(doc, d, op.props);
      d.set(N('M'), PDFString.of(pdfDate()));
    } else if (op.type === 'resize') {
      if (!d) continue;
      const [ox0, oy0, ox1, oy1] = op.old, [nx0, ny0, nx1, ny1] = op.rect;
      const sx = (nx1 - nx0) / Math.max(ox1 - ox0, 1e-6), sy = (ny1 - ny0) / Math.max(oy1 - oy0, 1e-6);
      const fn = (x, y) => [nx0 + (x - ox0) * sx, ny0 + (y - oy0) * sy];
      for (const k of ['QuadPoints', 'Vertices', 'L', 'CL', 'InkList']) { const v = ctx.lookup(d.get(N(k))); if (v instanceof PDFArray) d.set(N(k), mapFlat(v, fn)); }
      d.set(N('Rect'), ctx.obj([nx0, ny0, nx1, ny1]));
      d.set(N('M'), PDFString.of(pdfDate()));
      if (subOf(d) === 'FreeText') regenFreeText(doc, d);
    } else if (op.type === 'del') {
      const arr = page.node.Annots(); if (!arr) continue;
      const kill = new Set([refKey(ref)]);
      for (let changed = true; changed;) {
        changed = false;
        for (let i = 0; i < arr.size(); i++) {
          const r = arr.get(i); if (!(r instanceof PDFRef)) continue;
          const dd = ctx.lookupMaybe(r, PDFDict); if (!dd) continue;
          if (!kill.has(refKey(r))) {
            const irt = dd.get(N('IRT'));
            if (irt instanceof PDFRef && kill.has(refKey(irt))) { kill.add(refKey(r)); changed = true; }
          } else {
            const pop = dd.get(N('Popup'));
            if (pop instanceof PDFRef && !kill.has(refKey(pop))) { kill.add(refKey(pop)); changed = true; }
          }
        }
      }
      const keep = [], dead = [];
      for (let i = 0; i < arr.size(); i++) {
        const r = arr.get(i);
        if (r instanceof PDFRef && kill.has(refKey(r))) dead.push(r); else keep.push(r);
      }
      page.node.set(N('Annots'), ctx.obj(keep));
      dead.forEach((r) => ctx.delete(r));
    }
  }
  return await doc.save({ useObjectStreams: false });
}
// ページの削除などで使われなくなったオブジェクトを取り除き、保存するファイルを小さくする
function gcDoc(doc) {
  const ctx = doc.context;
  const livePages = new Set(doc.getPages().map((p) => p.ref.tag));
  const PAGE = PDFName.of('Page'), TYPE = PDFName.of('Type');
  const live = new Set(), stack = [];
  const push = (o) => {
    if (o instanceof PDFRef) {
      if (live.has(o.tag)) return;
      const t = ctx.lookup(o);
      if (t instanceof PDFDict && t.get(TYPE) === PAGE && !livePages.has(o.tag)) return;
      live.add(o.tag); if (t) stack.push(t);
    } else if (o) stack.push(o);
  };
  const ti = ctx.trailerInfo;
  [ti.Root, ti.Info, ti.Encrypt, ti.ID].forEach((o) => o && push(o));
  while (stack.length) {
    const o = stack.pop();
    if (o instanceof PDFStream) { for (const [, v] of o.dict.entries()) push(v); }
    else if (o instanceof PDFDict) { for (const [, v] of o.entries()) push(v); }
    else if (o instanceof PDFArray) { for (let i = 0; i < o.size(); i++) push(o.get(i)); }
  }
  const dead = [];
  for (const [ref] of ctx.enumerateIndirectObjects()) if (!live.has(ref.tag)) dead.push(ref);
  dead.forEach((r) => ctx.delete(r));
  return dead.length;
}
/* ---- 編集ロック（v4.11.1）: 使えない機能をグレーアウトする
 *  enc: 暗号化されている（ページの回転・整理・内容の編集・既存の注釈の変更・しおりの編集など、PDFの中身を作り直す機能が使えない）
 *  annot / print: 文書の設定（権限）で、注釈の追加／印刷が許可されているか */
const encLocked = () => !!(S.lock.enc || S.libErr);
async function refreshLock() {
  const pdf = S.pdf, bytes = S.baseBytes; if (!pdf || !bytes) return;
  let enc = null, perms = null;
  try { enc = await lockInfo(bytes); } catch { /* ignore */ }
  try { perms = await pdf.getPermissions(); } catch { /* ignore */ }
  if (pdf !== S.pdf) return;
  S.lock = { enc: !!(enc && !enc.error), annot: !perms || perms.includes(0x20), print: !perms || perms.includes(0x04) };
  updateButtons(); syncProps();
  if (!S.lock.annot && !['select', 'asel', 'edit'].includes(S.tool)) setTool('select');
  if (encLocked() && S.tool === 'edit') setTool('select');
}
async function probeLib(bytes, gen) {
  S.libErr = false; showWarn();
  if (bytes.length > 40e6) { refreshLock(); return; }               // 大きなPDFは pdf-lib での試し読みを省く（暗号化は refreshLock で調べる）
  await refreshLock();
  if (gen !== S.loadGen) return;
  if (S.lock.enc) return;                                            // 暗号化されている: pdf-lib では読めないことが分かっているので、試し読みしない
  await new Promise((r) => (window.requestIdleCallback ? requestIdleCallback(r, { timeout: 1500 }) : setTimeout(r, 0)));
  if (gen !== S.loadGen) return;
  try { await PDFDocument.load(bytes, { updateMetadata: false }); }
  catch (e) { if (gen !== S.loadGen) return; S.libErr = friendlyError(e) + '\n（' + ((e && e.message) || e).slice(0, 160) + '）'; showWarn(); }
  if (gen === S.loadGen) refreshLock();
}
function showWarn() {
  $('#warn').hidden = true; return;            // v3.9: 編集ロック（暗号化・セキュリティ設定）の警告は表示しない（判定結果 S.libErr は内部で使う）
  // eslint-disable-next-line no-unreachable
  const w = $('#warn');
  if (!S.libErr) { w.hidden = true; return; }
  w.hidden = false;
  w.innerHTML = `<b>ℹ このPDFは暗号化（セキュリティ設定）などのため、通常の方法では編集できません。</b>` +
    `<br>図形・テキスト・スタンプは<b>画像として追記保存</b>できます（元の文書・暗号化は変更しません）。PDF内の文字・図形の編集、ページ操作、既存コメントの編集・移動・削除はできません。` +
    `<br><small>${esc(S.libErr).replace(/\n/g, ' ')}</small><button type="button" id="warnX">×</button>`;
  $('#warnX').onclick = () => { w.hidden = true; };
}
/* ------------------------------------------------------------ 文書の読み込み */
const wrap = $('#wrap'), pagesEl = $('#pages'), msgEl = $('#msg'), stage = $('#stage');
function showMsg(html, err = false) {
  msgEl.className = 'msg' + (err ? ' err' : ''); msgEl.innerHTML = html; msgEl.style.display = 'flex';
  const b = msgEl.querySelector('button'); if (b) b.addEventListener('click', openFileDialog);
}
/* ---- 大きなPDFは、ファイルの中身をメモリに置かない（v4.11.2）
 *  40MB以上のPDFは、ファイル（ディスク）から必要な部分だけをその都度読む（LazyPdf）。表示（PDF.js）は必要な範囲だけを受け取るので、
 *  開いた直後のメモリにPDF全体が載らない。保存・ページ操作・注釈の変更など、PDF全体が必要な操作のときだけ全体を読み込む（baseAll）。
 *  元のファイルに上書き保存する前には、全体をメモリに読み込んで固定する（pin。上書きしたあとで古い内容を読み続けないように） */
const LAZY_MIN = 40 * 1024 * 1024;
class LazyPdf {
  constructor(length, reader, file = null, url = null) { this.length = length; this.byteLength = length; this._read = reader; this._mem = null; this._weak = null; this.file = file; this.url = url; }
  // 先頭から順に読む（小さな塊で届くので、読み終えた分はすぐ手放せる）
  async stream() { const c = this._cached(); if (c) return new Blob([c]).stream(); if (this.file) return this.file.stream(); return (await fetch(this.url)).body; }
  _cached() { return this._mem || (this._weak && this._weak.deref()) || null; }
  async read(b, e) {
    e = Math.min(e, this.length); const c = this._cached();
    if (c) return c.slice(b, e);
    const u = new Uint8Array(await this._read(b, e));
    if (u.length !== e - b) throw new Error('PDFファイルの読み込みに失敗しました（ファイルが変更・移動された可能性があります）');
    return u;
  }
  async all() {
    const c = this._cached(); if (c) return c;
    const u = await this.read(0, this.length); this._weak = new WeakRef(u); return u;
  }
  async pin() { if (!this._mem) this._mem = await this.all(); }
  get pinned() { return !!this._mem; }
}
const isLazy = (b) => b instanceof LazyPdf;
// 今のPDF全体のバイト列（大きなPDFでは、このときにファイルから読み込む）
const baseAll = async (b = S.baseBytes) => (isLazy(b) ? b.all() : b);
// 元のファイルに上書きする前に: 読んでいるファイルの中身をメモリに固定する
async function pinBase() { const b = S.baseBytes; if (isLazy(b)) await b.pin(); for (const sn of [...S.undo, ...S.redo]) if (isLazy(sn.b) && sn.b !== b) await sn.b.pin(); }
// ファイル（File）から
const lazyFromFile = (f) => new LazyPdf(f.size, (b, e) => f.slice(b, e).arrayBuffer(), f);
// file:// のURLから（範囲を指定して読めるときだけ）。40MB未満・範囲を指定して読めないときは null
//  Chrome の file:// は範囲指定（Range）で読めるが、ファイルの大きさを返さないので、1バイトずつ読めるかどうかで大きさを調べる
async function lazyFromUrl(url) {
  const rd = async (b, e) => {
    const r = await fetch(url, { headers: { Range: `bytes=${b}-${e - 1}` } });
    if (!r.ok) throw new Error('PDFファイルの一部を読み込めませんでした');
    return r.arrayBuffer();
  };
  const ok = async (x) => { try { return (await rd(x, x + 1)).byteLength === 1; } catch { return false; } };
  try {
    if ((await rd(1000, 2000)).byteLength !== 1000) return null;       // 範囲を指定して読めない
    if (!(await ok(LAZY_MIN))) return null;                             // 40MB未満
    let lo = LAZY_MIN, hi = LAZY_MIN * 2;
    while (await ok(hi)) { lo = hi; hi *= 2; if (hi > 2 ** 42) return null; }
    while (hi - lo > 1) { const m = Math.floor((lo + hi) / 2); if (await ok(m)) lo = m; else hi = m; }
    return new LazyPdf(lo + 1, rd, null, url);
  } catch { return null; }
}
// 大きなPDFを少しずつ読みながら、文字列があるか調べる（後ろから。全体をメモリに置かない）
async function lazyContains(src, ...strs) {
  const ov = Math.max(...strs.map((t) => t.length)) - 1, rd = (await src.stream()).getReader();
  let tail = new Uint8Array(0);
  try {
    for (;;) {
      const { value, done } = await rd.read(); if (done) return false;
      const buf = new Uint8Array(tail.length + value.length); buf.set(tail); buf.set(value, tail.length);
      if (bytesContain(buf, ...strs)) return true;
      tail = buf.slice(Math.max(0, buf.length - ov));                       // 塊の境目をまたぐ文字列のために、末尾を少し残す
    }
  } finally { try { rd.cancel(); } catch { /* ignore */ } }
}
// 編集ロック（暗号化）の情報: 大きなPDFでは、先頭と末尾だけを読んで調べる（分からなければ全体を読む）
async function lockInfo(b = S.baseBytes) {
  if (!isLazy(b)) return UNLOCK.info(b);
  const head = await b.read(0, Math.min(b.length, 1 << 20)), tail = await b.read(Math.max(0, b.length - 8 * (1 << 20)), b.length);
  const both = new Uint8Array(head.length + tail.length); both.set(head); both.set(tail, head.length);
  const r = await UNLOCK.info(both);
  return r && r.error ? UNLOCK.info(await b.all()) : r;
}
// v4.11.2: 大きなPDFは、PDF.js にファイル全体の写しを渡さず、必要な部分だけをその都度渡す（PDFDataRangeTransport）
//  これまでは、画面側（保存・編集用）と PDF.js の作業スレッド（表示用）に、同じPDFを1つずつ持っていて、メモリが2倍になっていた。
//  作業スレッドは、表示するページに必要な部分（文字・画像・フォントなど）だけを読み込むので、開いた直後のメモリが大きく減る。
const RANGE_MIN = 4 * 1024 * 1024, RANGE_CHUNK = 256 * 1024;
function pdfjsOpts(bytes) {
  const base = { cMapUrl: LIB + 'cmaps/', cMapPacked: true,
    standardFontDataUrl: LIB + 'standard_fonts/', wasmUrl: LIB + 'wasm/', iccUrl: LIB + 'iccs/',
    useSystemFonts: true, disableFontFace: S.textMode === 'outline', worker: PDFW };
  if (!isLazy(bytes) && bytes.length < RANGE_MIN) return { ...base, data: bytes.slice() };     // 小さなPDFは、これまでどおり丸ごと渡す
  const head = isLazy(bytes) ? null : bytes.slice(0, Math.min(bytes.length, RANGE_CHUNK * 4));
  const tr = new pdfjsLib.PDFDataRangeTransport(bytes.length, head);
  // 作業スレッドから頼まれた範囲を渡す（写しを渡す。元のバイト列は、保存・編集用にこちらで持ち続ける）
  tr.requestDataRange = (begin, end) => {
    const get = isLazy(bytes) ? bytes.read(begin, end) : Promise.resolve(bytes.slice(begin, Math.min(end, bytes.length)));
    get.then((c) => tr.onDataRange(begin, c), (e) => { console.error(e); toast('PDFファイルを読み込めませんでした。ファイルが変更・移動された可能性があります。開き直してください。', 8000); });
  };
  return { ...base, range: tr, length: bytes.length, rangeChunkSize: isLazy(bytes) ? RANGE_CHUNK * 4 : RANGE_CHUNK, disableAutoFetch: true, disableStream: true };
}
async function openPdfJs(bytes) {
  const task = pdfjsLib.getDocument(pdfjsOpts(bytes));
  task.onPassword = (update, reason) => {
    const pw = window.prompt(reason === 2 ? 'パスワードが違います。もう一度入力してください。' : 'このPDFのパスワードを入力してください。');
    if (pw === null) task.destroy(); else update(pw);
  };
  return await task.promise;
}
function swapPdf(pdf) {
  for (const p of S.pages) releasePage(p);
  const old = S.pdf; S.pdf = pdf;
  if (old && old !== pdf) { try { old.destroy(); } catch { /* ignore */ } }
}
async function loadFromBytes(bytes, name, { handle = null, url = null, page = 1 } = {}) {
  const gen = ++S.loadGen;
  const head = new TextDecoder('latin1').decode(isLazy(bytes) ? await bytes.read(0, Math.min(1024, bytes.length)) : bytes.subarray(0, 1024));
  if (!head.includes('%PDF')) throw new Error('PDF形式のファイルではありません。');
  let annots = [], base = bytes;
  // v4.11.1: PDF.js での読み込み（作業スレッド）と、このアドオンの注釈があるかの確認（画面のスレッド）を同時に進める
  let pdfP = openPdfJs(bytes);
  if (!isLazy(bytes) && bytesContain(bytes, 'EPAType', MARKER)) {
    try { const r = await extractOurs(await baseAll(bytes)); base = r.bytes; annots = r.annots; }
    catch (e) { console.warn('既存図形の取り込みに失敗', e); }
    if (base !== bytes) { pdfP.then((p) => p.destroy()).catch(() => {}); pdfP = openPdfJs(base); }
  }
  const pdf = await pdfP;
  if (gen !== S.loadGen) { pdf.destroy(); return; }
  swapPdf(pdf);
  ceOnBase(null); ceLeave();
  Object.assign(S, { baseBytes: base, fileName: name, fileHandle: handle, sourceUrl: url,
    annots, natives: [], nmap: new Map(), selId: null, undo: [], redo: [], dirty: false, draft: null, drag: null, ghost: null, editing: null });
  document.title = `${name} - PDFエディター`;
  $('#fileName').textContent = name; $('#fileName').title = name;
  $('#btnNative').style.display = url ? '' : 'none';
  msgEl.style.display = 'none';
  closeFind(); FIND.cache.clear(); findDet.clear(); FIND.q = '';                          // 別のPDFを開いた: 検索をやめる
  await buildPages(page);
  syncProps(); updateButtons(); scheduleList();
  refreshLock();                                                          // 編集ロックの確認は軽いので、すぐ行う（使えないボタンを早くグレーアウトする）
  // v4.11.1: 既存の注釈・しおりの一覧や、pdf-lib での試し読みは、最初のページが表示されてから行う（表示を待たせない）
  await afterFirstPaint(gen);
  if (gen !== S.loadGen) return;
  // 大きなPDF（ファイルから少しずつ読む）は、このアドオンの注釈があるかを、最初のページを表示してから調べる
  if (isLazy(base) && await lazyContains(base, 'EPAType', MARKER) && gen === S.loadGen) {
    try {
      const r = await extractOurs(await baseAll(base));
      if (gen === S.loadGen && r.annots.length) { S.annots = r.annots; await setBase(r.bytes); S.undo = []; S.redo = []; S.dirty = false; updateButtons(); }
    } catch (e) { console.warn('既存図形の取り込みに失敗', e); }
    if (gen !== S.loadGen) return;
  }
  collectNatives(); collectOutline();
  probeLib(S.baseBytes, gen);
}
// 表示中のページが描き終わるまで待つ（最長2秒）
function afterFirstPaint(gen) {
  return new Promise((res) => {
    const t0 = performance.now();
    const tick = () => { const p = S.pages[S.cur - 1]; if (gen !== S.loadGen || (p && p.rendered) || performance.now() - t0 > 2000) res(); else setTimeout(tick, 30); };
    tick();
  });
}
async function setBase(bytes, { keepScroll = true } = {}) {
  const sy = wrap.scrollTop, cur = S.cur;
  if (S.editing) endEdit(false);
  const pdf = await openPdfJs(bytes);
  // v3.7: ページ数が同じなら、表示を作り直さずに差し替える（今の表示を残したまま描き直すので、白くならない）
  if (keepScroll && S.pdf && S.pages.length === pdf.numPages) { await swapInPlace(pdf, bytes); refreshLock(); collectOutline(); findReset(); return; }
  swapPdf(pdf);
  ceOnBase(bytes);
  S.baseBytes = bytes; S.draft = null; S.drag = null; S.ghost = null;
  await buildPages(Math.min(cur, pdf.numPages));
  if (keepScroll) wrap.scrollTop = sy;
  syncProps(); updateButtons(); scheduleList();
  collectNatives(); refreshLock(); collectOutline(); findReset();
}
/** 文書を差し替える（ページの枠と描画済みの画像はそのまま。新しい内容の描画ができたページから、一度に入れ替える） */
async function swapInPlace(pdf, bytes) {
  const old = S.pdf;
  pvReset(true);
  for (const p of S.pages) { cancelRender(p); p.pageObj = null; if (p.rendered) p.rscale = -1; }
  S.pdf = pdf; ceOnBase(bytes);
  S.baseBytes = bytes; S.draft = null; S.drag = null; S.ghost = null;
  S.firstView1 = (await pdf.getPage(1)).getViewport({ scale: 1 });
  if (['width', 'height', 'page'].includes(S.fit)) {        // ページの向き・大きさが変わった場合（回転の取り消しなど）に合わせる
    const cp = await pdf.getPage(S.cur);
    if (S.pdf !== pdf) return;
    computeScale(cp.getViewport({ scale: 1 }));
  }
  const want = (p) => (S.paged ? S.keep.has(p.num) || p.num === S.cur : p.rendered || nearView(p));
  const order = [...S.pages].sort((a, b) => Math.abs(a.num - S.cur) - Math.abs(b.num - S.cur));
  for (const p of order) {
    if (S.pdf !== pdf) return;
    if (!want(p)) { if (p.rendered) releasePage(p); continue; }
    p.pageObj = await pdf.getPage(p.num);
    if (S.pdf !== pdf) return;
    if (!S.zooming) applyScale(p);
    renderPage(p);
  }
  if (old && old !== pdf) { try { old.destroy(); } catch { /* ignore */ } }
  syncProps(); updateButtons(); scheduleList();
  collectNatives();
  (async () => {                                   // 残りのページの寸法を、新しい文書に合わせる（回転などに対応）
    for (const p of S.pages) {
      if (S.pdf !== pdf) return;
      if (!p.pageObj) { p.pageObj = await pdf.getPage(p.num); if (S.pdf === pdf && !S.zooming && (!S.paged || p.num === S.cur)) sizePage(p); }
    }
    updatePgBar();
  })().catch(console.error);
}
// ページの枠をすべて作り直す（描画は見えている付近だけ、後から順に行う）
async function buildPages(startPage = 1) {
  const gen = S.loadGen, pdf = S.pdf;
  io.disconnect(); ioFar.disconnect(); pvReset(false);
  pagesEl.replaceChildren(); S.pages = [];
  $('#pageCount').textContent = pdf.numPages; $('#pageNum').max = pdf.numPages;
  const first = await pdf.getPage(1);
  S.firstView1 = first.getViewport({ scale: 1 });
  S.cur = S.want = clamp(startPage, 1, pdf.numPages);
  const curPage = S.cur === 1 ? first : await pdf.getPage(S.cur);
  if (S.fit === 'width' || S.fit === 'height' || S.fit === 'page') computeScale(curPage.getViewport({ scale: 1 }));
  wrapDims = [wrap.clientWidth, wrap.clientHeight];                 // 全ページの枠を作る間は、表示領域の大きさを1回だけ測る
  for (let i = 1; i <= pdf.numPages; i++) {
    const el = document.createElement('div'); el.className = 'pg'; el.dataset.num = i;
    pagesEl.appendChild(el);
    const p = { num: i, el, pageObj: i === 1 ? first : (i === S.cur ? curPage : null), gen: 0, rendered: false, rendering: false, visible: false,
      view: null, svg: null, task: null, scale: S.scale, rscale: 0, rtarget: 0, rp: null, rc: 0 };
    S.pages.push(p); sizePage(p); io.observe(el); ioFar.observe(el);
  }
  wrapDims = null;
  applyPaged();
  if (S.paged) wrap.scrollTop = 0; else if (startPage > 1) S.pages[S.cur - 1]?.el.scrollIntoView();
  $('#pageNum').value = S.cur;
  (async () => {
    await afterFirstPaint(gen);                                         // 残りのページの寸法の読み込みは、最初のページを描いてから
    for (let i = 2; i <= pdf.numPages; i++) {
      if (gen !== S.loadGen || pdf !== S.pdf) return;
      const p = S.pages[i - 1]; if (!p.pageObj) p.pageObj = await pdf.getPage(i);
      if (gen !== S.loadGen || pdf !== S.pdf) return;
      if (!S.zooming && (!S.paged || p.num === S.cur)) sizePage(p);
    }
  })().catch(console.error);
  if (S.paged) startPaged();
  updatePgBar();
}
/* ------------------------------------------------------- ズーム / フィット */
function fitBase() { const p = S.pages[S.cur - 1]; return p && p.pageObj ? p.pageObj.getViewport({ scale: 1 }) : S.firstView1; }
// v4.11.1: 全ページの大きさを直す間は、表示領域の大きさを1回だけ測って使い回す
// （ページごとに測ると、そのたびにレイアウトの計算が走り、千ページ以上の文書で1秒以上止まっていた）
let wrapDims = null;
/** 1画面に収める倍率（v: 倍率1のビューポート, fit: 収め方。省略時は現在の設定） */
function calcScale(v, fit = S.fit) {
  const fitV = fit === 'height' || fit === 'page';                   // v3.3: 縦に収める／ページ全体は、上下の余白なし
  const dims = wrapDims || [wrap.clientWidth, wrap.clientHeight];
  const cw = dims[0] - 40, ch = dims[1] - (fitV ? 0 : 24);
  const fw = cw / v.width; let fh = (ch - (fitV ? 0.5 : 1)) / v.height, s = S.scale;
  if (fit === 'width') s = fw;
  else if (fit === 'page') s = Math.min(fw, fh);
  else if (fit === 'height') { if (v.width * fh > cw) fh = (ch - 17) / v.height; s = fh; }
  return clamp(s, 0.1, 8);
}
/** ズーム選択欄の表示を現在の状態に合わせる（手動倍率は、末尾の1つの項目を書き換えて表す） */
function syncZoomUi() {
  const sel = $('#selZoom'), cu = $('#optCustom');
  if (['width', 'page', 'height'].includes(S.fit)) { sel.value = S.fit; cu.hidden = true; return; }
  const hit = [...sel.options].find((o) => o !== cu && !isNaN(+o.value) && Math.abs(+o.value - S.scale) < 0.004);
  if (hit) { sel.value = hit.value; cu.hidden = true; return; }
  cu.value = String(+S.scale.toFixed(3)); cu.textContent = Math.round(S.scale * 100) + '%'; cu.hidden = false; sel.value = cu.value;
}
function computeScale(base) { const v = base || fitBase(); if (!v) return; S.scale = calcScale(v); syncZoomUi(); }
const fitPaged = () => S.paged && (S.fit === 'height' || S.fit === 'page');
/** そのページの表示倍率。1ページ表示の「縦に収める」では、ページごとの寸法に合わせる（サイズの違うページでも収まる） */
function pageScale(p) { return fitPaged() && p.pageObj ? calcScale(p.pageObj.getViewport({ scale: 1 })) : S.scale; }
/** ページの枠・描画済みの内容（canvas / SVG / 文字層）を、現在の倍率の大きさに引き伸ばす（再描画はしない＝軽い） */
function restyle(p) {
  const sc = p.scale;
  const v = p.pageObj ? p.pageObj.getViewport({ scale: sc }) : S.firstView1.clone({ scale: sc });
  const w = v.width + 'px', h = v.height + 'px';
  p.el.style.width = w; p.el.style.height = h; p.el.style.setProperty('--scale-factor', sc);
  if (p.rendered) {
    const cv = p.el.firstElementChild;
    if (cv && cv.tagName === 'CANVAS') { cv.style.width = w; cv.style.height = h; }
    if (p.svg) { p.svg.setAttribute('width', v.width); p.svg.setAttribute('height', v.height); }
  }
}
function sizePage(p) { applyScale(p); }
function applyScale(p) {
  p.scale = pageScale(p); restyle(p);
  if (p.rendering && p.rtarget !== p.scale) cancelRender(p);       // 古い倍率の描画は捨てる
}
/* ---- 拡大縮小: 表示はすぐピクセル拡大で追従し、ホイールが止まってから、必要なページだけ再描画して差し替える ---- */
let zoomTimer = 0;
function startZoomCommit(ms) { S.zooming = true; clearTimeout(zoomTimer); zoomTimer = setTimeout(commitRender, ms); }
function nearView(p) {
  const r = p.el.getBoundingClientRect(), w = wrap.getBoundingClientRect();
  return r.width > 0 && r.bottom > w.top - 600 && r.top < w.bottom + 600;
}
function commitRender() {
  zoomTimer = 0; S.zooming = false;
  LS.set('zoom', { fit: S.fit, scale: S.scale, paged: S.paged, mem: S.fitMem });
  if (S.paged) { startPaged(); for (const p of S.pages) if (!S.keep.has(p.num) && (p.rendered || p.rendering)) releasePage(p); }
  else for (const p of S.pages) { if (nearView(p)) renderPage(p); else if (p.rendered || p.rendering) releasePage(p); }
}
/** 倍率・表示モードが変わったあとのレイアウト更新。anchor（画面座標）の下にあった位置が、動かないようにスクロールを調整する */
function layoutZoom(anchor, modeChanged) {
  const wr = wrap.getBoundingClientRect();
  const cx = anchor ? anchor.x : wr.left + wr.width / 2, cy = anchor ? anchor.y : wr.top + wr.height / 2;
  let ref = null, fx = 0, fy = 0, bd = Infinity;
  for (const p of S.pages) {
    if (S.paged && p.num !== S.cur) continue;
    const r = p.el.getBoundingClientRect(); if (r.width === 0) continue;
    const d = cy < r.top ? r.top - cy : cy > r.bottom ? cy - r.bottom : 0;
    if (d < bd) { bd = d; ref = p; fx = (cx - r.left) / r.width; fy = (cy - r.top) / r.height; if (d === 0) break; }
  }
  if (ZT.k !== 1 || ZT.tx || ZT.ty) setZoomTransform(1, 0, 0);        // 拡大縮小の途中の見た目（transform）を外してから、本当の大きさにする
  wrapDims = [wrap.clientWidth, wrap.clientHeight];
  try { for (const p of S.pages) { if (S.paged && !p.pageObj && p.num !== S.cur) { p.scale = S.scale; continue; } applyScale(p); } }
  finally { wrapDims = null; }
  applyPaged();
  void wrap.offsetHeight;
  if (modeChanged || fitPaged()) {
    if (S.paged) { wrap.scrollTop = 0; wrap.scrollLeft = Math.max(0, (wrap.scrollWidth - wrap.clientWidth) / 2); }
    else { const cp = S.pages[S.cur - 1]; if (cp) wrap.scrollTop = Math.max(0, cp.el.offsetTop - 12); }
  } else if (ref) {
    const r2 = ref.el.getBoundingClientRect();
    wrap.scrollLeft += r2.left + fx * r2.width - cx; wrap.scrollTop += r2.top + fy * r2.height - cy;
  }
  updatePgBar();
}
/** 倍率を変える。fit: 'width'|'height'|'page'|null(任意倍率)。anchor: 画面座標（省略時は表示の中央） */
function setZoom(fit, scale, paged = S.paged, anchor = null, delay = 60) {
  if (!S.pdf) return;
  const modeChanged = !!paged !== S.paged;
  S.fit = fit; S.paged = !!paged; if (scale) S.scale = clamp(scale, 0.1, 8);
  pfTok++;
  computeScale(); syncZoomUi();
  layoutZoom(anchor, modeChanged);
  if (fitPaged()) {        // 横スクロールバーの有無で表示領域の高さが変わるため、レイアウト確定後にもう一度、ぴったり収まる倍率に合わせる
    const s1 = S.scale; computeScale();
    if (Math.abs(S.scale - s1) > 1e-4) { syncZoomUi(); layoutZoom(anchor, modeChanged); }
  }
  startZoomCommit(delay);
}
/* ---- 「縦に収める」「ページ全体」から拡大したあと、縮小して元の大きさに戻したら、その選択に戻す（収まる大きさより小さくはしない） ---- */
const fitFloor = (mem) => { const v = fitBase(); return Math.max(v ? calcScale(v, mem) : 0, S.fitMemScale || 0); };
function restoreFit(mem) {
  S.fitMem = null; S.fitMemScale = 0;
  setZoom(mem, null, true, null, 170);
  zTarget = S.scale;
}
/** 「＋」「−」ボタン・Ctrl+「+」「-」用の段階ズーム */
function stepZoom(scale) {
  if (!S.pdf) return;
  if (fitPaged()) {
    if (scale <= S.scale * 1.0001) return;                  // 収まる大きさより小さくはしない
    S.fitMem = S.fit; S.fitMemScale = S.scale;
  } else if (S.fitMem && S.paged && scale < S.scale && scale <= fitFloor(S.fitMem) * 1.004) { restoreFit(S.fitMem); return; }
  setZoom(null, scale);
}
/* ホイール拡大縮小は、1フレームに1回だけレイアウトに反映する */
let zRaf = 0, zTarget = 0, zAnchor = null;
/* ---- ホイール・ピンチでの拡大縮小（v4.11.1）
 *  回している間は、ページの並び（#pages）全体を CSS の transform で拡大縮小して見せるだけにする（ページごとの大きさの計算・
 *  レイアウトのやり直しをしない＝何千ページあっても軽い）。止まったら（約0.17秒後）1回だけ本当の大きさに直し、描き直す。 */
const ZT = { k: 1, tx: 0, ty: 0 };
const visScale = () => S.scale * ZT.k;                       // 画面に見えている倍率（拡大縮小の途中を含む）
function setZoomTransform(k, tx, ty) {
  ZT.k = k; ZT.tx = tx; ZT.ty = ty;
  pagesEl.style.transformOrigin = '0 0';
  pagesEl.style.transform = k === 1 && !tx && !ty ? '' : `translate(${tx}px, ${ty}px) scale(${k})`;
}
function zoomByFactor(factor, anchor) {
  if (!S.pdf) return;
  if (!zRaf && fitPaged()) {                                // 縦に収める／ページ全体: 縮小は無視。拡大したら、その選択を覚えておく
    if (factor <= 1) return;
    S.fitMem = S.fit; S.fitMemScale = S.scale;
  }
  zTarget = clamp((zRaf ? zTarget : visScale()) * factor, 0.1, 8); zAnchor = anchor;
  if (!S.zooming) for (const q of [...RS.active]) cancelRender(q);          // 拡大縮小の始まり: 描画中のページは取りやめる（倍率が変わるので使わない）
  S.zooming = true; clearTimeout(zoomTimer); zoomTimer = setTimeout(commitZoom, 200);
  if (zRaf) return;
  zRaf = requestAnimationFrame(() => {
    zRaf = 0;
    const mem = S.paged ? S.fitMem : null;
    if (mem && zTarget < visScale() && zTarget <= fitFloor(mem) * 1.004) { setZoomTransform(1, 0, 0); restoreFit(mem); return; }   // 元の大きさまで縮小した: 選択を保ったまま「収まる表示」に戻る
    const f = zTarget / visScale();
    if (Math.abs(f - 1) < 1e-6) return;
    S.fit = null; pfTok++;
    zoomPreview(ZT.k * f, f);
    const s0 = S.scale; S.scale = visScale(); syncZoomUi(); S.scale = s0;            // 倍率の表示は、見えている倍率にする
  });
}
/* 拡大縮小の途中の見た目を、止まったあとの本当のレイアウトと同じ位置に置く（v4.11.1）
 *  ・カーソルの下の点は動かさない
 *  ・ページの幅が表示領域より狭いときは左右の中央（本当のレイアウトでは中央に置かれる）
 *  ・広いときは、表示領域の外に余白ができないように、左右の端で止める（本当のレイアウトのスクロール範囲と同じ）
 *  ・上下も、文書の先頭より上・末尾より下に余白ができないように止める
 *  これで、止まったときに左右・上下へ動かない */
function zoomPreview(k2, f) {
  const wr = wrap.getBoundingClientRect(), cw = wrap.clientWidth, ch = wrap.clientHeight;
  const wl = wr.left + wrap.clientLeft, wt = wr.top + wrap.clientTop;
  const ax = zAnchor ? zAnchor.x : wl + cw / 2, ay = zAnchor ? zAnchor.y : wt + ch / 2;
  // 基準のページ: 1ページ表示では表示中のページ、連続表示ではカーソルの高さにある（いちばん近い）ページ
  let ref = S.paged ? S.pages[S.cur - 1] : null, R = ref ? ref.el.getBoundingClientRect() : null;
  if (!ref) {
    let bd = Infinity;
    for (let i = Math.max(0, S.cur - 4); i < Math.min(S.pages.length, S.cur + 3); i++) {
      const q = S.pages[i], r = q.el.getBoundingClientRect(); if (!r.height) continue;
      const d = ay < r.top ? r.top - ay : ay > r.bottom ? ay - r.bottom : 0;
      if (d < bd) { bd = d; ref = q; R = r; }
    }
  }
  const P = pagesEl.getBoundingClientRect(), k0 = ZT.k;
  const ox = P.left - ZT.tx, oy = P.top - ZT.ty;                        // #pages の左上（拡大縮小をかける前の位置）
  if (!ref || !R || !R.width) { setZoomTransform(k2, ax - f * (ax - ox - ZT.tx) - ox, ay - f * (ay - oy - ZT.ty) - oy); return; }
  const Lx = (R.left - P.left) / k0, Ly = (R.top - P.top) / k0, W2 = R.width * f;
  // 左右
  const left = W2 <= cw ? wl + (cw - W2) / 2 : clamp(ax - (ax - R.left) * f, wl + cw - W2, wl);
  const tx = left - ox - k2 * Lx;
  // 上下: カーソルの下の点を保ち、文書の先頭・末尾で止める
  // （#pages の上下の余白は、本当のレイアウトでは拡大縮小しないので、その分も合わせる）
  const cs = getComputedStyle(pagesEl), padT = parseFloat(cs.paddingTop) || 0, padB = parseFloat(cs.paddingBottom) || 0;
  const s0 = wrap.scrollTop, Hp = P.height / k0, Hall = k2 * (Hp - padT - padB) + padT + padB;
  const topMax = s0 + padT * (1 - k2), topMin = wt + ch - padB - oy - k2 * (Hp - padB);
  let ty = ay - (ay - R.top) * f - oy - k2 * Ly;
  if (Hall <= ch) ty = topMax;                                               // 文書全体が表示領域に収まる: 先頭に揃う
  else ty = clamp(ty, topMin, topMax);
  setZoomTransform(k2, tx, ty);
}
// 拡大縮小が止まった: 本当の大きさにレイアウトし直して（カーソルの下の点はそのまま）、描き直す
function commitZoom() {
  if (zRaf) { cancelAnimationFrame(zRaf); zRaf = 0; }
  if (ZT.k !== 1 || ZT.tx || ZT.ty) { S.scale = clamp(visScale(), 0.1, 8); syncZoomUi(); layoutZoom(zAnchor, false); }
  commitRender();
}
/* ------------------------------------------------------- 1ページ表示（先読み付き） */
/* 表示するページ以外は、画面の外に置いたまま（visibility:hidden）描画しておく。切り替えは「表示位置の入れ替え」だけなので、白い画面が出ない */
function applyPaged() {
  document.body.classList.toggle('paged', !!S.paged);
  for (const p of S.pages) p.el.classList.toggle('off', S.paged && p.num !== S.cur);
}
/** 保持（先読み）するページ: 前後1ページと、進行方向の3ページ先まで */
function setKeep(n) {
  const N = S.pdf ? S.pdf.numPages : 0, d = S.dirNav || 1;
  S.keep = new Set([n - 1, n, n + 1, n + 2 * d, n + 3 * d, S.cur].filter((x) => x >= 1 && x <= N));
}
function releaseOutside() { for (const p of S.pages) if ((p.rendered || p.rendering) && !S.keep.has(p.num)) releasePage(p); }
async function ensurePage(p) {
  if (!p.pageObj) p.pageObj = await S.pdf.getPage(p.num);
  applyScale(p);
}
let pfTok = 0;
// 先読み: 描く順番は renderPrio（行き先に近いページから）が決める。PDF.js の作業スレッドでの読み込みは、描画と並行して進む
async function prefetch(n) {
  const tok = ++pfTok, d = S.dirNav || 1;
  for (const m of [n + d, n + 2 * d, n - d, n + 3 * d]) {
    if (tok !== pfTok || !S.paged || !S.pdf) return;
    if (m < 1 || m > S.pdf.numPages || !S.keep.has(m)) continue;
    const p = S.pages[m - 1]; if (!p) continue;
    await ensurePage(p); if (tok !== pfTok) return;
    renderPage(p);
  }
}
function startPaged() {         // 読み込み直後・ズーム変更後: 現在のページを先に描き、そのあと前後を先読み
  setKeep(S.cur); S.want = S.cur;
  const p = S.pages[S.cur - 1]; if (!p) return;
  renderPage(p); prefetch(S.cur);
}
/* ---- ページ切り替え（v4.11.1: 高速なページ送り）
 *  ホイール・キーを回したら、描画を待たずにすぐ次のページへ切り替える（まだ描いていないページは「レンダリング中…」と表示）。
 *  続けて切り替えている間は描画を始めず、止まったところ（最後の切り替えから約0.15秒）で、そのページと前後のページを描く。
 *  これで、数百ページでも引っかからずに送れる。 */
let flipTimer = 0;
const FLIP_SETTLE = 150;
function showNow(n, where, fast = false) {
  const p = S.pages[n - 1]; if (!p) return;
  if (S.editing) endEdit(true);
  if (p.pageObj && !S.zooming) applyScale(p); else p.scale = pageScale(p);
  S.cur = n; S.scale = p.scale; syncZoomUi(); setKeep(S.want);
  applyPaged(); $('#pageNum').value = n;
  void wrap.offsetHeight;
  wrap.scrollTop = where === 'bottom' ? wrap.scrollHeight : 0;
  releaseOutside(); scheduleList(); updatePgBar();
  if (fast) { flipSettle(); return; }                              // 続けて切り替えている: 止まってから描く
  if (!p.rendered || p.rscale !== p.scale) ensurePage(p).then(() => { if (S.cur === n) { applyScale(p); renderPage(p); } }).catch(() => {});
  prefetch(S.want);
}
// ページ送りが止まったら、表示中のページを描き、前後を先読みする
function flipSettle() {
  clearTimeout(flipTimer);
  flipTimer = setTimeout(() => {
    if (performance.now() - RS.lastFlip < FLIP_SETTLE) { flipSettle(); return; }
    if (!S.paged || !S.pdf) return;
    const p = S.pages[S.cur - 1]; if (!p) return;
    const n = S.cur;
    ensurePage(p).then(() => { if (S.cur !== n) return; applyScale(p); renderPage(p); prefetch(n); }).catch(() => {});
  }, FLIP_SETTLE);
}
async function showPage(n, where = 'top') {
  if (!S.pdf) return;
  n = clamp(n, 1, S.pdf.numPages);
  S.dirNav = Math.sign(n - S.cur) || S.dirNav;
  const now = performance.now(), fast = now - RS.lastFlip < FLIP_SETTLE; RS.lastFlip = now;
  S.want = n; setKeep(n);
  showNow(n, where, fast);
}
const atTop = () => wrap.scrollTop <= 1;
const atBottom = () => wrap.scrollTop + wrap.clientHeight >= wrap.scrollHeight - 2;
const edgeNow = (dir) => S.want !== S.cur || (dir > 0 ? atBottom() : atTop());
/** 1ページ進む／戻る（描画を待たずに、すぐ切り替える） */
function advance(dir) {
  if (!S.pdf) return false;
  const t = S.want + dir;
  if (t < 1 || t > S.pdf.numPages) return false;
  showPage(t, dir > 0 ? 'top' : 'bottom');
  return true;
}
let lastKeyFlip = 0;
function keyFlip(dir) {
  const now = performance.now();
  if (now - lastKeyFlip < 25) return;
  if (advance(dir)) lastKeyFlip = now;
}
function pagedStep(dir, byKey = false, amount = 0) {
  if (edgeNow(dir)) keyFlip(dir);
  else wrap.scrollBy({ top: (amount || (byKey ? wrap.clientHeight * 0.9 : 120)) * dir });
}
function goPage(n) {
  if (!S.pdf) return;
  n = clamp(n, 1, S.pdf.numPages);
  if (S.paged) { showPage(n); return; }
  S.cur = S.want = n;
  const p = S.pages[n - 1];
  wrap.scrollTop = Math.max(0, p.el.offsetTop - 4);
  $('#pageNum').value = n;
}
/** 表示内容の設定（アンチエイリアスなど）を変えたとき、今の表示を残したまま描き直す */
function refreshAll() {
  for (const p of S.pages) p.rscale = -1;
  if (S.zooming) return;
  commitRender();
}
/* ---- ページ数スクロールバー（「縦に収める」「ページ全体」で、ページ数を表す） ---- */
const bar = $('#pgbar'), thumb = $('#pgthumb'), tip = $('#pgtip');
let barDrag = null;
function barLayout() {
  const N = S.pdf ? S.pdf.numPages : 1;
  bar.style.bottom = (wrap.offsetHeight - wrap.clientHeight) + 'px';
  const trackH = bar.clientHeight, thumbH = clamp(trackH / Math.max(N, 1), 30, Math.max(30, trackH));
  return { N, trackH, thumbH, room: Math.max(1, trackH - thumbH) };
}
function updatePgBar() {
  const show = !!(S.pdf && fitPaged() && S.pdf.numPages > 1);
  bar.hidden = !show; document.body.classList.toggle('pgbar-on', show);
  if (!show) return;
  const g = barLayout(), n = barDrag ? barDrag.page : S.want;
  thumb.style.height = g.thumbH + 'px';
  if (!barDrag || barDrag.free === undefined) thumb.style.top = ((n - 1) / Math.max(g.N - 1, 1)) * g.room + 'px';
  bar.title = `${n} / ${g.N} ページ`;
}
// ページ数スクロールバーの位置から、ページ番号を求める
function barPage(clientY, off) {
  const g = barLayout(), r = bar.getBoundingClientRect();
  const t = clamp((clientY - r.top - off) / g.room, 0, 1);
  return { page: Math.round(t * (g.N - 1)) + 1, top: clamp(clientY - r.top - off, 0, g.room), g };
}
thumb.addEventListener('pointerdown', (e) => {
  e.preventDefault(); e.stopPropagation(); thumb.setPointerCapture(e.pointerId);
  barDrag = { off: e.clientY - thumb.getBoundingClientRect().top, page: S.want, last: 0, free: 0 };
  thumb.classList.add('drag'); tip.hidden = false; tip.style.top = thumb.offsetTop + 'px'; tip.textContent = `${S.want} / ${S.pdf.numPages}`;
});
thumb.addEventListener('pointermove', (e) => {
  if (!barDrag) return;
  const b = barPage(e.clientY, barDrag.off); thumb.style.top = b.top + 'px'; tip.style.top = b.top + 'px'; tip.textContent = `${b.page} / ${b.g.N}`;
  if (b.page !== barDrag.page) {
    barDrag.page = b.page; const now = performance.now();
    if (now - barDrag.last > 90) { barDrag.last = now; showPage(b.page, 'top'); }
  }
});
const endBarDrag = (e) => {
  if (!barDrag) return;
  const pg = barDrag.page; barDrag = null; thumb.classList.remove('drag'); tip.hidden = true;
  try { thumb.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  showPage(pg, 'top'); updatePgBar();
};
thumb.addEventListener('pointerup', endBarDrag); thumb.addEventListener('pointercancel', endBarDrag);
bar.addEventListener('pointerdown', (e) => {                      // トラックをクリック: その位置のページへ
  if (e.target !== bar) return; e.preventDefault();
  const g = barLayout(), b = barPage(e.clientY, g.thumbH / 2); showPage(b.page, 'top');
});
function applyGamma() {
  const e = clamp(S.gamma / 100, 0.3, 2);
  for (const id of ['gR', 'gG', 'gB']) $('#' + id).setAttribute('exponent', String(e));
  document.body.classList.toggle('gam', Math.abs(e - 1) > 0.005);
}
/* ---------------------------------------------------------------- 描画 */
let lockTail = Promise.resolve();
function withLock(fn) { const run = lockTail.then(fn, fn); lockTail = run.catch(() => {}); return run; }
const io = new IntersectionObserver((es) => {
  const flipping = S.paged && performance.now() - RS.lastFlip < FLIP_SETTLE;          // 1ページ表示でページ送りを続けている間は描かない（止まってから flipSettle が描く）
  for (const e of es) { const p = S.pages[+e.target.dataset.num - 1]; if (!p) continue; p.visible = e.isIntersecting; if (e.isIntersecting && !flipping) renderPage(p); }
}, { root: wrap, rootMargin: '500px 0px' });
const ioFar = new IntersectionObserver((es) => { if (S.paged || S.zooming) return; for (const e of es) { const p = S.pages[+e.target.dataset.num - 1]; if (p && !e.isIntersecting && p.rendered) releasePage(p); } }, { root: wrap, rootMargin: '3000px 0px' });
/* ---- 描画の順番と、スクロール中の描画の制御（v4.11.1: 大きなPDFでも滑らかにスクロールできるように）
 *  ・描画を待っているページは、画面の中央に近い順に描く（通り過ぎたページの描画は待たない・取りやめる）
 *  ・同時に描画を進めるのは2ページまで（1ページを描いている間に、次のページの内容をPDF.jsの作業スレッドで読み込む）
 *  ・画面への描き込みは1フレームに1回分（約15ms）だけ。スクロール中は、さらに間隔をあけてスクロールを優先する
 *  ・アンチエイリアスで大きく描くページは、先に普通の大きさで描いて表示し、スクロールが止まってから高画質で描き直す */
const RS = { lastFlip: 0, fast: false, lastTop: 0, lastScroll: 0, lastSlice: 0, active: new Set(), queue: new Set(), waiting: new Map(), timer: 0, raf: 0, inflight: null, inflightAt: 0 };
const MAX_ACTIVE = 2;
window.__EPA_RS = RS;                         // 動作確認用
const scrollingNow = () => performance.now() - RS.lastScroll < 140;
/** 描画の優先度（小さいほど先）。描かなくてよいページは Infinity */
function renderPrio(p) {
  if (S.zooming || !pagedWanted(p)) return Infinity;
  const up = p.rendered ? 1e7 : 0;                                         // 描き直し（高画質化・倍率の変更）は、まだ白いページの後
  if (S.paged) return up + (p.num === S.want ? 0 : p.num === S.cur ? 1 : 2 + Math.abs(p.num - S.want));
  const r = p.el.getBoundingClientRect(), w = wrap.getBoundingClientRect();
  if (!r.height) return Infinity;
  const mid = (w.top + w.bottom) / 2, d = Math.abs((r.top + r.bottom) / 2 - mid);
  if (r.bottom > w.top && r.top < w.bottom) return up + d;                    // 画面に見えている
  const gap = r.bottom <= w.top ? w.top - r.bottom : r.top - w.bottom;
  if (gap > w.height) return Infinity;                                       // 1画面以上離れたページは描かない
  return up + 1e5 + d;
}
/** 描画の順番を待つ。描かなくてよくなったら false */
function renderSlot(p, gen) {
  return new Promise((res) => { p.slotRes = res; p.slotGen = gen; RS.queue.add(p); slotPump(); });
}
function slotDone(p) { if (RS.active.delete(p)) slotPump(); if (!RS.active.size) pvKick(150); }
function slotPump() {
  for (const q of RS.queue) if (q.slotGen !== q.gen || renderPrio(q) === Infinity) { RS.queue.delete(q); q.slotRes(false); }
  const busy = scrollingNow() && !S.paged;
  while (RS.active.size < MAX_ACTIVE && RS.queue.size) {
    let best = null, bp = Infinity;
    for (const q of RS.queue) { const v = renderPrio(q); if (v < bp) { bp = v; best = q; } }
    if (!best || (busy && (bp >= 1e5 || RS.fast))) break;                      // スクロール中は、見えているページだけ始める（速いときは、止まるまで待つ）
    // 優先度の高いページの読み込みが終わる（描き始める）までは、次のページを始めない（作業スレッドを、先に見せたいページに使う）
    if ([...RS.active].some((q) => !q.drawing && renderPrio(q) < bp)) break;
    RS.queue.delete(best); RS.active.add(best); best.slotRes(true);
  }
  if (RS.queue.size && busy) idleKick();
}
// スクロール中: 描画中のページのうち、遠く離れたものは取りやめる
function dropFarRenders() {
  if (S.paged) return;
  for (const q of [...RS.active]) if (q.rendering && renderPrio(q) === Infinity) cancelRender(q);
}
/** 画面への描き込み（PDF.js の onContinue）: 1フレームに1回分。スクロール中は間隔をあける。優先度の高いページから */
function drawGate(p, cont) {
  RS.waiting.set(p, cont);
  if (!p.drawing) { p.drawing = true; slotPump(); }                          // 読み込みが終わって描き始めた: 次のページの読み込みを始めてよい
  drawPump();
}
function drawPump() {
  if (!RS.waiting.size) return;
  const now = performance.now();
  if (scrollingNow() && !S.paged && now - RS.lastSlice < 60) { frameKick(); return; }
  let best = null, bp = Infinity;
  for (const q of RS.waiting.keys()) { const v = renderPrio(q); if (v < bp || !best) { bp = v; best = q; } }
  if (bp === Infinity) {                                                      // 拡大縮小中などで、描かなくてよくなったページは描かずに取りやめる
    for (const q of [...RS.waiting.keys()]) if (renderPrio(q) === Infinity) cancelRender(q);
    return;
  }
  // 別のページの描き込みが進行中（PDF.js が次のフレームで描く予定）なら、それが終わるまで待つ（1フレームに2ページ分を描かない）
  // 同じページの続きは待たない（v4.11.1: 1回分ごとに1フレーム空いて、描画が半分の速さになっていたのを修正）
  if (RS.inflight && RS.inflight !== best && RS.inflight.rendering && now - RS.inflightAt < 40) { frameKick(); return; }
  const cont = RS.waiting.get(best); RS.waiting.delete(best);
  RS.inflight = best; RS.inflightAt = now; RS.lastSlice = now;
  cont();
  if (RS.waiting.size) frameKick();
}
function frameKick() {
  if (RS.raf) return;
  RS.raf = requestAnimationFrame(() => { RS.raf = 0; drawPump(); });
}
function idleKick() {
  clearTimeout(RS.timer);
  RS.timer = setTimeout(() => { if (scrollingNow()) { idleKick(); return; } requestNear(); slotPump(); drawPump(); upgradePending(); pvKick(200); }, 150);
}
// スクロールが止まったとき: 画面の付近で、まだ描いていないページを描く（スクロール中に取りやめたページなど）
function requestNear() {
  if (S.paged || !S.pdf) return;
  const c = S.cur - 1;
  for (let i = Math.max(0, c - 3); i <= Math.min(S.pages.length - 1, c + 3); i++) {
    const p = S.pages[i];
    if ((!p.rendered || p.rscale !== p.scale) && !p.rendering && renderPrio(p) < Infinity) renderPage(p);
  }
}
// スクロールが止まったら、普通の大きさで描いておいたページを高画質で描き直す
function upgradePending() {
  if (S.paged || S.zooming) return;
  for (const p of S.pages) if (p.rquick && p.rendered && !p.rendering && renderPrio(p) < Infinity) { p.rscale = -1; renderPage(p); }
}
/** スクロールが止まってから実行する（選択用の文字層など、重い後処理） */
function afterScroll(fn) {
  const tick = () => {
    if (scrollingNow() && !S.paged) { setTimeout(tick, 160); return; }
    if (window.requestIdleCallback) requestIdleCallback(fn, { timeout: 600 }); else setTimeout(fn, 0);
  };
  tick();
}
wrap.addEventListener('scroll', () => {
  if (S.paged) return;
  const now = performance.now(), dt = Math.max(1, now - RS.lastScroll), dy = Math.abs(wrap.scrollTop - RS.lastTop);
  RS.fast = dy / Math.min(dt, 100) > wrap.clientHeight / 400;          // 1画面を0.4秒より速く動かしている: 止まるまで描画を始めない
  RS.lastScroll = now; RS.lastTop = wrap.scrollTop;
  dropFarRenders(); idleKick();
}, { passive: true });
/* ---- メモリの整理（v4.11.2）
 *  PDF.js は、読み込んだページのフォントや画像を、文書を閉じるまで覚えておく。大きな文書をたくさん見る（検索で全ページを読む）と
 *  数百MB以上になるので、ある程度のページを読んだら、描画していないときに PDF.js の覚えている内容を手放す（PDFDocumentProxy.cleanup）。
 *  表示中のページの絵はそのまま。手放したフォントは次に必要になったときに読み直す（フォントの変換結果は別に覚えているので速い） */
const CLEAN_EVERY = 80;
let workSince = 0, cleaning = null, cleanTimer = 0;
function noteWork() { if (++workSince >= CLEAN_EVERY) { clearTimeout(cleanTimer); cleanTimer = setTimeout(() => maybeCleanup(), 1500); } }
async function maybeCleanup(force = false) {
  if (!S.pdf || cleaning || (!force && workSince < CLEAN_EVERY)) return cleaning;
  if (RS.active.size || RS.queue.size || S.zooming || S.busy || S.editing || PV.busy) {          // 描画中などは待つ
    clearTimeout(cleanTimer); cleanTimer = setTimeout(() => maybeCleanup(force), 1000); return null;
  }
  const pdf = S.pdf;
  cleaning = (async () => {
    try { await pdf.cleanup(); workSince = 0; }
    catch (e) { clearTimeout(cleanTimer); cleanTimer = setTimeout(() => maybeCleanup(force), 1000); }      // 描画が始まっていた: あとでもう一度
    finally { cleaning = null; }
  })();
  return cleaning;
}
/** 描画を中止する（今の表示内容は残す） */
function cancelRender(p) {
  p.gen++; try { p.task && p.task.cancel(); } catch { /* ignore */ }
  p.task = null; p.rendering = false; p.rp = null;
  RS.waiting.delete(p); if (RS.queue.delete(p)) p.slotRes(false); slotDone(p);
}
/** 描画内容を捨てて、空の枠に戻す（PDF.js の、そのページの描画用データも手放す＝メモリを抑える） */
function releasePage(p) {
  // 描いてあった絵から縮小版を作っておく（読み直し不要で軽い。戻ってきたときにすぐ見せられる）
  if (!p.prev && p.rendered && Math.abs(p.num - S.cur) <= PV_KEEP) {
    const big = p.el.querySelector(':scope > canvas:not(.pv)');
    if (big && big.width > 0) {
      const k = Math.min(1, PV_W * 1.4 / Math.max(big.width, big.height)), cv = document.createElement('canvas'); cv.className = 'pv';
      cv.width = Math.max(1, Math.round(big.width * k)); cv.height = Math.max(1, Math.round(big.height * k));
      const x = cv.getContext('2d'); x.imageSmoothingQuality = 'high'; x.drawImage(big, 0, 0, cv.width, cv.height); p.prev = cv;
    }
  }
  cancelRender(p); p.svg = null; p.rendered = false; p.rscale = 0; p.rquick = false; p.el.replaceChildren();
  if (p.prev) p.el.appendChild(p.prev);                  // 縮小版があれば、それを見せておく
  if (p.pageObj) { try { p.pageObj.cleanup(); } catch { /* ignore */ } }
}
/* ---- 前後のページの縮小版（v4.11.2）
 *  表示中のページの前後（連続表示は前 PV_BACK・後ろ PV_AHEAD ページ）を、小さな画像（幅 PV_W 画素）で先に描いておく。
 *  スクロールしてきたときは、本来の描画が終わるまで縮小版を引き伸ばして見せる（「レンダリング中…」の代わり）。
 *  縮小版は1ページ約0.6MB。画面の描画（本来の大きさ）がないときだけ、1ページずつ描く。遠く離れたページの縮小版は捨てる */
const PV_AHEAD = 20, PV_BACK = 8, PV_W = 360, PV_KEEP = 40;
const PV = { busy: false, timer: 0, gen: 0 };
function pvKick(ms = 120) { clearTimeout(PV.timer); PV.timer = setTimeout(pumpPreview, ms); }
function pvTargets() {
  const N = S.pages.length, c = S.cur, d = S.dirNav || 1, out = [];
  for (let k = 1; k <= Math.max(PV_AHEAD, PV_BACK); k++) {             // 進む方向を先に、近い順
    if (k <= PV_AHEAD && c + k * d >= 1 && c + k * d <= N) out.push(c + k * d);
    if (k <= PV_BACK && c - k * d >= 1 && c - k * d <= N) out.push(c - k * d);
  }
  return [c, ...out].map((n) => S.pages[n - 1]);
}
async function pumpPreview() {
  if (PV.busy || !S.pdf || S.zooming || S.busy) return;
  const flipping = S.paged && performance.now() - RS.lastFlip < FLIP_SETTLE * 2;
  if (RS.active.size || RS.queue.size || cleaning || flipping || (scrollingNow() && !S.paged)) { pvKick(200); return; }   // 本来の描画・スクロール・ページ送りが先
  // 遠く離れたページの縮小版は捨てる
  for (const p of S.pages) if (p.prev && Math.abs(p.num - S.cur) > PV_KEEP) { if (p.prev.isConnected) p.prev.remove(); p.prev = null; }
  const p = pvTargets().find((q) => q && !q.prev && !q.rendered);
  if (!p) { if (PV.made) { PV.made = 0; maybeCleanup(true); } return; }      // 縮小版を描き終えた: 描画に使ったフォントなどを手放す
  PV.busy = true; const gen = PV.gen, pdf = S.pdf;
  try {
    const page = p.pageObj || (p.pageObj = await pdf.getPage(p.num));
    if (gen !== PV.gen || pdf !== S.pdf) return;
    const v1 = page.getViewport({ scale: 1 }), view = page.getViewport({ scale: Math.min(1, PV_W / Math.max(v1.width, v1.height) * 1.4) });
    const cv = document.createElement('canvas'); cv.className = 'pv';
    cv.width = Math.max(1, Math.floor(view.width)); cv.height = Math.max(1, Math.floor(view.height));
    const task = page.render({ canvasContext: cv.getContext('2d'), viewport: view });
    // 描き込みは、スクロール中・本来の描画があるときは待つ（画面の動きを優先）
    task.onContinue = (cont) => { const go = () => ((scrollingNow() && !S.paged) || S.zooming || RS.waiting.size || RS.active.size ? setTimeout(go, 50) : cont()); go(); };
    p.pvTask = task;
    await task.promise;
    p.pvTask = null;
    if (gen !== PV.gen || pdf !== S.pdf) return;
    p.prev = cv; PV.made = (PV.made || 0) + 1;
    if (!p.rendered) p.el.appendChild(cv);
    if (Math.abs(p.num - S.cur) > 3) { try { page.cleanup(); } catch { /* ignore */ } }   // すぐには本来の大きさで描かないページは、描画用のデータを手放す
    noteWork();
  } catch (e) { if (!e || e.name !== 'RenderingCancelledException') console.warn('preview', e); }
  finally { PV.busy = false; p.pvTask = null; pvKick(30); }
}
// 文書が変わった・拡大縮小の途中など: 縮小版を作り直す（今描いている縮小版は取りやめる）
function pvReset(drop) {
  PV.gen++;
  for (const p of S.pages) {
    if (p.pvTask) { try { p.pvTask.cancel(); } catch { /* ignore */ } p.pvTask = null; }
    if (drop && p.prev) { if (p.prev.isConnected) p.prev.remove(); p.prev = null; }
  }
}
function pickSS(q, W, H) {
  let ss = 1;
  if (S.aa === 'auto') ss = q < 1.0 ? 4 : q < 2 ? 2 : 1;
  else if (S.aa === 'max') ss = q < 2 ? 4 : q < 4 ? 2 : 1;
  while (ss > 1 && W * H * ss * ss > 40e6) ss /= 2;
  return ss;
}
const freeCanvas = (c) => { try { c.width = 0; c.height = 0; } catch { /* ignore */ } };
/** テキストレイヤ（選択用）をブラウザー標準のPDFビューアの選択表示に近づける: ①ハイライトの高さを文字の高さに ②同じ行の隣り合う文字列の隙間をつなぐ */
// v4.11.1: 文字の多いページで画面が止まらないように、少しずつ（手が空いたときに約8msずつ）処理する
async function tidyTextLayer(td) {
  const spans = [...td.children].filter((e) => e.tagName === 'SPAN');
  if (!spans.length || spans.length > 5000) return;
  const idle = () => new Promise((r) => (window.requestIdleCallback ? requestIdleCallback(r, { timeout: 500 }) : setTimeout(r, 0)));
  const STEP = 200;
  for (let st = 0; st < spans.length - 1; st += STEP) {
    if (st) await idle();
    if (!td.isConnected || S.zooming) return;
    const part = spans.slice(st, Math.min(spans.length, st + STEP + 1));      // 次の塊の先頭も1つ含める（隙間を測るため）
    for (const s of part) s.style.clipPath = 'inset(0)';
    const rs = part.map((s) => s.getBoundingClientRect());
    const jobs = [];
    for (let i = 0; i + 1 < part.length; i++) {
      const a = rs[i], b = rs[i + 1];
      if (!a.height || !b.height || !part[i].textContent) continue;
      const h = a.height, gap = b.left - a.right;
      if (Math.abs((a.top + a.bottom) / 2 - (b.top + b.bottom) / 2) < h * 0.4 && gap > 0.5 && gap < h * 2.2) jobs.push([part[i], gap]);
    }
    const pads = jobs.map(([s]) => { const i = document.createElement('i'); i.textContent = ' '; i.style.cssText = 'font:inherit;color:transparent;white-space:pre'; s.appendChild(i); return i; });
    const ws = pads.map((i) => i.getBoundingClientRect().width);
    pads.forEach((i, n) => {
      const s = jobs[n][0], tf = getComputedStyle(s).transform, k = (tf && tf !== 'none' && new DOMMatrixReadOnly(tf).a) || 1;
      i.style.letterSpacing = Math.max(0, (jobs[n][1] - ws[n]) / k) + 'px';
    });
  }
}
const pagedWanted = (p) => !S.paged || S.keep.has(p.num);
/** ページを描画する。すでに最新なら何もしない。描画中は今の表示を残し、できあがってから丸ごと差し替える（途中で白くならない） */
function renderPage(p) {
  if (p.rendered && p.rscale === p.scale) return Promise.resolve();
  if (p.rendering) return p.rp || Promise.resolve();
  if (S.zooming || !pagedWanted(p)) return Promise.resolve();
  p.rendering = true; const gen = p.gen;
  p.rp = doRender(p, gen).finally(() => { if (gen === p.gen) { p.rendering = false; p.rp = null; } });
  return p.rp;
}
/** 選択用の文字層は、画像の描画が終わって表示を切り替えたあとで組み立てる（ページ切り替えを待たせない） */
async function buildTextLayer(p, gen, view, sc) {
  let sw = null;
  try {
    const td = document.createElement('div'); td.className = 'textLayer';
    sw = document.createElement('div'); sw.className = 'stagepg'; sw.style.width = view.width + 'px'; sw.style.height = view.height + 'px';
    sw.style.setProperty('--scale-factor', sc); sw.appendChild(td); stage.appendChild(sw);
    const tl = new pdfjsLib.TextLayer({ textContentSource: p.pageObj.streamTextContent(), container: td, viewport: view });
    await tl.render();
    if (gen !== p.gen || p.view !== view) return;
    const old = p.el.querySelector(':scope > .textLayer');
    if (!old) return;
    old.replaceWith(td);
    tidyTextLayer(td);
  } catch (e) { console.warn('text layer', e); }
  finally { if (sw) sw.remove(); }
}
// 1ページを PDF.js で描画する。描き終わってから入れ替えるので、描画中も前の絵が見えたままになる
async function doRender(p, gen) {
  const lg = S.loadGen, pdf = S.pdf;
  let big = null, aborted = false;
  try {
    if (!p.pageObj) p.pageObj = await pdf.getPage(p.num);
    if (gen !== p.gen || lg !== S.loadGen) return;
    if (!(await renderSlot(p, gen))) { aborted = true; return; }             // 順番を待つ（待っている間に不要になったら描かない）
    p.drawing = false;
    if (gen !== p.gen) return;
    const sc = p.scale; p.rtarget = sc; p.rc++;
    const view = p.pageObj.getViewport({ scale: sc });
    const dpr = Math.min(window.devicePixelRatio || 1, Math.sqrt(16e6 / (view.width * view.height)));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(view.width * dpr)); canvas.height = Math.max(1, Math.floor(view.height * dpr));
    canvas.style.width = view.width + 'px'; canvas.style.height = view.height + 'px';
    let ss = pickSS(sc * dpr, canvas.width, canvas.height);
    const quick = ss > 1 && !p.rendered && !S.paged;                        // まだ白いページ: まず普通の大きさで描いて早く見せる
    if (quick) ss = 1;
    let target = canvas;
    if (ss > 1) { big = document.createElement('canvas'); big.width = canvas.width * ss; big.height = canvas.height * ss; target = big; }
    const sx = target.width / view.width, sy = target.height / view.height;
    globalThis.__EPA_MINW = 0;
    const ctx = target.getContext('2d');
    if (ss > 1) { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, target.width, target.height); }
    ctx.textRendering = 'geometricPrecision';
    p.task = p.pageObj.render({ canvasContext: ctx, viewport: view, transform: (sx !== 1 || sy !== 1) ? [sx, 0, 0, sy, 0, 0] : undefined });
    p.task.onContinue = (cont) => drawGate(p, cont);
    await p.task.promise;
    if (gen !== p.gen) return;
    if (big) {
      let cur = big;
      for (let k = ss; k > 1; k /= 2) {
        const n = document.createElement('canvas'); n.width = cur.width / 2; n.height = cur.height / 2;
        const x = n.getContext('2d'); x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'low';
        x.drawImage(cur, 0, 0, n.width, n.height); freeCanvas(cur); cur = n;
      }
      canvas.getContext('2d').drawImage(cur, 0, 0); freeCanvas(cur); big = null;
    }
    const td = document.createElement('div'); td.className = 'textLayer';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'ov'); svg.setAttribute('width', view.width); svg.setAttribute('height', view.height);
    svg.setAttribute('viewBox', `0 0 ${view.width} ${view.height}`);
    // ---- 差し替え（一度に入れ替えるので、途中で白い画面が出ない）
    p.view = view; p.svg = svg; p.rendered = true; p.rscale = sc; p.rquick = quick;
    p.el.style.width = view.width + 'px'; p.el.style.height = view.height + 'px'; p.el.style.setProperty('--scale-factor', sc);
    p.el.replaceChildren(canvas, td, svg);
    drawHits(p);                                                            // 検索結果の強調表示（v4.11.2）
    noteWork();
    redrawPage(p);
    if (S.editing && S.editing.a.page === p.num && !S.editing.ta.isConnected) p.el.appendChild(S.editing.ta);
    if (!quick) afterScroll(() => { if (gen === p.gen && p.view === view) buildTextLayer(p, gen, view, sc); });
    else idleKick();                                                            // 止まったら高画質で描き直す（文字層もそのとき作る）
  } catch (e) {
    if (e && e.name !== 'RenderingCancelledException') console.error(e);
  } finally {
    if (big) freeCanvas(big);
    RS.waiting.delete(p); slotDone(p); drawPump();
    if (aborted) { /* 順番待ちの間に不要になった */ }
  }
}
/* ------------------------------------------------------- SVGオーバーレイ */
function svgEl(name, attrs, parent) {
  const e = document.createElementNS(NS, name);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e); return e;
}
const pageOf = (a) => S.pages[a.page - 1];
const vpt = (view, pt) => view.convertToViewportPoint(pt[0], pt[1]);
function vbox(view, bb) {
  const c = [[bb[0], bb[1]], [bb[2], bb[1]], [bb[2], bb[3]], [bb[0], bb[3]]].map((q) => vpt(view, q));
  const xs = c.map((q) => q[0]), ys = c.map((q) => q[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}
function handlePoints(a) {
  if (a.type === 'text') {             // 0: 右辺（幅）、1〜4: 四隅（拡大縮小。フォントサイズも変わる）、5: 左辺（幅）、6: 上辺・7: 下辺（拡大縮小）
    const bb = localBox(a), c = a.pts[0], r = a.rot || 0, my = (bb[1] + bb[3]) / 2, mx = (bb[0] + bb[2]) / 2;
    return [[bb[2], my], [bb[0], bb[1]], [bb[2], bb[1]], [bb[2], bb[3]], [bb[0], bb[3]], [bb[0], my], [mx, bb[3]], [mx, bb[1]]].map((q) => rotPt(q, c, r));
  }
  if (isRectLike(a)) {                // 0〜3: 四隅、4〜7: 各辺の中央（四角形・楕円のみ）
    const [p0, p1] = a.pts, c = pivotOf(a);
    const cs = [[p0[0], p0[1]], [p1[0], p0[1]], [p1[0], p1[1]], [p0[0], p1[1]]].map((q) => rotPt(q, c, a.rot || 0));
    if (a.type === 'stamp') return cs;
    return [...cs, ...cs.map((q, i) => { const n2 = cs[(i + 1) % 4]; return [(q[0] + n2[0]) / 2, (q[1] + n2[1]) / 2]; })];
  }
  if (a.type === 'ink') { const b = primsBBox(shapePrims(a)); return [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]]; }
  return a.pts;
}
// 注釈1つを、ページの上の SVG オーバーレイに描く（draft は描画中のプレビュー）
function drawAnnot(p, a, parent, { draft = false } = {}) {
  const view = p.view, sc = view.scale;
  const V = (pt) => vpt(view, pt);
  const g = svgEl('g', { opacity: a.p.opacity / 100 }, parent);
  if (!draft) g.dataset.id = a.id;
  const selected = !draft && S.sel.has(a.id);
  const single = selected && S.sel.size === 1;
  const toD = (pr) => {
    if (pr.k === 'bez') {
      const f = (q) => { const [x, y] = V(q); return `${x.toFixed(2)} ${y.toFixed(2)}`; };
      return `M${f(pr.start)} ` + pr.segs.map((s) => `C${f(s[0])} ${f(s[1])} ${f(s[2])}`).join(' ') + (pr.closed !== false ? ' Z' : '');
    }
    return pr.pts.map((q, i) => { const [x, y] = V(q); return `${i ? 'L' : 'M'}${x.toFixed(2)} ${y.toFixed(2)}`; }).join(' ') + (pr.closed ? ' Z' : '');
  };
  if (a.type === 'text' || a.type === 'stamp') {
    const bb = annotBBox(a);
    if (a.type === 'text') {
      const g1 = svgEl('g', { transform: `matrix(${view.transform.join(' ')})` }, g);
      const L = layoutText(a.text, a.p.fontSize, a.w, { face: a.p.face }), bw = a.p.width || 0, F = faceOf(a.p.face);
      const g2 = svgEl('g', { transform: `translate(${a.pts[0][0]} ${a.pts[0][1]}) rotate(${a.rot || 0}) scale(1 -1)` }, g1);
      if (a.p.fill) svgEl('rect', { x: 0, y: 0, width: a.w, height: L.h, fill: a.p.fill }, g2);
      if (bw > 0) svgEl('rect', { x: bw / 2, y: bw / 2, width: a.w - bw, height: L.h - bw, fill: 'none', stroke: a.p.color, 'stroke-width': bw }, g2);
      L.lines.forEach((ln, i) => {
        for (const r of ln.runs) {
          if (r.t.trim() === '') continue;
          const t = svgEl('text', { x: r.x, y: L.pad + i * L.lh + L.b, fill: a.p.color, 'font-size': a.p.fontSize,
            'font-family': r.f === 'l' ? F.css.l : F.css.j, style: 'white-space:pre' }, g2);
          t.textContent = r.t;
        }
      });
      if (!a.text && !draft) svgEl('rect', { x: 0, y: 0, width: a.w, height: L.h, fill: 'none', stroke: '#999', 'stroke-dasharray': '3 2', 'stroke-width': 1 / sc }, g2);
    } else {
      // 画像は「貼ったときのページの向き」で正立する。その後ページを回転したら、画像もいっしょに回す
      const im = S.images.get(a.img), [x0, y0, x1, y1] = vbox(view, localBox(a));
      const turn = normRot(view.rotation - stampRot(a, view.rotation)), cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
      const iw = turn % 180 ? y1 - y0 : x1 - x0, ih = turn % 180 ? x1 - x0 : y1 - y0, deg = turn - (a.rot || 0);
      if (im) svgEl('image', { href: im.url, x: cx - iw / 2, y: cy - ih / 2, width: iw, height: ih, preserveAspectRatio: 'none',
        transform: deg ? `rotate(${deg} ${cx} ${cy})` : '' }, g);
    }
    void bb;
    const c = annotQuad(a).map(V);
    const dd = 'M' + c.map((q) => q.map((v) => v.toFixed(2)).join(' ')).join('L') + 'Z';
    if (selected) svgEl('path', { d: dd, fill: 'none', stroke: '#0f6cbd', 'stroke-width': 1.5, 'stroke-dasharray': '5 3', 'pointer-events': 'none' }, g);
    if (!draft) {
      const hit = svgEl('path', { d: dd, class: 'hit', fill: 'rgba(0,0,0,0)', stroke: 'none', 'pointer-events': 'all' }, g);
      hit.dataset.id = a.id;
      if (single) addHandles(p, a, parent);
    }
    return;
  }
  const prims = shapePrims(a);
  const ink = a.type === 'ink';
  const mainD = ink ? prims.map(toD).join(' ') : toD(prims[0]);
  const maxW = Math.max(...prims.map((pr) => primStyle(a, pr).width), a.p.width || 1);
  if (selected) svgEl('path', { d: mainD, fill: 'none', stroke: 'rgba(15,108,189,.28)', 'stroke-width': Math.max(maxW * sc, 1) + 7, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', 'pointer-events': 'none' }, g);
  for (const pr of prims) {
    const st = primStyle(a, pr);
    const common = { stroke: st.color, 'stroke-width': st.width * sc, 'stroke-linejoin': ink || a.type === 'cloud' ? 'round' : 'miter', fill: pr.fill && st.fill ? st.fill : 'none', 'pointer-events': 'none' };
    if ((st.op ?? 1) < 1) common.opacity = st.op;
    if (st.dash) common['stroke-dasharray'] = st.dash.map((v) => +(v * sc).toFixed(2)).join(' ');
    if (pr.k === 'circle') { const [cx, cy] = V(pr.c); svgEl('circle', { cx, cy, r: pr.r * sc, ...common }, g); }
    else svgEl('path', { d: toD(pr), ...common }, g);
  }
  if (!draft) {
    const filled = ((a.type === 'rect' || a.type === 'ellipse' || isClosedT(a.type)) && a.p.fill) || (ink && prims.some((pr) => pr.fill));
    const hit = svgEl('path', { d: mainD, class: 'hit', fill: 'none', stroke: 'rgba(0,0,0,0)', 'stroke-width': Math.max(maxW * sc, 1) + 8,
      'pointer-events': filled ? 'all' : 'stroke' }, g);
    hit.dataset.id = a.id;
    if (single) addHandles(p, a, parent);
  }
}
/** 画面上の向き（中心→ハンドル）に合った、拡大縮小の両矢印カーソル */
function resizeCursor(view, from, to) {
  const a = vpt(view, from), b = vpt(view, to);
  let ang = Math.atan2(b[1] - a[1], b[0] - a[0]) * 180 / Math.PI; ang = ((ang % 180) + 180) % 180;
  return ang < 22.5 || ang >= 157.5 ? 'ew-resize' : ang < 67.5 ? 'nwse-resize' : ang < 112.5 ? 'ns-resize' : 'nesw-resize';
}
function addHandles(p, a, parent) {
  const boxy = isRectLike(a) || a.type === 'text';
  const q = boxy ? annotQuad(a) : null, C = q ? [(q[0][0] + q[2][0]) / 2, (q[0][1] + q[2][1]) / 2] : null;
  handlePoints(a).forEach((pt, i) => {
    const [x, y] = vpt(p.view, pt);
    const edge = (a.type === 'text' && (i === 0 || i >= 5)) || (isRectLike(a) && i >= 4);
    const st = { fill: '#fff', stroke: '#0f6cbd', 'stroke-width': 2, class: 'h', 'pointer-events': 'all' };
    const h = edge ? svgEl('rect', { x: x - 4.5, y: y - 4.5, width: 9, height: 9, ...st }, parent) : svgEl('circle', { cx: x, cy: y, r: 5.5, ...st }, parent);
    if (boxy) {                        // 角は斜め、辺は縦横（枠の形ではなく、角か辺かで向きを決める）
      const r = a.rot || 0, l = rotPt(pt, C, -r), w2 = Math.abs(q[1][0] - q[0][0]) + Math.abs(q[1][1] - q[0][1]);
      const sx = Math.abs(l[0] - C[0]) > 1e-3 * (w2 + 1) ? Math.sign(l[0] - C[0]) : 0, sy = Math.abs(l[1] - C[1]) > 0.3 ? Math.sign(l[1] - C[1]) : 0;
      h.style.cursor = resizeCursor(p.view, C, rotPt([C[0] + sx, C[1] + sy], C, r));
    }
    h.dataset.h = i; h.dataset.id = a.id;
  });
}
// PDFにもともとあった注釈の、選択枠・移動中の位置を描く
function drawNative(p, n, parent) {
  const view = p.view;
  const sel = S.sel.has(n.key);
  const dr = S.drag && ((S.drag.mode === 'nmove' && S.drag.n === n) || (S.drag.mode === 'gmove' && S.drag.nats.has(n))) ? S.drag.d : [0, 0];
  const rs = S.drag && S.drag.mode === 'nresize' && S.drag.n === n ? S.drag : null;
  const r = [n.rect[0] + dr[0], n.rect[1] + dr[1], n.rect[2] + dr[0], n.rect[3] + dr[1]];
  const [x, y, x1, y1] = vbox(view, r), w = x1 - x, h = y1 - y;
  const g = svgEl('g', {}, parent);
  if (n.subtype === 'Text' && !n.hasAP) {
    const s = Math.min(Math.max(Math.min(w, h), 14), 24);
    svgEl('rect', { x, y, width: s, height: s, rx: 2, fill: '#ffd54a', stroke: '#b58900', 'stroke-width': 1, 'pointer-events': 'none' }, g);
    svgEl('path', { d: `M${x + 4} ${y + s * 0.38}H${x + s - 4}M${x + 4} ${y + s * 0.62}H${x + s - 4}`, stroke: '#8a6d00', 'stroke-width': 1.2, 'pointer-events': 'none' }, g);
  }
  const attrs = { class: 'nhit' };
  let hit;
  const pathOf = (pts, close) => pts.map((q, i) => { const c = vpt(view, [q[0] + dr[0], q[1] + dr[1]]); return `${i ? 'L' : 'M'}${c[0].toFixed(2)} ${c[1].toFixed(2)}`; }).join(' ') + (close ? 'Z' : '');
  if (n.subtype === 'Line' && n.line && n.line.length >= 4) hit = svgEl('path', { ...attrs, d: pathOf([[n.line[0], n.line[1]], [n.line[2], n.line[3]]]), 'stroke-width': 12, fill: 'none' }, g);
  else if ((n.subtype === 'PolyLine' || n.subtype === 'Polygon') && n.verts && n.verts.length > 1) hit = svgEl('path', { ...attrs, d: pathOf(n.verts, n.subtype === 'Polygon'), 'stroke-width': 12, fill: n.subtype === 'Polygon' ? 'rgba(0,0,0,0)' : 'none' }, g);
  else if (n.subtype === 'Ink' && n.ink && n.ink.length) hit = svgEl('path', { ...attrs, d: n.ink.map((l) => pathOf(l)).join(' '), 'stroke-width': 12, fill: 'none' }, g);
  else hit = svgEl('rect', { ...attrs, x, y, width: Math.max(w, 6), height: Math.max(h, 6) }, g);
  hit.dataset.nid = n.key;
  if (S.drag && S.drag.mode === 'gscale' && S.drag.nats.has(n) && S.drag.moved) {
    const [a0, b0, a1, b1] = vbox(view, gscaleRect(S.drag, n.rect));
    svgEl('rect', { x: a0, y: b0, width: a1 - a0, height: b1 - b0, fill: 'rgba(15,108,189,.10)', stroke: '#0f6cbd', 'stroke-width': 1.5, 'stroke-dasharray': '5 3', 'pointer-events': 'none' }, g);
    return;
  }
  if (rs) {
    const [a0, b0, a1, b1] = rs.vr;
    svgEl('rect', { x: a0, y: b0, width: a1 - a0, height: b1 - b0, fill: 'rgba(15,108,189,.10)', stroke: '#0f6cbd', 'stroke-width': 1.5, 'stroke-dasharray': '5 3', 'pointer-events': 'none' }, g);
    return;
  }
  const vd = S.drag && S.drag.mode === 'nvert' && S.drag.n === n ? S.drag : null;
  if (vd) {           // 頂点を動かしている途中: 新しい形を点線で表示
    svgEl('path', { d: pathOf(vd.pts.map((q) => [q[0] - dr[0], q[1] - dr[1]]), n.subtype === 'Polygon'), fill: 'none', stroke: '#0f6cbd', 'stroke-width': 1.5, 'stroke-dasharray': '5 3', 'pointer-events': 'none' }, g);
  }
  const np = sel && S.sel.size === 1 ? nativePts(n) : null;
  if (np) {           // 直線・折れ線・多角形・雲形: 頂点のハンドル（ドラッグで移動、Alt+クリックで削除）
    (vd ? vd.pts : np.pts).forEach((q, i) => {
      const [hx, hy] = vpt(view, q);
      const hd = svgEl('circle', { cx: hx, cy: hy, r: 5, fill: '#fff', stroke: '#0f6cbd', 'stroke-width': 2, class: 'nh', 'pointer-events': 'all' }, parent);
      hd.dataset.nv = i; hd.dataset.nid = n.key;
    });
    if (!vd) svgEl('path', { d: pathOf(np.pts, n.subtype === 'Polygon'), fill: 'none', stroke: '#0f6cbd', 'stroke-width': 1, 'stroke-dasharray': '4 3', 'pointer-events': 'none' }, g);
    return;
  }
  if (sel) {
    svgEl('rect', { x: x - 2, y: y - 2, width: w + 4, height: h + 4, fill: 'rgba(15,108,189,.08)', stroke: '#0f6cbd', 'stroke-width': 1.5, 'stroke-dasharray': '5 3', 'pointer-events': 'none' }, g);
    if (S.sel.size === 1 && NATIVE_RESIZABLE.has(n.subtype)) {
      [[x, y], [x1, y], [x1, y1], [x, y1]].forEach(([hx, hy], i) => {
        const hd = svgEl('rect', { x: hx - 5, y: hy - 5, width: 10, height: 10, fill: '#fff', stroke: '#0f6cbd', 'stroke-width': 2, class: 'nh', 'pointer-events': 'all' }, parent);
        hd.dataset.nh = i; hd.dataset.nid = n.key;
      });
    }
  }
}
function redrawPage(p) {
  if (!p || !p.svg || !p.view) return;
  p.svg.replaceChildren();
  for (const n of S.natives) if (n.page === p.num) drawNative(p, n, p.svg);
  const skip = S.editing ? S.editing.a.id : null;
  for (const a of S.annots) if (a.page === p.num && a.id !== skip) drawAnnot(p, a, p.svg);     // 配置順のとおりに描く（v3.6）
  p.svg.querySelectorAll('.h').forEach((h) => p.svg.appendChild(h));                           // ハンドルは一番上に
  drawGroupUi(p);
  if (S.draft && S.draft.page === p.num) drawAnnot(p, S.draft, p.svg, { draft: true });
  if (S.ghost && S.ghost.page === p.num) {
    const [a, b] = S.ghost.pts;
    svgEl('rect', { x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), width: Math.abs(a[0] - b[0]), height: Math.abs(a[1] - b[1]), fill: 'rgba(15,108,189,.06)', stroke: '#0f6cbd', 'stroke-dasharray': '4 3', 'pointer-events': 'none' }, p.svg);
  }
  if (S.tool === 'edit') ceDraw(p);
}
const redrawAll = () => S.pages.forEach(redrawPage);
/* ---- 複数選択（v3.1）: 選択範囲の枠・回転ハンドル・範囲選択の枠 */
const selOurs = () => S.annots.filter((a) => S.sel.has(a.id));
const selNatives = () => [...S.sel].filter((k) => k.startsWith('n:')).map((k) => S.nmap.get(k)).filter(Boolean);
function keyBBox(k) { if (k.startsWith('n:')) { const n = S.nmap.get(k); return n ? n.rect : null; } const a = S.annots.find((x) => x.id === k); return a ? annotBBox(a) : null; }
function keyPage(k) { if (k.startsWith('n:')) { const n = S.nmap.get(k); return n ? n.page : 0; } const a = S.annots.find((x) => x.id === k); return a ? a.page : 0; }
function groupBox(pageNum, oursOnly = false) {
  let b = null;
  for (const k of S.sel) {
    if (keyPage(k) !== pageNum || (oursOnly && k.startsWith('n:'))) continue;
    const q = keyBBox(k); if (!q) continue;
    b = b ? [Math.min(b[0], q[0]), Math.min(b[1], q[1]), Math.max(b[2], q[2]), Math.max(b[3], q[3])] : q.slice();
  }
  return b;
}
// 複数選択の枠・回転ハンドル・範囲選択の四角を描く
function drawGroupUi(p) {
  if (S.drag && S.drag.mode === 'amarq' && S.drag.p === p) {
    const [a, b] = [S.drag.xy0, S.drag.xy1];
    svgEl('rect', { x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), width: Math.abs(a[0] - b[0]), height: Math.abs(a[1] - b[1]), fill: 'rgba(15,108,189,.08)', stroke: '#0f6cbd', 'stroke-dasharray': '4 3', 'pointer-events': 'none' }, p.svg);
  }
  if (!isSelTool() || !S.sel.size || S.editing) return;
  if (S.sel.size > 1) {
    const gb = groupBox(p.num); if (!gb) return;
    const [x0, y0, x1, y1] = vbox(p.view, gb);
    svgEl('rect', { x: x0 - 4, y: y0 - 4, width: x1 - x0 + 8, height: y1 - y0 + 8, fill: 'none', stroke: '#0f6cbd', 'stroke-width': 1, 'stroke-dasharray': '6 3', 'pointer-events': 'none' }, p.svg);
    if (!(S.drag && (S.drag.mode === 'gmove' || S.drag.mode === 'rotate'))) {     // まとめて拡大縮小するハンドル（四隅＋各辺の中央）
      const C = [(gb[0] + gb[2]) / 2, (gb[1] + gb[3]) / 2];
      groupHandles(gb).forEach((pt, i) => {
        const [hx, hy] = vpt(p.view, pt), sq = i >= 4;
        const st = { fill: '#fff', stroke: '#0f6cbd', 'stroke-width': 2, class: 'gh', 'pointer-events': 'all' };
        const h = sq ? svgEl('rect', { x: hx - 4.5, y: hy - 4.5, width: 9, height: 9, ...st }, p.svg) : svgEl('circle', { cx: hx, cy: hy, r: 5.5, ...st }, p.svg);
        h.style.cursor = resizeCursor(p.view, C, [C[0] + Math.sign(pt[0] - C[0]), C[1] + Math.sign(pt[1] - C[1])]); h.dataset.gh = i;
      });
    }
  }
  const ob = groupBox(p.num, true); if (!ob) return;               // 回転ハンドル（自前の注釈があるとき）
  const [x0, y0, x1] = vbox(p.view, ob), cx = (x0 + x1) / 2, ty = y0 - 6;
  svgEl('line', { x1: cx, y1: ty, x2: cx, y2: ty - 18, stroke: '#0f6cbd', 'stroke-width': 1.5, 'pointer-events': 'none' }, p.svg);
  const h = svgEl('circle', { cx, cy: ty - 24, r: 7, fill: '#fff', stroke: '#0f6cbd', 'stroke-width': 2, class: 'roth', 'pointer-events': 'all' }, p.svg);
  h.dataset.rot = '1';
  const t = svgEl('title', {}, h); t.textContent = 'ドラッグで回転（Shiftで15°刻み）';
}
/** 複数選択の拡大縮小ハンドルの位置（PDF座標）: 0〜3 四隅、4〜7 辺の中央（下・右・上・左） */
function groupHandles(b) {
  const mx = (b[0] + b[2]) / 2, my = (b[1] + b[3]) / 2;
  return [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]], [mx, b[1]], [b[2], my], [mx, b[3]], [b[0], my]];
}
/** 注釈を、点 O を基準に横 sx・縦 sy 倍する（複数選択の拡大縮小） */
function scaleAnnot(a, o, O, sx, sy) {
  const f = (q) => [O[0] + (q[0] - O[0]) * sx, O[1] + (q[1] - O[1]) * sy];
  if (a.type === 'text') {
    const k = sx === 1 ? sy : sy === 1 ? sx : Math.sqrt(sx * sy);
    a.pts = [f(o.pts[0])];
    if (sy === 1) { a.w = Math.max(10, o.w * sx); delete a.autoW; }                     // 横の辺だけ: 幅だけ
    else { a.p.fontSize = clamp(Math.round(o.p.fontSize * k * 10) / 10, 4, 300); a.w = Math.max(10, o.w * k); }
    return;
  }
  if (isRectLike(a) && o.rot) {                                        // 回転している四角形など: 中心を移し、大きさを近似で変える
    const c = pivotOf(o), c2 = f(c), lb = localBox(o), hw = (lb[2] - lb[0]) / 2 * sx, hh = (lb[3] - lb[1]) / 2 * sy;
    a.pts = [[c2[0] - hw, c2[1] - hh], [c2[0] + hw, c2[1] + hh]]; return;
  }
  mapAnnot(a, o, f);
}
function startGroupScale(e, p, idx) {
  const gb = groupBox(p.num); if (!gb) return;
  const hs = groupHandles(gb), opp = [2, 3, 0, 1, 6, 7, 4, 5][idx];
  S.drag = { mode: 'gscale', p, idx, H: hs[idx], O: hs[opp], gb, snap: takeSnap(), sx: 1, sy: 1, moved: false,
    ours: selOurs().filter((a) => a.page === p.num).map((a) => ({ a, o: clone(a) })), nats: new Set(selNatives().filter((n) => n.page === p.num)) };
  e.preventDefault();
}
function gscaleRect(d, r) {
  const f = (x, y) => [d.O[0] + (x - d.O[0]) * d.sx, d.O[1] + (y - d.O[1]) * d.sy];
  const A = f(r[0], r[1]), B = f(r[2], r[3]);
  return [Math.min(A[0], B[0]), Math.min(A[1], B[1]), Math.max(A[0], B[0]), Math.max(A[1], B[1])];
}
async function finishGroupScale(d) {
  if (!d.moved) { redrawPage(d.p); return; }
  if (d.nats.size) {
    const ops = [...d.nats].map((n) => {
      const r = gscaleRect(d, n.rect);
      if (NATIVE_RESIZABLE.has(n.subtype)) return { type: 'resize', id: n.id, page: n.page, old: n.rect, rect: r };
      return { type: 'move', id: n.id, page: n.page, dx: (r[0] + r[2] - n.rect[0] - n.rect[2]) / 2, dy: (r[1] + r[3] - n.rect[1] - n.rect[3]) / 2 };
    });
    setBusy(true, '注釈の大きさを変更中…');
    try { await setBase(await nativeEdit(ops)); }
    catch (e) { console.error(e); toast('既存の注釈の大きさを変更できませんでした: ' + friendlyError(e), 6000); }
    finally { setBusy(false); }
  }
  commit(d.snap); redrawAll(); syncProps();
}
/* ---- 配置順（v3.6）: 最前面へ／前面へ／背面へ／最背面へ */
const Z_LABEL = { front: '最前面へ', forward: '前面へ', backward: '背面へ', back: '最背面へ' };
/** 選択したものを、配列の中で並べ替える（sel: 選択しているかの判定） */
function zReorder(arr, sel, mode) {
  const a = arr.slice();
  if (mode === 'front') return [...a.filter((x) => !sel(x)), ...a.filter(sel)];
  if (mode === 'back') return [...a.filter(sel), ...a.filter((x) => !sel(x))];
  if (mode === 'forward') { for (let i = a.length - 2; i >= 0; i--) if (sel(a[i]) && !sel(a[i + 1])) [a[i], a[i + 1]] = [a[i + 1], a[i]]; }
  else for (let i = 1; i < a.length; i++) if (sel(a[i]) && !sel(a[i - 1])) [a[i], a[i - 1]] = [a[i - 1], a[i]];
  return a;
}
async function annotZOrder(mode) {
  if (S.busy) return;
  const ours = selOurs(), nats = selNatives();
  if (!ours.length && !nats.length) return;
  const snap = takeSnap();
  const pages = new Set(ours.map((a) => a.page));
  for (const pg of pages) {                                  // 自前の注釈: 同じページの中で並べ替え
    const slots = [], list = [];
    S.annots.forEach((a, i) => { if (a.page === pg) { slots.push(i); list.push(a); } });
    const re = zReorder(list, (a) => S.sel.has(a.id), mode);
    slots.forEach((i, k) => { S.annots[i] = re[k]; });
  }
  if (nats.length) {                                        // 既存の注釈: PDFの注釈の並び（/Annots）を並べ替え
    const byPage = new Map();
    for (const n of nats) { if (!byPage.has(n.page)) byPage.set(n.page, []); byPage.get(n.page).push(n.id); }
    setBusy(true, '配置順を変更中…');
    try { await setBase(await nativeEdit([...byPage].map(([page, ids]) => ({ type: 'order', page, ids, mode })))); }
    catch (e) { console.error(e); toast('既存の注釈の配置順を変えられませんでした: ' + friendlyError(e), 6000); }
    finally { setBusy(false); }
  }
  redrawAll(); commit(snap); syncProps();
  toast(`${Z_LABEL[mode]}移動しました${ours.length && nats.length ? '（このツールで作った注釈は、他のソフトで作った注釈より常に前面に保存されます）' : ''}`, ours.length && nats.length ? 5000 : 1800);
}
function zOrder(mode) {
  if (S.tool === 'edit') { const ids = [...ce.sel]; if (ids.length) ceCommit(ids.map((id) => ({ id, z: mode })), '配置順を変更中…', { zSkip: true }); return; }
  if (S.sel.size) annotZOrder(mode);
}
/** 注釈を変換する（orig: 変換前の複製、f: 点の写像）。移動・拡大縮小に使う */
function mapAnnot(a, orig, f) {
  a.pts = orig.pts.map(f);
  if (orig.strokes) a.strokes = orig.strokes.map((st) => ({ ...st, pts: st.pts.map(f) }));
}
/** 注釈を点 C のまわりに deg 度（反時計回り）回す */
function rotateAnnot(a, orig, C, deg) {
  const R = (q) => rotPt(q, C, deg);
  if (a.type === 'line' || a.type === 'polyline' || a.type === 'polygon' || a.type === 'cloud' || a.type === 'ink') { mapAnnot(a, orig, R); return; }
  if (a.type === 'text') { a.pts = [R(orig.pts[0])]; a.rot = normDeg((orig.rot || 0) + deg); return; }
  const c = pivotOf(orig), c2 = R(c);
  a.pts = orig.pts.map((q) => [q[0] + c2[0] - c[0], q[1] + c2[1] - c[1]]);
  a.rot = normDeg((orig.rot || 0) + deg);
}
const isSelT = (t) => t === 'select' || t === 'asel';
const isSelTool = () => isSelT(S.tool);
function pruneSel() { for (const k of [...S.sel]) if (k.startsWith('n:') ? !S.nmap.has(k) : !S.annots.some((a) => a.id === k)) S.sel.delete(k); }
function toggleSel(k) {
  const s2 = new Set(S.sel); if (s2.has(k)) s2.delete(k); else s2.add(k);
  const pgs = new Set([...S.sel, ...s2].map(keyPage)); S.sel = s2;
  for (const n of pgs) if (S.pages[n - 1]) redrawPage(S.pages[n - 1]);
  syncProps(); updateButtons(); scheduleList();
}
async function deleteSelectedAnnots() {
  const keys = [...S.sel]; if (!keys.length || S.busy) return;
  if (keys.length === 1) return deleteByKey(keys[0]);
  const sn = takeSnap(), ours = new Set(keys.filter((k) => !k.startsWith('n:'))), nats = selNatives();
  S.annots = S.annots.filter((a) => !ours.has(a.id)); S.sel = new Set();
  if (nats.length) {
    setBusy(true, '注釈を削除中…');
    try { await setBase(await nativeEdit(nats.map((n) => ({ type: 'del', id: n.id, page: n.page })))); }
    catch (e) { console.error(e); toast('既存の注釈を削除できませんでした: ' + friendlyError(e), 6000); }
    finally { setBusy(false); }
  }
  redrawAll(); commit(sn); syncProps(); updateButtons();
  toast(`${keys.length}個の注釈を削除しました`);
}
const INKABLE = new Set(['line', 'rect', 'ellipse', 'polyline', 'polygon', 'cloud', 'ink']);
// 手書き注釈にまとめられる組み合わせか（同じページに、図形が2つ以上。既存の図形の注釈も含む）
function inkTargets() {
  const items = [...selOurs().filter((a) => INKABLE.has(a.type)), ...selNatives().filter((n) => NATIVE_SHAPES.has(n.subtype))];
  if (!items.length) return null;
  const page = items[0].page, list = items.filter((x) => x.page === page);
  return { page, ours: list.filter((x) => !x.key), nats: list.filter((x) => x.key), n: list.length };
}
const canMergeInk = () => { const t = inkTargets(); return !!t && t.n >= 2 && (!encLocked() || !t.nats.length) && S.lock.annot; };
/** 選択した図形の注釈を、1つの手書き（Ink）注釈にまとめる（v4.11: 既存の図形の注釈もまとめられる） */
async function convertToInk() {
  if (S.busy) return;
  const T = inkTargets();
  if (!T || T.n < 2) { toast('手書き注釈にまとめるには、同じページの図形（直線・四角形・丸・折れ線・多角形・雲形・手書き）を2つ以上選択してください'); return; }
  const { page } = T, list = T.ours;
  const skipped = S.sel.size - T.n;
  const strokes = [], sn = takeSnap();
  if (T.nats.length) {                     // 既存の注釈を図形として読み、元のPDFからは削除する
    setBusy(true, '既存の注釈をまとめています…');
    try {
      const doc = await baseDoc(), shapes = [];
      for (const n of T.nats) { const d = doc.context.lookupMaybe(refFromId(n.id), PDFDict), sh = d && nativeShape(doc, d); if (sh) shapes.push(sh); }
      for (const a of shapes) {
        const op = (a.p.opacity ?? 100) / 100;
        for (const pr of shapePrims(a)) {
          const st = primStyle(a, pr);
          strokes.push({ pts: flattenPrim(pr), closed: !!(pr.closed || pr.k === 'circle'), color: st.color, width: st.width, fill: pr.fill && st.fill ? st.fill : null, dash: st.dash, op: (st.op ?? 1) * op });
        }
      }
      await setBase(await nativeEdit(T.nats.map((n) => ({ type: 'del', id: n.id, page: n.page }))));
    } catch (e) { console.error(e); toast('既存の注釈をまとめられませんでした: ' + friendlyError(e), 6000); return; }
    finally { setBusy(false); }
  }
  for (const a of list) {
    const op = (a.p.opacity ?? 100) / 100;
    if (a.type === 'ink') { for (const st of a.strokes) strokes.push({ ...st, pts: st.pts.map((q) => q.slice()), op: (st.op ?? 1) * op }); continue; }
    for (const pr of shapePrims(a)) {
      const st = primStyle(a, pr);
      strokes.push({ pts: flattenPrim(pr), closed: !!(pr.closed || pr.k === 'circle'), color: st.color, width: st.width, fill: pr.fill && st.fill ? st.fill : null, dash: st.dash, op });
    }
  }
  if (!strokes.length) return;
  const idx = list.length ? S.annots.findIndex((a) => a === list[0]) : S.annots.length;
  const ink = { id: newId(), type: 'ink', page, pts: [], strokes, author: S.author, date: new Date().toISOString(),
    p: { ...DEFAULTS, color: strokes[0].color, width: strokes[0].width, opacity: 100 } };
  const dead = new Set(list.map((a) => a.id));
  S.annots = S.annots.filter((a) => !dead.has(a.id));
  S.annots.splice(Math.min(idx, S.annots.length), 0, ink);
  S.sel = new Set([ink.id]);
  redrawPage(S.pages[page - 1]); commit(sn); syncProps(); updateButtons();
  toast(`${T.n}個の図形を1つの手書き注釈にまとめました${skipped > 0 ? `（テキスト・スタンプ・別ページなど${skipped}個は対象外）` : ''}`, 5000);
}
/* ------------------------------------------------------- 履歴 (undo / redo) */
const takeSnap = () => ({ a: JSON.stringify(S.annots), b: S.baseBytes });
function trimUndo() {
  const mem = (b) => (!b ? 0 : isLazy(b) && !b.pinned ? 0 : b.length);       // ファイルから読む版は、メモリを使わない
  const seen = new Set(); let tot = mem(S.baseBytes); seen.add(S.baseBytes);
  for (let i = S.undo.length - 1; i >= 0; i--) {
    const b = S.undo[i].b;
    if (!seen.has(b)) { seen.add(b); tot += mem(b); }
    if (tot > 300e6 && i > 0) { S.undo.splice(0, i); break; }
  }
}
function commit(prev) {
  const cur = JSON.stringify(S.annots);
  if (cur !== prev.a || S.baseBytes !== prev.b) {
    S.undo.push(prev); if (S.undo.length > 60) S.undo.shift(); S.redo = []; S.dirty = true; trimUndo();
  }
  updateButtons(); scheduleList();
}
async function restoreSnap(sn) {
  S.annots = JSON.parse(sn.a); S.dirty = true;
  if (sn.b !== S.baseBytes) {
    setBusy(true, '元に戻しています…');
    try { await setBase(sn.b); probeLib(sn.b, S.loadGen); } catch (e) { console.error(e); toast('元に戻せませんでした: ' + e.message, 5000); } finally { setBusy(false); }
  }
  pruneSel();
  redrawAll(); syncProps(); updateButtons(); scheduleList();
}
async function undo() { if (S.busy || !S.undo.length) return; const cur = takeSnap(); const sn = S.undo.pop(); S.redo.push(cur); await restoreSnap(sn); }
async function redo() { if (S.busy || !S.redo.length) return; const cur = takeSnap(); const sn = S.redo.pop(); S.undo.push(cur); await restoreSnap(sn); }
function updateButtons() {
  $('#btnUndo').disabled = !S.undo.length; $('#btnRedo').disabled = !S.redo.length;
  $('#btnDelete').disabled = !(S.sel.size || (S.tool === 'edit' && ce.sel.size));
  for (const id of ['#btnDocProps', '#btnPrint', '#btnEmbed', '#btnRotL', '#btnRotR', '#btnSave', '#btnSaveAs', '#btnStamp', '#btnDateStamp', '#btnDateStampCfg', '#btnPages', '#btnOrg', '#btnFind']) $(id).disabled = !S.pdf;
  // 編集ロック: 使えない機能はグレーアウトし、理由をツールチップに出す
  const enc = !!S.pdf && encLocked(), noAnnot = !!S.pdf && !S.lock.annot, noPrint = !!S.pdf && !S.lock.print;
  const lockEl = (el, off, why) => {
    if (!el) return;
    if (el.dataset.title0 === undefined) el.dataset.title0 = el.title || '';
    if (off) el.disabled = true;
    el.classList.toggle('locked', off);
    el.title = off ? `${why}\n（左の「文書プロパティ」で編集ロックを解除すると使えます）` : el.dataset.title0;
  };
  const ENC = 'このPDFは編集ロック（暗号化）がかかっているため使えません', ANN = 'このPDFは文書の設定で注釈の追加が禁止されているため使えません';
  document.querySelectorAll('.tool').forEach((b) => { b.disabled = false; });
  for (const id of ['#bmAdd', '#bmRename', '#bmDel']) $(id).disabled = false;
  for (const id of ['#btnRotL', '#btnRotR', '#btnPages', '#btnOrg', '#btnEmbed']) lockEl($(id), enc, ENC);
  lockEl(document.querySelector('.tool[data-tool="edit"]'), enc, ENC);
  document.querySelectorAll('.tool').forEach((b) => { if (!['select', 'asel', 'edit'].includes(b.dataset.tool)) lockEl(b, noAnnot, ANN); });
  for (const id of ['#btnStamp', '#btnDateStamp', '#btnDateStampCfg']) lockEl($(id), noAnnot, ANN);
  lockEl($('#btnPrint'), noPrint, 'このPDFは文書の設定で印刷が禁止されているため使えません');
  for (const id of ['#bmAdd', '#bmRename', '#bmDel']) lockEl($(id), enc || !S.pdf, enc ? ENC : 'PDFを開いてください');
  if (S.pdf && !enc) { $('#bmAdd').disabled = false; $('#bmRename').disabled = $('#bmDel').disabled = !S.bmSel; }
}
/* ------------------------------------------------------- 選択 / プロパティ */
const selAnnot = () => S.annots.find((a) => a.id === S.selId) || null;
const selNative = () => (S.selId && S.selId.startsWith('n:') ? S.nmap.get(S.selId) || null : null);
function pageOfKey(k) {
  if (!k) return null;
  if (k.startsWith('n:')) { const n = S.nmap.get(k); return n ? S.pages[n.page - 1] : null; }
  const a = S.annots.find((x) => x.id === k); return a ? pageOf(a) : null;
}
function select(id) {
  const olds = [...S.sel]; S.selId = id;
  for (const k of new Set([...olds, id])) { const pg = pageOfKey(k); if (pg) redrawPage(pg); }
  syncProps(); updateButtons(); scheduleList();
}
const curDefaults = () => (S.tool === 'text' ? S.textDefaults : S.defaults);
const P = { start: $('#pStart'), end: $('#pEnd'), style: $('#pStyle'), width: $('#pWidth'), color: $('#pColor'), fill: $('#pFill'),
  opacity: $('#pOpacity'), opacityNum: $('#pOpacityNum'), font: $('#pFontSize'), intensity: $('#pCloud'), radius: $('#pRadius'),
  startSize: $('#pStartSize'), endSize: $('#pEndSize'), face: $('#pFontFace') };
/** 始点・終点の大きさ欄: 「なし」のときは隠す */
function syncEndSize(p) {
  P.startSize.value = p.startSize ?? 100; P.endSize.value = p.endSize ?? 100;
  P.startSize.disabled = P.start.disabled; P.endSize.disabled = P.end.disabled;
  $('#rowStartSz').style.visibility = !P.start.disabled && P.start.value !== 'None' ? 'visible' : 'hidden';
  $('#rowEndSz').style.visibility = !P.end.disabled && P.end.value !== 'None' ? 'visible' : 'hidden';
}
const CAPS = {
  line: ['start', 'end', 'style', 'width', 'color', 'fill', 'opacity'], polyline: ['start', 'end', 'style', 'width', 'color', 'fill', 'opacity', 'radius'],
  polygon: ['style', 'width', 'color', 'fill', 'opacity'],
  cloud: ['style', 'width', 'color', 'fill', 'opacity', 'intensity'], ink: ['width', 'color', 'opacity'],
  rect: ['style', 'width', 'color', 'fill', 'opacity', 'radius'], ellipse: ['style', 'width', 'color', 'fill', 'opacity'], text: ['width', 'color', 'fill', 'opacity', 'font', 'face'],
  stamp: ['opacity'], native: [], none: ['start', 'end', 'style', 'width', 'color', 'fill', 'opacity'],
};
function syncZBox() { $('#zBox').style.display = (S.tool === 'edit' ? ce.sel.size : (isSelTool() && S.sel.size)) ? '' : 'none'; }
// 右のプロパティ欄を、今の選択（注釈・内容の編集の対象・描画ツールの既定値）に合わせる
function syncProps() {
  $('#ceBox').style.display = 'none'; $('#multiBox').style.display = 'none'; $('#rowRadius').style.display = 'none';
  syncZBox();
  if (S.tool === 'edit') { ceSyncProps(); return; }
  if (S.sel.size > 1) { syncMultiProps(); return; }
  const a = selAnnot(), nat = selNative();
  if (nat) loadNativeProps([nat]);
  const kind = a ? a.type : nat ? 'native' : (S.tool === 'select' ? null : S.tool);
  const p = a ? a.p : nat ? { ...S.defaults, ...S.textDefaults, ...(nat.props || {}) } : curDefaults();
  let title;
  if (a) title = `選択中: ${OURS_LABEL[a.type]}`;
  else if (nat) title = `選択中: 既存の注釈（${NATIVE_LABEL[nat.subtype] || nat.subtype}）`;
  else if (S.tool === 'select') title = '新規描画の既定値';
  else title = `新規描画: ${OURS_LABEL[S.tool] || ''}`;
  $('#propTarget').textContent = title; $('#propTarget').classList.toggle('sel', !!(a || nat));
  P.start.value = p.start; P.end.value = p.end; P.style.value = p.style;
  P.width.value = p.width; P.color.value = p.color;
  P.fill.value = p.fill || '#ffffff'; P.fill.classList.toggle('none', !p.fill);
  P.opacity.value = p.opacity; P.opacityNum.value = p.opacity;
  P.font.value = p.fontSize || S.textDefaults.fontSize; P.face.value = FACES[p.face] ? p.face : 'gothic';
  P.intensity.value = String(p.intensity || 1);
  P.radius.value = p.radius || 0;
  const caps = new Set(nat ? (nat.props ? nativeCaps(nat) : []) : CAPS[kind || 'none']);
  $('#rowRadius').style.display = caps.has('radius') ? '' : 'none';
  for (const k of Object.keys(P)) P[k].disabled = !caps.has(k);
  P.opacityNum.disabled = !caps.has('opacity');
  $('#pFillNone').disabled = !caps.has('fill');
  syncEndSize(p);
  const textLike = kind === 'text' || (nat && nat.subtype === 'FreeText');
  $('#rowFont').style.display = kind === 'text' || caps.has('font') ? '' : 'none';
  P.face.style.display = $('label[for="pFontFace"]').style.display = nat ? 'none' : '';    // 既存のテキストボックスの書体は変えられない
  $('#rowCloud').style.display = kind === 'cloud' || caps.has('intensity') ? '' : 'none';
  $('#lblColor').textContent = textLike ? '文字の色(O) :' : '色(O) :';
  $('#lblWidth').textContent = textLike ? '枠線の太さ(T) :' : '太さ(T) :';
  P.width.min = textLike ? '0' : '0.25';
  $('#natBox').style.display = nat ? '' : 'none';
  $('#hintEnds').textContent = nat
    ? (NATIVE_VERTEX.has(nat.subtype) ? `※ドラッグで移動／頂点のハンドルをドラッグで形を変更${nat.subtype === 'Line' ? '' : '・辺をダブルクリックで頂点を追加・Alt+クリックで頂点を削除'}／Enterで内容を編集`
      : NATIVE_RESIZABLE.has(nat.subtype) ? '※ドラッグで移動／四角のハンドルでサイズ変更／ダブルクリックで内容を編集' : '※ドラッグで移動／ダブルクリックで内容を編集（この種類はサイズ変更できません）')
    : kind === 'rect' ? '※四角形には始点/終点はありません'
      : kind === 'ellipse' ? '※ドラッグで楕円（Shiftで正円）。四角のハンドルで大きさを変更'
      : kind === 'cloud' ? '※クリックで頂点を追加、ダブルクリック/Enterで閉じて確定。ドラッグすると四角形の雲になります'
      : kind === 'polygon' ? '※クリックで頂点を追加、ダブルクリック/Enter/Escで閉じて確定。選択中は、頂点をドラッグ／辺をダブルクリックで頂点を追加／Alt+クリックで頂点を削除'
        : kind === 'text' ? '※ダブルクリックまたはEnterで文字を編集'
          : kind === 'stamp' ? '※四角のハンドルで拡大縮小（Shiftで縦横比を解除）' : '';
}
const CAPKEY = { fontSize: 'font', startSize: 'start', endSize: 'end' };
function setAnnotProp(a, key, value) {
  a.p[key] = value;
  if (a.type === 'text' && (key === 'fontSize' || key === 'face')) fitTextW(a);
  if (a.type === 'ink' && (key === 'color' || key === 'width')) a.strokes = a.strokes.map((st) => ({ ...st, [key]: value }));
}
function applyProp(key, value) {
  if (S.tool === 'edit') { if (ce.sel.size) ce.pend[key] = value; return; }
  const cap = CAPKEY[key] || key;
  if (S.sel.size > 1) {
    pendNative(selNatives(), key, value);
    const list = selOurs().filter((a) => (CAPS[a.type] || []).includes(cap)); if (!list.length) return;
    if (!S.propSnap) S.propSnap = takeSnap();
    for (const a of list) setAnnotProp(a, key, value);
    redrawAll(); S.dirty = true; return;
  }
  const a = selAnnot(), nat = selNative();
  if (a) {
    if (!S.propSnap) S.propSnap = takeSnap();
    setAnnotProp(a, key, value); redrawPage(pageOf(a)); S.dirty = true;
  } else if (nat) pendNative([nat], key, value);
  else curDefaults()[key] = value;
}
// 既存の注釈のプロパティの変更は、確定したとき（endPropEdit）にまとめてPDFに反映する（スライダーを動かしている間は貯めておく）
function pendNative(list, key, value) {
  const cap = CAPKEY[key] || key;
  for (const n of list) {
    if (!n.props || !nativeCaps(n).includes(cap) || (key === 'face')) continue;
    if (!S.natPend) S.natPend = new Map();
    const e = S.natPend.get(n.key) || { n, props: {} }; e.props[key] = value; n.props[key] = value; S.natPend.set(n.key, e);
  }
}
/** 複数選択中のプロパティ欄 */
function syncMultiProps() {
  const ours = selOurs(), nats = selNatives();
  loadNativeProps(nats);
  $('#propTarget').textContent = `選択中: ${S.sel.size}個の注釈${nats.length ? `（既存${nats.length}個を含む）` : ''}`; $('#propTarget').classList.add('sel');
  const caps = new Set([...ours.flatMap((a) => CAPS[a.type] || []), ...nats.flatMap((n) => (n.props ? nativeCaps(n) : []))]);
  const nat0 = nats.find((n) => n.props && nativeCaps(n).length);
  const p = (ours.find((a) => a.type !== 'stamp') || ours[0] || { p: nat0 ? { ...S.defaults, ...nat0.props } : S.defaults }).p;
  P.start.value = p.start || 'None'; P.end.value = p.end || 'None'; P.style.value = p.style || 'solid';
  P.width.value = p.width ?? 1; P.color.value = p.color || '#000000';
  P.fill.value = p.fill || '#ffffff'; P.fill.classList.toggle('none', !p.fill);
  P.opacity.value = p.opacity ?? 100; P.opacityNum.value = p.opacity ?? 100;
  P.font.value = p.fontSize || S.textDefaults.fontSize; P.intensity.value = String(p.intensity || 1); P.radius.value = p.radius || 0;
  for (const k of Object.keys(P)) P[k].disabled = !caps.has(k);
  P.opacityNum.disabled = !caps.has('opacity'); $('#pFillNone').disabled = !caps.has('fill');
  syncEndSize(p);
  $('#rowFont').style.display = caps.has('font') ? '' : 'none';
  $('#rowCloud').style.display = caps.has('intensity') ? '' : 'none';
  $('#rowRadius').style.display = caps.has('radius') ? '' : 'none';
  $('#lblColor').textContent = '色(O) :'; $('#lblWidth').textContent = '太さ(T) :';
  $('#natBox').style.display = 'none';
  $('#multiBox').style.display = '';
  $('#btnToInk').disabled = !canMergeInk();
  $('#hintEnds').textContent = '※ドラッグでまとめて移動／上の丸いハンドルで回転（Shiftで15°刻み）／Deleteで削除／Shift+クリックで追加・解除／Ctrl+Gで1つの手書き注釈に';
}
// プロパティ欄での変更を確定し、元に戻す履歴に1回分として積む
function endPropEdit() {
  if (S.tool === 'edit') { ceApplyPending(); return; }
  if (S.propSnap) {
    const cur = JSON.stringify(S.annots);
    if (cur !== S.propSnap.a) { S.undo.push(S.propSnap); S.redo = []; S.dirty = true; }
    S.propSnap = null; updateButtons(); scheduleList();
  }
  if (S.natPend && S.natPend.size) {
    const ops = [...S.natPend.values()].map(({ n, props }) => ({ type: 'props', id: n.id, page: n.page, props }));
    S.natPend = null;
    nativeOp(ops, '既存の注釈を変更中…');
  }
}
const numIn = (el, lo, hi, dflt) => { const v = parseFloat(el.value); return Number.isFinite(v) ? clamp(v, lo, hi) : dflt; };
const minW = () => (S.tool === 'edit' || selAnnot()?.type === 'text' || (!selAnnot() && S.tool === 'text') ? 0 : 0.25);
P.start.addEventListener('change', () => { applyProp('start', P.start.value); endPropEdit(); if (S.tool !== 'edit') syncEndSize(((S.sel.size > 1 ? selOurs()[0] : selAnnot()) || { p: curDefaults() }).p); });
P.end.addEventListener('change', () => { applyProp('end', P.end.value); endPropEdit(); if (S.tool !== 'edit') syncEndSize(((S.sel.size > 1 ? selOurs()[0] : selAnnot()) || { p: curDefaults() }).p); });
for (const [k, el] of [['startSize', P.startSize], ['endSize', P.endSize]]) {
  el.addEventListener('input', () => { const v = parseFloat(el.value); if (Number.isFinite(v) && v >= 10) applyProp(k, clamp(v, 10, 1000)); });
  el.addEventListener('change', () => { applyProp(k, numIn(el, 10, 1000, 100)); endPropEdit(); });
}
P.style.addEventListener('change', () => { applyProp('style', P.style.value); endPropEdit(); });
P.intensity.addEventListener('change', () => { applyProp('intensity', +P.intensity.value); endPropEdit(); });
P.width.addEventListener('input', () => { const v = parseFloat(P.width.value); if (Number.isFinite(v) && v >= minW()) applyProp('width', clamp(v, minW(), 100)); });
P.width.addEventListener('change', () => { applyProp('width', numIn(P.width, minW(), 100, 1)); if (S.tool !== 'edit') P.width.value = (selAnnot() || { p: curDefaults() }).p.width; endPropEdit(); });
P.color.addEventListener('input', () => applyProp('color', P.color.value));
P.color.addEventListener('change', endPropEdit);
P.fill.addEventListener('input', () => { P.fill.classList.remove('none'); applyProp('fill', P.fill.value); });
P.fill.addEventListener('change', endPropEdit);
$('#pFillNone').addEventListener('click', () => { P.fill.classList.add('none'); applyProp('fill', null); endPropEdit(); });
P.opacity.addEventListener('input', () => { P.opacityNum.value = P.opacity.value; applyProp('opacity', +P.opacity.value); });
P.opacity.addEventListener('change', endPropEdit);
P.opacityNum.addEventListener('input', () => { const v = parseFloat(P.opacityNum.value); if (Number.isFinite(v)) { const c = clamp(v, 0, 100); P.opacity.value = c; applyProp('opacity', c); } });
P.opacityNum.addEventListener('change', () => { const c = numIn(P.opacityNum, 0, 100, 100); P.opacityNum.value = c; P.opacity.value = c; applyProp('opacity', c); endPropEdit(); });
P.font.addEventListener('input', () => { const v = parseFloat(P.font.value); if (Number.isFinite(v) && v >= 4) applyProp('fontSize', clamp(v, 4, 300)); });
P.radius.addEventListener('input', () => { const v = parseFloat(P.radius.value); if (Number.isFinite(v) && v >= 0) applyProp('radius', clamp(v, 0, 500)); });
P.radius.addEventListener('change', () => { applyProp('radius', numIn(P.radius, 0, 500, 0)); endPropEdit(); });
P.face.addEventListener('change', () => { applyProp('face', P.face.value); endPropEdit(); });
P.font.addEventListener('change', () => { applyProp('fontSize', numIn(P.font, 4, 300, 12)); if (S.tool !== 'edit') P.font.value = (selAnnot() || { p: curDefaults() }).p.fontSize; endPropEdit(); });
/* ------------------------------------------------------------ 追加 / 削除 */
function addAnnot(a, opts = {}) {
  const snap = takeSnap();
  if (!a.author) a.author = S.author;
  if (!a.date) a.date = new Date().toISOString();
  S.annots.push(a); commit(snap);
  const pin = $('#chkPin').checked && ['line', 'rect', 'ellipse', 'polyline', 'polygon', 'cloud'].includes(a.type) && !opts.forceSelect;
  if (pin) { S.selId = null; redrawPage(pageOf(a)); syncProps(); }
  else { S.selId = a.id; redrawPage(pageOf(a)); setTool('select'); }
  scheduleList();
}
async function nativeOp(op, msg, { keepSel = true } = {}) {
  if (S.busy) return false;
  if (encLocked()) { toast('このPDFは編集ロック（暗号化）がかかっているため、既存の注釈やしおりは変更できません。左の「文書プロパティ」でロックを解除できます。', 6000); return false; }
  const sn = takeSnap(), sel = new Set(S.sel); setBusy(true, msg);
  try {
    const bytes = await nativeEdit(Array.isArray(op) ? op : [op]);
    S.sel = keepSel ? sel : new Set();
    await setBase(bytes); commit(sn); return true;
  } catch (e) { console.error(e); toast('操作できませんでした: ' + friendlyError(e), 6000); redrawAll(); return false; }
  finally { setBusy(false); }
}
const deleteNative = (key) => { const n = S.nmap.get(key); return n ? nativeOp({ type: 'del', id: n.id, page: n.page }, '注釈を削除中…', { keepSel: false }) : null; };
const moveNative = (n, dx, dy) => nativeOp({ type: 'move', id: n.id, page: n.page, dx, dy }, '注釈を移動中…');
const vertsNative = (n, pts, dup) => nativeOp({ type: 'verts', id: n.id, page: n.page, pts, dup }, '頂点を変更中…');
const resizeNative = (n, rect) => nativeOp({ type: 'resize', id: n.id, page: n.page, old: n.rect, rect }, '注釈のサイズを変更中…');
async function editNativeContents(key) {
  const n = S.nmap.get(key); if (!n || S.busy) return;
  const r = await dialog({
    title: `コメントの編集（${NATIVE_LABEL[n.subtype] || n.subtype} / p.${n.page}${n.author ? ' / ' + n.author : ''}）`, ok: '更新',
    html: '<textarea id="ncText" rows="7" style="width:460px;max-width:80vw"></textarea><p class="small">Ctrl+Enterで更新します。</p>',
    init: (d) => {
      const t = d.querySelector('#ncText'); t.value = n.contents || '';
      t.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); d.querySelector('form').requestSubmit(); } });
      setTimeout(() => { t.focus(); t.setSelectionRange(t.value.length, t.value.length); }, 0);
    },
    validate: (d) => ({ text: d.querySelector('#ncText').value }),
  });
  if (!r || r.text === (n.contents || '')) return;
  if (await nativeOp({ type: 'contents', id: n.id, page: n.page, text: r.text }, 'コメントを更新中…')) toast('コメントを更新しました');
}
$('#btnEditNat').addEventListener('click', () => { const n = selNative(); if (n) editNativeContents(n.key); });
async function deleteByKey(key) {
  if (key.startsWith('n:')) return deleteNative(key);
  const a = S.annots.find((x) => x.id === key); if (!a) return;
  const snap = takeSnap();
  S.annots = S.annots.filter((x) => x.id !== key); S.sel.delete(key);
  redrawPage(pageOf(a)); commit(snap); syncProps();
}
const deleteSelected = () => (S.tool === 'edit' ? ceDelete() : S.sel.size ? deleteSelectedAnnots() : undefined);
/* ------------------------------------------------------------ ツール */
function setTool(t) {
  const tb = document.querySelector(`.tool[data-tool="${t}"]`);
  if (tb && tb.disabled && S.pdf) { toast(tb.title.split('\n')[0], 4000); return; }      // 編集ロックで使えないツール（キー操作で選ばれた場合も）
  if (S.draft) finishPoly();
  if (S.editing) endEdit(true);
  const prev = S.tool;
  if (prev === 'edit' && t !== 'edit') ceLeave();
  S.tool = t;
  document.body.className = (S.paged ? 'paged ' : '') + (document.body.classList.contains('gam') ? 'gam ' : '') + (document.body.classList.contains('pgbar-on') ? 'pgbar-on ' : '') + 'tool-' + t;
  document.querySelectorAll('.tool').forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
  if (!isSelT(t) && S.sel.size) { const pgs = new Set([...S.sel].map(keyPage)); S.sel = new Set(); for (const n of pgs) if (S.pages[n - 1]) redrawPage(S.pages[n - 1]); }
  if (prev !== t && (isSelT(prev) || isSelT(t))) for (const pg of S.pages) redrawPage(pg);
  if (prev === 'edit' || t === 'edit') { redrawAll(); for (const p of S.pages) p.el.style.cursor = ''; }
  syncProps(); updateButtons(); scheduleList();
  if (t === 'edit' && prev !== 'edit') ceEnter();
}
document.querySelectorAll('.tool').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
/* ---------------------------------------------------- ポインタ操作 */
const pgOf = (target) => { const el = target.closest && target.closest('.pg'); return el ? S.pages[+el.dataset.num - 1] : null; };
function evXY(e, p) { const r = p.el.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
const toPdf = (p, xy) => p.view.convertToPdfPoint(xy[0], xy[1]);
const toVp = (p, pt) => p.view.convertToViewportPoint(pt[0], pt[1]);
function snap45(from, to) {
  const dx = to[0] - from[0], dy = to[1] - from[1], len = Math.hypot(dx, dy);
  const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  return [from[0] + len * Math.cos(ang), from[1] + len * Math.sin(ang)];
}
// Shift を押しながらの描画: ドラッグ先を正方形（正円）になる位置に合わせる
function squareOf(from, to) {
  const dx = to[0] - from[0], dy = to[1] - from[1], s = Math.max(Math.abs(dx), Math.abs(dy));
  return [from[0] + Math.sign(dx || 1) * s, from[1] + Math.sign(dy || 1) * s];
}
const RECT_H = [[0, 0], [1, 0], [1, 1], [0, 1]];
let lastDown = null;
pagesEl.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || !S.pdf || S.busy) return;
  if (e.target.tagName === 'TEXTAREA') return;
  if (S.editing) endEdit(true);
  if (S.tool === 'edit') { ceDown(e); return; }
  const p = pgOf(e.target);
  // v3.2: 描画ツールでも、注釈の上（移動カーソルの出る所）をクリックしたら「選択」に切り替えて選ぶ。Ctrlを押しながらなら描く
  if (!isSelTool() && !e.ctrlKey && !S.draft) {
    const hitEl = e.target.closest && e.target.closest('.hit[data-id]');
    if (hitEl && S.annots.some((a) => a.id === hitEl.dataset.id)) setTool('select');
  }
  if (isSelTool()) {
    const rEl = e.target.closest && e.target.closest('[data-rot]');
    if (rEl && p && p.view) { startRotate(e, p); return; }
    const ghEl = e.target.closest && e.target.closest('[data-gh]');
    if (ghEl && p && p.view) { startGroupScale(e, p, +ghEl.dataset.gh); return; }
    const hEl = e.target.closest && e.target.closest('[data-h]');
    const nhEl = e.target.closest && e.target.closest('[data-nh]');
    const nvEl = e.target.closest && e.target.closest('[data-nv]');
    const aEl = e.target.closest && e.target.closest('[data-id]');
    const nEl = e.target.closest && e.target.closest('[data-nid]');
    if (hEl) {
      const a = S.annots.find((x) => x.id === hEl.dataset.id); if (!a) return;
      const idx = +hEl.dataset.h;
      if (e.altKey && isMulti(a.type) && a.pts.length > minPts(a.type)) {
        const snap = takeSnap(); a.pts.splice(idx, 1); redrawPage(pageOf(a)); commit(snap); e.preventDefault(); return;
      }
      const bb = isRectLike(a) ? localBox(a) : annotBBox(a), hp = handlePoints(a);
      S.drag = { mode: 'handle', a, idx, snap: takeSnap(), p: pageOf(a), ar: (bb[2] - bb[0]) / Math.max(bb[3] - bb[1], 1e-6),
        O: isRectLike(a) || a.type === 'ink' ? hp[(idx + 2) % 4].slice() : null, H: hp[idx].slice(), origA: clone(a) };
      e.preventDefault();
    } else if (nvEl) {
      const n = S.nmap.get(nvEl.dataset.nid), np = n && nativePts(n); if (!np) return;
      const idx = +nvEl.dataset.nv;
      e.preventDefault();
      if (e.altKey) {          // Alt+クリック: 頂点を削除（直線は2点のまま）
        if (n.subtype !== 'Line' && np.pts.length > nativeMinPts(n)) { np.pts.splice(idx, 1); vertsNative(n, np.pts, np.dup); }
        return;
      }
      S.drag = { mode: 'nvert', n, p: pageOf(n), idx, pts: np.pts, dup: np.dup, moved: false };
    } else if (nhEl) {
      const n = S.nmap.get(nhEl.dataset.nid); if (!n) return;
      const pg = pageOf(n), i = +nhEl.dataset.nh, [x0, y0, x1, y1] = vbox(pg.view, n.rect);
      const corners = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
      S.drag = { mode: 'nresize', n, p: pg, O: corners[(i + 2) % 4], ar: (x1 - x0) / Math.max(y1 - y0, 1e-6), lockAr: n.subtype === 'Stamp', vr: [x0, y0, x1, y1] };
      e.preventDefault();
    } else if (aEl) {
      const a = S.annots.find((x) => x.id === aEl.dataset.id); if (!a) return;
      // Shift/Ctrl+クリック: 選択に追加・解除。選択済みのものは、動かさずに離したときだけ解除（Shift+ドラッグは上下左右の移動）
      let tog = null;
      if (e.shiftKey || e.ctrlKey) { if (S.sel.has(a.id)) tog = a.id; else toggleSel(a.id); }
      if (S.sel.has(a.id) && S.sel.size > 1) { startGroupMove(e, pageOf(a)); S.drag.toggle = tog; return; }
      if (S.selId !== a.id) select(a.id);
      S.drag = { mode: 'move', a, p: pageOf(a), start: toPdf(pageOf(a), evXY(e, pageOf(a))), orig: clone(a.pts), origA: clone(a), snap: takeSnap(), toggle: tog };
      e.preventDefault();
    } else if (nEl) {
      const n = S.nmap.get(nEl.dataset.nid); if (!n) return;
      let tog = null;
      if (e.shiftKey || e.ctrlKey) { if (S.sel.has(n.key)) tog = n.key; else toggleSel(n.key); }
      if (S.sel.has(n.key) && S.sel.size > 1) { startGroupMove(e, pageOf(n)); S.drag.toggle = tog; return; }
      if (S.selId !== n.key) select(n.key);
      const pg = pageOf(n);
      S.drag = { mode: 'nmove', n, p: pg, start: toPdf(pg, evXY(e, pg)), d: [0, 0], moved: false, toggle: tog };
      e.preventDefault();
    } else {
      if (!e.shiftKey && !e.ctrlKey && S.sel.size) select(null);
      if (S.tool === 'asel' && p && p.view) { const xy = evXY(e, p); S.drag = { mode: 'amarq', p, xy0: xy, xy1: xy.slice(), add: e.shiftKey || e.ctrlKey }; e.preventDefault(); }
    }
    return;
  }
  if (!p || !p.view) return;
  e.preventDefault();
  const xy = evXY(e, p);
  if (S.tool === 'text') { S.drag = { mode: 'tdraw', p }; S.ghost = { page: p.num, pts: [xy, xy.slice()] }; return; }
  if (isMulti(S.tool)) {
    if (S.draft && S.draft.page !== p.num) finishPoly();
    const cxy = e.shiftKey && S.draft && S.draft.pts.length >= 2 ? snap45(toVp(p, S.draft.pts[S.draft.pts.length - 2]), xy) : xy;
    const pt = toPdf(p, cxy);
    if (!S.draft) {
      S.draft = { id: newId(), type: S.tool, page: p.num, pts: [pt, pt.slice()], p: { ...S.defaults } }; lastDown = { t: performance.now(), xy };
      if (S.tool === 'cloud') S.drag = { mode: 'cdrag', p, startXY: xy, moved: false };
    } else {
      const now = performance.now(), dbl = lastDown && now - lastDown.t < 450 && Math.hypot(xy[0] - lastDown.xy[0], xy[1] - lastDown.xy[1]) < 6;
      lastDown = { t: now, xy };
      if (dbl) { finishPoly(); return; }
      S.draft.pts[S.draft.pts.length - 1] = pt; S.draft.pts.push(pt.slice());
    }
    redrawPage(p); return;
  }
  const pt = toPdf(p, xy);
  S.draft = { id: newId(), type: S.tool, page: p.num, pts: [pt, pt.slice()], p: { ...S.defaults } };
  S.drag = { mode: 'draw', p, startXY: xy };
});
window.addEventListener('pointermove', (e) => {
  const d = S.drag;
  if (d) {
    const p = d.p; const xy = evXY(e, p);
    if (d.mode === 'draw') {
      let c = xy;
      if (e.shiftKey) c = (S.draft.type === 'rect' || S.draft.type === 'ellipse') ? squareOf(d.startXY, xy) : snap45(d.startXY, xy);
      S.draft.pts[1] = toPdf(p, c); redrawPage(p);
    } else if (d.mode === 'cdrag') {
      if (!d.moved && Math.hypot(xy[0] - d.startXY[0], xy[1] - d.startXY[1]) > 6) d.moved = true;
      if (d.moved) {
        const a0 = d.startXY, a1 = e.shiftKey ? squareOf(a0, xy) : xy;
        S.draft.pts = [[a0[0], a0[1]], [a1[0], a0[1]], [a1[0], a1[1]], [a0[0], a1[1]]].map((q) => toPdf(p, q)); redrawPage(p);
      }
    } else if (d.mode === 'tdraw') { S.ghost.pts[1] = xy; redrawPage(p); }
    else if (d.mode === 'move') {
      const cur = toPdf(p, xy); let dx = cur[0] - d.start[0], dy = cur[1] - d.start[1];
      if (e.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }        // Shift: 上下左右だけ
      mapAnnot(d.a, d.origA, (q) => [q[0] + dx, q[1] + dy]); redrawPage(p);
    } else if (d.mode === 'gmove') {
      const cur = toPdf(p, xy); d.d = [cur[0] - d.start[0], cur[1] - d.start[1]];
      if (!d.moved && Math.hypot(d.d[0], d.d[1]) * p.view.scale > 3) d.moved = true;
      if (e.shiftKey) { if (Math.abs(d.d[0]) > Math.abs(d.d[1])) d.d[1] = 0; else d.d[0] = 0; }
      if (d.moved) { const [dx, dy] = d.d; for (const { a, o } of d.ours) mapAnnot(a, o, (q) => [q[0] + dx, q[1] + dy]); redrawPage(p); }
    } else if (d.mode === 'gscale') {
      const P = toPdf(p, xy), { O, H } = d, corner = d.idx < 4, horiz = d.idx === 5 || d.idx === 7, vert = d.idx === 4 || d.idx === 6;
      let sx = vert ? 1 : (P[0] - O[0]) / ((H[0] - O[0]) || 1e-9), sy = horiz ? 1 : (P[1] - O[1]) / ((H[1] - O[1]) || 1e-9);
      if (corner && e.shiftKey) { const k = Math.max(Math.abs(sx), Math.abs(sy)); sx = Math.sign(sx || 1) * k; sy = Math.sign(sy || 1) * k; }
      sx = Math.max(0.05, sx); sy = Math.max(0.05, sy);                     // 裏返しはしない
      d.sx = sx; d.sy = sy; d.moved = true;
      for (const { a, o } of d.ours) scaleAnnot(a, o, O, sx, sy);
      redrawPage(p);
    } else if (d.mode === 'rotate') {
      const P = toPdf(p, xy);
      let deg = (Math.atan2(P[1] - d.C[1], P[0] - d.C[0]) - d.a0) * 180 / Math.PI;
      if (e.shiftKey) deg = Math.round(deg / 15) * 15;
      for (const { a, o } of d.ours) rotateAnnot(a, o, d.C, deg);
      d.changed = Math.abs(normDeg(deg)) > 0.01; redrawPage(p);
    } else if (d.mode === 'amarq') { d.xy1 = xy; redrawPage(p);
    } else if (d.mode === 'nmove') {
      const cur = toPdf(p, xy); d.d = [cur[0] - d.start[0], cur[1] - d.start[1]];
      if (e.shiftKey) { if (Math.abs(d.d[0]) > Math.abs(d.d[1])) d.d[1] = 0; else d.d[0] = 0; }
      if (Math.hypot(d.d[0], d.d[1]) * p.view.scale > 3) d.moved = true;
      if (d.moved) redrawPage(p);
    } else if (d.mode === 'nvert') {
      let c = xy;
      if (e.shiftKey) {        // Shift: 隣の頂点から45°刻み
        const m = d.pts.length, nb = d.idx > 0 ? d.idx - 1 : (d.n.subtype === 'Polygon' ? m - 1 : 1);
        c = snap45(toVp(p, d.pts[nb]), xy);
      }
      d.pts[d.idx] = toPdf(p, c); d.moved = true; redrawPage(p);
    } else if (d.mode === 'nresize') {
      const O = d.O; let dx = xy[0] - O[0], dy = xy[1] - O[1];
      if (d.lockAr !== e.shiftKey) {
        let w = Math.abs(dx), h = Math.abs(dy);
        if (w / Math.max(h, 1e-6) > d.ar) h = w / d.ar; else w = h * d.ar;
        dx = Math.sign(dx || 1) * w; dy = Math.sign(dy || 1) * h;
      }
      if (Math.abs(dx) < 8) dx = Math.sign(dx || 1) * 8;
      if (Math.abs(dy) < 8) dy = Math.sign(dy || 1) * 8;
      d.vr = [Math.min(O[0], O[0] + dx), Math.min(O[1], O[1] + dy), Math.max(O[0], O[0] + dx), Math.max(O[1], O[1] + dy)];
      redrawPage(p);
    } else if (d.mode === 'handle') {
      const a = d.a; const pt = toPdf(p, xy);
      if (a.type === 'text' && d.idx === 0) { const v = rotPt(pt, a.pts[0], -(a.rot || 0)); a.w = Math.max(20, v[0] - a.pts[0][0]); delete a.autoW; }
      else if (a.type === 'text' && d.idx >= 5) {   // 辺: 左=幅（右辺を固定）、上下=拡大縮小（反対側の辺を固定）
        const o = d.origA, rot = o.rot || 0, lb = localBox(o), anc = o.pts[0], v = rotPt(pt, anc, -rot), h0 = lb[3] - lb[1];
        if (d.idx === 5) {
          const w2 = Math.max(20, lb[2] - v[0]); a.w = w2; delete a.autoW; a.pts = [rotPt([lb[2] - w2, lb[3]], anc, rot)];
        } else {
          const h2 = d.idx === 6 ? v[1] - lb[1] : lb[3] - v[1];
          const k = clamp(h2 / Math.max(h0, 1e-6), 4 / o.p.fontSize, 300 / o.p.fontSize);
          a.p.fontSize = Math.round(o.p.fontSize * k * 10) / 10; a.w = Math.max(10, o.w * k);
          a.pts = [d.idx === 6 ? rotPt([lb[0], lb[1] + h0 * k], anc, rot) : anc.slice()];
          P.font.value = a.p.fontSize;
        }
      }
      else if (a.type === 'text') {                 // 四隅: 反対側の角を固定して、枠とフォントサイズを同じ割合で拡大縮小
        const o = d.origA, rot = o.rot || 0, lb = localBox(o), anc = o.pts[0];
        const C4 = [[lb[0], lb[1]], [lb[2], lb[1]], [lb[2], lb[3]], [lb[0], lb[3]]], i = d.idx - 1;
        const Ol = C4[(i + 2) % 4], Hl = C4[i], Ow = rotPt(Ol, anc, rot);
        const v = rotPt(pt, Ow, -rot), vx = v[0] - Ow[0], vy = v[1] - Ow[1], hx = Hl[0] - Ol[0], hy = Hl[1] - Ol[1];
        let k = (vx * hx + vy * hy) / Math.max(hx * hx + hy * hy, 1e-6);
        k = clamp(k, 4 / o.p.fontSize, 300 / o.p.fontSize);
        a.p.fontSize = Math.round(o.p.fontSize * k * 10) / 10; a.w = Math.max(10, o.w * k);
        const off = rotPt([(Ol[0] - anc[0]) * k, (Ol[1] - anc[1]) * k], [0, 0], rot);
        a.pts = [[Ow[0] - off[0], Ow[1] - off[1]]];
        P.font.value = a.p.fontSize;
      }
      else if (a.type === 'ink') {
        const { O, H } = d;
        let sx = (pt[0] - O[0]) / ((H[0] - O[0]) || 1e-9), sy = (pt[1] - O[1]) / ((H[1] - O[1]) || 1e-9);
        if (e.shiftKey) { const k = Math.max(Math.abs(sx), Math.abs(sy)); sx = Math.sign(sx || 1) * k; sy = Math.sign(sy || 1) * k; }
        if (Math.abs(sx) < 0.02) sx = Math.sign(sx || 1) * 0.02; if (Math.abs(sy) < 0.02) sy = Math.sign(sy || 1) * 0.02;
        mapAnnot(a, d.origA, (q) => [O[0] + (q[0] - O[0]) * sx, O[1] + (q[1] - O[1]) * sy]);
      } else if (isRectLike(a) && d.idx >= 4) {      // 辺の中央: その方向だけ大きさを変える（反対側の辺を固定。回転していても可）
        const o = d.origA, rot = o.rot || 0, c0 = pivotOf(o), lb = localBox(o), v = rotPt(pt, c0, -rot);
        // 角の並び（pts[0] 基準）に対応する辺: 4=pts[0]のy, 5=pts[1]のx, 6=pts[1]のy, 7=pts[0]のx
        const [q0, q1] = o.pts, nb = [q0[0], q0[1], q1[0], q1[1]];
        if (d.idx === 4) nb[1] = v[1]; else if (d.idx === 5) nb[2] = v[0]; else if (d.idx === 6) nb[3] = v[1]; else nb[0] = v[0];
        let x0 = Math.min(nb[0], nb[2]), x1 = Math.max(nb[0], nb[2]), y0 = Math.min(nb[1], nb[3]), y1 = Math.max(nb[1], nb[3]);
        if (x1 - x0 < 2) x1 = x0 + 2; if (y1 - y0 < 2) y1 = y0 + 2;
        const cw = rotPt([(x0 + x1) / 2, (y0 + y1) / 2], c0, rot), hw = (x1 - x0) / 2, hh = (y1 - y0) / 2;
        a.pts = [[cw[0] - hw, cw[1] - hh], [cw[0] + hw, cw[1] + hh]];
        void lb;
      } else if (a.rot && isRectLike(a)) {          // 回転している四角形・楕円・スタンプ: 回転した向きのまま大きさを変える
        const O = d.O, v = rotPt(pt, O, -a.rot);
        let dx = v[0] - O[0], dy = v[1] - O[1];
        if (a.type === 'stamp' && !e.shiftKey) { let w = Math.abs(dx), h = Math.abs(dy); if (w / Math.max(h, 1e-6) > d.ar) h = w / d.ar; else w = h * d.ar; dx = Math.sign(dx || 1) * w; dy = Math.sign(dy || 1) * h; }
        if (Math.abs(dx) < 5) dx = Math.sign(dx || 1) * 5; if (Math.abs(dy) < 5) dy = Math.sign(dy || 1) * 5;
        const c2 = rotPt([O[0] + dx / 2, O[1] + dy / 2], O, a.rot), hw = Math.abs(dx) / 2, hh = Math.abs(dy) / 2;
        a.pts = [[c2[0] - hw, c2[1] - hh], [c2[0] + hw, c2[1] + hh]];
      } else if (a.type === 'stamp') {
        const O = d.O; const dx = pt[0] - O[0], dy = pt[1] - O[1];
        let w = Math.abs(dx), h = Math.abs(dy);
        if (!e.shiftKey) { if (w / Math.max(h, 1e-6) > d.ar) h = w / d.ar; else w = h * d.ar; }
        a.pts = [O.slice(), [O[0] + Math.sign(dx || 1) * Math.max(w, 5), O[1] + Math.sign(dy || 1) * Math.max(h, 5)]];
      } else if (a.type === 'rect' || a.type === 'ellipse') { const [fx, fy] = RECT_H[d.idx]; a.pts[fx][0] = pt[0]; a.pts[fy][1] = pt[1]; }
      else {
        let c = xy;
        if (e.shiftKey && a.type !== 'cloud') { const nb = d.idx > 0 ? a.pts[d.idx - 1] : a.pts[1]; c = snap45(toVp(p, nb), xy); }
        a.pts[d.idx] = toPdf(p, c);
      }
      redrawPage(p);
    }
  } else if (S.draft && isMulti(S.draft.type)) {
    const p = S.pages[S.draft.page - 1]; if (!p.view) return;
    let xy = evXY(e, p);
    const n = S.draft.pts.length;
    if (e.shiftKey && n >= 2) xy = snap45(toVp(p, S.draft.pts[n - 2]), xy);
    S.draft.pts[n - 1] = toPdf(p, xy); redrawPage(p);
  }
});
window.addEventListener('pointerup', () => {
  const d = S.drag; if (!d) return;
  S.drag = null;
  if (d.mode === 'draw') {
    const dr = S.draft; S.draft = null;
    const a = toVp(d.p, dr.pts[0]), b = toVp(d.p, dr.pts[1]);
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 4) { redrawPage(d.p); return; }
    addAnnot(dr);
  } else if (d.mode === 'cdrag') {
    if (d.moved) { const dr = S.draft; S.draft = null; addAnnot(dr); }
    else { const pt = S.draft.pts[0]; S.draft.pts = [pt, pt.slice()]; redrawPage(d.p); }
  } else if (d.mode === 'tdraw') {
    const g = S.ghost; S.ghost = null; redrawPage(d.p);
    const [a, b] = g.pts, moved = Math.hypot(a[0] - b[0], a[1] - b[1]) > 8;
    // 枠の左上（画面上）を基点にする。ページが回転していても、画面で見て横書きになるよう注釈を回す
    const tl = moved ? [Math.min(a[0], b[0]), Math.min(a[1], b[1])] : a;
    // クリックだけで置いたときは幅を自動にする（入力した文字のいちばん長い行に合わせて右の余白を詰める）
    const w = moved ? Math.max(30, Math.abs(a[0] - b[0]) / d.p.view.scale) : 200;
    const r = normRot(d.p.view.rotation);
    beginEdit({ id: newId(), type: 'text', page: d.p.num, pts: [toPdf(d.p, tl)], w, ...(moved ? {} : { autoW: true }), ...(r ? { rot: r } : {}), text: '', author: S.author, date: new Date().toISOString(), p: { ...S.textDefaults } }, true);
  } else if (d.mode === 'move' && d.toggle && JSON.stringify(d.a.pts) === JSON.stringify(d.orig)) { toggleSel(d.toggle);
  } else if (d.mode === 'gscale') { finishGroupScale(d);
  } else if (d.mode === 'gmove') { finishGroupMove(d);
  } else if (d.mode === 'rotate') { if (d.changed) { commit(d.snap); syncProps(); } redrawPage(d.p);
  } else if (d.mode === 'amarq') { finishMarquee(d);
  } else if (d.mode === 'nmove') {
    if (d.moved) moveNative(d.n, d.d[0], d.d[1]); else if (d.toggle) toggleSel(d.toggle);
  } else if (d.mode === 'nvert') {
    if (d.moved) vertsNative(d.n, d.pts, d.dup); else redrawPage(d.p);
  } else if (d.mode === 'nresize') {
    const [a0, b0, a1, b1] = d.vr, A = toPdf(d.p, [a0, b0]), B = toPdf(d.p, [a1, b1]);
    const rect = [Math.min(A[0], B[0]), Math.min(A[1], B[1]), Math.max(A[0], B[0]), Math.max(A[1], B[1])];
    const o = d.n.rect;
    if (rect.every((v, i) => Math.abs(v - o[i]) < 0.5)) redrawPage(d.p); else resizeNative(d.n, rect);
  } else { commit(d.snap); if (d.mode === 'handle') syncProps(); }
});
function startGroupMove(e, pg) {
  if (!pg || !pg.view) return;
  S.drag = { mode: 'gmove', p: pg, start: toPdf(pg, evXY(e, pg)), d: [0, 0], moved: false, snap: takeSnap(),
    ours: selOurs().filter((a) => a.page === pg.num).map((a) => ({ a, o: clone(a) })), nats: new Set(selNatives().filter((n) => n.page === pg.num)) };
  e.preventDefault();
}
async function finishGroupMove(d) {
  if (!d.moved) { if (d.toggle) toggleSel(d.toggle); else redrawPage(d.p); return; }
  const [dx, dy] = d.d;
  if (d.nats.size) {
    setBusy(true, '注釈を移動中…');
    try { await setBase(await nativeEdit([...d.nats].map((n) => ({ type: 'move', id: n.id, page: n.page, dx, dy })))); }
    catch (e) { console.error(e); toast('既存の注釈を移動できませんでした: ' + friendlyError(e), 6000); }
    finally { setBusy(false); }
  }
  commit(d.snap); redrawAll(); syncProps();
}
function startRotate(e, p) {
  const ours = selOurs().filter((a) => a.page === p.num); if (!ours.length) return;
  if (selNatives().length) toast('既存の注釈（他のソフトで作成したもの）は回転できません。それ以外を回転します', 3500);
  const gb = groupBox(p.num, true), C = [(gb[0] + gb[2]) / 2, (gb[1] + gb[3]) / 2], P0 = toPdf(p, evXY(e, p));
  S.drag = { mode: 'rotate', p, C, a0: Math.atan2(P0[1] - C[1], P0[0] - C[0]), ours: ours.map((a) => ({ a, o: clone(a) })), snap: takeSnap(), changed: false };
  e.preventDefault();
}
function finishMarquee(d) {
  const A = toPdf(d.p, d.xy0), B = toPdf(d.p, d.xy1);
  if (Math.hypot(d.xy0[0] - d.xy1[0], d.xy0[1] - d.xy1[1]) < 4) { redrawPage(d.p); return; }
  const box = [Math.min(A[0], B[0]), Math.min(A[1], B[1]), Math.max(A[0], B[0]), Math.max(A[1], B[1])];
  const inside = (b) => b && b[0] >= box[0] - 0.5 && b[1] >= box[1] - 0.5 && b[2] <= box[2] + 0.5 && b[3] <= box[3] + 0.5;
  const keys = [...S.annots.filter((a) => a.page === d.p.num && inside(annotBBox(a))).map((a) => a.id),
    ...S.natives.filter((n) => n.page === d.p.num && inside(n.rect)).map((n) => n.key)];
  S.sel = new Set([...(d.add ? S.sel : []), ...keys]);
  redrawPage(d.p); syncProps(); updateButtons(); scheduleList();
  if (keys.length) toast(`${S.sel.size}個の注釈を選択しました`, 1800);
}
function finishPoly() {
  const dr = S.draft; if (!dr) return;
  S.draft = null;
  const pts = dr.pts.slice(0, -1);
  const ded = pts.filter((q, i) => i === 0 || Math.hypot(q[0] - pts[i - 1][0], q[1] - pts[i - 1][1]) > 0.5);
  if (ded.length < minPts(dr.type)) { redrawPage(S.pages[dr.page - 1]); return; }
  dr.pts = ded; addAnnot(dr);
}
function cancelDraft() { if (!S.draft) return; const p = S.pages[S.draft.page - 1]; S.draft = null; S.drag = null; redrawPage(p); }
/* ------------------------------------------------- テキストコメントの編集 */
// 幅が自動のテキスト: 置いた位置からページの右端（画面で見た右）までを折り返しの上限にする
function autoMaxW(p, a) {
  const [vx] = vpt(p.view, a.pts[0]);
  return Math.max(30, (p.view.width - vx) / p.view.scale - 4);
}
// 幅が自動のテキストの幅を、いちばん長い行に合わせる（上限は autoMaxW）
function fitTextW(a, p = pageOf(a)) {
  if (!a || a.type !== 'text' || !a.autoW || !p || !p.view) return;
  const maxW = autoMaxW(p, a), L = layoutText(a.text || '', a.p.fontSize, maxW, { face: a.p.face });
  a.w = Math.min(maxW, Math.max(a.p.fontSize, L.maxLineW + L.pad * 2 + 1));
}
function beginEdit(a, isNew) {
  const p = pageOf(a); if (!p || !p.view) return;
  if (S.editing) endEdit(true);
  const snap = takeSnap(), sc = p.view.scale, [vx, vy] = vpt(p.view, a.pts[0]);
  if (a.autoW) a.w = autoMaxW(p, a);
  const ta = document.createElement('textarea'); ta.className = 'te'; ta.value = a.text || '';
  Object.assign(ta.style, { left: vx + 'px', top: vy + 'px', width: a.w * sc + 'px', fontSize: a.p.fontSize * sc + 'px', fontFamily: `${faceOf(a.p.face).css.l},${faceOf(a.p.face).css.j}`,
    padding: 2 * sc + 'px', color: a.p.color, background: a.p.fill || 'rgba(255,255,255,.88)', transform: `rotate(${p.view.rotation - (a.rot || 0)}deg)`, transformOrigin: '0 0' });
  p.el.appendChild(ta);
  S.editing = { a, isNew, ta, orig: a.text || '', snap };
  const grow = () => {
    if (a.autoW) {         // 入力に合わせて編集欄の幅も伸ばす（右端までで折り返す）
      const maxW = autoMaxW(p, a), L = layoutText(ta.value, a.p.fontSize, maxW, { face: a.p.face });
      ta.style.width = Math.min(maxW, Math.max(a.p.fontSize * 4, L.maxLineW + L.pad * 2 + a.p.fontSize)) * sc + 'px';
    }
    ta.style.height = 'auto'; ta.style.height = Math.max(ta.scrollHeight, a.p.fontSize * sc * 1.5) + 'px';
  };
  ta.addEventListener('input', grow);
  ta.addEventListener('blur', () => endEdit(true));
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); endEdit(true); }          // v3.3: Escでも反映（画面をクリックしたときと同じ）
    else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); endEdit(true); }
  });
  grow(); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
  redrawPage(p);
}
// テキストコメントの編集を終える（commitIt=false なら取り消す）
function endEdit(commitIt = true) {
  const E = S.editing; if (!E) return;
  S.editing = null;
  const text = E.ta.value; if (E.ta.isConnected) E.ta.remove();
  const a = E.a, p = pageOf(a);
  if (!commitIt) { fitTextW(a, p); if (p) redrawPage(p); return; }
  if (E.isNew) {
    if (text.trim() === '') { if (p) redrawPage(p); return; }
    a.text = text; fitTextW(a, p); addAnnot(a);
  } else {
    if (text === E.orig) { fitTextW(a, p); if (p) redrawPage(p); return; }
    if (text.trim() === '') { S.annots = S.annots.filter((x) => x.id !== a.id); S.sel.delete(a.id); }
    else { a.text = text; fitTextW(a, p); }
    if (p) redrawPage(p); commit(E.snap); syncProps();
  }
}
pagesEl.addEventListener('dblclick', (e) => {
  if (!isSelTool() || S.busy) return;
  const nEl = e.target.closest && e.target.closest('[data-nid]');
  if (nEl && !e.target.closest('[data-nh]')) {
    const n = S.nmap.get(nEl.dataset.nid), np = n && n.subtype !== 'Line' ? nativePts(n) : null;
    if (np) {               // 既存の折れ線・多角形・雲形: 辺をダブルクリックすると頂点を追加（コメントの編集は Enter／「コメントを編集」）
      const p = pageOf(n), xy = evXY(e, p), m = np.pts.length, nSeg = n.subtype === 'Polygon' ? m : m - 1;
      let best = -1, bd = Infinity, bq = null;
      for (let i = 0; i < nSeg; i++) {
        const A = toVp(p, np.pts[i]), B = toVp(p, np.pts[(i + 1) % m]);
        const ab = [B[0] - A[0], B[1] - A[1]], l2 = ab[0] ** 2 + ab[1] ** 2 || 1;
        const t = clamp(((xy[0] - A[0]) * ab[0] + (xy[1] - A[1]) * ab[1]) / l2, 0, 1);
        const q = [A[0] + ab[0] * t, A[1] + ab[1] * t], dist = Math.hypot(q[0] - xy[0], q[1] - xy[1]);
        if (dist < bd) { bd = dist; best = i; bq = q; }
      }
      if (best >= 0 && bd < 14) { np.pts.splice(best + 1, 0, toPdf(p, bq)); vertsNative(n, np.pts, np.dup); return; }
    }
    editNativeContents(nEl.dataset.nid); return;
  }
  const a = selAnnot(); if (!a) return;
  if (a.type === 'text') { if (e.target.closest && e.target.closest('[data-id]')) beginEdit(a, false); return; }
  if (!isMulti(a.type)) return;
  const aEl = e.target.closest && e.target.closest('[data-id]'); if (!aEl || e.target.closest('[data-h]')) return;
  const p = pageOf(a), xy = evXY(e, p), nPt = a.pts.length, nSeg = isClosedT(a.type) ? nPt : nPt - 1;
  let best = -1, bd = Infinity, bq = null;
  for (let i = 0; i < nSeg; i++) {
    const A = toVp(p, a.pts[i]), B = toVp(p, a.pts[(i + 1) % nPt]);
    const ab = [B[0] - A[0], B[1] - A[1]], l2 = ab[0] ** 2 + ab[1] ** 2 || 1;
    const t = clamp(((xy[0] - A[0]) * ab[0] + (xy[1] - A[1]) * ab[1]) / l2, 0, 1);
    const q = [A[0] + ab[0] * t, A[1] + ab[1] * t], dist = Math.hypot(q[0] - xy[0], q[1] - xy[1]);
    if (dist < bd) { bd = dist; best = i; bq = q; }
  }
  if (best >= 0 && bd < 14) { const snap = takeSnap(); a.pts.splice(best + 1, 0, toPdf(p, bq)); redrawPage(p); commit(snap); }
});
wrap.addEventListener('pointerdown', (e) => {
  if (isSelTool() && S.sel.size && !e.shiftKey && (e.target === wrap || e.target === pagesEl)) select(null);
  if (S.tool === 'edit' && (e.target === wrap || e.target === pagesEl)) ceClear();
});
/* ---------------------------------------------- 画像スタンプ（クリップボード / 日付印） */
async function normalizeImage(blob) {
  const bmp = await createImageBitmap(blob);
  const m = Math.max(bmp.width, bmp.height), k = m > 3000 ? 3000 / m : 1;
  const w = Math.max(1, Math.round(bmp.width * k)), h = Math.max(1, Math.round(bmp.height * k));
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  cv.getContext('2d').drawImage(bmp, 0, 0, w, h);
  if (bmp.close) bmp.close();
  const out = await new Promise((r) => cv.toBlob(r, 'image/png'));
  return { bytes: new Uint8Array(await out.arrayBuffer()), w, h };
}
async function ensureView(p) {
  if (p.view) return;
  if (!p.pageObj) p.pageObj = await S.pdf.getPage(p.num);
  p.view = p.pageObj.getViewport({ scale: p.scale || S.scale });
}
async function placeStamp(bytes, w, h, { widthPt = null } = {}) {
  if (!S.pdf) { toast('先にPDFを開いてください'); return; }
  const id = await registerImage(bytes);
  const p = S.pages[S.cur - 1]; await ensureView(p);
  let wpt = widthPt || w * 0.75, hpt = wpt * h / w;
  if (!widthPt) { const maxW = (p.view.width / p.view.scale) * 0.4; if (wpt > maxW) { const k = maxW / wpt; wpt *= k; hpt *= k; } }
  const rot = normRot(p.view.rotation);
  const [pw, ph] = rot % 180 ? [hpt, wpt] : [wpt, hpt];
  const cy = clamp(wrap.scrollTop + wrap.clientHeight / 2 - p.el.offsetTop, 0, p.view.height);
  const C = p.view.convertToPdfPoint(p.view.width / 2, cy);
  addAnnot({ id: newId(), type: 'stamp', page: p.num, img: id, prot: rot, pts: [[C[0] - pw / 2, C[1] - ph / 2], [C[0] + pw / 2, C[1] + ph / 2]], p: { ...TEXT_DEFAULTS } }, { forceSelect: true });
}
async function addStampFromBlob(blob) {
  if (!S.pdf) { toast('先にPDFを開いてください'); return; }
  try {
    const { bytes, w, h } = await normalizeImage(blob);
    await placeStamp(bytes, w, h);
    toast('画像をスタンプとして貼り付けました（四角のハンドルで拡大縮小）');
  } catch (e) { console.error(e); toast('画像を貼り付けられませんでした: ' + (e.message || e), 5000); }
}
async function pasteFromClipboardButton() {
  try {
    const items = await navigator.clipboard.read();
    for (const it of items) {
      const type = it.types.find((t) => t.startsWith('image/'));
      if (type) { await addStampFromBlob(await it.getType(type)); return; }
    }
    toast('クリップボードに画像がありません');
  } catch (e) { toast('クリップボードを読み取れませんでした。Ctrl+V で貼り付けてください。', 4500); }
}
/* ---- v3.2: 注釈のコピー・切り取り・貼り付け（Ctrl+C / Ctrl+X / Ctrl+V）、複製（Ctrl+D） */
const CLIP_MARK = 'EPA-ANNOTS:';
const clip = { items: null, mark: '', n: 0, other: false };
const ANNOTCLIP_KEY = 'annotClip';
// ほかのタブでコピーした注釈を読み込む（クリップボードの目印が一致するときだけ）。スタンプの画像はこのタブに登録し直す
async function loadOtherClip(mark) {
  const c = await IDB.get(ANNOTCLIP_KEY);
  if (!c || c.mark !== mark || !Array.isArray(c.items) || !c.items.length) return false;
  const ids = new Map();
  for (const [id, b] of Object.entries(c.images || {})) {
    try { ids.set(id, await registerImage(b instanceof Uint8Array ? b : new Uint8Array(b))); } catch { /* ignore */ }
  }
  clip.items = c.items.map((a) => (a.type === 'stamp' ? { ...a, img: ids.get(a.img) || null } : a)).filter((a) => a.type !== 'stamp' || a.img);
  clip.mark = c.mark; clip.n = 0; clip.other = true;
  return clip.items.length > 0;
}
const typingTarget = (t) => t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
const textSelected = () => { const g = window.getSelection && window.getSelection(); return !!(g && !g.isCollapsed && String(g).trim()); };
function copyAnnots() {
  const ours = selOurs();
  if (!ours.length) { if (selNatives().length) toast('既存の注釈（他のソフトで作成したもの）はコピーできません'); return false; }
  clip.items = ours.map(clone); clip.mark = CLIP_MARK + newId(); clip.n = 0; clip.other = false;
  // v4.11.1: 同じブラウザのほかのタブ（ほかのPDF）でも貼り付けられるように、注釈（スタンプの画像も）を保存しておく
  const images = {};
  for (const a of clip.items) if (a.type === 'stamp' && a.img && S.images.has(a.img)) images[a.img] = S.images.get(a.img).bytes;
  IDB.set(ANNOTCLIP_KEY, { mark: clip.mark, items: clip.items, images, time: Date.now() });
  const skip = selNatives().length;
  toast(`${ours.length}個の注釈をコピーしました${skip ? `（既存の注釈${skip}個は対象外）` : ''}。Ctrl+Vで貼り付け`, 2500);
  return true;
}
// コピーした注釈を、今のページに貼り付ける（同じページなら少しずつずらす）
function pasteAnnots() {
  if (!clip.items || !S.pdf) return;
  clip.n++;
  const page = S.cur, src = clip.items[0].page, k = page === src && !clip.other ? 12 * clip.n : 12 * (clip.n - 1);   // 同じページなら少しずらす
  const snap = takeSnap(), made = [];
  for (const o of clip.items) {
    const a = clone(o); a.id = newId(); a.page = page; a.author = S.author; a.date = new Date().toISOString();
    if (k) mapAnnot(a, clone(a), (q) => [q[0] + k, q[1] - k]);
    S.annots.push(a); made.push(a.id);
  }
  if (!isSelTool()) setTool('select');
  S.sel = new Set(made);
  if (S.pages[page - 1]) redrawPage(S.pages[page - 1]);
  commit(snap); syncProps(); updateButtons();
  toast(`${made.length}個の注釈を貼り付けました`, 1800);
}
window.addEventListener('copy', (e) => {
  if (typingTarget(e.target) || textSelected() || S.tool === 'edit' || !selOurs().length) return;
  if (copyAnnots()) { e.preventDefault(); e.clipboardData.setData('text/plain', clip.mark); }
});
window.addEventListener('cut', (e) => {
  if (typingTarget(e.target) || textSelected() || S.tool === 'edit' || !selOurs().length) return;
  if (copyAnnots()) {
    e.preventDefault(); e.clipboardData.setData('text/plain', clip.mark);
    const ids = new Set(selOurs().map((a) => a.id)), snap = takeSnap();
    S.annots = S.annots.filter((a) => !ids.has(a.id)); for (const id of ids) S.sel.delete(id);
    redrawAll(); commit(snap); syncProps(); updateButtons();
  }
});
window.addEventListener('paste', async (e) => {
  const t = e.target; if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
  // ほかのタブでコピーした注釈（クリップボードに目印の文字列がある）
  const mk = e.clipboardData ? e.clipboardData.getData('text/plain') : '';
  if (S.tool !== 'edit' && S.pdf && mk.startsWith(CLIP_MARK) && mk !== clip.mark) {
    e.preventDefault();
    if (!S.lock.annot) { toast('このPDFは文書の設定で注釈の追加が禁止されているため、貼り付けられません', 5000); return; }
    if (await loadOtherClip(mk)) pasteAnnots(); else toast('コピーした注釈が見つかりませんでした（もう一度コピーしてください）', 4000);
    return;
  }
  if (S.tool !== 'edit' && clip.items) {           // コピーした注釈（クリップボードがその後に変わっていなければ）
    const txt = e.clipboardData ? e.clipboardData.getData('text/plain') : '';
    const hasImg = [...((e.clipboardData && e.clipboardData.items) || [])].some((i) => i.kind === 'file' && i.type.startsWith('image/'));
    if (txt === clip.mark || (!txt && !hasImg)) { e.preventDefault(); pasteAnnots(); return; }
  }
  const it = [...((e.clipboardData && e.clipboardData.items) || [])].find((i) => i.kind === 'file' && i.type.startsWith('image/'));
  if (!it) return;
  e.preventDefault(); const f = it.getAsFile(); if (f) await addStampFromBlob(f);
});
$('#btnStamp').addEventListener('click', pasteFromClipboardButton);
/* ---- 日付印（部名 / 'YY.MM.DD / 名前） ---- */
const DS_DEF = { dept: '', name: '', date: '', color: '#ff0000', mm: 17 };
const dsSettings = () => ({ ...DS_DEF, ...LS.get('dstamp', {}) });
const FONT_MINCHO = '"Yu Mincho","YuMincho","MS Mincho","Hiragino Mincho ProN","Noto Serif CJK JP","Noto Sans CJK JP",serif';
const FONT_DSDATE = '"Meiryo","Segoe UI","Yu Gothic UI","Yu Gothic","Noto Sans CJK JP",sans-serif';
function dsDateText(s, now = new Date()) {
  const t = String(s || '').trim(), z = (v) => String(v).padStart(2, '0');
  if (!t) return `'${z(now.getFullYear() % 100)}.${z(now.getMonth() + 1)}.${z(now.getDate())}`;
  let m = /^(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?$/.exec(t);
  if (m) return `'${m[1].slice(2)}.${z(+m[2])}.${z(+m[3])}`;
  m = /^['’‘`]?(\d{2})\.(\d{1,2})\.(\d{1,2})$/.exec(t);
  if (m) return `'${m[1]}.${z(+m[2])}.${z(+m[3])}`;
  return t;
}
function drawDateStamp(cv, s, dateText) {
  const D = cv.width, c = cv.getContext('2d'); c.clearRect(0, 0, D, D);
  const col = s.color || '#ff0000', cx = D / 2, cy = D / 2, R = D / 2 - D * 0.014;
  c.strokeStyle = col; c.fillStyle = col; c.lineJoin = 'round';
  c.lineWidth = D * 0.012; c.beginPath(); c.arc(cx, cy, R, 0, Math.PI * 2); c.stroke();
  const dy = D * 0.145, half = Math.sqrt(Math.max(R * R - dy * dy, 0));
  c.lineWidth = D * 0.014;
  for (const yy of [cy - dy, cy + dy]) { c.beginPath(); c.moveTo(cx - half, yy); c.lineTo(cx + half, yy); c.stroke(); }
  const put = (text, yc, font, maxW, maxS) => {
    if (!text) return;
    c.font = `400 100px ${font}`; const w100 = c.measureText(text).width || 1;
    const size = Math.min(100 * maxW / w100, maxS);
    c.font = `400 ${size}px ${font}`; c.textAlign = 'center'; c.textBaseline = 'alphabetic';
    const m = c.measureText(text), yb = yc + (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2;
    c.lineWidth = size * 0.012; c.strokeText(text, cx, yb); c.fillText(text, cx, yb);
  };
  put(s.dept, D * 0.225, FONT_MINCHO, D * 0.6, D * 0.175);
  put(dateText, cy, FONT_DSDATE, D * 0.86, D * 0.24);
  put(s.name, D * 0.795, FONT_MINCHO, D * 0.6, D * 0.175);
}
async function makeAndPlaceDateStamp(s) {
  try {
    const cv = document.createElement('canvas'); cv.width = cv.height = 720;
    drawDateStamp(cv, s, dsDateText(s.date));
    const blob = await new Promise((r) => cv.toBlob(r, 'image/png'));
    await placeStamp(new Uint8Array(await blob.arrayBuffer()), 720, 720, { widthPt: clamp(+s.mm || 17, 8, 80) * 72 / 25.4 });
    toast(`日付印を貼り付けました（${s.dept || ''} ${dsDateText(s.date)} ${s.name || ''}）`);
  } catch (e) { console.error(e); toast('日付印を作成できませんでした: ' + (e.message || e), 5000); }
}
// 日付印の設定ダイアログ
async function openDateStampDialog() {
  const s0 = dsSettings();
  const r = await dialog({
    title: '日付印スタンプ', ok: '保存して貼り付け',
    html: `<div class="dsrow"><div>
      <label>部名（上段） <input id="dsDept" class="w" value="${esc(s0.dept)}" placeholder="例: 総務部"></label>
      <label>日付（中段） <input id="dsDate" class="w" value="${esc(s0.date)}" placeholder="空欄＝貼り付ける日（'YY.MM.DD）"></label>
      <label>名前（下段） <input id="dsName" class="w" value="${esc(s0.name)}" placeholder="例: 山田"></label>
      <label>まとめて入力 <input id="dsLine" class="w" placeholder="部名,'YY.MM.DD,名前"></label>
      <label>色 <input id="dsColor" type="color" value="${esc(s0.color)}"> 直径 <input id="dsMm" type="number" min="8" max="80" step="1" value="${esc(s0.mm)}" style="width:64px"> mm</label>
      </div><canvas id="dsPrev" width="360" height="360"></canvas></div>
      <p class="small">日付欄を空にすると、貼り付けるたびに今日の日付になります。設定は保存され、次回から左サイドバーの「日付印」ボタン1回で貼り付けられます。</p>`,
    init: (d, signal) => {
      const q = (id) => d.querySelector(id), cv = q('#dsPrev');
      const cur = () => ({ dept: q('#dsDept').value.trim(), date: q('#dsDate').value.trim(), name: q('#dsName').value.trim(), color: q('#dsColor').value, mm: +q('#dsMm').value || 17 });
      const prev = () => { const s = cur(); drawDateStamp(cv, s, dsDateText(s.date)); };
      d.addEventListener('input', (e) => {
        if (e.target.id === 'dsLine') {
          const parts = e.target.value.split(/[,，、]/);
          if (parts.length >= 3) { q('#dsDept').value = parts[0].trim(); q('#dsDate').value = parts[1].trim(); q('#dsName').value = parts.slice(2).join(',').trim(); }
        }
        prev();
      }, { signal });
      prev();
    },
    validate: (d) => {
      const g = (id) => d.querySelector(id).value;
      const s = { dept: g('#dsDept').trim(), date: g('#dsDate').trim(), name: g('#dsName').trim(), color: g('#dsColor'), mm: clamp(+g('#dsMm') || 17, 8, 80) };
      if (!s.dept && !s.name) throw new Error('部名または名前を入力してください。');
      return s;
    },
  });
  if (!r) return;
  LS.set('dstamp', r); await makeAndPlaceDateStamp(r);
}
async function pasteDateStamp() {
  if (!S.pdf || S.busy) return;
  const s = dsSettings();
  if (!s.dept && !s.name) { await openDateStampDialog(); return; }
  await makeAndPlaceDateStamp(s);
}
$('#btnDateStamp').addEventListener('click', pasteDateStamp);
$('#btnDateStampCfg').addEventListener('click', openDateStampDialog);
/* ======================================================= 内容の編集（PDF内の文字・ベクター図形を直接編集）v3.0
 *  pdfedit.js がページのコンテンツストリームを解析・書き換える。ここでは選択・ドラッグ・プロパティ・文字入力のUIを担当。
 *  1回の操作（移動・拡大縮小・削除・色の変更・文字の置き換え）ごとにPDFを作り直し、表示し直す（元に戻す／やり直しに対応）。 */
const ce = {
  docBytes: null, docP: null, ready: new Map(), pending: new Map(),
  sel: new Set(), page: 0, hover: null, hoverPage: 0, drag: null, marq: null, lift: null,
  nudge: null, nudgeTimer: 0, pend: {}, editing: null, hoverRaf: 0,
  gen: 0, prep: null, prepTimer: 0,
};
window.__CE = ce;
const hexOf = (rgb) => (rgb ? rgb2hex(rgb) : null);
function ceOnBase(bytes) {
  ce.gen++; ce.prep = null;
  if (bytes === ce.docBytes) return;
  ce.docBytes = null; ce.docP = null; ce.ready.clear(); ce.pending.clear();
  ce.sel.clear(); ce.hover = null; ce.drag = null; ce.marq = null; ceLiftEnd();
}
function ceDoc() {
  if (ce.docBytes !== S.baseBytes || !ce.docP) {
    ce.docBytes = S.baseBytes; ce.ready.clear(); ce.pending.clear();
    ce.docP = baseAll().then((b) => PDFDocument.load(b, { updateMetadata: false }));
    ce.docP.catch(() => {});
  }
  return ce.docP;
}
/** ページを解析（結果はキャッシュ）。失敗したら { err } */
function ceParse(num) {
  if (ce.docBytes === S.baseBytes && ce.pending.has(num)) return ce.pending.get(num);
  const bytes = S.baseBytes;
  const pr = (async () => {
    const doc = await ceDoc();
    if (bytes !== S.baseBytes) return { err: '文書が変わりました' };
    try {
      const r = CE.parsePage(doc, num - 1);
      const p = S.pages[num - 1], v = p && p.pageObj ? p.pageObj.view : null;
      for (const o of r.objs) {
        o.bg = !!(v && (o.bbox[2] - o.bbox[0]) >= (v[2] - v[0]) * 0.9 && (o.bbox[3] - o.bbox[1]) >= (v[3] - v[1]) * 0.9);
      }
      if (bytes === S.baseBytes) ce.ready.set(num, r);
      return { r };
    } catch (e) { console.warn('content parse', e); return { err: friendlyError(e) }; }
  })();
  ce.pending.set(num, pr);
  return pr;
}
const ceObjs = () => { const r = ce.ready.get(ce.page); return r ? [...ce.sel].map((id) => r.objs[id]).filter(Boolean) : []; };
function ceUnion(objs) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const o of objs) { x0 = Math.min(x0, o.bbox[0]); y0 = Math.min(y0, o.bbox[1]); x1 = Math.max(x1, o.bbox[2]); y1 = Math.max(y1, o.bbox[3]); }
  return x0 === Infinity ? null : [x0, y0, x1, y1];
}
/* ---- 当たり判定 */
const hitCtx = document.createElement('canvas').getContext('2d');
function p2d(o) {
  if (o._p2d) return o._p2d;
  const path = new Path2D();
  const segs = o.parts ? o.parts[0].segs : o.segs;
  for (const s of segs) {
    if (s[0] === 'm') path.moveTo(s[1], s[2]); else if (s[0] === 'l') path.lineTo(s[1], s[2]);
    else if (s[0] === 'c') path.bezierCurveTo(s[1], s[2], s[3], s[4], s[5], s[6]); else if (s[0] === 'h') path.closePath();
  }
  o._p2d = path; return path;
}
function inQuad(q, x, y, tol) {
  let inside = false;
  for (let i = 0, j = 3; i < 4; j = i++) {
    const [xi, yi] = q[i], [xj, yj] = q[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi || 1e-9) + xi) inside = !inside;
  }
  return inside;
}
/** 点 pt（PDF座標）にあるオブジェクトのid（上にあるものから順） */
function ceHits(r, pt, tol, withBg = false) {
  const [x, y] = pt, out = [];
  for (let i = r.objs.length - 1; i >= 0; i--) {
    const o = r.objs[i];
    if (!o.editable || (o.bg && !withBg)) continue;
    const b = o.bbox;
    if (x < b[0] - tol || x > b[2] + tol || y < b[1] - tol || y > b[3] + tol) continue;
    if (o.kind === 'text') { if (inQuad(o.oquad, x, y) || o.quads.some((q) => inQuad(q, x, y))) out.push(o.id); continue; }
    const P = p2d(o);
    let hit = false;
    if (o.fill && hitCtx.isPointInPath(P, x, y, o.evenOdd ? 'evenodd' : 'nonzero')) hit = true;
    if (!hit) { hitCtx.lineWidth = Math.max(o.stroke ? o.lwPage : 0, tol * 2); hitCtx.lineJoin = 'round'; hit = hitCtx.isPointInStroke(P, x, y); }
    if (hit) out.push(o.id);
  }
  return out;
}
/* ---- 表示（選択枠・ハンドル・範囲選択） */
function ceDraw(p) {
  if (S.tool !== 'edit' || !p.view || !p.svg) return;
  const r = ce.ready.get(p.num); if (!r) return;
  const view = p.view, g = svgEl('g', { 'pointer-events': 'none' }, p.svg);
  const T = ce.drag && ce.drag.T && ce.page === p.num ? ce.drag.T : null;
  const V = (q) => { const t = T ? CE.ap(T, q[0], q[1]) : q; return vpt(view, t); };
  const poly = (pts, attrs, parent = g) => svgEl('path', { d: 'M' + pts.map((q) => V(q).map((v) => v.toFixed(1)).join(' ')).join('L') + 'Z', fill: 'none', ...attrs }, parent);
  const box = (b) => [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]];
  const outline = (o, attrs) => { if (o.kind === 'text') poly(o.oquad, attrs); else poly(box(o.bbox), attrs); };
  if (!ce.drag && ce.hover != null && ce.hoverPage === p.num && !ce.sel.has(ce.hover) && r.objs[ce.hover]) {
    outline(r.objs[ce.hover], { stroke: '#0f6cbd', 'stroke-width': 1.2, opacity: 0.85 });
  }
  if (ce.page === p.num && ce.sel.size) {
    const objs = ceObjs();
    for (const o of objs) outline(o, { stroke: '#0f6cbd', 'stroke-width': 1.3, 'stroke-dasharray': '4 3' });
    const U = ceUnion(objs);
    if (U && !(ce.drag && ce.drag.mode === 'move')) {
      if (objs.length > 1) poly(box(U), { stroke: '#0f6cbd', 'stroke-width': 1, opacity: 0.6 });
      const bx = box(U), Cc = [(U[0] + U[2]) / 2, (U[1] + U[3]) / 2];
      const hs = [...bx, ...bx.map((c, i) => { const n2 = bx[(i + 1) % 4]; return [(c[0] + n2[0]) / 2, (c[1] + n2[1]) / 2]; })];   // 0〜3 四隅、4〜7 辺の中央
      hs.forEach((c, i) => {
        const [hx, hy] = V(c), sz = i < 4 ? 10 : 8;
        const h = svgEl('rect', { x: hx - sz / 2, y: hy - sz / 2, width: sz, height: sz, fill: '#fff', stroke: '#0f6cbd', 'stroke-width': 2, 'pointer-events': 'all', class: 'ceh' }, p.svg);
        h.style.cursor = resizeCursor(view, Cc, [Cc[0] + Math.sign(c[0] - Cc[0]), Cc[1] + Math.sign(c[1] - Cc[1])]);
        h.dataset.ceh = i;
      });
      if (!ce.drag) {                    // 回転ハンドル（v3.5）
        const [vx0, vy0, vx1] = vbox(view, U), cx = (vx0 + vx1) / 2, ty = vy0 - 6;
        svgEl('line', { x1: cx, y1: ty, x2: cx, y2: ty - 18, stroke: '#0f6cbd', 'stroke-width': 1.5, 'pointer-events': 'none' }, p.svg);
        const rh = svgEl('circle', { cx, cy: ty - 24, r: 7, fill: '#fff', stroke: '#0f6cbd', 'stroke-width': 2, class: 'roth', 'pointer-events': 'all' }, p.svg);
        rh.dataset.cerot = '1';
        svgEl('title', {}, rh).textContent = 'ドラッグで回転（Shiftで15°刻み）';
      }
    }
  }
  if (ce.marq && ce.marq.page === p.num) {
    const [a, b] = ce.marq.xy;
    svgEl('rect', { x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), width: Math.abs(a[0] - b[0]), height: Math.abs(a[1] - b[1]), fill: 'rgba(15,108,189,.08)', stroke: '#0f6cbd', 'stroke-dasharray': '4 3', 'pointer-events': 'none' }, p.svg);
  }
}
const ceRedraw = () => { const pg = new Set([ce.page, ce.hoverPage]); for (const n of pg) if (n && S.pages[n - 1]) redrawPage(S.pages[n - 1]); };
/* ---- ドラッグ中のプレビュー: 描画済みの画像から選択部分を切り抜いて動かす（元の位置は白く隠す） */
/* ドラッグ中の表示（v3.6）: 選択したものだけを描いた画像と、それを取り除いた背景の画像を、あらかじめ別に描いておく。
   準備ができるまでは、描画済みの画像を切り抜いて代用する（重なった他の図形も一緒に写ることがある） */
function cePrepKey(p) { return `${ce.gen}|${p.num}|${p.rscale}|${[...ce.sel].sort((a, b) => a - b).join(',')}`; }
// 「内容を編集」: ドラッグ中のプレビュー用に、選択した部分だけを描いた画像を用意する
function cePrepLift(p) {
  const r = ce.ready.get(p.num); if (!r || !ce.sel.size || !p.view) return null;
  const ids = [...ce.sel];
  if (ids.length > 400 || ids.some((id) => !r.objs[id] || r.objs[id].ctx !== 'p')) return null;   // フォームの中のものは切り抜きで代用
  const key = cePrepKey(p);
  if (ce.prep && ce.prep.key === key) return ce.prep;
  const cv = p.el.querySelector(':scope > canvas'); if (!cv) return null;
  const W = cv.width, H = cv.height, view = p.view, gen = ce.gen;
  const prep = { key, ready: false, fg: null, bg: null };
  prep.promise = (async () => {
    const src = await ceDoc();
    if (gen !== ce.gen) return;
    const nd = await PDFDocument.create();
    const [pa] = await nd.copyPages(src, [p.num - 1]);           // 別々に複製する（同じ内容ストリームを共有しないように）
    const [pb] = await nd.copyPages(src, [p.num - 1]);
    nd.addPage(pa); nd.addPage(pb);
    CE.applyEdits(nd, CE.parsePage(nd, 0), ids.map((id) => ({ id, z: 'front' })), { isolate: true });
    CE.applyEdits(nd, CE.parsePage(nd, 1), ids.map((id) => ({ id, del: true })));
    const out = await nd.save({ useObjectStreams: false });
    if (gen !== ce.gen) return;
    const pdf = await pdfjsLib.getDocument(pdfjsOpts(out)).promise;
    try {
      for (const [n, k] of [[1, 'fg'], [2, 'bg']]) {
        const pg = await pdf.getPage(n), vp = pg.getViewport({ scale: view.scale });
        const c = document.createElement('canvas'); c.width = W; c.height = H;
        globalThis.__EPA_MINW = 0;
        await pg.render({ canvasContext: c.getContext('2d'), viewport: vp, transform: [W / vp.width, 0, 0, H / vp.height, 0, 0], background: k === 'fg' ? 'rgba(0,0,0,0)' : '#ffffff' }).promise;
        prep[k] = c;
      }
    } finally { pdf.destroy(); }
    if (gen !== ce.gen) return;
    prep.ready = true;
    if (ce.lift && ce.lift.p === p && ce.lift.key === key && !ce.lift.exact) ceLiftExact(p, prep);   // ドラッグ中に準備ができたら差し替え
  })().catch((e) => { console.warn('drag preview', e); });
  ce.prep = prep;
  return prep;
}
function ceSchedulePrep() {
  clearTimeout(ce.prepTimer);
  ce.prepTimer = setTimeout(() => { const p = S.pages[ce.page - 1]; if (S.tool === 'edit' && p && ce.sel.size) cePrepLift(p); }, 120);
}
/** 準備した画像で、ドラッグ中の表示を作る（選択範囲だけを切り出す） */
function ceLiftExact(p, prep) {
  const L = ce.lift; if (!L) return;
  const objs = ceObjs(); if (!objs.length) return;
  const cv = prep.fg, kx = cv.width / p.view.width, ky = cv.height / p.view.height;
  const U = ceUnion(objs);
  let [x0, y0, x1, y1] = vbox(p.view, U);
  x0 = Math.max(0, Math.floor(x0 - 2)); y0 = Math.max(0, Math.floor(y0 - 2)); x1 = Math.min(p.view.width, Math.ceil(x1 + 2)); y1 = Math.min(p.view.height, Math.ceil(y1 + 2));
  const w = x1 - x0, h = y1 - y0; if (w <= 0 || h <= 0) return;
  const crop = (srcCv) => {
    const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w * kx)); c.height = Math.max(1, Math.round(h * ky));
    c.getContext('2d').drawImage(srcCv, x0 * kx, y0 * ky, w * kx, h * ky, 0, 0, c.width, c.height);
    Object.assign(c.style, { position: 'absolute', left: x0 + 'px', top: y0 + 'px', width: w + 'px', height: h + 'px' });
    return c;
  };
  L.holes.replaceChildren(crop(prep.bg));                 // 元の場所: 取り除いたあとの見た目（上に重なっていたものは残る）
  L.mov.replaceChildren(crop(prep.fg));                   // 動かす: 選択したものだけ
  L.exact = true;
}
function ceLiftStart(p) {
  ceLiftEnd();
  const cv = p.el.querySelector(':scope > canvas'); if (!cv || !p.view) return;
  const objs = ceObjs(); if (!objs.length) return;
  const kx = cv.width / p.view.width, ky = cv.height / p.view.height;
  const layer = document.createElement('div'); layer.className = 'ce-layer';
  const holes = document.createElement('div'), mov = document.createElement('div'); mov.className = 'ce-mov';
  layer.append(holes, mov);
  p.el.insertBefore(layer, p.svg);
  const prep = cePrepLift(p);
  ce.lift = { p, layer, mov, holes, key: prep ? prep.key : null, exact: false };
  if (prep && prep.ready) { ceLiftExact(p, prep); return; }
  const rects = objs.length > 60 ? [ceUnion(objs)] : objs.map((o) => o.bbox);
  for (const bb of rects) {
    let [x0, y0, x1, y1] = vbox(p.view, bb);
    x0 = Math.max(0, Math.floor(x0 - 1)); y0 = Math.max(0, Math.floor(y0 - 1)); x1 = Math.min(p.view.width, Math.ceil(x1 + 1)); y1 = Math.min(p.view.height, Math.ceil(y1 + 1));
    const w = x1 - x0, h = y1 - y0; if (w <= 0 || h <= 0) continue;
    const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w * kx)); c.height = Math.max(1, Math.round(h * ky));
    try { c.getContext('2d').drawImage(cv, x0 * kx, y0 * ky, w * kx, h * ky, 0, 0, c.width, c.height); } catch { /* ignore */ }
    const st = { left: x0 + 'px', top: y0 + 'px', width: w + 'px', height: h + 'px' };
    Object.assign(c.style, st); mov.appendChild(c);
    const hd = document.createElement('div'); hd.className = 'ce-hole'; Object.assign(hd.style, st); holes.appendChild(hd);
  }
}
function ceLiftSet(T) {
  const L = ce.lift; if (!L || !L.p.view) return;
  const Vt = L.p.view.transform, Vi = CE.inv(Vt); if (!Vi) return;
  const M = CE.mul(CE.mul(Vi, T), Vt);
  L.mov.style.transform = `matrix(${M.map((v) => +v.toFixed(5)).join(',')})`;
}
function ceLiftEnd() { if (ce.lift) { ce.lift.layer.remove(); ce.lift = null; } }
/* ---- 選択 */
function ceSelect(ids, page) {
  ce.sel = new Set(ids); if (page) ce.page = page;
  ceRedraw(); syncProps(); updateButtons(); ceSchedulePrep();
}
function ceClear() { if (!ce.sel.size) return; ce.sel.clear(); ceRedraw(); syncProps(); updateButtons(); }
/* ---- 編集の確定（PDFを作り直して表示し直す） */
async function ceCommit(edits, msg = '編集中…', { selectDup = false, ...opts } = {}) {
  if (S.busy || !edits.length) { ceLiftEnd(); return false; }
  const sn = takeSnap(), page = ce.page; setBusy(true, msg);
  try {
    const doc = await ceDoc();
    const pr = await ceParse(page); if (pr.err) throw new Error(pr.err);
    const hints = CE.applyEdits(doc, pr.r, edits);
    if (edits.some((e) => pr.r.objs[e.id] && pr.r.objs[e.id].ctx !== 'p')) gcDoc(doc);
    const bytes = await doc.save({ useObjectStreams: false });
    ce.docBytes = bytes; ce.docP = Promise.resolve(doc); ce.ready.clear(); ce.pending.clear();
    ce.sel.clear(); ce.hover = null;
    await setBase(bytes); commit(sn);
    const r2 = await ceParse(page);
    if (r2.r) {
      const hs = hints.filter((h) => h.kind !== 'none' && (!selectDup || h.dup));
      ce.page = page; ce.sel = new Set(CE.findByHints(r2.r, hs));
    }
    ceRedraw(); syncProps(); updateButtons(); ceSchedulePrep();
    if (opts.zSkip && hints.zSkip) toast('フォームの中の文字・図形は、配置順を変えられません', 4000);
    return true;
  } catch (e) {
    console.error(e); ceLiftEnd();
    ce.docBytes = null; ce.docP = null; ce.ready.clear(); ce.pending.clear();     // 書き換え途中の文書は捨てる
    toast('編集できませんでした: ' + friendlyError(e), 7000);
    ceParse(page).then(() => ceRedraw());
    return false;
  } finally { setBusy(false); }
}
const ceT = (dx, dy) => [1, 0, 0, 1, dx, dy];
function ceScaleT(O, sx, sy) { return [sx, 0, 0, sy, O[0] - O[0] * sx, O[1] - O[1] * sy]; }
function ceDelete() { const ids = [...ce.sel]; if (ids.length) ceCommit(ids.map((id) => ({ id, del: true })), '削除中…'); }
function ceDuplicate() {
  const ids = [...ce.sel]; if (!ids.length) return;
  const p = S.pages[ce.page - 1], k = p && p.view ? 12 / p.view.scale : 10;
  const d = p && p.view ? CE.mul(CE.mul(CE.inv(p.view.transform), ceT(k * p.view.scale, k * p.view.scale)), p.view.transform) : ceT(10, -10);
  const T = ceT(d[4], d[5]);
  ceCommit(ids.map((id) => ({ id, dup: true, T })), '複製中…', { selectDup: true }).then((ok) => { if (ok) toast('複製しました（ドラッグで移動できます）'); });
}
function ceMove(dx, dy) { const ids = [...ce.sel]; if (ids.length) return ceCommit(ids.map((id) => ({ id, T: ceT(dx, dy) })), '移動中…'); }
/* ---- 入りと出 */
async function ceEnter() {
  if (!S.pdf) return;
  if (encLocked()) { toast('このPDFは編集ロック（セキュリティ設定）がかかっているため、内容の編集ができません。左の「文書プロパティ」でロックを解除できます。', 7000); setTool('select'); return; }
  const n = S.cur;
  $('#propTarget').textContent = '文字・図形を読み取り中…';
  const pr = await ceParse(n);
  if (S.tool !== 'edit') return;
  if (pr.err) toast('このページの内容を読み取れませんでした: ' + pr.err, 6000);
  else if (!pr.r.objs.some((o) => o.editable)) toast('このページには、編集できる文字・図形がありません（スキャンした画像のページなど）。', 5000);
  if (S.pages[n - 1]) redrawPage(S.pages[n - 1]);
  syncProps();
}
function ceLeave() { if (ce.editing) ceEndText(true); ce.sel.clear(); ce.hover = null; ce.drag = null; ce.marq = null; ceLiftEnd(); clearTimeout(ce.nudgeTimer); ce.nudge = null; }
/* ---- ポインタ操作 */
function ceDown(e) {
  if (ce.editing) {        // 文字の編集中に周りをクリック: 編集を確定するだけ（テキストコメントと同じ）
    if (e.target === ce.editing.ta) return;
    e.preventDefault(); ceEndText(true); return;
  }
  const p = pgOf(e.target); if (!p || !p.view) { ceClear(); return; }
  e.preventDefault();
  const r = ce.ready.get(p.num);
  if (!r) { ceParse(p.num).then(() => redrawPage(p)); return; }
  const xy = evXY(e, p), pt = toPdf(p, xy), tol = 4 / p.view.scale;
  const rEl = e.target.closest && e.target.closest('[data-cerot]');
  if (rEl && ce.sel.size && ce.page === p.num) {
    const U = ceUnion(ceObjs()), C = [(U[0] + U[2]) / 2, (U[1] + U[3]) / 2], P0 = toPdf(p, evXY(e, p));
    ce.drag = { mode: 'rot', p, C, a0: Math.atan2(P0[1] - C[1], P0[0] - C[0]), T: null };
    ceLiftStart(p); return;
  }
  const hEl = e.target.closest && e.target.closest('[data-ceh]');
  if (hEl && ce.sel.size && ce.page === p.num) {
    const U = ceUnion(ceObjs()), i = +hEl.dataset.ceh;
    const C = [[U[0], U[1]], [U[2], U[1]], [U[2], U[3]], [U[0], U[3]]];
    const Mid = C.map((c, k) => { const n2 = C[(k + 1) % 4]; return [(c[0] + n2[0]) / 2, (c[1] + n2[1]) / 2]; });
    const H = i < 4 ? C[i] : Mid[i - 4], O = i < 4 ? C[(i + 2) % 4] : Mid[(i - 4 + 2) % 4];
    ce.drag = { mode: 'scale', p, O, H, axis: i < 4 ? null : (i === 4 || i === 6 ? 'y' : 'x'), T: null, keep: ceObjs().some((o) => o.kind === 'text') };
    ceLiftStart(p); return;
  }
  const hits = ceHits(r, pt, tol, e.altKey);
  let top = hits.length ? hits[0] : null;
  if (e.altKey && hits.length) {                              // Alt+クリック: 重なっている下のオブジェクトを順に選ぶ
    const cur = ce.page === p.num && ce.sel.size === 1 ? [...ce.sel][0] : null;
    const k = cur === null ? -1 : hits.indexOf(cur);
    top = hits[(k + 1) % hits.length];
  }
  if (top === null) {
    if (!e.shiftKey && !e.ctrlKey) ceClear();
    ce.marq = { page: p.num, p, xy: [xy, xy.slice()], add: e.shiftKey || e.ctrlKey };
    ce.drag = { mode: 'marq', p };
    return;
  }
  if (ce.page !== p.num) { ce.sel.clear(); ce.page = p.num; }
  if (e.shiftKey || e.ctrlKey) {
    if (ce.sel.has(top)) ce.sel.delete(top); else ce.sel.add(top);
    ceSelect([...ce.sel], p.num); return;
  }
  if (!ce.sel.has(top)) ceSelect([top], p.num);
  ce.drag = { mode: 'move', p, start: pt, startXY: xy, T: null, moved: false };
}
// 「内容を編集」: ドラッグ中（移動・拡大縮小・回転・範囲選択）のポインタ移動
function ceMoveEv(e) {
  const d = ce.drag;
  if (d) {
    const p = d.p, xy = evXY(e, p), pt = toPdf(p, xy);
    if (d.mode === 'marq') { ce.marq.xy[1] = xy; redrawPage(p); return; }
    if (d.mode === 'move') {
      if (!d.moved && Math.hypot(xy[0] - d.startXY[0], xy[1] - d.startXY[1]) < 3) return;
      if (!d.moved) { d.moved = true; ceLiftStart(p); }
      let dx = pt[0] - d.start[0], dy = pt[1] - d.start[1];
      if (e.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
      d.T = ceT(dx, dy);
    } else if (d.mode === 'scale') {
      const { O, H } = d;
      let sx = d.axis === 'y' ? 1 : (pt[0] - O[0]) / ((H[0] - O[0]) || 1e-9), sy = d.axis === 'x' ? 1 : (pt[1] - O[1]) / ((H[1] - O[1]) || 1e-9);
      if (d.axis) { if (d.keep !== e.shiftKey) { const s = d.axis === 'x' ? sx : sy; sx = s; sy = s; } }   // 辺: その方向だけ（文字を含むときは縦横比を保つ）
      else if (d.keep !== e.shiftKey) { const s = Math.max(Math.abs(sx), Math.abs(sy)); sx = s; sy = s; }
      sx = Math.max(0.02, Math.abs(sx)); sy = Math.max(0.02, Math.abs(sy));
      d.T = ceScaleT(O, sx, sy);
    } else if (d.mode === 'rot') {
      let deg = (Math.atan2(pt[1] - d.C[1], pt[0] - d.C[0]) - d.a0) * 180 / Math.PI;
      if (e.shiftKey) deg = Math.round(deg / 15) * 15;
      const t = deg * Math.PI / 180, cs = Math.cos(t), sn = Math.sin(t), [cx, cy] = d.C;
      d.T = [cs, sn, -sn, cs, cx - cs * cx + sn * cy, cy - sn * cx - cs * cy];
    }
    ceLiftSet(d.T); redrawPage(p);
    return;
  }
  if (S.tool !== 'edit' || S.busy || ce.editing) return;
  const p = pgOf(e.target);
  if (!p || !p.view) { if (ce.hover !== null) { ce.hover = null; ceRedraw(); } return; }
  const r = ce.ready.get(p.num);
  if (!r) { ceParse(p.num).then(() => redrawPage(p)); return; }
  const xy = evXY(e, p);
  if (ce.hoverRaf) return;
  ce.hoverRaf = requestAnimationFrame(() => {
    ce.hoverRaf = 0;
    if (!p.view) return;
    const hits = ceHits(r, toPdf(p, xy), 4 / p.view.scale);
    const h = hits.length ? hits[0] : null;
    p.el.style.cursor = e.target.closest && e.target.closest('[data-ceh]') ? 'nwse-resize' : h !== null ? 'move' : '';
    if (h !== ce.hover || ce.hoverPage !== p.num) {
      const old = ce.hoverPage; ce.hover = h; ce.hoverPage = p.num;
      redrawPage(p); if (old && old !== p.num && S.pages[old - 1]) redrawPage(S.pages[old - 1]);
    }
  });
}
function ceUp(e) {
  const d = ce.drag; if (!d) return;
  ce.drag = null;
  if (d.mode === 'marq') {
    const m = ce.marq; ce.marq = null;
    const r = ce.ready.get(m.page); if (!r) { redrawPage(d.p); return; }
    const A = toPdf(d.p, m.xy[0]), B = toPdf(d.p, m.xy[1]);
    const box = [Math.min(A[0], B[0]), Math.min(A[1], B[1]), Math.max(A[0], B[0]), Math.max(A[1], B[1])];
    if (Math.hypot(m.xy[0][0] - m.xy[1][0], m.xy[0][1] - m.xy[1][1]) < 4) { redrawPage(d.p); return; }
    const inside = r.objs.filter((o) => o.editable && !o.bg && o.bbox[0] >= box[0] && o.bbox[1] >= box[1] && o.bbox[2] <= box[2] && o.bbox[3] <= box[3]).map((o) => o.id);
    const base = m.add && ce.page === m.page ? [...ce.sel] : [];
    ceSelect([...new Set([...base, ...inside])], m.page);
    if (inside.length) toast(`${ce.sel.size}個の文字・図形を選択しました`, 1800);
    return;
  }
  if (!d.T || (d.mode === 'move' && !d.moved)) { ceLiftEnd(); redrawPage(d.p); return; }
  const T = d.T;
  if (CE.isId(T)) { ceLiftEnd(); redrawPage(d.p); return; }
  ceCommit([...ce.sel].map((id) => ({ id, T })), d.mode === 'scale' ? '拡大縮小中…' : d.mode === 'rot' ? '回転中…' : '移動中…');
}
/* ---- 矢印キーで少しずつ移動（まとめて確定） */
function ceNudge(dx, dy) {
  const p = S.pages[ce.page - 1]; if (!p || !p.view) return;
  if (!ce.nudge) { ce.nudge = [0, 0]; ceLiftStart(p); }
  ce.nudge[0] += dx; ce.nudge[1] += dy;
  ceLiftSet(ceT(ce.nudge[0], ce.nudge[1]));
  clearTimeout(ce.nudgeTimer);
  ce.nudgeTimer = setTimeout(() => { const n = ce.nudge; ce.nudge = null; if (n && (n[0] || n[1])) ceMove(n[0], n[1]); else ceLiftEnd(); }, 450);
}
/* ---- 文字の書き換え */
const SERIF_RE = /Mincho|Ming|Song|Serif|Times|Roman|Garamond|Georgia|Century|明朝/i;
// 「内容を編集」: 文字の行をその場で書き換える入力欄を出す
function ceBeginText(o) {
  if (!o || o.kind !== 'text') return;
  const p = S.pages[ce.page - 1]; if (!p || !p.view) return;
  if (ce.editing) ceEndText(true);
  const sc = p.view.scale, [x0, y0, x1, y1] = vbox(p.view, o.bbox);
  const fsPx = Math.max(6, o.fsPage * sc);
  const ta = document.createElement('textarea'); ta.className = 'te ce-te'; ta.value = o.text.replace(/\s+$/, '');
  const col = hexOf(o.rgbFill) || '#000000';
  Object.assign(ta.style, { left: x0 - 3 + 'px', top: y0 - 3 + 'px', minWidth: Math.max(60, x1 - x0 + 24) + 'px', fontSize: fsPx + 'px',
    fontFamily: SERIF_RE.test(o.fontName) ? FONT_MINCHO : FONT_STACK, padding: '2px', color: col, background: 'rgba(255,255,255,.96)', lineHeight: '1.25' });
  if (o.vert) { ta.style.writingMode = 'vertical-rl'; ta.style.minHeight = Math.max(60, y1 - y0 + 24) + 'px'; }
  const hole = document.createElement('div'); hole.className = 'ce-hole'; Object.assign(hole.style, { position: 'absolute', left: x0 + 'px', top: y0 + 'px', width: x1 - x0 + 'px', height: y1 - y0 + 'px', zIndex: 4 });
  p.el.append(hole, ta);
  ce.editing = { o, ta, hole, page: ce.page };
  const grow = () => {
    if (o.vert) { ta.style.width = 'auto'; ta.style.width = ta.scrollWidth + 'px'; ta.style.height = Math.max(ta.scrollHeight, y1 - y0 + 24) + 'px'; return; }
    ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px';
    ta.style.width = 'auto'; ta.style.width = Math.max(ta.scrollWidth + 4, x1 - x0 + 24) + 'px';
  };
  ta.addEventListener('input', grow);
  ta.addEventListener('blur', () => ceEndText(true));
  ta.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); ceEndText(false); }
    else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); ceEndText(true); }
  });
  grow(); ta.focus(); ta.select();
  if (o.unknown) toast('一部の文字（�）を読み取れませんでした。その部分も入力し直してください。', 6000);
  else toast('文字を書き換えて Ctrl+Enter で確定（Escで取り消し）。改行もできます', 3500);
}
function ceEndText(commitIt) {
  const E = ce.editing; if (!E) return;
  ce.editing = null;
  const text = E.ta.value; E.ta.remove(); E.hole.remove();
  if (!commitIt || text === E.o.text.replace(/\s+$/, '')) return;
  const f = E.o.shows[0].font;
  const missing = [...text.replace(/\n/g, '')].filter((ch) => !(f && f.encodeChar && f.encodeChar(ch)));
  ceCommit([{ id: E.o.id, text }], '文字を置き換え中…').then((ok) => {
    if (!ok) return;
    if (text.trim() === '') toast('文字を削除しました');
    else if (missing.length) toast(`元のフォントに含まれない文字（${[...new Set(missing)].slice(0, 8).join('')}${missing.length > 8 ? '…' : ''}）は、代わりのフォント（ゴシック体／Helvetica）で表示します`, 7000);
    else toast('文字を置き換えました');
  });
}
/* ---- キー操作（内容の編集中） */
function ceKey(e) {
  const mod = e.ctrlKey || e.metaKey, k = e.key;
  if (mod && k.toLowerCase() === 'a') {
    e.preventDefault();
    const n = ce.sel.size ? ce.page : S.cur, r = ce.ready.get(n);
    if (r) { ceSelect(r.objs.filter((o) => o.editable && !o.bg).map((o) => o.id), n); toast(`${ce.sel.size}個の文字・図形を選択しました（背景は除く）`, 2000); }
    return true;
  }
  if (!ce.sel.size) return false;
  if (mod && k.toLowerCase() === 'd') { e.preventDefault(); ceDuplicate(); return true; }
  if (mod) return false;
  if (k === 'Escape') { ceClear(); return true; }
  if (k === 'Delete' || k === 'Backspace') { e.preventDefault(); ceDelete(); return true; }
  if (k === 'Enter') { const o = ceObjs(); if (o.length === 1 && o[0].kind === 'text') { e.preventDefault(); ceBeginText(o[0]); } return true; }
  if (k.startsWith('Arrow')) {
    e.preventDefault(); const st = e.shiftKey ? 10 : 1;
    const p = S.pages[ce.page - 1]; if (!p || !p.view) return true;
    const vx = k === 'ArrowLeft' ? -1 : k === 'ArrowRight' ? 1 : 0, vy = k === 'ArrowUp' ? -1 : k === 'ArrowDown' ? 1 : 0;
    const a = p.view.convertToPdfPoint(0, 0), b = p.view.convertToPdfPoint(vx, vy), l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    ceNudge((b[0] - a[0]) / l * st, (b[1] - a[1]) / l * st);
    return true;
  }
  return false;
}
/* ---- プロパティ欄 */
function ceSyncProps() {
  const objs = ceObjs();
  const texts = objs.filter((o) => o.kind === 'text'), paths = objs.filter((o) => o.kind === 'path');
  let title;
  $('#rowStartSz').style.visibility = 'hidden'; $('#rowEndSz').style.visibility = 'hidden';
  if (!objs.length) title = '内容の編集: 文字や図形をクリックして選択';
  else if (objs.length === 1) title = texts.length ? `選択中: 文字（${texts[0].fontName || 'フォント不明'}）` : '選択中: 図形（ベクター）';
  else title = `選択中: ${objs.length}個（文字${texts.length}・図形${paths.length}）`;
  $('#propTarget').textContent = title; $('#propTarget').classList.toggle('sel', objs.length > 0);
  const t0 = texts[0], p0 = paths[0], ps = paths.find((o) => o.stroke) || null, pf = paths.find((o) => o.fill) || null;
  const color = t0 ? hexOf(t0.rgbFill) : ps ? hexOf(ps.rgbStroke) : null;
  P.color.value = color || '#000000';
  P.fill.value = (pf && hexOf(pf.rgbFill)) || '#ffffff'; P.fill.classList.toggle('none', !pf || !pf.rgbFill);
  P.width.value = ps ? +ps.lwPage.toFixed(2) : 1;
  P.font.value = t0 ? +t0.fsPage.toFixed(1) : 12;
  for (const k of Object.keys(P)) P[k].disabled = true;
  P.opacityNum.disabled = true;
  P.color.disabled = !objs.length; P.fill.disabled = !paths.length; P.width.disabled = !paths.length; P.font.disabled = !texts.length;
  $('#pFillNone').disabled = !paths.some((o) => o.fill && o.stroke);
  P.width.min = '0';
  $('#rowFont').style.display = texts.length ? '' : 'none';
  $('#rowCloud').style.display = 'none';
  $('#lblColor').textContent = texts.length && !paths.length ? '文字の色(O) :' : paths.length && !texts.length ? '線の色(O) :' : '色(O) :';
  $('#lblWidth').textContent = '線の太さ(T) :';
  $('#natBox').style.display = 'none';
  $('#ceBox').style.display = '';
  $('#ceInfo').innerHTML = !objs.length
    ? 'クリックで選択／ドラッグで移動／四角のハンドルで拡大縮小／空白からドラッグで範囲選択／Alt+クリックで重なった下の図形'
    : objs.length === 1 && t0 ? `<b>文字:</b> ${esc(t0.text.length > 80 ? t0.text.slice(0, 80) + '…' : t0.text)}<br><span>${t0.fsPage.toFixed(1)}pt / ${esc(t0.fontName || '')}</span>`
      : objs.length === 1 && p0 ? `<b>図形:</b> ${p0.fill ? '塗り' : ''}${p0.fill && p0.stroke ? '＋' : ''}${p0.stroke ? '線 ' + p0.lwPage.toFixed(2) + 'pt' : ''}` : '';
  $('#ceText').disabled = !(objs.length === 1 && t0);
  $('#ceDup').disabled = !objs.length; $('#ceDel').disabled = !objs.length;
  $('#hintEnds').textContent = objs.length ? '※ドラッグで移動（Shiftで水平・垂直）／四隅・辺のハンドルで拡大縮小／上の丸いハンドルで回転（Shiftで15°刻み）／矢印キーで1pt／Ctrl+Dで複製／Deleteで削除' : '';
}
// 「内容を編集」: プロパティ欄で変えた色・太さなどを、選択中のものにまとめて反映する
function ceApplyPending() {
  const pend = ce.pend; ce.pend = {};
  const keys = Object.keys(pend); if (!keys.length || !ce.sel.size) return;
  const edits = [];
  for (const o of ceObjs()) {
    const ed = { id: o.id }; let any = false;
    if ('color' in pend) { if (o.kind === 'text') ed.fill = pend.color; else ed.stroke = pend.color; any = true; }
    if ('fill' in pend && o.kind === 'path') { if (pend.fill === null && !o.stroke) { /* 線の無い図形の塗りは消さない */ } else { ed.fill = pend.fill; any = true; } }
    if ('width' in pend && o.kind === 'path') { ed.lw = pend.width; any = true; }
    if ('fontSize' in pend && o.kind === 'text' && o.fsPage > 0) { const k = pend.fontSize / o.fsPage; ed.T = ceScaleT(o.origin, k, k); any = true; }
    if (any) edits.push(ed);
  }
  if (edits.length) ceCommit(edits, '変更を反映中…');
}
$('#ceText').addEventListener('click', () => { const o = ceObjs(); if (o.length === 1) ceBeginText(o[0]); });
$('#ceDup').addEventListener('click', ceDuplicate);
$('#ceDel').addEventListener('click', ceDelete);
pagesEl.addEventListener('dblclick', (e) => {
  if (S.tool !== 'edit' || S.busy) return;
  const p = pgOf(e.target), r = p && ce.ready.get(p.num); if (!r || !p.view) return;
  const hits = ceHits(r, toPdf(p, evXY(e, p)), 4 / p.view.scale);
  const o = hits.map((id) => r.objs[id]).find((x) => x.kind === 'text');
  if (o) { ceSelect([o.id], p.num); ceBeginText(o); }
});
window.addEventListener('pointermove', ceMoveEv);
window.addEventListener('pointerup', ceUp);
/* ------------------------------------------------------------ キー操作 */
const ARROW_STEP = 80;
/** 矢印キー（図形を選択していないとき）: 上下=スクロール（1ページ表示では端でページ切り替え）、左右=左右スクロール（動かせないときはページ切り替え） */
function arrowNav(e) {
  const t = e.target;
  if (t && t.tagName === 'INPUT' && t.type === 'range') return;          // スライダーはそのまま操作できるように
  const k = e.key;
  e.preventDefault();
  const sgn = (k === 'ArrowDown' || k === 'ArrowRight') ? 1 : -1;
  if (k === 'ArrowUp' || k === 'ArrowDown') {
    if (S.paged) pagedStep(sgn, true, ARROW_STEP);
    else wrap.scrollBy({ top: ARROW_STEP * sgn });
    return;
  }
  if (wrap.scrollWidth > wrap.clientWidth + 1) { wrap.scrollBy({ left: ARROW_STEP * sgn }); return; }
  if (S.paged) keyFlip(sgn);
  else if (!e.repeat || performance.now() - lastKeyFlip > 90) { lastKeyFlip = performance.now(); goPage(S.cur + sgn); }
}
window.addEventListener('keydown', (e) => {
  if (org.open) { orgKey(e); return; }
  if ($('#dlg').open) return;
  const tag = (e.target.tagName || '').toLowerCase();
  const typing = (tag === 'input' && !['checkbox', 'range', 'color'].includes(e.target.type)) || tag === 'textarea' || tag === 'select';
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); if (!e.repeat) save(e.shiftKey); return; }   // 押し続けても1回だけ
  if (mod && e.key.toLowerCase() === 'o') { e.preventDefault(); openFileDialog(); return; }
  if (mod && e.key.toLowerCase() === 'p') { e.preventDefault(); printDoc(); return; }
  if (mod && e.key.toLowerCase() === 'f' && !org.open) { e.preventDefault(); openFind(); return; }
  if (e.key === 'F3' && S.pdf) { e.preventDefault(); if (!FIND.open) openFind(); else findStep(e.shiftKey ? -1 : 1); return; }
  if (typing) return;
  if (mod && e.key.toLowerCase() === 'b' && S.pdf && !S.busy) { e.preventDefault(); if (encLocked()) toast('このPDFは編集ロックがかかっているため、しおりを追加できません。', 5000); else bmAdd(); return; }
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
  if (mod && (e.key === '+' || e.key === '=')) { e.preventDefault(); stepZoom(S.scale * 1.15); return; }
  if (mod && e.key === '-') { e.preventDefault(); stepZoom(S.scale / 1.15); return; }
  if (mod && S.pdf && !S.busy && (e.code === 'BracketRight' || e.code === 'BracketLeft') && (S.tool === 'edit' ? ce.sel.size : (isSelTool() && S.sel.size))) {
    e.preventDefault(); zOrder(e.code === 'BracketRight' ? (e.shiftKey ? 'front' : 'forward') : (e.shiftKey ? 'back' : 'backward')); return;
  }
  if (S.tool === 'edit' && !S.busy && S.pdf && ceKey(e)) return;
  if (mod && isSelTool() && S.pdf && !S.busy && e.key.toLowerCase() === 'g') { e.preventDefault(); convertToInk(); return; }
  if (mod && isSelTool() && S.pdf && !S.busy && e.key.toLowerCase() === 'd' && selOurs().length) {   // 複製
    e.preventDefault(); const keep = clip.items, km = clip.mark, kn = clip.n;
    if (copyAnnots()) { pasteAnnots(); }
    if (keep) { clip.items = keep; clip.mark = km; clip.n = kn; }
    return;
  }
  if (mod && S.tool === 'asel' && S.pdf && e.key.toLowerCase() === 'a') {
    e.preventDefault();
    S.sel = new Set([...S.annots.filter((a) => a.page === S.cur).map((a) => a.id), ...S.natives.filter((n) => n.page === S.cur).map((n) => n.key)]);
    redrawAll(); syncProps(); updateButtons(); scheduleList(); toast(`${S.sel.size}個の注釈を選択しました`, 1800); return;
  }
  if (mod) return;
  if (S.busy) return;
  if (e.key === 'Escape') { if (S.draft && isMulti(S.draft.type)) finishPoly(); else if (S.draft) cancelDraft(); else if (isSelTool() && S.sel.size) select(null); else if (S.tool !== 'select') setTool('select'); return; }
  if (S.draft && isMulti(S.draft.type)) {
    if (e.key === 'Enter') { e.preventDefault(); finishPoly(); return; }
    if (e.key === 'Backspace') { e.preventDefault(); if (S.draft.pts.length > 2) { const c = S.draft.pts.pop(); S.draft.pts.pop(); S.draft.pts.push(c); redrawPage(S.pages[S.draft.page - 1]); } return; }
  }
  if (S.paged && S.pdf && (e.key === 'PageDown' || e.key === 'PageUp')) { e.preventDefault(); pagedStep(e.key === 'PageDown' ? 1 : -1, true); return; }
  const k = e.key.toLowerCase();
  if (k === 'v') setTool('select'); else if (k === 'g') setTool('edit'); else if (k === 'a') setTool('asel'); else if (k === 'l') setTool('line'); else if (k === 'r') setTool('rect'); else if (k === 'e') setTool('ellipse');
  else if (k === 'p') setTool('polyline'); else if (k === 'n') setTool('polygon'); else if (k === 'c') setTool('cloud'); else if (k === 't') { e.preventDefault(); setTool('text'); }
  const a = selAnnot(), nat = selNative();
  if (a && a.type === 'text' && e.key === 'Enter') { e.preventDefault(); beginEdit(a, false); return; }
  if (nat && e.key === 'Enter') { e.preventDefault(); editNativeContents(nat.key); return; }
  if (S.sel.size && (e.key === 'Delete' || e.key === 'Backspace')) { e.preventDefault(); deleteSelected(); return; }
  const movers = selOurs();
  if (movers.length && e.key.startsWith('Arrow')) {
    e.preventDefault(); const st = e.shiftKey ? 10 : 1;
    const dx = e.key === 'ArrowLeft' ? -st : e.key === 'ArrowRight' ? st : 0, dy = e.key === 'ArrowUp' ? st : e.key === 'ArrowDown' ? -st : 0;
    const snap = takeSnap();
    for (const m of movers) mapAnnot(m, clone(m), (q) => [q[0] + dx, q[1] + dy]);
    redrawAll(); commit(snap);
  } else if (!movers.length && S.pdf && !e.altKey && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) arrowNav(e);
});
/* ------------------------------------------------------------ 保存 */
/* 「保存」: ダイアログなし。保存先ファイルが分かっていれば上書き、無ければダウンロードフォルダへ（同名は上書き）。
 * 「名前を付けて保存」: 保存先ダイアログ。ブラウザのファイルAPIが使えない環境では、ブラウザー標準の保存ダイアログ(downloads API)に切り替える。 */
const PDF_PICKER_TYPES = [{ description: 'PDF', accept: { 'application/pdf': ['.pdf'] } }];
const urlKey = (u) => { try { const x = new URL(u); return x.origin + x.pathname + x.search; } catch { return String(u); } };
const urlFileName = (u) => { try { return decodeURIComponent(new URL(u).pathname.split('/').filter(Boolean).pop() || ''); } catch { return ''; } };
const safeName = (n) => (String(n).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^[.\s]+|[\s.]+$/g, '') || 'document');
const pdfName = (n) => safeName(/\.pdf$/i.test(n) ? n : n + '.pdf');
const IDB = {
  db: null,
  async open() {
    if (this.db) return this.db;
    this.db = await new Promise((res, rej) => {
      const r = indexedDB.open('epa', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('handles');
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    return this.db;
  },
  async get(k) {
    try { const db = await this.open(); return await new Promise((res, rej) => { const q = db.transaction('handles').objectStore('handles').get(k); q.onsuccess = () => res(q.result || null); q.onerror = () => rej(q.error); }); }
    catch { return null; }
  },
  async set(k, v) {
    try { const db = await this.open(); await new Promise((res, rej) => { const t = db.transaction('handles', 'readwrite'); t.objectStore('handles').put(v, k); t.oncomplete = res; t.onerror = () => rej(t.error); }); }
    catch (e) { console.warn('IDB set', e); }
  },
};
async function ensureWrite(h) {
  try {
    if (!h.queryPermission) return true;
    if ((await h.queryPermission({ mode: 'readwrite' })) === 'granted') return true;
    return (await h.requestPermission({ mode: 'readwrite' })) === 'granted';
  } catch { return false; }
}
async function writeHandle(h, bytes) {
  await pinBase();                                      // v4.11.2: 読んでいる元のファイルに上書きするかもしれないので、先にメモリに固定する
  assertPdfBytes(bytes);
  const w = await h.createWritable();
  try { await w.write(new Blob([bytes], { type: 'application/pdf' })); await w.close(); }
  catch (e) { try { await w.abort(); } catch { /* ignore */ } throw e; }
}
async function rememberHandle(h) { if (S.sourceUrl && h && h.name === urlFileName(S.sourceUrl)) await IDB.set(urlKey(S.sourceUrl), h); }
async function restoreHandle() {
  if (!S.sourceUrl || S.fileHandle) return null;
  const h = await IDB.get(urlKey(S.sourceUrl));
  if (h && h.name === urlFileName(S.sourceUrl)) S.fileHandle = h;
  return S.fileHandle;
}
const hasDownloads = () => !!(hasChrome && chrome.downloads && chrome.downloads.download);
const cbp = (fn) => new Promise((res, rej) => fn((v) => (chrome.runtime.lastError ? rej(new Error(chrome.runtime.lastError.message)) : res(v))));
async function downloadBytes(bytes, filename, { saveAs = false } = {}) {
  await pinBase();
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  try {
    if (hasDownloads()) {
      let id;
      try { id = await cbp((cb) => chrome.downloads.download({ url, filename, saveAs, conflictAction: saveAs ? 'prompt' : 'overwrite' }, cb)); }
      catch (e) { if (/cancel/i.test(e.message)) return null; throw e; }
      if (id === undefined) return null;
      const st = await new Promise((resolve) => {
        const fin = (v) => { chrome.downloads.onChanged.removeListener(on); resolve(v); };
        const on = (d) => { if (d.id !== id || !d.state) return; if (d.state.current === 'complete') fin({ ok: true }); else if (d.state.current === 'interrupted') fin({ ok: false, err: d.error && d.error.current }); };
        chrome.downloads.onChanged.addListener(on);
        chrome.downloads.search({ id }, (r) => { const it = r && r[0]; if (it && it.state === 'complete') fin({ ok: true }); else if (it && it.state === 'interrupted') fin({ ok: false, err: it.error }); });
        setTimeout(() => fin({ ok: true, late: true }), 60000);
      });
      if (!st.ok) { if (st.err === 'USER_CANCELED') return null; throw new Error('ダウンロードに失敗しました: ' + (st.err || '不明')); }
      const [it] = await cbp((cb) => chrome.downloads.search({ id }, cb));
      return (it && it.filename) || filename;
    }
    const a = document.createElement('a'); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
    return filename;
  } finally { setTimeout(() => URL.revokeObjectURL(url), 60000); }
}
function showError(title, e) {
  const msg = friendlyError(e), raw = (e && (e.stack || e.message)) || String(e);
  return dialog({ title, ok: 'OK',
    html: `<p style="white-space:pre-wrap">${esc(msg)}</p><details open><summary>詳細（開発者への連絡用）</summary><textarea readonly rows="6" style="width:480px;max-width:80vw">${esc(`${e && e.name ? e.name + ': ' : ''}${(e && e.message) || ''}\n${raw}\nv4.11 / ${navigator.userAgent}`)}</textarea></details>` });
}
// 保存（上書き／名前を付けて保存）。可能ならファイルに直接書き込み、できなければダウンロードにする
// file:// のURL → PCのパス（Windows: C:\...、共有フォルダ: \\サーバー\...、それ以外: /...）
function fileUrlToPath(u) {
  try {
    const x = new URL(u); if (x.protocol !== 'file:') return '';
    const p = decodeURIComponent(x.pathname);
    if (x.host && x.host !== 'localhost') return '\\\\' + x.host + p.replace(/\//g, '\\');
    if (/^\/[A-Za-z]:/.test(p)) return p.slice(1).replace(/\//g, '\\');
    return p;
  } catch { return ''; }
}
// 元のPDFの場所を選んでもらう保存先の選択画面。ブラウザーは、選択画面のファイル名欄にフォルダーのパスを入れることを許さない
// （「\」「:」が「_」に置き換えられる）ため、元のPDFのフルパスをクリップボードにコピーし、ファイル名欄で Ctrl+V で貼り付けてもらう。
// 拡張子（.pdf）はコピーしない: ファイル名欄で選択されているのが名前の部分だけでも、全体でも、貼り付けると正しいパスになる（.pdf は画面が補う）
// 保存先の選択画面を開く。戻り値 { h } または { e }（キャンセルは AbortError）。
// 注意: ブラウザーは、選択画面で既存のファイルを選んだ時点で、そのファイルを0バイトに切り詰める。
//       そのため、この画面は「保存用のPDFを作り終えてから」開く（作成に失敗したとき、元のファイルを空にしないため）。
// toOriginal: ダブルクリックで開いたPDFの最初の［保存］。元のPDFのフルパスをコピーし、ファイル名欄に Ctrl+V で貼り付けてもらう
//   （ブラウザーは、ファイル名欄にフォルダーのパスを入れることを許さない。「\」「:」が「_」に置き換えられる）。
//   拡張子（.pdf）はコピーしない: ファイル名欄で選択されているのが名前の部分だけでも、全体でも、正しいパスになる（.pdf は画面が補う）
async function pickSaveTarget(suggestedName, toOriginal) {
  if (toOriginal) {
    const path = fileUrlToPath(S.sourceUrl);
    if (path) {
      try {
        await navigator.clipboard.writeText(path.replace(/\.pdf$/i, ''));
        toast(`元のPDFに上書きするには、保存画面のファイル名欄で Ctrl+V を押して［保存］→［はい］。（元のPDFの場所をコピーしました: ${path}）`, 30000);
      } catch { toast(`元のPDFに上書きするには、保存画面で次の場所を選んでください: ${path}`, 30000); }
    }
  }
  // PDFの作成に時間がかかり、ボタンを押した直後の操作と見なされなくなったときは、もう一度ボタンを押してもらう（ブラウザーの決まり）
  if (navigator.userActivation && !navigator.userActivation.isActive) {
    const ok = await dialog({ title: '保存先を選ぶ', ok: '保存先を選ぶ', html: '<p>保存用のPDFができました。［保存先を選ぶ］を押して、保存先を選んでください。</p>' });
    if (!ok) return { e: new DOMException('キャンセルしました', 'AbortError') };
  }
  return window.showSaveFilePicker({ suggestedName, id: 'epa-pdf', types: PDF_PICKER_TYPES }).then((h) => ({ h }), (e) => ({ e }));
}
// 書き込む前の確認: 中身がPDFとして正しくなければ、どのファイルにも書き込まない（空のファイルで上書きしないため）
function assertPdfBytes(bytes) {
  const ok = bytes && bytes.length > 64 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;   // %PDF
  if (!ok) throw new Error(`保存用のPDFを正しく作れませんでした（${bytes ? bytes.length : 0}バイト）。元のファイルは変更していません。`);
}
// 戻り値: 保存できたら true（キャンセル・失敗は false）
async function save(saveAs = false) {
  if (!S.pdf || S.busy) return false;
  if (S.editing) endEdit(true);
  const base = S.fileName.replace(/\.pdf$/i, '');
  let step = '準備';
  try {
    let handle = null;
    if (!saveAs) {
      handle = S.fileHandle || (await restoreHandle());
      if (handle && !(await ensureWrite(handle))) handle = null;
    }
    // ダブルクリックで開いたPDF（file://）で、上書き先がまだ分からないとき: 保存先の選択画面で、元のPDFの場所を選んでもらう
    const toOriginal = !saveAs && !handle && !!window.showSaveFilePicker && !!S.sourceUrl && /^file:/i.test(S.sourceUrl);
    const pickIt = (saveAs && !!window.showSaveFilePicker) || toOriginal;
    // ① 先に保存用のPDFを作る。失敗したら、保存先のファイルには一切触れずに終える
    setBusy(true, '保存用PDFを作成中…'); step = 'PDFの作成';
    const bytes = await buildPdfBytes();
    assertPdfBytes(bytes);
    let msg;
    if (saveAs || toOriginal) {
      // ② できてから、保存先を選んでもらう
      setBusy(false); step = '保存先の選択';
      const r = pickIt ? await pickSaveTarget(saveAs ? `${base}.pdf` : (urlFileName(S.sourceUrl) || pdfName(S.fileName)), toOriginal) : null;
      if (r && r.e && r.e.name === 'AbortError') { toast('保存をキャンセルしました'); return false; }
      if (r && r.h) {
        step = 'ファイルへの書き込み'; setBusy(true, 'ファイルに書き込み中…');
        await writeHandle(r.h, bytes);
        S.fileHandle = r.h; S.fileName = r.h.name; $('#fileName').textContent = r.h.name; document.title = `${r.h.name} - PDFエディター`;
        await rememberHandle(r.h); msg = `保存しました: ${r.h.name}`;            // 次からは、このファイルに直接上書きする
      } else {
        step = '名前を付けて保存（ダウンロード）'; setBusy(false);
        const path = await downloadBytes(bytes, pdfName(base), { saveAs: true });
        if (path === null) { toast('保存をキャンセルしました'); return false; }
        msg = `保存しました: ${path}`;
      }
    } else if (handle) {
      try {
        step = 'ファイルへの書き込み'; setBusy(true, 'ファイルに書き込み中…');
        await writeHandle(handle, bytes); S.fileHandle = handle; msg = `上書き保存しました: ${handle.name}`;
      } catch (e) {
        console.warn('direct write failed', e); step = 'ダウンロード';
        const path = await downloadBytes(bytes, pdfName(S.fileName), { saveAs: false });
        msg = `元のファイルへ直接書き込めなかったため、次の場所に保存しました: ${path}`;
      }
    } else {
      step = 'ダウンロード'; setBusy(true, '保存中…');
      const path = await downloadBytes(bytes, pdfName(S.fileName), { saveAs: false });
      msg = `保存しました: ${path}`;
    }
    S.dirty = false; toast(msg, 6000);
    return true;
  } catch (e) {
    console.error(e); setBusy(false);
    await showError(`保存できませんでした（${step}）`, e);
    return false;
  } finally { setBusy(false); }
}
$('#btnSave').addEventListener('click', () => save(false));
$('#btnSaveAs').addEventListener('click', () => save(true));
/* ---- 保存していない変更の確認
   「保存（既定・Enter）／保存しない／キャンセル」を選ぶダイアログ。戻り値: 'save' | 'discard' | 'cancel' */
function askSaveChanges(action) {
  return new Promise((res) => {
    const dlg = $('#dlg'); let result = 'cancel';
    if (dlg.open) { res('cancel'); return; }
    dlg.innerHTML = `<form method="dialog" class="savedlg">
      <div class="sv-head"><svg viewBox="0 0 24 24" class="sv-ico"><path d="M5 3h11l3 3v15H5z" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linejoin="round"/><path d="M8 3v5h7V3M8 21v-7h8v7" stroke="currentColor" stroke-width="1.8" fill="none"/></svg>
        <h3>${esc(action)}前に「${esc(S.fileName)}」への変更を保存しますか？</h3></div>
      <p class="sv-msg">保存しないと変更内容は失われます。</p>
      <div class="sv-btn"><button type="button" id="svNo">保存しない</button><span class="grow"></span><button type="button" id="svCancel">キャンセル</button><button type="submit" id="svYes" class="pri">保存</button></div></form>`;
    dlg.querySelector('form').addEventListener('submit', (e) => { e.preventDefault(); result = 'save'; dlg.close(); });
    $('#svNo').onclick = () => { result = 'discard'; dlg.close(); };
    $('#svCancel').onclick = () => { result = 'cancel'; dlg.close(); };
    dlg.addEventListener('close', () => res(result), { once: true });
    dlg.showModal(); $('#svYes').focus();      // 既定は「保存」（Enter で保存）
  });
}
// 保存していない変更があれば確認する。続けてよければ true（保存した／保存しないを選んだ）
async function confirmUnsaved(action) {
  if (!S.dirty || !S.pdf) return true;
  if (S.editing) endEdit(true);
  const r = await askSaveChanges(action);
  if (r === 'cancel') return false;
  if (r === 'save') return await save(false);
  return true;
}
// このタブを閉じる（拡張機能のページなので chrome.tabs で閉じられる）
function closeTab() {
  S.dirty = false;
  try { if (hasChrome && chrome.tabs && chrome.tabs.getCurrent) { chrome.tabs.getCurrent((t) => (t ? chrome.tabs.remove(t.id) : window.close())); return; } } catch {}
  window.close();
}
// タブ／ウィンドウを閉じるとき: ブラウザーの決まった確認しか出せないため、まずそれを出し、
// 「キャンセル（このページに留まる）」を選んだら、続けて「保存／保存しない／キャンセル」のダイアログを出す
window.addEventListener('beforeunload', (e) => {
  if (!S.dirty) return;
  e.preventDefault(); e.returnValue = '';
  setTimeout(async () => {                   // ページを離れた場合は実行されない（留まったときだけ動く）
    const r = await askSaveChanges('閉じる');
    if (r === 'discard') closeTab();
    else if (r === 'save' && (await save(false))) closeTab();
  }, 0);
});
/* ------------------------------------------------------- 開く / 取得 */
// ファイルの中身: 大きなファイルは、必要な部分だけをその都度読む（LazyPdf）。小さなファイルは、これまでどおり全体を読む
const fileSource = async (f) => (f.size >= LAZY_MIN ? lazyFromFile(f) : new Uint8Array(await f.arrayBuffer()));
async function openFileDialog() {
  if (!(await confirmUnsaved('別のPDFを開く'))) return;
  try {
    if (window.showOpenFilePicker) {
      const [h] = await window.showOpenFilePicker({ types: PDF_PICKER_TYPES });
      const f = await h.getFile(); await loadFromBytes(await fileSource(f), f.name, { handle: h });
    } else {
      const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.pdf,application/pdf';
      inp.onchange = async () => { const f = inp.files[0]; if (f) await loadFromBytes(await fileSource(f), f.name); };
      inp.click();
    }
  } catch (e) { if (e && e.name !== 'AbortError') { console.error(e); showMsg(`<p>PDFを開けませんでした。</p><p class="small">${esc(e.message || e)}</p><button type="button">PDFファイルを開く</button>`, true); } }
}
$('#btnOpen').addEventListener('click', openFileDialog);
$('#btnOpen2').addEventListener('click', openFileDialog);
// URL（PCに保存したPDFの file:// のURLだけ）からPDFを取得して開く
async function loadFromUrl(url) {
  // 拡張機能として動いているときは file:// だけ。開発時に http のテスト用サーバーから動かしている場合だけ、同じサーバーのPDFも開ける
  const devServer = /^https?:$/.test(location.protocol) && url.startsWith(location.origin + '/');
  if (!/^file:/i.test(url) && !devServer) {
    showMsg('<p>このエディターで開けるのは、PCに保存したPDFだけです。</p><p class="small">「PDFファイルを開く」から選ぶか、PDFファイルをここにドラッグ＆ドロップしてください。</p><button type="button">PDFファイルを開く</button>', true);
    return;
  }
  showMsg('<p>読み込み中…</p>');
  try {
    // 大きなファイルは、範囲を指定して読めれば（file:// は読める）、全体を読み込まずに開く
    let buf = /^file:/i.test(url) ? await lazyFromUrl(url) : null;
    if (!buf) {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      buf = new Uint8Array(await r.arrayBuffer());
    }
    let name = 'document.pdf';
    try { const u = new URL(url); name = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || name); if (!/\.pdf$/i.test(name)) name += '.pdf'; } catch { /* ignore */ }
    const m = /[#&]page=(\d+)/.exec(url);
    await loadFromBytes(buf, name, { url, page: m ? +m[1] : 1 });
    restoreHandle();
  } catch (e) {
    console.error(e);
    const fileHint = /^file:/i.test(url) ? '<p class="small">ローカルファイルを開くには、拡張機能の管理画面（chrome://extensions または edge://extensions）でこの拡張機能の詳細を開き、「ファイルの URL へのアクセスを許可する」をオンにしてください。<br>または「PDFファイルを開く」から選択/ドラッグ＆ドロップしてください。</p>' : '';
    showMsg(`<p>PDFを読み込めませんでした。</p><p class="small">${esc(e.message || e)}</p>${fileHint}<button type="button">PDFファイルを開く</button>`, true);
  }
}
/* ------------------------------------------------- ドラッグ＆ドロップ */
let dragDepth = 0;
const hasFiles = (e) => e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');
window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e) || org.open) return;
  dragDepth++; $('#dropHint').textContent = S.pdf ? 'PDFをドロップ → ページを挿入（Shiftを押しながらで開き直す／画像はスタンプに）' : 'PDFをドロップして開く';
  $('#dropHint').classList.add('on');
});
window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('#dropHint').classList.remove('on'); });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', async (e) => {
  e.preventDefault(); dragDepth = 0; $('#dropHint').classList.remove('on');
  if (org.open || $('#dlg').open || !e.dataTransfer) return;
  const files = [...e.dataTransfer.files]; if (!files.length) return;
  const pdf = files.find((f) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
  const img = files.find((f) => f.type.startsWith('image/'));
  if (pdf) {
    if (!S.pdf || e.shiftKey) {
      if (!(await confirmUnsaved('別のPDFを開く'))) return;
      try {
        const it = [...e.dataTransfer.items].find((x) => x.kind === 'file' && x.type === 'application/pdf');
        let h = null; if (it && it.getAsFileSystemHandle) { h = await it.getAsFileSystemHandle(); if (h && h.kind !== 'file') h = null; }
        const f = h ? await h.getFile() : pdf;
        await loadFromBytes(await fileSource(f), f.name, { handle: h });
      } catch (err) { console.error(err); toast('PDFを開けませんでした: ' + err.message, 5000); }
    } else {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const pgEl = el && el.closest ? el.closest('.pg') : null;
      await actInsert(pdf, pgEl ? +pgEl.dataset.num : S.cur);
    }
  } else if (img && S.pdf) await addStampFromBlob(img);
});
/* ------------------------------------------------------- ズーム / ページ移動 UI */
function chooseZoom(v) {
  S.fitMem = null; S.fitMemScale = 0;                                       // 倍率を直接選んだときは、「元に戻す」記憶を捨てる
  if (v === 'height' || v === 'page') setZoom(v, null, true);
  else if (v === 'width') setZoom('width', null, false);
  else setZoom(null, parseFloat(v));
}
$('#selZoom').addEventListener('change', (e) => { chooseZoom(e.target.value); e.target.blur(); });   // 選択後は矢印キーでスクロールできるように、フォーカスを外す
$('#btnZoomIn').addEventListener('click', () => stepZoom(S.scale * 1.15));
$('#btnZoomOut').addEventListener('click', () => stepZoom(S.scale / 1.15));
$('#btnFitH').addEventListener('click', () => { S.fitMem = null; S.fitMemScale = 0; setZoom('height', null, true); });
/* ホイール
 *  ・Ctrl+ホイール: マウスカーソルを中心に拡大縮小（ピクセル拡大で追従し、止まってから再描画）
 *    「縦に収める」「ページ全体」のときは、収まる大きさより小さくはならず、拡大したあと元の大きさまで縮小すると、その表示に戻る
 *  ・横ホイール（サイドホイール）/ Shift+ホイール: 左右スクロールだけ（Ctrlを押していても拡大縮小しない）
 *  ・1ページ表示: ページの端でさらに回すと隣のページへ。回し続けるかぎり連続して切り替わる（表示が追いつくのを待ちながら、詰まらず進む） */
const wheelSt = { t: 0, acc: 0, armed: false, dir: 0, until: 0 };
wrap.addEventListener('wheel', (e) => {
  if (org.open) return;
  const px = (v) => (e.deltaMode === 1 ? v * 16 : e.deltaMode === 2 ? v * wrap.clientHeight : v);
  const dx = px(e.deltaX), dy = px(e.deltaY);
  const horiz = Math.abs(dx) > Math.abs(dy);
  if (e.ctrlKey) {
    e.preventDefault();
    if (horiz || dy === 0) { wrap.scrollLeft += dx; return; }            // Ctrl+サイドホイール: 左右スクロールのみ
    const factor = Math.abs(dy) >= 40 ? Math.pow(1.1, -dy / 100) : Math.exp(-dy * 0.01);   // ホイール1ノッチ≒10%、トラックパッドのピンチは細かく
    zoomByFactor(factor, { x: e.clientX, y: e.clientY });
    return;
  }
  if (horiz || e.shiftKey) return;                                       // 左右スクロールはブラウザ標準に任せる
  if (!S.paged || !S.pdf || S.busy) return;
  const now = performance.now(), gap = now - wheelSt.t; wheelSt.t = now;
  const dir = Math.sign(dy);
  if (!dir) return;
  if (gap > 180 || dir !== wheelSt.dir) { wheelSt.acc = 0; wheelSt.dir = dir; wheelSt.armed = edgeNow(dir); }
  if (!edgeNow(dir)) return;
  e.preventDefault();
  if (!wheelSt.armed) return;
  wheelSt.acc = Math.min(wheelSt.acc + Math.abs(dy), 200);
  if (now < wheelSt.until || wheelSt.acc < 60) return;
  if (!advance(dir)) return;                                             // ホイール1ノッチで1ページ（回し続ければ、描画を待たずに次々と送る）
  wheelSt.acc = 0; wheelSt.until = now + 12;
  wheelSt.armed = fitPaged();
}, { passive: false });
let rz; window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => { if (!S.pdf) return; if (['width', 'page', 'height'].includes(S.fit)) setZoom(S.fit); else updatePgBar(); }, 200); });
$('#pageNum').addEventListener('change', (e) => { goPage(parseInt(e.target.value) || 1); e.target.blur(); });
let rafScroll = 0;
wrap.addEventListener('scroll', () => {
  if (S.paged || rafScroll) return; rafScroll = requestAnimationFrame(() => {
    rafScroll = 0; const mid = wrap.scrollTop + wrap.clientHeight / 2;
    for (const p of S.pages) {
      if (p.el.offsetTop + p.el.offsetHeight > mid) { S.cur = S.want = p.num; if (document.activeElement !== $('#pageNum')) $('#pageNum').value = p.num; break; }
    }
  });
});
/* 文字の描画方式 / 文字・線の濃さ / アンチエイリアス */
$('#selText').value = S.textMode;
$('#selText').addEventListener('change', async (e) => {
  S.textMode = e.target.value; LS.set('textMode', S.textMode);
  if (!S.pdf) return;
  setBusy(true, '描画方式を切り替え中…');
  try { await setBase(S.baseBytes); } catch (err) { console.error(err); toast('切り替えに失敗しました: ' + err.message, 5000); } finally { setBusy(false); }
});
$('#selAA').value = S.aa;
$('#selAA').addEventListener('change', (e) => { S.aa = e.target.value; LS.set('aa', S.aa); refreshAll(); });
const gammaLabel = () => { $('#gammaVal').textContent = S.gamma + '%' + (S.gamma === 100 ? '（標準）' : ''); };
$('#rngGamma').value = S.gamma; gammaLabel(); applyGamma();
$('#rngGamma').addEventListener('input', (e) => { S.gamma = +e.target.value; LS.set('gamma', S.gamma); gammaLabel(); applyGamma(); });
$('#gammaReset').addEventListener('click', () => { S.gamma = 100; $('#rngGamma').value = 100; LS.set('gamma', 100); gammaLabel(); applyGamma(); });
/* ------------------------------------------------------- 検索（v4.11.2）
 *  PDF.js でページの文字を読み取り（読み取った結果は覚えておく）、表示中のページから順に探す。見つかった分から件数を出し、移動できる。
 *  大文字と小文字・全角と半角は区別せず、空白と改行は無視して探す（PDFでは、文字の間に空白が入っていたり、行の途中で分かれていたりするため） */
const FIND = { open: false, q: '', gen: 0, byPage: new Map(), order: [], cur: null, cache: new Map(), scanned: 0, done: false, timer: 0 };
const isWide = (cp) => cp >= 0x2e80;
// 1文字ずつ、比べやすい形（NFKC・小文字）にする。元の文字の位置も覚えておく
function normChars(str) {
  const out = []; let ci = 0;
  for (const ch of str) {
    for (const n of ch.normalize('NFKC').toLowerCase()) if (!/\s/.test(n)) out.push([n, ci]);
    ci++;
  }
  return out;
}
const normQuery = (q) => normChars(q).map((x) => x[0]).join('');
// ページの文字を読み取り、比べる文字列（s）と、元の文字の位置（map）、文字列の項目（items）にする
async function readPageText(n) {
  const pdf = S.pdf, page = await pdf.getPage(n);
  const tc = await page.getTextContent();
  if (pdf !== S.pdf) return null;
  const items = [], chars = [], map = [];
  for (const it of tc.items) {
    if (typeof it.str !== 'string' || !it.str) continue;
    const st = tc.styles[it.fontName] || {}, k = items.length;
    items.push({ t: it.transform, w: it.width, h: it.height, v: !!st.vertical, str: it.str });
    for (const [ch, ci] of normChars(it.str)) { chars.push(ch); map.push(k * 65536 + ci); }
  }
  noteWork();
  return { s: chars.join(''), map: Uint32Array.from(map), items };
}
// 検索用に覚えておくのは、比べる文字列だけ（大きな文書でもメモリを使いすぎないように。1400ページで数MB）。
// 見つかった箇所の位置（文字列の項目の座標）は、色を付けるときに読み直し、最近の数ページ分だけ覚えておく
const FIND_DET_MAX = 24;
const findDet = new Map();
function putDet(n, d) { findDet.delete(n); findDet.set(n, d); while (findDet.size > FIND_DET_MAX) findDet.delete(findDet.keys().next().value); }
async function pageText(n) {
  const c = FIND.cache.get(n); if (c !== undefined) return { s: c };
  const d = await readPageText(n); if (!d) return null;
  FIND.cache.set(n, d.s); putDet(n, d);
  return d;
}
async function pageDetail(n) {
  const d = findDet.get(n); if (d) { putDet(n, d); return d; }
  const r = await readPageText(n); if (r) putDet(n, r);
  return r;
}
// 文字列の項目の中での、文字の位置（0〜1）。全角は半角の約2倍の幅とみなす
function itemPos(it) {
  const w = [...it.str].map((ch) => (isWide(ch.codePointAt(0)) ? 1 : 0.55)), tot = w.reduce((a, b) => a + b, 0) || 1;
  const pos = [0]; for (const x of w) pos.push(pos[pos.length - 1] + x / tot);
  return pos;
}
// 見つかった文字の範囲を、PDFの座標の四角形（四隅）にする（文字列の項目ごとに1つ）
function hitQuads(t, h) {
  const out = []; let i = h.a;
  while (i < h.b) {
    const k = Math.floor(t.map[i] / 65536), c0 = t.map[i] % 65536; let c1 = c0;
    while (i < h.b && Math.floor(t.map[i] / 65536) === k) { c1 = Math.max(c1, t.map[i] % 65536); i++; }
    const it = t.items[k], [a, b, c, d, e, f] = it.t;
    const nu = Math.hypot(a, b) || 1, nv = Math.hypot(c, d) || 1, u = [a / nu, b / nu], v = [c / nv, d / nv];
    const pos = itemPos(it), t0 = pos[c0], t1 = pos[Math.min(c1 + 1, pos.length - 1)];
    if (it.v) {                                 // 縦書き: 上から下へ進む
      const L = it.h || nv, W = it.w || nv, x0 = e - u[0] * W / 2, y0 = f;
      const p = (s, q) => [x0 + u[0] * q * W - v[0] * s * L, y0 + u[1] * q * W - v[1] * s * L];
      out.push([p(t0, 0), p(t0, 1), p(t1, 1), p(t1, 0)]);
    } else {
      const L = it.w, H = it.h || nv;
      const p = (s, q) => [e + u[0] * s * L + v[0] * q * H, f + u[1] * s * L + v[1] * q * H];
      out.push([p(t0, -0.22), p(t1, -0.22), p(t1, 0.9), p(t0, 0.9)]);
    }
  }
  return out;
}
// ページに、見つかった箇所の色を付ける
function drawHits(p) {
  const old = p.el.querySelector(':scope > svg.hl'); if (old) old.remove();
  const hs = FIND.open && FIND.byPage.get(p.num);
  if (!hs || !hs.length) return;
  const t = findDet.get(p.num);
  if (!t) { const g = FIND.gen; pageDetail(p.num).then((d) => { if (d && g === FIND.gen) drawHits(p); }).catch(() => {}); return; }
  const view = p.view || (p.pageObj ? p.pageObj.getViewport({ scale: p.scale }) : null); if (!view) return;
  const svg = document.createElementNS(NS, 'svg'); svg.setAttribute('class', 'hl'); svg.setAttribute('viewBox', `0 0 ${view.width} ${view.height}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  hs.forEach((h, j) => {
    const curr = FIND.cur && FIND.cur.page === p.num && FIND.cur.j === j;
    for (const q of hitQuads(t, h)) {
      const pts = q.map((pt) => view.convertToViewportPoint(pt[0], pt[1]).map((x) => x.toFixed(1)).join(',')).join(' ');
      svgEl('polygon', { points: pts, class: curr ? 'cur' : '' }, svg);
    }
  });
  const cv = p.el.querySelector(':scope > canvas');
  p.el.insertBefore(svg, cv ? cv.nextSibling : p.el.firstChild);
}
function findInfo() {
  const n = FIND.order.length, idx = FIND.cur ? FIND.order.findIndex((x) => x.page === FIND.cur.page && x.j === FIND.cur.j) + 1 : 0;
  const prog = FIND.done || !FIND.q ? '' : `（検索中 ${FIND.scanned}/${S.pdf ? S.pdf.numPages : 0}ページ）`;
  $('#findInfo').textContent = !FIND.q ? '' : n ? `${idx || '-'} / ${n}件${prog}` : FIND.done ? '見つかりません' : `0件${prog}`;
  $('#findInput').classList.toggle('none', !!(FIND.q && FIND.done && !n));
}
function rebuildOrder() {
  FIND.order = [];
  for (const pg of [...FIND.byPage.keys()].sort((a, b) => a - b)) FIND.byPage.get(pg).forEach((h, j) => FIND.order.push({ page: pg, j }));
}
// 検索を始める（表示中のページから末尾へ、そのあと先頭から）
async function runFind() {
  const gen = ++FIND.gen, q = normQuery(FIND.q);
  FIND.byPage = new Map(); FIND.order = []; FIND.cur = null; FIND.scanned = 0; FIND.done = false;
  for (const p of S.pages) drawHits(p);
  if (!q || !S.pdf) { FIND.done = true; findInfo(); return; }
  findInfo();
  const N = S.pdf.numPages, start = S.cur; let lastInfo = 0;
  for (let k = 0; k < N; k++) {
    if (gen !== FIND.gen || !S.pdf) return;
    while (RS.active.size && !FIND.cache.has(((start - 1 + k) % N) + 1)) {     // 表示中のページの描画を優先する
      await new Promise((r) => setTimeout(r, 60)); if (gen !== FIND.gen) return;
    }
    const n = ((start - 1 + k) % N) + 1;
    if (workSince >= CLEAN_EVERY) { await maybeCleanup(); if (gen !== FIND.gen) return; }
    let t = null; try { t = await pageText(n); } catch (e) { console.warn('find', n, e); }
    if (gen !== FIND.gen) return;
    FIND.scanned++;
    if (t) {
      const hs = []; let i = t.s.indexOf(q);
      while (i >= 0) { hs.push({ a: i, b: i + q.length }); i = t.s.indexOf(q, i + q.length); }
      if (hs.length) {
        FIND.byPage.set(n, hs); rebuildOrder();
        const p = S.pages[n - 1]; if (p) drawHits(p);
        if (!FIND.cur) showHit({ page: n, j: 0 });
      }
    }
    if (performance.now() - lastInfo > 150) { lastInfo = performance.now(); findInfo(); }
  }
  FIND.done = true; findInfo(); maybeCleanup(true);
}
// 見つかった箇所へ移動して、画面の中央あたりに見せる
function showHit(h) {
  const prev = FIND.cur; FIND.cur = h; findInfo();
  if (prev && S.pages[prev.page - 1]) drawHits(S.pages[prev.page - 1]);
  const p = S.pages[h.page - 1], hit = FIND.byPage.get(h.page)[h.j];
  if (S.paged) showPage(h.page, 'top'); else goPage(h.page);
  let t = null;
  Promise.all([ensurePage(p), pageDetail(h.page).then((d) => { t = d; })]).then(() => {
    if (FIND.cur !== h || !t) return;
    drawHits(p);
    const view = p.pageObj.getViewport({ scale: p.scale }), qs = hitQuads(t, hit);
    const xs = [], ys = []; for (const q of qs) for (const pt of q) { const v = view.convertToViewportPoint(pt[0], pt[1]); xs.push(v[0]); ys.push(v[1]); }
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    wrap.scrollTop = (S.paged ? 0 : p.el.offsetTop) + cy - wrap.clientHeight / 2;
    if (p.el.offsetWidth > wrap.clientWidth) wrap.scrollLeft = p.el.offsetLeft + cx - wrap.clientWidth / 2;
  }).catch(() => {});
}
function findStep(dir) {
  if (!FIND.order.length) { if (FIND.q && !FIND.done) toast('検索中です…', 1200); return; }
  let i = FIND.cur ? FIND.order.findIndex((x) => x.page === FIND.cur.page && x.j === FIND.cur.j) : -1;
  if (i < 0) {                                   // まだ移動していない: 表示中のページから探す
    i = dir > 0 ? FIND.order.findIndex((x) => x.page >= S.cur) : (() => { let r = -1; FIND.order.forEach((x, k) => { if (x.page <= S.cur) r = k; }); return r; })();
    if (i < 0) i = dir > 0 ? 0 : FIND.order.length - 1;
  } else i = (i + dir + FIND.order.length) % FIND.order.length;
  showHit(FIND.order[i]);
}
function openFind() {
  if (!S.pdf) return;
  FIND.open = true; $('#findbar').hidden = false;
  const inp = $('#findInput');
  const sel = String(window.getSelection ? window.getSelection() : '').trim();
  if (sel && sel.length < 100 && !sel.includes('\n')) inp.value = sel;          // 選択している文字があれば、それを探す
  inp.focus(); inp.select();
  if (inp.value !== FIND.q) { FIND.q = inp.value; runFind(); } else for (const p of S.pages) drawHits(p);
}
function closeFind() {
  if (!FIND.open) return;
  FIND.open = false; FIND.gen++; $('#findbar').hidden = true;
  for (const p of S.pages) { const o = p.el.querySelector(':scope > svg.hl'); if (o) o.remove(); }
}
// 文書が変わった（編集・ページ操作など）: 読み取った文字を捨てて、開いていれば探し直す
function findReset() {
  FIND.cache.clear(); findDet.clear(); FIND.gen++;
  if (FIND.open && FIND.q) runFind(); else { FIND.byPage = new Map(); FIND.order = []; FIND.cur = null; }
}
$('#findInput').addEventListener('input', (e) => {
  clearTimeout(FIND.timer);
  FIND.timer = setTimeout(() => { if (e.target.value !== FIND.q) { FIND.q = e.target.value; runFind(); } }, 250);
});
$('#findInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault(); clearTimeout(FIND.timer);
    if (e.target.value !== FIND.q) { FIND.q = e.target.value; runFind(); } else findStep(e.shiftKey ? -1 : 1);
  } else if (e.key === 'Escape') { e.preventDefault(); closeFind(); wrap.focus && wrap.focus(); }
});
$('#findNext').addEventListener('click', () => findStep(1));
$('#findPrev').addEventListener('click', () => findStep(-1));
$('#findClose').addEventListener('click', closeFind);
$('#btnFind').addEventListener('click', () => (FIND.open ? closeFind() : openFind()));
/* ------------------------------------------------------- コメント一覧 */
let listRaf = 0;
function scheduleList() { if (listRaf) return; listRaf = requestAnimationFrame(() => { listRaf = 0; renderList(); }); }
function allEntries() {
  const out = [];
  for (const a of S.annots) {
    const bb = annotBBox(a);
    out.push({ key: a.id, ours: true, type: a.type, label: OURS_LABEL[a.type], page: a.page, text: a.type === 'text' ? a.text : '',
      author: a.author || '', date: a.date || '', top: bb[3], color: a.type === 'stamp' ? '#7a5af8' : a.p.color,
      cat: a.type === 'text' ? 'text' : a.type === 'stamp' ? 'stamp' : 'shape' });
  }
  for (const n of S.natives) {
    out.push({ key: n.key, ours: false, type: n.subtype, label: NATIVE_LABEL[n.subtype] || n.subtype, page: n.page, text: n.contents,
      author: n.author, date: n.date, top: n.rect[3], replyTo: n.replyTo, color: '#6b6b6b', cat: 'existing' });
  }
  return out;
}
// コメント一覧（右パネル）を作り直す
function renderList() {
  const ul = $('#cmtList'); const keepTop = $('#listScroll').scrollTop;
  const entries = allEntries();
  $('#cmtCount').textContent = entries.length;
  const q = $('#cmtSearch').value.trim().toLowerCase(), f = $('#cmtFilter').value;
  const ok = (en) => {
    if (f === 'text' && !en.text) return false;
    if (f === 'shape' && en.cat !== 'shape') return false;
    if (f === 'stamp' && en.cat !== 'stamp') return false;
    if (f === 'existing' && en.cat !== 'existing') return false;
    if (q && !(`${en.text} ${en.author} ${en.label} p.${en.page}`.toLowerCase().includes(q))) return false;
    return true;
  };
  const byKey = new Map(entries.map((x) => [x.key, x]));
  const children = new Map(), tops = [];
  for (const en of entries) {
    if (en.replyTo && byKey.has(en.replyTo)) { if (!children.has(en.replyTo)) children.set(en.replyTo, []); children.get(en.replyTo).push(en); }
    else tops.push(en);
  }
  const sorter = (a, b) => a.page - b.page || b.top - a.top;
  tops.sort(sorter);
  const frag = document.createDocumentFragment(); let shown = 0;
  const add = (en, depth) => {
    const kids = (children.get(en.key) || []).sort(sorter);
    if (!(ok(en) || kids.some((k) => ok(k)))) return;
    shown++;
    const li = document.createElement('li');
    li.className = 'cmt' + (S.sel.has(en.key) ? ' sel' : '') + (depth ? ' reply' : '');
    li.dataset.key = en.key;
    li.innerHTML = `<div class="c1"><span class="dot" style="background:${esc(en.color)}"></span><b>p.${en.page}</b><span class="lab">${depth ? '↳ ' : ''}${esc(en.label)}</span>` +
      `<span class="who">${esc(en.author)}</span><span class="when">${esc(fmtDate(en.date))}</span><button type="button" class="cdel" title="削除">✕</button></div>` +
      `<div class="c2${en.text ? '' : ' empty'}">${en.text ? esc(en.text) : '（コメントなし）'}</div>`;
    frag.appendChild(li);
    kids.forEach((k) => add(k, depth + 1));
  };
  tops.forEach((en) => add(en, 0));
  ul.replaceChildren(frag);
  $('#cmtEmpty').style.display = shown ? 'none' : '';
  $('#cmtEmpty').textContent = entries.length ? '該当するコメントがありません' : 'コメントはありません';
  $('#listScroll').scrollTop = keepTop;
  const selLi = ul.querySelector('li.sel'); if (selLi && !$('#listPane').hidden) selLi.scrollIntoView({ block: 'nearest' });
}
async function scrollToKey(key) {
  let page, bb;
  if (key.startsWith('n:')) { const n = S.nmap.get(key); if (!n) return; page = n.page; bb = n.rect; }
  else { const a = S.annots.find((x) => x.id === key); if (!a) return; page = a.page; bb = annotBBox(a); }
  if (S.paged && S.cur !== page) await showPage(page);
  const p = S.pages[page - 1]; if (!p) return; await ensureView(p);
  const [, top] = vbox(p.view, bb);
  wrap.scrollTop = Math.max(0, p.el.offsetTop + top - wrap.clientHeight / 3);
  S.cur = S.want = page; $('#pageNum').value = page;
}
async function selectKey(key, { scroll = false } = {}) {
  if (!isSelTool()) setTool('select');
  select(key); if (scroll) await scrollToKey(key);
}
$('#cmtList').addEventListener('click', (e) => {
  const li = e.target.closest('li'); if (!li) return;
  if (e.target.closest('.cdel')) { deleteByKey(li.dataset.key); return; }
  if (e.shiftKey || e.ctrlKey) { if (!isSelTool()) setTool('select'); toggleSel(li.dataset.key); return; }
  selectKey(li.dataset.key, { scroll: true });
});
$('#cmtList').addEventListener('dblclick', (e) => {
  const li = e.target.closest('li'); if (!li || e.target.closest('.cdel')) return;
  const key = li.dataset.key;
  if (key.startsWith('n:')) { editNativeContents(key); return; }
  const a = S.annots.find((x) => x.id === key);
  if (a && a.type === 'text') setTimeout(() => beginEdit(a, false), 50);
});
$('#cmtSearch').addEventListener('input', scheduleList);
$('#cmtFilter').addEventListener('change', scheduleList);
$('#author').value = S.author;
$('#author').addEventListener('change', (e) => { S.author = e.target.value.trim(); LS.set('author', S.author); toast('作成者名を保存しました（以後の新規コメントに付きます）'); });
function showTab(name) {
  $('#propsPane').hidden = name !== 'props'; $('#listPane').hidden = name !== 'list'; $('#bmPane').hidden = name !== 'bm';
  $('#tabProps').classList.toggle('on', name === 'props'); $('#tabList').classList.toggle('on', name === 'list'); $('#tabBm').classList.toggle('on', name === 'bm');
  if (name === 'list') renderList();
  if (name === 'bm') renderBookmarks();
}
$('#tabProps').addEventListener('click', () => showTab('props'));
$('#tabList').addEventListener('click', () => showTab('list'));
$('#tabBm').addEventListener('click', () => showTab('bm'));
/* ------------------------------------------------------- しおり（v4.11.1） */
const bmClosed = new Set();            // 閉じているしおり（パスの文字列）
// PDFのしおりを読み込む（PDF.js）。行き先のページ番号と、ページ内の位置（上端）も求める
async function collectOutline() {
  const pdf = S.pdf; if (!pdf) return;
  let raw = null;
  try { raw = await pdf.getOutline(); } catch (e) { console.warn('outline', e); }
  const dest = async (it) => {
    try {
      let d = it.dest; if (typeof d === 'string') d = await pdf.getDestination(d);
      if (!Array.isArray(d) || !d[0]) return null;
      const idx = typeof d[0] === 'number' ? d[0] : await pdf.getPageIndex(d[0]);
      const kind = d[1] && d[1].name, top = kind === 'XYZ' ? d[3] : kind === 'FitH' || kind === 'FitBH' ? d[2] : null;
      return { page: idx + 1, top: typeof top === 'number' ? top : null };
    } catch { return null; }
  };
  const walk = async (items, path) => {
    const out = [];
    for (let i = 0; i < (items || []).length; i++) {
      const it = items[i], p = [...path, i], d = await dest(it);
      out.push({ title: it.title || '（無題）', path: p, page: d ? d.page : null, top: d ? d.top : null, url: it.url || it.unsafeUrl || null,
        bold: !!it.bold, italic: !!it.italic, items: await walk(it.items, p) });
      if (!path.length && pdf !== S.pdf) return out;
    }
    return out;
  };
  const tree = await walk(raw, []);
  if (pdf !== S.pdf) return;
  if (S.outlineGen !== S.loadGen) { bmClosed.clear(); S.bmSel = null; S.outlineGen = S.loadGen; }     // 別のPDFを開いた
  S.outline = tree;
  if (S.bmSel && !bmFind(S.bmSel)) S.bmSel = null;
  if (!$('#bmPane').hidden) renderBookmarks();
  updateButtons();
}
const bmKey = (path) => path.join('.');
function bmFind(key, list = S.outline) {
  for (const it of list) { if (bmKey(it.path) === key) return it; const f = bmFind(key, it.items); if (f) return f; }
  return null;
}
function renderBookmarks() {
  const ul = $('#bmTree'); ul.replaceChildren();
  const build = (items, parent) => {
    for (const it of items) {
      const li = document.createElement('li'), key = bmKey(it.path), has = it.items.length > 0;
      li.setAttribute('role', 'treeitem');
      if (has && bmClosed.has(key)) li.classList.add('closed');
      const row = document.createElement('div'); row.className = 'bm' + (S.bmSel === key ? ' sel' : ''); row.dataset.key = key;
      row.title = it.page ? `${it.title}（${it.page}ページ）` : it.url ? `${it.title}（${it.url}）` : it.title;
      const tw = document.createElement('span'); tw.className = 'tw'; tw.textContent = has ? (bmClosed.has(key) ? '▶' : '▼') : '';
      const tt = document.createElement('span'); tt.className = 'tt'; tt.textContent = it.title;
      if (it.bold) tt.style.fontWeight = '600'; if (it.italic) tt.style.fontStyle = 'italic';
      const pn = document.createElement('span'); pn.className = 'pn'; pn.textContent = it.page ? String(it.page) : it.url ? '🔗' : '';
      row.append(tw, tt, pn); li.appendChild(row);
      if (has) { const sub = document.createElement('ul'); sub.setAttribute('role', 'group'); build(it.items, sub); li.appendChild(sub); }
      parent.appendChild(li);
    }
  };
  build(S.outline, ul);
  $('#bmEmpty').hidden = S.outline.length > 0;
  updateButtons();
}
// しおりの行き先へ移動する（ページ内の位置があれば、その位置が画面の上に来るように）
function bmGo(it) {
  if (!it || !it.page || !S.pdf) return;
  const n = clamp(it.page, 1, S.pdf.numPages), p = S.pages[n - 1];
  const toTop = () => {
    if (it.top == null || !p.pageObj) return;
    const vy = p.pageObj.getViewport({ scale: p.scale }).convertToViewportPoint(0, it.top)[1];
    wrap.scrollTop = (S.paged ? 0 : p.el.offsetTop) + Math.max(0, vy - 4);
  };
  if (S.paged) { showPage(n, 'top'); ensurePage(p).then(toTop).catch(() => {}); }
  else { goPage(n); ensurePage(p).then(toTop).catch(() => {}); }
}
// 今、画面の一番上に見えている位置（ページ番号と、ページ内の上端のPDF座標）
function viewTopDest() {
  const n = S.cur, p = S.pages[n - 1]; if (!p) return { page: 1, top: null };
  const view = p.view || (p.pageObj ? p.pageObj.getViewport({ scale: p.scale }) : null);
  const y = Math.max(0, wrap.getBoundingClientRect().top - p.el.getBoundingClientRect().top);
  if (!view || y < 2) return { page: n, top: view ? view.convertToPdfPoint(0, 0)[1] : null };
  return { page: n, top: view.convertToPdfPoint(0, y)[1] };
}
async function bmAdd() {
  if (!S.pdf || S.busy) return;
  if (S.editing) endEdit(true);
  const d = viewTopDest();
  const r = await dialog({
    title: 'しおりを追加', ok: '追加',
    html: `<label>しおりの名前 <input id="bmName" value="${esc(d.page + 'ページ')}" style="width:100%"></label><p class="small">${d.page}ページの、今見えている位置に付けます。${S.bmSel ? '選んでいるしおりの下に追加します。' : ''}</p>`,
    init: (dl) => { const i = dl.querySelector('#bmName'); setTimeout(() => { i.focus(); i.select(); }, 0); },
    validate: (dl) => { const v = dl.querySelector('#bmName').value.trim(); if (!v) throw new Error('名前を入力してください。'); return v; },
  });
  if (!r) return;
  const path = S.bmSel ? S.bmSel.split('.').map(Number) : null;
  const ok = await nativeOp({ type: 'bm', act: 'add', path, title: r, page: d.page, top: d.top }, 'しおりを追加中…');
  if (ok) {
    S.bmSel = path ? bmKey([...path.slice(0, -1), path[path.length - 1] + 1]) : bmKey([S.outline.length]);
    showTab('bm'); toast(`しおり「${r}」を追加しました（保存すると、ファイルに反映されます）`);
  }
}
async function bmRename() {
  const it = S.bmSel && bmFind(S.bmSel); if (!it || S.busy) return;
  const r = await dialog({
    title: 'しおりの名前を変更', ok: '変更',
    html: `<label>しおりの名前 <input id="bmName" value="${esc(it.title)}" style="width:100%"></label>`,
    init: (dl) => { const i = dl.querySelector('#bmName'); setTimeout(() => { i.focus(); i.select(); }, 0); },
    validate: (dl) => { const v = dl.querySelector('#bmName').value.trim(); if (!v) throw new Error('名前を入力してください。'); return v; },
  });
  if (!r || r === it.title) return;
  await nativeOp({ type: 'bm', act: 'rename', path: it.path, title: r }, 'しおりの名前を変更中…');
}
async function bmDelete() {
  const it = S.bmSel && bmFind(S.bmSel); if (!it || S.busy) return;
  const n = (function cnt(x) { return x.items.reduce((a, c) => a + 1 + cnt(c), 0); })(it);
  if (n && !(await dialog({ title: 'しおりの削除', ok: '削除', html: `<p>「${esc(it.title)}」と、その下の${n}個のしおりを削除します。</p>` }))) return;
  if (await nativeOp({ type: 'bm', act: 'del', path: it.path }, 'しおりを削除中…')) { S.bmSel = null; toast(`しおり「${it.title}」を削除しました`); }
}
$('#bmTree').addEventListener('click', (e) => {
  const row = e.target.closest('.bm'); if (!row) return;
  const key = row.dataset.key, it = bmFind(key);
  if (e.target.classList.contains('tw') && it && it.items.length) {                       // ▶▼: 開く／閉じる
    if (bmClosed.has(key)) bmClosed.delete(key); else bmClosed.add(key);
    renderBookmarks(); return;
  }
  S.bmSel = key; renderBookmarks(); bmGo(it);
});
$('#bmTree').addEventListener('dblclick', (e) => { const row = e.target.closest('.bm'); if (row && !e.target.classList.contains('tw') && !encLocked()) { S.bmSel = row.dataset.key; bmRename(); } });
$('#bmPane').addEventListener('keydown', (e) => {
  if ((e.target.tagName || '').toLowerCase() === 'input') return;
  if (e.key === 'F2' && S.bmSel && !encLocked()) { e.preventDefault(); e.stopPropagation(); bmRename(); }
  else if (e.key === 'Delete' && S.bmSel && !encLocked()) { e.preventDefault(); e.stopPropagation(); bmDelete(); }
});
$('#bmTree').tabIndex = 0;
$('#bmAdd').addEventListener('click', bmAdd);
$('#bmRename').addEventListener('click', bmRename);
$('#bmDel').addEventListener('click', bmDelete);
$('#btnComments').addEventListener('click', () => { $('#props').classList.remove('hidden'); showTab('list'); });
/* ------------------------------------------------------- ダイアログ */
function dialog({ title, html, ok = 'OK', init, validate }) {
  return new Promise((res) => {
    const dlg = $('#dlg'); let result = null; const ac = new AbortController();
    dlg.innerHTML = `<form method="dialog"><h3>${esc(title)}</h3><div class="dbody">${html}</div><p class="derr" id="derr"></p>` +
      `<div class="dbtn"><button type="button" id="dCancel">キャンセル</button><button type="submit" id="dOk" class="pri">${esc(ok)}</button></div></form>`;
    dlg.querySelector('form').addEventListener('submit', (e) => {
      e.preventDefault();
      try { result = validate ? validate(dlg) : true; } catch (err) { $('#derr').textContent = err.message; return; }
      dlg.close();
    });
    $('#dCancel').onclick = () => { result = null; dlg.close(); };
    dlg.addEventListener('close', () => { ac.abort(); res(result); }, { once: true });
    if (init) init(dlg, ac.signal);
    dlg.showModal();
    const first = dlg.querySelector('input,select'); if (first) first.focus();
  });
}
function parseRange(str, n) {
  str = (str || '').trim();
  if (!str || /^(all|すべて|全部|全て)$/i.test(str)) return [...Array(n).keys()];
  const set = new Set();
  for (const part of str.split(/[,、，\s]+/)) {
    if (!part) continue;
    const m = /^(\d*)\s*[-–〜~]\s*(\d*)$/.exec(part);
    if (m && (m[1] || m[2])) {
      let a = m[1] ? +m[1] : 1, b = m[2] ? +m[2] : n; if (a > b) [a, b] = [b, a];
      if (a < 1 || b > n) throw new Error(`ページ範囲が不正です（1〜${n}）: ${part}`);
      for (let i = a; i <= b; i++) set.add(i - 1);
    } else if (/^\d+$/.test(part)) {
      const v = +part; if (v < 1 || v > n) throw new Error(`ページ番号が範囲外です（1〜${n}）: ${part}`); set.add(v - 1);
    } else throw new Error(`解釈できない指定です: ${part}`);
  }
  if (!set.size) throw new Error('ページが指定されていません。');
  return [...set].sort((a, b) => a - b);
}
/* ------------------------------------------------------- ページ操作の共通処理 */
const currentItems = () => S.pages.map((_, i) => ({ id: newId(), k: 'old', i, rot: 0, ext: null }));
async function pickPdf() {
  if (window.showOpenFilePicker) {
    try { const [h] = await window.showOpenFilePicker({ types: PDF_PICKER_TYPES }); return await h.getFile(); }
    catch (e) { if (e && e.name === 'AbortError') return null; throw e; }
  }
  return await new Promise((res) => { const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.pdf,application/pdf'; inp.onchange = () => res(inp.files[0] || null); inp.click(); });
}
async function makeExt(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let doc;
  try { doc = await PDFDocument.load(bytes, { updateMetadata: false }); }
  catch (e) { throw new Error(/encrypt/i.test(e.message) ? '暗号化（パスワード付き）のPDFは挿入できません。' : `PDFを読み込めません: ${e.message}`); }
  return { name: file.name, bytes, n: doc.getPageCount(), pdfP: null };
}
const extPdf = (ext) => (ext.pdfP ||= pdfjsLib.getDocument(pdfjsOpts(ext.bytes)).promise);
// ページの並べ替え・回転・挿入・削除をまとめて反映する（元に戻せる）
async function applyItems(items, msg = 'ページを処理中…') {
  if (S.busy) return false;
  const sn = takeSnap(); setBusy(true, msg);
  try {
    const doc = await PDFDocument.load(await baseAll(), { updateMetadata: false });
    const old = doc.getPages(), extDocs = new Map(), newPages = [], map = new Map();
    for (const it of items) {
      let page;
      if (it.k === 'old') page = old[it.i];
      else {
        let ed = extDocs.get(it.ext);
        if (!ed) { ed = await PDFDocument.load(it.ext.bytes, { updateMetadata: false }); extDocs.set(it.ext, ed); }
        [page] = await doc.copyPages(ed, [it.i]);
      }
      if (it.rot) page.setRotation(degrees((((page.getRotation().angle + it.rot) % 360) + 360) % 360));
      newPages.push(page); if (it.k === 'old') map.set(it.i, newPages.length - 1);
    }
    for (let k = old.length - 1; k >= 0; k--) doc.removePage(k);
    for (const pg of newPages) doc.addPage(pg);
    if (map.size < old.length) gcDoc(doc);
    let bytes = await doc.save({ useObjectStreams: false });
    S.annots = S.annots.filter((a) => map.has(a.page - 1)).map((a) => ({ ...a, page: map.get(a.page - 1) + 1 }));
    // v4.11.1: 貼り付け・挿入したページに、このアドオンで書いた注釈があれば、既存の注釈にせず、編集できる注釈として取り込む
    if (items.some((it) => it.k !== 'old') && bytesContain(bytes, 'EPAType', MARKER)) {
      try {
        const r = await extractOurs(bytes), ids = new Set(S.annots.map((a) => a.id));
        for (const a of r.annots) { if (ids.has(a.id)) a.id = newId(); ids.add(a.id); }
        bytes = r.bytes; S.annots.push(...r.annots);
      } catch (e) { console.warn('貼り付けたページの注釈の取り込みに失敗', e); }
    }
    pruneSel();
    await setBase(bytes, { keepScroll: false });
    commit(sn); goPage(Math.min(S.cur, S.pages.length));
    return true;
  } catch (e) { console.error(e); toast('ページ操作に失敗しました: ' + friendlyError(e), 7000); return false; }
  finally { setBusy(false); }
}
// 選んだページだけを新しいPDFとして書き出す（ページの抽出）
// ページ（items）だけの新しいPDFを作る。'old' は srcBytes（今の注釈を入れたPDF）のページ
async function itemsToBytes(items, srcBytes) {
  const src = await PDFDocument.load(srcBytes, { updateMetadata: false });
  const out = await PDFDocument.create(), extDocs = new Map();
  for (const it of items) {
    let page;
    if (it.k === 'old') [page] = await out.copyPages(src, [it.i]);
    else {
      let ed = extDocs.get(it.ext);
      if (!ed) { ed = await PDFDocument.load(it.ext.bytes, { updateMetadata: false }); extDocs.set(it.ext, ed); }
      [page] = await out.copyPages(ed, [it.i]);
    }
    if (it.rot) page.setRotation(degrees((((page.getRotation().angle + it.rot) % 360) + 360) % 360));
    out.addPage(page);
  }
  return await out.save({ useObjectStreams: false });
}
async function exportItems(items, srcBytes, nameSuffix) {
  setBusy(true, '抽出したPDFを作成中…');
  try {
    const bytes = await itemsToBytes(items, srcBytes);
    setBusy(false);
    const suggested = `${S.fileName.replace(/\.pdf$/i, '')}${nameSuffix}.pdf`;
    let name = null;
    if (window.showSaveFilePicker) {
      try { const h = await window.showSaveFilePicker({ suggestedName: suggested, id: 'epa-pdf', types: PDF_PICKER_TYPES }); await writeHandle(h, bytes); name = h.name; }
      catch (e) { if (e && e.name === 'AbortError') name = null; else name = await downloadBytes(bytes, pdfName(suggested), { saveAs: true }); }
    } else name = await downloadBytes(bytes, pdfName(suggested), { saveAs: true });
    if (name) toast(`${items.length}ページを抽出して保存しました: ${name}`); else toast('保存をキャンセルしました');
    return !!name;
  } catch (e) { console.error(e); toast('抽出に失敗しました: ' + friendlyError(e), 7000); return false; }
  finally { setBusy(false); }
}
const rangeLabel = (idxs) => `_p${idxs[0] + 1}${idxs.length > 1 ? '-' + (idxs[idxs.length - 1] + 1) : ''}`;
/* ------------------------------------------------------- ページの挿入 / 削除 / 抽出 */
async function askInsert(ext, { total, defPos = 'after', defNum = 1 }) {
  return await dialog({
    title: 'ページの挿入', ok: '挿入',
    html: `<p>挿入するPDF: <b>${esc(ext.name)}</b>（${ext.n}ページ）</p>` +
      `<label>挿入するページ <input id="iRange" value="すべて" placeholder="例: 1-3,5"> <small>（1〜${ext.n}）</small></label>` +
      `<label>挿入位置 <select id="iPos"><option value="first">先頭</option><option value="before">指定ページの前</option><option value="after">指定ページの後ろ</option><option value="last">末尾</option></select>` +
      ` ページ <input id="iNum" type="number" min="1" max="${total}" value="${clamp(defNum, 1, total)}" style="width:70px"> <small>/ ${total}</small></label>`,
    init: (d) => { d.querySelector('#iPos').value = defPos; },
    validate: (d) => {
      const pages = parseRange(d.querySelector('#iRange').value, ext.n);
      const pos = d.querySelector('#iPos').value, num = clamp(parseInt(d.querySelector('#iNum').value) || 1, 1, total);
      const index = pos === 'first' ? 0 : pos === 'last' ? total : pos === 'before' ? num - 1 : num;
      return { pages, index };
    },
  });
}
async function actInsert(file = null, defNum = null) {
  if (!S.pdf || S.busy) return;
  try {
    file = file || await pickPdf(); if (!file) return;
    const ext = await makeExt(file);
    const r = await askInsert(ext, { total: S.pdf.numPages, defPos: 'after', defNum: defNum || S.cur }); if (!r) return;
    const items = currentItems();
    items.splice(r.index, 0, ...r.pages.map((i) => ({ id: newId(), k: 'ext', ext, i, rot: 0 })));
    if (await applyItems(items, 'ページを挿入中…')) { goPage(r.index + 1); toast(`${r.pages.length}ページを挿入しました（${ext.name}）`); }
  } catch (e) { console.error(e); toast(e.message || String(e), 6000); }
}
async function actDelete() {
  if (!S.pdf || S.busy) return;
  const n = S.pdf.numPages;
  const r = await dialog({
    title: 'ページの削除', ok: '削除',
    html: `<label>削除するページ <input id="rRange" value="${S.cur}" placeholder="例: 2,4-6"> <small>（全${n}ページ）</small></label><p class="small">削除後も「元に戻す」(Ctrl+Z)で復元できます。</p>`,
    validate: (d) => { const idx = parseRange(d.querySelector('#rRange').value || String(S.cur), n); if (idx.length >= n) throw new Error('すべてのページは削除できません。'); return idx; },
  });
  if (!r) return;
  const del = new Set(r);
  if (await applyItems(currentItems().filter((it) => !del.has(it.i)), 'ページを削除中…')) toast(`${r.length}ページを削除しました`);
}
async function actExtract() {
  if (!S.pdf || S.busy) return;
  const n = S.pdf.numPages;
  const r = await dialog({
    title: 'ページの抽出', ok: '抽出して保存',
    html: `<label>抽出するページ <input id="xRange" value="${S.cur}" placeholder="例: 1-3,5"> <small>（全${n}ページ）</small></label>` +
      `<label class="chk"><input type="checkbox" id="xDel">抽出したページを元のPDFから削除する</label>`,
    validate: (d) => ({ idx: parseRange(d.querySelector('#xRange').value || String(S.cur), n), del: d.querySelector('#xDel').checked }),
  });
  if (!r) return;
  if (r.del && r.idx.length >= n) { toast('すべてのページを削除することはできません。'); return; }
  let src; try { src = await buildPdfBytes(); } catch (e) { toast('抽出に失敗しました: ' + friendlyError(e), 7000); return; }
  const ok = await exportItems(r.idx.map((i) => ({ k: 'old', i, rot: 0 })), src, rangeLabel(r.idx));
  if (ok && r.del) { const del = new Set(r.idx); await applyItems(currentItems().filter((it) => !del.has(it.i)), 'ページを削除中…'); }
}
/* ------------------------------------------------------- ページの整理（サムネイル） */
const org = { open: false, items: [], sel: new Set(), anchor: null, dragIds: null };
const orgGrid = $('#orgGrid');
const thumbIO = new IntersectionObserver((es) => {
  for (const e of es) if (e.isIntersecting) { const it = org.items.find((x) => x.id === e.target.dataset.id); if (it) renderThumb(it, e.target); }
}, { root: orgGrid, rootMargin: '400px' });
async function renderThumb(it, el) {
  const key = String(it.rot); if (el._done === key) return; el._done = key;
  try {
    const doc = it.k === 'old' ? S.pdf : await extPdf(it.ext);
    const page = await doc.getPage(it.i + 1);
    const rot = (((page.rotate + it.rot) % 360) + 360) % 360;
    const v0 = page.getViewport({ scale: 1, rotation: rot });
    const sc = 170 / Math.max(v0.width, v0.height), dpr = Math.min(2, window.devicePixelRatio || 1);
    const vp = page.getViewport({ scale: sc * dpr, rotation: rot });
    const cv = el.querySelector('canvas');
    cv.width = Math.floor(vp.width); cv.height = Math.floor(vp.height);
    cv.style.width = Math.floor(vp.width / dpr) + 'px'; cv.style.height = Math.floor(vp.height / dpr) + 'px';
    await page.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
  } catch (e) { if (!e || e.name !== 'RenderingCancelledException') console.warn('thumb', e); el._done = null; }
}
function orgRender() {
  thumbIO.disconnect(); orgGrid.replaceChildren();
  org.items.forEach((it, idx) => {
    const el = document.createElement('div');
    el.className = 'thumb' + (org.sel.has(it.id) ? ' sel' : ''); el.dataset.id = it.id; el.draggable = true;
    el.innerHTML = `<div class="tbox"><canvas></canvas></div><div class="tlab">${idx + 1}${it.k === 'ext' ? ` <span class="ext" title="${esc(it.ext.name)}">＋${it.ext.tag || '挿入'}</span>` : ''}${it.rot ? ` <span class="rot">↻${it.rot}°</span>` : ''}</div>`;
    orgGrid.appendChild(el); thumbIO.observe(el);
  });
  orgInfo();
}
function orgInfo() { $('#orgInfo').textContent = `${org.items.length}ページ ／ 選択 ${org.sel.size}`; orgSyncButtons(); }
function orgRefreshSel() { orgGrid.querySelectorAll('.thumb').forEach((el) => el.classList.toggle('sel', org.sel.has(el.dataset.id))); orgInfo(); }
function openOrganizer() {
  if (!S.pdf || S.busy) return;
  if (encLocked()) { toast('このPDFは編集ロックがかかっているため、ページの整理はできません。左の「文書プロパティ」でロックを解除できます。', 6000); return; }
  if (S.editing) endEdit(true);
  org.items = currentItems(); org.sel.clear(); org.anchor = null; org.dragIds = null; org.open = true;
  $('#org').classList.remove('hidden'); orgRender(); orgLoadClip();
}
function closeOrganizer() { org.open = false; $('#org').classList.add('hidden'); thumbIO.disconnect(); orgGrid.replaceChildren(); }
const orgSelItems = () => org.items.filter((x) => org.sel.has(x.id));
orgGrid.addEventListener('click', (e) => {
  const el = e.target.closest('.thumb');
  if (!el) { org.sel.clear(); orgRefreshSel(); return; }
  const id = el.dataset.id;
  if (e.shiftKey && org.anchor) {
    const a = org.items.findIndex((x) => x.id === org.anchor), b = org.items.findIndex((x) => x.id === id);
    org.sel.clear(); for (let i = Math.min(a, b); i <= Math.max(a, b); i++) org.sel.add(org.items[i].id);
  } else if (e.ctrlKey || e.metaKey) { if (org.sel.has(id)) org.sel.delete(id); else org.sel.add(id); org.anchor = id; }
  else { org.sel.clear(); org.sel.add(id); org.anchor = id; }
  orgRefreshSel();
});
orgGrid.addEventListener('dblclick', (e) => {
  const el = e.target.closest('.thumb'); if (!el) return;
  const idx = org.items.findIndex((x) => x.id === el.dataset.id); if (idx < 0) return;
  orgApply(idx + 1);
});
const clearIns = () => orgGrid.querySelectorAll('.ins-before,.ins-after').forEach((x) => x.classList.remove('ins-before', 'ins-after'));
// ページの整理: ドラッグ中のサムネイルを、どのページの前／後ろに入れるか
function dropTarget(e) {
  const el = e.target.closest && e.target.closest('.thumb');
  if (!el) return { id: null, after: true };
  const r = el.getBoundingClientRect();
  return { id: el.dataset.id, after: e.clientX > r.left + r.width / 2 };
}
orgGrid.addEventListener('dragstart', (e) => {
  const el = e.target.closest('.thumb'); if (!el) return;
  const id = el.dataset.id;
  if (!org.sel.has(id)) { org.sel.clear(); org.sel.add(id); org.anchor = id; orgRefreshSel(); }
  org.dragIds = new Set(org.sel); e.dataTransfer.setData('text/plain', 'epa-thumbs'); e.dataTransfer.effectAllowed = 'move';
});
orgGrid.addEventListener('dragover', (e) => {
  e.preventDefault(); e.stopPropagation(); clearIns();
  const t = dropTarget(e); if (t.id) orgGrid.querySelector(`[data-id="${t.id}"]`).classList.add(t.after ? 'ins-after' : 'ins-before');
  e.dataTransfer.dropEffect = org.dragIds ? 'move' : 'copy';
});
orgGrid.addEventListener('dragleave', (e) => { if (!orgGrid.contains(e.relatedTarget)) clearIns(); });
orgGrid.addEventListener('dragend', () => { org.dragIds = null; clearIns(); });
orgGrid.addEventListener('drop', async (e) => {
  e.preventDefault(); e.stopPropagation(); clearIns();
  const t = dropTarget(e);
  if (org.dragIds) {
    const ids = org.dragIds; org.dragIds = null;
    const dragged = org.items.filter((x) => ids.has(x.id)), rest = org.items.filter((x) => !ids.has(x.id));
    let at = rest.length;
    if (t.id) { const ti = rest.findIndex((x) => x.id === t.id); if (ti < 0) return; at = ti + (t.after ? 1 : 0); }
    rest.splice(at, 0, ...dragged); org.items = rest; orgRender(); return;
  }
  const pdf = [...(e.dataTransfer.files || [])].find((f) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
  if (pdf) {
    let idx = org.items.length; if (t.id) idx = org.items.findIndex((x) => x.id === t.id) + (t.after ? 1 : 0);
    await orgInsert(pdf, idx);
  }
});
async function orgInsert(file, idx) {
  try {
    file = file || await pickPdf(); if (!file) return;
    const ext = await makeExt(file);
    if (idx == null) { const sel = org.items.map((x, i) => (org.sel.has(x.id) ? i : -1)).filter((i) => i >= 0); idx = sel.length ? sel[sel.length - 1] + 1 : org.items.length; }
    const total = org.items.length;
    const defPos = idx <= 0 ? 'first' : idx >= total ? 'last' : 'after';
    const r = await askInsert(ext, { total, defPos, defNum: idx });
    if (!r) return;
    const items = r.pages.map((i) => ({ id: newId(), k: 'ext', ext, i, rot: 0 }));
    org.items.splice(r.index, 0, ...items); org.sel = new Set(items.map((x) => x.id)); orgRender();
  } catch (e) { console.error(e); toast(e.message || String(e), 6000); }
}
// ---- ページのコピー・貼り付け（v4.11）
//  コピーしたページは、注釈を含めた1つのPDFにして IndexedDB に置く。同じブラウザで開いている、ほかのタブのPDFの「ページの整理」からも貼り付けられる
//  （拡張機能のページはすべて同じ保存場所を使う。コピーしたことは localStorage の変化で、ほかのタブに知らせる）
const PAGECLIP_KEY = 'pageClip', PAGECLIP_LS = 'epa-pageclip';
async function orgCopy() {
  const sel = orgSelItems(); if (!sel.length) { toast('コピーするページを選択してください'); return; }
  if (S.busy) return;
  setBusy(true, 'ページをコピー中…');
  try {
    const bytes = await itemsToBytes(sel, await buildPdfBytes());
    const clip = { bytes, n: sel.length, name: S.fileName || 'PDF', time: Date.now() };
    await IDB.set(PAGECLIP_KEY, clip); org.clip = clip;
    try { localStorage.setItem(PAGECLIP_LS, String(clip.time)); } catch { /* ignore */ }
    orgSyncButtons();
    toast(`${sel.length}ページをコピーしました（ほかのタブのPDFの「ページの整理」でも貼り付けられます）`, 3500);
  } catch (e) { console.error(e); toast('コピーできませんでした: ' + friendlyError(e), 6000); }
  finally { setBusy(false); }
}
async function orgLoadClip() {
  const c = await IDB.get(PAGECLIP_KEY);
  org.clip = c && c.bytes && c.n ? c : null; orgSyncButtons();
  return org.clip;
}
// 貼り付ける位置: 選択したページの最後の後ろ（選択がなければ末尾）
function orgInsertIndex() {
  const sel = org.items.map((x, i) => (org.sel.has(x.id) ? i : -1)).filter((i) => i >= 0);
  return sel.length ? sel[sel.length - 1] + 1 : org.items.length;
}
async function orgPaste() {
  const c = await orgLoadClip(); if (!c) { toast('コピーしたページがありません（「ページの整理」でページを選んで「コピー」してください）'); return; }
  const bytes = c.bytes instanceof Uint8Array ? c.bytes : new Uint8Array(c.bytes);
  const ext = { name: `${c.name} からコピー`, bytes, n: c.n, pdfP: null, tag: '貼付' };
  const idx = orgInsertIndex(), items = [];
  for (let i = 0; i < c.n; i++) items.push({ id: newId(), k: 'ext', ext, i, rot: 0 });
  org.items.splice(idx, 0, ...items); org.sel = new Set(items.map((x) => x.id)); org.anchor = items[0].id; orgRender();
  toast(`${c.n}ページを貼り付けました（「適用」で反映されます）`);
}
// 空白ページを挿入する。大きさ・向きは、選択したページ（なければ最後のページ）の見た目に合わせる
async function orgBlank() {
  try {
    const idx = orgInsertIndex(), ref = org.items[Math.max(0, idx - 1)];
    let w = 595.28, h = 841.89;
    if (ref) {
      const doc = ref.k === 'old' ? S.pdf : await extPdf(ref.ext), page = await doc.getPage(ref.i + 1);
      const v = page.getViewport({ scale: 1, rotation: (((page.rotate + ref.rot) % 360) + 360) % 360 });
      w = v.width; h = v.height;
    }
    const bd = await PDFDocument.create(); bd.addPage([w, h]);
    const ext = { name: '空白ページ', bytes: await bd.save(), n: 1, pdfP: null, tag: '空白' };
    const it = { id: newId(), k: 'ext', ext, i: 0, rot: 0 };
    org.items.splice(idx, 0, it); org.sel = new Set([it.id]); org.anchor = it.id; orgRender();
  } catch (e) { console.error(e); toast('空白ページを挿入できませんでした: ' + friendlyError(e), 6000); }
}
function orgSyncButtons() {
  $('#orgCopy').disabled = !org.sel.size;
  $('#orgPaste').disabled = !org.clip;
  $('#orgPaste').title = org.clip ? `コピーした${org.clip.n}ページ（${org.clip.name}）を、選択したページの後ろに貼り付け (Ctrl+V)` : 'コピーしたページはありません';
}
window.addEventListener('storage', (e) => { if (e.key === PAGECLIP_LS && org.open) orgLoadClip(); });
function orgRotate(d) {
  const sel = orgSelItems(); if (!sel.length) { toast('回転するページを選択してください'); return; }
  sel.forEach((it) => { it.rot = (((it.rot + d) % 360) + 360) % 360; });
  orgGrid.querySelectorAll('.thumb.sel').forEach((el) => { el._done = null; });
  orgRender();
}
function orgDelete() {
  if (!org.sel.size) { toast('削除するページを選択してください'); return; }
  if (org.sel.size >= org.items.length) { toast('すべてのページは削除できません'); return; }
  org.items = org.items.filter((x) => !org.sel.has(x.id)); org.sel.clear(); orgRender();
}
async function orgExtract() {
  const sel = orgSelItems(); if (!sel.length) { toast('抽出するページを選択してください'); return; }
  let src; try { src = await buildPdfBytes(); } catch (e) { toast('抽出に失敗しました: ' + friendlyError(e), 7000); return; }
  await exportItems(sel, src, `_抽出${sel.length}p`);
}
async function orgApply(openPage = null) {
  const same = org.items.length === S.pages.length && org.items.every((it, i) => it.k === 'old' && it.i === i && !it.rot);
  const items = org.items; closeOrganizer();
  if (same) { if (openPage) goPage(openPage); else toast('変更はありません'); return; }
  if (await applyItems(items, 'ページ構成を反映中…')) { toast('ページ構成を反映しました'); if (openPage) goPage(openPage); }
}
// ページの整理画面のキー操作
function orgKey(e) {
  if ($('#dlg').open) return;
  const mod = e.ctrlKey || e.metaKey;
  if (e.key === 'Escape') { e.preventDefault(); closeOrganizer(); }
  else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); orgDelete(); }
  else if (mod && e.key.toLowerCase() === 'a') { e.preventDefault(); org.sel = new Set(org.items.map((x) => x.id)); orgRefreshSel(); }
  else if (mod && e.key.toLowerCase() === 'c') { e.preventDefault(); orgCopy(); }
  else if (mod && e.key.toLowerCase() === 'v') { e.preventDefault(); orgPaste(); }
}
$('#orgRotL').addEventListener('click', () => orgRotate(-90));
$('#orgRotR').addEventListener('click', () => orgRotate(90));
$('#orgDel').addEventListener('click', orgDelete);
$('#orgExtract').addEventListener('click', orgExtract);
$('#orgInsert').addEventListener('click', () => orgInsert(null, null));
$('#orgCopy').addEventListener('click', orgCopy);
$('#orgPaste').addEventListener('click', orgPaste);
$('#orgBlank').addEventListener('click', orgBlank);
$('#orgAll').addEventListener('click', () => { org.sel = new Set(org.items.map((x) => x.id)); orgRefreshSel(); });
$('#orgApply').addEventListener('click', () => orgApply());
$('#orgCancel').addEventListener('click', closeOrganizer);
$('#btnOrg').addEventListener('click', openOrganizer);
/* ------------------------------------------------------- メニュー / サイドバー / 周辺UI */
const pageMenu = $('#pageMenu');
$('#btnPages').addEventListener('click', (e) => {
  e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect();
  pageMenu.style.left = r.left + 'px'; pageMenu.style.top = (r.bottom + 2) + 'px'; pageMenu.classList.toggle('open');
});
document.addEventListener('click', () => pageMenu.classList.remove('open'));
pageMenu.addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  pageMenu.classList.remove('open');
  ({ org: openOrganizer, insert: () => actInsert(), delete: actDelete, extract: actExtract })[b.dataset.act]();
});
$('#btnUndo').addEventListener('click', undo);
$('#btnRedo').addEventListener('click', redo);
$('#btnDelete').addEventListener('click', deleteSelected);
const refit = () => { if (S.pdf && ['width', 'page', 'height'].includes(S.fit)) setTimeout(() => setZoom(S.fit), 0); else setTimeout(updatePgBar, 0); };
$('#btnProps').addEventListener('click', () => { $('#props').classList.toggle('hidden'); LS.set('panelHidden', $('#props').classList.contains('hidden')); refit(); });
if (LS.get('panelHidden', false)) $('#props').classList.add('hidden');
function setToolsOpen(open) {
  $('#tools').classList.toggle('collapsed', !open);
  $('#btnTools').textContent = open ? '◀' : '▶';
  $('#btnTools').title = open ? 'ツールバーを閉じる' : 'ツールバーを開く';
  LS.set('toolsOpen', open);
}
$('#btnTools').addEventListener('click', () => { setToolsOpen($('#tools').classList.contains('collapsed')); refit(); });
setToolsOpen(LS.get('toolsOpen', true));
if (hasChrome) {
  chrome.storage.local.get('autoOpen').then(({ autoOpen = true }) => { $('#chkAuto').checked = autoOpen; });
  $('#chkAuto').addEventListener('change', (e) => chrome.storage.local.set({ autoOpen: e.target.checked }));
} else { $('#chkAuto').closest('label').style.display = 'none'; }
$('#btnNative').addEventListener('click', async () => {
  if (!S.sourceUrl) return;
  if (!(await confirmUnsaved('ブラウザーのPDFビューアで開き直す'))) return;
  S.dirty = false;
  const u = new URL(S.sourceUrl); u.hash = u.hash ? u.hash + '&epa-skip' : 'epa-skip'; location.href = u.href;
});
/* 操作のヒント（矢印キーの説明） */
document.querySelectorAll('li').forEach((li) => {
  if (li.textContent.includes('矢印キー')) li.textContent = '矢印キー: 図形を選択中は1pt移動（Shiftで10pt）。選択していないときは、上下=スクロール（1ページ表示では端でページ切り替え）／左右=左右スクロール（動かせないときはページ切り替え）';
});
/* ---- v3.1: 連続描画（既定でオン・設定を保存）／ページの回転／手書き注釈へのまとめ */
$('#chkPin').checked = LS.get('pin', true);
$('#chkPin').addEventListener('change', (e) => LS.set('pin', e.target.checked));
// 表示中のページを90度回転する（上のバーの回転ボタン）
async function rotateCurPage(d) {
  if (!S.pdf || S.busy) return;
  if (encLocked()) { toast('このPDFは編集ロックがかかっているため、ページを回転できません。左の「文書プロパティ」でロックを解除できます。', 6000); return; }
  const n = S.cur, items = currentItems(); items[n - 1].rot = d;
  if (await applyItems(items, 'ページを回転中…')) { goPage(n); toast(`${n}ページ目を${d < 0 ? '左' : '右'}に90°回転しました`); }
}
$('#btnRotL').addEventListener('click', () => rotateCurPage(-90));
$('#btnRotR').addEventListener('click', () => rotateCurPage(90));
$('#btnToInk').addEventListener('click', convertToInk);
/* ---- v3.2: 描画ツールでCtrlを押している間は、注釈の上でも描画用のカーソルにする */
const setCtrlCls = (on) => document.documentElement.classList.toggle('ctrl-draw', on);
window.addEventListener('keydown', (e) => { if (e.key === 'Control') setCtrlCls(true); });
window.addEventListener('keyup', (e) => { if (e.key === 'Control') setCtrlCls(false); });
window.addEventListener('blur', () => setCtrlCls(false));
document.querySelectorAll('#zBox [data-z]').forEach((b) => b.addEventListener('click', () => zOrder(b.dataset.z)));
/* ---- v3.3: カラーパレット（色・塗りつぶしの色の下に12色） */
const PALETTE = [['#000000', '黒'], ['#ffffff', '白'], ['#808080', '灰'], ['#e60012', '赤'], ['#ff7eb6', '桃'], ['#ff8c00', '橙'],
  ['#ffd400', '黄'], ['#22a33a', '緑'], ['#3ec1f0', '水色'], ['#0050d0', '青'], ['#8a2be2', '紫'], ['#8b4513', '茶']];
document.querySelectorAll('.pal').forEach((box) => {
  const inp = document.getElementById(box.dataset.for);
  for (const [c, nm] of PALETTE) {
    const b = document.createElement('button'); b.type = 'button'; b.style.background = c; b.title = `${nm}（${c}）`;
    b.addEventListener('click', () => {
      if (inp.disabled) return;
      inp.value = c; inp.dispatchEvent(new Event('input', { bubbles: true })); inp.dispatchEvent(new Event('change', { bubbles: true }));
    });
    box.appendChild(b);
  }
});
/* ======================================================= 文書プロパティ（編集ロックの解除）／印刷 */
const fmtPdfDate = (d) => { const iso = parsePdfDate(d || ''); return iso ? fmtDate(iso) : '—'; };
const PERM = { PRINT: 0x04, MODIFY: 0x08, COPY: 0x10, ANNOT: 0x20, FILL: 0x100, ASSEMBLE: 0x400, PRINT_HQ: 0x800 };
// 文書プロパティ画面（タイトルなどの編集、情報・セキュリティの表示、編集ロックの解除）
async function openDocProps() {
  if (!S.pdf || S.busy) return;
  if (S.editing) endEdit(true);
  const pdf = S.pdf;
  const meta = await pdf.getMetadata().catch(() => ({ info: {} }));
  const info = meta.info || {};
  const perms = await pdf.getPermissions().catch(() => null);
  const enc = await lockInfo();
  const locked = !!S.libErr || !!(enc && !enc.error);
  const page = await pdf.getPage(S.cur), v = page.getViewport({ scale: 1, rotation: 0 }), r = page.rotate;
  const mm = (pt) => (pt * 25.4 / 72).toFixed(1);
  const kb = S.baseBytes ? S.baseBytes.length : 0;
  const allow = (f) => (!perms || perms.includes(f) ? '<span class="ok">可</span>' : '<span class="ng">不可</span>');
  const row = (k, val) => `<tr><th>${esc(k)}</th><td>${val}</td></tr>`;
  const inp = (id, label, val, ph = '') => `<label class="dp-l">${esc(label)}<input id="${id}" value="${esc(val || '')}" placeholder="${esc(ph)}" ${locked ? 'disabled' : ''}></label>`;
  const res = await dialog({
    title: '文書プロパティ', ok: locked ? '閉じる' : '適用',
    html: `<div class="docprops">
      <h4>概要</h4>
      ${inp('dpTitle', 'タイトル', info.Title)}
      ${inp('dpAuthor', '作成者', info.Author)}
      ${inp('dpSubject', 'サブタイトル（件名）', info.Subject)}
      ${inp('dpKeywords', 'キーワード', info.Keywords, '複数のときは、カンマ（,）で区切る')}
      <h4>情報</h4>
      <table class="dp-t">
        ${row('ファイル名', esc(S.fileName))}
        ${row('ファイルサイズ', kb >= 1048576 ? (kb / 1048576).toFixed(2) + ' MB' : Math.max(1, Math.round(kb / 1024)) + ' KB')}
        ${row('ページ数', pdf.numPages)}
        ${row(`ページサイズ（${S.cur}ページ目）`, `${mm(v.width)} × ${mm(v.height)} mm（${Math.round(v.width)} × ${Math.round(v.height)} pt）${r ? `／${r}°回転` : ''}`)}
        ${row('PDFのバージョン', esc(info.PDFFormatVersion || '—'))}
        ${row('作成日時', esc(fmtPdfDate(info.CreationDate)))}
        ${row('更新日時', esc(fmtPdfDate(info.ModDate)))}
        ${row('作成アプリケーション', esc(info.Creator || '—'))}
        ${row('PDF変換', esc(info.Producer || '—'))}
      </table>
      <h4>セキュリティ（編集ロック）</h4>
      <table class="dp-t">
        ${row('状態', locked ? `<b class="ng">編集ロックあり</b>${enc && enc.label ? `（${esc(enc.label)}）` : ''}` : '<span class="ok">ロックなし</span>')}
        ${row('許可されている操作', `印刷 ${allow(PERM.PRINT)}／変更 ${allow(PERM.MODIFY)}／コピー ${allow(PERM.COPY)}／注釈 ${allow(PERM.ANNOT)}／ページの組み替え ${allow(PERM.ASSEMBLE)}`)}
      </table>
      ${locked ? `<div class="dp-unlock">
        <p class="small">所有者パスワード（権限パスワード）を入力すると、編集ロックを解除できます。解除したあとに保存すると、ロックのないPDFになります。</p>
        <div class="dp-row"><input id="dpPw" type="password" placeholder="所有者パスワード" autocomplete="off"><button type="button" id="dpUnlock" class="pri">ロックを解除</button></div>
        <p id="dpMsg" class="derr"></p>
      </div>` : ''}
    </div>`,
    init: (d, signal) => {
      const btn = d.querySelector('#dpUnlock'); if (!btn) return;
      const pw = d.querySelector('#dpPw'), msg = d.querySelector('#dpMsg');
      setTimeout(() => pw.focus(), 0);
      pw.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); btn.click(); } }, { signal });
      btn.addEventListener('click', async () => {
        btn.disabled = true; msg.textContent = '確認しています…'; msg.classList.remove('derr-ok');
        try {
          const r2 = await UNLOCK.unlock(await baseAll(), pw.value);
          if (r2.error === 'password') { msg.textContent = 'パスワードが違います。所有者パスワード（権限パスワード）を入力してください。'; btn.disabled = false; pw.select(); return; }
          d.close();
          await applyUnlocked(r2.bytes);
        } catch (e) { console.error(e); msg.textContent = 'ロックを解除できませんでした: ' + (e.message || e); btn.disabled = false; }
      }, { signal });
    },
    validate: (d) => (locked ? null : {
      title: d.querySelector('#dpTitle').value, author: d.querySelector('#dpAuthor').value,
      subject: d.querySelector('#dpSubject').value, keywords: d.querySelector('#dpKeywords').value,
    }),
  });
  if (!res) return;
  if (res.title === (info.Title || '') && res.author === (info.Author || '') && res.subject === (info.Subject || '') && res.keywords === (info.Keywords || '')) return;
  const sn = takeSnap(); setBusy(true, '文書プロパティを変更中…');
  try {
    const doc = await PDFDocument.load(await baseAll(), { updateMetadata: false });
    doc.setTitle(res.title); doc.setAuthor(res.author); doc.setSubject(res.subject);
    doc.setKeywords(res.keywords.split(/\s*[,、，;；]\s*/).filter(Boolean));
    doc.setModificationDate(new Date());
    await setBase(await doc.save({ useObjectStreams: false })); commit(sn);
    toast('文書プロパティを変更しました（保存すると、ファイルに反映されます）');
  } catch (e) { console.error(e); toast('文書プロパティを変更できませんでした: ' + friendlyError(e), 6000); }
  finally { setBusy(false); }
}
// ロックを解除したPDFに差し替える（元に戻せる）
async function applyUnlocked(bytes) {
  const sn = takeSnap(); setBusy(true, '編集ロックを解除しています…');
  try {
    await setBase(bytes);
    S.libErr = null; await probeLib(bytes, S.loadGen);
    commit(sn); S.dirty = true;
    toast('編集ロックを解除しました。保存すると、ロックのないPDFとして保存されます。', 6000);
  } catch (e) { console.error(e); toast('ロックを解除できませんでした: ' + friendlyError(e), 6000); }
  finally { setBusy(false); }
}
$('#btnDocProps').addEventListener('click', openDocProps);
/* ------------------------------------------------------- 印刷
   印刷ダイアログで範囲・用紙・倍率などを決め、印刷用のPDFを作ってブラウザー標準のPDF印刷に渡す。
   （ページを画像にしないので、大きな文書でもすぐ印刷画面が開く。うまく渡せない環境では画像方式で印刷する） */
const PRINT_DPI = 200;
let printing = false, printFrame = null, printFrameUrl = null;
const PAPERS = {
  same: { label: 'PDFのページと同じ' },
  A3: { label: 'A3（297 × 420 mm）', w: 841.89, h: 1190.55 },
  A4: { label: 'A4（210 × 297 mm）', w: 595.28, h: 841.89 },
  A5: { label: 'A5（148 × 210 mm）', w: 419.53, h: 595.28 },
  B4: { label: 'B4（257 × 364 mm）', w: 728.5, h: 1031.81 },
  B5: { label: 'B5（182 × 257 mm）', w: 515.91, h: 728.5 },
  Letter: { label: 'レター（8.5 × 11 in）', w: 612, h: 792 },
  Legal: { label: 'リーガル（8.5 × 14 in）', w: 612, h: 1008 },
};
const PRINT_DEF = { paper: 'A4', fit: 'fit', pct: 100, orient: 'auto', annots: 'all', reverse: false, bind: 'none', bindMm: 10, duplex: 'simplex' };
// 前回の印刷設定（両面の指定だけは覚えず、毎回「片面印刷」から始める）
function loadPrintOpt() {
  let old = {}; try { old = JSON.parse(localStorage.getItem('epaPrintOpt') || '{}'); } catch {}   // v4.1〜4.2 の保存場所
  return { ...PRINT_DEF, ...old, ...LS.get('print', {}), duplex: 'simplex' };
}
function savePrintOpt(o) { const { paper, fit, pct, orient, annots, reverse, bind, bindMm } = o; LS.set('print', { paper, fit, pct, orient, annots, reverse, bind, bindMm }); }
// 印刷ダイアログの入力値を読む
function readPrintForm(dlg) {
  const q = (s) => dlg.querySelector(s), val = (name) => q(`input[name=${name}]:checked`).value;
  return {
    range: val('prRange'), pages: q('#prPages').value, reverse: q('#prRev').checked,
    paper: q('#prPaper').value, fit: val('prFit'), pct: +q('#prPct').value || 100, orient: val('prOri'),
    bind: val('prBind'), bindMm: +q('#prBindMm').value || 10, duplex: q('#prDup').value, annots: q('#prAnn').value,
  };
}
// 印刷する用紙の並び（0始まりのページ番号の配列）。ページ指定が正しくなければ例外
function printPageList(r, n, cur) {
  const l = r.range === 'cur' ? [cur - 1] : r.range === 'pages' ? parseRange(r.pages, n) : [...Array(n).keys()];
  return r.reverse ? l.slice().reverse() : l;
}
// とじしろを付ける辺（用紙の座標で left/right/top/bottom）。両面で同じ向きにめくる場合、裏面は左右を入れ替える
function bindSide(PW, PH, o, sheet) {
  if (!o.bind || o.bind === 'none' || !(+o.bindMm > 0)) return null;
  const portrait = PW <= PH;
  let side = (o.bind === 'long') === portrait ? 'left' : 'top';
  const flip = o.duplex === 'long' ? 'long' : o.duplex === 'short' ? 'short' : null;
  if (flip && flip === o.bind && side === 'left' && sheet % 2 === 1) side = 'right';
  return side;
}
// ページ（切り抜き範囲 cw×ch、回転 rot）を用紙のどこに何倍で置くか。sheet は何枚目の用紙か（0から）
function printLayout(cw, ch, rot, o, sheet = 0) {
  const dw = rot % 180 ? ch : cw, dh = rot % 180 ? cw : ch;
  const custom = o.fit === 'custom' ? Math.max(1, Math.min(1000, +o.pct || 100)) / 100 : null;
  let PW, PH;
  if (o.paper === 'same' || !PAPERS[o.paper]) { PW = dw; PH = dh; }
  else {
    const P = PAPERS[o.paper], land = o.orient === 'land' || (o.orient === 'auto' && dw > dh);
    PW = land ? Math.max(P.w, P.h) : Math.min(P.w, P.h); PH = land ? Math.min(P.w, P.h) : Math.max(P.w, P.h);
  }
  // とじしろを除いた、ページを置ける範囲（PDFの座標: 左下が原点）
  const side = bindSide(PW, PH, o, sheet), m = side ? Math.min(+o.bindMm * 72 / 25.4, (side === 'left' || side === 'right' ? PW : PH) * 0.5) : 0;
  const ax = side === 'left' ? m : 0, ay = side === 'bottom' ? m : 0;
  const aw = PW - (side === 'left' || side === 'right' ? m : 0), ah = PH - (side === 'top' || side === 'bottom' ? m : 0);
  const fitS = Math.min(aw / dw, ah / dh);
  let s;
  if (o.paper === 'same' || !PAPERS[o.paper]) s = custom || (m ? Math.min(1, fitS) : 1);
  else s = o.fit === 'actual' ? 1 : o.fit === 'shrink' ? Math.min(1, fitS) : custom || fitS;
  return { PW, PH, s, dw, dh, tx: ax + (aw - dw * s) / 2, ty: ay + (ah - dh * s) / 2, side, m };
}
// 回転込みで、ページの内容の座標 → 用紙の座標 にする行列
function printMatrix(cx, cy, cw, ch, rot, L) {
  const D = rot === 90 ? [0, -1, 1, 0, -cy, cw + cx] : rot === 180 ? [-1, 0, 0, -1, cw + cx, ch + cy]
    : rot === 270 ? [0, 1, -1, 0, ch + cy, -cx] : [1, 0, 0, 1, -cx, -cy];
  const s = L.s;
  return [s * D[0], s * D[1], s * D[2], s * D[3], s * D[4] + L.tx, s * D[5] + L.ty];
}
const pnum = (v) => { const r = Math.round(v * 10000) / 10000; return Object.is(r, -0) ? '0' : String(r); };
// 印刷のもとにするPDF（追加した注釈を含む・暗号化を外したもの）
async function printSourceBytes() {
  if (encLocked()) {      // 暗号化されたPDF: 印刷用のコピーだけ暗号化を外し、追加した注釈を書き込む
    const r = await UNLOCK.unlock(await baseAll(), '', { asUser: true });
    if (r.bytes) return S.annots.length ? await buildViaPdfLib(r.bytes) : r.bytes;
  }
  return await buildPdfBytes();
}
// ページの注釈のうち test(サブタイプ, フラグF) が真のものを、外観（見た目）どおりに描く命令を作る。
// 描いた注釈と、それに付いたポップアップは、ページの注釈の一覧から外す。戻り値 ops はページの座標系で描く命令。
function flattenPageAnnots(doc, node, test) {
  const { PDFName, PDFArray, PDFDict, PDFNumber, PDFRef } = window.PDFLib;
  const ctx = doc.context, N = (n) => PDFName.of(n);
  const numOf = (v) => { v = ctx.lookup(v); return v instanceof PDFNumber ? v.asNumber() : 0; };
  const annots = node.lookup(N('Annots'));
  if (!(annots instanceof PDFArray)) return { ops: '', count: 0 };
  node.normalize();
  let ops = '';
  const done = new Set(), keep = [];
  for (let j = 0; j < annots.size(); j++) {
    const raw = annots.get(j);
    try {
      const a = ctx.lookup(raw); if (!(a instanceof PDFDict)) { keep.push(raw); continue; }
      const st = a.lookup(N('Subtype')), sub = st ? st.asString().slice(1) : '';
      const F = numOf(a.get(N('F')));
      if (sub === 'Popup' || !test(sub, F)) { keep.push(raw); continue; }
      done.add(a);
      const ap = a.lookup(N('AP')); if (!(ap instanceof PDFDict)) continue;      // 見た目がないものは、描かずに外す
      let ref = ap.get(N('N')), nv = ctx.lookup(ref);
      if (nv instanceof PDFDict && !nv.get(N('BBox'))) {     // 状態ごとの外観（チェックボックスなど）
        const as = a.lookup(N('AS')); if (!as) continue;
        ref = nv.get(as); nv = ctx.lookup(ref);
      }
      if (!(ref instanceof PDFRef) || !nv || !nv.dict) continue;
      const bb = nv.dict.lookup(N('BBox')), rc = a.lookup(N('Rect'));
      if (!(bb instanceof PDFArray) || !(rc instanceof PDFArray)) continue;
      // 外観の BBox（Matrix で変換したもの）が、注釈の Rect にぴったり収まるように置く（PDFの仕様どおり）
      const B = bb.asArray().map(numOf), R = rc.asArray().map(numOf);
      const mt = nv.dict.lookup(N('Matrix')), m = mt instanceof PDFArray ? mt.asArray().map(numOf) : [1, 0, 0, 1, 0, 0];
      const xs = [], ys = [];
      for (const [x, y] of [[B[0], B[1]], [B[2], B[1]], [B[0], B[3]], [B[2], B[3]]]) { xs.push(m[0] * x + m[2] * y + m[4]); ys.push(m[1] * x + m[3] * y + m[5]); }
      const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
      const r0 = Math.min(R[0], R[2]), r1 = Math.min(R[1], R[3]), rw = Math.abs(R[2] - R[0]), rh = Math.abs(R[3] - R[1]);
      if (x1 - x0 < 1e-6 || y1 - y0 < 1e-6 || rw < 1e-6 || rh < 1e-6) continue;
      const sx = rw / (x1 - x0), sy = rh / (y1 - y0);
      const name = node.newXObject('EPAp', ref);
      ops += `q ${pnum(sx)} 0 0 ${pnum(sy)} ${pnum(r0 - x0 * sx)} ${pnum(r1 - y0 * sy)} cm ${name.asString()} Do Q\n`;
    } catch (e) { console.warn('注釈を描けませんでした', e); keep.push(raw); }
  }
  // 描いた注釈に付いていたポップアップ（コメントの吹き出し）も外す
  const rest = keep.filter((r) => {
    const d = ctx.lookup(r);
    if (!(d instanceof PDFDict)) return true;
    const st = d.lookup(N('Subtype'));
    return !(st && st.asString() === '/Popup' && done.has(d.lookup(N('Parent'))));
  });
  if (rest.length) node.set(N('Annots'), ctx.obj(rest)); else node.delete(N('Annots'));
  return { ops, count: done.size };
}
// 選んだページ・用紙・倍率で、印刷用のPDFを作る（注釈は見た目どおりにページへ焼き込む）
async function buildPrintPdf(srcBytes, idxs, o) {
  const { PDFDocument, PDFName, PDFArray } = window.PDFLib;
  const src = await PDFDocument.load(srcBytes, { ignoreEncryption: true, updateMetadata: false });
  const out = await PDFDocument.create({ updateMetadata: false });
  const ctx = out.context, N = (n) => PDFName.of(n);
  const pages = await out.copyPages(src, idxs);
  for (const [sheet, p] of pages.entries()) {
    const node = p.node;
    const mb = p.getMediaBox(), cb = p.getCropBox();
    const cx = Math.max(mb.x, cb.x), cy = Math.max(mb.y, cb.y);
    const cw = Math.min(mb.x + mb.width, cb.x + cb.width) - cx || mb.width, ch = Math.min(mb.y + mb.height, cb.y + cb.height) - cy || mb.height;
    const rot = (((p.getRotation().angle || 0) % 360) + 360) % 360;
    const L = printLayout(cw, ch, rot, o, sheet), M = printMatrix(cx, cy, cw, ch, rot, L).map(pnum).join(' ');
    out.addPage(p);
    node.normalize();
    // 注釈の外観をページの内容として描く（「文書」はフォームの値だけ）
    const { ops: annOps } = flattenPageAnnots(out, node, (sub, F) => !!(F & 4) && !(F & 2) && (o.annots !== 'doc' || sub === 'Widget'));
    node.delete(N('Annots'));
    // もとの内容を、用紙に合わせて縮小・回転・移動して描く
    const pre = ctx.register(ctx.stream(`q ${M} cm ${pnum(cx)} ${pnum(cy)} ${pnum(cw)} ${pnum(ch)} re W n\n`));
    const post = ctx.register(ctx.stream(`\nQ\n` + (annOps ? `q ${M} cm\n${annOps}Q\n` : '')));
    const cur = node.get(N('Contents')), arr = [pre];
    const curV = ctx.lookup(cur);
    if (curV instanceof PDFArray) for (let j = 0; j < curV.size(); j++) arr.push(curV.get(j));
    else if (cur) arr.push(cur);
    arr.push(post);
    node.set(N('Contents'), ctx.obj(arr));
    node.set(N('MediaBox'), ctx.obj([0, 0, +pnum(L.PW), +pnum(L.PH)]));
    for (const k of ['CropBox', 'BleedBox', 'TrimBox', 'ArtBox', 'Rotate']) node.delete(N(k));
  }
  out.setTitle(S.fileName || 'PDF');
  // ブラウザーの印刷画面の「両面印刷」の初期値にする（既定は片面）
  try {
    const D = window.PDFLib.Duplex;
    out.catalog.getOrCreateViewerPreferences().setDuplex(o.duplex === 'long' ? D.DuplexFlipLongEdge : o.duplex === 'short' ? D.DuplexFlipShortEdge : D.Simplex);
  } catch (e) { console.warn(e); }
  return await out.save();
}
// 画像方式（予備）: 各ページを高解像度の画像にして、このページごと印刷する
async function printAsImages(bytes) {
  const box = $('#printContainer'), urls = [];
  const doc = await openPdfJs(bytes);
  try {
    box.replaceChildren();
    const v1 = (await doc.getPage(1)).getViewport({ scale: 1 });
    $('#printPageStyle').textContent = `@page { size: ${v1.width}pt ${v1.height}pt; margin: 0; }`;
    for (let i = 1; i <= doc.numPages; i++) {
      $('#busyMsg').textContent = `印刷の準備中… ${i} / ${doc.numPages}`;
      const page = await doc.getPage(i), v0 = page.getViewport({ scale: 1 });
      let sc = PRINT_DPI / 72; while (v0.width * sc * v0.height * sc > 16e6) sc *= 0.85;
      const vp = page.getViewport({ scale: sc });
      const cv = document.createElement('canvas'); cv.width = Math.floor(vp.width); cv.height = Math.floor(vp.height);
      const c2 = cv.getContext('2d'); c2.fillStyle = '#fff'; c2.fillRect(0, 0, cv.width, cv.height);
      globalThis.__EPA_MINW = 0;
      globalThis.__EPA_MESHMAX = 9e6;                       // 印刷: グラデーション（メッシュ）を細かく描く（画面表示では軽くするため 1e6 画素まで）
      try { await page.render({ canvasContext: c2, viewport: vp, intent: 'print', annotationMode: pdfjsLib.AnnotationMode.DISABLE }).promise; }
      finally { globalThis.__EPA_MESHMAX = 0; }
      const blob = await new Promise((res) => cv.toBlob(res, 'image/jpeg', 0.92));
      freeCanvas(cv);
      const url = URL.createObjectURL(blob); urls.push(url);
      const pe = document.createElement('div'); pe.className = 'printedPage';
      const img = new Image(); img.src = url; pe.appendChild(img); box.appendChild(pe);
    }
    await Promise.all([...box.querySelectorAll('img')].map((im) => im.decode().catch(() => {})));
  } catch (e) { box.replaceChildren(); urls.forEach((u) => URL.revokeObjectURL(u)); throw e; }
  finally { doc.destroy(); }
  setBusy(false);
  document.body.classList.add('printing');
  await new Promise((res) => {
    const done = () => { if (!document.body.classList.contains('printing')) return; document.body.classList.remove('printing'); box.replaceChildren(); urls.forEach((u) => URL.revokeObjectURL(u)); res(); };
    window.addEventListener('afterprint', done, { once: true });
    window.print();
    setTimeout(() => { if (!matchMedia('print').matches) done(); }, 1000);   // afterprint が来ない環境への保険
  });
}
function clearPrintFrame() {
  if (printFrame) printFrame.remove();
  if (printFrameUrl) URL.revokeObjectURL(printFrameUrl);
  printFrame = printFrameUrl = null;
}
window.addEventListener('pagehide', clearPrintFrame);
// 印刷用のPDFを見えない枠に読み込み、ブラウザーのPDF印刷を呼ぶ
function printViaFrame(bytes) {
  return new Promise((resolve, reject) => {
    clearPrintFrame();
    printFrameUrl = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    const fr = printFrame = document.createElement('iframe');
    fr.className = 'printFrame'; fr.setAttribute('aria-hidden', 'true'); fr.tabIndex = -1;
    const to = setTimeout(() => reject(new Error('印刷用PDFの読み込みが終わりませんでした')), 20000);
    fr.addEventListener('load', () => {
      clearTimeout(to);
      setTimeout(() => {
        try { const w = fr.contentWindow; w.focus(); w.print(); resolve(); }
        catch (e) { reject(e); }
      }, 150);
    }, { once: true });
    fr.src = printFrameUrl;
    document.body.appendChild(fr);
  });
}
// 印刷: ダイアログ → 印刷用PDFの作成 → ブラウザーのPDF印刷
async function printDoc() {
  if (!S.pdf || S.busy || printing) return;
  if (S.editing) endEdit(true);
  const perms = await S.pdf.getPermissions().catch(() => null);
  if (perms && !perms.includes(PERM.PRINT)) { toast('このPDFは、文書の設定で印刷が禁止されています。左の「文書プロパティ」で編集ロックを解除すると印刷できます。', 7000); return; }
  printing = true;
  let srcDoc = S.pdf, tmpDoc = null, srcP = null;
  try {
    const n = S.pdf.numPages, cur = S.cur;
    const o = loadPrintOpt();
    // 印刷のもとにするPDFは必要になったときに1回だけ作る（大きい・暗号化されたPDFでもダイアログはすぐ開く）
    const getSrc = () => { if (!srcP) { srcP = printSourceBytes(); srcP.catch(() => {}); } return srcP; };
    const opts = (sel, def) => Object.entries(sel).map(([k, v]) => `<option value="${k}" ${k === def ? 'selected' : ''}>${esc(v)}</option>`).join('');
    const rad = (name, val, label, def) => `<label><input type="radio" name="${name}" value="${val}" ${val === def ? 'checked' : ''}>${esc(label)}</label>`;
    let pv = { list: [], k: 0, tok: 0, task: null, timer: 0 };
    const res = await dialog({
      title: '印刷', ok: '印刷',
      html: `<div class="prdlg">
        <div class="pr-opts">
          <h4>印刷するページ</h4>
          <div class="pr-row">${rad('prRange', 'all', 'すべて', 'all')}${rad('prRange', 'cur', `現在のページ（${cur}）`, 'all')}${rad('prRange', 'pages', 'ページ指定', 'all')}
            <input id="prPages" placeholder="例: 1-3, 5" disabled></div>
          <label class="pr-chk"><input type="checkbox" id="prRev" ${o.reverse ? 'checked' : ''}>逆順で印刷</label>
          <h4>用紙とサイズ</h4>
          <label class="pr-l">用紙 <select id="prPaper">${opts(Object.fromEntries(Object.entries(PAPERS).map(([k, v]) => [k, v.label])), o.paper)}</select></label>
          <div class="pr-row" id="prFitRow">${rad('prFit', 'fit', '合わせる', o.fit)}${rad('prFit', 'actual', '実際のサイズ', o.fit)}${rad('prFit', 'shrink', '大きいページを縮小', o.fit)}</div>
          <div class="pr-row">${rad('prFit', 'custom', 'カスタム倍率', o.fit)}<input id="prPct" type="number" min="1" max="1000" value="${+o.pct || 100}"> %</div>
          <div class="pr-row" id="prOriRow">向き: ${rad('prOri', 'auto', '縦・横を自動', o.orient)}${rad('prOri', 'port', '縦', o.orient)}${rad('prOri', 'land', '横', o.orient)}</div>
          <div class="pr-row">とじしろ: ${rad('prBind', 'none', 'なし', o.bind)}${rad('prBind', 'short', '短辺', o.bind)}${rad('prBind', 'long', '長辺', o.bind)}
            <span class="pr-mm"><input id="prBindMm" type="number" min="1" max="100" step="1" value="${+o.bindMm || 10}"> mm</span></div>
          <h4>両面印刷</h4>
          <select id="prDup">${opts({ simplex: '片面印刷', long: '両面印刷（長辺とじ）', short: '両面印刷（短辺とじ）' }, 'simplex')}</select>
          <h4>注釈とフォーム</h4>
          <select id="prAnn">${opts({ all: '文書と注釈', doc: '文書（注釈を印刷しない）' }, o.annots)}</select>
          <p class="pr-note">プリンター・部数・カラーは、［印刷］を押したあとに開くブラウザーの印刷画面で選びます（拡張機能からはプリンターを直接選べないため）。片面／両面はここでの指定が印刷画面の初期値になります。</p>
        </div>
        <div class="pr-prev">
          <div class="pr-cvwrap"><canvas id="prCv"></canvas></div>
          <div class="pr-nav"><button type="button" id="prPrev">‹</button><span id="prNo">用紙 1 / 1</span><button type="button" id="prNext">›</button></div>
          <div class="pr-info" id="prInfo"></div>
        </div>
      </div>`,
      init(dlg, signal) {
        const q = (s) => dlg.querySelector(s);
        // プレビュー: 表示中の用紙1枚だけを小さく描く（新しい描画が始まったら古いものは中断）
        const draw = async () => {
          const r = readPrintForm(dlg), tok = ++pv.tok;
          q('#prPages').disabled = r.range !== 'pages';
          const same = r.paper === 'same';
          q('#prFitRow').classList.toggle('dis', same); q('#prOriRow').classList.toggle('dis', same);
          q('#prPct').disabled = r.fit !== 'custom';
          q('#prBindMm').disabled = r.bind === 'none';
          let list; try { list = printPageList(r, n, cur); q('#derr').textContent = ''; } catch (e) { q('#derr').textContent = e.message; return; }
          if (list.join() !== pv.list.join()) { pv.list = list; pv.k = 0; }
          pv.k = Math.max(0, Math.min(pv.k, list.length - 1));
          q('#prNo').textContent = `用紙 ${pv.k + 1} / ${list.length}`;
          q('#prPrev').disabled = pv.k <= 0; q('#prNext').disabled = pv.k >= list.length - 1;
          if (pv.task) { try { pv.task.cancel(); } catch {} pv.task = null; }     // 描きかけのプレビューは止める
          const page = await srcDoc.getPage(list[pv.k] + 1); if (tok !== pv.tok) return;
          const [vx0, vy0, vx1, vy1] = page.view, rot = ((page.rotate % 360) + 360) % 360;
          const L = printLayout(vx1 - vx0, vy1 - vy0, rot, r, pv.k);
          const mm = (pt) => (pt * 25.4 / 72).toFixed(1);
          const sideJ = { left: '左', right: '右', top: '上', bottom: '下' }[L.side];
          q('#prInfo').innerHTML = `${list[pv.k] + 1}ページ目（${mm(L.dw)} × ${mm(L.dh)} mm）<br>用紙 ${mm(L.PW)} × ${mm(L.PH)} mm／倍率 ${(L.s * 100).toFixed(1)}%` +
            (L.side ? `<br>とじしろ: ${sideJ}に ${mm(L.m)} mm` : '');
          const cv = q('#prCv'), dpr = window.devicePixelRatio || 1, k = Math.min(300 / L.PW, 380 / L.PH);
          const W = Math.max(1, Math.round(L.PW * k)), H = Math.max(1, Math.round(L.PH * k));
          const vp = page.getViewport({ scale: L.s * k * dpr });
          const tmp = document.createElement('canvas'); tmp.width = Math.max(1, Math.ceil(vp.width)); tmp.height = Math.max(1, Math.ceil(vp.height));
          globalThis.__EPA_MINW = 0;
          try {
            const task = pv.task = page.render({ canvasContext: tmp.getContext('2d'), viewport: vp, intent: 'print',
              annotationMode: r.annots === 'doc' ? pdfjsLib.AnnotationMode.DISABLE : pdfjsLib.AnnotationMode.ENABLE });
            await task.promise;
            if (pv.task === task) pv.task = null;
          } catch (e) { freeCanvas(tmp); if (tok === pv.tok && !(e && e.name === 'RenderingCancelledException')) console.warn(e); return; }
          if (tok !== pv.tok) { freeCanvas(tmp); return; }
          cv.width = W * dpr; cv.height = H * dpr; cv.style.width = W + 'px'; cv.style.height = H + 'px';
          const c = cv.getContext('2d');
          c.fillStyle = '#fff'; c.fillRect(0, 0, cv.width, cv.height);
          c.drawImage(tmp, L.tx * k * dpr, (L.PH - L.ty - L.dh * L.s) * k * dpr);
          freeCanvas(tmp);
          if (L.side) {          // とじしろの位置を点線で示す
            const z = k * dpr, mz = L.m * z;
            c.save(); c.fillStyle = 'rgba(80,140,230,.12)'; c.strokeStyle = '#3a78d8'; c.lineWidth = Math.max(1, dpr); c.setLineDash([4 * dpr, 3 * dpr]);
            const rect = L.side === 'left' ? [0, 0, mz, cv.height] : L.side === 'right' ? [cv.width - mz, 0, mz, cv.height]
              : L.side === 'top' ? [0, 0, cv.width, mz] : [0, cv.height - mz, cv.width, mz];
            c.fillRect(...rect);
            c.beginPath();
            if (L.side === 'left') { c.moveTo(mz, 0); c.lineTo(mz, cv.height); }
            else if (L.side === 'right') { c.moveTo(cv.width - mz, 0); c.lineTo(cv.width - mz, cv.height); }
            else if (L.side === 'top') { c.moveTo(0, mz); c.lineTo(cv.width, mz); }
            else { c.moveTo(0, cv.height - mz); c.lineTo(cv.width, cv.height - mz); }
            c.stroke(); c.restore();
          }
        };
        pv.redraw = draw;
        const later = () => { clearTimeout(pv.timer); pv.timer = setTimeout(draw, 150); };   // 入力中は少し待ってから描く
        dlg.addEventListener('input', later, { signal }); dlg.addEventListener('change', later, { signal });
        signal.addEventListener('abort', () => { clearTimeout(pv.timer); pv.tok++; if (pv.task) try { pv.task.cancel(); } catch {} });
        q('#prPrev').addEventListener('click', () => { pv.k--; draw(); }, { signal });
        q('#prNext').addEventListener('click', () => { pv.k++; draw(); }, { signal });
        draw();
        // 追加した注釈があるときだけ、プレビュー用に注釈入りのPDFを裏で用意する（ダイアログを先に表示してから）
        if (S.annots.length) setTimeout(() => !signal.aborted && getSrc().then(async (b) => {
          if (signal.aborted) return;
          try { tmpDoc = await openPdfJs(b.slice()); if (!signal.aborted) { srcDoc = tmpDoc; draw(); } } catch (e) { console.warn(e); }
        }, () => {}), 300);
      },
      validate(dlg) { const r = readPrintForm(dlg); return { ...r, idxs: printPageList(r, n, cur) }; },
    });
    if (tmpDoc) { srcDoc = S.pdf; tmpDoc.destroy(); tmpDoc = null; }
    if (!res) return;
    savePrintOpt(res);
    setBusy(true, '印刷用のPDFを作成中…');
    $('#busy').classList.add('show');
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 30)));    // 「作成中」を先に表示してから重い処理に入る
    const src = await getSrc();
    const bytes = await buildPrintPdf(src.slice(), res.idxs, res);
    if (window.__EPA_printHook) { await window.__EPA_printHook(bytes, res); setBusy(false); return; }   // テスト用
    setBusy(false);
    try { await printViaFrame(bytes); }
    catch (e) {
      console.warn('ブラウザーのPDF印刷に渡せなかったため、画像方式で印刷します', e);
      clearPrintFrame();
      setBusy(true, '印刷の準備中…');
      await printAsImages(bytes);
    }
  } catch (e) {
    console.error(e); toast('印刷できませんでした: ' + friendlyError(e), 6000);
  } finally {
    if (tmpDoc) tmpDoc.destroy();
    setBusy(false); printing = false;
  }
}
$('#btnPrint').addEventListener('click', printDoc);
/* ------------------------------------------------------- 注釈埋め込み
   注釈（このアドオンで追加したもの・もとからあったもの）を、見た目どおりにページの内容へ描き込み、注釈としては取り除く。
   フォームの入力欄とリンクは、そのまま残す。「元に戻す」で取り消せる。 */
async function embedAnnots() {
  if (!S.pdf || S.busy) return;
  if (S.editing) endEdit(true);
  if (encLocked()) { toast('このPDFは編集ロックがかかっているため、注釈を埋め込めません。左の「文書プロパティ」でロックを解除できます。', 6000); return; }
  const cur = S.cur;
  const res = await dialog({
    title: '注釈埋め込み', ok: '埋め込む',
    html: `<div class="embdlg">
      <label><input type="radio" name="embScope" value="all" checked>すべての注釈を埋め込む</label>
      <label><input type="radio" name="embScope" value="cur">現在のページ（${cur}ページ目）の注釈を埋め込む</label>
      <p class="pr-note">埋め込んだ注釈はページの内容の一部になり、注釈としての移動・編集・削除はできなくなります（直後なら「戻す」で取り消せます）。フォームの入力欄とリンクはそのまま残ります。</p>
    </div>`,
    validate: (dlg) => dlg.querySelector('input[name=embScope]:checked').value,
  });
  if (!res) return;
  const targets = res === 'cur' ? new Set([cur]) : new Set(S.pages.map((p) => p.num));
  const sn = takeSnap(); setBusy(true, '注釈を埋め込み中…');
  try {
    const doc = await PDFDocument.load(await baseAll(), { updateMetadata: false });
    await writeAnnots(doc, S.annots.filter((a) => targets.has(a.page)));
    let count = 0;
    doc.getPages().forEach((page, i) => {
      if (!targets.has(i + 1)) return;
      const node = page.node, ctx = doc.context, N = (n) => PDFName.of(n);
      const r = flattenPageAnnots(doc, node, (sub, F) => !(F & 2) && !(F & 32) && sub !== 'Widget' && sub !== 'Link');
      count += r.count;
      if (!r.ops) return;
      // もとの内容を q … Q で包んでから注釈を描く（もとの内容の座標変換などが残っていても、注釈の位置がずれない）
      const pre = ctx.register(ctx.stream('q\n')), post = ctx.register(ctx.stream('\nQ\n' + r.ops));
      const c = node.get(N('Contents')), cv = ctx.lookup(c), arr = [pre];
      if (cv instanceof PDFArray) for (let j = 0; j < cv.size(); j++) arr.push(cv.get(j)); else if (c) arr.push(c);
      arr.push(post);
      node.set(N('Contents'), ctx.obj(arr));
    });
    if (!count) { toast(res === 'cur' ? 'このページには、埋め込む注釈がありません' : '埋め込む注釈がありません'); return; }
    const bytes = await doc.save({ useObjectStreams: false });
    S.annots = S.annots.filter((a) => !targets.has(a.page)); S.sel = new Set();
    await setBase(bytes); commit(sn); redrawAll(); syncProps();
    toast(`${count}個の注釈をページに埋め込みました`);
  } catch (e) { console.error(e); toast('注釈を埋め込めませんでした: ' + friendlyError(e), 6000); }
  finally { setBusy(false); }
}
$('#btnEmbed').addEventListener('click', embedAnnots);
/* ------------------------------------------------------- 起動 */
syncZoomUi();
document.body.classList.toggle('paged', !!S.paged);
syncProps(); updateButtons(); renderList();
const qp = new URLSearchParams(location.search);
if (qp.get('file')) loadFromUrl(qp.get('file'));
