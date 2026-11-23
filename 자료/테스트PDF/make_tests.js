const fs = require('fs');
const { PDFDocument, StandardFonts, rgb, cmyk, grayscale, PDFName, PDFNumber,
  pushGraphicsState, popGraphicsState, concatTransformationMatrix, drawObject } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const MM = 72 / 25.4;
const A4 = [210 * MM, 297 * MM], A3L = [420 * MM, 297 * MM];

// 최소 PNG(RGBA) 인코더 — 가운데 원, 바깥은 투명
function makePng(w, h) {
  const zlib = require('zlib');
  const crcT = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcT[n] = c >>> 0; }
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; for (let x = 0; x < w; x++) { const p = y * (w * 4 + 1) + 1 + x * 4; const inC = (x - w / 2) ** 2 + (y - h / 2) ** 2 < (w * 0.45) ** 2; raw[p] = 30; raw[p + 1] = 120; raw[p + 2] = 240; raw[p + 3] = inC ? 255 : 0; } }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = ihdr[11] = ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
function imageXObject(doc, w, h, cs) {
  const n = cs === 'DeviceCMYK' ? 4 : cs === 'DeviceGray' ? 1 : 3;
  const data = new Uint8Array(w * h * n);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = (y * w + x) * n;
    if (n === 1) { data[p] = ((x ^ y) & 64) ? 60 : 200; }
    else if (n === 3) { data[p] = (x * 255 / w) | 0; data[p + 1] = (y * 255 / h) | 0; data[p + 2] = 160; }
    else { data[p] = (x * 255 / w) | 0; data[p + 1] = (y * 200 / h) | 0; data[p + 2] = 40; data[p + 3] = 0; }
  }
  const s = doc.context.flateStream(data, { Type: 'XObject', Subtype: 'Image', Width: w, Height: h, ColorSpace: cs, BitsPerComponent: 8 });
  return doc.context.register(s);
}
function placeImage(page, ref, x, y, w, h) {
  const name = page.node.newXObject('Im', ref);
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(w, 0, 0, h, x, y), drawObject(name), popGraphicsState());
}

