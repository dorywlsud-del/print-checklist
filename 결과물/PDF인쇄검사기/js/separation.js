/* 분판 미리보기 엔진
 *
 * 원리: 선택한 페이지를 판(C/M/Y/K/별색)마다 하나씩 복제하고,
 *  - 각 개체가 칠해지기 직전에 "그 판의 잉크량"을 회색(1-잉크)으로 덮어써서 칠하게 하고
 *  - 이미지·그라데이션은 색공간을 "해당 성분만 뽑아내는 함수"로 바꿔치기한 뒤
 *  pdf.js 로 그려서 판별 잉크량(0~255)을 얻는다.
 * 중복인쇄(오버프린트)가 켜진 개체는 자기가 쓰지 않는 판을 덮지 않도록(녹아웃하지 않도록) 그리지 않는다.
 * 추가로 'opmask' 판은 중복인쇄 개체만 검게 그려서 중복인쇄 영역을 표시하는 데 쓴다.
 */
(function () {
  'use strict';
  const { PDFDocument, PDFName, PDFDict, PDFArray, PDFRawStream, PDFNumber, PDFRef, PDFString, PDFHexString, PDFBool } = PDFLib;
  const { parseContent, nameStr, streamBytes, streamDict } = PDFStructure;
  const N = (s) => PDFName.of(s);
  const PROCESS = ['Cyan', 'Magenta', 'Yellow', 'Black'];
  const PROCESS_KO = { Cyan: '사이안 (C)', Magenta: '마젠타 (M)', Yellow: '옐로 (Y)', Black: '블랙 (K)' };
  const PROCESS_RGB = { Cyan: [0, 174, 239], Magenta: [236, 0, 140], Yellow: [255, 242, 0], Black: [35, 31, 32] };

  const enc = (s) => { const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i) & 255; return u; };
  const r4 = (v) => (Math.round(Math.max(0, Math.min(1, v)) * 10000) / 10000).toString();

  // ---------------- 색공간 모델 ----------------
  function lookupBytes(o) {
    if (o instanceof PDFString) return enc(o.asString ? o.asString() : o.value);
    if (o instanceof PDFHexString) { const h = o.asString ? o.asString() : o.value; const u = new Uint8Array(h.length >> 1); for (let i = 0; i < u.length; i++) u[i] = parseInt(h.substr(i * 2, 2), 16); return u; }
    try { return streamBytes(o); } catch (e) { return new Uint8Array(0); }
  }
  function model(ctx, csObj, resCS, spotCS, depth) {
    depth = depth || 0;
    if (depth > 6 || csObj == null) return { type: 'gray', n: 1 };
    const o = csObj instanceof PDFRef ? ctx.lookup(csObj) : csObj;
    if (o instanceof PDFName) {
      const nm = nameStr(o);
      if (nm === 'DeviceCMYK' || nm === 'CMYK') return { type: 'cmyk', n: 4, device: true };
      if (nm === 'DeviceRGB' || nm === 'RGB') return { type: 'rgb', n: 3 };
      if (nm === 'DeviceGray' || nm === 'G') return { type: 'gray', n: 1 };
      if (nm === 'Pattern') return { type: 'pattern', n: 0 };
      if (resCS instanceof PDFDict) { const r = resCS.get(o); if (r) return model(ctx, r, null, spotCS, depth + 1); }
      return { type: 'gray', n: 1 };
    }
    if (o instanceof PDFArray) {
      const fam = nameStr(o.lookup(0));
      switch (fam) {
        case 'ICCBased': {
          const sd = streamDict(o.lookup(1)); const nn = sd ? sd.lookup(N('N')) : null;
          const n = nn instanceof PDFNumber ? nn.asNumber() : 3;
          return n === 4 ? { type: 'cmyk', n: 4 } : n === 1 ? { type: 'gray', n: 1 } : { type: 'rgb', n: 3 };
        }
        case 'CalRGB': return { type: 'rgb', n: 3 };
        case 'CalGray': return { type: 'gray', n: 1 };
        case 'CalCMYK': return { type: 'cmyk', n: 4 };
        case 'Lab': return { type: 'lab', n: 3 };
        case 'Indexed': case 'I': {
          const base = model(ctx, o.get(1), resCS, spotCS, depth + 1);
          const hv = o.lookup(2);
          return { type: 'indexed', n: 1, base, hival: hv instanceof PDFNumber ? hv.asNumber() : 255, lookupRaw: o.get(3), lookup: lookupBytes(o.lookup(3)) };
        }
        case 'Separation': {
          const nm = nameStr(o.lookup(1));
          if (spotCS && nm && !PROCESS.includes(nm) && nm !== 'All' && nm !== 'None' && !spotCS[nm]) spotCS[nm] = { arr: o, n: 1, idx: 0 };
          return { type: 'sep', n: 1, names: [nm] };
        }
        case 'DeviceN': {
          const a = o.lookup(1); const names = [];
          if (a instanceof PDFArray) for (let k = 0; k < a.size(); k++) names.push(nameStr(a.lookup(k)));
          if (spotCS) names.forEach((nm, k) => { if (nm && !PROCESS.includes(nm) && nm !== 'None' && nm !== 'All' && !spotCS[nm]) spotCS[nm] = { arr: o, n: names.length, idx: k }; });
          return { type: 'devn', n: names.length, names };
        }
        case 'Pattern': return { type: 'pattern', n: 0 };
        default: return model(ctx, o.get(0), resCS, spotCS, depth + 1);
      }
    }
    return { type: 'gray', n: 1 };
  }

  function rgb2cmyk(r, g, b) {
    const k = 1 - Math.max(r, g, b);
    if (k >= 0.9999) return [0, 0, 0, 1];
    return [(1 - r - k) / (1 - k), (1 - g - k) / (1 - k), (1 - b - k) / (1 - k), k];
  }
  // 색 값 → 해당 판 잉크량(0~1)
  function inkOf(m, vals, plate) {
    const v = vals || [];
    switch (m.type) {
      case 'cmyk': { const d = v.length >= 4 ? v : [0, 0, 0, 1]; const j = PROCESS.indexOf(plate); return j < 0 ? 0 : d[j]; }
      case 'gray': return plate === 'Black' ? 1 - (v.length ? v[0] : 0) : 0;
      case 'rgb': { const d = v.length >= 3 ? v : [0, 0, 0]; const c = rgb2cmyk(d[0], d[1], d[2]); const j = PROCESS.indexOf(plate); return j < 0 ? 0 : c[j]; }
      case 'lab': return plate === 'Black' ? 1 - (v.length ? v[0] : 0) / 100 : 0;
      case 'sep': { const t = v.length ? v[0] : 1; const nm = m.names[0]; return nm === 'All' || nm === plate ? t : 0; }
      case 'devn': { const j = m.names.indexOf(plate); if (j >= 0) return v.length > j ? v[j] : 1; return m.names.includes('All') ? (v[0] || 0) : 0; }
      case 'indexed': {
        const idx = Math.max(0, Math.min(m.hival, Math.round(v.length ? v[0] : 0)));
        const n = m.base.n, bv = [];
        for (let k = 0; k < n; k++) bv.push((m.lookup[idx * n + k] || 0) / 255);
        if (m.base.type === 'lab') bv[0] *= 100;
        return inkOf(m.base, bv, plate);
      }
    }
    return 0;
  }
  // 중복인쇄일 때 이 개체가 해당 판을 칠하는가?
  function paintsPlate(m, vals, plate, opm) {
    const t = m.type === 'indexed' ? m.base.type : m.type;
    if (t === 'cmyk') {
      if (!PROCESS.includes(plate)) return false;
      return m.device && opm === 1 ? inkOf(m, vals, plate) > 0 : true;
    }
    if (t === 'sep' || t === 'devn') {
      const names = (m.type === 'indexed' ? m.base : m).names || [];
      return names.includes(plate) || names.includes('All');
    }
    return true; // RGB/Gray/Lab 는 중복인쇄가 사실상 적용되지 않음
  }
  function opCapable(m) { const t = m.type === 'indexed' ? m.base.type : m.type; return t === 'cmyk' || t === 'sep' || t === 'devn'; }

  // 판(plate) 하나에 대한 칠하기 결정: 회색값(문자열) 또는 null(칠하지 않음)
  function decide(col, opOn, opm, plate) {
    if (plate === '__opmask') return opOn && opCapable(col.m) ? '0' : '1';
    if (opOn && opCapable(col.m) && !paintsPlate(col.m, col.vals, plate, opm)) return null;
    return r4(1 - inkOf(col.m, col.vals, plate));
  }

  // ---------------- 함수/색공간 생성 ----------------
  class Builder {
    constructor(ctx, plate) { this.ctx = ctx; this.plate = plate; this.fnCache = new Map(); }
    psFn(n, body) {
      const key = n + '|' + body;
      if (this.fnCache.has(key)) return this.fnCache.get(key);
      const dom = []; for (let k = 0; k < n; k++) dom.push(0, 1);
      const ref = this.ctx.register(this.ctx.stream(`{ ${body} }`, { FunctionType: 4, Domain: dom, Range: [0, 1] }));
      this.fnCache.set(key, ref); return ref;
    }
    constFn(n) { return this.psFn(n, 'pop '.repeat(n) + '1'); }
    selectFn(n, j) { return j < 0 ? this.constFn(n) : this.psFn(n, `${n - 1 - j} index 1 exch sub ${n + 1} 1 roll ${'pop '.repeat(n)}`); }
    rgbFn() {
      const key = 'rgb';
      if (this.fnCache.has(key)) return this.fnCache.get(key);
      const S = 9, data = new Uint8Array(S * S * S);
      let p = 0;
      for (let b = 0; b < S; b++) for (let g = 0; g < S; g++) for (let r = 0; r < S; r++) {
        data[p++] = Math.round((1 - inkOf({ type: 'rgb' }, [r / (S - 1), g / (S - 1), b / (S - 1)], this.plate)) * 255);
      }
      const ref = this.ctx.register(this.ctx.stream(data, { FunctionType: 0, Domain: [0, 1, 0, 1, 0, 1], Range: [0, 1], Size: [S, S, S], BitsPerSample: 8 }));
      this.fnCache.set(key, ref); return ref;
    }
    // 원래 색공간 모델 → 이 판의 잉크를 회색으로 내보내는 새 색공간
    cs(m) {
      const pl = this.plate, ctx = this.ctx;
      let fn;
      if (pl === '__opmask') { if (m.type === 'indexed' || !m.n) return null; fn = this.constFn(m.n); }
      else switch (m.type) {
        case 'cmyk': fn = this.selectFn(4, PROCESS.indexOf(pl)); break;
        case 'gray': fn = pl === 'Black' ? this.psFn(1, '0 add') : this.constFn(1); break;
        case 'rgb': fn = PROCESS.includes(pl) ? this.rgbFn() : this.constFn(3); break;
        case 'lab': fn = pl === 'Black' ? this.psFn(3, 'pop pop') : this.constFn(3); break;
        case 'sep': fn = (m.names[0] === pl || m.names[0] === 'All') ? this.selectFn(1, 0) : this.constFn(1); break;
        case 'devn': { let j = m.names.indexOf(pl); if (j < 0 && m.names.includes('All')) j = m.names.indexOf('All'); fn = this.selectFn(m.n, j); break; }
        case 'indexed': {
          const base = this.cs(m.base);
          if (!base) return null;
          return ctx.obj([N('Indexed'), base, m.hival, m.lookupRaw]);
        }
        default: return null;
      }
      if (m.n === 1) return ctx.obj([N('Separation'), N('Plate'), N('DeviceGray'), fn]);
      const names = []; for (let k = 0; k < m.n; k++) names.push(N('P' + k));
      return ctx.obj([N('DeviceN'), ctx.obj(names), N('DeviceGray'), fn]);
    }
  }

  function cloneDict(ctx, d, skip) {
    const out = ctx.obj({});
    if (d instanceof PDFDict) for (const [k, v] of d.entries()) { if (!skip || !skip.includes(nameStr(k))) out.set(k, v); }
    return out;
  }
  const refKey = (o) => (o instanceof PDFRef ? o.toString() : null);

  // ---------------- 콘텐츠 재작성 ----------------
  class Rewriter {
    constructor(doc, plate, spotCS) {
      this.doc = doc; this.ctx = doc.context; this.plate = plate; this.spotCS = spotCS;
      this.B = new Builder(this.ctx, plate);
      this.imgCache = new Map(); this.shCache = new Map(); this.patCache = new Map(); this.formCache = new Map();
      this.formSeq = 0;
    }
    rewriteImage(raw) {
      const key = refKey(raw);
      if (key && this.imgCache.has(key)) return this.imgCache.get(key);
      let res = raw;
      const s = raw instanceof PDFRef ? this.ctx.lookup(raw) : raw;
      const sd = streamDict(s);
      const im = sd && sd.lookup(N('ImageMask'));
      if (sd && s instanceof PDFRawStream && !(im instanceof PDFBool && im.asBoolean()) && sd.get(N('ColorSpace'))) {
        const m = model(this.ctx, sd.get(N('ColorSpace')), null, this.spotCS);
        const ncs = this.B.cs(m);
        if (ncs) {
          const nd = cloneDict(this.ctx, sd, m.type === 'lab' ? ['Decode'] : null);
          nd.set(N('ColorSpace'), ncs);
          res = this.ctx.register(PDFRawStream.of(nd, s.contents));
        }
      }
      if (key) this.imgCache.set(key, res);
      return res;
    }
    rewriteShading(raw, resCS) {
      const key = refKey(raw);
      if (key && this.shCache.has(key)) return this.shCache.get(key);
      let res = raw;
      const s = raw instanceof PDFRef ? this.ctx.lookup(raw) : raw;
      const sd = streamDict(s);
      if (sd && sd.get(N('ColorSpace'))) {
        const m = model(this.ctx, sd.get(N('ColorSpace')), resCS, this.spotCS);
        const ncs = this.B.cs(m);
        if (ncs) {
          const nd = cloneDict(this.ctx, sd, ['Background']);
          nd.set(N('ColorSpace'), ncs);
          res = this.ctx.register(s instanceof PDFRawStream ? PDFRawStream.of(nd, s.contents) : nd);
        }
      }
      if (key) this.shCache.set(key, res);
      return res;
    }
    rewritePattern(raw, resCS) {
      const key = refKey(raw);
      if (key && this.patCache.has(key)) return this.patCache.get(key);
      let res = raw;
      const s = raw instanceof PDFRef ? this.ctx.lookup(raw) : raw;
      const sd = streamDict(s);
      if (sd) {
        const pt = sd.lookup(N('PatternType'));
        if (pt instanceof PDFNumber && pt.asNumber() === 2) {
          const nd = cloneDict(this.ctx, sd);
          const sh = sd.get(N('Shading'));
          if (sh) nd.set(N('Shading'), this.rewriteShading(sh, resCS));
          res = this.ctx.register(nd);
        } else if (s instanceof PDFRawStream) {
          let bytes = null; try { bytes = streamBytes(s); } catch (e) { }
          if (bytes) {
            const out = this.rewriteContent(bytes, sd.lookup(N('Resources')), null, 0);
            res = this.ctx.register(this.makeStream(out.bytes, sd, out.res));
          }
        }
      }
      if (key) this.patCache.set(key, res);
      return res;
    }
    makeStream(bytes, srcDict, newRes) {
      const st = this.ctx.flateStream(bytes);
      for (const [k, v] of srcDict.entries()) {
        const kn = nameStr(k);
        if (kn === 'Filter' || kn === 'DecodeParms' || kn === 'Length' || kn === 'Resources') continue;
        st.dict.set(k, v);
      }
      if (newRes) st.dict.set(N('Resources'), newRes);
      return st;
    }
    newResources(srcRes) {
      const ctx = this.ctx;
      const res = srcRes instanceof PDFDict ? cloneDict(ctx, srcRes) : ctx.obj({});
      const resCS = srcRes instanceof PDFDict ? srcRes.lookup(N('ColorSpace')) : null;
      const xo = srcRes instanceof PDFDict ? srcRes.lookup(N('XObject')) : null;
      res.set(N('XObject'), xo instanceof PDFDict ? cloneDict(ctx, xo) : ctx.obj({}));
      const sh = srcRes instanceof PDFDict ? srcRes.lookup(N('Shading')) : null;
      if (sh instanceof PDFDict) {
        const n = ctx.obj({});
        for (const [k, v] of sh.entries()) n.set(k, this.rewriteShading(v, resCS));
        res.set(N('Shading'), n);
      }
      const pat = srcRes instanceof PDFDict ? srcRes.lookup(N('Pattern')) : null;
      if (pat instanceof PDFDict) {
        const n = ctx.obj({});
        for (const [k, v] of pat.entries()) n.set(k, this.rewritePattern(v, resCS));
        res.set(N('Pattern'), n);
      }
      return res;
    }

    // inherit: 상위에서 물려받은 그래픽 상태 (폼 XObject 용)
    rewriteContent(bytes, srcRes, inherit, depth) {
      const ctx = this.ctx, plate = this.plate;
      const res = this.newResources(srcRes);
      const resCS = srcRes instanceof PDFDict ? srcRes.lookup(N('ColorSpace')) : null;
      const resGS = srcRes instanceof PDFDict ? srcRes.lookup(N('ExtGState')) : null;
      const resXO = srcRes instanceof PDFDict ? srcRes.lookup(N('XObject')) : null;
      const newXO = res.lookup(N('XObject'));
      const defCol = () => ({ m: { type: 'gray', n: 1 }, vals: [0], csText: null, colText: enc('0 g') });
      const gs = inherit ? Object.assign({}, inherit.state) : { fill: defCol(), stroke: Object.assign(defCol(), { colText: enc('0 G') }), opF: false, opS: false, opm: 0, tr: 0 };
      if (inherit) {
        // 물려받은 이름 있는 색공간을 새 리소스에 복사 (복원 명령이 유효하도록)
        (inherit.csNames || []).forEach(([nm, obj]) => {
          let cs = res.lookup(N('ColorSpace'));
          if (!(cs instanceof PDFDict)) { cs = ctx.obj({}); res.set(N('ColorSpace'), cs); }
          else if (!cs.get(N(nm))) { const c2 = cloneDict(ctx, cs); res.set(N('ColorSpace'), c2); cs = c2; }
          if (!cs.get(N(nm))) cs.set(N(nm), obj);
        });
      }
      const stack = [];
      const out = [];
      const csNameObj = {}; // 이 콘텐츠에서 쓰인 이름 → 색공간 객체
      const self = this;
      const W = (s) => out.push(enc(s));

      const restore = (c, stroke) => {
        if (c.csText) out.push(enc(' '), c.csText);
        if (c.colText) out.push(enc(' '), c.colText);
        else if (!c.csText) W(stroke ? ' 0 G' : ' 0 g');
        W('\n');
      };
      const act = (c, opOn) => (c.m.type === 'pattern' ? 'orig' : decide(c, opOn, gs.opm, plate));

      parseContent(bytes, (op, a, s, e) => {
        const seg = bytes.subarray(s, e);
        const segPlain = () => out.push(seg);
        switch (op) {
          case 'q': stack.push({ fill: gs.fill, stroke: gs.stroke, opF: gs.opF, opS: gs.opS, opm: gs.opm, tr: gs.tr }); segPlain(); break;
          case 'Q': if (stack.length) Object.assign(gs, stack.pop()); segPlain(); break;
          case 'cs': case 'CS': {
            const nm = a[0] && a[0].name;
            const m = nm ? model(ctx, N(nm), resCS, self.spotCS) : { type: 'gray', n: 1 };
            if (nm && resCS instanceof PDFDict && resCS.get(N(nm))) csNameObj[nm] = resCS.get(N(nm));
            const c = { m, vals: [], csText: seg, colText: null, csName: nm };
            if (op === 'cs') gs.fill = c; else gs.stroke = c;
            segPlain(); break;
          }
          case 'sc': case 'scn': case 'SC': case 'SCN': {
            const t = op === 'sc' || op === 'scn' ? 'fill' : 'stroke';
            gs[t] = Object.assign({}, gs[t], { vals: a.filter(x => typeof x === 'number'), colText: seg });
            segPlain(); break;
          }
          case 'k': case 'K': case 'rg': case 'RG': case 'g': case 'G': {
            const t = op === op.toLowerCase() ? 'fill' : 'stroke';
            const m = op.toLowerCase() === 'k' ? { type: 'cmyk', n: 4, device: true } : op.toLowerCase() === 'rg' ? { type: 'rgb', n: 3 } : { type: 'gray', n: 1 };
            gs[t] = { m, vals: a.filter(x => typeof x === 'number'), csText: null, colText: seg };
            segPlain(); break;
          }
          case 'gs': {
            const g = a[0] && a[0].name && resGS instanceof PDFDict ? resGS.lookup(N(a[0].name)) : null;
            if (g instanceof PDFDict) {
              const o1 = g.lookup(N('OP')), o2 = g.lookup(N('op')), om = g.lookup(N('OPM'));
              if (o1 instanceof PDFBool) { gs.opS = o1.asBoolean(); if (!(o2 instanceof PDFBool)) gs.opF = gs.opS; }
              if (o2 instanceof PDFBool) gs.opF = o2.asBoolean();
              if (om instanceof PDFNumber) gs.opm = om.asNumber();
            }
            segPlain(); break;
          }
          case 'Tr': if (typeof a[0] === 'number') gs.tr = a[0]; segPlain(); break;
          case 'f': case 'F': case 'f*': {
            const x = act(gs.fill, gs.opF);
            if (x === 'orig') segPlain();
            else if (x === null) W(' n\n');
            else { W(` ${x} g\n`); segPlain(); restore(gs.fill, false); }
            break;
          }
          case 'S': case 's': {
            const x = act(gs.stroke, gs.opS);
            if (x === 'orig') segPlain();
            else if (x === null) W(op === 's' ? ' h n\n' : ' n\n');
            else { W(` ${x} G\n`); segPlain(); restore(gs.stroke, true); }
            break;
          }
          case 'B': case 'B*': case 'b': case 'b*': {
            const xf = act(gs.fill, gs.opF), xs = act(gs.stroke, gs.opS);
            const f = xf !== null, st = xs !== null;
            const map = { B: ['B', 'f', 'S'], 'B*': ['B*', 'f*', 'S'], b: ['b', 'h f', 's'], 'b*': ['b*', 'h f*', 's'] }[op];
            const nop = f && st ? map[0] : f ? map[1] : st ? map[2] : 'n';
            if (f && xf !== 'orig') W(` ${xf} g`);
            if (st && xs !== 'orig') W(` ${xs} G`);
            W(` ${nop}\n`);
            if (f && xf !== 'orig') restore(gs.fill, false);
            if (st && xs !== 'orig') restore(gs.stroke, true);
            break;
          }
          case 'Tj': case 'TJ': case "'": case '"': {
            const tr = gs.tr;
            const usesF = [0, 2, 4, 6].includes(tr), usesS = [1, 2, 5, 6].includes(tr);
            const xf = usesF ? act(gs.fill, gs.opF) : null, xs = usesS ? act(gs.stroke, gs.opS) : null;
            const f = xf !== null, st = xs !== null;
            const clip = tr >= 4;
            const ntr = f && st ? (clip ? 6 : 2) : f ? (clip ? 4 : 0) : st ? (clip ? 5 : 1) : (clip ? 7 : 3);
            if (tr === 3 || tr === 7) { segPlain(); break; }
            if (ntr !== tr) W(` ${ntr} Tr`);
            if (f && xf !== 'orig') W(` ${xf} g`);
            if (st && xs !== 'orig') W(` ${xs} G`);
            W(' '); segPlain();
            if (f && xf !== 'orig') restore(gs.fill, false);
            if (st && xs !== 'orig') restore(gs.stroke, true);
            if (ntr !== tr) W(` ${tr} Tr\n`);
            break;
          }
          case 'BI': if (plate === '__opmask') W(' '); else segPlain(); break;
          case 'Do': {
            const nm = a[0] && a[0].name;
            const raw = nm && resXO instanceof PDFDict ? resXO.get(N(nm)) : null;
            const xo = raw instanceof PDFRef ? ctx.lookup(raw) : raw;
            const sd = streamDict(xo);
            if (!sd) { segPlain(); break; }
            const st = nameStr(sd.lookup(N('Subtype')));
            if (st === 'Image') {
              const im = sd.lookup(N('ImageMask'));
              if (im instanceof PDFBool && im.asBoolean()) { // 스텐실 마스크: 칠 색을 사용
                const x = act(gs.fill, gs.opF);
                if (x === null) W(' ');
                else if (x === 'orig') segPlain();
                else { W(` ${x} g `); segPlain(); restore(gs.fill, false); }
              } else {
                newXO.set(N(nm), self.rewriteImage(raw));
                segPlain();
              }
            } else if (st === 'Form' && depth < 12) {
              const cSig = (c) => [c.m.type, c.m.names || 0, c.m.device ? 1 : 0, c.vals, c.csName || ''];
              const sig = (refKey(raw) || nm) + '|' + JSON.stringify([cSig(gs.fill), cSig(gs.stroke), gs.opF, gs.opS, gs.opm, gs.tr]);
              let ref = self.formCache.get(sig);
              if (!ref) {
                let fb = null; try { fb = streamBytes(xo); } catch (e) { }
                if (!fb) { segPlain(); break; }
                const csNames = [];
                [gs.fill, gs.stroke].forEach(c => { if (c.csName && csNameObj[c.csName]) csNames.push([c.csName, csNameObj[c.csName]]); });
                const fres = sd.lookup(N('Resources')) || srcRes;
                const r = self.rewriteContent(fb, fres, { state: { fill: gs.fill, stroke: gs.stroke, opF: gs.opF, opS: gs.opS, opm: gs.opm, tr: gs.tr }, csNames }, depth + 1);
                ref = ctx.register(self.makeStream(r.bytes, sd, r.res));
                self.formCache.set(sig, ref);
              }
              const newName = `${nm}_p${++self.formSeq}`;
              newXO.set(N(newName), ref);
              W(` /${newName} Do\n`);
            } else segPlain();
            break;
          }
          default: segPlain();
        }
      });
      let total = 0; out.forEach(x => total += x.length);
      const buf = new Uint8Array(total); let off = 0;
      out.forEach(x => { buf.set(x, off); off += x.length; });
      return { bytes: buf, res };
    }
  }

  // ---------------- 페이지 분판 생성 ----------------
  async function build(srcDoc, pageIndex, longEdge, onProgress) {
    const T0 = performance.now(); const prog = (t) => { if (window.SEP_DEBUG) console.log('[sep]', Math.round(performance.now() - T0) + 'ms', t); onProgress && onProgress(t); };
    prog('분판 준비 중…');
    const doc = await PDFDocument.create();
    const [cp] = await doc.copyPages(srcDoc, [pageIndex]);
    doc.addPage(cp);
    const ctx = doc.context, node = cp.node;
    const contents = [];
    const c = node.lookup(N('Contents'));
    if (c instanceof PDFArray) { for (let k = 0; k < c.size(); k++) contents.push(streamBytes(c.lookup(k))); }
    else if (c) contents.push(streamBytes(c));
    let total = 0; contents.forEach(x => total += x.length + 1);
    const content = new Uint8Array(total); let off = 0;
    contents.forEach(x => { content.set(x, off); off += x.length; content[off++] = 10; });
    const res = node.lookup(N('Resources'));

    // 1차: 별색 수집 (opmask 재작성 과정에서 색공간 모델을 모두 훑는다)
    const spotCS = {};
    const variants = [];
    const addVariant = (plate) => {
      const rw = new Rewriter(doc, plate, spotCS);
      const out = rw.rewriteContent(content, res, null, 0);
      const pg = doc.addPage([10, 10]);
      ['MediaBox', 'CropBox', 'Rotate'].forEach(k => { const v = node.get(N(k)); if (v) pg.node.set(N(k), v); });
      pg.node.set(N('Resources'), out.res);
      pg.node.set(N('Contents'), ctx.register(ctx.flateStream(out.bytes)));
      variants.push({ plate, pageNo: doc.getPageCount() });
    };
    addVariant('__opmask');
    const spots = Object.keys(spotCS);
    PROCESS.concat(spots).forEach(p => addVariant(p));

    // 별색 표시 색상 샘플 페이지
    const samples = {};
    spots.forEach(nm => {
      const sc = spotCS[nm];
      const pg = doc.addPage([20, 20]);
      pg.node.set(N('Resources'), ctx.obj({ ColorSpace: ctx.obj({ S0: sc.arr }) }));
      const vals = []; for (let k = 0; k < sc.n; k++) vals.push(k === sc.idx ? 1 : 0);
      pg.node.set(N('Contents'), ctx.register(ctx.stream(`/S0 cs ${vals.join(' ')} scn 0 0 20 20 re f`)));
      samples[nm] = doc.getPageCount();
    });

    prog('분판 파일 생성 중…');
    const bytes = await doc.save({ useObjectStreams: false });

    // 판마다 별도 워커(백그라운드 스레드)에서 병렬로 그린다. 워커를 못 만들면 한 판씩 순서대로.
    const nWorkers = Math.max(1, Math.min(variants.length, 4, (navigator.hardwareConcurrency || 4) - 1));
    const workers = [];
    for (let w = 0; w < nWorkers; w++) { const wk = makeWorker(); if (wk) workers.push(wk); else break; }
    const result = { plates: [], W: 0, H: 0, opmask: null };
    let done = 0;
    const renderVariant = async (v, worker) => {
      const pdf = await pdfjsLib.getDocument({ ...PC.PDFJS_OPTS, data: bytes.slice(), isEvalSupported: true, verbosity: 0, worker: worker || undefined }).promise;
      try {
        const page = await pdf.getPage(v.pageNo);
        const base = page.getViewport({ scale: 1 });
        const vp = page.getViewport({ scale: longEdge / Math.max(base.width, base.height) });
        const cv = document.createElement('canvas');
        cv.width = Math.round(vp.width); cv.height = Math.round(vp.height);
        const cx = cv.getContext('2d', { willReadFrequently: true });
        cx.fillStyle = '#fff'; cx.fillRect(0, 0, cv.width, cv.height);
        await page.render({ canvasContext: cx, viewport: vp, intent: 'print', annotationMode: pdfjsLib.AnnotationMode.DISABLE }).promise;
        const d = cx.getImageData(0, 0, cv.width, cv.height).data;
        const ink = new Uint8Array(cv.width * cv.height);
        for (let i = 0, j = 0; j < ink.length; i += 4, j++) ink[j] = 255 - Math.round((d[i] + d[i + 1] + d[i + 2]) / 3);
        result.W = cv.width; result.H = cv.height;
        if (v.plate === '__opmask') result.opmask = ink;
        else {
          let cov = 0; for (let j = 0; j < ink.length; j++) if (ink[j] > 5) cov++;
          v.out = { name: v.plate, label: PROCESS_KO[v.plate] || v.plate, kind: PROCESS.includes(v.plate) ? 'process' : 'spot', rgb: PROCESS_RGB[v.plate] || [200, 0, 120], ink, coverage: cov / ink.length };
        }
        cv.width = cv.height = 0;
        if (v.plate === PROCESS[0]) { // 별색 표시 색상 샘플은 첫 판 문서에서 함께 읽는다
          for (const nm of spots) {
            try {
              const sp = await pdf.getPage(samples[nm]);
              const c2 = document.createElement('canvas'); c2.width = 20; c2.height = 20;
              const x2 = c2.getContext('2d', { willReadFrequently: true });
              await sp.render({ canvasContext: x2, viewport: sp.getViewport({ scale: 1 }) }).promise;
              const d2 = x2.getImageData(10, 10, 1, 1).data;
              sampleRGB[nm] = [d2[0], d2[1], d2[2]];
            } catch (e) { }
          }
        }
      } finally {
        await pdf.destroy();
        done++; prog(`판 그리는 중… (${done}/${variants.length})`);
      }
    };
    const sampleRGB = {};
    prog(`판 그리는 중… (0/${variants.length})`);
    try {
      if (workers.length) {
        const queue = variants.slice();
        await Promise.all(workers.map(async (wk) => { while (queue.length) await renderVariant(queue.shift(), wk); }));
      } else {
        for (const v of variants) await renderVariant(v, null);
      }
    } finally { workers.forEach(w => { try { w.destroy(); } catch (e) { } }); }
    variants.forEach(v => { if (v.out) { if (sampleRGB[v.plate]) v.out.rgb = sampleRGB[v.plate]; result.plates.push(v.out); } });
    return result;
  }

  // file:// 에서도 동작하도록 워커 코드를 Blob 으로 띄운다
  let workerURL = null, workerFailed = false;
  function makeWorker() {
    if (workerFailed || !window.PDFJS_WORKER_CODE) return null;
    try {
      if (!workerURL) workerURL = URL.createObjectURL(new Blob([window.PDFJS_WORKER_CODE], { type: 'text/javascript' }));
      return new pdfjsLib.PDFWorker({ port: new Worker(workerURL) });
    } catch (e) { workerFailed = true; console.warn('워커 생성 실패 — 메인 스레드에서 처리', e); return null; }
  }

  window.PDFSeparation = { build, PROCESS };
})();
