/* 검사 규칙: 수집된 정보 + 설정 → 항목별 판정 */
(function () {
  'use strict';
  const { SIZES, matchSize, sizeLabel, fmt, pageRanges } = PC;

  const PRESETS = {
    press: { mode: 'press', bleedMM: 3, safeMM: 5, dpiWarn: 300, dpiErr: 150 },
    office: { mode: 'office', bleedMM: 0, safeMM: 5, dpiWarn: 150, dpiErr: 96 },
  };
  const DEFAULTS = Object.assign({}, PRESETS.press, { color: 'color', target: 'auto', binding: 'none' });

  const EDGE_KO = { top: '위', bottom: '아래', left: '왼쪽', right: '오른쪽' };
  const LV = { error: 3, warn: 2, info: 1, ok: 0, skip: -1 };
  const worst = (arr) => arr.reduce((w, s) => (LV[s] > LV[w] ? s : w), 'ok');

  function evaluate(F, S) {
    const pages = F.pages;
    const n = pages.length;
    const checks = [];
    const pageIssues = pages.map(() => []);
    const note = (i, level, text, rectN, kind) => pageIssues[i].push({ level, text, rectN, kind });
    const press = S.mode === 'press';

    // 1. 판형 ------------------------------------------------------------
    {
      const key = (P) => `${Math.round(Math.min(P.trimWmm, P.trimHmm))}x${Math.round(Math.max(P.trimWmm, P.trimHmm))}`;
      const groups = new Map();
      pages.forEach(P => { const k = key(P); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(P.index); });
      const sorted = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
      let target = null;
      if (S.target !== 'auto') { const s = SIZES.find(x => x[0] === S.target); if (s) target = { name: s[0], w: s[1], h: s[2] }; }
      const labelOf = (P) => sizeLabel(Math.min(P.trimWmm, P.trimHmm), Math.max(P.trimWmm, P.trimHmm));
      let status = 'ok', summary, details = [];
      const bad = [];
      if (target) {
        pages.forEach(P => {
          const a = Math.min(P.trimWmm, P.trimHmm), b = Math.max(P.trimWmm, P.trimHmm);
          if (Math.abs(a - target.w) > 1.2 || Math.abs(b - target.h) > 1.2) bad.push(P.index);
        });
        if (bad.length) {
          status = 'error';
          summary = `목표 판형(${target.name.split(' ')[0]} ${target.w}×${target.h}mm)과 다른 페이지 ${bad.length}쪽`;
          bad.forEach(i => note(i, 'error', `판형 불일치: ${labelOf(pages[i])}`, null, 'size'));
        } else summary = `모든 페이지 ${target.name} ${target.w}×${target.h}mm`;
      } else if (sorted.length > 1) {
        status = 'warn';
        summary = `페이지 크기가 ${sorted.length}종류 섞여 있음`;
        const main = sorted[0][1];
        sorted.slice(1).forEach(([, idxs]) => idxs.forEach(i => { bad.push(i); note(i, 'warn', `다른 크기: ${labelOf(pages[i])}`, null, 'size'); }));
        details.push(`기준(가장 많은 크기): ${labelOf(pages[main[0]])} — ${main.length}쪽`);
      } else {
        summary = `모든 페이지 ${labelOf(pages[0])}`;
      }
      sorted.forEach(([, idxs]) => details.push(`${labelOf(pages[idxs[0]])}: ${pageRanges(idxs)}쪽`));
      const est = pages.filter(P => P.trimSource === 'estimated');
      if (est.length) details.push(`TrimBox(재단 크기 정보)가 없어, 페이지 크기(사방 약 ${fmt(est[0].bleedMin)}mm 도련 포함)로 재단선을 추정했습니다.`);
      const noTrim = pages.filter(P => P.trimSource === 'none');
      if (press && noTrim.length) details.push(`TrimBox 없음 — 페이지 전체를 완성 크기로 간주했습니다 (${pageRanges(noTrim.map(p => p.index))}쪽).`);
      checks.push({ id: 'size', title: '판형 (완성 크기)', status, summary, details, pages: bad });
    }

    // 2. 방향/회전 ------------------------------------------------------
    {
      const land = pages.filter(P => P.trimWmm > P.trimHmm + 1).map(P => P.index);
      const rot = pages.filter(P => P.rotate).map(P => P.index);
      let status = 'ok', summary = land.length === n ? '모든 페이지 가로 방향' : (land.length ? '' : '모든 페이지 세로 방향');
      const details = [];
      if (land.length && land.length < n) {
        status = 'warn'; summary = `가로 방향 페이지 ${land.length}쪽이 섞여 있음`;
        land.forEach(i => note(i, 'warn', '가로 방향 페이지', null, 'orient'));
        details.push(`가로 방향: ${pageRanges(land)}쪽`);
      }
      if (rot.length) {
        status = worst([status, 'info']);
        details.push(`페이지 회전 설정(/Rotate)이 있는 페이지: ${pageRanges(rot)}쪽 — 인쇄소 RIP에 따라 방향이 달라질 수 있어 확인 권장`);
      }
      checks.push({ id: 'orient', title: '페이지 방향', status, summary, details, pages: status === 'warn' ? land : rot });
    }

    // 3. 페이지 수 --------------------------------------------------------
    {
      let status = 'ok', summary = `총 ${n}쪽`; const details = [];
      if (S.binding === 'saddle' && n % 4) {
        status = 'error';
        summary = `중철 제본은 4의 배수여야 함 — 현재 ${n}쪽 (${4 - n % 4}쪽 추가 또는 조정 필요)`;
      } else if (S.binding === 'saddle') summary += ' (4의 배수 ✓ 중철 가능)';
      else if (S.binding === 'perfect' && n % 2) {
        status = 'info'; summary += ' — 홀수 페이지라 마지막 장 뒷면이 빈 면이 됨';
      }
      checks.push({ id: 'count', title: '페이지 수', status, summary, details, pages: [] });
    }

    // 4. 도련 ------------------------------------------------------------
    if (press) {
      const need = S.bleedMM;
      const lack = [], noExtend = [];
      let anyBleed = false;
      pages.forEach(P => {
        if (!P.raster) return;
        const touched = Object.keys(P.raster.touch).filter(k => P.raster.touch[k] > 0.02);
        if (P.bleedMin >= need - 0.25) {
          anyBleed = true;
          const big = touched.filter(k => P.raster.touch[k] > 0.3);
          if (big.length && P.raster.outsideRatio < 0.03) {
            noExtend.push(P.index);
            note(P.index, 'warn', `배경이 재단선에서 끝남(${big.map(k => EDGE_KO[k]).join('·')}) — 도련 영역까지 늘려야 함`, null, 'bleed');
          }
        } else if (touched.length) {
          lack.push(P.index);
          const t = P.raster.trimN, th = 0.012;
          const strip = { top: [t[0], t[1], t[2], t[1] + th], bottom: [t[0], t[3] - th, t[2], t[3]], left: [t[0], t[1], t[0] + th, t[3]], right: [t[2] - th, t[1], t[2], t[3]] };
          touched.forEach((k, j) => {
            note(P.index, 'error', `재단선까지 닿는 디자인(${touched.map(k => EDGE_KO[k]).join('·')})이 있는데 도련 ${P.bleedMin > 0.2 ? fmt(P.bleedMin) + 'mm로 부족' : '없음'}`, strip[k], 'bleed');
            if (j) pageIssues[P.index][pageIssues[P.index].length - 1].dup = true;
          });
        }
      });
      let status = 'ok', summary;
      const details = [`기준: 사방 ${need}mm 도련`];
      if (lack.length) { status = 'error'; summary = `도련 부족 ${lack.length}쪽 — 재단 시 가장자리에 흰 선이 생길 수 있음`; }
      else if (noExtend.length) { status = 'warn'; summary = `도련은 있으나 배경이 도련 영역까지 이어지지 않은 페이지 ${noExtend.length}쪽`; }
      else if (anyBleed) summary = `도련 ${fmt(pages[0].bleedMin)}mm 확보`;
      else summary = '도련 없음 — 가장자리까지 닿는 디자인이 없어 문제 없음';
      checks.push({ id: 'bleed', title: '도련 (재단 여유)', status, summary, details, pages: lack.concat(noExtend) });
    } else {
      checks.push({ id: 'bleed', title: '도련 (재단 여유)', status: 'skip', summary: '사무용 프린터 모드 — 재단하지 않으므로 검사 생략', details: [], pages: [] });
    }

    // 5. 안전여백 --------------------------------------------------------
    {
      const bad = [];
      pages.forEach(P => {
        const ins = PDFRaster.safeIntrusions(P, S.safeMM);
        if (ins.length) {
          bad.push(P.index);
          ins.forEach(x => x.rects.forEach((rc, j) => {
            note(P.index, 'warn', `${EDGE_KO[x.edge]} 가장자리 ${fmt(x.nearestMM)}mm 지점까지 내용 있음`, rc, 'safe');
            if (j) pageIssues[P.index][pageIssues[P.index].length - 1].dup = true;
          }));
        }
        if (!press && P.raster) {
          const t = Object.keys(P.raster.touch).filter(k => P.raster.touch[k] > 0.02);
          if (t.length) {
            if (!bad.includes(P.index)) bad.push(P.index);
            note(P.index, 'warn', `${t.map(k => EDGE_KO[k]).join('·')} 가장자리 끝까지 인쇄 요소 — 일반 프린터는 가장자리 약 4mm를 인쇄하지 못함`, null, 'safe');
          }
        }
      });
      const status = bad.length ? 'warn' : 'ok';
      checks.push({
        id: 'safe', title: '안전여백', status,
        summary: bad.length ? `재단선(가장자리) ${S.safeMM}mm 안쪽까지 내용이 있는 페이지 ${bad.length}쪽` : `모든 내용이 가장자리에서 ${S.safeMM}mm 이상 떨어져 있음`,
        details: [press ? '재단 오차로 가장자리 내용이 잘릴 수 있습니다. 글자·쪽번호는 안쪽으로 옮기세요.' : '일반 프린터는 용지 가장자리를 인쇄하지 못해 잘릴 수 있습니다.'],
        pages: bad,
      });
    }

    // 6. 글꼴 ------------------------------------------------------------
    {
      const map = new Map();
      pages.forEach(P => (P.fonts || []).forEach(f => {
        const k = f.name + '|' + f.embedded;
        if (!map.has(k)) map.set(k, Object.assign({ pages: [] }, f));
        map.get(k).pages.push(P.index);
      }));
      const fonts = [...map.values()];
      const notEmb = fonts.filter(f => !f.embedded);
      const t3 = fonts.filter(f => f.type === 'Type3');
      let status = 'ok', summary;
      const details = fonts.map(f => `${f.embedded ? '✓' : '✗'} ${f.name} (${f.type}${f.subset ? ', 부분 포함' : ''}) — ${pageRanges(f.pages)}쪽`);
      if (F.info.encrypted) { status = 'warn'; summary = '암호화 문서라 글꼴 검사가 제한됨'; }
      else if (notEmb.length) {
        status = 'error';
        summary = `포함(임베드)되지 않은 글꼴 ${notEmb.length}종: ${notEmb.map(f => f.name).slice(0, 4).join(', ')}${notEmb.length > 4 ? ' 외' : ''}`;
        notEmb.forEach(f => f.pages.forEach(i => note(i, 'error', `글꼴 미포함: ${f.name}`, null, 'font')));
      } else if (!fonts.length) summary = '사용된 글꼴 없음 (텍스트가 없거나 윤곽선/이미지로 변환됨)';
      else summary = `사용 글꼴 ${fonts.length}종 모두 PDF에 포함됨`;
      if (t3.length) details.push(`Type3 글꼴 ${t3.length}종 — 비트맵 글꼴일 경우 인쇄 품질이 떨어질 수 있음`);
      checks.push({ id: 'font', title: '글꼴 포함', status, summary, details, pages: [...new Set(notEmb.flatMap(f => f.pages))] });
    }

    // 이미지 목록 (아주 작은 장식 이미지는 제외) — 같은 이미지가 여러 번 배치돼도 배치마다 검사
    const allImgs = [];
    pages.forEach(P => (P.images || []).forEach(im => {
      if (im.wMM < 3 || im.hMM < 3) return;
      allImgs.push({ P, im, kind: PC.imageKind(im) });
    }));
    // 같은 이미지(같은 객체) 묶기 — 색상·형식 집계용
    const uniq = new Map();
    allImgs.forEach((x, k) => {
      const key = x.im.ref || `inline-${x.P.index}-${k}`;
      if (!uniq.has(key)) uniq.set(key, Object.assign({ pages: [], places: [] }, x));
      const u = uniq.get(key); u.pages.push(x.P.index); u.places.push(x);
    });
    const uniqImgs = [...uniq.values()];
    const imgCount = (arr) => arr.length + '개' + (arr.reduce((s, u) => s + u.places.length, 0) > arr.length ? ` (배치 ${arr.reduce((s, u) => s + u.places.length, 0)}회)` : '');

    // 7. 이미지 해상도 ----------------------------------------------------
    {
      let total = 0; const errs = [], warns = [];
      const details = [];
      allImgs.forEach(({ P, im }) => {
        total++;
        const d = Math.round(im.dpi);
        const lab = `${im.w}×${im.h}px, ${d}dpi, 인쇄 크기 ${fmt(im.wMM, 0)}×${fmt(im.hMM, 0)}mm`;
        const oneBit = im.mask || im.bpc === 1;
        if (!oneBit && d < S.dpiErr) { errs.push(P.index); note(P.index, 'error', `저해상도 이미지 ${d}dpi (${fmt(im.wMM, 0)}×${fmt(im.hMM, 0)}mm)`, im.rectN, 'image'); details.push({ level: 'error', page: P.index, rectN: im.rectN, text: lab }); }
        else if (d < S.dpiWarn) { warns.push(P.index); note(P.index, 'warn', `해상도 낮음 ${d}dpi (${fmt(im.wMM, 0)}×${fmt(im.hMM, 0)}mm)`, im.rectN, 'image'); details.push({ level: 'warn', page: P.index, rectN: im.rectN, text: lab }); }
      });
      // 오류(✗)를 먼저, 같은 등급 안에서는 페이지 순
      details.sort((a, b) => (a.level === b.level ? a.page - b.page : a.level === 'error' ? -1 : 1));
      let status = 'ok', summary;
      if (!total) summary = '이미지 없음';
      else if (errs.length) { status = 'error'; summary = `${S.dpiErr}dpi 미만 이미지 ${errs.length}개 — 흐리거나 깨져 보일 수 있음`; }
      else if (warns.length) { status = 'warn'; summary = `${S.dpiWarn}dpi 미만 이미지 ${warns.length}개`; }
      else summary = `이미지 ${total}개 모두 ${S.dpiWarn}dpi 이상`;
      if (warns.length && errs.length) summary += `, ${S.dpiWarn}dpi 미만 ${warns.length}개`;
      details.unshift(`기준: ${S.dpiWarn}dpi 미만 주의(△), ${S.dpiErr}dpi 미만 오류(✕) — 실제 인쇄 크기 기준 유효 해상도. 줄을 누르면 해당 위치로 이동합니다.`);
      if (details.length > 401) { const more = details.length - 401; details.length = 401; details.push(`… 외 ${more}개`); }
      checks.push({ id: 'image', title: '이미지 해상도', status, summary, details, pages: [...new Set(errs.concat(warns))] });
    }

    // 7-2. 이미지 색상 모드 --------------------------------------------------
    {
      const G = { RGB: [], CMYK: [], Gray: [], Spot: [], Other: [] };
      uniqImgs.forEach(u => G[u.kind.group].push(u));
      const details = [];
      const line = (g, extra) => {
        const arr = G[g]; if (!arr.length) return;
        const idx = arr.filter(u => u.kind.indexed).length;
        details.push(`${PC.IMG_GROUP_LABEL[g]} ${imgCount(arr)}${idx ? ` — 인덱스 색상 ${idx}개 포함` : ''} · ${pageRanges(arr.flatMap(u => u.pages))}쪽${extra || ''}`);
      };
      line('RGB'); line('CMYK'); line('Gray');
      if (G.Spot.length) {
        const names = [...new Set(G.Spot.flatMap(u => u.im.csInfo.spots || []))];
        line('Spot', ` (${names.join(', ')})`);
      }
      line('Other', ' (Lab·JPEG2000 내장 색상 등)');
      let status = 'ok', summary, bad = [];
      const counts = ['RGB', 'CMYK', 'Gray', 'Spot'].filter(g => G[g].length).map(g => `${PC.IMG_GROUP_LABEL[g]} ${G[g].length}`).join(' · ');
      const mark = (arr, level, text) => arr.forEach(u => u.places.forEach(x => { bad.push(x.P.index); note(x.P.index, level, text, x.im.rectN, 'imgcolor'); }));
      if (!uniqImgs.length) summary = '이미지 없음';
      else if (press && S.color === 'color' && G.RGB.length) {
        status = 'warn';
        summary = `RGB 이미지 ${G.RGB.length}개 — 인쇄 시 CMYK로 변환되며 색이 탁해질 수 있음 (${counts})`;
        mark(G.RGB, 'warn', 'RGB 이미지');
        details.push('사진·그림은 CMYK로 변환해 넣는 것을 권장합니다. 밝은 형광색·파란색 계열이 특히 많이 변합니다.');
      } else if (S.color === 'mono' && (G.RGB.length || G.CMYK.length)) {
        status = 'info';
        summary = `컬러 이미지 ${G.RGB.length + G.CMYK.length}개 — 흑백 인쇄 시 회색으로 변환됨 (${counts})`;
      } else summary = counts ? `${counts}` + (G.RGB.length ? ' (사무용 프린터는 RGB도 문제 없음)' : '') : '이미지 없음';
      if (G.Spot.length) {
        status = worst([status, press ? 'warn' : 'info']);
        if (press) { mark(G.Spot, 'warn', '별색 이미지(듀오톤 등)'); summary += ` · 별색 이미지 ${G.Spot.length}개`; }
      }
      checks.push({ id: 'imgcolor', title: '이미지 색상 모드', status, summary, details, pages: [...new Set(bad)] });
    }

    // 7-3. 이미지 형식 (PNG) ----------------------------------------------
    {
      const F2 = {};
      uniqImgs.forEach(u => { (F2[u.kind.format] = F2[u.kind.format] || []).push(u); });
      const png = F2['PNG 추정'] || [];
      const pngAlpha = png.filter(u => u.kind.alpha), pngRGB = png.filter(u => u.kind.group === 'RGB'), png16 = png.filter(u => u.kind.bit16);
      const details = [];
      if (uniqImgs.length) details.push('형식 구성: ' + ['JPEG', 'PNG 추정', '무손실', 'JPEG2000', '흑백 스캔(JBIG2/CCITT)', '기타'].filter(f => F2[f]).map(f => `${f === '무손실' ? '무손실(TIFF·PSD 등)' : f} ${F2[f].length}개`).join(', '));
      png.forEach(u => {
        const tags = [u.kind.group === 'RGB' ? 'RGB' : '흑백', u.kind.alpha ? '투명 배경' : null, u.kind.indexed ? '인덱스(PNG-8)' : null, u.kind.bit16 ? '16비트' : null].filter(Boolean);
        const lvl = press && (u.kind.alpha || (u.kind.group === 'RGB' && S.color === 'color')) ? 'warn' : 'info';
        details.push({
          level: lvl, page: u.places[0].P.index, rectN: u.places[0].im.rectN,
          pageLabel: pageRanges(u.pages),
          text: `${u.im.w}×${u.im.h}px, ${tags.join(', ')}, ${Math.round(Math.min(...u.places.map(x => x.im.dpi)))}dpi`,
        });
      });
      if (details.length > 401) { const more = details.length - 401; details.length = 401; details.push(`… 외 ${more}개`); }
      let status = 'ok', summary;
      const bad = [];
      if (!png.length) summary = uniqImgs.length ? 'PNG로 보이는 이미지 없음' : '이미지 없음';
      else {
        const parts = [pngAlpha.length ? `투명 배경 ${pngAlpha.length}개` : '', pngRGB.length ? `RGB ${pngRGB.length}개` : ''].filter(Boolean);
        summary = `PNG로 보이는 이미지 ${imgCount(png)}${parts.length ? ' — ' + parts.join(', ') : ''}`;
        status = press && (pngAlpha.length || (pngRGB.length && S.color === 'color')) ? 'warn' : 'info';
        png.forEach(u => u.places.forEach(x => {
          const why = [x.kind.alpha ? '투명 배경' : '', x.kind.group === 'RGB' ? 'RGB' : ''].filter(Boolean).join('·');
          bad.push(x.P.index);
          // RGB 자체는 '이미지 색상 모드'에서 이미 주의로 표시되므로, 여기서는 투명 배경만 주의로 올린다
          note(x.P.index, press && x.kind.alpha ? 'warn' : 'info', `PNG 추정 이미지${why ? ' (' + why + ')' : ''}`, x.im.rectN, 'png');
        }));
        if (press) {
          if (pngRGB.length) details.push('PNG는 CMYK를 저장할 수 없어 항상 RGB입니다. 인쇄소에서 CMYK로 변환되며 색이 달라질 수 있습니다.');
          if (pngAlpha.length) details.push('투명 배경 PNG는 출력 시 투명도 병합 과정에서 가장자리 흰 선·계단 현상이 생길 수 있어 실제 출력 확인을 권장합니다.');
        }
        if (png16.length) details.push(`16비트 PNG ${png16.length}개 — 파일 용량만 커지고 인쇄 품질 이득은 거의 없음`);
      }
      details.push('※ PDF에는 원본 파일 형식이 저장되지 않아, 압축 방식(무손실)·색공간(RGB/흑백)·투명 마스크로 추정합니다. 무손실 TIFF·PSD도 같은 형태로 보일 수 있습니다.');
      checks.push({ id: 'imgformat', title: '이미지 형식 (PNG)', status, summary, details, pages: [...new Set(bad)] });
    }

    // 8. 색상 모드 -------------------------------------------------------
    {
      const rgb = pages.filter(P => P.colorUse && P.colorUse.RGB > 0).map(P => P.index);
      const rgbBlack = pages.filter(P => P.rgbBlackText > 0).map(P => P.index);
      const cmyk = pages.filter(P => P.colorUse && P.colorUse.CMYK > 0).length;
      const details = [];
      let status = 'ok', summary;
      const used = ['RGB', 'CMYK', 'Gray', 'Spot', 'Lab'].filter(c => pages.some(P => P.colorUse && P.colorUse[c] > 0));
      details.push(`사용된 색공간: ${used.map(c => ({ RGB: 'RGB', CMYK: 'CMYK', Gray: '흑백(Gray)', Spot: '별색', Lab: 'Lab' }[c])).join(', ') || '없음'}`);
      if (F.info.pdfx) details.push(`PDF/X 출력 조건: ${F.info.pdfx}${F.info.outputIntent ? ' / ' + F.info.outputIntent : ''}`);
      if (press && S.color === 'color' && rgb.length) {
        status = 'warn';
        summary = `글자·도형에 RGB 색상이 쓰인 페이지 ${rgb.length}쪽 — CMYK 변환 시 색이 탁해질 수 있음`;
        rgb.forEach(i => note(i, 'warn', '글자·도형에 RGB 색상 사용', null, 'color'));
        if (rgbBlack.length) details.push(`검정 글자가 RGB로 지정된 페이지: ${pageRanges(rgbBlack)}쪽 — 4색 검정으로 분해되면 글자가 번져 보일 수 있음 (K100 권장)`);
      } else if (press && S.color === 'mono' && rgb.length) {
        status = 'info'; summary = `RGB 요소가 있으나 흑백 인쇄라 영향 적음`;
      } else if (rgb.length) {
        status = 'info'; summary = `RGB 사용 (${press ? '' : '사무용 프린터는 '}문제 없음)`;
      } else summary = !used.length ? '글자·도형 없음' : cmyk ? 'CMYK / 흑백 색상만 사용' : '흑백(Gray) 색상만 사용';
      details.push('※ 이미지는 \'이미지 색상 모드\' 항목에서 따로 검사합니다.');
      checks.push({ id: 'colormode', title: '색상 모드 (글자·도형)', status, summary, details, pages: status === 'warn' ? rgb : [] });
    }

    // 9. 컬러 / 흑백 페이지 -------------------------------------------------
    {
      const col = pages.filter(P => P.isColor).map(P => P.index);
      const details = [];
      if (col.length) details.push(`컬러 페이지: ${pageRanges(col)}쪽`);
      if (col.length < n) details.push(`흑백 페이지: ${pageRanges(pages.filter(P => !P.isColor).map(P => P.index))}쪽`);
      let status = 'info';
      let summary = `컬러 ${col.length}쪽 · 흑백 ${n - col.length}쪽`;
      if (S.color === 'mono' && col.length) {
        status = 'warn';
        summary += ' — 흑백 인쇄 시 색이 회색으로 바뀜. 색으로만 구분한 정보(빨간 글씨, 그래프 등) 확인';
        col.forEach(i => { const P = pages[i]; note(i, 'warn', '컬러 요소 있음 (흑백 인쇄 시 회색)', P.raster && P.raster.colorBoxN, 'mono'); });
      }
      checks.push({ id: 'colorpages', title: '컬러 / 흑백 페이지', status, summary, details, pages: S.color === 'mono' ? col : [] });
    }

    // 10. 별색 ----------------------------------------------------------
    {
      const map = new Map();
      pages.forEach(P => (P.spots || []).forEach(s => { if (!map.has(s)) map.set(s, []); map.get(s).push(P.index); }));
      if (map.size) {
        let st = press ? 'warn' : 'info';
        const ps = [...new Set([...map.values()].flat())];
        ps.forEach(i => note(i, st, `별색 사용: ${pages[i].spots.join(', ')}`, null, 'spot'));
        const details = ['줄을 누르면 해당 페이지의 분판 미리보기(그 별색 판만)로 이동합니다.'];
        const CUT = /칼선|도무송|cut|die|crease|perf|재단|오시|미싱|varnish|바니쉬|코팅|박|foil|white|화이트/i;
        let cutKO = 0;
        for (const [name, pgs] of map.entries()) {
          let op = 0, ko = 0;
          pgs.forEach(i => { const e = pages[i].ov && pages[i].ov.spot[name]; if (e) { op += e.op; ko += e.ko; } });
          const isCut = CUT.test(name);
          const opTxt = op + ko === 0 ? '이미지·그라데이션에만 사용' : op && ko ? `중복인쇄 ${op}개 · 녹아웃 ${ko}개 (섞여 있음)` : op ? `모두 중복인쇄 (${op}개)` : `중복인쇄 없음 — 모두 녹아웃 (${ko}개)`;
          let hint = '';
          if (isCut && ko) { hint = ' ⚠ 후가공(칼선·코팅 등)용 별색이 녹아웃이면 그 아래 그림이 비어 인쇄됨 → 중복인쇄 필요'; cutKO++; }
          else if (isCut) hint = ' — 후가공(칼선·코팅 등)용으로 보임: 실제 잉크로 인쇄되지 않게 처리됐는지 확인';
          details.push(`■ ${name}: ${pageRanges(pgs)}쪽 · ${opTxt}${hint}`);
          pgs.slice(0, 40).forEach(i => {
            const e = pages[i].ov && pages[i].ov.spot[name];
            const t = e ? (e.op && e.ko ? `중복인쇄 ${e.op} · 녹아웃 ${e.ko}` : e.op ? `중복인쇄 ${e.op}` : `녹아웃 ${e.ko}`) : '이미지·그라데이션';
            details.push({ level: isCut && e && e.ko ? 'warn' : 'info', page: i, text: `${name} — ${t}`, sep: { solo: name } });
          });
        }
        if (cutKO && press) st = 'error';
        if (press) details.push('별색 인쇄를 의도한 것이 아니라면 CMYK로 변환하세요.');
        checks.push({
          id: 'spot', title: '별색 (Spot color)', status: st,
          summary: `별색 ${map.size}개 사용: ${[...map.keys()].slice(0, 3).join(', ')}${map.size > 3 ? ' 외' : ''}` + (cutKO ? ` — 후가공 별색 녹아웃 ${cutKO}개` : ''),
          details, pages: ps,
        });
      } else checks.push({ id: 'spot', title: '별색 (Spot color)', status: 'ok', summary: '별색 없음', details: [], pages: [] });
    }

    // 11. 빈 페이지 -------------------------------------------------------
    {
      const blank = pages.filter(P => P.isBlank).map(P => P.index);
      blank.forEach(i => note(i, 'warn', '빈 페이지', null, 'blank'));
      checks.push({
        id: 'blank', title: '빈 페이지', status: blank.length ? 'warn' : 'ok',
        summary: blank.length ? `빈 페이지 ${blank.length}쪽: ${pageRanges(blank)}쪽 — 의도한 백면인지 확인` : '빈 페이지 없음',
        details: [], pages: blank,
      });
    }

    // 12. 가는 선 -------------------------------------------------------
    {
      const bad = pages.filter(P => P.hairline && (P.hairline.count || P.hairline.zero));
      bad.forEach(P => note(P.index, 'warn', `가는 선 ${P.hairline.count + P.hairline.zero}개${P.hairline.zero ? ' (두께 0 포함)' : ''}`, null, 'line'));
      const zero = bad.reduce((s, P) => s + P.hairline.zero, 0);
      checks.push({
        id: 'line', title: '가는 선', status: bad.length ? 'warn' : 'ok',
        summary: bad.length ? `0.25pt(0.09mm)보다 가는 선이 있는 페이지 ${bad.length}쪽 — 인쇄 시 흐리거나 끊길 수 있음` : '너무 가는 선 없음',
        details: zero ? [`두께 0으로 지정된 선 ${zero}개 — 장비에 따라 거의 보이지 않게 인쇄됨`] : [],
        pages: bad.map(P => P.index),
      });
    }

    // 13. 중복인쇄 (오버프린트) — 일반 색 ------------------------------------
    {
      const sum = (k) => pages.reduce((s, P) => s + (P.ov ? P.ov[k] : 0), 0);
      const white = pages.filter(P => P.ov && P.ov.white), color = pages.filter(P => P.ov && P.ov.color);
      const nBlack = sum('black'), nBlackText = sum('blackText'), nBlackTextKO = sum('blackTextKO');
      const details = ['줄을 누르면 해당 페이지의 분판 미리보기(중복인쇄 영역 표시)로 이동합니다.'];
      let status = 'ok', summary;
      const bad = [];
      if (white.length) {
        const lv = press ? 'error' : 'warn';
        white.forEach(P => { bad.push(P.index); note(P.index, lv, `흰색 개체 중복인쇄 ${P.ov.white}개 — 인쇄 시 사라짐`, null, 'overprint'); details.push({ level: lv, page: P.index, text: `흰색 개체 ${P.ov.white}개에 중복인쇄 — 색 위에 놓이면 인쇄 시 사라짐 (분판에서 확인)`, sep: { overprint: true } }); });
      }
      if (color.length) {
        const lv = press ? 'warn' : 'info';
        color.forEach(P => { bad.push(P.index); if (lv === 'warn') note(P.index, lv, `색상 개체 중복인쇄 ${P.ov.color}개`, null, 'overprint'); details.push({ level: lv, page: P.index, text: `색상(CMYK) 개체 ${P.ov.color}개 중복인쇄 — 아래 색과 섞여 인쇄됨`, sep: { overprint: true } }); });
      }
      const sW = sum('white'), sC = sum('color');
      if (sW) { status = press ? 'error' : 'warn'; summary = `흰색 개체 중복인쇄 ${sW}개 (${white.length}쪽) — 색 위에 놓인 흰색은 인쇄 시 사라짐`; }
      else if (sC) { status = press ? 'warn' : 'info'; summary = `색상 개체 중복인쇄 ${sC}개 (${color.length}쪽) — 아래 색과 섞여 인쇄되므로 의도 확인`; }
      else if (nBlack) summary = `검정(K100) 중복인쇄 ${nBlack}개 — 일반적으로 권장되는 설정`;
      else summary = '중복인쇄 설정 없음';
      if (sW && sC) summary += `, 색상 개체 중복인쇄 ${sC}개`;
      if (nBlack) details.push(`검정(K100) 중복인쇄 ${nBlack}개 (글자 ${nBlackText}개) — 정상: 검정이 아래 색 위에 겹쳐 찍혀 틈이 생기지 않음`);
      if (press && nBlackTextKO) details.push(`검정(K100) 글자 ${nBlackTextKO}개가 녹아웃 — 색 배경 위 작은 검정 글자는 중복인쇄를 권장 (인쇄소에서 자동 처리하는 경우도 많음)`);
      const nOut = sum('outside');
      if (nOut) details.push(`재단선 밖(도련·여백·재단 표시 영역)의 중복인쇄 개체 ${nOut}개는 잘려 나가므로 검사에서 제외했습니다.`);
      if (!press) details.push('사무용 프린터는 중복인쇄 설정을 무시하는 경우가 많습니다.');
      checks.push({ id: 'overprint', title: '중복인쇄 (오버프린트)', status, summary, details, pages: [...new Set(bad)] });
    }

    // 13-2. 투명도 ----------------------------------------------------------
    {
      const tr = pages.filter(P => P.transparency).map(P => P.index);
      checks.push({
        id: 'transp', title: '투명도', status: tr.length ? 'info' : 'ok',
        summary: tr.length ? `투명 효과가 있는 페이지 ${tr.length}쪽 — 미리보기와 출력 결과 비교 권장` : '투명 효과 없음',
        details: tr.length ? [`투명 효과(불투명도·그림자·혼합 모드·투명 PNG 등): ${pageRanges(tr)}쪽`] : [], pages: tr,
      });
    }

    // 14. 주석 / 양식 ---------------------------------------------------
    {
      const printed = [], hidden = [], forms = [];
      pages.forEach(P => (P.annots || []).forEach(a => {
        if (a.subtype === 'Link') return;
        if (a.subtype === 'Widget') { forms.push(P.index); note(P.index, 'warn', '양식 입력칸', a.rectN, 'annot'); return; }
        if (a.print && !a.hidden) { printed.push(P.index); note(P.index, 'warn', `인쇄되는 주석(${a.subtype})`, a.rectN, 'annot'); }
        else hidden.push(P.index);
      }));
      const details = [];
      if (printed.length) details.push(`인쇄되는 주석/메모/스탬프: ${pageRanges(printed)}쪽`);
      if (forms.length) details.push(`양식 입력칸: ${pageRanges(forms)}쪽 — 입력 내용이 인쇄되는지, 테두리가 남는지 확인`);
      if (hidden.length) details.push(`인쇄되지 않는 주석(메모 등): ${pageRanges(hidden)}쪽 — 화면에서만 보임`);
      const bad = [...new Set(printed.concat(forms))];
      checks.push({
        id: 'annot', title: '주석 / 양식 필드', status: bad.length ? 'warn' : hidden.length ? 'info' : 'ok',
        summary: bad.length ? `인쇄에 영향을 주는 주석·입력칸이 있는 페이지 ${bad.length}쪽` : hidden.length ? '인쇄되지 않는 주석만 있음' : '주석 없음',
        details, pages: bad,
      });
    }

    // 15. 레이어 -------------------------------------------------------
    {
      const oc = pages.filter(P => P.usesOC).map(P => P.index);
      const has = F.info.ocgs.length || oc.length;
      checks.push({
        id: 'layer', title: '레이어', status: has ? 'warn' : 'ok',
        summary: has ? `레이어 ${F.info.ocgs.length}개 — 화면 표시와 인쇄 결과가 다를 수 있음` : '레이어 없음',
        details: has ? [`레이어: ${F.info.ocgs.join(', ') || '(이름 없음)'}`, '미리보기는 "인쇄" 기준으로 그려졌습니다. 인쇄소에는 레이어를 병합한 PDF를 권장합니다.'] : [],
        pages: oc,
      });
    }

    // 16. 보안 / 분석 오류 ------------------------------------------------
    {
      const errs = pages.filter(P => P.parseError && !F.info.encrypted).map(P => P.index);
      const details = [];
      let status = 'ok', summary = '보안 설정 없음';
      if (F.info.encrypted) { status = 'warn'; summary = '암호/보안 설정된 PDF — 인쇄소에서 열기·출력이 제한될 수 있고 일부 검사가 생략됨'; }
      if (errs.length) { status = worst([status, 'warn']); details.push(`구조 분석 중 문제가 있었던 페이지: ${pageRanges(errs)}쪽 (파일 손상 가능성)`); errs.forEach(i => note(i, 'warn', '구조 분석 실패: ' + pages[i].parseError, null, 'parse')); if (!F.info.encrypted) summary = '일부 페이지 구조 분석 실패'; }
      checks.push({ id: 'security', title: '보안 / 파일 상태', status, summary, details, pages: errs });
    }

    // 정렬 / 종합
    const order = { error: 0, warn: 1, info: 2, ok: 3, skip: 4 };
    const sortedChecks = checks.slice().sort((a, b) => order[a.status] - order[b.status]);
    const counts = { error: 0, warn: 0, info: 0, ok: 0, skip: 0 };
    checks.forEach(c => counts[c.status]++);
    const verdict = counts.error ? 'error' : counts.warn ? 'warn' : 'ok';
    const pageLevel = pageIssues.map(list => list.length ? worst(list.map(x => x.level)) : 'ok');
    return { checks: sortedChecks, counts, verdict, pageIssues, pageLevel };
  }

  window.PDFRules = { evaluate, DEFAULTS, PRESETS, SIZES };
})();
