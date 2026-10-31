// Concurrency tests: many customers hitting the database at the same moment.
// Needs a REAL PostgreSQL server (PGlite has one connection only) and the `psql` command.
//   PGHOST=127.0.0.1 PGPORT=5432 PGUSER=postgres node tests/sql-concurrency.test.mjs
// It creates (and wipes!) a database called cr_concurrency_test. Never point it at your real project.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { checker, psql, psqlAsync, realDbLoad } = require('./lib.js');

const conn = { host: process.env.PGHOST || '127.0.0.1', port: process.env.PGPORT || 5432, user: process.env.PGUSER || 'postgres', db: 'cr_concurrency_test' };
if (psql({ ...conn, db: 'postgres' }, 'select 1').code !== 0) {
  console.log('SKIPPED: no PostgreSQL server reachable at ' + conn.host + ':' + conn.port + ' (set PGHOST/PGPORT/PGUSER). These tests need a real server.');
  process.exit(0);
}
const c = checker();
realDbLoad(conn);
const one = (sql) => psql(conn, sql).out;
const comp = one("select name || '|' || price from public.components where active order by price limit 1").split('|');
const COMP = { name: comp[0], price: +comp[1] };
const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
const tue = one("select to_char(d, 'YYYY-MM-DD') from generate_series((now() at time zone 'Asia/Kolkata')::date + 2, (now() at time zone 'Asia/Kolkata')::date + 14, '1 day') d where extract(dow from d) in (2,5) limit 1");
let seq = 0;
const code = () => { const al = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; let s = 'CR'; for (let i = 0; i < 8; i++) s += al[Math.floor(Math.random() * 32)]; return s; };

// one customer = one connection. The insert is held open for `hold` ms before commit, so the others really overlap with it.
function orderScript({ phone, coupon = null, discount = 0, orderCode = code(), qty = 10, hold = 400 }) {
  const sub = COMP.price * qty, net = sub - discount, adv = Math.max(1, Math.round(net * 0.2));
  return `begin; set local role anon; select set_config('request.jwt.claims', '{}', true);
insert into public.orders (order_code, customer_name, customer_phone, delivery_location, batch_date, items, subtotal, discount, coupon_code, advance, cod, status, payment_ref)
values (${q(orderCode)}, 'T', ${q(phone)}, 'Hostel', ${q(tue)}, ${q(JSON.stringify([{ name: COMP.name, qty, price: COMP.price }]))}::jsonb, ${sub}, ${discount}, ${coupon ? q(coupon) : 'null'}, ${adv}, ${net - adv}, 'Confirmed', '123456789012');
select pg_sleep(${hold / 1000}); commit;`;
}
const admin = (sql) => `select set_config('request.jwt.claims', '{"email":"admin@test.com"}', false); ${sql}`;
const all = (scripts) => Promise.all(scripts.map((s) => psqlAsync(conn, s)));
const wins = (rs) => rs.filter((r) => r.code === 0).length;
const reasons = (rs) => [...new Set(rs.filter((r) => r.code !== 0).map((r) => (r.err.match(/ERROR:\s+(\S+)/) || [, '?'])[1]))].join(',');

// coupons used below
one(admin(`insert into public.coupons (code, discount_type, discount_value, scope, min_order, max_uses, one_per_customer, active)
  values ('ONCE50', 'flat', 50, 'all', 0, null, true, true), ('LAST1', 'flat', 50, 'all', 0, 1, false, true), ('LAST3', 'flat', 50, 'all', 0, 3, false, true)`));

// C1. same customer, same one-per-customer coupon, 8 orders at once
let rs = await all(Array.from({ length: 8 }, () => orderScript({ phone: '9876500001', coupon: 'ONCE50', discount: 50 })));
c.ok(wins(rs) === 1, `C1 one-per-customer coupon used by the same phone 8 times at once: ${wins(rs)} order(s) saved (refused: ${reasons(rs)})`);

// C2. a coupon with only 1 use left, 8 different customers at once
rs = await all(Array.from({ length: 8 }, (_, i) => orderScript({ phone: '98765001' + String(10 + i), coupon: 'LAST1', discount: 50 })));
c.ok(wins(rs) === 1 && one("select used_count from public.coupons where code='LAST1'") === '1', `C2 coupon with 1 use left, 8 customers at once: ${wins(rs)} order(s), counter=${one("select used_count from public.coupons where code='LAST1'")} (refused: ${reasons(rs)})`);

// C3. coupon with 3 uses left, 9 customers
rs = await all(Array.from({ length: 9 }, (_, i) => orderScript({ phone: '98765002' + String(10 + i), coupon: 'LAST3', discount: 50 })));
c.ok(wins(rs) === 3 && one("select used_count from public.coupons where code='LAST3'") === '3', `C3 coupon with 3 uses left, 9 customers at once: ${wins(rs)} orders, counter=${one("select used_count from public.coupons where code='LAST3'")}`);

// C4. one phone number placing 12 orders at once (limit is 5 per hour)
rs = await all(Array.from({ length: 12 }, () => orderScript({ phone: '9876500003' })));
c.ok(wins(rs) <= 5, `C4 rate limit of 5 per hour for one phone, 12 orders at once: ${wins(rs)} saved (refused: ${reasons(rs)})`);

// C5. the same order code sent 6 times at once (double submit / retries)
const same = code();
rs = await all(Array.from({ length: 6 }, () => orderScript({ phone: '9876500004', orderCode: same })));
c.ok(wins(rs) === 1 && one(`select count(*) from public.orders where order_code = ${q(same)}`) === '1', `C5 the same order code sent 6 times at once: ${one(`select count(*) from public.orders where order_code = ${q(same)}`)} row`);

// C6. a delivered order: two return requests at once, two reviews at once
one(admin(`insert into public.orders (order_code, customer_name, customer_phone, items, subtotal, advance, cod, status, delivered_at, payment_ref)
  values ('CRDELIVER1', 'R', '9111111111', '[]', 100, 20, 80, 'Delivered', now() - interval '1 day', '111111111111')`));
const ret = "begin; set local role anon; select public.request_return('CRDELIVER1', '9111111111', 'return', 'broken'); select pg_sleep(0.3); commit;";
rs = await all([ret, ret, ret]);
c.ok(rs.every((r) => r.code === 0) && rs.filter((r) => r.out.includes('t')).length === 1, `C6a three return requests at once: ${rs.filter((r) => r.out.includes('t')).length} accepted, no errors`);
const rev = "begin; set local role anon; select public.submit_review('CRDELIVER1', '9111111111', 5, 'nice'); select pg_sleep(0.3); commit;";
rs = await all([rev, rev, rev]);
c.ok(rs.every((r) => r.code === 0) && rs.filter((r) => /\bok\b/.test(r.out)).length === 1 && one("select count(*) from public.reviews where order_code='CRDELIVER1'") === '1',
  `C6b three reviews for one order at once: 1 saved, the others get a clean answer, no errors (${rs.map((r) => r.out.replace(/\s+/g, ' ') || r.err.slice(0, 40)).join(' / ')})`);

console.log(c.fails ? `FAILS ${c.fails} of ${c.total}` : `ALL PASS (${c.total} checks)`);
process.exit(c.fails ? 1 : 0);