(async () => {
  // ---------- 문제 많은 파일 ----------
  {
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    const helv = await doc.embedFont(StandardFonts.Helvetica); // 미포함 글꼴
    const malgun = await doc.embedFont(fs.readFileSync('C:/Windows/Fonts/malgun.ttf'), { subset: true });

    let p = doc.addPage(A4); // 1: 미포함 글꼴 + RGB 검정 텍스트 + 가장자리 텍스트 + RGB 빨간 박스
    p.drawText('Helvetica not embedded', { x: 30 * MM, y: 250 * MM, size: 20, font: helv, color: rgb(0, 0, 0) });
    p.drawText('Page number too close to edge', { x: 80 * MM, y: 2 * MM, size: 9, font: helv, color: rgb(0, 0, 0) });
    p.drawRectangle({ x: 30 * MM, y: 150 * MM, width: 80 * MM, height: 40 * MM, color: rgb(0.9, 0.1, 0.1) });

    p = doc.addPage(A4); // 2: 저해상도 RGB 이미지
    p.drawText('저해상도 이미지', { x: 30 * MM, y: 260 * MM, size: 18, font: malgun, color: grayscale(0) });
    placeImage(p, imageXObject(doc, 60, 45, 'DeviceRGB'), 30 * MM, 120 * MM, 120 * MM, 90 * MM);
    placeImage(p, imageXObject(doc, 600, 450, 'DeviceRGB'), 30 * MM, 30 * MM, 60 * MM, 45 * MM);

    doc.addPage(A4); // 3: 빈 페이지

    p = doc.addPage(A3L); // 4: 다른 크기 + 가장자리까지 배경(도련 없음)
    p.drawRectangle({ x: 0, y: 0, width: A3L[0], height: 60 * MM, color: cmyk(0.8, 0.2, 0, 0) });
    p.drawText('A3 가로, 배경이 재단선까지', { x: 30 * MM, y: 200 * MM, size: 24, font: malgun, color: cmyk(0, 0, 0, 1) });

    p = doc.addPage(A4); // 5: 가는 선 + 인쇄되는 주석
    p.drawLine({ start: { x: 30 * MM, y: 200 * MM }, end: { x: 180 * MM, y: 200 * MM }, thickness: 0.1, color: grayscale(0) });
    p.drawText('가는 선과 메모 주석', { x: 30 * MM, y: 250 * MM, size: 18, font: malgun, color: grayscale(0) });
    const annot = doc.context.obj({ Type: 'Annot', Subtype: 'Square', Rect: [60 * MM, 100 * MM, 150 * MM, 150 * MM], F: 4, C: [1, 0, 0], Contents: '검토 메모' });
    p.node.set(PDFName.of('Annots'), doc.context.obj([doc.context.register(annot)]));

    p = doc.addPage(A4); // 6: 정상 흑백 페이지
    p.drawText('정상 흑백 페이지', { x: 30 * MM, y: 250 * MM, size: 18, font: malgun, color: grayscale(0) });

    p = doc.addPage(A4); // 7: 이미지 형식/색상 모음 (투명 PNG, JPEG, 흑백, CMYK)
    p.drawText('이미지 형식·색상 모음', { x: 30 * MM, y: 270 * MM, size: 18, font: malgun, color: grayscale(0) });
    const png = await doc.embedPng(makePng(800, 800));
    p.drawImage(png, { x: 25 * MM, y: 170 * MM, width: 60 * MM, height: 60 * MM });
    const jpg = await doc.embedJpg(fs.readFileSync('C:/Windows/Web/Wallpaper/Spotlight/img14.jpg'));
    p.drawImage(jpg, { x: 110 * MM, y: 170 * MM, width: 80 * MM, height: 80 * MM * jpg.height / jpg.width });
    placeImage(p, imageXObject(doc, 900, 900, 'DeviceGray'), 25 * MM, 60 * MM, 60 * MM, 60 * MM);
    placeImage(p, imageXObject(doc, 900, 900, 'DeviceCMYK'), 110 * MM, 60 * MM, 60 * MM, 60 * MM);

    p = doc.addPage(A4); // 8: 별색 + 중복인쇄 모음
    {
      const ctx = doc.context;
      const sepFn = (c1) => ctx.obj({ FunctionType: 2, Domain: [0, 1], C0: [0, 0, 0, 0], C1: c1, N: 1 });
      const cs1 = ctx.obj(['Separation', 'PANTONE 185 C', 'DeviceCMYK', sepFn([0, 0.91, 0.76, 0])]);
      const cs2 = ctx.obj(['Separation', Buffer.from('칼선', 'utf8').toString('latin1'), 'DeviceCMYK', sepFn([0, 1, 0, 0])]);
      const res = p.node.Resources();
      res.set(PDFName.of('ColorSpace'), ctx.obj({ CS1: cs1, CS2: cs2 }));
      res.set(PDFName.of('ExtGState'), ctx.obj({ GSop: { Type: 'ExtGState', OP: true, op: true, OPM: 1 }, GSko: { Type: 'ExtGState', OP: false, op: false } }));
      const content = [
        'q /GSko gs 1 0 0 0 k 56 400 480 300 re f Q',          // 사이안 배경
        'q /GSop gs 0 0 0 0 k 80 600 200 40 re f Q',           // 흰색 + 중복인쇄 (사라짐)
        'q /GSop gs 0 0 0 1 k 80 500 200 40 re f Q',           // K100 중복인쇄
        'q /GSop gs 0 1 0 0 k 320 600 150 60 re f Q',          // 마젠타 중복인쇄
        'q /GSop gs /CS1 cs 1 scn 320 480 150 80 re f Q',      // 별색 중복인쇄
        'q /GSko gs /CS1 cs 0.5 scn 100 200 150 80 re f Q',    // 별색 50% 녹아웃
        'q /GSko gs /CS2 CS 1 SCN 3 w 60 150 470 600 re S Q',  // 칼선 녹아웃 (잘못된 설정)
      ].join('\n');
      p.node.addContentStream(ctx.register(ctx.flateStream(content)));
    }
    // 9: 재단 여백(slug)이 있는 페이지 — 재단선 밖 중복인쇄 글자/재단 표시는 검사 제외, 안쪽 흰색 중복인쇄 1개만 잡혀야 함
    {
      const p9 = doc.addPage([236 * MM, 323 * MM]);
      p9.setTrimBox(13 * MM, 13 * MM, 210 * MM, 297 * MM);
      p9.setBleedBox(10 * MM, 10 * MM, 216 * MM, 303 * MM);
      const ctx = doc.context;
      const res = p9.node.Resources();
      res.set(PDFName.of('ExtGState'), ctx.obj({ GSop: { Type: 'ExtGState', OP: true, op: true, OPM: 1 } }));
      res.set(PDFName.of('Font'), ctx.obj({ F1: ctx.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica' }) }));
      const t = 13 * MM, R = 223 * MM, Tp = 310 * MM;
      const content = [
        `q 0 0.5 1 0 k ${t - 3 * MM} ${t + 200 * MM} ${216 * MM} ${100 * MM} re f Q`,                 // 도련까지 이어진 배경
        `q /GSop gs 0 0 0 0 k ${t + 30 * MM} ${t + 250 * MM} ${60 * MM} ${10 * MM} re f Q`,            // 안쪽: 흰색 중복인쇄 (잡혀야 함)
        `q /GSop gs 0 0 0 1 k BT /F1 8 Tf ${t} ${4 * MM} Td (Slug info: job 2026-11 / page 9 / overprint text) Tj ET Q`, // 아래 여백 글자
        `q /GSop gs 0 0 0 0 k BT /F1 8 Tf ${t} ${Tp + 3 * MM} Td (WHITE OVERPRINT IN SLUG) Tj ET Q`,                      // 위 여백 흰 글자
        `q /GSop gs 0 0 0 1 K 0.25 w ${t} 0 m ${t} ${8 * MM} l S ${R} 0 m ${R} ${8 * MM} l S 0 ${t} m ${8 * MM} ${t} l S Q`, // 재단 표시
      ].join('\n');
      p9.node.addContentStream(ctx.register(ctx.flateStream(content)));
    }
    fs.writeFileSync('test_bad.pdf', await doc.save());
  }
  // ---------- 정상 파일 (도련 3mm, CMYK, 고해상도) ----------
  {
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    const malgun = await doc.embedFont(fs.readFileSync('C:/Windows/Fonts/malgun.ttf'), { subset: true });
    for (let i = 0; i < 4; i++) {
      const p = doc.addPage([216 * MM, 303 * MM]);
      p.setTrimBox(3 * MM, 3 * MM, 210 * MM, 297 * MM);
      p.setBleedBox(0, 0, 216 * MM, 303 * MM);
      p.drawRectangle({ x: 0, y: 0, width: 216 * MM, height: 50 * MM, color: cmyk(0, 0.6, 0.9, 0) });
      p.drawText(`정상 페이지 ${i + 1}`, { x: 25 * MM, y: 260 * MM, size: 22, font: malgun, color: cmyk(0, 0, 0, 1) });
      placeImage(p, imageXObject(doc, 900, 600, 'DeviceCMYK'), 25 * MM, 120 * MM, 75 * MM, 50 * MM);
      p.drawText(`${i + 1}`, { x: 105 * MM, y: 15 * MM, size: 10, font: malgun, color: cmyk(0, 0, 0, 1) });
    }
    fs.writeFileSync('test_good.pdf', await doc.save());
  }
  console.log('ok');
})();
