/* 把 assets/icon/*.svg 渲染成各尺寸 PNG
 * 运行：node assets/icon/render.cjs
 *   icon-*     独立图形（品牌紫），用于面板内
 *   icon-app-* 应用图标（紫渐变底），用于扩展/收藏夹/README
 * 16px 使用手工像素对位版本，其余尺寸用矢量版本
 */
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const DIR = __dirname;
const OUT = path.join(DIR, 'png');
const SIZES = [16, 32, 48, 128, 256];

const read = (f) => fs.readFileSync(path.join(DIR, f), 'utf8');
const appSvg = read('icon-app.svg');
const app16Svg = read('icon-app-16.svg');
const glyphSvg = read('icon.svg').replace(/currentColor/g, '#4f46e5');

async function shoot(page, svg, size, file) {
  const html = `<!doctype html><html><body style="margin:0;background:transparent">
    ${svg.replace(/width="(32|16)" height="(32|16)"/, `width="${size}" height="${size}"`)}
  </body></html>`;
  await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: 'load' });
  await page.screenshot({ path: file, omitBackground: true });
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();

  for (const size of SIZES) {
    await shoot(page, glyphSvg, size, path.join(OUT, `icon-${size}.png`));
    await shoot(page, size === 16 ? app16Svg : appSvg, size, path.join(OUT, `icon-app-${size}.png`));
    console.log('✔', size);
  }
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
