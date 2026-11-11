/* PDF の編集ロック解除（標準セキュリティハンドラ: RC4 40/128bit・AES-128・AES-256）
 *  所有者パスワード（権限パスワード）を確かめてから、すべての文字列・ストリームを復号し、暗号化を外したPDFを作る。
 *  pdf-lib は暗号化PDFを読めないため、読み込みの途中（オブジェクトストリームの展開前）に復号を差し込む。 */
export function createPdfUnlocker(PDFLib) {
  const { PDFParser, PDFObjectStreamParser, PDFContext, PDFDocument, PDFDict, PDFArray, PDFName, PDFString, PDFHexString, PDFRawStream, PDFRef, PDFNumber } = PDFLib;
  const N = (k) => PDFName.of(k);

  /* ------------------------------------------------------------ MD5 */
  function md5(data) {
    const K = new Int32Array(64), Sx = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
    for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0;
    const len = data.length, n = ((len + 8) >> 6) + 1, buf = new Uint8Array(n * 64);
    buf.set(data); buf[len] = 0x80;
    const bits = len * 8; for (let i = 0; i < 4; i++) buf[n * 64 - 8 + i] = (bits >>> (8 * i)) & 0xff;
    buf[n * 64 - 4] = Math.floor(len / 0x20000000) & 0xff;
    let a0 = 0x67452301, b0 = 0xefcdab89 | 0, c0 = 0x98badcfe | 0, d0 = 0x10325476;
    const M = new Int32Array(16);
    for (let ch = 0; ch < n; ch++) {
      for (let i = 0; i < 16; i++) { const o = ch * 64 + i * 4; M[i] = buf[o] | (buf[o + 1] << 8) | (buf[o + 2] << 16) | (buf[o + 3] << 24); }
      let A = a0, B = b0, C = c0, D = d0;
      for (let i = 0; i < 64; i++) {
        let F, g;
        if (i < 16) { F = (B & C) | (~B & D); g = i; }
        else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
        else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
        else { F = C ^ (B | ~D); g = (7 * i) % 16; }
        const s = Sx[(i >> 4) * 4 + (i & 3)], t = (A + F + K[i] + M[g]) | 0;
        A = D; D = C; C = B; B = (B + ((t << s) | (t >>> (32 - s)))) | 0;
      }
      a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
    }
    const out = new Uint8Array(16);
    [a0, b0, c0, d0].forEach((v, k) => { for (let i = 0; i < 4; i++) out[k * 4 + i] = (v >>> (8 * i)) & 0xff; });
    return out;
  }
  /* ------------------------------------------------------------ RC4 */
  function rc4(key, data) {
    const s = new Uint8Array(256); for (let i = 0; i < 256; i++) s[i] = i;
    for (let i = 0, j = 0; i < 256; i++) { j = (j + s[i] + key[i % key.length]) & 255; const t = s[i]; s[i] = s[j]; s[j] = t; }
    const out = new Uint8Array(data.length);
    for (let k = 0, i = 0, j = 0; k < data.length; k++) {
      i = (i + 1) & 255; j = (j + s[i]) & 255; const t = s[i]; s[i] = s[j]; s[j] = t;
      out[k] = data[k] ^ s[(s[i] + s[j]) & 255];
    }
    return out;
  }
  /* ------------------------------------------------------------ AES（128 / 256） */
  const SBOX = new Uint8Array(256), INV = new Uint8Array(256);
  {
    let p = 1, q = 1;
    do {
      p = p ^ ((p << 1) & 0xff) ^ (p & 0x80 ? 0x1b : 0);
      q ^= q << 1; q ^= q << 2; q ^= q << 4; q &= 0xff; if (q & 0x80) q ^= 0x09;
      const x = q ^ ((q << 1) | (q >> 7)) ^ ((q << 2) | (q >> 6)) ^ ((q << 3) | (q >> 5)) ^ ((q << 4) | (q >> 4));
      SBOX[p] = (x ^ 0x63) & 0xff;
    } while (p !== 1);
    SBOX[0] = 0x63;
    for (let i = 0; i < 256; i++) INV[SBOX[i]] = i;
  }
  const xt = (b) => ((b << 1) ^ (b & 0x80 ? 0x1b : 0)) & 0xff;
  const gm = (a, b) => { let r = 0; while (b) { if (b & 1) r ^= a; a = xt(a); b >>= 1; } return r; };
  function expandKey(key) {
    const nk = key.length / 4, nr = nk + 6, w = new Uint8Array(16 * (nr + 1));
    w.set(key);
    let rcon = 1;
    for (let i = nk; i < 4 * (nr + 1); i++) {
      let t = w.slice((i - 1) * 4, i * 4);
      if (i % nk === 0) { t = new Uint8Array([SBOX[t[1]] ^ rcon, SBOX[t[2]], SBOX[t[3]], SBOX[t[0]]]); rcon = xt(rcon); }
      else if (nk > 6 && i % nk === 4) t = t.map((v) => SBOX[v]);
      for (let k = 0; k < 4; k++) w[i * 4 + k] = w[(i - nk) * 4 + k] ^ t[k];
    }
    return { w, nr };
  }
  function encBlock(ks, inp) {
    const { w, nr } = ks, s = new Uint8Array(16);
    for (let i = 0; i < 16; i++) s[i] = inp[i] ^ w[i];
    for (let r = 1; r <= nr; r++) {
      for (let i = 0; i < 16; i++) s[i] = SBOX[s[i]];
      const t = s.slice();
      for (let c = 0; c < 4; c++) for (let rr = 0; rr < 4; rr++) s[c * 4 + rr] = t[((c + rr) % 4) * 4 + rr];
      if (r !== nr) for (let c = 0; c < 4; c++) {
        const a = s.slice(c * 4, c * 4 + 4);
        s[c * 4] = xt(a[0]) ^ xt(a[1]) ^ a[1] ^ a[2] ^ a[3];
        s[c * 4 + 1] = a[0] ^ xt(a[1]) ^ xt(a[2]) ^ a[2] ^ a[3];
        s[c * 4 + 2] = a[0] ^ a[1] ^ xt(a[2]) ^ xt(a[3]) ^ a[3];
        s[c * 4 + 3] = xt(a[0]) ^ a[0] ^ a[1] ^ a[2] ^ xt(a[3]);
      }
      for (let i = 0; i < 16; i++) s[i] ^= w[r * 16 + i];
    }
    return s;
  }
  // 高速な復号（表引き方式）。大きなPDFでも一瞬で復号できるよう、32ビット単位で計算する
  const TD = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  for (let x = 0; x < 256; x++) {
    const v = INV[x], a14 = gm(v, 14), a9 = gm(v, 9), a13 = gm(v, 13), a11 = gm(v, 11);
    TD[0][x] = ((a14 << 24) | (a9 << 16) | (a13 << 8) | a11) >>> 0;
    TD[1][x] = ((a11 << 24) | (a14 << 16) | (a9 << 8) | a13) >>> 0;
    TD[2][x] = ((a13 << 24) | (a11 << 16) | (a14 << 8) | a9) >>> 0;
    TD[3][x] = ((a9 << 24) | (a13 << 16) | (a11 << 8) | a14) >>> 0;
  }
  function decKeys(key) {
    const { w, nr } = expandKey(key), n = 4 * (nr + 1), rk = new Uint32Array(n);
    for (let i = 0; i < n; i++) rk[i] = ((w[i * 4] << 24) | (w[i * 4 + 1] << 16) | (w[i * 4 + 2] << 8) | w[i * 4 + 3]) >>> 0;
    for (let i = 4; i < n - 4; i++) {     // 中間ラウンドの鍵には InvMixColumns をかけておく
      const v = rk[i];
      rk[i] = (TD[0][SBOX[v >>> 24]] ^ TD[1][SBOX[(v >>> 16) & 255]] ^ TD[2][SBOX[(v >>> 8) & 255]] ^ TD[3][SBOX[v & 255]]) >>> 0;
    }
    return { rk, nr };
  }
  /** AES-CBC 復号。先頭16バイトがIV（iv を渡したときはそれを使う）。unpad: PKCS#5 の詰め物を取る */
  function aesCbcDecrypt(key, data, { iv = null, unpad = true } = {}) {
    const { rk, nr } = decKeys(key), [T0, T1, T2, T3] = TD, IS = INV;
    const ivb = iv || data.subarray(0, 16), off = iv ? 0 : 16;
    const n = Math.floor((data.length - off) / 16), out = new Uint8Array(n * 16);
    const rd = (b, i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
    let p0 = rd(ivb, 0), p1 = rd(ivb, 4), p2 = rd(ivb, 8), p3 = rd(ivb, 12);
    const K = nr * 4;
    for (let b = 0, o = off; b < n; b++, o += 16) {
      const c0 = rd(data, o), c1 = rd(data, o + 4), c2 = rd(data, o + 8), c3 = rd(data, o + 12);
      let s0 = c0 ^ rk[K], s1 = c1 ^ rk[K + 1], s2 = c2 ^ rk[K + 2], s3 = c3 ^ rk[K + 3], t0, t1, t2, t3;
      for (let r = nr - 1; r >= 1; r--) {
        const k = r * 4;
        t0 = T0[s0 >>> 24] ^ T1[(s3 >>> 16) & 255] ^ T2[(s2 >>> 8) & 255] ^ T3[s1 & 255] ^ rk[k];
        t1 = T0[s1 >>> 24] ^ T1[(s0 >>> 16) & 255] ^ T2[(s3 >>> 8) & 255] ^ T3[s2 & 255] ^ rk[k + 1];
        t2 = T0[s2 >>> 24] ^ T1[(s1 >>> 16) & 255] ^ T2[(s0 >>> 8) & 255] ^ T3[s3 & 255] ^ rk[k + 2];
        t3 = T0[s3 >>> 24] ^ T1[(s2 >>> 16) & 255] ^ T2[(s1 >>> 8) & 255] ^ T3[s0 & 255] ^ rk[k + 3];
        s0 = t0; s1 = t1; s2 = t2; s3 = t3;
      }
      const f0 = ((IS[s0 >>> 24] << 24) | (IS[(s3 >>> 16) & 255] << 16) | (IS[(s2 >>> 8) & 255] << 8) | IS[s1 & 255]) ^ rk[0] ^ p0;
      const f1 = ((IS[s1 >>> 24] << 24) | (IS[(s0 >>> 16) & 255] << 16) | (IS[(s3 >>> 8) & 255] << 8) | IS[s2 & 255]) ^ rk[1] ^ p1;
      const f2 = ((IS[s2 >>> 24] << 24) | (IS[(s1 >>> 16) & 255] << 16) | (IS[(s0 >>> 8) & 255] << 8) | IS[s3 & 255]) ^ rk[2] ^ p2;
      const f3 = ((IS[s3 >>> 24] << 24) | (IS[(s2 >>> 16) & 255] << 16) | (IS[(s1 >>> 8) & 255] << 8) | IS[s0 & 255]) ^ rk[3] ^ p3;
      const q = b * 16;
      out[q] = f0 >>> 24; out[q + 1] = f0 >>> 16; out[q + 2] = f0 >>> 8; out[q + 3] = f0;
      out[q + 4] = f1 >>> 24; out[q + 5] = f1 >>> 16; out[q + 6] = f1 >>> 8; out[q + 7] = f1;
      out[q + 8] = f2 >>> 24; out[q + 9] = f2 >>> 16; out[q + 10] = f2 >>> 8; out[q + 11] = f2;
      out[q + 12] = f3 >>> 24; out[q + 13] = f3 >>> 16; out[q + 14] = f3 >>> 8; out[q + 15] = f3;
      p0 = c0; p1 = c1; p2 = c2; p3 = c3;
    }
    if (unpad && out.length) { const p = out[out.length - 1]; if (p >= 1 && p <= 16) return out.subarray(0, out.length - p); }
    return out;
  }
  function aesCbcEncryptNoPad(key, iv, data) {
    const ks = expandKey(key), out = new Uint8Array(data.length);
    let prev = iv;
    for (let b = 0; b < data.length / 16; b++) {
      const x = new Uint8Array(16);
      for (let i = 0; i < 16; i++) x[i] = data[b * 16 + i] ^ prev[i];
      prev = encBlock(ks, x); out.set(prev, b * 16);
    }
    return out;
  }
  /* ------------------------------------------------------------ SHA-2（ブラウザ標準の WebCrypto） */
  const sha = async (alg, data) => new Uint8Array(await crypto.subtle.digest(alg, data));
  const cat = (...a) => { let n = 0; for (const x of a) n += x.length; const o = new Uint8Array(n); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };
  const eq = (a, b, n = a.length) => { for (let i = 0; i < n; i++) if (a[i] !== b[i]) return false; return true; };
  /** Algorithm 2.B（R6 のハッシュ） */
  async function hash2B(pw, salt, udata) {
    let K = await sha('SHA-256', cat(pw, salt, udata));
    for (let i = 0; ; ) {
      const one = cat(pw, K, udata), K1 = new Uint8Array(one.length * 64);
      for (let r = 0; r < 64; r++) K1.set(one, r * one.length);
      const E = aesCbcEncryptNoPad(K.subarray(0, 16), K.subarray(16, 32), K1);
      let sum = 0; for (let k = 0; k < 16; k++) sum += E[k];
      K = await sha(['SHA-256', 'SHA-384', 'SHA-512'][sum % 3], E);
      i++;
      if (i >= 64 && E[E.length - 1] <= i - 32) break;
    }
    return K.subarray(0, 32);
  }

  /* ------------------------------------------------------------ 鍵の算出（所有者パスワード） */
  const PAD = new Uint8Array([0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,
    0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a]);
  const padPw = (pw) => { const o = new Uint8Array(32); const b = pw.subarray(0, 32); o.set(b); o.set(PAD.subarray(0, 32 - b.length), b.length); return o; };
  const latin = (s) => { const o = []; for (const ch of s) { const c = ch.codePointAt(0); o.push(c < 256 ? c : 63); } return Uint8Array.from(o); };
  function fileKeyR4(userPad, enc) {
    const { O, P, id0, n, R, encMeta } = enc;
    const pb = new Uint8Array([P & 0xff, (P >>> 8) & 0xff, (P >>> 16) & 0xff, (P >>> 24) & 0xff]);
    let h = md5(cat(userPad, O.subarray(0, 32), pb, id0, R >= 4 && !encMeta ? new Uint8Array([255, 255, 255, 255]) : new Uint8Array(0)));
    if (R >= 3) for (let i = 0; i < 50; i++) h = md5(h.subarray(0, n));
    return h.subarray(0, n);
  }
  function checkUserR4(key, enc) {
    const { U, id0, R } = enc;
    if (R === 2) return eq(rc4(key, PAD), U, 32);
    let x = rc4(key, md5(cat(PAD, id0)));
    for (let i = 1; i <= 19; i++) x = rc4(key.map((v) => v ^ i), x);
    return eq(x, U, 16);
  }
  async function ownerKey(password, enc) {
    const { R, O, U, OE, n } = enc;
    if (R >= 5) {
      let pw = new TextEncoder().encode(password.normalize('NFKC')); if (pw.length > 127) pw = pw.subarray(0, 127);
      const U48 = U.subarray(0, 48);
      const h = R === 5 ? await sha('SHA-256', cat(pw, O.subarray(32, 40), U48)) : await hash2B(pw, O.subarray(32, 40), U48);
      if (!eq(h, O, 32)) return null;
      const ik = R === 5 ? await sha('SHA-256', cat(pw, O.subarray(40, 48), U48)) : await hash2B(pw, O.subarray(40, 48), U48);
      return aesCbcDecrypt(ik, OE.subarray(0, 32), { iv: new Uint8Array(16), unpad: false });
    }
    let h = md5(padPw(latin(password)));
    if (R >= 3) for (let i = 0; i < 50; i++) h = md5(h);
    const k = h.subarray(0, n);
    let x = O.subarray(0, 32);
    if (R === 2) x = rc4(k, x);
    else for (let i = 19; i >= 0; i--) x = rc4(k.map((v) => v ^ i), x);
    const key = fileKeyR4(x, enc);
    return checkUserR4(key, enc) ? key : null;
  }

  // 利用者用パスワード（ふつうは空）で鍵を求める。開くだけのPDFの印刷用コピーを作るときに使う。
  async function userKey(password, enc) {
    const { R, U, UE } = enc;
    if (R >= 5) {
      let pw = new TextEncoder().encode(password.normalize('NFKC')); if (pw.length > 127) pw = pw.subarray(0, 127);
      const h = R === 5 ? await sha('SHA-256', cat(pw, U.subarray(32, 40))) : await hash2B(pw, U.subarray(32, 40), new Uint8Array(0));
      if (!eq(h, U, 32) || !UE) return null;
      const ik = R === 5 ? await sha('SHA-256', cat(pw, U.subarray(40, 48))) : await hash2B(pw, U.subarray(40, 48), new Uint8Array(0));
      return aesCbcDecrypt(ik, UE.subarray(0, 32), { iv: new Uint8Array(16), unpad: false });
    }
    const key = fileKeyR4(padPw(latin(password)), enc);
    return checkUserR4(key, enc) ? key : null;
  }

  /* ------------------------------------------------------------ 読み込みへの差し込み */
  const origHeader = PDFParser.prototype.parseIndirectObjectHeader;
  const origForStream = PDFObjectStreamParser.forStream;
  const origAssign = PDFContext.prototype.assign;
  let HOOK = null;     // { lastRef, decryptStream(ref, bytes), inStm, plain:Set }
  PDFParser.prototype.parseIndirectObjectHeader = function (...a) { const r = origHeader.apply(this, a); if (HOOK) HOOK.lastRef = r; return r; };
  PDFObjectStreamParser.forStream = function (stream, ...a) {
    if (HOOK && HOOK.skipObjStm) return { parseIntoContext: async () => {} };     // 暗号化の情報を読むだけのときは展開しない
    if (HOOK && HOOK.decryptStream && HOOK.lastRef) stream.contents = HOOK.decryptStream(HOOK.lastRef, stream.contents);
    const p = origForStream.call(this, stream, ...a);
    if (HOOK) {
      const run = p.parseIntoContext.bind(p), hk = HOOK;
      p.parseIntoContext = async () => { hk.inStm = true; try { return await run(); } finally { hk.inStm = false; } };
    }
    return p;
  };
  PDFContext.prototype.assign = function (ref, obj) { if (HOOK && HOOK.inStm) HOOK.plain.add(ref.tag); return origAssign.call(this, ref, obj); };
  async function parseContext(bytes, hook) {
    HOOK = hook;
    try { return await PDFParser.forBytesWithOptions(bytes, 100, false, false).parseDocument(); }
    finally { HOOK = null; }
  }

  /* ------------------------------------------------------------ 暗号化の情報 */
  const bytesOf = (o) => (o && o.asBytes ? o.asBytes() : new Uint8Array(0));
  async function readEncryption(bytes) {
    const ctx = await parseContext(bytes, { lastRef: null, decryptStream: null, inStm: false, plain: new Set(), skipObjStm: true });
    const encRaw = ctx.trailerInfo.Encrypt;
    if (!encRaw) return null;
    const ed = ctx.lookup(encRaw);
    if (!(ed instanceof PDFDict)) throw new Error('暗号化の情報を読み取れません。');
    const L = (k) => ctx.lookup(ed.get(N(k)));
    const num = (k, d) => { const v = L(k); return v && v.asNumber ? v.asNumber() : d; };
    const filter = L('Filter');
    if (!filter || filter.asString() !== '/Standard') throw new Error('このPDFは、パスワード以外の方式（証明書など）で保護されているため、解除できません。');
    const V = num('V', 0), R = num('R', 2);
    let n = (num('Length', 40) / 8) | 0;
    const ids = ctx.lookup(ctx.trailerInfo.ID);
    const id0 = ids instanceof PDFArray ? bytesOf(ctx.lookup(ids.get(0))) : new Uint8Array(0);
    const em = L('EncryptMetadata');
    const enc = { V, R, n: R === 2 ? 5 : n, P: num('P', -1) | 0, O: bytesOf(L('O')), U: bytesOf(L('U')), OE: bytesOf(L('OE')), UE: bytesOf(L('UE')), id0, encMeta: !(em && em.asBoolean && em.asBoolean() === false),
      stm: 'RC4', str: 'RC4', encRef: encRaw instanceof PDFRef ? encRaw : null };
    if (V >= 4) {
      const cf = L('CF'), method = (name) => {
        if (!name || name === 'Identity') return 'None';
        const d = cf instanceof PDFDict ? ctx.lookup(cf.get(N(name))) : null;
        const m = d instanceof PDFDict ? ctx.lookup(d.get(N('CFM'))) : null;
        const ln = d instanceof PDFDict ? ctx.lookup(d.get(N('Length'))) : null;
        if (ln && ln.asNumber) { const v = ln.asNumber(); if (R < 5) enc.n = v > 32 ? v / 8 : v; }
        const s = m && m.asString ? m.asString().slice(1) : 'None';
        return s === 'AESV2' ? 'AES128' : s === 'AESV3' ? 'AES256' : s === 'V2' ? 'RC4' : 'None';
      };
      const nm = (k) => { const v = L(k); return v && v.asString ? v.asString().slice(1) : 'Identity'; };
      enc.stm = method(nm('StmF')); enc.str = method(nm('StrF'));
    }
    if (R >= 5) { enc.stm = enc.stm === 'None' ? 'None' : 'AES256'; enc.str = enc.str === 'None' ? 'None' : 'AES256'; enc.n = 32; }
    return enc;
  }
  function objKey(fileKey, ref, aes) {
    const n = ref.objectNumber, g = ref.generationNumber;
    const x = cat(fileKey, new Uint8Array([n & 255, (n >> 8) & 255, (n >> 16) & 255, g & 255, (g >> 8) & 255]), aes ? new Uint8Array([0x73, 0x41, 0x6c, 0x54]) : new Uint8Array(0));
    return md5(x).subarray(0, Math.min(fileKey.length + 5, 16));
  }
  function decryptWith(method, fileKey, ref, data) {
    if (method === 'None' || !data.length) return data;
    if (method === 'AES256') return data.length >= 16 ? aesCbcDecrypt(fileKey, data) : new Uint8Array(0);
    if (method === 'AES128') return data.length >= 16 ? aesCbcDecrypt(objKey(fileKey, ref, true), data) : new Uint8Array(0);
    return rc4(objKey(fileKey, ref, false), data);
  }

  /**
   * 所有者パスワードで編集ロックを解除し、暗号化を外したPDFのバイト列を返す。
   * 戻り値: { bytes } 。パスワードが違う場合は { error: 'password' }
   */
  async function unlock(bytes, password, { asUser = false } = {}) {
    const enc = await readEncryption(bytes);
    if (!enc) return { bytes, notEncrypted: true };
    const key = asUser ? await userKey(password || '', enc) : await ownerKey(password || '', enc);
    if (!key) return { error: 'password' };
    const hook = { lastRef: null, inStm: false, plain: new Set(), decryptStream: (ref, data) => decryptWith(enc.stm, key, ref, data) };
    const ctx = await parseContext(bytes, hook);
    const encTag = enc.encRef ? enc.encRef.tag : null;
    const decStr = (ref, o) => {
      if (o instanceof PDFString || o instanceof PDFHexString) {
        const d = decryptWith(enc.str, key, ref, o.asBytes());
        return PDFHexString.of([...d].map((v) => v.toString(16).padStart(2, '0')).join(''));
      }
      if (o instanceof PDFArray) { for (let i = 0; i < o.size(); i++) { const v = o.get(i), nv = decStr(ref, v); if (nv !== v) o.set(i, nv); } return o; }
      if (o instanceof PDFDict) { for (const [k, v] of o.entries()) { const nv = decStr(ref, v); if (nv !== v) o.set(k, nv); } return o; }
      return o;
    };
    for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
      if (ref.tag === encTag || hook.plain.has(ref.tag)) continue;      // 暗号化の辞書、オブジェクトストリームの中身（まとめて復号済み）は除く
      if (obj instanceof PDFRawStream) {
        const t = obj.dict.lookup(N('Type'));
        const tn = t && t.asString ? t.asString() : '';
        if (tn === '/XRef') continue;
        decStr(ref, obj.dict);
        if (tn === '/ObjStm') continue;                                 // 読み込み時に復号済み
        if (tn === '/Metadata' && !enc.encMeta) continue;
        obj.contents = decryptWith(enc.stm, key, ref, obj.contents);
        obj.dict.set(N('Length'), PDFNumber.of(obj.contents.length));
      } else decStr(ref, obj);
    }
    if (enc.encRef) ctx.delete(enc.encRef);
    ctx.trailerInfo.Encrypt = undefined;
    const doc = await PDFDocument.load(await new PDFDocument(ctx, true, false).save({ useObjectStreams: false }), { updateMetadata: false });
    return { bytes: await doc.save({ useObjectStreams: false }), enc: { R: enc.R, method: enc.stm } };
  }
  /* 暗号化の情報だけを、文書全体を解析せずに読む（v4.11.1: 大きなPDFで「文書プロパティ」の表示が遅かったため）
   *  末尾（と先頭）のトレーラーから /Encrypt と /ID を探し、暗号化の辞書のオブジェクトだけを取り出して、小さなPDFとして解析する。
   *  読み取れないときは null（呼び出し側で、従来どおり文書全体を解析する） */
  const latin1 = (u8) => { let t = ''; for (let i = 0; i < u8.length; i += 8192) t += String.fromCharCode.apply(null, u8.subarray(i, i + 8192)); return t; };
  async function readEncryptionFast(bytes) {
    const n = bytes.length, tail = latin1(bytes.subarray(Math.max(0, n - 2e6))), head = latin1(bytes.subarray(0, Math.min(n, 1e6)));
    const lastOf = (txt, re) => { let m, r = null; re.lastIndex = 0; while ((m = re.exec(txt))) r = m; return r; };
    const encRe = /\/Encrypt\s+(\d+)\s+(\d+)\s+R/g, idRe = /\/ID\s*\[\s*<([0-9A-Fa-f\s]*)>/g;
    const em = lastOf(tail, encRe) || lastOf(head, encRe);
    if (!em) return /\/Encrypt\b/.test(tail) || /\/Encrypt\b/.test(head) ? undefined : null;   // 直接書かれた辞書などは、従来の方法で読む
    const idm = lastOf(tail, idRe) || lastOf(head, idRe);
    if (!idm) return undefined;
    // 暗号化の辞書のオブジェクト（"N G obj"）を、ファイルの中から探す（最後のものが有効）
    const pat = new TextEncoder().encode(`${em[1]} ${em[2]} obj`), L = pat.length;
    let pos = -1;
    for (let i = bytes.lastIndexOf(0x6f); i >= L - 3; i = bytes.lastIndexOf(0x6f, i - 1)) {     // 'o'（"obj" の先頭）を手がかりに、後ろから探す（最後のものが有効）
      if (bytes[i + 1] !== 0x62 || bytes[i + 2] !== 0x6a) continue;
      const st = i - (L - 3);
      let ok = st === 0 || bytes[st - 1] <= 0x20;
      for (let k = 0; ok && k < L - 3; k++) if (bytes[st + k] !== pat[k]) ok = false;
      if (ok) { pos = st; break; }
    }
    if (pos < 0) return undefined;
    const body = latin1(bytes.subarray(pos, Math.min(n, pos + 65536)));
    const end = body.indexOf('endobj'); if (end < 0) return undefined;
    const mini = `%PDF-1.7\n${body.slice(0, end + 6)}\ntrailer\n<< /Encrypt ${em[1]} ${em[2]} R /ID [<${idm[1].replace(/\s+/g, '')}><${idm[1].replace(/\s+/g, '')}>] >>\n%%EOF\n`;
    const u8 = new Uint8Array(mini.length); for (let i = 0; i < mini.length; i++) u8[i] = mini.charCodeAt(i) & 255;
    return await readEncryption(u8);
  }
  /** 暗号化されているか・方式（表示用） */
  async function info(bytes) {
    try {
      let enc;
      try { enc = await readEncryptionFast(bytes); } catch { enc = undefined; }
      if (enc === undefined) enc = await readEncryption(bytes);
      if (!enc) return null;
      const label = enc.stm === 'AES256' ? 'AES 256ビット' : enc.stm === 'AES128' ? 'AES 128ビット' : enc.stm === 'RC4' ? `RC4 ${enc.n * 8}ビット` : '暗号化なし（Identity）';
      return { R: enc.R, label, P: enc.P };
    } catch (e) { return { error: e.message || String(e) }; }
  }
  // _t は動作確認（テスト）用に内部の暗号関数を出しているだけで、拡張機能の本体からは使わない
  return { unlock, info, _t: { md5, rc4, aesCbcDecrypt, aesCbcEncryptNoPad } };
}
