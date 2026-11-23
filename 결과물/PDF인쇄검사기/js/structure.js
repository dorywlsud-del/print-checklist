/* PDF 구조 분석 (pdf-lib 사용)
 * 페이지 박스, 폰트, 이미지, 색상, 선 두께, 투명도, 주석, 레이어 정보를 수집한다.
 */
(function () {
  'use strict';
  const { PDFDocument, PDFName, PDFDict, PDFArray, PDFRawStream, PDFNumber, PDFRef,
    PDFString, PDFHexString, PDFBool, decodePDFRawStream } = PDFLib;

  const PT2MM = 25.4 / 72;
  const N = (s) => PDFName.of(s);

  // ---------- pdf-lib 헬퍼 ----------
  const utf8 = new TextDecoder('utf-8', { fatal: true });
  let euckr = null; try { euckr = new TextDecoder('euc-kr'); } catch (e) { }
  function nameStr(o) {
    if (!o) return null;
    if (o instanceof PDFName) {
      let s;
      try { s = o.decodeText(); } catch (e) { return o.toString().replace(/^\//, ''); }
      if (/[\x80-\xff]/.test(s)) { // 한글 등 비ASCII 이름(별색명 등)
        const bytes = Uint8Array.from(s, ch => ch.charCodeAt(0) & 255);
        try { return utf8.decode(bytes); } catch (e) { if (euckr) return euckr.decode(bytes); }
      }
      return s;
    }
    return null;
  }
  function num(o, d) { return o instanceof PDFNumber ? o.asNumber() : d; }
  function textOf(o) {
    if (o instanceof PDFString || o instanceof PDFHexString) { try { return o.decodeText(); } catch (e) { return ''; } }
    return nameStr(o) || '';
  }
  function streamDict(o) {
    if (!o) return null;
    if (o instanceof PDFDict) return o;
    if (o.dict instanceof PDFDict) return o.dict;
    return null;
  }
  function streamBytes(s) {
    if (s instanceof PDFRawStream) return decodePDFRawStream(s).decode();
    if (s && typeof s.getContents === 'function') return s.getContents();
    return new Uint8Array(0);
  }
  function refKey(ctx, o) { return o instanceof PDFRef ? o.toString() : null; }

  // ---------- 콘텐츠 스트림 토크나이저 ----------
  const WS = new Uint8Array(256); [0, 9, 10, 12, 13, 32].forEach(c => WS[c] = 1);
  const DELIM = new Uint8Array(256); '()<>[]{}/%'.split('').forEach(c => DELIM[c.charCodeAt(0)] = 1);
  const NUM_RE = /^[+-]?(\d+\.?\d*|\.\d+)$/;

  // onOp(op, operands, segStart, segEnd): segStart~segEnd 는 피연산자+연산자 바이트 범위
  function parseContent(b, onOp) {
    let i = 0; const n = b.length;
    const stack = [];
    let ops = 0;
    let segStart = 0;

    function skipWS() {
      while (i < n) {
        const c = b[i];
        if (WS[c]) { i++; continue; }
        if (c === 37) { while (i < n && b[i] !== 10 && b[i] !== 13) i++; continue; }
        break;
      }
    }
    function readRegular() {
      const s = i;
      while (i < n && !WS[b[i]] && !DELIM[b[i]]) i++;
      let str = '';
      for (let k = s; k < i; k++) str += String.fromCharCode(b[k]);
      return str;
    }
    function readValue() {
      skipWS();
      if (i >= n) return undefined;
      const c = b[i];
      if (c === 40) { // ( string
        i++; let depth = 1;
        while (i < n && depth > 0) {
          const ch = b[i];
          if (ch === 92) { i += 2; continue; }
          if (ch === 40) depth++;
          else if (ch === 41) depth--;
          i++;
        }
        return { str: true };
      }
      if (c === 60) {
        if (b[i + 1] === 60) { // << dict
          i += 2; const d = {};
          for (;;) {
            skipWS();
            if (i >= n) break;
            if (b[i] === 62 && b[i + 1] === 62) { i += 2; break; }
            const k = readValue();
            if (k === undefined) break;
            const v = readValue();
            if (k && k.name) d[k.name] = v;
          }
          return { dict: d };
        }
        i++; while (i < n && b[i] !== 62) i++; i++;
        return { str: true };
      }
      if (c === 91) { // [ array
        i++; const arr = [];
        for (;;) {
          skipWS();
          if (i >= n) break;
          if (b[i] === 93) { i++; break; }
          const v = readValue();
          if (v === undefined) break;
          arr.push(v);
        }
        return arr;
      }
      if (c === 47) { i++; return { name: readRegular() }; }
      if (c === 41 || c === 62 || c === 93 || c === 123 || c === 125) { i++; return null; }
      const tok = readRegular();
      if (tok === '') { i++; return null; }
      if (NUM_RE.test(tok)) return parseFloat(tok);
      if (tok === 'true') return true;
      if (tok === 'false') return false;
      if (tok === 'null') return null;
      return { op: tok };
    }

    while (i < n) {
      skipWS();
      if (i >= n) break;
      const v = readValue();
      if (v === undefined) break;
      if (v && v.op) {
        const op = v.op;
        if (op === 'BI') {
          const d = {};
          for (;;) {
            skipWS();
            if (i >= n) break;
            const k = readValue();
            if (k && k.op === 'ID') break;
            if (k === undefined) break;
            const val = readValue();
            if (k && k.name) d[k.name] = val;
          }
          i++; // ID 뒤 공백 1개
          // EI 찾기
          while (i < n) {
            if (b[i] === 69 && b[i + 1] === 73 && (i === 0 || WS[b[i - 1]]) && (i + 2 >= n || WS[b[i + 2]])) { i += 2; break; }
            i++;
          }
          onOp('BI', [d], segStart, i);
        } else {
          onOp(op, stack.splice(0), segStart, i);
        }
        segStart = i;
        stack.length = 0;
        if (++ops > 3000000) break; // 안전장치
      } else {
        stack.push(v);
        if (stack.length > 64) stack.shift();
      }
    }
  }

  // ---------- 행렬 ----------
  function mul(m, n) { // m × n
    return [
      m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3],
      m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
      m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5]
    ];
  }
  function apply(m, x, y) { return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]; }
  function unitBox(m) {
    const p = [apply(m, 0, 0), apply(m, 1, 0), apply(m, 0, 1), apply(m, 1, 1)];
    const xs = p.map(q => q[0]), ys = p.map(q => q[1]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }

  // ---------- 색공간 분류 ----------
  const PROCESS = new Set(['Cyan', 'Magenta', 'Yellow', 'Black']);
  function classifyCS(ctx, csObj, resCS, depth) {
    depth = depth || 0;
    if (depth > 6 || csObj == null) return { cat: 'Other' };
    let o = csObj instanceof PDFRef ? ctx.lookup(csObj) : csObj;
    if (o instanceof PDFName) {
      const nm = nameStr(o);
      if (nm === 'DeviceRGB' || nm === 'RGB') return { cat: 'RGB' };
      if (nm === 'DeviceCMYK' || nm === 'CMYK') return { cat: 'CMYK' };
      if (nm === 'DeviceGray' || nm === 'G') return { cat: 'Gray' };
      if (nm === 'Pattern') return { cat: 'Pattern' };
      if (nm === 'Indexed' || nm === 'I') return { cat: 'Other' };
      if (resCS) {
        const r = resCS.lookup(o);
        if (r) return classifyCS(ctx, r, null, depth + 1);
      }
      return { cat: 'Other', name: nm };
    }
    if (o instanceof PDFArray) {
      const fam = nameStr(o.lookup(0));
      switch (fam) {
        case 'ICCBased': {
          const sd = streamDict(o.lookup(1));
          const nComp = sd ? num(sd.lookup(N('N')), 3) : 3;
          return { cat: nComp === 4 ? 'CMYK' : nComp === 1 ? 'Gray' : 'RGB', icc: true };
        }
        case 'CalRGB': return { cat: 'RGB' };
        case 'CalGray': return { cat: 'Gray' };
        case 'Lab': return { cat: 'Lab' };
        case 'Indexed': case 'I': {
          const base = classifyCS(ctx, o.get(1), resCS, depth + 1);
          return Object.assign({}, base, { indexed: true });
        }
        case 'Separation': {
          const nm = nameStr(o.lookup(1));
          if (nm === 'All' || nm === 'None') return { cat: 'Gray' };
          if (PROCESS.has(nm)) return { cat: 'CMYK' };
          return { cat: 'Spot', spots: [nm] };
        }
        case 'DeviceN': {
          const arr = o.lookup(1);
          const names = [];
          if (arr instanceof PDFArray) for (let k = 0; k < arr.size(); k++) names.push(nameStr(arr.lookup(k)));
          const spots = names.filter(x => x && !PROCESS.has(x) && x !== 'None' && x !== 'All');
          return spots.length ? { cat: 'Spot', spots } : { cat: 'CMYK' };
        }
        case 'Pattern': return { cat: 'Pattern' };
        default: return classifyCS(ctx, o.get(0), resCS, depth + 1);
      }
    }
    return { cat: 'Other' };
  }

  // ---------- 폰트 ----------
  function fontInfo(ctx, fontDict) {
    const d = fontDict instanceof PDFRef ? ctx.lookup(fontDict) : fontDict;
    if (!(d instanceof PDFDict)) return null;
    const subtype = nameStr(d.lookup(N('Subtype'))) || '?';
    let base = nameStr(d.lookup(N('BaseFont'))) || (subtype === 'Type3' ? '(Type3 글꼴)' : '(이름 없음)');
    let desc = d.lookup(N('FontDescriptor'));
    let descType = subtype;
    if (subtype === 'Type0') {
      const df = d.lookup(N('DescendantFonts'));
      const f0 = df instanceof PDFArray ? df.lookup(0) : null;
      if (f0 instanceof PDFDict) {
        desc = f0.lookup(N('FontDescriptor'));
        descType = nameStr(f0.lookup(N('Subtype'))) || subtype;
      }
    }
    let embedded = false;
    if (subtype === 'Type3') embedded = true;
    else if (desc instanceof PDFDict) {
      embedded = !!(desc.get(N('FontFile')) || desc.get(N('FontFile2')) || desc.get(N('FontFile3')));
    }
    const subset = /^[A-Z]{6}\+/.test(base);
    const clean = base.replace(/^[A-Z]{6}\+/, '');
    return { name: clean, rawName: base, type: subtype === 'Type0' ? 'Type0/' + descType : subtype, embedded, subset };
  }

  // ---------- 페이지 분석 ----------
  function boxOf(node, key) {
    const a = node.lookup(N(key));
    if (!(a instanceof PDFArray) || a.size() < 4) return null;
    const v = [0, 1, 2, 3].map(k => num(a.lookup(k), 0));
    return [Math.min(v[0], v[2]), Math.min(v[1], v[3]), Math.max(v[0], v[2]), Math.max(v[1], v[3])];
  }
  function inheritedBox(node, key) {
    let cur = node; let guard = 0;
    while (cur instanceof PDFDict && guard++ < 50) {
      const b = boxOf(cur, key);
      if (b) return b;
      cur = cur.lookup(N('Parent'));
    }
    return null;
  }
  function intersect(a, b) {
    return [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
  }

  function analyzePage(doc, page, idx) {
    const ctx = doc.context;
    const node = page.node;
    const media = inheritedBox(node, 'MediaBox') || [0, 0, 595.28, 841.89];
    const crop = intersect(inheritedBox(node, 'CropBox') || media, media);
    const trimRaw = boxOf(node, 'TrimBox');
    const bleedRaw = boxOf(node, 'BleedBox');
    let rotate = 0;
    try { rotate = ((page.getRotation().angle % 360) + 360) % 360; } catch (e) { }

    const P = {
      index: idx, rotate,
      mediaBox: media, cropBox: crop,
      trimBox: trimRaw ? intersect(trimRaw, crop) : null,
      bleedBox: bleedRaw ? intersect(bleedRaw, crop) : null,
      fonts: new Map(), images: [],
      colorUse: { RGB: 0, CMYK: 0, Gray: 0, Spot: 0, Lab: 0, Pattern: 0, Other: 0 },
      rgbVector: 0, rgbBlackText: 0, spots: new Set(),
      transparency: false, overprint: false,
      // 중복인쇄 통계: white=흰색 개체 중복인쇄, black=K100 중복인쇄, blackKO=K100 녹아웃, color=일반 색 중복인쇄, spot[name]={op,ko}
      // outside = 재단선 밖(도련·여백·재단 표시 영역)에 있어 검사에서 제외한 중복인쇄 개체 수
      ov: { white: 0, black: 0, blackText: 0, blackKO: 0, blackTextKO: 0, color: 0, spot: {}, outside: 0 },
      hairline: { count: 0, zero: 0, minPt: Infinity, rects: [] },
      annots: [], usesOC: false, parseError: null,
    };

    P._trimOP = PC.effectiveTrim(crop, P.trimBox).box;

    let resources = null;
    try { resources = node.Resources(); } catch (e) { }
    if (!resources) {
      let cur = node; let g = 0;
      while (cur instanceof PDFDict && g++ < 50) {
        const r = cur.lookup(N('Resources'));
        if (r instanceof PDFDict) { resources = r; break; }
        cur = cur.lookup(N('Parent'));
      }
    }

    // 콘텐츠 바이트
    let contents = [];
    try {
      const c = node.lookup(N('Contents'));
      if (c instanceof PDFArray) {
        for (let k = 0; k < c.size(); k++) contents.push(streamBytes(c.lookup(k)));
      } else if (c) contents.push(streamBytes(c));
    } catch (e) { P.parseError = '콘텐츠 해석 실패: ' + e.message; }

    let total = 0; contents.forEach(x => total += x.length + 1);
    const all = new Uint8Array(total); let off = 0;
    contents.forEach(x => { all.set(x, off); off += x.length; all[off++] = 10; });

    const visited = new Set();
    try { runContent(ctx, all, resources, [1, 0, 0, 1, 0, 0], P, 0, visited); }
    catch (e) { P.parseError = '콘텐츠 해석 중 오류: ' + e.message; }

    // 주석
    try {
      const annots = node.lookup(N('Annots'));
      if (annots instanceof PDFArray) {
        for (let k = 0; k < annots.size(); k++) {
          const a = annots.lookup(k);
          if (!(a instanceof PDFDict)) continue;
          const st = nameStr(a.lookup(N('Subtype'))) || '?';
          if (st === 'Popup') continue;
          const f = num(a.lookup(N('F')), 0);
          const r = a.lookup(N('Rect'));
          let rect = null;
          if (r instanceof PDFArray && r.size() >= 4) {
            const v = [0, 1, 2, 3].map(q => num(r.lookup(q), 0));
            rect = [Math.min(v[0], v[2]), Math.min(v[1], v[3]), Math.max(v[0], v[2]), Math.max(v[1], v[3])];
          }
          P.annots.push({ subtype: st, print: !!(f & 4), hidden: !!(f & 2), rect });
        }
      }
    } catch (e) { }

    delete P._trimOP;
    P.fonts = Array.from(P.fonts.values());
    P.spots = Array.from(P.spots);
    if (!isFinite(P.hairline.minPt)) P.hairline.minPt = null;
    if (P.hairline.rects.length > 40) P.hairline.rects.length = 40;
    return P;
  }

  function runContent(ctx, bytes, resources, baseCTM, P, depth, visited) {
    if (depth > 12) return;
    const res = resources instanceof PDFDict ? resources : null;
    const resFont = res ? res.lookup(N('Font')) : null;
    const resXO = res ? res.lookup(N('XObject')) : null;
    const resCS = res ? res.lookup(N('ColorSpace')) : null;
    const resGS = res ? res.lookup(N('ExtGState')) : null;
    const resSh = res ? res.lookup(N('Shading')) : null;
    const asDict = (x) => (x instanceof PDFDict ? x : null);
    const fontRes = asDict(resFont), xoRes = asDict(resXO), csRes = asDict(resCS), gsRes = asDict(resGS), shRes = asDict(resSh);

    let gs = Object.assign({ ctm: baseCTM.slice(), lw: 1, fill: { cat: 'Gray', vals: [0] }, stroke: { cat: 'Gray', vals: [0] }, tr: 0, font: null, opF: false, opS: false, opm: 0 }, P._inheritGS || {}, { ctm: baseCTM.slice() });
    const stack = [];
    const csCache = new Map();
    const getCS = (nm) => {
      if (csCache.has(nm)) return csCache.get(nm);
      const r = classifyCS(ctx, N(nm), csRes);
      csCache.set(nm, r); return r;
    };
    const fontCache = new Map();

    function use(c) {
      P.colorUse[c.cat] = (P.colorUse[c.cat] || 0) + 1;
      if (c.spots) c.spots.forEach(s => P.spots.add(s));
    }
    function colorClass(c) {
      const v = c.vals || [];
      const z = (x) => x < 0.005, o = (x) => x > 0.995;
      if (c.cat === 'CMYK') {
        if (v.length < 4) return 'black';
        if (v.every(z)) return 'white';
        if (z(v[0]) && z(v[1]) && z(v[2]) && o(v[3])) return 'black';
        return 'process';
      }
      if (c.cat === 'Gray') { const g = v.length ? v[0] : 0; return o(g) ? 'white' : z(g) ? 'black' : 'process'; }
      if (c.cat === 'Spot') return v.length && v.every(z) ? 'white' : 'spot';
      return 'other';
    }
    // 현재 경로 / 글자 위치 (페이지 좌표 bbox)
    let pb = null;
    const addPt = (x, y) => {
      if (typeof x !== 'number' || typeof y !== 'number') return;
      const p = apply(gs.ctm, x, y);
      if (!pb) pb = [p[0], p[1], p[0], p[1]];
      else { if (p[0] < pb[0]) pb[0] = p[0]; if (p[1] < pb[1]) pb[1] = p[1]; if (p[0] > pb[2]) pb[2] = p[0]; if (p[1] > pb[3]) pb[3] = p[1]; }
    };
    let tm = [1, 0, 0, 1, 0, 0], tlm = [1, 0, 0, 1, 0, 0];
    const textBox = () => {
      const m = mul(tm, gs.ctm), fs = gs.fs || 10;
      const q = [apply(m, 0, -0.2 * fs), apply(m, fs, -0.2 * fs), apply(m, 0, fs), apply(m, fs, fs)];
      const xs = q.map(v => v[0]), ys = q.map(v => v[1]);
      return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    };
    const T = P._trimOP;
    const insideTrim = (b) => !b || !T || (b[2] > T[0] + 0.5 && b[0] < T[2] - 0.5 && b[3] > T[1] + 0.5 && b[1] < T[3] - 0.5);

    function recordOP(c, opOn, isText, box) {
      const cls = colorClass(c), ov = P.ov;
      if (!insideTrim(box)) { if (opOn) ov.outside++; return; } // 재단선 밖 개체는 검사 제외
      if (opOn) P.overprint = true;
      if (cls === 'white') { if (opOn) ov.white++; }
      else if (cls === 'black') {
        if (opOn) { ov.black++; if (isText) ov.blackText++; }
        else { ov.blackKO++; if (isText) ov.blackTextKO++; }
      } else if (cls === 'process') { if (opOn) ov.color++; }
      if (c.cat === 'Spot' && c.spots) c.spots.forEach(s => {
        const e = ov.spot[s] || (ov.spot[s] = { op: 0, ko: 0 });
        if (opOn) e.op++; else e.ko++;
      });
    }
    function paintFill() { use(gs.fill); recordOP(gs.fill, gs.opF, false, pb); if (gs.fill.cat === 'RGB') P.rgbVector++; }
    function paintStroke() {
      use(gs.stroke); recordOP(gs.stroke, gs.opS, false, pb); if (gs.stroke.cat === 'RGB') P.rgbVector++;
      const m = gs.ctm; const sc = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
      const w = gs.lw * sc;
      if (gs.lw === 0) { P.hairline.zero++; }
      else if (w < 0.25) { P.hairline.count++; }
      if (gs.lw === 0 || w < 0.25) {
        P.hairline.minPt = Math.min(P.hairline.minPt, w);
      }
    }
    function setColor(target, cs, vals) {
      gs[target] = { cat: cs.cat, spots: cs.spots, vals: vals.filter(v => typeof v === 'number') };
    }
    function textShow() {
      const tr = gs.tr;
      if (tr === 3 || tr === 7) return;
      if (gs.font) {
        const key = gs.font;
        if (!fontCache.has(key)) {
          let fi = null;
          try { fi = fontRes ? fontInfo(ctx, fontRes.get(N(key))) : null; } catch (e) { }
          fontCache.set(key, fi);
        }
        const fi = fontCache.get(key);
        if (fi) {
          const k = fi.rawName + '|' + fi.embedded;
          if (!P.fonts.has(k)) P.fonts.set(k, fi);
        }
      }
      const tb = textBox();
      if (tr === 1 || tr === 2 || tr === 5 || tr === 6) recordOP(gs.stroke, gs.opS, true, tb);
      if (tr === 0 || tr === 2 || tr === 4 || tr === 6) {
        use(gs.fill);
        recordOP(gs.fill, gs.opF, true, tb);
        if (gs.fill.cat === 'RGB') {
          P.rgbVector++;
          const v = gs.fill.vals;
          if (v.length === 3 && v.every(x => x < 0.05)) P.rgbBlackText++;
        }
      }
      if (tr === 1 || tr === 2 || tr === 5 || tr === 6) use(gs.stroke);
    }
    function placeImage(info) {
      const m = gs.ctm;
      const wPt = Math.hypot(m[0], m[1]);
      const hPt = Math.hypot(m[2], m[3]);
      const dpiX = wPt > 0 ? info.w / (wPt / 72) : 0;
      const dpiY = hPt > 0 ? info.h / (hPt / 72) : 0;
      if (P.images.length < 500) {
        P.images.push(Object.assign(info, {
          dpiX, dpiY, dpi: Math.min(dpiX, dpiY),
          wMM: wPt * PT2MM, hMM: hPt * PT2MM, rect: unitBox(m)
        }));
      }
      // 이미지 색상은 '이미지 색상 모드' 항목에서 따로 판정 (글자·도형 색상 집계에는 넣지 않음)
      if (!info.mask && info.csInfo.spots) info.csInfo.spots.forEach(s => P.spots.add(s));
    }

    parseContent(bytes, (op, a) => {
      switch (op) {
        case 'q': stack.push(Object.assign({}, gs, { ctm: gs.ctm.slice() })); if (stack.length > 256) stack.shift(); break;
        case 'Q': if (stack.length) gs = stack.pop(); break;
        case 'cm': if (a.length >= 6 && a.slice(-6).every(x => typeof x === 'number')) gs.ctm = mul(a.slice(-6), gs.ctm); break;
        case 'w': if (typeof a[0] === 'number') gs.lw = a[0]; break;
        case 'Tr': if (typeof a[0] === 'number') gs.tr = a[0]; break;
        case 'Tf': if (a[0] && a[0].name) gs.font = a[0].name; if (typeof a[1] === 'number') gs.fs = a[1]; break;
        // 경로 위치
        case 'm': case 'l': addPt(a[0], a[1]); break;
        case 'c': addPt(a[0], a[1]); addPt(a[2], a[3]); addPt(a[4], a[5]); break;
        case 'v': case 'y': addPt(a[0], a[1]); addPt(a[2], a[3]); break;
        case 're': if (a.length >= 4) { addPt(a[0], a[1]); addPt(a[0] + a[2], a[1] + a[3]); addPt(a[0] + a[2], a[1]); addPt(a[0], a[1] + a[3]); } break;
        case 'n': pb = null; break;
        // 글자 위치
        case 'BT': tm = [1, 0, 0, 1, 0, 0]; tlm = tm.slice(); break;
        case 'Tm': if (a.length >= 6 && a.slice(-6).every(x => typeof x === 'number')) { tlm = a.slice(-6); tm = tlm.slice(); } break;
        case 'Td': case 'TD':
          if (typeof a[0] === 'number' && typeof a[1] === 'number') {
            if (op === 'TD') gs.tl = -a[1];
            tlm = mul([1, 0, 0, 1, a[0], a[1]], tlm); tm = tlm.slice();
          }
          break;
        case 'TL': if (typeof a[0] === 'number') gs.tl = a[0]; break;
        case 'T*': tlm = mul([1, 0, 0, 1, 0, -(gs.tl || 0)], tlm); tm = tlm.slice(); break;
        case 'rg': setColor('fill', { cat: 'RGB' }, a); break;
        case 'RG': setColor('stroke', { cat: 'RGB' }, a); break;
        case 'k': setColor('fill', { cat: 'CMYK' }, a); break;
        case 'K': setColor('stroke', { cat: 'CMYK' }, a); break;
        case 'g': setColor('fill', { cat: 'Gray' }, a); break;
        case 'G': setColor('stroke', { cat: 'Gray' }, a); break;
        case 'cs': if (a[0] && a[0].name) gs.fill = Object.assign({ vals: [] }, getCS(a[0].name)); break;
        case 'CS': if (a[0] && a[0].name) gs.stroke = Object.assign({ vals: [] }, getCS(a[0].name)); break;
        case 'sc': case 'scn': gs.fill = Object.assign({}, gs.fill, { vals: a.filter(v => typeof v === 'number') }); break;
        case 'SC': case 'SCN': gs.stroke = Object.assign({}, gs.stroke, { vals: a.filter(v => typeof v === 'number') }); break;
        case 'f': case 'F': case 'f*': paintFill(); pb = null; break;
        case 'S': case 's': paintStroke(); pb = null; break;
        case 'B': case 'B*': case 'b': case 'b*': paintFill(); paintStroke(); pb = null; break;
        case "'": case '"': tlm = mul([1, 0, 0, 1, 0, -(gs.tl || 0)], tlm); tm = tlm.slice(); textShow(); break;
        case 'Tj': case 'TJ': textShow(); break;
        case 'BDC': if (a[0] && a[0].name === 'OC') P.usesOC = true; break;
        case 'gs': {
          if (!a[0] || !a[0].name || !gsRes) break;
          const g = gsRes.lookup(N(a[0].name));
          if (g instanceof PDFDict) {
            const ca = num(g.lookup(N('ca')), 1), CA = num(g.lookup(N('CA')), 1);
            const sm = g.lookup(N('SMask'));
            const bm = nameStr(g.lookup(N('BM')));
            if (ca < 1 || CA < 1 || (sm && nameStr(sm) !== 'None') || (bm && bm !== 'Normal' && bm !== 'Compatible')) P.transparency = true;
            // OP: 선(및 op가 없으면 면) 중복인쇄, op: 면 중복인쇄, OPM: 0값 성분 처리 방식
            const op1 = g.lookup(N('OP')), op2 = g.lookup(N('op')), opm = g.lookup(N('OPM'));
            if (op1 instanceof PDFBool) { gs.opS = op1.asBoolean(); if (!(op2 instanceof PDFBool)) gs.opF = gs.opS; }
            if (op2 instanceof PDFBool) gs.opF = op2.asBoolean();
            if (opm instanceof PDFNumber) gs.opm = opm.asNumber();
            const lw = g.lookup(N('LW'));
            if (lw instanceof PDFNumber) gs.lw = lw.asNumber();
          }
          break;
        }
        case 'sh': {
          if (!a[0] || !a[0].name || !shRes) break;
          const s = shRes.lookup(N(a[0].name));
          const sd = streamDict(s);
          if (sd) use(classifyCS(ctx, sd.get(N('ColorSpace')), csRes));
          break;
        }
        case 'BI': {
          const d = a[0] || {};
          const w = d.W || d.Width, h = d.H || d.Height;
          const isMask = d.IM === true || d.ImageMask === true;
          const csv = d.CS || d.ColorSpace;
          let csInfo = { cat: 'Gray' };
          if (csv && csv.name) csInfo = classifyCS(ctx, N(csv.name), csRes);
          if (typeof w === 'number' && typeof h === 'number') {
            let fv = d.F || d.Filter;
            if (Array.isArray(fv)) fv = fv[fv.length - 1];
            const fr = fv && fv.name ? ({ Fl: 'FlateDecode', DCT: 'DCTDecode', CCF: 'CCITTFaxDecode', LZW: 'LZWDecode', RL: 'RunLengthDecode' }[fv.name] || fv.name) : '없음';
            placeImage({ w, h, bpc: d.BPC || d.BitsPerComponent || (isMask ? 1 : 8), mask: isMask, cs: isMask ? '마스크' : csLabel(csInfo), csInfo, filter: FILTER_LABEL[fr] || '인라인', filterRaw: fr, inline: true });
          }
          break;
        }
        case 'Do': {
          if (!a[0] || !a[0].name || !xoRes) break;
          const raw = xoRes.get(N(a[0].name));
          const xo = raw instanceof PDFRef ? ctx.lookup(raw) : raw;
          const sd = streamDict(xo);
          if (!sd) break;
          const st = nameStr(sd.lookup(N('Subtype')));
          if (st === 'Image') {
            const isMask = (() => { const v = sd.lookup(N('ImageMask')); return v instanceof PDFBool && v.asBoolean(); })();
            const csInfo = isMask ? { cat: 'Gray' } : classifyCS(ctx, sd.get(N('ColorSpace')), csRes);
            let filt = sd.lookup(N('Filter'));
            if (filt instanceof PDFArray) filt = filt.lookup(filt.size() - 1);
            const fname = nameStr(filt) || '없음';
            const jpx = fname === 'JPXDecode';
            const sm = sd.get(N('SMask'));
            if (sm) P.transparency = true;
            placeImage({
              w: num(sd.lookup(N('Width')), 0), h: num(sd.lookup(N('Height')), 0),
              bpc: num(sd.lookup(N('BitsPerComponent')), isMask ? 1 : 8),
              mask: isMask, cs: isMask ? '마스크' : (jpx && !sd.get(N('ColorSpace')) ? 'JPX(내장)' : csLabel(csInfo)),
              csInfo, filter: FILTER_LABEL[fname] || fname, filterRaw: fname, ref: refKey(ctx, raw),
              hasSMask: !!sm || !!sd.get(N('Mask')),
            });
          } else if (st === 'Form') {
            const key = refKey(ctx, raw);
            if (key && visited.has(key) && depth > 0) break;
            if (key) visited.add(key);
            const mArr = sd.lookup(N('Matrix'));
            let fm = [1, 0, 0, 1, 0, 0];
            if (mArr instanceof PDFArray && mArr.size() === 6) fm = [0, 1, 2, 3, 4, 5].map(k => num(mArr.lookup(k), 0));
            const grp = sd.lookup(N('Group'));
            if (grp instanceof PDFDict && nameStr(grp.lookup(N('S'))) === 'Transparency') P.transparency = true;
            if (sd.get(N('OC'))) P.usesOC = true;
            const fres = sd.lookup(N('Resources')) || resources;
            let fb = null;
            try { fb = streamBytes(xo); } catch (e) { }
            if (fb) {
              const prev = P._inheritGS;
              P._inheritGS = { lw: gs.lw, fill: gs.fill, stroke: gs.stroke, tr: gs.tr, font: null, opF: gs.opF, opS: gs.opS, opm: gs.opm };
              runContent(ctx, fb, fres, mul(fm, gs.ctm), P, depth + 1, visited);
              P._inheritGS = prev;
            }
            if (key) visited.delete(key);
          }
          break;
        }
      }
    });
  }

  const FILTER_LABEL = { DCTDecode: 'JPEG', JPXDecode: 'JPEG2000', FlateDecode: '무손실(Flate)', CCITTFaxDecode: '팩스(CCITT)', JBIG2Decode: 'JBIG2', RunLengthDecode: 'RLE', LZWDecode: 'LZW' };
  function csLabel(c) {
    const base = { RGB: 'RGB', CMYK: 'CMYK', Gray: '흑백(Gray)', Spot: '별색', Lab: 'Lab', Pattern: '패턴', Other: '기타' }[c.cat] || c.cat;
    return c.indexed ? base + '(인덱스)' : base;
  }

  // ---------- 문서 분석 ----------
  async function analyzeStructure(bytes, onProgress) {
    const head = new TextDecoder('latin1').decode(bytes.subarray(0, 1024));
    const vm = head.match(/%PDF-(\d\.\d)/);
    const encrypted = /\/Encrypt\s/.test(new TextDecoder('latin1').decode(bytes.subarray(Math.max(0, bytes.length - 4096))));
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false });
    const ctx = doc.context;
    const catalog = doc.catalog;
    const info = {
      version: vm ? vm[1] : '?',
      encrypted: doc.isEncrypted || encrypted,
      producer: safe(() => doc.getProducer()), creator: safe(() => doc.getCreator()), title: safe(() => doc.getTitle()),
      pdfx: null, outputIntent: null, ocgs: [], hasAcroForm: false,
    };
    try {
      const oi = catalog.lookup(N('OutputIntents'));
      if (oi instanceof PDFArray && oi.size()) {
        const o0 = oi.lookup(0);
        if (o0 instanceof PDFDict) {
          info.pdfx = nameStr(o0.lookup(N('S')));
          info.outputIntent = textOf(o0.lookup(N('OutputConditionIdentifier'))) || textOf(o0.lookup(N('Info')));
        }
      }
    } catch (e) { }
    try {
      const ocp = catalog.lookup(N('OCProperties'));
      if (ocp instanceof PDFDict) {
        const ocgs = ocp.lookup(N('OCGs'));
        if (ocgs instanceof PDFArray) for (let k = 0; k < ocgs.size(); k++) {
          const g = ocgs.lookup(k);
          if (g instanceof PDFDict) info.ocgs.push(textOf(g.lookup(N('Name'))) || '(이름 없음)');
        }
      }
    } catch (e) { }
    try {
      const af = catalog.lookup(N('AcroForm'));
      if (af instanceof PDFDict) { const f = af.lookup(N('Fields')); info.hasAcroForm = f instanceof PDFArray && f.size() > 0; }
    } catch (e) { }

    const pages = doc.getPages();
    const out = [];
    for (let k = 0; k < pages.length; k++) {
      let P;
      try { P = analyzePage(doc, pages[k], k); }
      catch (e) { P = { index: k, parseError: e.message, fonts: [], images: [], colorUse: {}, spots: [], annots: [], hairline: { count: 0, zero: 0 } }; }
      if (info.encrypted) P.parseError = P.parseError || '암호화 문서 — 내용 구조 검사 제한';
      out.push(P);
      if (onProgress && (k % 5 === 4)) { onProgress(k + 1, pages.length); await new Promise(r => setTimeout(r, 0)); }
    }
    return { info, pages: out, doc };
  }
  function safe(f) { try { return f() || ''; } catch (e) { return ''; } }

  window.PDFStructure = { analyzeStructure, PT2MM, parseContent, nameStr, streamBytes, streamDict };
})();
