// PostgreSQL 래퍼. DATABASE_URL 없으면 메모리 폴백.
// 테이블: bookings(예약), inventory(지점×SKU 재고), sales(결제 라인)
let pool=null, ready=false;
const mem={ bookings:[], inventory:[], sales:[], orders:[], customers:[], pickups:[] };
try{
  if(process.env.DATABASE_URL){
    const { Pool } = require('pg');
    pool = new Pool({ connectionString: process.env.DATABASE_URL,
      ssl: process.env.PGSSL==='off'? false : { rejectUnauthorized:false } });
  }
}catch(e){ console.warn('pg 모듈 없음 — 메모리 폴백'); }

const STORES=['성수점','홍대점','판교점'];

// ---- 30종 SKU 카탈로그 (디자인 × 사이즈) ----
const DESIGNS=[
  {base:'로마 클래식', cat:'테',   price:189000, medical:false},
  {base:'로마 와이드', cat:'테',   price:189000, medical:false},
  {base:'로마 슬림',   cat:'테',   price:189000, medical:false},
  {base:'로마 라운드', cat:'테',   price:189000, medical:false},
  {base:'편광 선글라스', cat:'선글라스', price:230000, medical:false},
  {base:'클립온 선글라스', cat:'선글라스', price:90000, medical:false}
];
const SIZES=['S','M','L']; // 디자인×사이즈
function buildCatalog(){
  const out=[];
  DESIGNS.forEach(function(d){ SIZES.forEach(function(s){
    out.push({ sku:skuId(d.base,s), name:d.base+' '+s, cat:d.cat, price:d.price, medical:d.medical });
  });});
  // 사이즈 없는 단품들 (렌즈·콘택트·액세서리) — 합쳐서 30종 맞춤
  const flat=[
    {name:'알도R 1.60 렌즈', cat:'렌즈', price:120000, medical:true},
    {name:'누진 렌즈',       cat:'렌즈', price:160000, medical:true},
    {name:'청광 렌즈',       cat:'렌즈', price:90000,  medical:true},
    {name:'변색 렌즈',       cat:'렌즈', price:140000, medical:true},
    {name:'1일용 콘택트(30P)', cat:'콘택트', price:35000, medical:false},
    {name:'1개월용 콘택트(2P)', cat:'콘택트', price:28000, medical:false},
    {name:'난시용 콘택트(30P)', cat:'콘택트', price:42000, medical:false},
    {name:'컬러 콘택트(10P)',   cat:'콘택트', price:30000, medical:false},
    {name:'오디오 이어팁',  cat:'액세서리', price:18000, medical:false},
    {name:'안경 케이스',    cat:'액세서리', price:12000, medical:false},
    {name:'안경 클리너 세트', cat:'액세서리', price:9000, medical:false},
    {name:'스포츠 스트랩',  cat:'액세서리', price:15000, medical:false}
  ];
  flat.forEach(function(f,i){ out.push({ sku:'X'+(i+1), name:f.name, cat:f.cat, price:f.price, medical:f.medical }); });
  return out; // 18 + 12 = 30종
}
function skuId(base,s){
  const map={'로마 클래식':'CL','로마 와이드':'WD','로마 슬림':'SL','로마 라운드':'RD','편광 선글라스':'SP','클립온 선글라스':'SC'};
  return (map[base]||'GN')+'-'+s;
}
const CATALOG=buildCatalog();
const SEED_CUSTOMERS=[
  {name:'양지근',phone:'010-2480-1001',store:'성수점',size:'F2×T2',face:'142mm / 낮은코',pd:'63.5mm',rx:'OD -3.25 / OS -3.50',nose:'낮음',seg:'단골'},
  {name:'김서연',phone:'010-3391-2210',store:'성수점',size:'F1×T1',face:'131mm / 표준',pd:'60.0mm',rx:'OD -1.75 / OS -2.00',nose:'표준',seg:'단골'},
  {name:'박도현',phone:'010-7782-5503',store:'홍대점',size:'F3×T2',face:'149mm / 높은코',pd:'66.0mm',rx:'OD -4.50 / OS -4.25',nose:'높음',seg:'신규'},
  {name:'이수민',phone:'010-5519-8834',store:'성수점',size:'F2×T1',face:'138mm / 표준',pd:'62.0mm',rx:'OD -2.25 / OS -2.25',nose:'표준',seg:'재방문'},
  {name:'정하준',phone:'010-6640-1199',store:'판교점',size:'F2×T2',face:'143mm / 낮은코',pd:'64.0mm',rx:'OD -3.00 / OS -2.75',nose:'낮음',seg:'단골'},
  {name:'최우진',phone:'010-2231-7788',store:'홍대점',size:'F2×T3',face:'145mm / 표준',pd:'65.0mm',rx:'OD -2.50 / OS -2.50',nose:'표준',seg:'재방문'},
  {name:'한지우',phone:'010-9982-3344',store:'판교점',size:'F1×T2',face:'133mm / 낮은코',pd:'59.5mm',rx:'OD -1.25 / OS -1.50',nose:'낮음',seg:'신규'}
];

