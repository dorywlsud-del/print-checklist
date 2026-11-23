/* 공통: 판형 표, 단위 변환 */
(function () {
  'use strict';
  const PT2MM = 25.4 / 72;
  const MM2PT = 72 / 25.4;

  // [이름, 가로mm, 세로mm]  (세로 방향 기준)
  const SIZES = [
    ['A3', 297, 420], ['A4 (국배판)', 210, 297], ['A5 (국판)', 148, 210], ['A6', 105, 148],
    ['B4', 257, 364], ['B5', 182, 257], ['B6', 128, 182],
    ['4×6배판', 188, 257], ['신국판', 152, 225], ['크라운판', 176, 248], ['4×6판', 127, 188],
    ['8절', 272, 394], ['16절', 197, 272],
    ['Letter', 215.9, 279.4], ['Legal', 215.9, 355.6], ['Tabloid', 279.4, 431.8],
  ];

  function matchSize(wMM, hMM, tol) {
    tol = tol == null ? 1.2 : tol;
    const a = Math.min(wMM, hMM), b = Math.max(wMM, hMM);
    for (const [name, w, h] of SIZES) {
      if (Math.abs(a - w) <= tol && Math.abs(b - h) <= tol) return { name, w, h };
    }
    return null;
  }

  // TrimBox가 없을 때, 페이지가 "표준 판형 + 사방 도련" 크기인지 추정
  function inferBleed(wMM, hMM) {
    const a = Math.min(wMM, hMM), b = Math.max(wMM, hMM);
    for (const [name, w, h] of SIZES) {
      const da = (a - w) / 2, db = (b - h) / 2;
      if (da >= 1.5 && da <= 5.5 && Math.abs(da - db) <= 0.6) return { name, w, h, bleed: (da + db) / 2 };
    }
    return null;
  }

  // 유효 재단 영역 (TrimBox > 크기로 추정 > 페이지 전체), 단위 pt
  function effectiveTrim(crop, trim) {
    if (trim && (trim[2] - trim[0]) > 10 && (trim[3] - trim[1]) > 10) return { box: trim, source: 'TrimBox' };
    const inf = inferBleed((crop[2] - crop[0]) * PT2MM, (crop[3] - crop[1]) * PT2MM);
    if (inf) {
      const b = inf.bleed * MM2PT;
      return { box: [crop[0] + b, crop[1] + b, crop[2] - b, crop[3] - b], source: 'estimated' };
    }
    return { box: crop.slice(), source: 'none' };
  }

  function sizeLabel(wMM, hMM) {
    const m = matchSize(wMM, hMM);
    const dims = `${fmt(wMM)}×${fmt(hMM)}mm`;
    return m ? `${m.name.split(' ')[0]} ${dims}` : dims;
  }
  function fmt(v, d) {
    d = d == null ? 1 : d;
    const r = Math.round(v * Math.pow(10, d)) / Math.pow(10, d);
    return Number.isInteger(r) ? String(r) : r.toFixed(d);
  }
  function pageRanges(list) { // [0,1,2,5] -> "1–3, 6"
    const s = Array.from(new Set(list)).sort((a, b) => a - b).map(x => x + 1);
    const out = []; let i = 0;
    while (i < s.length) {
      let j = i; while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
      out.push(j > i ? `${s[i]}–${s[j]}` : `${s[i]}`); i = j + 1;
    }
    return out.join(', ');
  }
  function fileSize(n) {
    if (n > 1048576) return fmt(n / 1048576, 1) + ' MB';
    return fmt(n / 1024, 0) + ' KB';
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // 이미지 분류: 색상 그룹 / 압축 형식 / PNG 추정
  const IMG_GROUP_LABEL = { RGB: 'RGB', CMYK: 'CMYK', Gray: '흑백', Spot: '별색', Other: '기타' };
  function imageKind(im) {
    const c = im.csInfo || { cat: 'Other' };
    let group = im.mask ? 'Gray' : ({ RGB: 'RGB', CMYK: 'CMYK', Gray: 'Gray', Spot: 'Spot' }[c.cat] || 'Other');
    const f = im.filterRaw || '';
    let format;
    if (f === 'DCTDecode') format = 'JPEG';
    else if (f === 'JPXDecode') format = 'JPEG2000';
    else if (f === 'JBIG2Decode' || f === 'CCITTFaxDecode') format = '흑백 스캔(JBIG2/CCITT)';
    else if (f === 'FlateDecode' || f === 'LZWDecode' || f === '없음' || f === 'RunLengthDecode') format = '무손실';
    else format = '기타';
    // PNG는 CMYK를 저장할 수 없고 무손실 압축 → PDF 안에서는 Flate + RGB/흑백(+투명 마스크) 형태로 남는다
    const png = format === '무손실' && !im.mask && (group === 'RGB' || group === 'Gray') && (im.bpc >= 8 || c.indexed);
    if (png) format = 'PNG 추정';
    return { group, indexed: !!c.indexed, format, png, alpha: !!im.hasSMask, bit16: im.bpc === 16 };
  }

  // 내장 CMap 읽기 (file://에서는 fetch가 막혀 있어 lib/pdf.cmaps.js에 담아 둔 것을 사용)
  class CMapFactory {
    async fetch({ name }) {
      const b64 = window.PDFJS_CMAPS && window.PDFJS_CMAPS[name];
      if (!b64) throw new Error('CMap 없음: ' + name);
      const bin = atob(b64), u = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      return { cMapData: u, compressionType: 1 };
    }
  }
  const PDFJS_OPTS = { CMapReaderFactory: CMapFactory, cMapUrl: 'lib/cmaps/', cMapPacked: true, useWorkerFetch: false };

  window.PC = { PDFJS_OPTS, PT2MM, MM2PT, SIZES, matchSize, inferBleed, effectiveTrim, sizeLabel, fmt, pageRanges, fileSize, esc, imageKind, IMG_GROUP_LABEL };
})();
