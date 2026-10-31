// Browser tests: real Chromium, the real pages, a stub in place of Supabase.
// Group A: reliability (double click, slow or broken internet). Group B: wrong, huge or hostile input.
'use strict';
const { startServer, launch, newPage, checker } = require('./lib');

const PAGES = ['index', 'catalog', 'product', 'projects', 'project-detail'];
const URLS = { product: 'product.html?id=k1', 'project-detail': 'project-detail.html?id=pr01' };
const USER = { name: 'Test Student', phone: '9876543210', year: '3rd', college: 'ABC College', department: 'ECE' };
// short timings so the tests are fast; the real pages use 12 s / 3 retries by default
const FAST = { CR_NET: { timeoutMs: 600, retries: 3, backoffMs: [80, 120, 160] } };

// Controls what happens to each attempt to save an order. One entry is used per attempt:
//   ok | fail (network down, nothing saved) | lose (saved, but the answer is lost) | hang (never answers)
//   slowsave:<ms> (saves after a delay) | reject (the database refuses: price changed) | slow:<ms>
const NET = `(function(){
  const of = db.from.bind(db); window.__calls = 0; window.__plan = [];
  db.from = (t) => { const b = of(t); if (t !== 'orders') return b; const oi = b.insert.bind(b);
    b.insert = (p) => { window.__calls++; const step = window.__plan.shift() || 'ok'; const real = () => oi(p);
      if (step === 'fail') return Promise.reject(new TypeError('Failed to fetch'));
      if (step === 'lose') return real().then(() => ({ data: null, error: { message: 'TypeError: Failed to fetch' } }));
      if (step === 'hang') return new Promise(() => {});
      if (step === 'reject') return Promise.resolve({ data: null, error: { message: 'item_or_price_changed' } });
      if (step.startsWith('slowsave:')) return new Promise((res) => setTimeout(() => real().then(res), +step.split(':')[1]));
      if (step.startsWith('slow:')) return new Promise((res) => setTimeout(() => real().then(res), +step.split(':')[1]));
      return real(); };
    return b; };
})();`;

async function openCheckout(pg, base, name) {
  await pg.goto(base + '/' + (URLS[name] || name + '.html')); await pg.waitForTimeout(1200);
  await pg.evaluate(() => { const it = CATALOG[0].id; state.cart = { [it]: 1 }; saveCart(); renderCartDrawer(); document.getElementById('checkoutBtn').click(); });
  await pg.waitForTimeout(250); await pg.evaluate(NET);
  await pg.fill('#coDeliveryLocation', 'Hostel A'); await pg.fill('#coUtr', '123456789012');
}
const state = (pg) => pg.evaluate(() => {
  const o = JSON.parse(localStorage.getItem('__db')).orders;
  return { orders: o.length, codes: o.map((x) => x.order_code), locLens: o.map((x) => (x.delivery_location || '').length), calls: window.__calls,
    success: document.getElementById('successModalOverlay').classList.contains('show'),
    errShown: !document.getElementById('saveError').classList.contains('hidden'), errText: document.getElementById('saveError').textContent,
    btnDisabled: document.getElementById('confirmPayBtn').disabled, btnText: document.getElementById('confirmPayBtn').textContent,
    cart: Object.keys(JSON.parse(localStorage.getItem('circuitrun_cart') || '{}')).length };
});
const waitFor = async (pg, fn, ms = 6000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await pg.evaluate(fn)) return true; await pg.waitForTimeout(60); } return false; };
const sampleButton = (pg) => pg.evaluate(() => { window.__texts = []; const b = document.getElementById('confirmPayBtn'); window.__tt = setInterval(() => window.__texts.push(b.textContent), 30); });

