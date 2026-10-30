// Shared helpers for the CircuitRun tests. Nothing here touches the live site or the live database.
'use strict';
const fs = require('fs'), path = require('path'), http = require('http'), cp = require('child_process');
const ROOT = path.resolve(__dirname, '..');            // the website files (index.html, *.sql ...)

// ---- a tiny in-memory stand-in for supabase-js, kept in localStorage('__db') -------------------------
const stub = `(function(){
const KEY='__db';
function load(){ try{ return JSON.parse(localStorage.getItem(KEY)||'{}'); }catch(e){ return {}; } }
function save(db){ localStorage.setItem(KEY, JSON.stringify(db)); }
let uid=Date.now();
function builder(table){
  const q={op:'select',filters:[],ord:null,lim:null,single:false,payload:null};
  const api={
    select(){ return api; },
    eq(c,v){ q.filters.push(r=>r[c]===v); return api; },
    in(c,a){ q.filters.push(r=>a.includes(r[c])); return api; },
    ilike(c,v){ q.filters.push(r=>String(r[c]||'').toLowerCase()===String(v).toLowerCase()); return api; },
    gte(c,v){ q.filters.push(r=>String(r[c])>=String(v)); return api; },
    order(c,o){ q.ord=[c,!(o&&o.ascending===false)]; return api; },
    limit(n){ q.lim=n; return api; },
    single(){ q.single=true; return api; },
    insert(p){ q.op='insert'; q.payload=p; return api; },
    upsert(p){ q.op='upsert'; q.payload=p; return api; },
    update(p){ q.op='update'; q.payload=p; return api; },
    delete(){ q.op='delete'; return api; },
    then(res,rej){
      const db=load(); const rows=db[table]=db[table]||[]; let out;
      try{
        if(q.op==='select'){
          let r=rows.filter(x=>q.filters.every(f=>f(x)));
          if(q.ord){ const [c,asc]=q.ord; r.sort((a,b)=>String(a[c]||'')<String(b[c]||'')?(asc?-1:1):(asc?1:-1)); }
          if(q.lim!=null) r=r.slice(0,q.lim);
          out = q.single ? (r[0]?{data:r[0],error:null}:{data:null,error:{message:'not found'}}) : {data:r,error:null};
        } else if(q.op==='insert'||q.op==='upsert'){
          const list=Array.isArray(q.payload)?q.payload:[q.payload]; let err=null;
          for(const p of list){
            if(table==='coupons' && rows.some(r=>r.code===p.code)){ err={message:'duplicate key value violates unique constraint "coupons_code_key"'}; break; }
            if(table==='orders' && rows.some(r=>r.order_code===p.order_code)){ err={message:'duplicate key value violates unique constraint "orders_order_code_key"'}; break; }
            if(table==='reviews' && rows.some(r=>r.order_code===p.order_code)){ err={message:'duplicate key value violates unique constraint'}; break; }
            if(q.op==='upsert' && table==='customers'){ const i=rows.findIndex(r=>r.phone===p.phone); if(i>=0){ Object.assign(rows[i],p); continue; } }
            const row=Object.assign({id:'id'+(uid++), created_at:new Date().toISOString()}, table==='coupons'?{used_count:0}:{}, p);
            rows.push(row);
          }
          out={data:null,error:err};
        } else if(q.op==='update'){
          rows.filter(x=>q.filters.every(f=>f(x))).forEach(x=>Object.assign(x,q.payload)); out={data:null,error:null};
        } else if(q.op==='delete'){
          db[table]=rows.filter(x=>!q.filters.every(f=>f(x))); out={data:null,error:null};
        }
        save(db);
      }catch(e){ out={data:null,error:{message:String(e)}}; }
      return Promise.resolve(out).then(res,rej);
    }
  };
  return api;
}
window.supabase={createClient:()=>({
  from:builder,
  auth:{
    async signInWithPassword({email,password}){ if(email==='admin@test.com'&&password==='good'){ localStorage.setItem('__sess','1'); return {data:{session:{user:{email}}},error:null}; } return {data:null,error:{message:'Invalid login credentials'}}; },
    async getSession(){ return {data:{session:localStorage.getItem('__sess')?{user:{}}:null}}; },
    async signOut(){ localStorage.removeItem('__sess'); return {error:null}; }
  },
  rpc(name,args){ const db=load(); const O=db.orders||[]; let data=null;
    if(name==='redeem_coupon'){ (db.coupons||[]).forEach(c=>{ if(c.code===String(args.p_code).toUpperCase()) c.used_count=(c.used_count||0)+1; }); save(db); }
    else if(name==='my_orders'){ data=O.filter(o=>o.customer_phone===args.p_phone).sort((x,y)=>String(y.created_at)<String(x.created_at)?-1:1); }
    else if(name==='order_by_code'){ data=O.filter(o=>o.order_code===args.p_code).slice(0,1); }
    else if(name==='coupon_used'){ data=O.some(o=>o.customer_phone===args.p_phone&&o.coupon_code===args.p_code); }
    else if(name==='public_stats'){ data={orders:O.length,customers:new Set(O.map(o=>o.customer_phone)).size}; }
    else if(name==='request_return'){ const o=O.find(o=>o.order_code===args.p_code&&o.customer_phone===args.p_phone&&!o.return_requested); if(o){ Object.assign(o,{return_requested:true,return_type:args.p_type,return_reason:args.p_reason}); save(db); } data=!!o; }
    else if(name==='submit_review'){ const o=O.find(o=>o.order_code===args.p_code&&o.customer_phone===args.p_phone); db.reviews=db.reviews||[]; if(!o) data='no_order'; else if(o.status!=='Delivered') data='not_delivered'; else if(db.reviews.some(r=>r.order_code===args.p_code)) data='duplicate'; else { db.reviews.push({id:'rv'+Date.now(),order_code:args.p_code,customer_name:o.customer_name.split(' ')[0],customer_college:o.customer_college||null,rating:args.p_rating,comment:args.p_comment||null,status:'pending',created_at:new Date().toISOString()}); save(db); data='ok'; } }
    else if(name==='upsert_customer'){ db.customers=db.customers||[]; const i=db.customers.findIndex(c=>c.phone===args.p_phone); const row={name:args.p_name,phone:args.p_phone,year:args.p_year,college:args.p_college,department:args.p_department}; if(i>=0)Object.assign(db.customers[i],row); else db.customers.push(row); save(db); }
    return Promise.resolve({data,error:null}); },  storage:{from:()=>({upload:async()=>({error:null}),getPublicUrl:()=>({data:{publicUrl:''}})})}
})};
})();`;

