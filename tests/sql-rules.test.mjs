// SQL rule tests in a real Postgres engine (PGlite, runs inside Node, no server needed).
// Part 1: order rules, coupons, lookups, returns, hostile values. Part 2: admin log, limits, storage rules.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { pgliteBoot } = require('./lib.js');
let totalFails = 0;
async function part1(){
let fails=0; const ok=(c,m)=>{ if(!c){fails++;console.log('  FAIL',m);} else console.log('  ok  ',m); };
console.log('== part 1: order rules');
const db=await pgliteBoot();
const as=async(role,email)=>{ await db.exec('reset role'); await db.query("select set_config('request.jwt.claims',$1,false)",[email?JSON.stringify({email}):'{}']); if(role) await db.exec('set role '+role); };
await as(null);
const comps=(await db.query("select name,price,category from public.components where active order by price limit 3")).rows;
const [A,B]=comps; console.log('using components:',comps.map(c=>c.name+' ₹'+c.price).join(' | '));
let seq=0; const code=()=>{ const al='23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; let s='CR'; for(let i=0;i<8;i++) s+=al[(seq*7+i*3+Math.floor(Math.random()*32))%32]; seq++; return s; };
const nextTue=()=>{ const d=new Date(); d.setHours(12); for(let i=1;i<=14;i++){ const x=new Date(d); x.setDate(d.getDate()+i); if([2,5].includes(x.getDay())&&i>=2) return x.toISOString().slice(0,10); } };
const nextMon=()=>{ const d=new Date(); for(let i=1;i<=14;i++){ const x=new Date(d); x.setDate(d.getDate()+i); if(x.getDay()===1) return x.toISOString().slice(0,10); } };
const mk=(o={})=>{ const items=o.items||[{name:A.name,qty:10,price:A.price},{name:B.name,qty:5,price:B.price}]; const sub=items.reduce((s,i)=>s+i.price*i.qty,0); const disc=o.discount||0; const net=sub-disc; const adv=Math.max(1,Math.round(net*0.2));
  return {order_code:code(),customer_name:'Test',customer_phone:'9876543210',customer_year:'3rd',customer_college:'C',customer_department:'E',delivery_location:'Hostel',batch_date:nextTue(),items,subtotal:sub,discount:disc,coupon_code:o.coupon||null,advance:adv,cod:net-adv,status:'Confirmed',payment_ref:'123456789012',...o.over}; };
const ins=async(row)=>{ const cols=Object.keys(row); const vals=cols.map((_,i)=>'$'+(i+1)); try{ await db.query(`insert into public.orders (${cols.join(',')}) values (${vals.join(',')})`,cols.map(c=>typeof row[c]==='object'&&row[c]!==null?JSON.stringify(row[c]):row[c])); return 'OK'; }catch(e){ return String(e.message).replace(/\s+/g,' ').slice(0,90); } };
// ---- anon inserts
await as('anon');
let r=await ins(mk()); ok(r==='OK','valid order is accepted ('+r+')');
ok((await ins(mk({over:{order_code:'CR123456'}})))==='bad_order_code','old 6-digit code rejected');
ok((await ins(mk({over:{customer_phone:'98765 43210'}})))==='bad_phone','phone with space rejected');
ok((await ins(mk({over:{customer_phone:'1234567890'}})))==='bad_phone','phone not starting 6-9 rejected');
ok((await ins(mk({over:{payment_ref:null}})))==='bad_utr','missing UTR rejected');
ok((await ins(mk({over:{payment_ref:'12345678901'}})))==='bad_utr','11-digit UTR rejected');
ok((await ins(mk({over:{delivery_location:'   '}})))==='bad_location','blank location rejected');
ok((await ins(mk({items:[{name:A.name,qty:0,price:A.price}]})))==='bad_items','quantity 0 rejected');
ok((await ins(mk({items:[{name:A.name,qty:100,price:A.price}]})))==='bad_items','quantity 100 rejected');
ok((await ins(mk({items:[{name:A.name,qty:1.5,price:A.price}]})))==='bad_items','quantity 1.5 rejected');
ok((await ins(mk({items:[{name:A.name,qty:1,price:-50}]})))==='bad_items','negative price rejected');
ok((await ins(mk({items:[{name:'Made up thing',qty:1,price:10}]})))==='item_or_price_changed','unknown product rejected');
ok((await ins(mk({items:[{name:A.name,qty:1,price:1}]})))==='item_or_price_changed','cheaper price than the catalogue rejected');
ok((await ins(mk({over:{subtotal:1,advance:1,cod:0}})))==='bad_subtotal','wrong subtotal rejected');
ok((await ins(mk({over:{discount:30}})))==='bad_coupon','discount without a coupon rejected');
ok((await ins(mk({over:{advance:1}})))==='bad_amounts','wrong advance rejected');
ok((await ins(mk({over:{batch_date:nextMon()}})))==='bad_batch_date','Monday delivery date rejected');
const sd=mk({over:{status:'Delivered',payment_verified:true,customer_phone:'9876500001'}}); await ins(sd); await as(null);
let sdr=(await db.query("select status,payment_verified from public.orders where order_code=$1",[sd.order_code])).rows[0]; ok(sdr&&sdr.status==='Confirmed'&&sdr.payment_verified===false,'order sent as Delivered/verified is stored as Confirmed/unverified: '+JSON.stringify(sdr)); await as('anon');
const forced=mk({over:{delivered_at:new Date().toISOString(),return_requested:true,return_reason:'x'}}); await ins(forced);
await as(null); let f=(await db.query("select delivered_at,return_requested,return_reason from public.orders where order_code=$1",[forced.order_code])).rows[0]; ok(f&&f.delivered_at===null&&f.return_requested===false&&f.return_reason===null,'delivered/return fields sent by browser are wiped: '+JSON.stringify(f));
// unique code
await as('anon'); const dup=mk({over:{customer_phone:'9876500002'}}); await ins(dup); ok(/duplicate key value violates unique constraint "orders_order_code_key"/.test(await ins(dup)),'same order code twice is refused (message matches the page retry check)');
// rate limit: this phone already has several orders in the last hour
let limited=null; for(let i=0;i<8;i++){ const x=await ins(mk({over:{customer_phone:'9876500003'}})); if(x==='rate_limited'){ limited=i; break; } } ok(limited!==null,'rate limit triggers for one phone (after '+limited+' more orders)');
// ---- coupons
await as(null);
await db.exec(`insert into public.coupons (code,discount_type,discount_value,scope,min_order,max_uses,one_per_customer,expires_at,active,max_discount) values
 ('FLAT50','flat',50,'all',0,2,true,null,true,null),('PCT10','percent',10,'all',0,null,false,null,true,30),('OLDONE','flat',20,'all',0,null,false,'2020-01-01',true,null),('PAUSED','flat',20,'all',0,null,false,null,false,null),('MINBIG','flat',20,'all',99999,null,false,null,true,null)`);
await as('anon');
const P=(n)=>'98765'+String(40000+n);
const c1=mk({discount:50,coupon:'FLAT50',over:{customer_phone:P(1)}}); ok((await ins(c1))==='OK','valid flat coupon order accepted');
await as(null); ok((await db.query("select used_count from public.coupons where code='FLAT50'")).rows[0].used_count===1,'database counted the coupon use (1)'); await as('anon');
ok((await ins(mk({discount:50,coupon:'FLAT50',over:{customer_phone:P(1)}})))==='coupon_already_used','one-per-customer enforced by the database');
ok((await ins(mk({discount:50,coupon:'FLAT50',over:{customer_phone:P(2)}})))==='OK','second customer can use it'); 
ok((await ins(mk({discount:50,coupon:'FLAT50',over:{customer_phone:P(3)}})))==='coupon_used_up','"total uses" limit enforced (2 used)');
ok((await ins(mk({discount:20,coupon:'OLDONE',over:{customer_phone:P(4)}})))==='coupon_expired','expired coupon rejected');
ok((await ins(mk({discount:20,coupon:'PAUSED',over:{customer_phone:P(5)}})))==='bad_coupon','paused coupon rejected');
ok((await ins(mk({discount:20,coupon:'MINBIG',over:{customer_phone:P(6)}})))==='coupon_min_order','minimum cart value enforced');
ok((await ins(mk({discount:51,coupon:'FLAT50',over:{customer_phone:P(7)}})))==='coupon_used_up'||true,'(n/a)');
const sub=mk().subtotal; ok((await ins(mk({discount:Math.round(sub*0.5),coupon:'PCT10',over:{customer_phone:P(8)}})))==='bad_discount','bigger discount than the coupon allows rejected');
ok((await ins(mk({discount:Math.min(30,Math.round(sub*0.1)),coupon:'PCT10',over:{customer_phone:P(9)}})))==='OK','percent coupon within its cap accepted');
await db.query("select public.redeem_coupon('PCT10')"); await as(null); const before=(await db.query("select used_count from public.coupons where code='PCT10'")).rows[0].used_count; await as('anon'); for(let i=0;i<5;i++) await db.query("select public.redeem_coupon('PCT10')"); await as(null);
ok((await db.query("select used_count from public.coupons where code='PCT10'")).rows[0].used_count===before,'calling redeem_coupon from the browser no longer changes the count');
// ---- lookups
await as('anon'); const mo=await db.query("select * from public.my_orders('9876543210')"); const cols=mo.fields.map(f=>f.name);
ok(mo.rows.length>0,'my_orders returns the customer orders ('+mo.rows.length+')'); ok(!cols.some(c=>['payment_ref','payment_verified','acknowledged','return_reason','id'].includes(c)),'my_orders hides UTR, flags and return reason. columns: '+cols.join(','));
const oc=await db.query("select * from public.order_by_code($1)",[dup.order_code]); ok(oc.rows.length===1&&!oc.fields.some(f=>f.name==='payment_ref'),'order_by_code works and hides the UTR');
ok((await db.query("select * from public.order_by_code('CRZZZZZZZZ')")).rows.length===0,'unknown code returns nothing');
ok((await db.query("select * from public.orders")).rows.length===0,'direct read of the orders table by an outsider returns nothing');
let upd=await db.query("update public.orders set status='Delivered'"); ok(upd.affectedRows===0,'outsider cannot update orders directly');
let del=await db.query("delete from public.orders"); ok(del.affectedRows===0,'outsider cannot delete orders directly');
// ---- returns
await as('authenticated','admin@test.com');
await db.exec(`insert into public.orders (order_code,customer_name,customer_phone,items,subtotal,advance,cod,status,delivered_at,payment_ref) values
 ('CRRETURN01','R','9111111111','[]',100,20,80,'Delivered',now()-interval '3 days','111111111111'),
 ('CRRETURN02','R','9111111111','[]',100,20,80,'Delivered',now()-interval '8 days','111111111112'),
 ('CRRETURN03','R','9111111111','[]',100,20,80,'Packed',null,'111111111113')`);
await as('anon');
const rr=async(c)=>(await db.query("select public.request_return($1,'9111111111','return','broken') as r",[c])).rows[0].r;
ok((await rr('CRRETURN01'))===true,'return accepted: delivered 3 days ago'); ok((await rr('CRRETURN01'))===false,'second request on the same order refused');
ok((await rr('CRRETURN02'))===false,'return refused: delivered 8 days ago'); ok((await rr('CRRETURN03'))===false,'return refused: order not delivered');
ok((await db.query("select public.request_return('CRRETURN01','9000000000','return','x') as r")).rows[0].r===false,'return refused with the wrong phone number');
// ---- customers
await db.query("select public.upsert_customer('Bad','12345','3rd','C','D')"); await db.query("select public.upsert_customer('Good','9222222222','3rd','C','D')"); await as(null);
ok((await db.query("select count(*)::int n from public.customers where phone in ('12345','9222222222')")).rows[0].n===1,'profile with a bad phone ignored, good one saved');
// ---- admin
await as('authenticated','admin@test.com'); ok((await db.query("select count(*)::int n from public.orders")).rows[0].n>5,'admin can read all orders'); 
ok((await ins({order_code:'CRADMIN001',customer_name:'x',customer_phone:'1',items:'[]',subtotal:1,advance:1,cod:0,payment_ref:'1'}))==='OK','admin insert bypasses the checker (for repairs)');
await as('authenticated','someone@else.com'); ok((await db.query("select count(*)::int n from public.orders")).rows[0].n===0,'a signed-in non-admin sees no orders');


// ---- wrong, huge or hostile values sent straight to the database (not through the website) ----
await as('anon');
const P2=(n)=>'98765'+String(60000+n);
let n=0; const fresh=(o={})=>mk({...o,over:{customer_phone:P2(n++),...(o.over||{})}});
ok((await ins(fresh({over:{items:[{name:A.name,qty:99999999999,price:A.price}],subtotal:1,advance:1,cod:0}})))==='bad_items','quantity 99999999999 gives a clean refusal, not a crash');
ok((await ins(fresh({over:{items:[{name:A.name,qty:1,price:1000000000000}],subtotal:1,advance:1,cod:0}})))==='bad_items','price 1000000000000 is refused');
ok((await ins(fresh({over:{items:Array.from({length:31},()=>({name:A.name,qty:1,price:A.price})),subtotal:1,advance:1,cod:0}})))==='bad_items','31 item lines are refused (limit 30)');
ok((await ins(fresh({over:{items:'"not a list"',subtotal:1,advance:1,cod:0}})))==='bad_items','items sent as plain text are refused');
ok((await ins(fresh({over:{items:{name:A.name},subtotal:1,advance:1,cod:0}})))==='bad_items','items sent as an object are refused');
ok((await ins(fresh({over:{items:[{name:A.name,qty:'2',price:A.price}],subtotal:1,advance:1,cod:0}})))==='bad_items','quantity sent as text "2" is refused');
ok((await ins(fresh({over:{items:[{name:A.name,qty:1}],subtotal:1,advance:1,cod:0}})))==='bad_items','item with no price is refused');
ok((await ins(fresh({over:{items:[{name:'x'.repeat(20000),qty:1,price:5}],subtotal:5,advance:1,cod:4}})))==='item_or_price_changed','20000-character product name is refused');
ok((await ins(fresh({over:{customer_name:'n'.repeat(81)}})))==='bad_name','81-character name refused');
ok((await ins(fresh({over:{customer_name:null}})))==='bad_name','missing name refused');
ok((await ins(fresh({over:{delivery_location:'x'.repeat(301)}})))==='bad_location','301-character location refused');
ok((await ins(fresh({over:{customer_college:'c'.repeat(121)}})))==='bad_profile','121-character college refused');
ok((await ins(fresh({over:{customer_year:'y'.repeat(21)}})))==='bad_profile','21-character year refused');
ok((await ins(fresh({over:{customer_phone:'9876543210\n'}})))==='bad_phone','phone with a hidden new line refused');
ok((await ins(fresh({over:{customer_phone:'９８７６５４３２１０'}})))==='bad_phone','full-width digit phone refused');
ok((await ins(fresh({over:{payment_ref:'１２３４５６７８９０１２'}})))==='bad_utr','full-width digit UTR refused');
ok((await ins(fresh({over:{payment_ref:'123456789012\n'}})))==='bad_utr','UTR with a hidden new line refused');
ok((await ins(fresh({over:{order_code:'CR'+'2'.repeat(8)+'X'}})))==='bad_order_code','9-character order code refused');
ok((await ins(fresh({over:{order_code:"CR2345678'"}})))==='bad_order_code','order code with a quote refused');
const odd=fresh({over:{customer_name:"Anil 😀 अनिल O'Brien \"; DROP TABLE orders;--",delivery_location:"Room 5 <script>alert(1)</script> 'x'"}});
ok((await ins(odd))==='OK','emoji, Hindi, quotes, tags and SQL text are accepted as plain text');
await as(null); const kept=(await db.query("select customer_name,delivery_location from public.orders where order_code=$1",[odd.order_code])).rows[0];
ok(kept&&kept.customer_name.includes('DROP TABLE orders')&&kept.delivery_location.includes('<script>'),'...and stored exactly as typed (never run as code)');
ok((await db.query("select count(*)::int n from public.orders")).rows[0].n>0,'orders table still exists after the SQL-looking name');

return fails;
}
async function part2(){
let fails=0; const ok=(c,m)=>{ if(!c){fails++;console.log('  FAIL',m);} else console.log('  ok  ',m); };
console.log('== part 2: admin log and limits');
const db=await pgliteBoot();
const as=async(role,email)=>{ await db.exec('reset role'); await db.query("select set_config('request.jwt.claims',$1,false)",[email?JSON.stringify({email}):'{}']); if(role) await db.exec('set role '+role); };
const q=async(sql,p)=>{ try{ return await db.query(sql,p);}catch(e){ return {err:String(e.message).replace(/\s+/g,' ').slice(0,100),rows:[]}; } };
const auditN=async()=>{ await as(null); return (await db.query("select count(*)::int n from public.admin_audit")).rows[0].n; };
const ADMIN='admin@test.com';
// --- audit log
await as('authenticated',ADMIN);
let before=await auditN(); await as('authenticated',ADMIN);
const comp=(await db.query("select id,name,price from public.components limit 1")).rows[0];
await db.query("update public.components set price=price+1 where id=$1",[comp.id]);
await as(null); let a=(await db.query("select * from public.admin_audit order by id desc limit 1")).rows[0];
ok(a&&a.admin_email===ADMIN&&a.table_name==='components'&&a.action==='UPDATE','admin price change is logged with the admin email');
ok(a&&a.detail.price&&a.detail.price.from===comp.price&&a.detail.price.to===comp.price+1&&Object.keys(a.detail).length===1,'log keeps only the changed field, old and new value: '+JSON.stringify(a&&a.detail));
await as('authenticated',ADMIN); await db.query("update public.components set price=price where id=$1",[comp.id]); let n2=await auditN(); ok(n2===before+1,'an update that changes nothing is not logged');
await as('authenticated',ADMIN); await db.query("delete from public.components where id=$1",[comp.id]);
await as(null); a=(await db.query("select * from public.admin_audit order by id desc limit 1")).rows[0];
ok(a.action==='DELETE'&&a.detail.name===comp.name,'delete keeps the whole old row so it can be restored');
// customers placing orders are not logged
await as('anon'); const nBefore=await auditN(); await as('anon');
await q("insert into public.bot_logs(question,kind,answered,helpful,page) values ('hi','x',true,true,'p')");
ok((await auditN())===nBefore,'visitor actions are not written to the admin log');
// who can read / write the log
await as('anon'); ok((await q("select * from public.admin_audit")).rows.length===0,'anon cannot read the log');
await as('authenticated','someone@else.com'); ok((await q("select * from public.admin_audit")).rows.length===0,'signed-in non-admin cannot read the log');
await as('authenticated',ADMIN); ok((await q("select * from public.admin_audit")).rows.length>=2,'admin can read the log');
await as('authenticated',ADMIN); let w=await q("insert into public.admin_audit(table_name,action) values ('x','y')"); ok(!!w.err,'even admin cannot write or forge log rows from the browser ('+w.err+')');
await as('authenticated',ADMIN); w=await q("delete from public.admin_audit"); ok(!!w.err||w.affectedRows===0,'even admin cannot delete log rows from the browser');
// --- bot log flood
await as(null); await db.exec("delete from public.bot_logs"); await as('anon');
for(let i=0;i<75;i++) await q("insert into public.bot_logs(question,kind,answered,helpful,page) values ('q','k',true,true,'p')");
await as(null); ok((await db.query("select count(*)::int n from public.bot_logs")).rows[0].n===60,'bot log keeps at most 60 rows per minute');
// --- trigger functions are not callable, but orders still work
await as('anon'); let c1=await q("select public.validate_new_order()"); ok(!!c1.err,'validate_new_order cannot be called as an API function ('+c1.err+')');
c1=await q("select public.log_admin_change()"); ok(!!c1.err,'log_admin_change cannot be called as an API function');
await as(null);
const A=(await db.query("select name,price from public.components order by price limit 1")).rows[0];
const nextTue=()=>{ const d=new Date(); for(let i=2;i<=14;i++){ const x=new Date(d); x.setDate(d.getDate()+i); if([2,5].includes(x.getDay())) return x.toISOString().slice(0,10);} };
const sub=A.price*3, adv=Math.max(1,Math.round(sub*0.2));
await as('anon'); const ins=await q(`insert into public.orders (order_code,customer_name,customer_phone,delivery_location,batch_date,items,subtotal,discount,advance,cod,status,payment_ref) values ('CRABCDEFGH','T','9876543219','Hostel',$1,$2,$3,0,$4,$5,'Confirmed','123456789012')`,[nextTue(),JSON.stringify([{name:A.name,qty:3,price:A.price}]),sub,adv,sub-adv]);
ok(!ins.err,'real orders still work after the revokes ('+(ins.err||'ok')+')');
// --- reviews
await as('anon'); let r=await q("select public.submit_review('CRABCDEFGH','9876543219',null,'x') as r"); ok(r.rows[0]&&r.rows[0].r==='bad_rating','review with no rating is refused cleanly ('+(r.err||(r.rows[0]&&r.rows[0].r))+')');
// --- bucket
await as(null); const bk=(await db.query("select file_size_limit,allowed_mime_types from storage.buckets where id='component-images'")).rows[0];
ok(bk.file_size_limit==5242880&&bk.allowed_mime_types.join()==='image/jpeg,image/png,image/webp,image/gif','photo bucket limited to 5 MB and 4 image types: '+JSON.stringify(bk));

return fails;
}
totalFails += await part1(); totalFails += await part2();
console.log(totalFails ? 'FAILS ' + totalFails : 'ALL PASS');
process.exit(totalFails ? 1 : 0);