(async () => {
  const c = checker(); const { srv, base } = await startServer(); const b = await launch();

  // ================= A. RELIABILITY =================
  for (const name of PAGES) {
    console.log('== A. reliability on', name);
    const mk = () => newPage(b, base, { storage: { circuitrun_user: JSON.stringify(USER) }, globals: FAST });
    let t, s;

    // 1. double click / many taps: exactly one order
    t = await mk(); await openCheckout(t.page, base, name);
    await t.page.evaluate(() => { window.__plan = ['slow:300']; });
    await t.page.dblclick('#confirmPayBtn').catch(() => {});
    await t.page.evaluate(() => { const bt = document.getElementById('confirmPayBtn'); for (let i = 0; i < 6; i++) bt.click(); });
    await waitFor(t.page, () => document.getElementById('successModalOverlay').classList.contains('show'));
    s = await state(t.page);
    c.ok(s.orders === 1 && s.calls === 1 && s.success, `A1 double click and 6 more taps: ${s.orders} order, ${s.calls} save call`);
    await t.ctx.close();

    // 2a. internet fails twice, then works: one tap is enough, no duplicate
    t = await mk(); await openCheckout(t.page, base, name); await sampleButton(t.page);
    await t.page.evaluate(() => { window.__plan = ['fail', 'fail']; });
    await t.page.click('#confirmPayBtn');
    await waitFor(t.page, () => document.getElementById('successModalOverlay').classList.contains('show'));
    s = await state(t.page); const texts = await t.page.evaluate(() => window.__texts);
    c.ok(s.success && s.orders === 1 && s.calls === 3, `A2a two network failures then success: ${s.orders} order, ${s.calls} attempts, success shown=${s.success}`);
    c.ok(texts.some((x) => /retry|slow|connection|again/i.test(x)), 'A2a button tells the customer it is retrying: ' + JSON.stringify([...new Set(texts)]));
    await t.ctx.close();

    // 2b. order saved but the answer was lost: retry must not create a second order
    t = await mk(); await openCheckout(t.page, base, name);
    await t.page.evaluate(() => { window.__plan = ['lose']; });
    await t.page.click('#confirmPayBtn');
    await waitFor(t.page, () => document.getElementById('successModalOverlay').classList.contains('show'));
    s = await state(t.page);
    c.ok(s.success && s.orders === 1 && s.calls === 2, `A2b answer lost after saving: ${s.orders} order, ${s.calls} attempts, success=${s.success}`);
    await t.ctx.close();

    // 2c. server never answers: times out, retries, one order
    t = await mk(); await openCheckout(t.page, base, name);
    await t.page.evaluate(() => { window.__plan = ['hang']; });
    await t.page.click('#confirmPayBtn');
    await waitFor(t.page, () => document.getElementById('successModalOverlay').classList.contains('show'));
    s = await state(t.page);
    c.ok(s.success && s.orders === 1 && s.calls === 2, `A2c no answer (timeout) then retry: ${s.orders} order, ${s.calls} attempts, success=${s.success}`);
    await t.ctx.close();

    // 2d. first attempt is so slow it times out but still saves later: still one order
    t = await mk(); await openCheckout(t.page, base, name);
    await t.page.evaluate(() => { window.__plan = ['slowsave:900']; });
    await t.page.click('#confirmPayBtn');
    await waitFor(t.page, () => document.getElementById('successModalOverlay').classList.contains('show'));
    await t.page.waitForTimeout(1500); s = await state(t.page);
    c.ok(s.success && s.orders === 1, `A2d slow first attempt that saves late: ${s.orders} order, ${s.calls} attempts`);
    await t.ctx.close();

    // 2e. internet stays down: stops after a fixed number of tries, says NOT confirmed, keeps cart, next tap reuses the code
    t = await mk(); await openCheckout(t.page, base, name);
    await t.page.evaluate(() => { window.__plan = ['fail', 'fail', 'fail', 'fail', 'fail', 'fail']; });
    await t.page.click('#confirmPayBtn'); await waitFor(t.page, () => !document.getElementById('saveError').classList.contains('hidden'), 8000);
    s = await state(t.page);
    c.ok(s.errShown && /NOT confirmed/.test(s.errText) && s.orders === 0 && !s.success, 'A2e internet down: error shown, nothing saved');
    c.ok(s.calls === 4, `A2e stops after 4 attempts (1 + 3 retries), no endless loop: ${s.calls}`);
    c.ok(!s.btnDisabled && s.cart === 1, 'A2e button usable again and cart kept');
    await t.page.evaluate(() => { window.__plan = []; window.__calls = 0; });
    await t.page.click('#confirmPayBtn'); await waitFor(t.page, () => document.getElementById('successModalOverlay').classList.contains('show'));
    s = await state(t.page); c.ok(s.success && s.orders === 1, 'A2e tapping again after the internet is back saves one order');
    await t.ctx.close();

    // 2f. the database refuses (price changed): no pointless retries, tells the customer to refresh
    t = await mk(); await openCheckout(t.page, base, name);
    await t.page.evaluate(() => { window.__plan = ['reject']; });
    await t.page.click('#confirmPayBtn'); await waitFor(t.page, () => !document.getElementById('saveError').classList.contains('hidden'));
    await t.page.waitForTimeout(600); s = await state(t.page);
    c.ok(s.calls === 1 && /refresh/i.test(s.errText) && s.orders === 0, `A2f refused order is not retried (${s.calls} call) and asks to refresh`);
    c.ok(t.errors.length === 0, 'no page errors ' + t.errors.join('|'));
    await t.ctx.close();
  }

  // ================= B. WRONG / HUGE / HOSTILE INPUT =================
  const big = (n) => 'A'.repeat(n);
  for (const name of ['index', 'product']) {
    console.log('== B. input on', name);
    // login form
    const login = async (vals) => {
      const t = await newPage(b, base, { globals: FAST });
      await t.page.goto(base + '/' + (URLS[name] || name + '.html')); await t.page.waitForTimeout(1000);
      await t.page.evaluate(() => document.getElementById('loginOverlay').classList.add('show'));
      await t.page.evaluate((v) => {
        document.getElementById('loginName').value = v.name; document.getElementById('loginPhone').value = v.phone;
        document.getElementById('loginCollege').value = v.college; document.getElementById('loginDept').value = v.dept;
        const y = document.getElementById('loginYear'); if (y.options.length > 1) y.selectedIndex = 1;
      }, vals);
      await t.page.click('#loginSubmitBtn'); await t.page.waitForTimeout(500);
      const u = await t.page.evaluate(() => { try { return JSON.parse(localStorage.getItem('circuitrun_user')); } catch (e) { return 'bad'; } });
      return { t, u };
    };
    let r = await login({ name: big(5000), phone: '9876543210', college: big(5000), dept: big(5000) });
    c.ok(!r.u || (r.u.name.length <= 80 && r.u.college.length <= 120 && r.u.department.length <= 120), `B1 5000-character name/college/department: ${r.u ? 'stored lengths ' + r.u.name.length + '/' + r.u.college.length + '/' + r.u.department.length : 'rejected'}`);
    await r.t.ctx.close();
    r = await login({ name: '    ', phone: '9876543210', college: 'C', dept: 'D' });
    c.ok(!r.u, 'B2 blank (spaces only) name is rejected'); await r.t.ctx.close();
    r = await login({ name: `O'Brien <b>x</b>"; DROP TABLE orders;--`, phone: '9876543210', college: 'C', dept: 'D' });
    const html = await r.t.page.evaluate(() => document.body.innerHTML);
    c.ok(r.u && r.u.name.includes('DROP TABLE') && !/<b>x<\/b>/.test(html) && r.t.errors.length === 0, 'B3 quotes, tags and SQL text are kept as plain text, nothing is injected');
    await r.t.ctx.close();
    r = await login({ name: 'अनिल कुमार 😀', phone: '9876543210', college: 'कॉलेज', dept: 'ECE' });
    c.ok(r.u && r.u.name === 'अनिल कुमार 😀', 'B4 Hindi and emoji names are accepted'); await r.t.ctx.close();
    for (const ph of ['12345', 'abcdefghij', '+919876543210', '9876543210\n', '９８７６５４３２１０', '0000000000']) {
      r = await login({ name: 'Ok', phone: ph, college: 'C', dept: 'D' });
      c.ok(!r.u || r.u.phone === '9876543210', `B5 phone ${JSON.stringify(ph)} is not accepted as-is`); await r.t.ctx.close();
    }

    // checkout fields
    const co = async (loc, utr, bypass) => {
      const t = await newPage(b, base, { storage: { circuitrun_user: JSON.stringify(USER) }, globals: FAST });
      await openCheckout(t.page, base, name);
      if (bypass) await t.page.evaluate((v) => { document.getElementById('coDeliveryLocation').value = v; }, loc);
      else await t.page.fill('#coDeliveryLocation', loc);
      await t.page.fill('#coUtr', utr);
      await t.page.click('#confirmPayBtn'); await t.page.waitForTimeout(900);
      const s = await state(t.page); await t.ctx.close(); return s;
    };
    let s = await co(big(5000), '123456789012'); c.ok(s.locLens.every((n) => n <= 300), `B6 typing 5000 characters in the address box: saved length ${s.locLens.join(',') || 'none'} (max 300)`);
    s = await co(big(5000), '123456789012', true); c.ok(s.orders === 0 && !s.success, `B6b 5000 characters forced past the box limit are refused (orders saved: ${s.orders})`);
    s = await co('   ', '123456789012'); c.ok(s.orders === 0, 'B7 blank delivery location is refused');
    for (const u of ['abcdefghijkl', '12345678901', '1234 5678 9012', '１２３４５６７８９０１２', '12345678901;', '']) {
      s = await co('Hostel', u); c.ok(s.orders === 0, `B8 UTR ${JSON.stringify(u)} is refused`);
    }
    s = await co(`Room 12 <script>alert(1)</script> 'quote" ; --`, '123456789012'); c.ok(s.orders === 1, 'B9 odd characters in the address are saved as text');

    // coupon box
    const t = await newPage(b, base, { storage: { circuitrun_user: JSON.stringify(USER) }, globals: FAST });
    await openCheckout(t.page, base, name);
    for (const code of [big(5000), `'; drop table coupons;--`, '😀😀😀', '<img src=x onerror=alert(1)>', '   ']) {
      await t.page.fill('#coCouponInput', code); await t.page.click('#coCouponApplyBtn').catch(() => {}); await t.page.waitForTimeout(150);
    }
    c.ok(t.errors.length === 0 && t.dialogs.length === 0, 'B10 hostile coupon codes: no errors, no popups ' + t.errors.join('|'));
    await t.ctx.close();
  }

  // storage that is broken or edited by hand
  for (const name of PAGES) {
    const bad = [
      { circuitrun_cart: '{bad json' }, { circuitrun_cart: '[]' }, { circuitrun_cart: '"x"' }, { circuitrun_cart: '{"k1":"abc"}' },
      { circuitrun_cart: '{"k1":-5,"zz":1,"k2":1e9}' }, { circuitrun_user: 'null' }, { circuitrun_user: '[]' }, { circuitrun_user: '{bad' },
      { circuitrun_user: '{"name":5,"phone":{}}' },
    ];
    let okAll = true, why = '';
    for (const st of bad) {
      const t = await newPage(b, base, { storage: st, globals: FAST });
      await t.page.goto(base + '/' + (URLS[name] || name + '.html')); await t.page.waitForTimeout(700);
      const len = await t.page.evaluate(() => document.body.innerText.length);
      if (t.errors.length || len < 50) { okAll = false; why += JSON.stringify(st) + ' -> ' + (t.errors[0] || 'empty page') + '; '; }
      await t.ctx.close();
    }
    c.ok(okAll, `B11 ${name}: broken saved cart/user data does not break the page ${why}`);
  }

  // hostile web addresses
  const addrs = ['product.html?id=<script>alert(1)</script>', 'product.html?id=' + 'A'.repeat(8000), 'product.html?id=', 'product.html?id[]=1',
    'project-detail.html?id=%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E', 'catalog.html?q=%3Cscript%3Ealert(1)%3C%2Fscript%3E', 'catalog.html?q=' + 'B'.repeat(8000),
    'invoice.html?order=<script>alert(1)</script>', 'invoice.html?order=' + 'C'.repeat(8000), 'invoice.html', 'index.html?x=%00%0d%0a'];
  for (const a of addrs) {
    const t = await newPage(b, base, { globals: FAST });
    await t.page.goto(base + '/' + a).catch(() => {}); await t.page.waitForTimeout(900);
    const html = await t.page.evaluate(() => document.body.innerHTML);
    const injected = /<script>alert\(1\)<\/script>/.test(html.replace(/<script[\s\S]*?<\/script>/g, (m) => m.includes('alert(1)') ? m : ''));
    c.ok(t.errors.length === 0 && t.dialogs.length === 0 && !/onerror=alert/.test(html.replace(/&lt;/g, '<')) === true || !injected, `B12 address ${a.slice(0, 60)}: no errors, no popup, nothing injected ${t.errors[0] || ''}`);
    await t.ctx.close();
  }

  await b.close(); srv.close();
  console.log(c.fails ? `FAILS ${c.fails} of ${c.total}` : `ALL PASS (${c.total} checks)`);
  process.exit(c.fails ? 1 : 0);
})();
