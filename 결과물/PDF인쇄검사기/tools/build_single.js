/* 배포용 한 파일 HTML 만들기
 * 사용법: node tools/build_single.js   (PDF인쇄검사기 폴더에서 실행)
 * 결과:   ../해내미PDF안전확인판.html  — css·js·라이브러리·이미지·글꼴을 모두 안에 담은 파일 1개.
 *         다른 컴퓨터에 이 파일 하나만 보내면 됩니다 (인터넷 불필요).
 * 원본(해내미PDF인쇄검사기.html + 폴더들)을 고친 뒤에는 이 스크립트를 다시 실행하세요.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.resolve(ROOT, '..', '해내미PDF안전확인판.html');
const rd = (p) => fs.readFileSync(path.join(ROOT, p));
const MIME = { '.png': 'image/png', '.ttf': 'font/ttf', '.woff2': 'font/woff2' };
const dataUri = (p) => `data:${MIME[path.extname(p)]};base64,${rd(p).toString('base64')}`;

// 이미지 경로 → data URI (HTML·CSS·JS 모두에서 같은 이름으로 쓰임)
const imgs = fs.readdirSync(path.join(ROOT, 'img')).filter((f) => f.endsWith('.png'));
function inlineImages(text, prefix) {
  for (const f of imgs) text = text.split(prefix + 'img/' + f).join(dataUri('img/' + f));
  return text;
}

// <script> 안에 넣을 때 태그가 끊기지 않도록
const safeScript = (code) => code.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');

let html = rd('해내미PDF인쇄검사기.html').toString('utf8');

// CSS
html = html.replace(/<link rel="stylesheet" href="css\/style\.css">/, () => {
  let css = rd('css/style.css').toString('utf8');
  css = inlineImages(css, '../');
  css = css.replace(/url\(\.\.\/fonts\/([^)]+)\)/g, (_, f) => `url(${dataUri('fonts/' + f)})`);
  if (/url\((?!data:)/.test(css)) throw new Error('CSS에 아직 외부 url()이 남아 있습니다');
  return `<style>\n${css}\n</style>`;
});

// 스크립트
html = html.replace(/<script src="([^"]+)"><\/script>/g, (_, src) => {
  let code = rd(src).toString('utf8');
  if (src.startsWith('js/')) code = inlineImages(code, '');
  return `<script>/* ${src} */\n${safeScript(code)}\n</script>`;
});

// HTML의 이미지
html = inlineImages(html, '');

// 남은 외부 참조 확인
const left = html.match(/(?:src|href)="(?!data:|#|https?:|\$\{)[^"]+"/g);  // ${...}는 실행 중에 채워지는 값
if (left) throw new Error('외부 파일 참조가 남아 있습니다: ' + left.join(', '));

fs.writeFileSync(OUT, html);
console.log('완료:', OUT, (fs.statSync(OUT).size / 1048576).toFixed(1) + ' MB');