const today=new Date();const iso=(d)=>d.toISOString().slice(0,10);
const y=new Date(today);y.setDate(y.getDate()-1);
const seed = {
 components:[
  {id:'k1',name:'Arduino Uno R3',spec:'ATmega328P',price:650,category:'Microcontrollers & ICs',source:'batch',active:true,details:'x',created_at:'2026-01-01'},
  {id:'k2',name:'DHT11 Sensor',spec:'Temp+humidity',price:80,category:'Sensors',source:'local',active:true,details:'x',created_at:'2026-01-01'},
  {id:'k3',name:'SG90 Servo',spec:'9g servo',price:120,category:'Motors & Actuators',source:'local',active:true,details:'x',created_at:'2026-01-01'},
  {id:'k4',name:'Jumper Wires',spec:'40pcs',price:60,category:'Prototyping & Wires',source:'local',active:true,details:'x',created_at:'2026-01-01'}],
 coupons:[
  {id:'cp1',code:'WELCOME10',discount_type:'percent',discount_value:10,scope:'all',targets:[],min_order:0,used_count:0,one_per_customer:true,active:true},
  {id:'cp2',code:'SENSOR20',discount_type:'percent',discount_value:20,scope:'category',targets:['Sensors'],min_order:0,used_count:0,one_per_customer:true,active:true},
  {id:'cp3',code:'ITEM50',discount_type:'flat',discount_value:50,scope:'item',targets:['k1'],min_order:500,used_count:0,one_per_customer:false,active:true},
  {id:'cp4',code:'OLD',discount_type:'percent',discount_value:10,scope:'all',targets:[],min_order:0,used_count:0,one_per_customer:true,active:true,expires_at:iso(y)},
  {id:'cp5',code:'FULL',discount_type:'percent',discount_value:10,scope:'all',targets:[],min_order:0,max_uses:1,used_count:1,one_per_customer:true,active:true},
  {id:'cp6',code:'CAPPED',discount_type:'percent',discount_value:50,max_discount:100,scope:'all',targets:[],min_order:0,used_count:0,one_per_customer:false,active:true},
  {id:'cp7',code:'PAUSED',discount_type:'percent',discount_value:10,scope:'all',targets:[],min_order:0,used_count:0,one_per_customer:true,active:false}],
 orders:[], customers:[], projects:[], blog_posts:[]
};


