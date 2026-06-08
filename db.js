// PostgreSQL 래퍼. DATABASE_URL 없으면 메모리 폴백.
// 테이블: bookings(예약), inventory(지점×SKU 재고), sales(결제 라인)
let pool=null, ready=false;
const mem={ bookings:[], inventory:[], sales:[] };
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
async function recordSale(store, date, method, lines){
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
        await client.query('INSERT INTO sales(store,date,sku,name,cat,qty,amount,medical,method) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
          [store,date,ln.sku,ln.name,ln.cat,ln.qty,ln.amount,ln.medical,method]);
      }
      await client.query('COMMIT');
      return {ok:true};
    }catch(e){ await client.query('ROLLBACK'); return {ok:false,error:'결제 처리 오류'}; }
    finally{ client.release(); }
  }
  // 메모리 폴백
  for(const ln of lines){ const it=mem.inventory.find(i=>i.store===store&&i.sku===ln.sku); if(!it||it.stock<ln.qty)return{ok:false,error:'재고 부족: '+ln.name}; }
  for(const ln of lines){ const it=mem.inventory.find(i=>i.store===store&&i.sku===ln.sku); it.stock-=ln.qty; it.sold+=ln.qty;
    mem.sales.push({store,date,sku:ln.sku,name:ln.name,cat:ln.cat,qty:ln.qty,amount:ln.amount,medical:ln.medical,method}); }
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

module.exports={ init, STORES, CATALOG,
  listBookings, countSlot, addBooking,
  getInventory, getStock, restock,
  recordSale, salesSummary, salesDaily,
  get ready(){return ready;} };
