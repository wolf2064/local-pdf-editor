/* PDF 内容編集エンジン（ページのコンテンツストリームを直接読み書きする）
 *  - ベクター（パス）: 移動・拡大縮小・削除・複製・線の色・塗りの色・線の太さ
 *  - 文字（テキスト行）: 移動・拡大縮小・削除・複製・文字の色・文字の置き換え
 *  画像（スキャン画像など）は対象外。フォームXObjectの中身も編集できる（そのページ専用の複製を作って書き換える）。
 *  座標はすべてページの既定ユーザー空間（PDF座標, pt）。行列は PDF と同じ [a b c d e f]（行ベクトル × 行列）。 */
export function createContentEditor(PDFLib) {
  const { PDFName, PDFDict, PDFArray, PDFRef, PDFStream, PDFString, decodePDFRawStream, StandardFontEmbedder, StandardFonts } = PDFLib;
  const N = (k) => PDFName.of(k);

  /* ---------------------------------------------------------------- 行列 */
  const I = [1, 0, 0, 1, 0, 0];
  const mul = (m, n) => [m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3], m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5]];
  const inv = (m) => {
    const d = m[0] * m[3] - m[1] * m[2];
    if (!d || !isFinite(d)) return null;
    return [m[3] / d, -m[1] / d, -m[2] / d, m[0] / d, (m[2] * m[5] - m[3] * m[4]) / d, (m[1] * m[4] - m[0] * m[5]) / d];
  };
  const ap = (m, x, y) => [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]];
  const isId = (m) => Math.abs(m[0] - 1) < 1e-9 && Math.abs(m[1]) < 1e-9 && Math.abs(m[2]) < 1e-9 && Math.abs(m[3] - 1) < 1e-9 && Math.abs(m[4]) < 1e-7 && Math.abs(m[5]) < 1e-7;
  const mscale = (m) => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;
  const F = (v) => {
    if (!isFinite(v)) v = 0;
    let s = String(Math.round(v * 1e5) / 1e5);
    if (s.includes('e')) s = Math.abs(v) < 1 ? '0' : v.toFixed(3);
    return s === '-0' ? '0' : s;
  };
  const FM = (m) => m.map(F).join(' ');
  const boxT = (M, b) => { const c = [ap(M, b[0], b[1]), ap(M, b[2], b[1]), ap(M, b[2], b[3]), ap(M, b[0], b[3])]; return [Math.min(...c.map((p) => p[0])), Math.min(...c.map((p) => p[1])), Math.max(...c.map((p) => p[0])), Math.max(...c.map((p) => p[1]))]; };
  /** 移動・拡大縮小で、元のクリップ領域からはみ出すか（はみ出すなら、クリップの外へ出して描き直す） */
  const leavesClip = (ob, clip, T, bb) => ob.ctx === 'p' && clip && !isId(T) && (() => { const b = boxT(T, bb); return b[0] < clip[0] - 0.5 || b[1] < clip[1] - 0.5 || b[2] > clip[2] + 0.5 || b[3] > clip[3] + 0.5; })();

  /* ---------------------------------------------------------------- バイト列 <-> latin1 文字列（1バイト=1文字） */
  function b2s(b) { let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return s; }
  function s2b(s) { const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff; return b; }
  function streamBytes(st) {
    if (!st) return null;
    if (typeof st.getUnencodedContents === 'function') return st.getUnencodedContents();
    try { return decodePDFRawStream(st).decode(); }
    catch (e) {
      const f = st.dict && st.dict.get(N('Filter'));
      if (!f) return st.getContents();
      throw new Error('このページの内容は、対応していない圧縮形式のため編集できません。');
    }
  }

  /* ---------------------------------------------------------------- 字句解析（コンテンツストリーム / CMap 共用） */
  const WS = new Uint8Array(256); [0, 9, 10, 12, 13, 32].forEach((c) => { WS[c] = 1; });
  const DL = new Uint8Array(256); [40, 41, 60, 62, 91, 93, 123, 125, 47, 37].forEach((c) => { DL[c] = 1; });
  const hexv = (c) => (c >= 48 && c <= 57 ? c - 48 : c >= 65 && c <= 70 ? c - 55 : c >= 97 && c <= 102 ? c - 87 : -1);
  function lex(b) {
    const n = b.length, ops = [];
    let i = 0;
    const skip = () => {
      for (;;) {
        while (i < n && WS[b[i]]) i++;
        if (i < n && b[i] === 37) { while (i < n && b[i] !== 10 && b[i] !== 13) i++; continue; }
        return;
      }
    };
    const word = () => { const s = i; while (i < n && !WS[b[i]] && !DL[b[i]]) i++; return b2s(b.subarray(s, i)); };
    function value() {                // i は値の先頭。読み終えた位置に i を進める
      const c = b[i];
      if (c === 40) {                   // (literal)
        i++; let depth = 1; const out = [];
        while (i < n) {
          const ch = b[i++];
          if (ch === 92) {
            const e = b[i++];
            if (e === 110) out.push(10); else if (e === 114) out.push(13); else if (e === 116) out.push(9);
            else if (e === 98) out.push(8); else if (e === 102) out.push(12);
            else if (e === 13) { if (b[i] === 10) i++; }
            else if (e === 10) { /* 行の継続 */ }
            else if (e >= 48 && e <= 55) {
              let v = e - 48;
              for (let k = 0; k < 2 && b[i] >= 48 && b[i] <= 55; k++) v = v * 8 + (b[i++] - 48);
              out.push(v & 0xff);
            } else if (e !== undefined) out.push(e);
          } else if (ch === 40) { depth++; out.push(ch); }
          else if (ch === 41) { if (--depth === 0) break; out.push(ch); }
          else out.push(ch);
        }
        return { t: 's', b: Uint8Array.from(out) };
      }
      if (c === 60) {
        if (b[i + 1] === 60) {          // << dict >>
          i += 2; const m = {};
          for (;;) {
            skip();
            if (i >= n) break;
            if (b[i] === 62 && b[i + 1] === 62) { i += 2; break; }
            if (b[i] !== 47) { value(); continue; }
            const k = value(); skip();
            if (b[i] === 62 && b[i + 1] === 62) { m[k.n] = null; continue; }
            m[k.n] = value();
          }
          return { t: 'd', m };
        }
        i++; const out = []; let hi = -1;   // <hex>
        while (i < n && b[i] !== 62) {
          const v = hexv(b[i++]);
          if (v < 0) continue;
          if (hi < 0) hi = v; else { out.push(hi * 16 + v); hi = -1; }
        }
        if (hi >= 0) out.push(hi * 16);
        i++;
        return { t: 's', b: Uint8Array.from(out), hex: true };
      }
      if (c === 91) {                    // [ array ]
        i++; const a = [];
        for (;;) { skip(); if (i >= n) break; if (b[i] === 93) { i++; break; } a.push(value()); }
        return a;
      }
      if (c === 47) {                    // /Name
        const s = i; i++;
        while (i < n && !WS[b[i]] && !DL[b[i]]) i++;
        const raw = b2s(b.subarray(s, i));
        return { t: 'n', n: raw.slice(1).replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))), raw };
      }
      if (c === 123 || c === 125 || c === 41 || c === 62 || c === 93) { i++; return { t: 'k', k: String.fromCharCode(c) }; }
      const w = word();
      if (w === '') { i++; return { t: 'k', k: '' }; }
      const num = +w;
      if (!isNaN(num) && /^[+\-.\d]/.test(w)) return num;
      if (w === 'true') return true;
      if (w === 'false') return false;
      if (w === 'null') return null;
      return { t: 'k', k: w };
    }
    let args = [], ap2 = [];
    while (true) {
      skip();
      if (i >= n) break;
      const s = i, v = value();
      if (v && v.t === 'k') {
        if (v.k === '' || v.k === '{' || v.k === '}' || v.k === ')' || v.k === '>' || v.k === ']') { continue; }
        const op = { op: v.k, args, ap: ap2, s: ap2.length ? ap2[0][0] : s, ks: s, e: i };
        if (v.k === 'BI') {             // インライン画像: ID のあとのバイナリを EI まで読み飛ばす
          for (;;) { skip(); if (i >= n) break; const t0 = i, tv = value(); if (tv && tv.t === 'k' && tv.k === 'ID') { i = t0 + 2; break; } }
          i++;
          let j = i;
          while (j < n - 1) {
            if (b[j] === 69 && b[j + 1] === 73 && (j === 0 || WS[b[j - 1]]) && (j + 2 >= n || WS[b[j + 2]] || DL[b[j + 2]])) break;
            j++;
          }
          i = Math.min(n, j + 2); op.e = i;
        }
        ops.push(op); args = []; ap2 = [];
      } else { args.push(v); ap2.push([s, i]); }
    }
    return ops;
  }

  /* ---------------------------------------------------------------- 文字コード表 */
  const HELV = StandardFontEmbedder.for(StandardFonts.Helvetica);
  const WINANSI = new Array(256).fill('');
  const NAME2UNI = new Map();
  for (const [cp, v] of Object.entries(HELV.encoding.unicodeMappings)) { if (!WINANSI[v[0]]) WINANSI[v[0]] = v[1]; if (!NAME2UNI.has(v[1])) NAME2UNI.set(v[1], String.fromCodePoint(+cp)); }
  for (let c = 32; c < 127; c++) if (!WINANSI[c]) WINANSI[c] = '';
  const EXTRA_NAMES = { fi: 'ﬁ', fl: 'ﬂ', ff: 'ﬀ', ffi: 'ﬃ', ffl: 'ﬄ', dotlessi: 'ı', Lslash: 'Ł', lslash: 'ł', fraction: '⁄', hungarumlaut: '˝', ogonek: '˛', caron: 'ˇ',
    breve: '˘', dotaccent: '˙', ring: '˚', quotesingle: "'", notequal: '≠', infinity: '∞', lessequal: '≤', greaterequal: '≥', partialdiff: '∂', summation: '∑',
    product: '∏', pi: 'π', integral: '∫', Omega: 'Ω', radical: '√', approxequal: '≈', Delta: '∆', lozenge: '◊', apple: '', mu: 'µ', minus: '−', nbspace: ' ',
    sfthyphen: '­', periodcentered: '·', middot: '·', Euro: '€', overscore: '¯', ellipsis: '…', endash: '–', emdash: '—', bullet: '•', dagger: '†', daggerdbl: '‡',
    trademark: '™', perthousand: '‰', florin: 'ƒ', circumflex: 'ˆ', tilde: '˜', quotesinglbase: '‚', quotedblbase: '„', quotedblleft: '“', quotedblright: '”',
    quoteleft: '‘', quoteright: '’', guilsinglleft: '‹', guilsinglright: '›', space: ' ' };
  for (const [k, v] of Object.entries(EXTRA_NAMES)) if (!NAME2UNI.has(k)) NAME2UNI.set(k, v);
  const UC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''), LC = 'abcdefghijklmnopqrstuvwxyz'.split('');
  const ASCII_NAMES = ['space', 'exclam', 'quotedbl', 'numbersign', 'dollar', 'percent', 'ampersand', 'quoteright', 'parenleft', 'parenright', 'asterisk', 'plus', 'comma',
    'hyphen', 'period', 'slash', 'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'colon', 'semicolon', 'less', 'equal', 'greater', 'question',
    'at', ...UC, 'bracketleft', 'backslash', 'bracketright', 'asciicircum', 'underscore', 'quoteleft', ...LC, 'braceleft', 'bar', 'braceright', 'asciitilde'];
  const STD_ENC = new Array(256).fill('');
  ASCII_NAMES.forEach((nm, k) => { STD_ENC[32 + k] = nm; });
  const putAt = (arr, start, names) => names.split(' ').forEach((nm, k) => { if (nm !== '_') arr[start + k] = nm; });
  putAt(STD_ENC, 161, 'exclamdown cent sterling fraction yen florin section currency quotesingle quotedblleft guillemotleft guilsinglleft guilsinglright fi fl _ endash dagger daggerdbl periodcentered _ paragraph bullet quotesinglbase quotedblbase quotedblright guillemotright ellipsis perthousand _ questiondown _ grave acute circumflex tilde macron breve dotaccent dieresis _ ring cedilla _ hungarumlaut ogonek caron emdash');
  putAt(STD_ENC, 225, 'AE _ ordfeminine _ _ _ _ Lslash Oslash OE ordmasculine _ _ _ _ _ ae _ _ _ dotlessi _ _ lslash oslash oe germandbls');
  const MAC_ENC = STD_ENC.slice(0, 128); MAC_ENC[39] = 'quotesingle'; MAC_ENC[96] = 'grave'; MAC_ENC.length = 256; MAC_ENC.fill('', 128);
  putAt(MAC_ENC, 128, 'Adieresis Aring Ccedilla Eacute Ntilde Odieresis Udieresis aacute agrave acircumflex adieresis atilde aring ccedilla eacute egrave ecircumflex edieresis iacute igrave icircumflex idieresis ntilde oacute ograve ocircumflex odieresis otilde uacute ugrave ucircumflex udieresis dagger degree cent sterling section bullet paragraph germandbls registered copyright trademark acute dieresis notequal AE Oslash infinity plusminus lessequal greaterequal yen mu partialdiff summation product pi integral ordfeminine ordmasculine Omega ae oslash questiondown exclamdown logicalnot radical florin approxequal Delta guillemotleft guillemotright ellipsis space Agrave Atilde Otilde OE oe endash emdash quotedblleft quotedblright quoteleft quoteright divide lozenge ydieresis Ydieresis fraction currency guilsinglleft guilsinglright fi fl daggerdbl periodcentered quotesinglbase quotedblbase perthousand Acircumflex Ecircumflex Aacute Edieresis Egrave Iacute Icircumflex Idieresis Igrave Oacute Ocircumflex apple Ograve Uacute Ucircumflex Ugrave dotlessi circumflex tilde macron breve dotaccent ring cedilla hungarumlaut ogonek caron');
  const BASE_ENC = { WinAnsiEncoding: WINANSI, MacRomanEncoding: MAC_ENC, StandardEncoding: STD_ENC };
  function glyphUni(name) {
    if (!name) return '';
    if (NAME2UNI.has(name)) return NAME2UNI.get(name);
    let m = /^uni([0-9A-Fa-f]{4,})$/.exec(name);
    if (m) { let s = ''; for (let k = 0; k + 4 <= m[1].length; k += 4) s += String.fromCharCode(parseInt(m[1].slice(k, k + 4), 16)); return s; }
    m = /^u([0-9A-Fa-f]{4,6})$/.exec(name);
    if (m) { try { return String.fromCodePoint(parseInt(m[1], 16)); } catch { return ''; } }
    const base = name.split('.')[0].split('_')[0];
    if (base !== name && base) return glyphUni(base);
    if (name.length === 1) return name;
    return '';
  }
  const STD14 = new Set(PDFLib.StandardFontValues || []);
  /** 康熙部首・CJK互換漢字（見た目は同じ別の文字）を通常の漢字にそろえる */
  const normCJK = (u) => (u && /[\u2e80-\u2fdf\uf900-\ufaff]/.test(u) ? u.normalize('NFKC') : u);
  function std14Name(base) {
    let b = String(base || '').replace(/^[A-Z]{6}\+/, '');
    if (STD14.has(b)) return b;
    const bold = /bold|black|heavy/i.test(b), it = /italic|oblique/i.test(b);
    const pick = (fam) => {
      if (fam === 'Times') return bold && it ? 'Times-BoldItalic' : bold ? 'Times-Bold' : it ? 'Times-Italic' : 'Times-Roman';
      return `${fam}${bold || it ? '-' : ''}${bold ? 'Bold' : ''}${it ? 'Oblique' : ''}`;
    };
    if (/^(Arial|Helvetica)/i.test(b)) return pick('Helvetica');
    if (/^Times/i.test(b)) return pick('Times');
    if (/^Courier/i.test(b)) return pick('Courier');
    if (/^Symbol/i.test(b)) return 'Symbol';
    if (/^ZapfDingbats/i.test(b)) return 'ZapfDingbats';
    return null;
  }
  const stdCache = new Map();
  const stdEmb = (nm) => { let e = stdCache.get(nm); if (!e) { e = StandardFontEmbedder.for(nm); stdCache.set(nm, e); } return e; };

  /* ---------------------------------------------------------------- CMap（ToUnicode / 埋め込みエンコーディング） */
  const bytesNum = (u8) => { let v = 0; for (const x of u8) v = v * 256 + x; return v; };
  const u16 = (u8) => { let s = ''; for (let k = 0; k + 1 < u8.length; k += 2) s += String.fromCharCode(u8[k] * 256 + u8[k + 1]); if (u8.length % 2) s += String.fromCharCode(u8[u8.length - 1]); return s; };
  function parseCMap(bytes) {
    const ops = lex(bytes), cs = [], uni = new Map(), cid = new Map(), cidR = [];
    let useName = null;
    for (const o of ops) {
      const a = o.args;
      if (o.op === 'endcodespacerange') {
        for (let k = 0; k + 1 < a.length; k += 2) if (a[k] && a[k].b) cs.push({ len: a[k].b.length, lo: a[k].b, hi: a[k + 1].b });
      } else if (o.op === 'endbfchar') {
        for (let k = 0; k + 1 < a.length; k += 2) if (a[k] && a[k].b && a[k + 1]) {
          const d = a[k + 1]; uni.set(a[k].b.length + ':' + bytesNum(a[k].b), d.b ? u16(d.b) : d.n ? glyphUni(d.n) : '');
        }
      } else if (o.op === 'endbfrange') {
        for (let k = 0; k + 2 < a.length; k += 3) {
          const lo = a[k] && a[k].b, hi = a[k + 1] && a[k + 1].b, d = a[k + 2]; if (!lo || !hi) continue;
          const L = lo.length, v0 = bytesNum(lo), v1 = bytesNum(hi);
          if (v1 - v0 > 70000) continue;
          if (Array.isArray(d)) { for (let v = v0; v <= v1; v++) { const x = d[v - v0]; if (x && x.b) uni.set(L + ':' + v, u16(x.b)); } }
          else if (d && d.b) {
            const base = d.b.slice();
            for (let v = v0; v <= v1; v++) {
              uni.set(L + ':' + v, u16(base));
              for (let q = base.length - 1; q >= 0; q--) { if (base[q] < 255) { base[q]++; break; } base[q] = 0; }
            }
          }
        }
      } else if (o.op === 'endcidchar') {
        for (let k = 0; k + 1 < a.length; k += 2) if (a[k] && a[k].b) cid.set(a[k].b.length + ':' + bytesNum(a[k].b), +a[k + 1] || 0);
      } else if (o.op === 'endcidrange') {
        for (let k = 0; k + 2 < a.length; k += 3) if (a[k] && a[k].b && a[k + 1] && a[k + 1].b) cidR.push({ len: a[k].b.length, lo: bytesNum(a[k].b), hi: bytesNum(a[k + 1].b), c: +a[k + 2] || 0 });
      } else if (o.op === 'usecmap' && a[0] && a[0].n) useName = a[0].n;
    }
    return { cs, uni, cid, cidR, useName };
  }
  function codeLenBy(cs) {
    if (!cs.length) return null;
    const byLen = [...cs].sort((x, y) => x.len - y.len);
    return (b, i) => {
      for (const r of byLen) {
        if (i + r.len > b.length) continue;
        let ok = true;
        for (let k = 0; k < r.len; k++) { const v = b[i + k]; if (v < r.lo[k] || v > r.hi[k]) { ok = false; break; } }
        if (ok) return r.len;
      }
      return byLen[0].len;
    };
  }

  /* ---------------------------------------------------------------- フォント */
  const fontCache = new WeakMap();
  function getFont(doc, fdictOrRef) {
    const ctx = doc.context;
    const fd = ctx.lookupMaybe(fdictOrRef, PDFDict);
    if (!fd) return null;
    let f = fontCache.get(fd); if (f) return f;
    f = buildFont(doc, fd); fontCache.set(fd, f); return f;
  }
  function buildFont(doc, fd) {
    const ctx = doc.context;
    const L = (o) => (o === undefined || o === null ? undefined : ctx.lookup(o));
    const nm = (o) => { const v = L(o); return v && v.asString ? v.asString().replace(/^\//, '') : v && v.decodeText ? v.decodeText() : ''; };
    const num = (o, d) => { const v = L(o); return v && v.asNumber ? v.asNumber() : d; };
    const arr = (o) => { const v = L(o); return v instanceof PDFArray ? v.asArray().map((x) => L(x)) : null; };
    const sub = nm(fd.get(N('Subtype')));
    const baseFont = nm(fd.get(N('BaseFont')));
    const F0 = { sub, baseFont, subset: /^[A-Z]{6}\+/.test(baseFont), vert: false, exact: true, asc: 0.8, desc: -0.2, type3: sub === 'Type3' };
    let toUni = null;
    const tu = L(fd.get(N('ToUnicode')));
    if (tu instanceof PDFStream) { try { toUni = parseCMap(streamBytes(tu)).uni; } catch { toUni = null; } }
    const desc0 = (dd) => {
      const d = L(dd && dd.get(N('FontDescriptor')));
      if (d instanceof PDFDict) {
        const a = num(d.get(N('Ascent')), 0), de = num(d.get(N('Descent')), 0);
        if (a > 0) F0.asc = Math.min(1.2, Math.max(0.5, a / 1000));
        if (de < 0) F0.desc = Math.max(-0.5, de / 1000);
        return d;
      }
      return null;
    };
    if (sub === 'Type0') {
      const dfs = arr(fd.get(N('DescendantFonts')));
      const cf = dfs && dfs[0] instanceof PDFDict ? dfs[0] : null;
      if (cf) desc0(cf);
      const enc = L(fd.get(N('Encoding')));
      let encName = enc && enc.asString ? enc.asString().slice(1) : null, cmap = null;
      if (enc instanceof PDFStream) { try { cmap = parseCMap(streamBytes(enc)); } catch { cmap = null; } const wm = num(enc.dict.get(N('WMode')), 0); if (wm === 1) F0.vert = true; if (cmap && cmap.useName) encName = cmap.useName; }
      if (encName && /-V$/.test(encName)) F0.vert = true;
      if (encName === 'Identity-V') F0.vert = true;
      const identity = !cmap && (encName === 'Identity-H' || encName === 'Identity-V');
      let codeLen;
      if (cmap && cmap.cs.length) codeLen = codeLenBy(cmap.cs);
      else if (identity || /UCS2|UTF16/.test(encName || '')) codeLen = (b, i) => (/UTF16/.test(encName || '') && b[i] >= 0xd8 && b[i] <= 0xdb ? 4 : 2);
      else if (/RKSJ/.test(encName || '')) codeLen = (b, i) => ((b[i] >= 0x81 && b[i] <= 0x9f) || (b[i] >= 0xe0 && b[i] <= 0xfc) ? 2 : 1);
      else if (/EUC/.test(encName || '')) codeLen = (b, i) => (b[i] === 0x8f ? 3 : b[i] >= 0x8e ? 2 : 1);
      else if (/UTF8/.test(encName || '')) codeLen = (b, i) => (b[i] < 0x80 ? 1 : b[i] < 0xe0 ? 2 : b[i] < 0xf0 ? 3 : 4);
      else codeLen = () => 2;
      const toCid = (code, len) => {
        if (identity) return code;
        if (cmap) {
          const c = cmap.cid.get(len + ':' + code); if (c !== undefined) return c;
          for (const r of cmap.cidR) if (r.len === len && code >= r.lo && code <= r.hi) return r.c + (code - r.lo);
          if (cmap.useName === 'Identity-H' || cmap.useName === 'Identity-V') return code;
        }
        return null;
      };
      const dw = cf ? num(cf.get(N('DW')), 1000) : 1000;
      const wmap = new Map();
      const W = cf ? arr(cf.get(N('W'))) : null;
      if (W) {
        for (let k = 0; k < W.length;) {
          const c0 = W[k] && W[k].asNumber ? W[k].asNumber() : 0, nx = W[k + 1];
          if (nx instanceof PDFArray) { nx.asArray().forEach((x, j) => wmap.set(c0 + j, L(x).asNumber())); k += 2; }
          else { const c1 = nx && nx.asNumber ? nx.asNumber() : c0, w = W[k + 2] && W[k + 2].asNumber ? W[k + 2].asNumber() : dw; if (c1 - c0 < 70000) for (let c = c0; c <= c1; c++) wmap.set(c, w); k += 3; }
        }
      }
      let dw2 = [880, -1000];
      const DW2 = cf ? arr(cf.get(N('DW2'))) : null;
      if (DW2 && DW2.length >= 2) dw2 = [DW2[0].asNumber(), DW2[1].asNumber()];
      const w2map = new Map();
      const W2 = cf ? arr(cf.get(N('W2'))) : null;
      if (W2) {
        for (let k = 0; k < W2.length;) {
          const c0 = W2[k] && W2[k].asNumber ? W2[k].asNumber() : 0, nx = W2[k + 1];
          if (nx instanceof PDFArray) { const v = nx.asArray().map((x) => L(x).asNumber()); for (let j = 0; j + 2 < v.length; j += 3) w2map.set(c0 + j / 3, v[j]); k += 2; }
          else { const c1 = nx.asNumber(), w = W2[k + 2].asNumber(); if (c1 - c0 < 70000) for (let c = c0; c <= c1; c++) w2map.set(c, w); k += 5; }
        }
      }
      if (!identity && !cmap && W && wmap.size) F0.exact = false;               // CIDが分からない（既定のCMap）ので、字幅が確定できない
      const sjis = /RKSJ/.test(encName || '') ? new TextDecoder('shift_jis') : null;
      const euc = /EUC/.test(encName || '') ? new TextDecoder('euc-jp') : null;
      const uniOf = (bytes, code, len) => {
        if (toUni) { const u = toUni.get(len + ':' + code); if (u !== undefined) return u; }
        if (/UCS2|UTF16/.test(encName || '')) return u16(bytes);
        if (sjis) { try { return sjis.decode(bytes); } catch { return ''; } }
        if (euc) { try { return euc.decode(bytes); } catch { return ''; } }
        if (/UTF8/.test(encName || '')) { try { return new TextDecoder().decode(bytes); } catch { return ''; } }
        return '';
      };
      F0.decode = (b) => {
        const out = [];
        for (let i = 0; i < b.length;) {
          let len = codeLen(b, i); if (len < 1) len = 1; if (i + len > b.length) len = b.length - i;
          const bytes = b.subarray(i, i + len), code = bytesNum(bytes), cid = toCid(code, len);
          const w0 = (cid !== null && wmap.has(cid) ? wmap.get(cid) : dw) / 1000;
          const w1 = (cid !== null && w2map.has(cid) ? w2map.get(cid) : dw2[1]) / 1000;
          out.push({ code, len, uni: normCJK(uniOf(bytes, code, len)), w0, w1, sp: len === 1 && code === 32 });
          i += len;
        }
        return out;
      };
      // 文字 → 文字コード（元のフォントで表せる文字だけ）
      const rev = new Map();
      if (toUni) for (const [k, u] of toUni) { if (!u || rev.has(u)) continue; const [len, code] = k.split(':').map(Number); const cid = toCid(code, len); if (cid === null || cid === 0) continue; rev.set(u, { len, code }); const nu = normCJK(u); if (nu !== u && !rev.has(nu)) rev.set(nu, { len, code }); }
      F0.encodeChar = (ch) => { const r = rev.get(ch); if (!r) return null; const o = []; for (let k = r.len - 1; k >= 0; k--) o.push(Math.floor(r.code / 256 ** k) % 256); return o; };
      if (!toUni && /UCS2|UTF16/.test(encName || '') && !F0.subset) F0.encodeChar = (ch) => { const c = ch.charCodeAt(0); return ch.length === 1 ? [c >> 8, c & 255] : null; };
      return F0;
    }
    // ---- 単純フォント（Type1 / TrueType / Type3）: 1バイト
    const d = desc0(fd);
    const first = num(fd.get(N('FirstChar')), 0), widths = arr(fd.get(N('Widths')));
    const missing = d ? num(d.get(N('MissingWidth')), 0) : 0;
    let fm = 0.001;
    if (F0.type3) {
      const m = arr(fd.get(N('FontMatrix'))); if (m && m.length >= 4) fm = m[0].asNumber();
      const bb = arr(fd.get(N('FontBBox')));
      if (bb && bb.length === 4) { const sy = m && m.length >= 4 ? m[3].asNumber() : 0.001; F0.asc = Math.min(1.2, Math.max(0.5, bb[3].asNumber() * sy)); F0.desc = Math.max(-0.5, Math.min(0, bb[1].asNumber() * sy)); }
    }
    // エンコーディング（文字コード → グリフ名）
    const std = std14Name(baseFont);
    const symbolic = d ? (num(d.get(N('Flags')), 0) & 4) !== 0 : false;
    let names = (std === 'Symbol' || std === 'ZapfDingbats') ? (() => { const e = stdEmb(std), a = new Array(256).fill(''); for (const v of Object.values(e.encoding.unicodeMappings)) a[v[0]] = v[1]; return a; })()
      : (sub === 'TrueType' || !symbolic) ? (sub === 'TrueType' ? WINANSI : STD_ENC) : STD_ENC;
    names = names.slice();
    const enc = L(fd.get(N('Encoding')));
    const diffs = new Set();
    if (enc && enc.asString) { const e = BASE_ENC[enc.asString().slice(1)]; if (e) names = e.slice(); }
    else if (enc instanceof PDFDict) {
      const be = L(enc.get(N('BaseEncoding'))); if (be && be.asString && BASE_ENC[be.asString().slice(1)]) names = BASE_ENC[be.asString().slice(1)].slice();
      const df = arr(enc.get(N('Differences')));
      if (df) { let c = 0; for (const x of df) { if (x && x.asNumber) c = x.asNumber(); else if (x && x.asString) { if (c >= 0 && c < 256) { names[c] = x.asString().slice(1); diffs.add(c); } c++; } } }
    }
    let wOf;
    if (widths) wOf = (c) => { const k = c - first; const v = k >= 0 && k < widths.length && widths[k] && widths[k].asNumber ? widths[k].asNumber() : missing; return v * fm; };
    else if (std) {
      const e = stdEmb(std); const fn = e.font;
      if (fn.Ascender) F0.asc = fn.Ascender / 1000; if (fn.Descender) F0.desc = fn.Descender / 1000;
      wOf = (c) => { const g = names[c]; const w = g ? fn.getWidthOfGlyph(g) : undefined; return (w === undefined ? 0 : w) / 1000; };
    } else { F0.exact = false; wOf = () => 0.5; }
    F0.decode = (b) => {
      const out = [];
      for (let i = 0; i < b.length; i++) {
        const c = b[i];
        let u = toUni ? toUni.get('1:' + c) : undefined;
        if (u === undefined) u = glyphUni(names[c]) || (sub === 'TrueType' && symbolic && c >= 32 && c < 127 ? String.fromCharCode(c) : '');
        out.push({ code: c, len: 1, uni: normCJK(u), w0: wOf(c), w1: -1, sp: c === 32 });
      }
      return out;
    };
    const rev = new Map();
    if (toUni) for (const [k, u] of toUni) {
      const [len, code] = k.split(':').map(Number);
      if (len === 1 && u && !rev.has(u) && (!widths || wOf(code) > 0)) { rev.set(u, code); const nu = normCJK(u); if (nu !== u && !rev.has(nu)) rev.set(nu, code); }
    }
    if (!F0.type3) {
      for (let c = 0; c < 256; c++) {
        if (F0.subset && !(diffs.has(c) || (toUni && toUni.has('1:' + c)))) continue;
        const u = glyphUni(names[c]); if (!u || rev.has(u)) continue;
        if (widths && !(wOf(c) > 0) && u !== ' ') continue;
        if (!widths && !std) continue;
        rev.set(u, c);
      }
    }
    F0.encodeChar = (ch) => { const c = rev.get(ch); return c === undefined ? null : [c]; };
    return F0;
  }

  /* ---------------------------------------------------------------- 色 */
  const DEV = { DeviceGray: 'g', G: 'g', DeviceRGB: 'rgb', RGB: 'rgb', DeviceCMYK: 'cmyk', CMYK: 'cmyk', CalGray: 'g', CalRGB: 'rgb' };
  const defColor = () => ({ k: 'g', comps: [0], cs: null, pat: null });
  function csKind(res, ctx, name) {
    if (DEV[name]) return DEV[name];
    if (name === 'Pattern') return 'pattern';
    const csd = res ? ctx.lookupMaybe(res.get(N('ColorSpace')), PDFDict) : null;
    let v = csd ? ctx.lookup(csd.get(N(name))) : null;
    if (v && v.asString) { const k = DEV[v.asString().slice(1)]; return k || 'other'; }
    if (v instanceof PDFArray) {
      const fam = ctx.lookup(v.get(0)); const f = fam && fam.asString ? fam.asString().slice(1) : '';
      if (f === 'ICCBased') { const st = ctx.lookup(v.get(1)); const nn = st && st.dict ? ctx.lookup(st.dict.get(N('N'))) : null; const n = nn && nn.asNumber ? nn.asNumber() : 3; return n === 1 ? 'g' : n === 4 ? 'cmyk' : 'rgb'; }
      if (f === 'CalRGB') return 'rgb';
      if (f === 'CalGray') return 'g';
      if (f === 'Pattern') return 'pattern';
      return 'other';
    }
    return 'other';
  }
  function colorRGB(c) {
    const v = c.comps;
    if (c.k === 'g') return [v[0], v[0], v[0]];
    if (c.k === 'rgb') return [v[0], v[1], v[2]];
    if (c.k === 'cmyk') { const k = 1 - (v[3] ?? 0); return [(1 - v[0]) * k, (1 - v[1]) * k, (1 - v[2]) * k]; }
    if (c.k === 'csg') return [v[0], v[0], v[0]];
    if (c.k === 'csrgb') return [v[0], v[1], v[2]];
    if (c.k === 'cscmyk') { const k = 1 - (v[3] ?? 0); return [(1 - v[0]) * k, (1 - v[1]) * k, (1 - v[2]) * k]; }
    return null;
  }
  const clamp01 = (x) => Math.min(1, Math.max(0, Number(x) || 0));
  function colorOps(c, stroke) {
    const v = c.comps.map(F).join(' ');
    if (c.k === 'g') return `${v} ${stroke ? 'G' : 'g'}`;
    if (c.k === 'rgb') return `${v} ${stroke ? 'RG' : 'rg'}`;
    if (c.k === 'cmyk') return `${v} ${stroke ? 'K' : 'k'}`;
    return `${c.cs} ${stroke ? 'CS' : 'cs'}${v ? ' ' + v : ''}${c.pat ? ' ' + c.pat : ''} ${stroke ? 'SCN' : 'scn'}`;
  }
  const rgbColor = (rgb) => ({ k: 'rgb', comps: rgb.map(clamp01), cs: null, pat: null });

  /* ---------------------------------------------------------------- ページの解析 */
  const PRE_OPS = new Set(['cm', 'w', 'J', 'j', 'M', 'd', 'ri', 'i', 'gs', 'g', 'G', 'rg', 'RG', 'k', 'K', 'cs', 'CS', 'sc', 'SC', 'scn', 'SCN']);
  const PRE_TEXT = new Set([...PRE_OPS, 'Tf', 'Tc', 'Tw', 'Tz', 'TL', 'Ts', 'Tr']);
  const PATH_OPS = new Set(['m', 'l', 'c', 'v', 'y', 're', 'h']);
  const PAINT = new Set(['S', 's', 'f', 'F', 'f*', 'B', 'B*', 'b', 'b*', 'n']);
  const SHOW = new Set(['Tj', 'TJ', "'", '"']);

  function pageContentBytes(page) {
    const ctx = page.doc.context;
    const c = page.node.get(N('Contents'));
    const v = c === undefined ? undefined : ctx.lookup(c);
    if (!v) return new Uint8Array(0);
    const parts = v instanceof PDFArray ? v.asArray().map((x) => ctx.lookup(x)) : [v];
    const bufs = parts.filter((x) => x instanceof PDFStream).map(streamBytes);
    let len = 0; bufs.forEach((x) => { len += x.length + 1; });
    const out = new Uint8Array(len); let o = 0;
    for (const x of bufs) { out.set(x, o); o += x.length; out[o++] = 10; }
    return out;
  }

  /**
   * ページを解析し、編集できるオブジェクト（パス・テキスト行）の一覧を返す。
   * 戻り値の objs[i].id は i。applyEdits には、同じ doc と同じ解析結果を渡す。
   */
  function parsePage(doc, pageIndex, { maxOps = 400000 } = {}) {
    const page = doc.getPages()[pageIndex];
    if (!page) throw new Error('ページがありません');
    const ctx = doc.context;
    const objs = [], ctxs = new Map(), shows = [];
    let z = 0, paintSeq = 0, totalOps = 0, formCount = 0;
    const root = { key: 'p', depth: 0, parent: null, name: null, ref: null, stream: null, resources: page.node.Resources() || null };
    const isect = (a, b) => (!a ? b.slice() : !b ? a.slice() : [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])]);
    const boxOf = (M, b) => { const c = [ap(M, b[0], b[1]), ap(M, b[2], b[1]), ap(M, b[2], b[3]), ap(M, b[0], b[3])]; return [Math.min(...c.map((p) => p[0])), Math.min(...c.map((p) => p[1])), Math.max(...c.map((p) => p[0])), Math.max(...c.map((p) => p[1]))]; };
    function run(cx, bytes, ctm0, depth, g0 = null) {
      cx.bytes = bytes; cx.src = b2s(bytes); ctxs.set(cx.key, cx);
      const ops = lex(bytes); cx.ops = ops;
      totalOps += ops.length;
      if (totalOps > maxOps) throw new Error('このページは内容が多すぎるため、編集できません。');
      const res = cx.resources;
      const fontsDict = res ? ctx.lookupMaybe(res.get(N('Font')), PDFDict) : null;
      const xobjDict = res ? ctx.lookupMaybe(res.get(N('XObject')), PDFDict) : null;
      const gsDict = res ? ctx.lookupMaybe(res.get(N('ExtGState')), PDFDict) : null;
      // フォームXObjectは、呼び出した時点のグラフィックス状態を引き継ぐ（gsAll / st は、そのストリーム内で書き直せるものだけ）
      let g = g0 ? { ...g0, ctm: ctm0.slice(), gsAll: [], st: {} }
        : { ctm: ctm0.slice(), fill: defColor(), stroke: defColor(), lw: 1, font: null, fontRaw: null, fs: 0, Tc: 0, Tw: 0, Tz: 100, TL: 0, Ts: 0, Tr: 0, clip: null, gsAll: [], st: {} };
      const stack = [], qAt = new Map();
      let path = null, clip = false, bt = null, Tm = I, Tlm = I, lastPath = null;
      const cloneG = () => ({ ...g, ctm: g.ctm.slice(), fill: { ...g.fill, comps: g.fill.comps.slice() }, stroke: { ...g.stroke, comps: g.stroke.comps.slice() }, clip: g.clip ? g.clip.slice() : null, gsAll: g.gsAll.slice(), st: { ...g.st } });
      const setColor = (stroke, o) => {
        const a = o.args.filter((x) => typeof x === 'number'), key = stroke ? 'stroke' : 'fill';
        switch (o.op.toLowerCase()) {
          case 'g': g[key] = { k: 'g', comps: a.slice(0, 1), cs: null, pat: null }; break;
          case 'rg': g[key] = { k: 'rgb', comps: a.slice(0, 3), cs: null, pat: null }; break;
          case 'k': g[key] = { k: 'cmyk', comps: a.slice(0, 4), cs: null, pat: null }; break;
          case 'cs': {
            const nmv = o.args[0]; if (!nmv || nmv.t !== 'n') break;
            const kind = csKind(res, ctx, nmv.n);
            const comps = kind === 'g' ? [0] : kind === 'rgb' ? [0, 0, 0] : kind === 'cmyk' ? [0, 0, 0, 1] : [];
            g[key] = { k: kind === 'g' ? 'csg' : kind === 'rgb' ? 'csrgb' : kind === 'cmyk' ? 'cscmyk' : 'cs', comps, cs: nmv.raw, pat: null, kind };
            break;
          }
          case 'sc': case 'scn': {
            const cur = g[key];
            const pat = o.args.find((x) => x && x.t === 'n');
            if (!cur.cs) { // cs を指定せずに sc（既定の DeviceGray など）
              g[key] = { ...cur, comps: a.slice(), k: a.length === 1 ? 'g' : a.length === 4 ? 'cmyk' : 'rgb' }; break;
            }
            g[key] = { ...cur, comps: a.slice(), pat: pat ? pat.raw : null };
            break;
          }
          default: break;
        }
      };
      const bboxOf = (segs, pad) => {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const s of segs) for (let k = 1; k < s.length; k += 2) { const x = s[k], y = s[k + 1]; if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
        if (x0 === Infinity) return null;
        return [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
      };
      const wrapOf = (i0, i1, pre) => {     // ops[i0..i1] が q（＋前置き）… Q で囲まれているか
        let k = i0 - 1;
        while (k >= 0 && pre.has(ops[k].op)) k--;
        if (k < 0 || ops[k].op !== 'q' || !ops[i1 + 1] || ops[i1 + 1].op !== 'Q') return null;
        const preOps = []; for (let j = k + 1; j < i0; j++) preOps.push(j);
        return { s: ops[k].s, e: ops[i1 + 1].e, qi: k, Qi: i1 + 1, pre: preOps, ctmOuter: qAt.get(k) || g.ctm };
      };
      for (let i = 0; i < ops.length; i++) {
        const o = ops[i], op = o.op, a = o.args;
        if (PATH_OPS.has(op)) {
          if (!path) path = { i0: i, segs: [], cur: [0, 0], start: [0, 0] };
          const P = (x, y) => ap(g.ctm, x, y);
          if (op === 'm') { const p = P(a[0], a[1]); path.segs.push(['m', ...p]); path.cur = [a[0], a[1]]; path.start = [a[0], a[1]]; }
          else if (op === 'l') { path.segs.push(['l', ...P(a[0], a[1])]); path.cur = [a[0], a[1]]; }
          else if (op === 'c') { path.segs.push(['c', ...P(a[0], a[1]), ...P(a[2], a[3]), ...P(a[4], a[5])]); path.cur = [a[4], a[5]]; }
          else if (op === 'v') { path.segs.push(['c', ...P(path.cur[0], path.cur[1]), ...P(a[0], a[1]), ...P(a[2], a[3])]); path.cur = [a[2], a[3]]; }
          else if (op === 'y') { path.segs.push(['c', ...P(a[0], a[1]), ...P(a[2], a[3]), ...P(a[2], a[3])]); path.cur = [a[2], a[3]]; }
          else if (op === 're') {
            const [x, y, w, h] = a;
            path.segs.push(['m', ...P(x, y)], ['l', ...P(x + w, y)], ['l', ...P(x + w, y + h)], ['l', ...P(x, y + h)], ['h']);
            path.cur = [x, y]; path.start = [x, y];
          } else if (op === 'h') { path.segs.push(['h']); path.cur = path.start.slice(); }
          continue;
        }
        if (op === 'W' || op === 'W*') { clip = true; continue; }
        if (PAINT.has(op)) {
          if (path && !clip && op !== 'n' && path.segs.length) {
            const hasFill = /^[fFBb]/.test(op), hasStroke = /^[SsBb]/.test(op);
            const lwPage = g.lw * mscale(g.ctm) || 0;
            const bb = bboxOf(path.segs, hasStroke ? Math.max(lwPage, 0.5) / 2 : 0), raw = bboxOf(path.segs, 0);
            if (bb) {
              const wr = wrapOf(path.i0, i, PRE_OPS);
              const po = { kind: 'path', ctx: cx.key, z: z++, ps: ops[path.i0].s, paintKs: o.ks, pe: o.e, paint: op, segs: path.segs, ctm: g.ctm.slice(),
                fill: hasFill ? { ...g.fill } : null, stroke: hasStroke ? { ...g.stroke } : null, fillState: { ...g.fill }, strokeState: { ...g.stroke },
                lw: g.lw, lwPage, evenOdd: op.includes('*'), bbox: bb, raw, wrap: wr, editable: true, depth, clip: g.clip ? g.clip.slice() : null, gsAll: g.gsAll.slice(), st: { ...g.st } };
              // 塗りだけのパスと線だけのパスが同じ形で続く場合（Office系の図形など）は、1つの図形として扱う
              const prev = lastPath && lastPath.ctx === cx.key && !lastPath.parts ? lastPath : null;
              const fo = (x) => /^[fF]/.test(x.paint), so = (x) => /^[Ss]$/.test(x.paint);
              const tolB = 0.05 + 0.01 * Math.max(raw[2] - raw[0], raw[3] - raw[1]);
              if (prev && prev.segs.length === po.segs.length && ((fo(prev) && so(po)) || (so(prev) && fo(po))) && prev.raw.every((v, k) => Math.abs(v - raw[k]) < tolB)) {
                const fp = fo(prev) ? prev : po, sp = fo(prev) ? po : prev;
                const comp = { ...sp, parts: [prev, po], z: prev.z, fill: fp.fill, fillState: fp.fillState, evenOdd: fp.evenOdd, paint: fp.evenOdd ? 'B*' : 'B',
                  bbox: [Math.min(prev.bbox[0], bb[0]), Math.min(prev.bbox[1], bb[1]), Math.max(prev.bbox[2], bb[2]), Math.max(prev.bbox[3], bb[3])], raw: prev.raw };
                objs[objs.length - 1] = comp; lastPath = null;
              } else { objs.push(po); lastPath = po; }
            }
          }
          if (path || clip) paintSeq++;
          if (clip) { lastPath = null; const cb = path && bboxOf(path.segs, 0); if (cb) g.clip = isect(g.clip, cb); }
          path = null; clip = false; continue;
        }
        if (path && op !== 'BI') { /* パスの途中に他の命令（不正だが許容） */ }
        switch (op) {
          case 'q': qAt.set(i, g.ctm.slice()); stack.push(cloneG()); break;
          case 'Q': if (stack.length) g = stack.pop(); break;
          case 'cm': if (a.length >= 6) g.ctm = mul(a.slice(0, 6), g.ctm); break;
          case 'w': if (typeof a[0] === 'number') g.lw = a[0]; break;
          case 'J': case 'j': case 'M': case 'd': g.st = { ...g.st, [op]: cx.src.slice(o.s, o.e) }; break;
          case 'gs': {
            if (!bt) g.gsAll = [...g.gsAll, cx.src.slice(o.s, o.e)];
            const nmv = a[0]; if (!nmv || nmv.t !== 'n' || !gsDict) break;
            const gd = ctx.lookupMaybe(gsDict.get(N(nmv.n)), PDFDict);
            if (gd) { const lw = ctx.lookup(gd.get(N('LW'))); if (lw && lw.asNumber) g.lw = lw.asNumber(); }
            if (bt) bt.gsList.push(o.s);
            break;
          }
          case 'g': case 'rg': case 'k': case 'cs': case 'sc': case 'scn': setColor(false, o); break;
          case 'G': case 'RG': case 'K': case 'CS': case 'SC': case 'SCN': setColor(true, o); break;
          case 'BT': {
            Tm = I; Tlm = I;
            bt = { cx: cx.key, bi: i, s: o.s, etEnd: -1, shows: [], gsList: [], ctm: g.ctm.slice(), wrap: null };
            break;
          }
          case 'ET': {
            if (bt) {
              bt.etEnd = o.e; bt.ei = i;
              bt.wrap = wrapOf(bt.bi, i, PRE_TEXT);
              if (bt.wrap) {   // BT の中身は、文字関連の命令だけか
                const okIn = new Set([...PRE_TEXT, 'BT', 'ET', 'Td', 'TD', 'Tm', 'T*', ...SHOW, 'BDC', 'BMC', 'EMC', 'MP', 'DP']);
                for (let j = bt.bi; j <= i; j++) if (!okIn.has(ops[j].op)) { bt.wrap = null; break; }
              }
            }
            bt = null; break;
          }
          case 'Tf': if (a[0] && a[0].t === 'n') { g.font = a[0].n; g.fontRaw = a[0].raw; g.fs = typeof a[1] === 'number' ? a[1] : g.fs; } break;
          case 'Tc': g.Tc = +a[0] || 0; break;
          case 'Tw': g.Tw = +a[0] || 0; break;
          case 'Tz': g.Tz = typeof a[0] === 'number' ? a[0] : 100; break;
          case 'TL': g.TL = +a[0] || 0; break;
          case 'Ts': g.Ts = +a[0] || 0; break;
          case 'Tr': g.Tr = +a[0] || 0; break;
          case 'Td': Tlm = mul([1, 0, 0, 1, +a[0] || 0, +a[1] || 0], Tlm); Tm = Tlm; break;
          case 'TD': g.TL = -(+a[1] || 0); Tlm = mul([1, 0, 0, 1, +a[0] || 0, +a[1] || 0], Tlm); Tm = Tlm; break;
          case 'Tm': if (a.length >= 6) { Tlm = a.slice(0, 6).map(Number); Tm = Tlm; } break;
          case 'T*': Tlm = mul([1, 0, 0, 1, 0, -g.TL], Tlm); Tm = Tlm; break;
          case 'Tj': case 'TJ': case "'": case '"': {
            lastPath = null;
            if (!bt) break;
            let strArgIdx = 0;
            if (op === '"') { g.Tw = +a[0] || 0; g.Tc = +a[1] || 0; strArgIdx = 2; }
            if (op === "'" || op === '"') { Tlm = mul([1, 0, 0, 1, 0, -g.TL], Tlm); Tm = Tlm; }
            const arg = a[strArgIdx];
            const fdRef = fontsDict && g.font ? fontsDict.get(N(g.font)) : undefined;
            const font = fdRef ? getFont(doc, fdRef) : null;
            const items = Array.isArray(arg) ? arg : [arg];
            const Th = g.Tz / 100, fs = g.fs;
            const glyphs = []; let x = 0;
            const vert = !!(font && font.vert);
            for (const it of items) {
              if (typeof it === 'number') { x += vert ? -it / 1000 * fs : -it / 1000 * fs * Th; continue; }
              if (!it || !it.b) continue;
              const gl = font ? font.decode(it.b) : [...it.b].map((c) => ({ code: c, len: 1, uni: String.fromCharCode(c), w0: 0.5, w1: -1, sp: c === 32 }));
              for (const q of gl) {
                if (vert) { const adv = q.w1 * fs + g.Tc + (q.sp ? g.Tw : 0); glyphs.push({ uni: q.uni, x, w: q.w1 * fs, adv }); x += adv; }
                else { const w = q.w0 * fs * Th, adv = (q.w0 * fs + g.Tc + (q.sp ? g.Tw : 0)) * Th; glyphs.push({ uni: q.uni, x, w, adv }); x += adv; }
              }
            }
            const ap0 = o.ap[strArgIdx];
            const sh = { cx: cx.key, bt, oi: i, s: o.s, e: o.e, op, raw: ap0 ? cx.src.slice(ap0[0], ap0[1]) : '()', Tm0: Tm.slice(), Tlm0: Tlm.slice(),
              fontName: g.font, fontRaw: g.fontRaw, font, fs, Tc: g.Tc, Tw: g.Tw, Tz: g.Tz, TL: g.TL, Ts: g.Ts, Tr: g.Tr, fill: { ...g.fill }, stroke: { ...g.stroke }, lw: g.lw,
              ctm: g.ctm.slice(), glyphs, adv: x, vert, exact: !!(font && font.exact), gsList: bt.gsList.slice(), paintSeq, z: z++, args: a, ap: o.ap,
              clip: g.clip ? g.clip.slice() : null, gsAll: [...g.gsAll, ...bt.gsList.map((q) => cx.src.slice(q, cx.ops.find((x) => x.s === q).e))] };
            sh.visible = g.Tr !== 3 && g.Tr !== 7 && glyphs.some((q) => q.uni.trim() !== '' || q.w !== 0);
            sh.clip = g.Tr >= 4;
            bt.shows.push(sh); shows.push(sh);
            Tm = vert ? mul([1, 0, 0, 1, 0, x], Tm) : mul([1, 0, 0, 1, x, 0], Tm);
            break;
          }
          case 'Do': {
            paintSeq++; lastPath = null;
            const nmv = a[0]; if (!nmv || nmv.t !== 'n' || !xobjDict) break;
            const ref = xobjDict.get(N(nmv.n));
            const xs = ctx.lookupMaybe(ref, PDFStream);
            if (!xs) break;
            const st = ctx.lookup(xs.dict.get(N('Subtype')));
            if (!st || st.asString() !== '/Form' || depth >= 6) break;
            let bytes; try { bytes = streamBytes(xs); } catch { break; }
            const mt = ctx.lookup(xs.dict.get(N('Matrix')));
            const M = mt instanceof PDFArray && mt.size() >= 6 ? mt.asArray().map((v) => ctx.lookup(v).asNumber()) : I;
            const fres = ctx.lookupMaybe(xs.dict.get(N('Resources')), PDFDict) || res;
            const sub = { key: `${cx.key}/${nmv.n}#${formCount++}`, depth: depth + 1, parent: cx, name: nmv.n, ref: ref instanceof PDFRef ? ref : null, stream: xs, resources: fres,
              ownRes: !!ctx.lookupMaybe(xs.dict.get(N('Resources')), PDFDict) };
            const save = { g, Tm, Tlm };
            const fm = mul(M, g.ctm), bbx = ctx.lookup(xs.dict.get(N('BBox')));
            const fb = bbx instanceof PDFArray && bbx.size() >= 4 ? boxOf(fm, bbx.asArray().map((v) => ctx.lookup(v).asNumber())) : null;
            run(sub, bytes, fm, depth + 1, { ...cloneG(), clip: fb ? isect(g.clip, fb) : g.clip });
            g = save.g; Tm = save.Tm; Tlm = save.Tlm;
            break;
          }
          case 'BI': case 'sh': paintSeq++; lastPath = null; break;
          default: break;
        }
      }
      cx.depthEnd = stack.length;
    }
    run(root, pageContentBytes(page), I, 0);
    // ---- テキストを行にまとめる
    const tq = (sh) => {
      const M = mul(sh.Tm0, sh.ctm), f = sh.font;
      const asc = (f ? f.asc : 0.8) * sh.fs, desc = (f ? f.desc : -0.2) * sh.fs;
      let pts;
      if (sh.vert) pts = [[-sh.fs / 2, sh.adv], [sh.fs / 2, sh.adv], [sh.fs / 2, 0], [-sh.fs / 2, 0]];
      else { const x0 = Math.min(0, sh.adv), x1 = Math.max(0, sh.adv, ...sh.glyphs.map((q) => q.x + q.w)); pts = [[x0, sh.Ts + desc], [x1, sh.Ts + desc], [x1, sh.Ts + asc], [x0, sh.Ts + asc]]; }
      return pts.map((p) => ap(M, p[0], p[1]));
    };
    let cur = null;
    const flush = () => { if (cur) objs.push(cur); cur = null; };
    for (const sh of shows) {
      if (!sh.visible || sh.clip) { flush(); continue; }
      const M = mul(sh.Tm0, sh.ctm);
      const o0 = ap(M, 0, 0), o1 = sh.vert ? ap(M, 0, sh.adv) : ap(M, sh.adv, 0);
      const dirv = sh.vert ? [-(M[2]), -(M[3])] : [M[0], M[1]], dl = Math.hypot(dirv[0], dirv[1]) || 1, dir = [dirv[0] / dl, dirv[1] / dl];
      const fsPage = Math.abs(sh.fs) * (sh.vert ? Math.hypot(M[0], M[1]) : Math.hypot(M[2], M[3]));
      if (cur) {
        const f1 = cur.shows[cur.shows.length - 1].font, f2 = sh.font, bn = (f) => (f && f.baseFont ? f.baseFont.replace(/^[A-Z]{6}\+/, '') : '');
        const epa = (x) => /^EPA/.test(x.fontName || '');                 // 書き換えで使った代わりのフォントは、前後とつなげる
        const fam = f1 === f2 || (f1 && f2 && ((f1.type3 && f2.type3) || (bn(f1) && bn(f1) === bn(f2)))) || epa(sh) || epa(cur.shows[cur.shows.length - 1]);
        const sameCtx = cur.ctx === sh.cx, sameFont = fam && Math.abs(cur.fsPage - fsPage) <= fsPage * 0.02;
        const dd = dir[0] * cur.dir[0] + dir[1] * cur.dir[1];
        const v = [o0[0] - cur.end[0], o0[1] - cur.end[1]];
        const along = v[0] * cur.dir[0] + v[1] * cur.dir[1], perp = Math.abs(-v[0] * cur.dir[1] + v[1] * cur.dir[0]);
        if (!(sameCtx && sameFont && sh.paintSeq === cur.paintSeq && sh.vert === cur.vert && dd > 0.995 && perp < fsPage * 0.25 && along > -fsPage * 0.6 && along < fsPage * 1.6)) flush();
      }
      if (!cur) cur = { kind: 'text', ctx: sh.cx, z: sh.z, shows: [], dir, origin: o0, fsPage, paintSeq: sh.paintSeq, vert: sh.vert, quads: [], end: o1, depth: ctxs.get(sh.cx).depth };
      cur.shows.push(sh); cur.quads.push(tq(sh)); cur.end = o1;
    }
    flush();
    // テキストの文字列・外枠
    for (const ob of objs) {
      if (ob.kind !== 'text') continue;
      let s = '', prevEnd = null, exact = true, unknown = false;
      for (const sh of ob.shows) {
        exact = exact && sh.exact;
        const M = mul(sh.Tm0, sh.ctm);
        for (const q of sh.glyphs) {
          const p0 = sh.vert ? ap(M, 0, q.x) : ap(M, q.x, 0);
          const along = (p0[0] - ob.origin[0]) * ob.dir[0] + (p0[1] - ob.origin[1]) * ob.dir[1];
          if (prevEnd !== null && along - prevEnd > ob.fsPage * 0.28 && !/\s$/.test(s) && q.uni !== ' ') s += ' ';
          const len = Math.abs(sh.vert ? q.w : q.w) * (sh.vert ? Math.hypot(M[2], M[3]) : Math.hypot(M[0], M[1]));
          if (!q.uni) unknown = true;
          s += q.uni || '�';
          prevEnd = along + (sh.vert ? Math.abs(q.w) * Math.hypot(M[2], M[3]) : len);
        }
      }
      ob.text = s; ob.exact = exact; ob.unknown = unknown;
      const xs = ob.quads.flat().map((p) => p[0]), ys = ob.quads.flat().map((p) => p[1]);
      ob.bbox = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
      {   // 行全体を囲む、文字の向きにそろえた四角形
        const d = ob.dir, nr = [-d[1], d[0]]; let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
        for (const p of ob.quads.flat()) { const u = p[0] * d[0] + p[1] * d[1], v = p[0] * nr[0] + p[1] * nr[1]; a0 = Math.min(a0, u); a1 = Math.max(a1, u); b0 = Math.min(b0, v); b1 = Math.max(b1, v); }
        const P = (u, v) => [u * d[0] + v * nr[0], u * d[1] + v * nr[1]];
        ob.oquad = [P(a0, b0), P(a1, b0), P(a1, b1), P(a0, b1)];
      }
      const sh0 = ob.shows[0];
      ob.fill = sh0.fill; ob.stroke = sh0.stroke; ob.fontName = sh0.font ? (sh0.font.baseFont.replace(/^[A-Z]{6}\+/, '') || (sh0.font.type3 ? 'Type3フォント' : '')) : (sh0.fontName || '');
      ob.editable = !!sh0.font;
    }
    objs.sort((a, b) => a.z - b.z);
    objs.forEach((o, k) => { o.id = k; });
    for (const o of objs) {
      o.rgbFill = o.kind === 'text' ? colorRGB(o.fill) : o.fill ? colorRGB(o.fill) : null;
      o.rgbStroke = o.kind === 'text' ? colorRGB(o.stroke) : o.stroke ? colorRGB(o.stroke) : null;
    }
    return { pageIndex, objs, ctxs, page };
  }

  /* ---------------------------------------------------------------- 書き込み用フォント（置き換えた文字が元のフォントに無いとき） */
  const fbCache = new WeakMap();
  function fallbackFonts(doc) {
    let r = fbCache.get(doc); if (r) return r;
    const ctx = doc.context;
    const helv = doc.embedStandardFont(StandardFonts.Helvetica);
    const desc = ctx.register(ctx.obj({ Type: 'FontDescriptor', FontName: 'MS-Gothic', Flags: 4, FontBBox: [0, -137, 1000, 859],
      ItalicAngle: 0, Ascent: 859, Descent: -140, CapHeight: 709, StemV: 80 }));
    const cid = ctx.register(ctx.obj({ Type: 'Font', Subtype: 'CIDFontType2', BaseFont: 'MS-Gothic',
      CIDSystemInfo: { Registry: PDFString.of('Adobe'), Ordering: PDFString.of('Japan1'), Supplement: 6 }, FontDescriptor: desc, DW: 1000, W: [231, 632, 500] }));
    const jpH = ctx.register(ctx.obj({ Type: 'Font', Subtype: 'Type0', BaseFont: 'MS-Gothic-UniJIS-UTF16-H', Encoding: 'UniJIS-UTF16-H', DescendantFonts: [cid] }));
    const jpV = ctx.register(ctx.obj({ Type: 'Font', Subtype: 'Type0', BaseFont: 'MS-Gothic-UniJIS-UTF16-V', Encoding: 'UniJIS-UTF16-V', DescendantFonts: [cid] }));
    r = { EPAHelv: helv.ref, EPAJpH: jpH, EPAJpV: jpV }; fbCache.set(doc, r); return r;
  }
  const helvCode = (ch) => { const cp = ch.codePointAt(0); try { return HELV.encoding.canEncodeUnicodeCodePoint(cp) ? HELV.encoding.encodeUnicodeCodePoint(cp).code : null; } catch { return null; } };
  const hex = (arr) => '<' + arr.map((v) => v.toString(16).padStart(2, '0')).join('') + '>';
  const utf16hex = (s) => { const o = []; for (let k = 0; k < s.length; k++) { const c = s.charCodeAt(k); o.push(c >> 8, c & 255); } return hex(o); };
  const isHalfKana = (cp) => cp >= 0xff61 && cp <= 0xff9f;

  /* ---------------------------------------------------------------- 編集の適用 */
  /**
   * edits: [{ id, T?(ページ座標での変換行列), del?, dup?, fill?('#rrggbb'|null=塗りなし), stroke?('#rrggbb'), lw?(pt), text?(新しい文字列) }]
   * doc を書き換える。戻り値: 編集後に同じオブジェクトを探すための手がかり（kind / 予想される外枠・基点）
   */
  function applyEdits(doc, parsed, edits, opts = {}) {
    const ctx = doc.context, { objs, ctxs, page } = parsed;
    const splices = new Map();
    const addSp = (key, s, e, t) => { if (!splices.has(key)) splices.set(key, []); splices.get(key).push({ s, e, t }); };
    const fontNeeds = new Map();     // ctxKey -> Set(fallback font names)
    const needFont = (key, name) => { if (!fontNeeds.has(key)) fontNeeds.set(key, new Set()); fontNeeds.get(key).add(name); };
    const hints = [], tails = [];
    const hexRgb = (h) => [1, 3, 5].map((k) => parseInt(h.slice(k, k + 2), 16) / 255);
    const blocks = new Map();
    // ---- 配置順（v3.6）: ed.z = 'front' | 'back' | 'forward' | 'backward'。ページ直下のオブジェクトだけ
    const zIns = [], zSel = new Set(edits.filter((e) => e.z).map((e) => e.id));
    const pgSize = page.getSize();
    const isBg = (o) => (o.bbox[2] - o.bbox[0]) >= pgSize.width * 0.9 && (o.bbox[3] - o.bbox[1]) >= pgSize.height * 0.9;
    const overlap = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
    const posStart = (N) => {
      if (N.kind === 'path') { const P = N.parts ? N.parts[0] : N; return P.wrap ? [P.wrap.s, P.wrap.ctmOuter] : [P.ps, P.ctm]; }
      const bt = N.shows[0].bt; return bt.wrap ? [bt.wrap.s, bt.wrap.ctmOuter] : [bt.s, bt.ctm];
    };
    const posEnd = (N) => {
      if (N.kind === 'path') { const P = N.parts ? N.parts[N.parts.length - 1] : N; return P.wrap ? [P.wrap.e, P.wrap.ctmOuter] : [P.pe, P.ctm]; }
      const bt = N.shows[N.shows.length - 1].bt; return bt.wrap ? [bt.wrap.e, bt.wrap.ctmOuter] : [bt.etEnd, bt.ctm];
    };
    let zSkip = 0;
    function zEdit(ob, ed) {
      if (ob.ctx !== 'p') { zSkip++; return; }
      let place;
      if (ed.z === 'front') place = { where: 'tail' };
      else {
        const fwd = ed.z === 'forward';
        const cand = objs.filter((o) => o.ctx === 'p' && o.editable && !zSel.has(o.id) && (fwd ? o.z > ob.z : o.z < ob.z) && overlap(o.bbox, ob.bbox) && !(ed.z === 'back' && isBg(o)));
        if (!cand.length) { if (ob.kind === 'text') hints.push({ kind: 'text', origin: ob.origin.slice(), src: ed.id }); else pushHint(ob, {}); return; }   // 動かす必要がない
        const N = fwd ? cand.reduce((a, b) => (a.z < b.z ? a : b)) : cand.reduce((a, b) => (a.z < b.z ? a : b));
        const N2 = ed.z === 'backward' ? cand.reduce((a, b) => (a.z > b.z ? a : b)) : N;   // 背面へ: 1つ下 / 最背面へ: 重なっている一番下（背景は除く）
        const [pos, Cins] = fwd ? posEnd(N) : posStart(N2);
        place = { where: 'at', pos, Cins };
      }
      if (ob.kind === 'path') for (const pt of (ob.parts || [ob])) pathEdit(pt, { del: true });
      else for (const sh of ob.shows) { if (!blocks.has(sh.bt)) blocks.set(sh.bt, { kill: new Set(), emits: [] }); blocks.get(sh.bt).kill.add(sh); }
      zIns.push({ ob, place });
      if (ob.kind === 'path') pushHint(ob, {}); else hints.push({ kind: 'text', origin: ob.origin.slice(), src: ed.id });
    }
    for (const ed of edits) {
      const ob = objs[ed.id]; if (!ob || !ob.editable) continue;
      if (ed.z) { zEdit(ob, ed); continue; }
      if (ob.kind === 'path') {
        if (ob.parts) {
          for (const part of ob.parts) {
            const isF = /^[fF]/.test(part.paint);
            const sub = { T: ed.T, del: ed.del, dup: ed.dup };
            if (isF && ed.fill !== undefined && ed.fill !== null) sub.fill = ed.fill;
            if (!isF && ed.stroke !== undefined) sub.stroke = ed.stroke;
            if (!isF && ed.lw !== undefined) sub.lw = ed.lw;
            if (isF && ed.fill === null) sub.del = true;          // 塗りを「なし」に
            pathEdit(part, sub);
          }
          pushHint(ob, ed);
          continue;
        }
        pathEdit(ob, ed); pushHint(ob, ed);
        continue;
      }
      // ---- テキスト
      textEdit(ob, ed);
    }
    function pushHint(ob, ed) {
      if (ed.del) { hints.push({ kind: 'none' }); return; }
      // 変換後のパスの点から外枠を求める（回転しても、編集後の解析結果と一致する）
      const T = ed.T || I, sg = ob.parts ? ob.parts[0].segs : ob.segs, c = [];
      for (const q of sg) for (let k = 1; k + 1 < q.length; k += 2) c.push(ap(T, q[k], q[k + 1]));
      if (!c.length) { const bb = ob.raw; c.push(ap(T, bb[0], bb[1]), ap(T, bb[2], bb[3])); }
      hints.push({ kind: 'path', bbox: [Math.min(...c.map((p) => p[0])), Math.min(...c.map((p) => p[1])), Math.max(...c.map((p) => p[0])), Math.max(...c.map((p) => p[1]))], dup: !!ed.dup, src: ed.id });
    }
    function pathEdit(ob, ed) {
      const cx = ctxs.get(ob.ctx), src = cx.src;
      const T = ed.T || I;
      {
        const range = ob.wrap ? [ob.wrap.s, ob.wrap.e] : [ob.ps, ob.pe];
        const Cins = ob.wrap ? ob.wrap.ctmOuter : ob.ctm;
        if (ed.del) { addSp(ob.ctx, range[0], range[1], ''); return; }
        const Ci = inv(Cins); if (!Ci) return;
        const newCtm = mul(ob.ctm, T);
        const Y = mul(newCtm, Ci);
        let paint = ob.paint;
        const fillC = ed.fill === undefined ? null : ed.fill;
        const strokeC = ed.stroke === undefined ? null : ed.stroke;
        let addFill = null, addStroke = null, addLw = null;
        if (ed.fill !== undefined) {
          if (ed.fill === null) { if (/^[Bb]/.test(paint)) paint = paint === 'B' || paint === 'B*' ? 'S' : 's'; }
          else { addFill = colorOps(rgbColor(hexRgb(fillC)), false); if (/^[Ss]$/.test(paint)) paint = paint === 'S' ? (ob.evenOdd ? 'B*' : 'B') : 'b'; }
        }
        if (ed.stroke !== undefined && strokeC) { addStroke = colorOps(rgbColor(hexRgb(strokeC)), true); if (/^[fF]/.test(paint)) paint = ob.paint === 'f*' ? 'B*' : 'B'; }
        if (ed.lw !== undefined && ed.lw !== null) { addLw = `${F(ed.lw / mscale(newCtm))} w`; if (/^[fF]/.test(paint)) paint = ob.paint === 'f*' ? 'B*' : 'B'; }
        else if (paint !== ob.paint && /^[SsBb]/.test(paint) && !/^[SsBb]/.test(ob.paint) && ob.lw * mscale(ob.ctm) < 0.1) addLw = `${F(1 / mscale(newCtm))} w`;
        if (paint !== ob.paint && /^[SsBb]/.test(paint) && !/^[SsBb]/.test(ob.paint) && !addStroke) addStroke = colorOps(ob.strokeState, true);
        const pre = [];
        if (ob.wrap) {
          for (const j of ob.wrap.pre) {
            const po = cx.ops[j];
            if (po.op === 'cm') continue;
            if (addFill && /^(g|rg|k|cs|sc|scn)$/.test(po.op)) continue;
            if (addStroke && /^(G|RG|K|CS|SC|SCN)$/.test(po.op)) continue;
            if (addLw && po.op === 'w') continue;
            pre.push(src.slice(po.s, po.e));
          }
        }
        if (!isId(Y)) pre.push(`${FM(Y)} cm`);
        if (addFill) pre.push(addFill);
        if (addStroke) pre.push(addStroke);
        if (addLw) pre.push(addLw);
        const body = src.slice(ob.ps, ob.paintKs) + paint;
        if (leavesClip(ob, ob.clip, T, ob.raw)) {        // クリップの外へ: 元の位置から消し、ページの最後に描き直す
          if (!ed.dup) addSp(ob.ctx, range[0], range[1], '');
          const st = [...ob.gsAll, `${FM(newCtm)} cm`, addFill || colorOps(ob.fillState, false), addStroke || colorOps(ob.strokeState, true), addLw || `${F(ob.lw)} w`, ...Object.values(ob.st)];
          tails.push(`\nq\n${st.join('\n')}\n${body}\nQ\n`);
          return;
        }
        const text = `q\n${pre.length ? pre.join('\n') + '\n' : ''}${body}\nQ`;
        if (ed.dup) addSp(ob.ctx, range[1], range[1], '\n' + text + '\n');
        else addSp(ob.ctx, range[0], range[1], '\n' + text + '\n');
      }
    }
    function textEdit(ob, ed) {
      const T = ed.T || I;
      const last = ob.shows[ob.shows.length - 1].bt;
      for (const sh of ob.shows) {
        if (!blocks.has(sh.bt)) blocks.set(sh.bt, { kill: new Set(), emits: [] });
        if (!ed.dup) blocks.get(sh.bt).kill.add(sh);
      }
      if (!blocks.has(last)) blocks.set(last, { kill: new Set(), emits: [] });
      const newText = ed.text !== undefined && ed.text !== null ? String(ed.text) : null;
      if (ed.del || (newText !== null && newText.trim() === '')) { hints.push({ kind: 'none' }); return; }
      if (leavesClip(ob, ob.shows[0].clip, T, ob.bbox)) tails.push({ ob, ed, T, newText, escape: true });
      else blocks.get(last).emits.push({ ob, ed, T, newText });
      const o2 = ap(T, ob.origin[0], ob.origin[1]);
      hints.push({ kind: 'text', origin: o2, dup: !!ed.dup, src: ed.id });
    }
    // テキスト: 出力の組み立て
    const stateOps = (sh, fillOv) => {
      const out = [`${sh.fontRaw} ${F(sh.fs)} Tf`, `${F(sh.Tc)} Tc`, `${F(sh.Tw)} Tw`, `${F(sh.Tz)} Tz`, `${F(sh.Ts)} Ts`, `${sh.Tr} Tr`];
      const fillC = fillOv ? rgbColor(fillOv) : sh.fill, strokeC = fillOv && (sh.Tr === 1 || sh.Tr === 2 || sh.Tr === 5 || sh.Tr === 6) ? rgbColor(fillOv) : sh.stroke;
      out.push(colorOps(fillC, false));
      if (sh.Tr === 1 || sh.Tr === 2 || sh.Tr === 5 || sh.Tr === 6) { out.push(colorOps(strokeC, true), `${F(sh.lw)} w`); }
      return out;
    };
    function emitText(em, Cins, cx) {
      const { ob, ed, T, newText, escape } = em;
      const C = ob.shows[0].ctm, Ci = inv(Cins); if (!Ci) return '';
      const Y = mul(mul(C, T), Ci);
      const fillOv = ed.fill ? hexRgb(ed.fill) : null;
      const parts = ['q'];
      if (escape) parts.push(...ob.shows[0].gsAll);
      else for (const go of ob.shows[0].gsList) { const o = cx.ops.find((x) => x.s === go); if (o) parts.push(cx.src.slice(o.s, o.e)); }
      if (!isId(Y)) parts.push(`${FM(Y)} cm`);
      parts.push('BT');
      if (newText === null) {
        for (const sh of ob.shows) {
          parts.push(...stateOps(sh, fillOv), `${FM(sh.Tm0)} Tm`, `${sh.raw} ${sh.op === 'TJ' || (sh.op !== 'Tj' && sh.raw.startsWith('[')) ? 'TJ' : 'Tj'}`);
        }
      } else {
        const sh = ob.shows[0];
        const cands = [];
        for (const x of ob.shows) if (x.font && x.font.encodeChar && !cands.some((c) => c.font === x.font)) cands.push({ font: x.font, raw: x.fontRaw, fs: x.fs });
        parts.push(...stateOps(sh, fillOv));
        const lead = Math.abs(sh.fs) * 1.25;
        parts.push(`${FM(sh.Tm0)} Tm`);
        const lines = newText.replace(/\r\n?/g, '\n').split('\n');
        lines.forEach((ln, li) => {
          if (li) parts.push(sh.vert ? `${F(-lead)} 0 Td` : `0 ${F(-lead)} Td`);
          let run = null; const runs = [];
          for (const ch of ln) {
            let kind, bytes = null;
            let ci = -1, enc = null;
            for (let q = 0; q < cands.length && !enc; q++) { enc = cands[q].font.encodeChar(ch); if (enc) ci = q; }
            if (enc) { kind = 'o' + ci; bytes = enc; }
            else if (!sh.vert && helvCode(ch) !== null && !isHalfKana(ch.codePointAt(0))) { kind = 'l'; bytes = [helvCode(ch)]; }
            else { kind = 'j'; bytes = null; }
            if (!run || run.kind !== kind) { run = { kind, codes: [], str: '' }; runs.push(run); }
            if (bytes) run.codes.push(...bytes); run.str += ch;
          }
          let curFont = 'o0';
          for (const r of runs) {
            if (r.kind !== curFont) {
              if (r.kind[0] === 'o') { const c = cands[+r.kind.slice(1)]; parts.push(`${c.raw} ${F(c.fs)} Tf`); }
              else { const nm = r.kind === 'l' ? 'EPAHelv' : sh.vert ? 'EPAJpV' : 'EPAJpH'; needFont(cx.key, nm); parts.push(`/${nm} ${F(sh.fs)} Tf`); }
              curFont = r.kind;
            }
            parts.push(`${r.kind === 'j' ? utf16hex(r.str) : hex(r.codes)} Tj`);
          }
          if (curFont !== 'o0') { parts.push(`${sh.fontRaw} ${F(sh.fs)} Tf`); curFont = 'o0'; }
        });
      }
      parts.push('ET', 'Q');
      return '\n' + parts.join('\n') + '\n';
    }
    const neutral = (sh, cx) => {
      // 元の文字を消す。文字送りの量だけ、何も描かずに進める（同じBT内の後続の文字の位置を保つ）
      const pre = sh.op === '"' ? `${F(sh.Tw)} Tw ${F(sh.Tc)} Tc T* ` : sh.op === "'" ? 'T* ' : '';
      if (!sh.exact) {
        const orig = cx.src.slice(sh.s, sh.e);
        return `3 Tr ${orig} ${sh.Tr} Tr`;
      }
      const Th = sh.Tz / 100;
      const k = sh.vert ? (sh.fs ? -sh.adv * 1000 / sh.fs : 0) : (sh.fs * Th ? -sh.adv * 1000 / (sh.fs * Th) : 0);
      return Math.abs(k) < 1e-6 ? pre.trim() : `${pre}[${F(k)}] TJ`;
    };
    for (const [bt, info] of blocks) {
      const cx = ctxs.get(bt.cx);
      const all = bt.shows.length > 0 && bt.shows.every((s) => info.kill.has(s));
      if (all && bt.wrap) {
        const Cins = bt.wrap.ctmOuter;
        const keepPre = [];
        for (const j of bt.wrap.pre) { const po = cx.ops[j]; if (po.op === 'gs' || po.op === 'ri' || po.op === 'i') keepPre.push(cx.src.slice(po.s, po.e)); }
        let t = info.emits.map((em) => emitText(em, Cins, cx)).join('');
        if (keepPre.length && t) t = `\nq\n${keepPre.join('\n')}\n${t}Q\n`;
        addSp(bt.cx, bt.wrap.s, bt.wrap.e, t);
      } else {
        for (const sh of info.kill) addSp(bt.cx, sh.s, sh.e, neutral(sh, cx));
        const t = info.emits.map((em) => emitText(em, bt.ctm, cx)).join('');
        if (t) addSp(bt.cx, bt.etEnd, bt.etEnd, t);
      }
    }
    // ---- クリップの外へ出したものは、ページの内容全体を q … Q で囲んだあとに描く
    // 配置順を変えたものを、移動先に（その時点の状態に左右されないよう、色・線・変換をすべて書き出して）描き直す
    {
      const cxp = ctxs.get('p');
      const selfPath = (pt, Cins) => {
        const Ci = inv(Cins); if (!Ci) return '';
        const body = cxp.src.slice(pt.ps, pt.paintKs) + pt.paint;
        const st = [...pt.gsAll, `${FM(mul(pt.ctm, Ci))} cm`, colorOps(pt.fillState, false), colorOps(pt.strokeState, true), `${F(pt.lw)} w`, ...Object.values(pt.st)];
        return `\nq\n${st.join('\n')}\n${body}\nQ\n`;
      };
      const emitObj = (ob, Cins) => (ob.kind === 'path' ? (ob.parts || [ob]).map((pt) => selfPath(pt, Cins)).join('')
        : emitText({ ob, ed: {}, T: I, newText: null, escape: true }, Cins, cxp));
      for (const z of zIns.sort((a, b) => a.ob.z - b.ob.z)) {
        if (z.place.where === 'tail') tails.push(emitObj(z.ob, I));
        else addSp('p', z.place.pos, z.place.pos, emitObj(z.ob, z.place.Cins));
      }
    }
    const tailText = tails.map((t) => (typeof t === 'string' ? t : emitText(t, I, ctxs.get('p')))).join('');
    if (tailText && !splices.has('p')) splices.set('p', []);
    // ---- ストリームへ書き戻す
    const newContent = new Map();
    for (const [key, list] of splices) {
      const cx = ctxs.get(key), src = cx.src;
      list.sort((a, b) => a.s - b.s || a.e - b.e);
      let pos = 0, out = '';
      for (const sp of list) {
        if (sp.s < pos) { console.warn('重なった編集を無視しました', sp); continue; }
        out += src.slice(pos, sp.s) + sp.t; pos = sp.e;
      }
      out += src.slice(pos);
      if (key === 'p' && tailText) out = `q\n${out}\n${'Q\n'.repeat(1 + (cx.depthEnd || 0))}${tailText}`;
      if (key === 'p' && opts.isolate) out = tailText;          // ドラッグ中の表示用: 選択したものだけを描くページ
      newContent.set(key, s2b(out));
    }
    const resPatch = new Map();   // ctxKey -> { fonts: Map(name->ref), xobj: Map(name->ref) }
    const patchOf = (key) => { if (!resPatch.has(key)) resPatch.set(key, { fonts: new Map(), xobj: new Map() }); return resPatch.get(key); };
    if (fontNeeds.size) { const fb = fallbackFonts(doc); for (const [key, set] of fontNeeds) for (const nm of set) patchOf(key).fonts.set(nm, fb[nm]); }
    const dirty = new Set([...newContent.keys(), ...resPatch.keys()]);
    const order = [...ctxs.values()].sort((a, b) => b.depth - a.depth);
    const patchRes = (resDict) => {   // 浅い複製を作り、Font / XObject を差し替える
      return (patch) => {
        const own = resDict ? resDict.clone(ctx) : ctx.obj({});
        for (const [sub, map] of [['Font', patch.fonts], ['XObject', patch.xobj]]) {
          if (!map.size) continue;
          const d0 = ctx.lookupMaybe(own.get(N(sub)), PDFDict);
          const d1 = d0 ? d0.clone(ctx) : ctx.obj({});
          for (const [nm, ref] of map) d1.set(N(nm), ref);
          own.set(N(sub), d1);
        }
        return own;
      };
    };
    for (const cx of order) {
      if (!dirty.has(cx.key)) continue;
      const bytes = newContent.get(cx.key) || null, patch = resPatch.get(cx.key);
      if (cx.key === 'p') {
        if (bytes) {
          const old = page.node.get(N('Contents'));
          const oldRefs = old instanceof PDFRef ? [old] : (ctx.lookup(old) instanceof PDFArray ? ctx.lookup(old).asArray().filter((x) => x instanceof PDFRef) : []);
          const st = ctx.flateStream(bytes); page.node.set(N('Contents'), ctx.register(st));
          for (const r of oldRefs) { if (ctx.lookup(r) instanceof PDFStream) ctx.delete(r); }
        }
        if (patch) page.node.set(N('Resources'), patchRes(page.node.Resources())(patch));
        continue;
      }
      // フォームXObject: このページ専用の複製を作って差し替える（他のページで共有されていても影響しない）
      const content = bytes || streamBytes(cx.stream);
      const st = ctx.flateStream(content);
      for (const [k, v] of cx.stream.dict.entries()) {
        const kk = k.asString();
        if (kk === '/Length' || kk === '/Filter' || kk === '/DecodeParms' || kk === '/DL') continue;
        st.dict.set(k, v);
      }
      if (patch) st.dict.set(N('Resources'), patchRes(cx.ownRes ? ctx.lookupMaybe(cx.stream.dict.get(N('Resources')), PDFDict) : cx.resources)(patch));
      const ref = ctx.register(st);
      patchOf(cx.parent.key).xobj.set(cx.name, ref);
      dirty.add(cx.parent.key);
      if (!order.includes(cx.parent)) order.push(cx.parent);
    }
    hints.zSkip = zSkip;
    return hints;
  }

  /** 編集後の解析結果から、手がかりに合うオブジェクトを探す（v3.8: 位置で索引を作り、数が多くても速く） */
  function findByHints(parsed, hints, tol = 0.75) {
    const CELL = 8, grid = new Map(), used = new Set(), ids = [];
    const keyOf = (kind, x, y) => `${kind}:${Math.floor(x / CELL)}:${Math.floor(y / CELL)}`;
    const anchor = (o) => (o.kind === 'text' ? o.origin : [(o.raw[0] + o.raw[2]) / 2, (o.raw[1] + o.raw[3]) / 2]);
    for (const o of parsed.objs) {
      const [x, y] = anchor(o), k = keyOf(o.kind, x, y);
      if (!grid.has(k)) grid.set(k, []); grid.get(k).push(o);
    }
    for (const h of hints) {
      if (h.kind !== 'path' && h.kind !== 'text') continue;
      const [x, y] = h.kind === 'text' ? h.origin : [(h.bbox[0] + h.bbox[2]) / 2, (h.bbox[1] + h.bbox[3]) / 2];
      const lim = h.kind === 'text' ? tol * 2 : Math.max(tol, 0.02 * Math.max(h.bbox[2] - h.bbox[0], h.bbox[3] - h.bbox[1]));
      const r = Math.max(1, Math.ceil(lim / CELL)), cx = Math.floor(x / CELL), cy = Math.floor(y / CELL);
      let best = null, bd = Infinity;
      for (let i = cx - r; i <= cx + r; i++) for (let j = cy - r; j <= cy + r; j++) {
        const list = grid.get(`${h.kind}:${i}:${j}`); if (!list) continue;
        for (const o of list) {
          if (used.has(o.id)) continue;
          let d;
          if (h.kind === 'text') d = Math.hypot(o.origin[0] - x, o.origin[1] - y);
          else { d = 0; for (let k = 0; k < 4; k++) d = Math.max(d, Math.abs(o.raw[k] - h.bbox[k])); }
          if (d < bd) { bd = d; best = o; }
        }
      }
      if (best && bd < lim) { ids.push(best.id); used.add(best.id); }
    }
    return ids;
  }

  // parsePage: ページを解析して、編集できる文字の行・図形の一覧を返す
  // applyEdits: 移動・削除・色の変更・文字の置き換えなどを、コンテンツストリームに書き込む
  // findByHints: 編集後にページを解析し直したとき、編集したものがどれになったかを探す（選択を保つため）
  // mul / inv / ap: 行列の掛け算・逆行列・点の変換、isId: 単位行列か
  return { parsePage, applyEdits, findByHints, mul, inv, ap, isId };
}