// ---- static file server for the website folder -----------------------------------------------------------
const TYPES = { '.html': 'text/html', '.js': 'application/javascript', '.json': 'application/json', '.css': 'text/css',
  '.png': 'image/png', '.svg': 'image/svg+xml' };
function startServer() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html';
      const f = path.join(ROOT, p);
      if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
    }).listen(0, '127.0.0.1', () => resolve({ srv, base: 'http://127.0.0.1:' + srv.address().port }));
  });
}

// ---- browser ------------------------------------------------------------------------------------------------------
function playwright() {
  try { return require('playwright'); } catch (e) { return require('/opt/node22/lib/node_modules/playwright'); }
}
async function launch() {
  const pw = playwright();
  const opts = { args: ['--no-sandbox'] };
  if (process.env.CR_CHROMIUM) opts.executablePath = process.env.CR_CHROMIUM;
  return pw.chromium.launch(opts);
}
// a new page where every outside request is blocked and supabase-js is the stub above
async function newPage(browser, base, init = {}) {
  const ctx = await browser.newContext({ viewport: { width: 430, height: 900 }, timezoneId: 'Asia/Kolkata' });
  await ctx.route(/^https?:/, (r) => {
    const u = r.request().url();
    if (u.startsWith(base)) return r.continue();
    if (/supabase-js/.test(u)) return r.fulfill({ contentType: 'application/javascript', body: stub });
    return r.abort();
  });
  await ctx.addInitScript(({ seed, init }) => {
    if (!localStorage.getItem('__db')) localStorage.setItem('__db', JSON.stringify(seed));
    for (const k of Object.keys(init.storage || {})) localStorage.setItem(k, init.storage[k]);
    if (init.globals) for (const k of Object.keys(init.globals)) window[k] = init.globals[k];
  }, { seed, init });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  const dialogs = []; page.on('dialog', (d) => { dialogs.push(d.message()); d.dismiss(); });
  return { ctx, page, errors, dialogs };
}

// ---- tiny assertion helper ------------------------------------------------------------------------------------------
function checker() {
  const c = { fails: 0, total: 0 };
  c.ok = (cond, msg) => { c.total++; if (!cond) { c.fails++; console.log('  FAIL', msg); } else console.log('  ok  ', msg); };
  return c;
}

// ---- PGlite (Postgres in WebAssembly): all SQL files in the order they are run on Supabase ----------------------
const SQL_ORDER = ['supabase_setup.sql', 'supabase_update2.sql', 'add_batch_column.sql', 'cms_schema.sql', 'feature_additions.sql',
  'add_component_details.sql', 'cms_seed.sql', 'coupons.sql', 'payments.sql', 'reviews.sql', 'bot_logs.sql'];
const PRELUDE = `create role anon nologin; create role authenticated nologin; create schema auth; create schema storage;
  create table storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
  insert into storage.buckets(id,name,public) values ('component-images','component-images',true);
  create table storage.objects(id uuid default gen_random_uuid(), bucket_id text, name text);
  alter table storage.objects enable row level security;
  create or replace function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true),''),'{}')::jsonb $$;
  grant usage on schema public, auth to anon, authenticated;`;
