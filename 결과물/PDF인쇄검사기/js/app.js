/* 화면 / 흐름 제어 */
(function () {
  'use strict';
  const { esc, fmt, pageRanges, fileSize, sizeLabel } = PC;
  const $ = (id) => document.getElementById(id);
  const ICON = { error: '!', warn: '!', info: 'i', ok: '✓', skip: '–' };
  const LEVEL_KO = { error: '오류', warn: '주의', info: '참고', ok: '통과', skip: '생략' };

  const state = {
    settings: loadSettings(), facts: null, result: null, pdf: null, urls: [], filter: null, modalIdx: -1, runId: 0, busy: false,
    srcDoc: null, modalMode: 'print', sepCache: new Map(),
    sepUI: { off: new Set(), solo: null, gray: true, op: false, tac: false, tacLimit: 300 },
  };

  // ---------------- 설정 ----------------
  function loadSettings() {
    let s = {};
    try { s = JSON.parse(localStorage.getItem('pdfPrintChecker.settings') || '{}'); } catch (e) { }
    return Object.assign({}, PDFRules.DEFAULTS, s);
  }
  function saveSettings() { try { localStorage.setItem('pdfPrintChecker.settings', JSON.stringify(state.settings)); } catch (e) { } }

  function initSettings() {
    const sel = $('selTarget');
    PDFRules.SIZES.forEach(([name, w, h]) => {
      const o = document.createElement('option'); o.value = name; o.textContent = `${name} ${w}×${h}mm`; sel.appendChild(o);
    });
    document.querySelectorAll('.seg').forEach(seg => {
      seg.addEventListener('click', (e) => {
        const b = e.target.closest('button'); if (!b) return;
        const key = seg.dataset.key;
        state.settings[key] = b.dataset.v;
        if (key === 'mode') Object.assign(state.settings, PDFRules.PRESETS[b.dataset.v]);
        syncSettings(); onSettingsChanged();
      });
    });
    document.querySelectorAll('.settings select, .settings input').forEach(el => {
      el.addEventListener('change', () => {
        const k = el.dataset.key;
        state.settings[k] = el.type === 'number' ? Math.max(0, parseFloat(el.value) || 0) : el.value;
        onSettingsChanged();
      });
    });
    $('btnReset').addEventListener('click', () => { state.settings = Object.assign({}, PDFRules.DEFAULTS); syncSettings(); onSettingsChanged(); });
    syncSettings();
  }
  function syncSettings() {
    const s = state.settings;
    document.querySelectorAll('.seg').forEach(seg => seg.querySelectorAll('button').forEach(b => b.classList.toggle('on', s[seg.dataset.key] === b.dataset.v)));
    document.querySelectorAll('.settings select, .settings input').forEach(el => { el.value = s[el.dataset.key]; });
    document.querySelector('[data-key=bleedMM]').disabled = s.mode !== 'press';
  }
  function onSettingsChanged() {
    saveSettings();
    if (state.facts && !state.busy) evaluateAndRender();
  }

  // ---------------- 파일 입력 ----------------
  function initInput() {
    const fi = $('fileInput');
    $('btnOpen').addEventListener('click', () => fi.click());
    $('btnPick').addEventListener('click', () => fi.click());
    fi.addEventListener('change', () => { if (fi.files[0]) run(fi.files[0]); fi.value = ''; });
    let depth = 0;
    window.addEventListener('dragenter', (e) => { e.preventDefault(); depth++; document.body.classList.add('dragging'); });
    window.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; document.body.classList.remove('dragging'); } });
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => {
      e.preventDefault(); depth = 0; document.body.classList.remove('dragging');
      const f = [...(e.dataTransfer.files || [])].find(x => /\.pdf$/i.test(x.name) || x.type === 'application/pdf');
      if (f) run(f); else if (e.dataTransfer.files.length) alert('PDF 파일만 검사할 수 있습니다.');
    });
    $('btnPrint').addEventListener('click', () => window.print());
  }

  // ---------------- 실행 ----------------
  async function run(file) {
    const runId = ++state.runId;
    state.busy = true;
    cleanup();
    $('drop').hidden = true; $('workspace').hidden = false;
    $('fileName').textContent = file.name;
    document.title = file.name + ' — PDF 인쇄 검사기';
    $('btnPrint').disabled = true;
    $('grid').innerHTML = ''; $('checks').innerHTML = ''; $('docinfo').innerHTML = '';
    setFilter(null);
    setVerdictBusy('파일 읽는 중…');
    progress(0, '파일 읽는 중');

    let bytes;
    try { bytes = new Uint8Array(await file.arrayBuffer()); }
    catch (e) { return fail('파일을 읽을 수 없습니다: ' + e.message); }
    if (runId !== state.runId) return;

    // 1) 구조 분석
    let struct;
    try {
      setVerdictBusy('PDF 구조 분석 중…');
      struct = await PDFStructure.analyzeStructure(bytes.slice(), (k, n) => progress(k / n * 0.25, `구조 분석 ${k}/${n}`));
    } catch (e) {
      console.warn('구조 분석 실패', e);
      struct = null;
    }
    if (runId !== state.runId) return;

    // 2) 렌더링 분석
    let pdf;
    try { pdf = await PDFRaster.openPdf(bytes.slice()); }
    catch (e) {
      const msg = e && e.name === 'PasswordException' ? '암호가 걸린 PDF는 열 수 없습니다. 암호를 해제한 뒤 다시 시도하세요.' : 'PDF를 열 수 없습니다 (손상된 파일일 수 있음): ' + (e && e.message);
      return fail(msg);
    }
    state.pdf = pdf;
    const n = pdf.numPages;
    if (!struct || struct.pages.length !== n) {
      const pages = [];
      for (let i = 0; i < n; i++) {
        const pg = await pdf.getPage(i + 1);
        const v = pg.view;
        pages.push({
          index: i, rotate: pg.rotate || 0, mediaBox: v, cropBox: v, trimBox: null, bleedBox: null,
          fonts: [], images: [], colorUse: {}, spots: [], annots: [], hairline: { count: 0, zero: 0 },
          parseError: struct ? '구조 분석 결과와 페이지 수 불일치' : '구조 분석 실패 (파일 구조가 비정상)',
        });
      }
      struct = { info: Object.assign({ version: '?', encrypted: false, ocgs: [], producer: '', creator: '' }, struct && struct.info), pages };
    }
    state.srcDoc = struct.doc && !struct.info.encrypted ? struct.doc : null;
    state.facts = { fileName: file.name, fileSize: file.size, info: struct.info, pages: struct.pages };
    renderDocInfo();

    struct.pages.forEach(P => $('grid').appendChild(makeCard(P)));
    for (let i = 0; i < n; i++) {
      if (runId !== state.runId) return;
      const P = struct.pages[i];
      setVerdictBusy(`페이지 검사 중… (${i + 1}/${n})`);
      progress(0.25 + (i + 1) / n * 0.75, `페이지 ${i + 1}/${n}`);
      try { await PDFRaster.analyzePageRaster(pdf, P); state.urls.push(P.raster.url); }
      catch (e) { console.warn('렌더 실패', i, e); P.renderError = e.message; P.parseError = P.parseError || ('렌더링 실패: ' + e.message); }
      fillCard(P);
    }
    if (runId !== state.runId) return;
    // 렌더링 실패 페이지를 위한 기본값
    struct.pages.forEach(P => {
      if (P.trimWmm == null) {
        const c = P.cropBox; P.trimEff = c; P.trimSource = 'none';
        P.trimWmm = (c[2] - c[0]) * PC.PT2MM; P.trimHmm = (c[3] - c[1]) * PC.PT2MM; P.bleedMin = 0;
        P.cropWmm = P.trimWmm; P.cropHmm = P.trimHmm;
      }
    });
    state.busy = false;
    progress(1, `검사 완료 · ${n}쪽`, true);
    renderDocInfo();
    evaluateAndRender();
    $('btnPrint').disabled = false;
  }

  function cleanup() {
    state.urls.forEach(u => URL.revokeObjectURL(u)); state.urls = [];
    if (state.pdf) { try { state.pdf.destroy(); } catch (e) { } }
    state.pdf = null; state.facts = null; state.result = null; state.srcDoc = null; state.sepCache.clear();
  }
  function fail(msg) {
    state.busy = false;
    $('verdict').className = 'verdict error';
    $('verdict').innerHTML = `<img class="v-img" src="img/cone.png" alt=""><div><div class="big">검사할 수 없음</div><div class="sub">${esc(msg)}</div></div>`;
    progress(0, '실패', true);
  }
  function progress(r, text, done) {
    $('progressFill').style.width = (r * 100).toFixed(1) + '%';
    $('progressText').textContent = text;
    $('progress').classList.toggle('done', !!done);
  }
  function setVerdictBusy(text) {
    $('verdict').className = 'verdict busy';
    $('verdict').innerHTML = `<img class="v-img bob" src="img/helmet.png" alt=""><div><div class="big" style="font-size:19px">${esc(text)}</div><div class="sub">페이지가 많으면 시간이 조금 걸립니다.</div></div>`;
  }

  // ---------------- 보고서 ----------------
  function renderDocInfo() {
    const F = state.facts; if (!F) return;
    const I = F.info, P0 = F.pages[0];
    const rows = [
      ['파일', `${F.fileName} (${fileSize(F.fileSize)})`],
      ['페이지', `${F.pages.length}쪽`],
    ];
    if (P0 && P0.trimWmm != null) rows.push(['완성 크기', sizeLabel(P0.trimWmm, P0.trimHmm) + (F.pages.length > 1 ? ' (1쪽 기준)' : '')]);
    rows.push(['PDF 버전', I.version + (I.pdfx ? ` · ${I.pdfx}` : '')]);
    if (I.creator) rows.push(['작성 프로그램', I.creator]);
    if (I.producer) rows.push(['PDF 변환', I.producer]);
    $('docinfo').innerHTML = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
  }

  function evaluateAndRender() {
    const R = PDFRules.evaluate(state.facts, state.settings);
    state.result = R;
    const V = { ok: ['img/mascot.png', '인쇄 가능', '검사한 항목에서 문제가 발견되지 않았습니다.'], warn: ['img/helmet.png', '확인 필요', '인쇄는 가능하지만 확인할 항목이 있습니다.'], error: ['img/cone.png', '수정 필요', '인쇄 전에 고쳐야 할 문제가 있습니다.'] }[R.verdict];
    const c = R.counts;
    $('verdict').className = 'verdict ' + R.verdict;
    $('verdict').innerHTML = `<img class="v-img v-${R.verdict}" src="${V[0]}" alt=""><div><div class="big">${V[1]}</div><div class="sub">${V[2]}</div>
      <div class="counts">${['error', 'warn', 'info', 'ok'].filter(k => c[k]).map(k => `<span><i class="st small ${k}">${ICON[k]}</i>${LEVEL_KO[k]} ${c[k]}</span>`).join('')}</div></div>`;

    const open = new Set([...document.querySelectorAll('.check.open')].map(el => el.dataset.id));
    $('checks').innerHTML = R.checks.map(ch => {
      const isOpen = open.size ? open.has(ch.id) : (ch.status === 'error' || ch.status === 'warn');
      const chips = ch.pages.length ? `<div class="chips">${ch.pages.slice(0, 80).map(i => `<button type="button" class="chip" data-page="${i}">${i + 1}쪽</button>`).join('')}${ch.pages.length > 80 ? `<span class="muted">… 외 ${ch.pages.length - 80}쪽</span>` : ''}</div>
        <div style="margin-top:8px"><button type="button" class="link" data-filter="${ch.id}">미리보기에서 해당 페이지만 보기</button></div>` : '';
      const MARK = { error: '✕', warn: '△', info: '•' };
      const det = ch.details.length ? `<ul>${ch.details.map((d, di) => typeof d === 'string'
        ? `<li>${esc(d)}</li>`
        : `<li class="ditem ${d.level}"><button type="button" data-check="${ch.id}" data-di="${di}" title="${d.page + 1}쪽에서 위치 보기">
            <span class="mk">${MARK[d.level] || '•'}</span><b>${esc(d.pageLabel || (d.page + 1))}쪽</b> ${esc(d.text)}<span class="go">보기 ›</span></button></li>`).join('')}</ul>` : '';
      const hasBody = det || chips;
      return `<div class="check ${ch.status}${isOpen && hasBody ? ' open' : ''}" data-id="${ch.id}">
        <button type="button" class="check-head" ${hasBody ? '' : 'style="cursor:default"'}>
          <span class="st ${ch.status}">${ICON[ch.status]}</span>
          <span class="check-main"><div class="check-title">${esc(ch.title)}</div><div class="check-sum">${esc(ch.summary)}</div></span>
          ${hasBody ? '<span class="chev">›</span>' : ''}
        </button>
        ${hasBody ? `<div class="check-body">${det}${chips}</div>` : ''}
      </div>`;
    }).join('');
    state.facts.pages.forEach(P => fillCard(P));
    applyFilter();
    if (state.modalIdx >= 0) showModal(state.modalIdx);
  }

  function initReportEvents() {
    $('checks').addEventListener('click', (e) => {
      const di = e.target.closest('[data-di]');
      if (di) {
        const ch = state.result.checks.find(c => c.id === di.dataset.check);
        const d = ch && ch.details[+di.dataset.di];
        if (d) showModal(d.page, d.rectN, d.sep);
        return;
      }
      const chip = e.target.closest('[data-page]');
      if (chip) { showModal(+chip.dataset.page); return; }
      const f = e.target.closest('[data-filter]');
      if (f) {
        const ch = state.result.checks.find(c => c.id === f.dataset.filter);
        setFilter({ title: ch.title, pages: new Set(ch.pages) });
        return;
      }
      const head = e.target.closest('.check-head');
      if (head && head.parentElement.querySelector('.check-body')) head.parentElement.classList.toggle('open');
    });
    $('btnClearFilter').addEventListener('click', () => setFilter(null));
  }

  // ---------------- 미리보기 카드 ----------------
  function makeCard(P) {
    const d = document.createElement('div');
    d.className = 'pcard'; d.dataset.idx = P.index; d.id = 'pc' + P.index;
    const ar = P.cropBox ? ((P.rotate === 90 || P.rotate === 270) ? (P.cropBox[3] - P.cropBox[1]) / (P.cropBox[2] - P.cropBox[0]) : (P.cropBox[2] - P.cropBox[0]) / (P.cropBox[3] - P.cropBox[1])) : 210 / 297;
    d.innerHTML = `<div class="sheet"><div class="ph" style="aspect-ratio:${ar}">분석 대기</div></div><div class="meta"><span class="pno">${P.index + 1}쪽</span></div>`;
    d.addEventListener('click', () => showModal(P.index));
    return d;
  }
  function fillCard(P) {
    const card = $('pc' + P.index); if (!card) return;
    const sheet = card.querySelector('.sheet');
    if (P.raster && !sheet.querySelector('img')) {
      sheet.innerHTML = `<img alt="${P.index + 1}쪽 미리보기" src="${P.raster.url}"><svg class="ov"></svg>`;
    } else if (!P.raster && P.renderError) {
      sheet.querySelector('.ph') && (sheet.querySelector('.ph').textContent = '렌더링 실패');
    }
    const svg = sheet.querySelector('svg.ov');
    const issues = state.result ? state.result.pageIssues[P.index] : [];
    if (svg) { svg.outerHTML = overlaySVG(P, issues); }
    const lv = state.result ? state.result.pageLevel[P.index] : 'ok';
    card.classList.remove('lv-error', 'lv-warn');
    if (lv === 'error' || lv === 'warn') card.classList.add('lv-' + lv);
    const ne = issues.filter(x => x.level === 'error' && !x.dup).length, nw = issues.filter(x => x.level === 'warn' && !x.dup).length;
    card.querySelector('.meta').innerHTML = `<span class="pno">${P.index + 1}쪽</span>${P.trimWmm != null ? `<span class="dim">${esc(shortSize(P))}</span>` : ''}
      ${P.isColor ? '<span class="tag color">컬러</span>' : (P.raster ? '<span class="tag">흑백</span>' : '')}
      ${ne ? `<span class="tag err">오류 ${ne}</span>` : ''}${nw ? `<span class="tag warn">주의 ${nw}</span>` : ''}`;
  }
  function shortSize(P) {
    const m = PC.matchSize(P.trimWmm, P.trimHmm);
    return m ? m.name.split(' ')[0] + (P.trimWmm > P.trimHmm ? ' 가로' : '') : `${fmt(P.trimWmm, 0)}×${fmt(P.trimHmm, 0)}`;
  }

  function overlaySVG(P, issues) {
    const R = P.raster; if (!R) return '<svg class="ov"></svg>';
    const W = 1000, H = Math.round(1000 * R.H / R.W);
    const r = (n) => [n[0] * W, n[1] * H, (n[2] - n[0]) * W, (n[3] - n[1]) * H].map(v => v.toFixed(1));
    const t = R.trimN;
    let s = `<svg class="ov" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">`;
    if (P.bleedMin > 0.2) {
      const [x, y, w, h] = r(t);
      s += `<path class="bleed" fill-rule="evenodd" d="M0 0H${W}V${H}H0Z M${x} ${y}h${w}v${h}h${-w}Z"><title>도련 영역 (재단 시 잘려 나감)</title></path>`;
      s += `<rect class="trim" x="${x}" y="${y}" width="${w}" height="${h}"><title>재단선</title></rect>`;
    }
    const sm = state.settings.safeMM;
    if (sm > 0) {
      const dx = sm * R.pxPerMM / R.W, dy = sm * R.pxPerMM / R.H;
      const sn = [t[0] + dx, t[1] + dy, t[2] - dx, t[3] - dy];
      if (sn[2] > sn[0] && sn[3] > sn[1]) {
        const [x, y, w, h] = r(sn);
        s += `<rect class="safe" x="${x}" y="${y}" width="${w}" height="${h}"><title>안전선 (${sm}mm)</title></rect>`;
      }
    }
    (issues || []).forEach((it, k) => {
      if (!it.rectN) return;
      let [x, y, w, h] = r(it.rectN).map(Number);
      const pad = 3; x -= pad; y -= pad; w += pad * 2; h += pad * 2;
      s += `<rect class="iss ${it.level}" data-k="${k}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(w, 6).toFixed(1)}" height="${Math.max(h, 6).toFixed(1)}"><title>${esc(it.text)}</title></rect>`;
    });
    return s + '</svg>';
  }

  // ---------------- 필터 / 토글 ----------------
  function setFilter(f) {
    state.filter = f;
    $('filterbar').hidden = !f;
    if (f) $('filterText').textContent = `'${f.title}' 해당 페이지 ${f.pages.size}쪽만 표시 중`;
    applyFilter();
    if (f && f.pages.size) { const first = Math.min(...f.pages); const el = $('pc' + first); el && el.scrollIntoView({ block: 'nearest' }); }
  }
  function applyFilter() {
    const only = $('tgOnly').checked;
    const R = state.result;
    document.querySelectorAll('.pcard').forEach(c => {
      const i = +c.dataset.idx;
      let show = true;
      if (state.filter) show = state.filter.pages.has(i);
      if (show && only && R) show = R.pageLevel[i] === 'error' || R.pageLevel[i] === 'warn';
      c.hidden = !show;
    });
  }
  function initToggles() {
    const ws = $('workspace');
    const bind = (id, cls) => { const el = $(id); const f = () => { ws.classList.toggle(cls, !el.checked); $('modal').classList.toggle(cls, !el.checked); }; el.addEventListener('change', f); f(); };
    bind('tgTrim', 'hide-trim'); bind('tgSafe', 'hide-safe'); bind('tgIssue', 'hide-issue');
    $('tgOnly').addEventListener('change', applyFilter);
    const z = $('zoom');
    let saved = null; try { saved = localStorage.getItem('pdfPrintChecker.zoom'); } catch (e) { }
    if (saved) z.value = saved;
    const fz = () => { document.documentElement.style.setProperty('--thumb', z.value + 'px'); try { localStorage.setItem('pdfPrintChecker.zoom', z.value); } catch (e) { } };
    z.addEventListener('input', fz); fz();
  }

  // ---------------- 페이지 상세 ----------------
  let hiResToken = 0;
  function showModal(i, focusRectN, sepOpts) {
    const F = state.facts; if (!F || i < 0 || i >= F.pages.length) return;
    if (focusRectN !== undefined || state.modalIdx !== i) state.focus = focusRectN ? { page: i, rectN: focusRectN } : null;
    if (sepOpts) {
      state.modalMode = 'sep';
      state.sepUI.solo = sepOpts.solo || null;
      state.sepUI.op = !!sepOpts.overprint;
      if (!sepOpts.solo) state.sepUI.off = new Set();
    }
    state.modalIdx = i;
    const P = F.pages[i];
    const issues = state.result ? state.result.pageIssues[i] : [];
    $('modal').hidden = false;
    $('mTitle').textContent = `${i + 1}쪽 / ${F.pages.length}쪽`;
    $('mPrev').disabled = i === 0; $('mNext').disabled = i === F.pages.length - 1;
    $('mTabs').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === state.modalMode));
    if (state.modalMode === 'sep') { showSep(i); return; }
    sepToken++;

    const view = $('mView');
    if (P.raster) {
      const R = P.raster;
      const vw = view.clientWidth - 40, vh = view.clientHeight - 40;
      const sc = Math.min(vw / R.W, vh / R.H);
      const w = Math.max(100, Math.floor(R.W * sc)), h = Math.max(100, Math.floor(R.H * sc));
      let ov = overlaySVG(P, issues);
      if (state.focus && state.focus.page === i) { // 목록에서 누른 이미지 위치 강조
        const f = state.focus.rectN, VW = 1000, VH = Math.round(1000 * R.H / R.W), pad = 8;
        ov = ov.replace('</svg>', `<rect class="focus" x="${(f[0] * VW - pad).toFixed(1)}" y="${(f[1] * VH - pad).toFixed(1)}" width="${((f[2] - f[0]) * VW + pad * 2).toFixed(1)}" height="${((f[3] - f[1]) * VH + pad * 2).toFixed(1)}"/></svg>`);
      }
      view.innerHTML = `<div class="sheet" style="width:${w}px;height:${h}px"><img alt="" src="${R.url}">${ov}</div>`;
      const fr = view.querySelector('rect.focus');
      if (fr) setTimeout(() => fr.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' }), 50);
      // 고해상도 다시 그리기
      const token = ++hiResToken;
      const want = Math.max(w, h) * (window.devicePixelRatio || 1);
      if (want > Math.max(R.W, R.H) * 1.1 && state.pdf) {
        PDFRaster.renderToCanvas(state.pdf, i, Math.min(want, 3200)).then(({ canvas, page }) => {
          page.cleanup();
          if (token !== hiResToken || state.modalIdx !== i) return;
          const img = view.querySelector('img'); if (img) img.replaceWith(canvas);
        }).catch(() => { });
      }
    } else view.innerHTML = `<p style="color:#fff">이 페이지는 미리보기를 만들 수 없습니다.</p>`;

    // 측면 정보
    const lvOrder = { error: 0, warn: 1, info: 2 };
    const iss = issues.filter(x => !x.dup).sort((a, b) => lvOrder[a.level] - lvOrder[b.level]);
    let h = `<h3>이 페이지의 문제 (${iss.length})</h3>`;
    h += iss.length ? iss.map((it, k) => `<div class="issue" data-k="${issues.indexOf(it)}"><span class="st small ${it.level}">${ICON[it.level]}</span><span>${esc(it.text)}</span></div>`).join('') : '<p class="muted">발견된 문제 없음</p>';
    const b = P.bleedMM;
    const kv = [];
    if (P.trimWmm != null) kv.push(['완성 크기', sizeLabel(P.trimWmm, P.trimHmm)]);
    if (P.cropWmm != null && P.bleedMin > 0.2) kv.push(['전체 크기', `${fmt(P.cropWmm)}×${fmt(P.cropHmm)}mm (도련 포함)`]);
    if (b) kv.push(['도련', P.bleedMin > 0.2 ? `위 ${fmt(b.top)} · 아래 ${fmt(b.bottom)} · 좌 ${fmt(b.left)} · 우 ${fmt(b.right)} mm` : '없음']);
    kv.push(['재단선 기준', { TrimBox: 'TrimBox (파일에 지정됨)', estimated: '크기로 추정', none: '페이지 전체' }[P.trimSource] || '-']);
    if (P.rotate) kv.push(['회전', P.rotate + '°']);
    kv.push(['색상', P.isColor ? '컬러' : '흑백']);
    const cu = P.colorUse || {};
    const used = Object.keys(cu).filter(k => cu[k] > 0 && k !== 'Pattern' && k !== 'Other');
    if (used.length) kv.push(['글자·도형 색',used.map(k => ({ RGB: 'RGB', CMYK: 'CMYK', Gray: 'Gray', Spot: '별색', Lab: 'Lab' }[k] || k)).join(', ')]);
    h += `<h3>페이지 정보</h3><dl class="kv">${kv.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`;
    h += `<div class="legend"><span><i style="border-color:#ff2b6a"></i>재단선</span><span><i style="border-color:#1f8bff;border-top-style:dashed"></i>안전선 ${state.settings.safeMM}mm</span><span><i style="border-color:rgba(255,40,120,.4);border-top-width:8px"></i>도련(잘림)</span></div>`;
    if (P.fonts && P.fonts.length) h += `<h3>글꼴 (${P.fonts.length})</h3><ul class="mini">${P.fonts.map(f => `<li>${f.embedded ? '✓' : '<b style="color:var(--err)">✗ 미포함</b>'} ${esc(f.name)} <span class="muted">${esc(f.type)}</span></li>`).join('')}</ul>`;
    const imgs = (P.images || []).filter(im => im.wMM >= 3 && im.hMM >= 3);
    if (imgs.length) h += `<h3>이미지 (${imgs.length})</h3><ul class="mini">${imgs.slice(0, 60).map(im => {
      const d = Math.round(im.dpi);
      const lv = !(im.mask || im.bpc === 1) && d < state.settings.dpiErr ? 'error' : d < state.settings.dpiWarn ? 'warn' : '';
      const k = PC.imageKind(im);
      const cTag = PC.IMG_GROUP_LABEL[k.group] + (k.indexed ? '(인덱스)' : '');
      const cWarn = state.settings.mode === 'press' && state.settings.color === 'color' && (k.group === 'RGB' || k.group === 'Spot');
      const fTag = k.format + (k.alpha ? '·투명' : '');
      return `<li><b style="color:${lv === 'error' ? 'var(--err)' : lv === 'warn' ? 'var(--warn)' : 'inherit'}">${d}dpi</b> · ${fmt(im.wMM, 0)}×${fmt(im.hMM, 0)}mm
        · <span style="${cWarn ? 'color:var(--warn);font-weight:700' : ''}">${esc(cTag)}</span> · <span style="${k.png ? 'color:var(--info);font-weight:700' : ''}">${esc(fTag)}</span>
        <span class="muted">${im.w}×${im.h}px</span></li>`;
    }).join('')}</ul>`;
    if (P.parseError) h += `<h3>분석 메모</h3><p class="muted">${esc(P.parseError)}</p>`;
    $('mSide').innerHTML = h;
  }
  // ---------------- 분판 미리보기 ----------------
  let sepToken = 0;
  async function showSep(i) {
    const view = $('mView'), side = $('mSide');
    const P = state.facts.pages[i];
    if (!state.srcDoc) {
      view.innerHTML = '<p style="color:#fff">이 파일은 분판 미리보기를 만들 수 없습니다 (암호화되었거나 구조 분석 실패).</p>';
      side.innerHTML = ''; return;
    }
    let S = state.sepCache.get(i);
    if (!S) {
      const token = ++sepToken;
      view.innerHTML = '<div class="sep-loading"><div class="spinner"></div><p id="sepProg">분판 계산 중…</p></div>';
      side.innerHTML = '<p class="muted">판(C·M·Y·K·별색)마다 페이지를 다시 그리므로 페이지가 복잡하면 몇 초~수십 초 걸릴 수 있습니다.</p>';
      try {
        const longEdge = Math.round(Math.min(2000, Math.max(1100, Math.max(view.clientWidth, view.clientHeight) * (window.devicePixelRatio || 1))));
        S = await PDFSeparation.build(state.srcDoc, i, longEdge, (t) => { const el = $('sepProg'); if (el && token === sepToken) el.textContent = t; });
        const n = S.W * S.H, tac = new Uint16Array(n);
        S.plates.forEach(p => { const a = p.ink; for (let j = 0; j < n; j++) tac[j] += a[j]; });
        let mx = 0, op = 0; for (let j = 0; j < n; j++) { if (tac[j] > mx) mx = tac[j]; if (S.opmask[j] > 100) op++; }
        S.tac = tac; S.maxTAC = Math.round(mx / 2.55); S.opArea = op / n;
        state.sepCache.set(i, S);
        if (state.sepCache.size > 4) state.sepCache.delete(state.sepCache.keys().next().value);
      } catch (e) {
        console.error(e);
        if (token === sepToken && state.modalIdx === i) view.innerHTML = `<p style="color:#fff">분판 생성 실패: ${esc(e.message)}</p>`;
        return;
      }
      if (token !== sepToken || state.modalIdx !== i || state.modalMode !== 'sep' || $('modal').hidden) return;
    }
    const U = state.sepUI;
    if (U.solo) { U.off = new Set(S.plates.filter(p => p.name !== U.solo).map(p => p.name)); U.solo = null; }

    const vw = view.clientWidth - 40, vh = view.clientHeight - 40;
    const sc = Math.min(vw / S.W, vh / S.H);
    view.innerHTML = `<div class="sheet" style="width:${Math.floor(S.W * sc)}px;height:${Math.floor(S.H * sc)}px"><canvas id="sepCanvas" width="${S.W}" height="${S.H}" style="width:100%;height:100%"></canvas></div>`;
    drawSep(S);

    // 측면: 판 목록
    const allOn = S.plates.every(p => !U.off.has(p.name));
    const pct = (v) => v >= 0.005 ? Math.round(v * 100) + '%' : v > 0 ? '<1%' : '0%';
    let h = `<h3>분판 — 판 ${S.plates.length}개</h3>
      <table class="plates"><thead><tr><th></th><th>판</th><th title="잉크가 묻는 면적">면적</th><th>커서</th></tr></thead><tbody>
      <tr class="all"><td><input type="checkbox" data-all ${allOn ? 'checked' : ''} aria-label="모든 판"></td><td colspan="3"><b>모든 판</b></td></tr>
      ${S.plates.map(p => `<tr class="${p.coverage === 0 ? 'empty' : ''}"><td><input type="checkbox" data-plate="${esc(p.name)}" ${U.off.has(p.name) ? '' : 'checked'} aria-label="${esc(p.label)}"></td>
        <td><button type="button" class="pname" data-solo="${esc(p.name)}" title="이 판만 보기"><i class="sw" style="background:rgb(${p.rgb.join(',')})"></i>${esc(p.label)}${p.kind === 'spot' ? ' <span class="spot-tag">별색</span>' : ''}</button></td>
        <td>${pct(p.coverage)}</td><td data-cur="${esc(p.name)}">–</td></tr>`).join('')}
      <tr class="tot"><td></td><td>총 잉크량 <span class="muted">(최대 ${S.maxTAC}%)</span></td><td></td><td data-cur="__tac">–</td></tr>
      </tbody></table>
      <div class="sep-opts">
        <label><input type="checkbox" data-opt="gray" ${U.gray ? 'checked' : ''}> 판 하나만 볼 때 흑백으로</label>
        <label><input type="checkbox" data-opt="op" ${U.op ? 'checked' : ''}> 중복인쇄 영역 표시 <i class="sw hatch"></i> <span class="muted">(${S.opArea > 0 ? pct(S.opArea) + ' 면적' : '없음'})</span></label>
        <label><input type="checkbox" data-opt="tac" ${U.tac ? 'checked' : ''}> 총 잉크량 <input type="number" data-opt="tacLimit" value="${U.tacLimit}" min="100" max="400" step="10">% 초과 표시 <i class="sw tacsw"></i></label>
      </div>`;
    const ov = P.ov || { spot: {} };
    const rows = [];
    if (ov.white) rows.push(`<li class="bad">✕ 흰색 개체 중복인쇄 ${ov.white}개 — 인쇄 시 사라짐</li>`);
    if (ov.color) rows.push(`<li class="warnc">△ 색상(CMYK) 개체 중복인쇄 ${ov.color}개</li>`);
    if (ov.black) rows.push(`<li>검정(K100) 중복인쇄 ${ov.black}개 <span class="muted">(글자 ${ov.blackText})</span></li>`);
    if (ov.blackTextKO) rows.push(`<li>검정(K100) 글자 녹아웃 ${ov.blackTextKO}개</li>`);
    Object.entries(ov.spot || {}).forEach(([nm, e]) => rows.push(`<li><b>${esc(nm)}</b> (별색): ${e.op ? `중복인쇄 ${e.op}개` : ''}${e.op && e.ko ? ' · ' : ''}${e.ko ? `녹아웃 ${e.ko}개` : ''}</li>`));
    h += `<h3>이 페이지의 중복인쇄 <span class="muted" style="font-weight:400">(재단 영역 안)</span></h3>${rows.length ? `<ul class="mini">${rows.join('')}</ul>` : '<p class="muted">중복인쇄 설정 없음</p>'}`;
    if (ov.outside) h += `<p class="muted">재단선 밖 중복인쇄 개체 ${ov.outside}개는 잘려 나가므로 제외</p>`;
    h += '<p class="muted" style="margin-top:12px">판 이름을 누르면 그 판만 봅니다. 화면 색은 근사치이며(색 관리 미적용) RGB 개체는 단순 변환으로 C·M·Y·K에 나눠 표시합니다.</p>';
    side.innerHTML = h;
  }

  function drawSep(S) {
    const cv = $('sepCanvas'); if (!cv) return;
    const U = state.sepUI;
    const cx = cv.getContext('2d');
    const img = cx.createImageData(S.W, S.H), d = img.data;
    const on = S.plates.filter(p => !U.off.has(p.name));
    const inks = on.map(p => p.ink), ab = on.map(p => [1 - p.rgb[0] / 255, 1 - p.rgb[1] / 255, 1 - p.rgb[2] / 255]);
    const gray = U.gray && on.length === 1;
    const n = S.W * S.H, W = S.W, lim = U.tacLimit * 2.55, K = on.length;
    // 중복인쇄 줄무늬는 재단 영역 안에만 표시
    const P = state.facts.pages[state.modalIdx];
    const tn = P && P.raster ? P.raster.trimN : [0, 0, 1, 1];
    const tx0 = tn[0] * S.W, tx1 = tn[2] * S.W, ty0 = tn[1] * S.H, ty1 = tn[3] * S.H;
    for (let j = 0, q = 0; j < n; j++, q += 4) {
      let r = 1, g = 1, b = 1;
      if (gray) { r = g = b = 1 - inks[0][j] / 255; }
      else for (let k = 0; k < K; k++) {
        const t = inks[k][j]; if (!t) continue;
        const tt = t / 255, a = ab[k];
        r *= 1 - tt * a[0]; g *= 1 - tt * a[1]; b *= 1 - tt * a[2];
      }
      let R = r * 255, G = g * 255, B = b * 255;
      if (U.op && S.opmask[j] > 100) {
        const x = j % W, y = (j / W) | 0;
        if (x >= tx0 && x < tx1 && y >= ty0 && y < ty1 && ((x + y) >> 2 & 1)) { R = R * 0.25; G = G * 0.25 + 190; B = B * 0.25 + 60; }
      }
      if (U.tac && S.tac[j] > lim) { R = R * 0.3 + 178; G = G * 0.3; B = B * 0.3 + 40; }
      d[q] = R; d[q + 1] = G; d[q + 2] = B; d[q + 3] = 255;
    }
    cx.putImageData(img, 0, 0);
  }

  function sepCursor(e) {
    const S = state.sepCache.get(state.modalIdx); const cv = $('sepCanvas');
    if (!S || !cv) return;
    const r = cv.getBoundingClientRect();
    const x = Math.floor((e.clientX - r.left) / r.width * S.W), y = Math.floor((e.clientY - r.top) / r.height * S.H);
    const inside = x >= 0 && y >= 0 && x < S.W && y < S.H;
    const j = y * S.W + x;
    document.querySelectorAll('#mSide [data-cur]').forEach(td => {
      if (!inside) { td.textContent = '–'; return; }
      if (td.dataset.cur === '__tac') { td.textContent = Math.round(S.tac[j] / 2.55) + '%'; return; }
      const p = S.plates.find(p => p.name === td.dataset.cur);
      td.textContent = p ? Math.round(p.ink[j] / 2.55) + '%' : '–';
    });
  }

  function initModal() {
    $('mTabs').addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      state.modalMode = b.dataset.v;
      showModal(state.modalIdx);
    });
    $('mView').addEventListener('mousemove', (e) => { if (state.modalMode === 'sep') sepCursor(e); });
    $('mView').addEventListener('mouseleave', (e) => { if (state.modalMode === 'sep') sepCursor({ clientX: -1e6, clientY: -1e6 }); });
    $('mSide').addEventListener('change', (e) => {
      if (state.modalMode !== 'sep') return;
      const S = state.sepCache.get(state.modalIdx); if (!S) return;
      const U = state.sepUI, t = e.target;
      if (t.hasAttribute('data-all')) { U.off = t.checked ? new Set() : new Set(S.plates.map(p => p.name)); showSep(state.modalIdx); return; }
      if (t.dataset.plate) { if (t.checked) U.off.delete(t.dataset.plate); else U.off.add(t.dataset.plate); showSep(state.modalIdx); return; }
      if (t.dataset.opt === 'tacLimit') { U.tacLimit = Math.max(100, parseFloat(t.value) || 300); drawSep(S); return; }
      if (t.dataset.opt) { U[t.dataset.opt] = t.checked; drawSep(S); }
    });
    $('mSide').addEventListener('click', (e) => {
      const b = e.target.closest('[data-solo]');
      if (!b || state.modalMode !== 'sep') return;
      const S = state.sepCache.get(state.modalIdx); if (!S) return;
      const U = state.sepUI, nm = b.dataset.solo;
      const soloNow = S.plates.every(p => (p.name === nm) !== U.off.has(p.name));
      U.off = soloNow ? new Set() : new Set(S.plates.filter(p => p.name !== nm).map(p => p.name));
      showSep(state.modalIdx);
    });
    const close = () => { $('modal').hidden = true; state.modalIdx = -1; hiResToken++; sepToken++; state.modalMode = 'print'; };
    $('mClose').addEventListener('click', close);
    $('modal').addEventListener('click', (e) => { if (e.target === $('modal')) close(); });
    $('mPrev').addEventListener('click', () => showModal(state.modalIdx - 1));
    $('mNext').addEventListener('click', () => showModal(state.modalIdx + 1));
    document.addEventListener('keydown', (e) => {
      if ($('modal').hidden) return;
      if (e.key === 'Escape') close();
      if (e.key === 'ArrowLeft' || e.key === 'PageUp') showModal(state.modalIdx - 1);
      if (e.key === 'ArrowRight' || e.key === 'PageDown') showModal(state.modalIdx + 1);
    });
    // 문제 항목에 마우스를 올리면 해당 위치 강조
    $('mSide').addEventListener('mouseover', (e) => {
      const it = e.target.closest('.issue');
      document.querySelectorAll('#mView .iss').forEach(r => r.style.strokeWidth = (it && r.dataset.k === it.dataset.k) ? '5' : '');
    });
    window.addEventListener('resize', () => { if (state.modalIdx >= 0) showModal(state.modalIdx); });
  }

  initSettings(); initInput(); initReportEvents(); initToggles(); initModal();
})();