function seedStock(sku, store){
  // 데모 시드: 지점별로 살짝 다르게, 디자인/사이즈별 편차
  let base = 8;
  if(/-M$/.test(sku)) base=14; else if(/-S$/.test(sku)) base=7; else if(/-L$/.test(sku)) base=6;
  if(sku[0]==='X') base=16; // 렌즈/콘택트/액세서리 넉넉
  const bump = {'성수점':4,'홍대점':1,'판교점':-1}[store]||0;
  return Math.max(0, base+bump);
}

async function init(){
  if(!pool){ ready=false; seedMem(); return; }
  await pool.query(`CREATE TABLE IF NOT EXISTS bookings(
    id SERIAL PRIMARY KEY, store TEXT, date TEXT, time TEXT, name TEXT, phone TEXT, created_at TIMESTAMPTZ DEFAULT now())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS inventory(
    store TEXT, sku TEXT, name TEXT, cat TEXT, price INT, medical BOOLEAN,
    stock INT, sold INT DEFAULT 0, PRIMARY KEY(store,sku))`);
  await pool.query(`CREATE TABLE IF NOT EXISTS sales(
    id SERIAL PRIMARY KEY, store TEXT, date TEXT, sku TEXT, name TEXT, cat TEXT,
    qty INT, amount INT, medical BOOLEAN, method TEXT, created_at TIMESTAMPTZ DEFAULT now())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS orders(
    id SERIAL PRIMARY KEY, store TEXT, sku TEXT, name TEXT, cat TEXT, qty INT,
    status TEXT DEFAULT '대기', created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS customers(
    id SERIAL PRIMARY KEY, name TEXT, phone TEXT, store TEXT,
    size TEXT, face TEXT, pd TEXT, rx TEXT, nose TEXT,
    seg TEXT, created_at TIMESTAMPTZ DEFAULT now())`);
  await pool.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS customer_id INT`);
  await pool.query(`CREATE TABLE IF NOT EXISTS pickups(
    id SERIAL PRIMARY KEY, store TEXT, customer_id INT, name TEXT, phone TEXT,
    kind TEXT,            -- A(도수) / B(비도수) / C(소모품)
    items TEXT,           -- 선택 제품 요약
    rx TEXT,              -- 도수(A형)
    date TEXT, time TEXT, -- 픽업 예약
    pay_type TEXT,        -- 선결제 / 보증금 / 매장결제 / 온라인
    amount INT DEFAULT 0, deposit INT DEFAULT 0,
    status TEXT DEFAULT '예약',  -- 예약 / 방문완료 / 구매전환 / 취소
    created_at TIMESTAMPTZ DEFAULT now())`);
  const cc=await pool.query('SELECT COUNT(*)::int AS c FROM customers');
  if(cc.rows[0].c===0){ for(const c of SEED_CUSTOMERS){
    await pool.query('INSERT INTO customers(name,phone,store,size,face,pd,rx,nose,seg) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [c.name,c.phone,c.store,c.size,c.face,c.pd,c.rx,c.nose,c.seg]); } }
  // 재고 시드: 비어있을 때만
  const c=await pool.query('SELECT COUNT(*)::int AS c FROM inventory'); 
  if(c.rows[0].c===0){
    for(const st of STORES){ for(const it of CATALOG){
      await pool.query('INSERT INTO inventory(store,sku,name,cat,price,medical,stock,sold) VALUES($1,$2,$3,$4,$5,$6,$7,0)',
        [st,it.sku,it.name,it.cat,it.price,it.medical,seedStock(it.sku,st)]);
    }}
  }
  ready=true;
}
function seedMem(){
  SEED_CUSTOMERS.forEach(function(c,i){ mem.customers.push(Object.assign({id:i+1},c)); });
  STORES.forEach(function(st){ CATALOG.forEach(function(it){
    mem.inventory.push({store:st,sku:it.sku,name:it.name,cat:it.cat,price:it.price,medical:it.medical,stock:seedStock(it.sku,st),sold:0});
  });});
}

// ---- bookings ----
async function listBookings(store,date){
  if(ready){const r=await pool.query('SELECT store,date,time,name,phone FROM bookings WHERE ($1::text IS NULL OR store=$1) AND ($2::text IS NULL OR date=$2) ORDER BY date,time',[store||null,date||null]);return r.rows;}
  return mem.bookings.filter(b=>(!store||b.store===store)&&(!date||b.date===date));
}
async function countSlot(store,date,time){
  if(ready){const r=await pool.query('SELECT COUNT(*)::int AS c FROM bookings WHERE store=$1 AND date=$2 AND time=$3',[store,date,time]);return r.rows[0].c;}
  return mem.bookings.filter(b=>b.store===store&&b.date===date&&b.time===time).length;
}
async function addBooking(b){
  if(ready){const r=await pool.query('INSERT INTO bookings(store,date,time,name,phone) VALUES($1,$2,$3,$4,$5) RETURNING store,date,time,name,phone',[b.store,b.date,b.time,b.name,b.phone||'']);return r.rows[0];}
  const row={store:b.store,date:b.date,time:b.time,name:b.name,phone:b.phone||''};mem.bookings.push(row);return row;
}

// ---- inventory ----
async function getInventory(store){
  if(ready){const r=await pool.query('SELECT sku,name,cat,price,medical,stock,sold FROM inventory WHERE store=$1 ORDER BY cat,name',[store]);return r.rows;}
  return mem.inventory.filter(i=>i.store===store).map(i=>({sku:i.sku,name:i.name,cat:i.cat,price:i.price,medical:i.medical,stock:i.stock,sold:i.sold}));
}
async function getStock(store,sku){
  if(ready){const r=await pool.query('SELECT stock FROM inventory WHERE store=$1 AND sku=$2',[store,sku]);return r.rows[0]?r.rows[0].stock:0;}
  const it=mem.inventory.find(i=>i.store===store&&i.sku===sku);return it?it.stock:0;
}
async function restock(store, threshold, add){
  if(ready){const r=await pool.query('UPDATE inventory SET stock=stock+$3 WHERE store=$1 AND stock<=$2 RETURNING sku',[store,threshold,add]);return r.rowCount;}
  let n=0;mem.inventory.forEach(i=>{if(i.store===store&&i.stock<=threshold){i.stock+=add;n++;}});return n;
}

// ---- sales (결제 = 여러 라인 + 재고 차감) ----
async function recordSale(store, date, method, lines, customerId){
  // lines: [{sku,name,cat,qty,amount,medical}]
  if(ready){
    const client=await pool.connect();
    try{
      await client.query('BEGIN');
      for(const ln of lines){
        const s=await client.query('SELECT stock FROM inventory WHERE store=$1 AND sku=$2 FOR UPDATE',[store,ln.sku]);
        if(!s.rows[0] || s.rows[0].stock<ln.qty){ await client.query('ROLLBACK'); return {ok:false,error:'재고 부족: '+ln.name}; }
      }
      for(const ln of lines){
        await client.query('UPDATE inventory SET stock=stock-$3, sold=sold+$3 WHERE store=$1 AND sku=$2',[store,ln.sku,ln.qty]);
        await client.query('INSERT INTO sales(store,date,sku,name,cat,qty,amount,medical,method,customer_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
          [store,date,ln.sku,ln.name,ln.cat,ln.qty,ln.amount,ln.medical,method,customerId||null]);
      }
      await client.query('COMMIT');
      return {ok:true};
    }catch(e){ await client.query('ROLLBACK'); return {ok:false,error:'결제 처리 오류'}; }
    finally{ client.release(); }
  }
  // 메모리 폴백
  for(const ln of lines){ const it=mem.inventory.find(i=>i.store===store&&i.sku===ln.sku); if(!it||it.stock<ln.qty)return{ok:false,error:'재고 부족: '+ln.name}; }
  for(const ln of lines){ const it=mem.inventory.find(i=>i.store===store&&i.sku===ln.sku); it.stock-=ln.qty; it.sold+=ln.qty;
    mem.sales.push({store,date,sku:ln.sku,name:ln.name,cat:ln.cat,qty:ln.qty,amount:ln.amount,medical:ln.medical,method,customer_id:customerId||null}); }
  return {ok:true};
}
async function salesSummary(store, date){
  // 반환: {total, byCat:{cat:{qty,amt}}}
  let rows;
  if(ready){const r=await pool.query('SELECT cat, SUM(qty)::int AS qty, SUM(amount)::int AS amt FROM sales WHERE store=$1 AND date=$2 GROUP BY cat',[store,date]);rows=r.rows;}
  else{ const m={}; mem.sales.filter(s=>s.store===store&&s.date===date).forEach(s=>{m[s.cat]=m[s.cat]||{qty:0,amt:0};m[s.cat].qty+=s.qty;m[s.cat].amt+=s.amount;}); rows=Object.keys(m).map(c=>({cat:c,qty:m[c].qty,amt:m[c].amt})); }
  const byCat={}; let total=0; rows.forEach(r=>{byCat[r.cat]={qty:r.qty,amt:r.amt};total+=r.amt;});
  return {total, byCat};
}
async function salesDaily(store, from, to){
  // 일별 매출 (재무 탭/본부용)
  if(ready){const r=await pool.query('SELECT date, SUM(amount)::int AS amt, SUM(qty)::int AS qty FROM sales WHERE ($1::text IS NULL OR store=$1) AND date BETWEEN $2 AND $3 GROUP BY date ORDER BY date',[store||null,from,to]);return r.rows;}
  const m={}; mem.sales.filter(s=>(!store||s.store===store)&&s.date>=from&&s.date<=to).forEach(s=>{m[s.date]=m[s.date]||{amt:0,qty:0};m[s.date].amt+=s.amount;m[s.date].qty+=s.qty;});
  return Object.keys(m).sort().map(d=>({date:d,amt:m[d].amt,qty:m[d].qty}));
}

async function refundSale(store, date, method, lines){
  // 환불: 재고 복구 + sales에 음수 라인 기록
  if(ready){
    const client=await pool.connect();
    try{
      await client.query('BEGIN');
      for(const ln of lines){
        await client.query('UPDATE inventory SET stock=stock+$3, sold=GREATEST(0,sold-$3) WHERE store=$1 AND sku=$2',[store,ln.sku,ln.qty]);
        await client.query('INSERT INTO sales(store,date,sku,name,cat,qty,amount,medical,method) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
          [store,date,ln.sku,ln.name,ln.cat,-ln.qty,-ln.amount,ln.medical,method+'환불']);
      }
      await client.query('COMMIT'); return {ok:true};
    }catch(e){ await client.query('ROLLBACK'); return {ok:false,error:'환불 처리 오류'}; }
    finally{ client.release(); }
  }
  for(const ln of lines){ const it=mem.inventory.find(i=>i.store===store&&i.sku===ln.sku);
    if(it){ it.stock+=ln.qty; it.sold=Math.max(0,it.sold-ln.qty); }
    mem.sales.push({store,date,sku:ln.sku,name:ln.name,cat:ln.cat,qty:-ln.qty,amount:-ln.amount,medical:ln.medical,method:method+'환불'}); }
  return {ok:true};
}
async function recentSales(store, limit){
  // 최근 결제 라인 (환불 대상 선택용)
  if(ready){const r=await pool.query('SELECT id,date,sku,name,cat,qty,amount,method FROM sales WHERE store=$1 AND qty>0 ORDER BY id DESC LIMIT $2',[store,limit||20]);return r.rows;}
  return mem.sales.filter(s=>s.store===store&&s.qty>0).slice(-(limit||20)).reverse().map((s,i)=>Object.assign({id:i},s));
}

// ---- orders (발주) : status 대기 -> 승인 -> 입고완료 ----
async function createOrder(store, sku, name, cat, qty){
  if(ready){const r=await pool.query("INSERT INTO orders(store,sku,name,cat,qty,status) VALUES($1,$2,$3,$4,$5,'대기') RETURNING id,store,sku,name,cat,qty,status",[store,sku,name,cat,qty]);return r.rows[0];}
  const row={id:mem.orders.length+1,store,sku,name,cat,qty,status:'대기'};mem.orders.push(row);return row;
}
async function listOrders(store, status){
  if(ready){const r=await pool.query('SELECT id,store,sku,name,cat,qty,status FROM orders WHERE ($1::text IS NULL OR store=$1) AND ($2::text IS NULL OR status=$2) ORDER BY id DESC',[store||null,status||null]);return r.rows;}
  return mem.orders.filter(o=>(!store||o.store===store)&&(!status||o.status===status)).slice().reverse();
}
async function updateOrder(id, status){
  // 입고완료 시 해당 지점 재고 증가
  if(ready){
    const o=await pool.query('SELECT store,sku,qty,status FROM orders WHERE id=$1',[id]);
    if(!o.rows[0]) return {ok:false,error:'발주 없음'};
    if(status==='입고완료' && o.rows[0].status!=='입고완료'){
      await pool.query('UPDATE inventory SET stock=stock+$3 WHERE store=$1 AND sku=$2',[o.rows[0].store,o.rows[0].sku,o.rows[0].qty]);
    }
    await pool.query('UPDATE orders SET status=$2, updated_at=now() WHERE id=$1',[id,status]);
    return {ok:true};
  }
  const o=mem.orders.find(x=>x.id===id); if(!o)return{ok:false,error:'발주 없음'};
  if(status==='입고완료' && o.status!=='입고완료'){ const it=mem.inventory.find(i=>i.store===o.store&&i.sku===o.sku); if(it)it.stock+=o.qty; }
  o.status=status; return {ok:true};
}
async function lowStock(store, threshold){
  // 발주 추천: 재고 <= threshold 인 SKU
  if(ready){const r=await pool.query('SELECT sku,name,cat,stock FROM inventory WHERE store=$1 AND stock<=$2 ORDER BY stock',[store,threshold]);return r.rows;}
  return mem.inventory.filter(i=>i.store===store&&i.stock<=threshold).map(i=>({sku:i.sku,name:i.name,cat:i.cat,stock:i.stock}));
}

// ---- customers ----
async function listCustomers(store, seg){
  if(ready){const r=await pool.query('SELECT id,name,phone,store,size,face,pd,rx,nose,seg FROM customers WHERE ($1::text IS NULL OR store=$1) AND ($2::text IS NULL OR seg=$2) ORDER BY name',[store||null,seg||null]);return r.rows;}
  return mem.customers.filter(c=>(!store||c.store===store)&&(!seg||c.seg===seg));
}
async function getCustomer(id){
  if(ready){const r=await pool.query('SELECT id,name,phone,store,size,face,pd,rx,nose,seg FROM customers WHERE id=$1',[id]);return r.rows[0]||null;}
  return mem.customers.find(c=>c.id==id)||null;
}
async function customerHistory(id){
  // 그 고객의 구매 이력 (sales)
  if(ready){const r=await pool.query('SELECT date,name,cat,qty,amount FROM sales WHERE customer_id=$1 AND qty>0 ORDER BY id DESC',[id]);return r.rows;}
  return mem.sales.filter(s=>s.customer_id==id&&s.qty>0).slice().reverse();
}
async function addCustomer(c){
  if(ready){const r=await pool.query('INSERT INTO customers(name,phone,store,size,face,pd,rx,nose,seg) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id',[c.name,c.phone||'',c.store||'',c.size||'',c.face||'',c.pd||'',c.rx||'',c.nose||'',c.seg||'신규']);return r.rows[0].id;}
  const id=mem.customers.length+1; mem.customers.push(Object.assign({id:id},c)); return id;
}
async function moveCustomer(id, toStore){
  if(ready){await pool.query('UPDATE customers SET store=$2 WHERE id=$1',[id,toStore]); return {ok:true};}
  var c=mem.customers.find(function(x){return x.id==id;}); if(c)c.store=toStore; return {ok:true};
}
async function segCounts(store){
  // 마케팅 세그먼트 집계
  const segs=['단골','재방문','신규'];
  const out={}; for(const sg of segs){ const list=await listCustomers(store, sg); out[sg]=list.length; }
  out['전체']=(await listCustomers(store)).length;
  return out;
}

// ---- pickups (고객 주문/픽업 예약) ----
async function createPickup(o){
  if(ready){const r=await pool.query(
    `INSERT INTO pickups(store,customer_id,name,phone,kind,items,rx,date,time,pay_type,amount,deposit,status)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'예약') RETURNING id`,
    [o.store,o.customerId||null,o.name||'',o.phone||'',o.kind,o.items||'',o.rx||'',o.date||'',o.time||'',o.payType||'',o.amount||0,o.deposit||0]);
    return r.rows[0].id;}
  const id=mem.pickups.length+1; mem.pickups.push(Object.assign({id:id,status:'예약'},o)); return id;
}
async function listPickups(store, status){
  if(ready){const r=await pool.query('SELECT id,store,name,phone,kind,items,rx,date,time,pay_type,amount,deposit,status FROM pickups WHERE ($1::text IS NULL OR store=$1) AND ($2::text IS NULL OR status=$2) ORDER BY id DESC',[store||null,status||null]);return r.rows;}
  return mem.pickups.filter(x=>(!store||x.store===store)&&(!status||x.status===status)).slice().reverse();
}
async function updatePickup(id, status){
  if(ready){await pool.query('UPDATE pickups SET status=$2 WHERE id=$1',[id,status]);return {ok:true};}
  var x=mem.pickups.find(p=>p.id==id); if(x)x.status=status; return {ok:true};
}

function _agg(rows){
  var total=0, byStore={}, byCat={};
  rows.forEach(function(r){ total+=r.amt; byStore[r.store]=(byStore[r.store]||0)+r.amt; byCat[r.cat]=(byCat[r.cat]||0)+r.amt; });
  var stores=Object.keys(byStore).map(function(s){return {store:s,amt:byStore[s]};}).sort(function(a,b){return b.amt-a.amt;});
  return {total:total, stores:stores, byCat:byCat};
}
async function salesRange(from, to){
  if(ready){const r=await pool.query('SELECT store, cat, SUM(amount)::int AS amt, SUM(qty)::int AS qty FROM sales WHERE date BETWEEN $1 AND $2 GROUP BY store,cat',[from,to]);return _agg(r.rows);}
  var m={}; mem.sales.filter(s=>s.date>=from&&s.date<=to).forEach(function(s){var k=s.store+'|'+s.cat; m[k]=m[k]||{store:s.store,cat:s.cat,amt:0}; m[k].amt+=s.amount;});
  return _agg(Object.keys(m).map(function(k){return m[k];}));
}

async function restockSuggest(store){
  // 재고 + 최근 30일 판매속도 → 권장 발주
  var today=new Date(); var from=new Date(today.getTime()-30*864e5);
  var f=from.toISOString().slice(0,10), t=today.toISOString().slice(0,10);
  var inv=[], sold={};
  if(ready){
    var iv=await pool.query('SELECT sku,name,cat,stock FROM inventory WHERE store=$1',[store]); inv=iv.rows;
    var sv=await pool.query('SELECT sku, SUM(qty)::int AS q FROM sales WHERE store=$1 AND qty>0 AND date BETWEEN $2 AND $3 GROUP BY sku',[store,f,t]);
    sv.rows.forEach(function(r){sold[r.sku]=r.q;});
  } else {
    inv=mem.inventory.filter(function(i){return i.store===store;}).map(function(i){return {sku:i.sku,name:i.name,cat:i.cat,stock:i.stock};});
    mem.sales.filter(function(x){return x.store===store&&x.qty>0&&x.date>=f&&x.date<=t;}).forEach(function(x){sold[x.sku]=(sold[x.sku]||0)+x.qty;});
  }
  var out=[];
  inv.forEach(function(it){
    var s30=sold[it.sku]||0, rate=s30/30, target=21;
    var suggest=Math.max(0, Math.ceil(rate*target)-it.stock);
    var daysLeft= rate>0? Math.floor(it.stock/rate): null;
    if(suggest>0 || it.stock<=5){ out.push({sku:it.sku,name:it.name,cat:it.cat,stock:it.stock,sold30:s30,daysLeft:daysLeft,suggest:Math.max(suggest, it.stock<=5?15:0)}); }
  });
  out.sort(function(a,b){var da=a.daysLeft==null?9999:a.daysLeft, dbb=b.daysLeft==null?9999:b.daysLeft; return da-dbb;});
  return out;
}

// 본부 공급마진율(데모) — 렌즈·콘택트 PB가 핵심, 테는 미끼(낮음)
var HQ_RATE={ '렌즈':0.55, '콘택트':0.42, '테':0.12, '선글라스':0.15, '액세서리':0.20 };
async function pbMargin(from, to){
  var rows;
  if(ready){const r=await pool.query('SELECT store, cat, SUM(amount)::int AS amt FROM sales WHERE date BETWEEN $1 AND $2 AND amount>0 GROUP BY store,cat',[from,to]);rows=r.rows;}
  else{ var m={}; mem.sales.filter(s=>s.date>=from&&s.date<=to&&s.amount>0).forEach(function(s){var k=s.store+'|'+s.cat;m[k]=m[k]||{store:s.store,cat:s.cat,amt:0};m[k].amt+=s.amount;}); rows=Object.keys(m).map(function(k){return m[k];}); }
  var totalRetail=0, totalHQ=0, byStore={}, byCat={};
  rows.forEach(function(r){
    var rate=HQ_RATE[r.cat]!=null?HQ_RATE[r.cat]:0.1; var hq=Math.round(r.amt*rate);
    totalRetail+=r.amt; totalHQ+=hq;
    byStore[r.store]=byStore[r.store]||{retail:0,hq:0,pb:0};
    byStore[r.store].retail+=r.amt; byStore[r.store].hq+=hq;
    if(r.cat==='렌즈'||r.cat==='콘택트') byStore[r.store].pb+=r.amt;
    byCat[r.cat]=byCat[r.cat]||{retail:0,hq:0}; byCat[r.cat].retail+=r.amt; byCat[r.cat].hq+=hq;
  });
  var stores=Object.keys(byStore).map(function(s){var o=byStore[s];return {store:s,retail:o.retail,hq:o.hq,pbShare:o.retail?Math.round(o.pb/o.retail*100):0};}).sort(function(a,b){return b.hq-a.hq;});
  return {totalRetail:totalRetail, totalHQ:totalHQ, stores:stores, byCat:byCat, rates:HQ_RATE};
}

async function settlement(store, from, to){
  // 결제수단별·의료비공제·환불 집계 (세무 리포트용)
  var rows;
  if(ready){const r=await pool.query('SELECT method, medical, SUM(amount)::int AS amt, SUM(qty)::int AS qty FROM sales WHERE store=$1 AND date BETWEEN $2 AND $3 GROUP BY method,medical',[store,from,to]);rows=r.rows;}
  else{ var m={}; mem.sales.filter(s=>s.store===store&&s.date>=from&&s.date<=to).forEach(function(s){var k=(s.method||'카드')+'|'+(s.medical?1:0); m[k]=m[k]||{method:s.method||'카드',medical:!!s.medical,amt:0,qty:0}; m[k].amt+=s.amount; m[k].qty+=s.qty;}); rows=Object.keys(m).map(function(k){return m[k];}); }
  var gross=0, refunds=0, medical=0, byMethod={};
  rows.forEach(function(r){
    var meth=(r.method||'카드').replace('환불','');
    if((r.method||'').indexOf('환불')>=0){ refunds+=Math.abs(r.amt); }
    gross+=r.amt;
    if(r.medical) medical+=r.amt;
    byMethod[meth]=(byMethod[meth]||0)+r.amt;
  });
  var net=gross; // gross already nets refunds(음수 포함)
  var vat=Math.round(net/11); // 부가세 추정(공급가의 10% = 합계/11)
  var methods=Object.keys(byMethod).map(function(k){return {method:k,amt:byMethod[k]};}).sort(function(a,b){return b.amt-a.amt;});
  return {net:net, refunds:refunds, medical:medical, vat:vat, methods:methods};
}

module.exports={ init, STORES, CATALOG, refundSale, recentSales, createOrder, listOrders, updateOrder, lowStock, salesRange, restockSuggest, pbMargin, settlement,
  createPickup, listPickups, updatePickup,
  listCustomers, getCustomer, customerHistory, addCustomer, moveCustomer, segCounts,
  listBookings, countSlot, addBooking,
  getInventory, getStock, restock,
  recordSale, salesSummary, salesDaily,
  get ready(){return ready;} };