const GRANTS = `grant select, insert, update, delete on all tables in schema public to anon, authenticated;
  grant execute on all functions in schema public to anon, authenticated;`;
const sqlFile = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const lockdown = () => sqlFile('admin_lockdown.sql').replace('YOUR_ADMIN_EMAIL@example.com', 'admin@test.com');
// the cron part of notifications.sql needs Supabase extensions; only its columns are needed here
const NOTIF_COLS = `alter table public.orders add column if not exists acknowledged boolean not null default false;
  alter table public.orders add column if not exists acknowledged_at timestamptz;`;
// ordered list of [label, sql] used by both the PGlite and the real-Postgres loaders
function sqlSteps(opts = {}) {
  const steps = [['prelude', PRELUDE]];
  for (const f of SQL_ORDER) steps.push([f, sqlFile(f)]);
  steps.push(['notifications columns', NOTIF_COLS], ['admin_lockdown.sql', lockdown()], ['push.sql', sqlFile('push.sql')],
    ['orders_lockdown.sql', sqlFile('orders_lockdown.sql')], ['grants', GRANTS],
    ['security_hardening.sql', sqlFile('security_hardening.sql')], ['grants', GRANTS],
    ['security_phase1.sql', sqlFile('security_phase1.sql')]);
  if (fs.existsSync(path.join(ROOT, 'security_phase2.sql'))) steps.push(['security_phase2.sql', sqlFile('security_phase2.sql')]);
  return steps.filter(([l]) => !(opts.skip || []).includes(l));
}
async function pgliteBoot(opts) {
  let PGlite;
  try { ({ PGlite } = await import('@electric-sql/pglite')); } catch (e) { ({ PGlite } = await import(path.join(process.env.CR_PGLITE_DIR || path.join(ROOT, 'tests/node_modules'), '@electric-sql/pglite/dist/index.js'))); }
  const db = new PGlite();
  for (const [label, sql] of sqlSteps(opts)) { try { await db.exec(sql); } catch (e) { throw new Error(label + ': ' + e.message); } }
  return db;
}

// ---- a real PostgreSQL server (optional, for the concurrency tests). Needs the `psql` command and a server you started. ----
const PSQL = (conn, extra) => ['-h', conn.host, '-p', String(conn.port), '-U', conn.user, '-d', conn.db, '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', ...extra];
function psql(conn, sql) {
  const r = cp.spawnSync('psql', PSQL(conn, ['-c', sql]), { encoding: 'utf8' });
  return { out: (r.stdout || '').trim(), err: (r.stderr || '').trim(), code: r.status };
}
// runs a whole script on its own connection, so many of these can run at the same moment
function psqlAsync(conn, script) {
  return new Promise((resolve) => {
    const p = cp.spawn('psql', PSQL(conn, ['-f', '-']), { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = ''; p.stdout.on('data', (d) => out += d); p.stderr.on('data', (d) => err += d);
    p.on('close', (code) => resolve({ out: out.trim(), err: err.trim(), code })); p.stdin.end(script);
  });
}
function realDbLoad(conn) {
  const admin = { ...conn, db: 'postgres' };
  psql(admin, `drop database if exists ${conn.db} with (force)`); psql(admin, `create database ${conn.db}`);
  // roles are cluster-wide: create them only if missing
  psql(conn, `do $$ begin if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if; if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if; end $$`);
  for (const [label, sql] of sqlSteps()) {
    const s = label === 'prelude' ? sql.replace('create role anon nologin; create role authenticated nologin;', '') : sql;
    const r = cp.spawnSync('psql', ['-h', conn.host, '-p', String(conn.port), '-U', conn.user, '-d', conn.db, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-f', '-'], { input: s, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(label + ': ' + (r.stderr || '').slice(0, 300));
  }
}

module.exports = { ROOT, stub, seed, startServer, launch, newPage, checker, pgliteBoot, sqlSteps, psql, psqlAsync, realDbLoad };
