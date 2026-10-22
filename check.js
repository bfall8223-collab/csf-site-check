// City Shift Finance site check: headers, breadcrumbs, mobile menu.
// Runs as a logged-out visitor. Read-only: it never changes the site.
const { chromium, devices } = require('playwright');
const fs = require('fs');

const SITE = process.env.SITE || 'https://cityshiftfinance.com';
const LIMIT = parseInt(process.env.LIMIT || '0', 10);      // 0 = all pages
const ONLY = (process.env.ONLY || '').split(/\s+/).filter(Boolean); // optional URL list
const CONCURRENCY = 4;
const OUT = 'report';

async function getUrls(request) {
  if (ONLY.length) return ONLY;
  const seen = new Set(), urls = new Set();
  async function read(u) {
    if (seen.has(u)) return; seen.add(u);
    const r = await request.get(u, { timeout: 30000 });
    if (!r.ok()) return;
    const xml = await r.text();
    const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map(m => m[1].replace(/&amp;/g, '&'));
    for (const l of locs) {
      if (/\.xml(\?|$)/.test(l)) { await read(l); }
      else if (l.startsWith(SITE) && !/\.(jpe?g|png|webp|gif|pdf|svg|mp4)$/i.test(l)) urls.add(l);
    }
  }
  await read(SITE + '/sitemap_index.xml');
  let list = [...urls].sort();
  if (LIMIT) list = list.slice(0, LIMIT);
  return list;
}

// ---------- checks run inside the page ----------
function mobileInspect() {
  const out = { problems: [], info: {} };
  const bc = document.querySelector('.csf-mcs-mobile-breadcrumb');
  if (bc && getComputedStyle(bc).display !== 'none') {
    const r = bc.getBoundingClientRect();
    out.info.breadcrumb = bc.innerText.replace(/\s+/g, ' ').trim();
    const hit = document.elementFromPoint(Math.min(r.left + 40, innerWidth - 5), r.top + r.height / 2);
    if (!hit || !bc.contains(hit)) out.problems.push('Mobile breadcrumb is hidden behind another element');
    const items = [...bc.querySelectorAll('a, .csf-mcs-mobile-breadcrumb__current')].map(e => e.innerText.trim().toLowerCase());
    for (let i = 1; i < items.length; i++) if (items[i] && items[i] === items[i - 1]) out.problems.push('Breadcrumb repeats the same name: ' + items[i]);
    if (/\|\s*city shift finance/i.test(bc.innerText)) out.problems.push('Breadcrumb contains "| City Shift Finance"');
    const below = document.elementFromPoint(innerWidth / 2, r.bottom + 6);
    if (below === document.body || below === document.documentElement) out.problems.push('Empty gap under the mobile breadcrumb');
  }
  return out;
}

function desktopInspect() {
  const out = { problems: [], info: {} };
  const h = document.getElementById('csf-mcs-universal-desktop-header');
  if (h && getComputedStyle(h).display !== 'none' && h.getBoundingClientRect().height > 0) {
    const active = [...h.querySelectorAll('.csf-mcs-uh-tab.is-active')];
    const practice = h.querySelector('.csf-mcs-uh-practice');
    out.info.activeTab = active.map(a => a.innerText.replace(/\s+/g, ' ').trim()).join(' / ');
    if (active.length > 1) out.problems.push('Desktop sticky bar underlines more than one tab');
    if (practice && active.length === 0) out.problems.push('Desktop sticky bar underlines no tab');
  }
  return out;
}

async function checkMenu(page, problems) {
  const toggle = page.locator('header .breakdance-menu-toggle, header .csf-mcs-uh-overview-toggle').filter({ visible: true }).first();
  if (!(await toggle.count())) return;
  const managed = await page.evaluate(() => !!(window.__CSF_MCS_MOBILE_NAV_PREVIEW__ || document.getElementById('csf-mcs-mobile-overview-early') || document.getElementById('csf-mcs-mobile-menu-early-intercept')));
  if (!managed) return; // page not handled by the Master Parent menu
  await toggle.click({ timeout: 5000 }).catch(() => {});
  const opened = await page.waitForSelector('#csf-mcs-mobile-overview.is-open', { timeout: 6000 }).then(() => true).catch(() => false);
  if (!opened) {
    // The home page intentionally opens its own Breakdance overview popup (#13679).
    const homeMenu = await page.evaluate(() => !!document.querySelector('[class*="bde-popup-13679-"].breakdance-popup-open'));
    if (homeMenu) return;
    const box = await toggle.boundingBox().catch(() => null);
    const diag = await page.evaluate((b) => ({
      onTop: b ? (function () { const e = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2); return e ? (e.tagName + '#' + e.id + '.' + String(e.className).slice(0, 80)) : 'none'; })() : 'no-box',
      toggleClass: (document.querySelector('header .breakdance-menu-toggle') || {}).className || 'none',
      readyState: document.readyState,
      menuReady: !!window.__CSF_MCS_MOBILE_NAV_PREVIEW__,
      pendingTap: !!window.__CSF_MCS_OPEN_PENDING,
      earlyScript: !!document.getElementById('csf-mcs-mobile-menu-early-intercept'),
      menuScript: !!document.getElementById('csf-mcs-mobile-menu-preview-script'),
      overlay: !!document.getElementById('csf-mcs-mobile-overview'),
      breakdanceMenuOpen: !!document.querySelector('.breakdance-menu--open, .breakdance-responsive-menu--open, .breakdance-menu.is-open'),
    }), box);
    problems.push('Hamburger did not open the navy menu [' + Object.entries(diag).map(([k, v]) => k + '=' + v).join(', ') + ']' + (page.__errors && page.__errors.length ? ' JS errors: ' + page.__errors.slice(0, 3).join(' | ') : ''));
    return;
  }
  const close = page.locator('#csf-mcs-mobile-overview.is-open .csf-mo-close').filter({ visible: true }).first();
  if (await close.count()) {
    await close.click().catch(() => {});
    const closed = await page.waitForFunction(() => !document.querySelector('#csf-mcs-mobile-overview.is-open'), null, { timeout: 4000 }).then(() => true).catch(() => false);
    if (!closed) problems.push('Menu close (×) did not close the menu');
  } else problems.push('Menu has no visible close (×) button');
}

