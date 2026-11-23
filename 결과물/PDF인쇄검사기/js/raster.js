/* 렌더링 기반 분석 (pdf.js)
 * 인쇄 의도(print intent)로 페이지를 그려서 미리보기 이미지를 만들고,
 * 빈 페이지 / 컬러 여부 / 재단선·안전여백 근처 요소를 픽셀로 검사한다.
 */
(function () {
  'use strict';
  const { PT2MM, MM2PT, inferBleed } = PC;
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'lib/pdf.worker.min.js';

  const ANALYSIS_LONG_EDGE = 1100;  // 분석·미리보기 해상도(긴 변 픽셀)
  const BAND_MM = 15;               // 가장자리에서 기록할 거리(mm)
  const WHITE = 242;                // 이보다 어두우면 '내용 있음'
  const SAT = 28;                   // 채널 차이가 이보다 크면 '컬러'

  async function openPdf(bytes) {
    const task = pdfjsLib.getDocument({
      ...PC.PDFJS_OPTS, data: bytes, isEvalSupported: false, disableFontFace: false,
      useSystemFonts: true, verbosity: 0,
    });
    return await task.promise;
  }

  // 유효 재단 영역 결정 (TrimBox > 크기로 추정 > 페이지 전체)
  function decideTrim(P) {
    const c = P.cropBox;
    const cw = (c[2] - c[0]) * PT2MM, ch = (c[3] - c[1]) * PT2MM;
    const et = PC.effectiveTrim(c, P.trimBox);
    P.trimEff = et.box; P.trimSource = et.source;
    const t = P.trimEff;
    P.bleedMM = {
      left: (t[0] - c[0]) * PT2MM, right: (c[2] - t[2]) * PT2MM,
      bottom: (t[1] - c[1]) * PT2MM, top: (c[3] - t[3]) * PT2MM,
    };
    P.bleedMin = Math.min(P.bleedMM.left, P.bleedMM.right, P.bleedMM.top, P.bleedMM.bottom);
    let tw = (t[2] - t[0]) * PT2MM, th = (t[3] - t[1]) * PT2MM;
    if (P.rotate === 90 || P.rotate === 270) { const x = tw; tw = th; th = x; }
    P.trimWmm = tw; P.trimHmm = th;
    let pw = cw, ph = ch;
    if (P.rotate === 90 || P.rotate === 270) { pw = ch; ph = cw; }
    P.cropWmm = pw; P.cropHmm = ph;
  }

  function normRect(vp, rect) {
    const r = vp.convertToViewportRectangle(rect);
    const x0 = Math.min(r[0], r[2]) / vp.width, x1 = Math.max(r[0], r[2]) / vp.width;
    const y0 = Math.min(r[1], r[3]) / vp.height, y1 = Math.max(r[1], r[3]) / vp.height;
    return [x0, y0, x1, y1];
  }

  async function renderToCanvas(pdf, index, longEdge) {
    const page = await pdf.getPage(index + 1);
    const base = page.getViewport({ scale: 1 });
    const scale = longEdge / Math.max(base.width, base.height);
    const vp = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(vp.width); canvas.height = Math.round(vp.height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({
      canvasContext: ctx, viewport: vp, intent: 'print',
      annotationMode: pdfjsLib.AnnotationMode.ENABLE_STORAGE,
    }).promise;
    return { canvas, ctx, vp, page, scale };
  }

  async function analyzePageRaster(pdf, P) {
    decideTrim(P);
    const { canvas, ctx, vp, page, scale } = await renderToCanvas(pdf, P.index, ANALYSIS_LONG_EDGE);
    const W = canvas.width, H = canvas.height;
    const pxPerMM = scale * MM2PT;
    const trimN = normRect(vp, P.trimEff);
    const tx0 = Math.round(trimN[0] * W), tx1 = Math.round(trimN[2] * W);
    const ty0 = Math.round(trimN[1] * H), ty1 = Math.round(trimN[3] * H);
    const maxD = Math.ceil(BAND_MM * pxPerMM);

    const mk = () => { const a = []; for (let d = 0; d < maxD; d++) a.push({ c: 0, lo: 1e9, hi: -1 }); return a; };
    const edges = { top: mk(), bottom: mk(), left: mk(), right: mk() };
    let nonWhite = 0, colorPx = 0, outside = 0, outsideTotal = 0;
    let cx0 = 1e9, cy0 = 1e9, cx1 = -1, cy1 = -1; // 컬러 영역 bbox

    const data = ctx.getImageData(0, 0, W, H).data;
    for (let y = 0; y < H; y++) {
      const inY = y >= ty0 && y < ty1;
      for (let x = 0; x < W; x++) {
        const p = (y * W + x) << 2;
        const r = data[p], g = data[p + 1], b = data[p + 2];
        const inside = inY && x >= tx0 && x < tx1;
        if (!inside) outsideTotal++;
        const mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
        if (mn >= WHITE) continue;
        nonWhite++;
        const mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
        if (mx - mn > SAT) {
          colorPx++;
          if (x < cx0) cx0 = x; if (x > cx1) cx1 = x; if (y < cy0) cy0 = y; if (y > cy1) cy1 = y;
        }
        if (!inside) { outside++; continue; }
        let d;
        d = y - ty0; if (d < maxD) { const e = edges.top[d]; e.c++; if (x < e.lo) e.lo = x; if (x > e.hi) e.hi = x; }
        d = ty1 - 1 - y; if (d < maxD) { const e = edges.bottom[d]; e.c++; if (x < e.lo) e.lo = x; if (x > e.hi) e.hi = x; }
        d = x - tx0; if (d < maxD) { const e = edges.left[d]; e.c++; if (y < e.lo) e.lo = y; if (y > e.hi) e.hi = y; }
        d = tx1 - 1 - x; if (d < maxD) { const e = edges.right[d]; e.c++; if (y < e.lo) e.lo = y; if (y > e.hi) e.hi = y; }
      }
    }

    // 재단선 접촉(가장 바깥 2px 의 채움 비율)
    const touch = {};
    for (const k of Object.keys(edges)) {
      const len = (k === 'top' || k === 'bottom') ? (tx1 - tx0) : (ty1 - ty0);
      const e = edges[k];
      const c = (e[0] ? e[0].c : 0) + (e[1] ? e[1].c : 0);
      touch[k] = len > 0 ? c / (2 * len) : 0;
    }

    // 가장자리별, 각 위치에서 '재단선에 붙은 요소(배경 등)'를 건너뛴 뒤 가장 가까운 내용까지의 거리
    const isInk = (x, y) => {
      const p = (y * W + x) << 2;
      return data[p] < WHITE || data[p + 1] < WHITE || data[p + 2] < WHITE;
    };
    const nearest = {};
    const spec = {
      top: { len: tx1 - tx0, at: (a, d) => [tx0 + a, ty0 + d] },
      bottom: { len: tx1 - tx0, at: (a, d) => [tx0 + a, ty1 - 1 - d] },
      left: { len: ty1 - ty0, at: (a, d) => [tx0 + d, ty0 + a] },
      right: { len: ty1 - ty0, at: (a, d) => [tx1 - 1 - d, ty0 + a] },
    };
    const lim = Math.min(maxD, Math.floor((tx1 - tx0) / 2), Math.floor((ty1 - ty0) / 2));
    for (const k of Object.keys(spec)) {
      const { len, at } = spec[k];
      const arr = new Uint16Array(Math.max(0, len)).fill(65535);
      for (let a = 0; a < len; a++) {
        let d = 0;
        let pt = at(a, 0);
        if (isInk(pt[0], pt[1])) { // 붙은 요소 건너뛰기 (흰색 2px 이상이 나올 때까지)
          let white = 0;
          while (d < lim && white < 2) { pt = at(a, d); white = isInk(pt[0], pt[1]) ? 0 : white + 1; d++; }
        }
        for (; d < lim; d++) { pt = at(a, d); if (isInk(pt[0], pt[1])) { arr[a] = d; break; } }
      }
      nearest[k] = arr;
    }

    const total = W * H;
    const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.9));
    const url = URL.createObjectURL(blob);

    P.raster = {
      W, H, pxPerMM, trimPx: [tx0, ty0, tx1, ty1], trimN,
      nonWhiteRatio: nonWhite / total, colorPx, colorRatio: colorPx / total,
      colorBoxN: cx1 >= 0 ? [cx0 / W, cy0 / H, (cx1 + 1) / W, (cy1 + 1) / H] : null,
      outsideRatio: outsideTotal ? outside / outsideTotal : 0,
      nearest, touch, url,
    };
    P.isBlank = nonWhite < total * 0.00003;
    P.isColor = colorPx > Math.max(40, total * 0.0002);
    // 각종 영역을 미리보기 좌표(0~1)로 변환
    P.images.forEach(im => { im.rectN = normRect(vp, im.rect); });
    P.annots.forEach(a => { if (a.rect) a.rectN = normRect(vp, a.rect); });
    if (P.bleedBox) P.bleedN = normRect(vp, P.bleedBox);
    P.viewW = vp.width; P.viewH = vp.height;
    page.cleanup();
    canvas.width = canvas.height = 0;
  }

  // 설정의 안전여백(mm)에 따라 가장자리 침범 영역 계산
  function safeIntrusions(P, safeMM) {
    const R = P.raster; if (!R) return [];
    const [tx0, ty0, tx1, ty1] = R.trimPx;
    const safePx = Math.round(safeMM * R.pxPerMM);
    const out = [];
    for (const k of ['top', 'bottom', 'left', 'right']) {
      // 배경이 가장자리 대부분을 덮는 쪽은 픽셀로 글자/배경 구분이 어려워 생략 (도련 검사에서 다룸)
      if (R.touch[k] > 0.5) continue;
      const arr = R.nearest[k];
      // 안전선 안쪽으로 들어온 위치들을 연속 구간으로 묶는다
      const gap = Math.max(4, Math.round(4 * R.pxPerMM));
      let runs = [], cur = null;
      for (let a = 0; a < arr.length; a++) {
        const d = arr[a];
        if (d >= 1 && d < safePx) {
          if (cur && a - cur.hi <= gap) { cur.hi = a; cur.dmin = Math.min(cur.dmin, d); cur.c++; }
          else { cur = { lo: a, hi: a, dmin: d, c: 1 }; runs.push(cur); }
        }
      }
      runs = runs.filter(r => r.c >= 3);
      if (!runs.length) continue;
      const item = { edge: k, nearestMM: Math.min(...runs.map(r => r.dmin)) / R.pxPerMM, rects: [] };
      out.push(item);
      runs.forEach(r => {
        let box;
        if (k === 'top') box = [tx0 + r.lo, ty0 + r.dmin, tx0 + r.hi + 1, ty0 + safePx];
        if (k === 'bottom') box = [tx0 + r.lo, ty1 - safePx, tx0 + r.hi + 1, ty1 - r.dmin];
        if (k === 'left') box = [tx0 + r.dmin, ty0 + r.lo, tx0 + safePx, ty0 + r.hi + 1];
        if (k === 'right') box = [tx1 - safePx, ty0 + r.lo, tx1 - r.dmin, ty0 + r.hi + 1];
        item.rects.push([box[0] / R.W, box[1] / R.H, box[2] / R.W, box[3] / R.H]);
      });
    }
    return out;
  }

  window.PDFRaster = { openPdf, analyzePageRaster, renderToCanvas, safeIntrusions, normRect };
})();