async function checkUrl(browser, url) {
  const result = { url, problems: [], info: {} };
  const shot = async (page, tag) => {
    const name = url.replace(SITE, '').replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '') || 'home';
    const file = `${OUT}/${name}-${tag}.png`;
    await page.screenshot({ path: file }).catch(() => {});
    return file;
  };
  // Mobile, as a visitor
  const mctx = await browser.newContext({ ...devices['iPhone 13'] });
  const m = await mctx.newPage();
  m.__errors = [];
  m.on('pageerror', e => m.__errors.push(String(e.message).slice(0, 160)));
  m.on('console', msg => { if (msg.type() === 'error') m.__errors.push(msg.text().slice(0, 160)); });
  try {
    const resp = await m.goto(url + (url.includes('?') ? '&' : '?') + 'csfcheck=' + Date.now(), { waitUntil: 'load', timeout: 45000 });
    const finalUrl = m.url().split('?')[0];
    if (resp && resp.status() >= 400) result.problems.push('Page returns HTTP ' + resp.status());
    if (finalUrl.replace(/\/$/, '') !== url.split('?')[0].replace(/\/$/, '')) { result.info.redirectedTo = finalUrl; await mctx.close(); return result; }
    await m.waitForTimeout(1500);
    const mi = await m.evaluate(mobileInspect);
    result.problems.push(...mi.problems); Object.assign(result.info, mi.info);
    // The home page uses its own Breakdance overview popup, checked by hand; skip it here.
    if (url.replace(/\/$/, '') !== SITE.replace(/\/$/, '')) await checkMenu(m, result.problems);
    if (result.problems.length) result.mobileShot = await shot(m, 'mobile');
  } catch (e) { result.problems.push('Mobile load failed: ' + e.message.split('\n')[0]); }
  await mctx.close();
  // Desktop
  const dctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const d = await dctx.newPage();
  try {
    await d.goto(url + (url.includes('?') ? '&' : '?') + 'csfcheck=' + Date.now(), { waitUntil: 'load', timeout: 45000 });
    await d.waitForTimeout(800);
    const di = await d.evaluate(desktopInspect);
    result.problems.push(...di.problems); Object.assign(result.info, di.info);
    if (di.problems.length) result.desktopShot = await shot(d, 'desktop');
  } catch (e) { result.problems.push('Desktop load failed: ' + e.message.split('\n')[0]); }
  await dctx.close();
  return result;
}

// Early-tap test: tap the hamburger as soon as the page appears (pages with a hero video).
async function earlyTap(browser, url) {
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  const p = await ctx.newPage();
  const problems = [];
  try {
    await p.goto(url + '?csfcheck=' + Date.now(), { waitUntil: 'domcontentloaded', timeout: 45000 });
    const t = p.locator('header .breakdance-menu-toggle').filter({ visible: true }).first();
    if (await t.count()) {
      await t.click({ timeout: 5000 }).catch(() => {});
      const ok = await p.waitForSelector('#csf-mcs-mobile-overview.is-open', { timeout: 20000 }).then(() => true).catch(() => false);
      if (!ok) problems.push('Early hamburger tap did not open the navy menu');
    }
  } catch (e) { problems.push('Early tap test failed: ' + e.message.split('\n')[0]); }
  await ctx.close();
  return { url: url + ' (early tap)', problems, info: {} };
}

if (require.main !== module) { module.exports = { mobileInspect, desktopInspect }; return; }
(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  const urls = await getUrls(ctx.request);
  console.log(`Checking ${urls.length} pages`);
  const results = [];
  let i = 0;
  async function worker() {
    while (i < urls.length) {
      const url = urls[i++];
      const r = await checkUrl(browser, url);
      results.push(r);
      if (r.problems.length) console.log('FAIL', url, r.problems.join('; '));
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  if (!ONLY.length) results.push(await earlyTap(browser, SITE + '/our-insights/'));
  await browser.close();

  const failed = results.filter(r => r.problems.length);
  fs.writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 2));
  let md = `# City Shift Finance site check\n\nChecked ${results.length} pages. **${failed.length} with problems.**\n\n`;
  if (failed.length) {
    md += '| Page | Problem |\n|---|---|\n';
    for (const f of failed) md += `| ${f.url} | ${f.problems.join('<br>')} |\n`;
    md += '\nScreenshots are in the "site-check-report" download on this run.\n';
  } else md += 'Everything passed.\n';
  fs.writeFileSync(`${OUT}/summary.md`, md);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
  console.log(md);
  process.exit(failed.length ? 1 : 0);
})();
