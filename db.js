// PostgreSQL 래퍼. DATABASE_URL 없으면 메모리 폴백.
// 테이블: bookings(예약), inventory(지점×SKU 재고), sales(결제 라인)
let pool=null, ready=false;
const mem={ bookings:[], inventory:[], sales:[], orders:[], customers:[], pickups:[], users:[], policy:{},
  aftercare:[], ascases:[], msessions:[], measurements:[], accesslog:[], overrides:[], quotes:[] };
try{
  if(process.env.DATABASE_URL){
    const { Pool } = require('pg');
    pool = new Pool({ connectionString: process.env.DATABASE_URL,
      ssl: process.env.PGSSL==='off'? false : { rejectUnauthorized:false } });
  }
}catch(e){ console.warn('pg 모듈 없음 — 메모리 폴백'); }

const STORES=['성수점','홍대점','판교점'];
// [09.24] 계정 비밀번호는 코드에 두지 않는다. Railway 환경변수 HQ_PASS / STORE_PASS 로 설정
//  - 설정돼 있으면 서버 시작 때마다 해시로 덮어씀 (비번 변경 = 환경변수 변경 + 재배포)
//  - 없으면 임의 비번으로 잠금 (로그인 불가, 로그에 경고)
const crypto=require('crypto');
function hashPass(p){ const salt=crypto.randomBytes(16).toString('hex'); return 'scrypt$'+salt+'$'+crypto.scryptSync(String(p),salt,32).toString('hex'); }
function checkPass(stored, p){
  if(!stored || !String(stored).startsWith('scrypt$')) return false;   // 평문 비번은 더 이상 통과 안 함
  const parts=stored.split('$'); const h=crypto.scryptSync(String(p||''),parts[1],32);
  const want=Buffer.from(parts[2],'hex'); return want.length===h.length && crypto.timingSafeEqual(want,h);
}
function envPass(role){ return role==='hq' ? process.env.HQ_PASS : process.env.STORE_PASS; }
const SEED_USERS=[
  {username:'hq', role:'hq', store:null},
  {username:'seongsu', role:'store', store:'성수점'},
  {username:'hongdae', role:'store', store:'홍대점'},
  {username:'pangyo',  role:'store', store:'판교점'}
];
function seedPassHash(u){
  const p=envPass(u.role);
  if(p && p.length>=8) return hashPass(p);
  console.warn('[auth] '+(u.role==='hq'?'HQ_PASS':'STORE_PASS')+' 환경변수가 없거나 8자 미만 — '+u.username+' 계정 잠금');
  return hashPass(crypto.randomBytes(24).toString('hex'));
}

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
    {name:'코받침 교체 세트', cat:'액세서리', price:18000, medical:false},
    {name:'안경 케이스',    cat:'액세서리', price:12000, medical:false},
    {name:'안경 클리너 세트', cat:'액세서리', price:9000, medical:false},
    {name:'스포츠 스트랩',  cat:'액세서리', price:15000, medical:false}
  ];
  flat.forEach(function(f,i){ out.push({ sku:'X'+(i+1), name:f.name, cat:f.cat, price:f.price, medical:f.medical }); });
  // [09.24] 기존 브랜드 테 (재고로 판다. 공급은 본사 경유, 입고 때 사이즈를 재서 기록)
  [{name:'수입 A 라인 티타늄', price:470000},{name:'국산 B 라인 아세테이트', price:210000}].forEach(function(f,i){
    out.push({ sku:'Y'+(i+1), name:f.name, cat:'테', price:f.price, medical:false }); });
  return out; // PB 12 + 선글라스 6 + 단품 12 + 기존 브랜드 테 2
}
function skuId(base,s){
  const map={'로마 클래식':'CL','로마 와이드':'WD','로마 슬림':'SL','로마 라운드':'RD','편광 선글라스':'SP','클립온 선글라스':'SC'};
  return (map[base]||'GN')+'-'+s;
}
const CATALOG=buildCatalog();
// [09.24 D-03] PB 테(일반 안경 9사이즈, 지금은 S·M·L)는 매장에 견본만 둔다. 팔면 본사가 조제해 보낸다
function isPBFrame(sku){ return /^(CL|WD|SL|RD)-/.test(String(sku||'')); }
// 본부 가격 정책 기본 할인 한도(%) — PB(렌즈·콘택트)는 마진 보호 위해 낮게
const DEFAULT_DISC={ '렌즈':5, '콘택트':5, '테':15, '선글라스':15, '액세서리':10 };
// 멤버십: 누적 구매액 기준 등급, 등급별 적립률(재방문 혜택)
function tierOf(spend){ if(spend>=3000000)return 'VIP'; if(spend>=1000000)return '골드'; if(spend>=300000)return '실버'; return '웰컴'; }
function rateOf(tier){ return tier==='VIP'?0.10:tier==='골드'?0.07:tier==='실버'?0.05:0.03; }
function nextTier(spend){ if(spend<300000)return {name:'실버',need:300000-spend}; if(spend<1000000)return {name:'골드',need:1000000-spend}; if(spend<3000000)return {name:'VIP',need:3000000-spend}; return null; }
const SEED_CUSTOMERS=[
  {name:'윤서진',phone:'010-0000-0001',store:'성수점',size:'F2×T2',face:'142mm / 낮은코',pd:'63.5mm',rx:'OD -3.25 / OS -3.50',nose:'낮음',seg:'단골',points:18500},
  {name:'김서연',phone:'010-0000-0002',store:'성수점',size:'F1×T1',face:'131mm / 표준',pd:'60.0mm',rx:'OD -1.75 / OS -2.00',nose:'표준',seg:'단골',points:9200},
  {name:'박도현',phone:'010-0000-0003',store:'홍대점',size:'F3×T2',face:'149mm / 높은코',pd:'66.0mm',rx:'OD -4.50 / OS -4.25',nose:'높음',seg:'신규',points:1200},
  {name:'이수민',phone:'010-0000-0004',store:'성수점',size:'F2×T1',face:'138mm / 표준',pd:'62.0mm',rx:'OD -2.25 / OS -2.25',nose:'표준',seg:'재방문',points:5400},
  {name:'정하준',phone:'010-0000-0005',store:'판교점',size:'F2×T2',face:'143mm / 낮은코',pd:'64.0mm',rx:'OD -3.00 / OS -2.75',nose:'낮음',seg:'단골',points:22100},
  {name:'최우진',phone:'010-0000-0006',store:'홍대점',size:'F2×T3',face:'145mm / 표준',pd:'65.0mm',rx:'OD -2.50 / OS -2.50',nose:'표준',seg:'재방문',points:3300},
  {name:'한지우',phone:'010-0000-0007',store:'판교점',size:'F1×T2',face:'133mm / 낮은코',pd:'59.5mm',rx:'OD -1.25 / OS -1.50',nose:'낮음',seg:'신규',points:800}
];

function seedStock(sku, store){
  // 데모 시드: 지점별로 살짝 다르게, 디자인/사이즈별 편차
  let base = 8;
  if(/-M$/.test(sku)) base=14; else if(/-S$/.test(sku)) base=7; else if(/-L$/.test(sku)) base=6;
  if(sku[0]==='X') base=16; // 렌즈/콘택트/액세서리 넉넉
  if(isPBFrame(sku)) return 1; // PB 테는 견본 1개
  if(sku[0]==='Y') base=4;   // 기존 브랜드 테
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
    seg TEXT, points INT DEFAULT 0, created_at TIMESTAMPTZ DEFAULT now())`);
  await pool.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS points INT DEFAULT 0`);
  await pool.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS customer_id INT`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS deadline TEXT`);
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
    await pool.query('INSERT INTO customers(name,phone,store,size,face,pd,rx,nose,seg,points) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [c.name,c.phone,c.store,c.size,c.face,c.pd,c.rx,c.nose,c.seg,c.points||0]); } }
  // 재고 시드: 비어있을 때만
  const c=await pool.query('SELECT COUNT(*)::int AS c FROM inventory'); 
  if(c.rows[0].c===0){
    for(const st of STORES){ for(const it of CATALOG){
      await pool.query('INSERT INTO inventory(store,sku,name,cat,price,medical,stock,sold) VALUES($1,$2,$3,$4,$5,$6,$7,0)',
        [st,it.sku,it.name,it.cat,it.price,it.medical,seedStock(it.sku,st)]);
    }}
  }
  // 매출 히스토리 시드: 비어있을 때만
  const sc=await pool.query('SELECT COUNT(*)::int AS c FROM sales');
  if(sc.rows[0].c===0){
    const h=genHistory();
    for(const x of h.sales){ await pool.query('INSERT INTO sales(store,date,sku,name,cat,qty,amount,medical,method,customer_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[x.store,x.date,x.sku,x.name,x.cat,x.qty,x.amount,x.medical,x.method,x.customer_id]); }
    for(const o of h.orders){ await pool.query('INSERT INTO orders(store,sku,name,cat,qty,status) VALUES($1,$2,$3,$4,$5,$6)',[o.store,o.sku,o.name,o.cat,o.qty,o.status]); }
    for(const pk of h.pickups){ await pool.query('INSERT INTO pickups(store,customer_id,name,phone,kind,items,rx,date,time,pay_type,amount,deposit,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',[pk.store,pk.customer_id,pk.name,pk.phone,pk.kind,pk.items,pk.rx,pk.date,pk.time,pk.payType,pk.amount,pk.deposit,pk.status]); }
  }
  // [09.24] 데모 매출 보충: 시드가 6월에 한 번만 들어가서 최근 기간 매출이 ₩0으로 보이던 문제
  //  마지막 매출일 다음 날 ~ 오늘(최대 60일)을 데모 매출로 채움. 끄려면 DEMO_TOPUP=off
  if(process.env.DEMO_TOPUP!=='off'){
    const mx=await pool.query('SELECT MAX(date) AS d FROM sales');
    const last=mx.rows[0].d? new Date(mx.rows[0].d+'T00:00:00') : null;
    const today=new Date(); today.setHours(0,0,0,0);
    const days=[]; for(let k=59;k>=0;k--){ const dt=new Date(today.getTime()-k*864e5); if(!last || dt>last) days.push(dt); }
    if(days.length){
      const h=genHistory({days:days});
      for(const x of h.sales){ await pool.query('INSERT INTO sales(store,date,sku,name,cat,qty,amount,medical,method,customer_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[x.store,x.date,x.sku,x.name,x.cat,x.qty,x.amount,x.medical,x.method,x.customer_id]); }
      console.log('[demo] 매출 보충 '+days.length+'일, '+h.sales.length+'건');
    }
  }
  await pool.query(`CREATE TABLE IF NOT EXISTS users(
    id SERIAL PRIMARY KEY, username TEXT UNIQUE, pass TEXT, role TEXT, store TEXT, token TEXT)`);
  const uc=await pool.query('SELECT COUNT(*)::int AS c FROM users');
  if(uc.rows[0].c===0){ for(const u of SEED_USERS){
    await pool.query('INSERT INTO users(username,pass,role,store,token) VALUES($1,$2,$3,$4,NULL)',[u.username,seedPassHash(u),u.role,u.store||null]); } }
  // [09.24] 기존 계정 비번 교체: 환경변수가 있으면 그 값으로, 없으면 평문(admin/1234) 계정을 잠금. 기존 로그인 세션도 끊음
  { const ur=await pool.query('SELECT id,username,pass,role FROM users');
    for(const u of ur.rows){
      const p=envPass(u.role);
      if(p && p.length>=8){ if(!checkPass(u.pass,p)) await pool.query('UPDATE users SET pass=$2, token=NULL WHERE id=$1',[u.id,hashPass(p)]); }
      else if(!String(u.pass||'').startsWith('scrypt$')){ await pool.query('UPDATE users SET pass=$2, token=NULL WHERE id=$1',[u.id,seedPassHash(u)]); }
    } }
  // [09.24] 라이브 DB에 이미 들어간 데모 데이터 정리 (실명·실제 형식 전화번호 → 가상 데이터, 오디오 품목명 교체)
  { const MAP=[['양지근','010-2480-1001','윤서진','010-0000-0001'],['김서연','010-3391-2210',null,'010-0000-0002'],
      ['박도현','010-7782-5503',null,'010-0000-0003'],['이수민','010-5519-8834',null,'010-0000-0004'],
      ['정하준','010-6640-1199',null,'010-0000-0005'],['최우진','010-2231-7788',null,'010-0000-0006'],['한지우','010-9982-3344',null,'010-0000-0007']];
    for(const m of MAP){ for(const t of ['customers','pickups']){
      await pool.query('UPDATE '+t+' SET phone=$2 WHERE phone=$1',[m[1],m[3]]);
      if(m[2]) await pool.query('UPDATE '+t+' SET name=$2 WHERE name=$1',[m[0],m[2]]); } }
    await pool.query("UPDATE inventory SET name='코받침 교체 세트' WHERE name='오디오 이어팁'");
    await pool.query("UPDATE sales SET name='코받침 교체 세트' WHERE name='오디오 이어팁'");
    await pool.query("UPDATE orders SET name='코받침 교체 세트' WHERE name='오디오 이어팁'");
    await pool.query("UPDATE pickups SET items=REPLACE(items,'오디오','') WHERE items LIKE '%오디오%'"); }
  await pool.query(`CREATE TABLE IF NOT EXISTS price_policy(sku TEXT PRIMARY KEY, list_price INT, max_disc INT)`);
  const pc=await pool.query('SELECT COUNT(*)::int AS c FROM price_policy');
  if(pc.rows[0].c===0){ for(const it of CATALOG){
    await pool.query('INSERT INTO price_policy(sku,list_price,max_disc) VALUES($1,$2,$3)',[it.sku,it.price,(DEFAULT_DISC[it.cat]!=null?DEFAULT_DISC[it.cat]:10)]); } }
  // [09.24] 판 다음 확인(7일째 착용 확인) · A/S 원인 기록 · 측정 기록(설계서 v0.3 §5)
  await pool.query(`CREATE TABLE IF NOT EXISTS aftercare(
    id SERIAL PRIMARY KEY, customer_id INT, store TEXT, sale_date TEXT, due_date TEXT,
    status TEXT DEFAULT '예정',      -- 예정 / 완료 / 연락 안 됨
    comfort TEXT, issues TEXT, note TEXT, source TEXT, done_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT now())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS as_cases(
    id SERIAL PRIMARY KEY, customer_id INT, store TEXT, aftercare_id INT, symptom TEXT,
    cause TEXT,                     -- 검안 / 가공 / 피팅 / 추천 (종결 때 필수)
    action TEXT, status TEXT DEFAULT '열림', opened_at TIMESTAMPTZ DEFAULT now(), closed_at TIMESTAMPTZ)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS measure_sessions(
    id SERIAL PRIMARY KEY, customer_id INT, device TEXT, store TEXT, operator TEXT,
    status TEXT DEFAULT '대기', created_at TIMESTAMPTZ DEFAULT now())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS measurements(
    id SERIAL PRIMARY KEY, customer_id INT, session_id INT, store TEXT, device TEXT, measured_at TIMESTAMPTZ DEFAULT now(),
    pd REAL, face_width REAL, nose_height REAL, nose_angle REAL, ear_l REAL, ear_r REAL, wrap_angle REAL,
    pow_json TEXT, confidence REAL, provisional BOOLEAN, method TEXT, operator TEXT, source TEXT)`);
  await pool.query('ALTER TABLE measurements ADD COLUMN IF NOT EXISTS ear_depth REAL');   // [09.24] 각막~귀 윗부분 앞뒤 거리
  await pool.query('ALTER TABLE measurements ADD COLUMN IF NOT EXISTS size_code TEXT');   // 이 측정으로 정한 9사이즈
  await pool.query(`CREATE TABLE IF NOT EXISTS quotes(
    id SERIAL PRIMARY KEY, no TEXT, customer_id INT, store TEXT, items TEXT, total INT, list_total INT,
    status TEXT DEFAULT '발행', created_by TEXT, created_at TIMESTAMPTZ DEFAULT now(), valid_until TEXT, paid_at TIMESTAMPTZ)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS overrides(
    id SERIAL PRIMARY KEY, kind TEXT, step TEXT, reason TEXT, detail TEXT, customer_id INT, store TEXT, username TEXT, at TIMESTAMPTZ DEFAULT now())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS measure_access_log(
    id SERIAL PRIMARY KEY, username TEXT, customer_id INT, action TEXT, at TIMESTAMPTZ DEFAULT now())`);
  await pool.query('ALTER TABLE aftercare ADD COLUMN IF NOT EXISTS judge TEXT');   // 적응 중 / 다시 맞춤
  await pool.query('ALTER TABLE aftercare ADD COLUMN IF NOT EXISTS fit INT');       // 판매 때 계산한 적합도(%)
  await pool.query(`CREATE TABLE IF NOT EXISTS standards(
    id SERIAL PRIMARY KEY, kind TEXT, version TEXT, note TEXT, released_at TIMESTAMPTZ DEFAULT now())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS standard_deploy(store TEXT, kind TEXT, version TEXT, at TIMESTAMPTZ DEFAULT now(), PRIMARY KEY(store,kind))`);
  const ac=await pool.query('SELECT COUNT(*)::int AS c FROM aftercare');
  if(ac.rows[0].c===0){ const d=_demoCare();
    for(const x of d.care){ await pool.query('INSERT INTO aftercare(customer_id,store,sale_date,due_date,status,comfort,issues,note,source,done_at,fit,judge) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',[x.customer_id,x.store,x.sale_date,x.due_date,x.status,x.comfort,x.issues,x.note,x.source,x.done_at,x.fit,x.judge]); }
    for(const a of d.as){ await pool.query('INSERT INTO as_cases(customer_id,store,symptom,cause,action,status,closed_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[a.customer_id,a.store,a.symptom,a.cause,a.action,a.status,a.closed_at]); } }
  // [09.24] 예전 7일 확인 항목(코·귀·어지러움·흐림)을 새 질문 3개로 옮긴다. 기준 보정 데모 기록이 없으면 채운다
  const oldc=await pool.query("SELECT COUNT(*)::int AS c FROM aftercare WHERE issues ~ '(코|귀|어지러움|흐림)'");
  if(oldc.rows[0].c>0){
    await pool.query("UPDATE aftercare SET issues=REGEXP_REPLACE(REGEXP_REPLACE(REGEXP_REPLACE(REGEXP_REPLACE(issues,'어지러움','가까운 곳','g'),'흐림','먼 곳','g'),'코','흘러내림','g'),'귀','흘러내림','g')");
    await pool.query("UPDATE aftercare SET judge='다시 맞춤' WHERE comfort='불편' AND judge IS NULL");
    await pool.query("UPDATE as_cases SET symptom=REPLACE(REPLACE(symptom,'코 (7일 확인)','흘러내림 (7일째 확인)'),'어지러움 (7일 확인)','가까운 곳 (7일째 확인)')"); }
  await pool.query("UPDATE aftercare SET source='손님 앱' WHERE source='고객 앱'");
  await pool.query("UPDATE as_cases SET action=REPLACE(action,'다리 끝','템플 끝') WHERE action LIKE '%다리 끝%'");
  await pool.query("UPDATE as_cases SET symptom=REPLACE(symptom,'다리 흘러내림','안경 흘러내림') WHERE symptom LIKE '%다리 흘러내림%'");
  await pool.query("UPDATE as_cases SET symptom=REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(symptom,'귀 (7일 확인)','흘러내림 (7일째 확인)'),'흐림 (7일 확인)','먼 곳 (7일째 확인)'),'코 (7일 확인)','흘러내림 (7일째 확인)'),'어지러움 (7일 확인)','가까운 곳 (7일째 확인)'),'(7일 확인)','(7일째 확인)') WHERE symptom LIKE '%(7일 확인)%'");
  const fc=await pool.query('SELECT COUNT(*)::int AS c FROM aftercare WHERE fit IS NOT NULL');
  if(fc.rows[0].c===0){ const d=_demoCare();
    for(const x of d.care.filter(function(x){return x.fit!=null&&x.status==='완료';})){ await pool.query('INSERT INTO aftercare(customer_id,store,sale_date,due_date,status,comfort,issues,note,source,done_at,fit,judge) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',[x.customer_id,x.store,x.sale_date,x.due_date,x.status,x.comfort,x.issues,x.note,x.source,x.done_at,x.fit,x.judge]); } }
  await pool.query(`CREATE TABLE IF NOT EXISTS workorders(id SERIAL PRIMARY KEY, store TEXT, customer_id INT, sku TEXT, frame TEXT, lens TEXT, rx TEXT, calc TEXT, status TEXT, created_at TIMESTAMPTZ DEFAULT now())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS vision_exams(id SERIAL PRIMARY KEY, customer_id INT, member TEXT, grp TEXT, date TEXT, rx TEXT, created_at TIMESTAMPTZ DEFAULT now())`);
  const vec=await pool.query('SELECT COUNT(*)::int AS c FROM vision_exams');
  if(vec.rows[0].c===0){ for(const x of _demoExams()) await pool.query('INSERT INTO vision_exams(customer_id,member,grp,date,rx) VALUES($1,$2,$3,$4,$5)',[x.customer_id,x.member,x.grp,x.date,x.rx]); }
  const stc=await pool.query('SELECT COUNT(*)::int AS c FROM standards');
  if(stc.rows[0].c===0){ for(const x of _demoStandards()) await pool.query('INSERT INTO standards(kind,version,note,released_at) VALUES($1,$2,$3,$4)',[x.kind,x.version,x.note,x.released_at]);
    for(const x of _demoDeploy()) await pool.query('INSERT INTO standard_deploy(store,kind,version) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[x.store,x.kind,x.version]); }
  for(const it of CATALOG.filter(function(x){return x.sku[0]==='Y';})){ for(const st of STORES){
    await pool.query('INSERT INTO inventory(store,sku,name,cat,price,medical,stock,sold) VALUES($1,$2,$3,$4,$5,$6,$7,0) ON CONFLICT DO NOTHING',[st,it.sku,it.name,it.cat,it.price,it.medical,seedStock(it.sku,st)]); }
    await pool.query('INSERT INTO price_policy(sku,list_price,max_disc) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[it.sku,it.price,DEFAULT_DISC['테']]); }
  // 기존 브랜드 테 판매 데모: 없으면 최근 45일에 조금 채운다 (PB 테 비중이 100%로 보이지 않게)
  const ys=await pool.query("SELECT COUNT(*)::int AS c FROM sales WHERE sku ~ '^Y'");
  if(ys.rows[0].c===0 && process.env.DEMO_TOPUP!=='off'){
    const ycat=CATALOG.filter(function(x){return x.sku[0]==='Y';});
    for(const st of STORES){ for(let i=0;i<9;i++){ const it=ycat[i%ycat.length]; const d=new Date(Date.now()-((i*5+STORES.indexOf(st)*2)%45)*864e5);
      await pool.query('INSERT INTO sales(store,date,sku,name,cat,qty,amount,medical,method) VALUES($1,$2,$3,$4,$5,1,$6,false,$7)',[st,_iso(d),it.sku,it.name,it.cat,it.price,'카드']); } } }
  // PB 테는 견본만 (D-03): 견본 1개로 맞추고, 쌓여 있던 PB 테 발주는 취소
  await pool.query("UPDATE inventory SET stock=1 WHERE sku ~ '^(CL|WD|SL|RD)-' AND stock<>1");
  await pool.query("UPDATE orders SET status='취소' WHERE sku ~ '^(CL|WD|SL|RD)-' AND status IN ('대기','푸시대기','승인')");
  ready=true;
}
// ---- 데모 히스토리 생성기 (최근 30일 매출 + 발주/픽업) ----
function genHistory(opts){
  function pad(n){return (n<10?'0':'')+n;}
  function rnd(a,b){return a+Math.floor(Math.random()*(b-a+1));}
  function pick(arr){return arr[Math.floor(Math.random()*arr.length)];}
  var byCat={};
  CATALOG.forEach(function(it){ (byCat[it.cat]=byCat[it.cat]||[]).push(it); });
  var catWeights=[['렌즈',30],['콘택트',18],['테',28],['선글라스',14],['액세서리',10]];
  var wsum=catWeights.reduce(function(a,c){return a+c[1];},0);
  function pickCat(){ var r=Math.random()*wsum, acc=0; for(var i=0;i<catWeights.length;i++){acc+=catWeights[i][1]; if(r<acc)return catWeights[i][0];} return '테'; }
  var storeVol={'성수점':[3,5],'홍대점':[2,4],'판교점':[1,3]};
  var sales=[], orders=[], pickups=[];
  var today=new Date();
  var DAYS=(opts&&opts.days)||[]; if(!DAYS.length){ for(var k=29;k>=0;k--) DAYS.push(new Date(today.getTime()-k*864e5)); }
  for(var di=0; di<DAYS.length; di++){
    var dt=DAYS[di];
    var iso=dt.getFullYear()+'-'+pad(dt.getMonth()+1)+'-'+pad(dt.getDate());
    var dow=dt.getDay(); var weekendBoost=(dow===0||dow===6)?1.4:1;
    STORES.forEach(function(st){
      var vr=storeVol[st]||[1,3]; var tx=Math.round(rnd(vr[0],vr[1])*weekendBoost);
      for(var t=0;t<tx;t++){
        var lines=rnd(1,2); var method=Math.random()<0.7?'카드':'현금';
        var cid=Math.random()<0.5?rnd(1,SEED_CUSTOMERS.length):null;
        for(var l=0;l<lines;l++){
          var cat=pickCat(); var pool=byCat[cat]; if(!pool||!pool.length)continue;
          var it=pick(pool); var qty=(cat==='콘택트'||cat==='액세서리')?rnd(1,3):1;
          sales.push({store:st,date:iso,sku:it.sku,name:it.name,cat:it.cat,qty:qty,amount:it.price*qty,medical:!!it.medical,method:method,customer_id:cid});
        }
      }
    });
  }
  // 발주 샘플 (혼합 상태)
  var od=[['성수점','X1','알도R 1.60 렌즈','렌즈',15,'대기'],['홍대점','X2','누진 렌즈','렌즈',15,'대기'],
          ['판교점','X3','청광 렌즈','렌즈',10,'승인'],['성수점','X5','1일용 콘택트(30P)','콘택트',20,'승인'],
          ['홍대점','SP-M','편광 선글라스 M','선글라스',8,'입고완료']];
  od.forEach(function(o){ orders.push({store:o[0],sku:o[1],name:o[2],cat:o[3],qty:o[4],status:o[5]}); });
  // 픽업 샘플
  function pad2(n){return (n<10?'0':'')+n;}
  var tmw=new Date(today.getTime()+864e5); var tiso=tmw.getFullYear()+'-'+pad2(tmw.getMonth()+1)+'-'+pad2(tmw.getDate());
  pickups.push({store:'성수점',customer_id:1,name:'윤서진',phone:'010-0000-0001',kind:'A',items:'로마 ACE-02 + 알도R 1.60',rx:'OD -3.25 / OS -3.50',date:tiso,time:'14:00',payType:'보증금',amount:0,deposit:10000,status:'예약'});
  pickups.push({store:'홍대점',customer_id:3,name:'박도현',phone:'010-0000-0003',kind:'C',items:'안경 케이스 + 클리너',rx:'',date:tiso,time:'11:00',payType:'온라인',amount:21000,deposit:0,status:'예약'});
  pickups.push({store:'판교점',customer_id:5,name:'정하준',phone:'010-0000-0005',kind:'A',items:'콘택트 1개월용',rx:'OD -3.00 / OS -2.75',date:tiso,time:'16:00',payType:'보증금',amount:0,deposit:10000,status:'방문완료'});
  return {sales:sales, orders:orders, pickups:pickups};
}
function seedMem(){
  mem.standards=_demoStandards(); mem.deploy=_demoDeploy(); mem.exams=_demoExams();
  (function(){ var d=_demoCare(); d.care.forEach(function(x,i){ x.id=i+1; mem.aftercare.push(x); }); d.as.forEach(function(a,i){ a.id=i+1; a.opened_at=new Date().toISOString(); mem.ascases.push(a); }); })();
  SEED_USERS.forEach(function(u,i){ mem.users.push({id:i+1,username:u.username,pass:seedPassHash(u),role:u.role,store:u.store||null,token:null}); });
  CATALOG.forEach(function(it){ mem.policy[it.sku]={list_price:it.price, max_disc:(DEFAULT_DISC[it.cat]!=null?DEFAULT_DISC[it.cat]:10)}; });
  SEED_CUSTOMERS.forEach(function(c,i){ mem.customers.push(Object.assign({id:i+1},c)); });
  STORES.forEach(function(st){ CATALOG.forEach(function(it){
    mem.inventory.push({store:st,sku:it.sku,name:it.name,cat:it.cat,price:it.price,medical:it.medical,stock:seedStock(it.sku,st),sold:0});
  });});
  var h=genHistory();
  h.sales.forEach(function(x){ mem.sales.push(x); });
  h.orders.forEach(function(o,i){ mem.orders.push(Object.assign({id:i+1},o)); });
  h.pickups.forEach(function(pk,i){ mem.pickups.push(Object.assign({id:i+1,status:pk.status},pk)); });
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
async function _policyMap(){
  if(ready){ const r=await pool.query('SELECT sku,list_price,max_disc FROM price_policy'); var m={}; r.rows.forEach(function(x){m[x.sku]={list_price:x.list_price,max_disc:x.max_disc};}); return m; }
  return mem.policy;
}
async function listPricePolicy(){
  const m=await _policyMap();
  return CATALOG.map(function(it){ var pp=m[it.sku]||{list_price:it.price,max_disc:10}; return {sku:it.sku,name:it.name,cat:it.cat,list_price:pp.list_price,max_disc:pp.max_disc}; });
}
/* [09.24] 견적서: 본사 권장가에서 시작, 판매가는 매장이 정함. 할인 한도를 넘으면 표시만 한다(막지 않음, D-12) */
const QUOTE_VALID_DAYS=14;
async function createQuote(b, who){
  var lines=Array.isArray(b.items)?b.items.slice(0,20):[]; if(!lines.length) return {ok:false,error:'품목이 없어요'};
  var m=await _policyMap(), out=[], total=0, listTotal=0;
  for(var i=0;i<lines.length;i++){ var l=lines[i], it=CATALOG.find(function(x){return x.sku===l.sku;}); if(!it) return {ok:false,error:'없는 품목: '+l.sku};
    var pp=m[it.sku]||{list_price:it.price,max_disc:10}, qty=Math.max(1,Math.min(10,parseInt(l.qty)||1));
    var disc=Math.max(0,Math.min(90,Math.round(+l.disc||0))), unit=Math.round(pp.list_price*(100-disc)/100/100)*100;
    out.push({sku:it.sku,name:it.name,cat:it.cat,medical:!!it.medical,qty:qty,list:pp.list_price,disc:disc,maxDisc:pp.max_disc,over:disc>pp.max_disc,unit:unit,amount:unit*qty,note:String(l.note||'').slice(0,80)});
    total+=unit*qty; listTotal+=pp.list_price*qty; }
  var cust=b.customer_id?await getCustomer(b.customer_id):null, store=(who&&who.store)||(cust&&cust.store)||b.store||null;
  var today=_iso(new Date()), valid=_addDays(today,QUOTE_VALID_DAYS), seq, no;
  if(ready){ const c=await pool.query("SELECT COUNT(*)::int AS n FROM quotes WHERE created_at::date=now()::date"); seq=c.rows[0].n+1; }
  else seq=mem.quotes.filter(function(q){return String(q.created_at).slice(0,10)===today;}).length+1;
  no='Q-'+today.slice(2).replace(/-/g,'')+'-'+String(seq).padStart(3,'0');
  var row={no:no,customer_id:cust?cust.id:null,store:store,items:JSON.stringify(out),total:total,list_total:listTotal,created_by:who?who.username:null,valid_until:valid};
  if(ready){ const r=await pool.query('INSERT INTO quotes(no,customer_id,store,items,total,list_total,created_by,valid_until) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,created_at',[row.no,row.customer_id,row.store,row.items,row.total,row.list_total,row.created_by,row.valid_until]); row.id=r.rows[0].id; row.created_at=r.rows[0].created_at; }
  else { row.id=mem.quotes.length+1; row.created_at=new Date().toISOString(); row.status='발행'; mem.quotes.push(row); }
  return {ok:true, quote:await getQuote(row.id)};
}
async function getQuote(id){
  if(!/^\d+$/.test(String(id))) return null;
  var q = ready ? (await pool.query('SELECT * FROM quotes WHERE id=$1',[id])).rows[0] : mem.quotes.find(function(x){return x.id===+id;});
  if(!q) return null; var c=q.customer_id?await getCustomer(q.customer_id):null;
  return Object.assign({},q,{items:JSON.parse(q.items||'[]'), customer:c?{id:c.id,name:c.name,size:c.size,rx:c.rx,pd:c.pd}:null});
}
async function listQuotes(store, customerId){
  var rows = ready ? (await pool.query('SELECT id,no,customer_id,store,total,list_total,status,created_at,valid_until FROM quotes WHERE ($1::text IS NULL OR store=$1) AND ($2::int IS NULL OR customer_id=$2) ORDER BY id DESC LIMIT 50',[store||null,customerId?+customerId:null])).rows
    : mem.quotes.filter(function(q){return (!store||q.store===store)&&(!customerId||q.customer_id===+customerId);}).slice().reverse().slice(0,50);
  var names=await _custNames();
  return rows.map(function(x){ var c=names[x.customer_id]||{}; return {id:x.id,no:x.no,customer_id:x.customer_id,name:c.name||'-',store:x.store,total:x.total,list_total:x.list_total,status:x.status||'발행',created_at:x.created_at,valid_until:x.valid_until}; });
}
async function quotesForCustomer(customerId){
  // 손님 앱용: 매장 내부 값(할인 한도·초과 여부·작성자)은 빼고 보낸다
  if(!/^\d+$/.test(String(customerId||''))) return [];
  var rows = ready ? (await pool.query('SELECT * FROM quotes WHERE customer_id=$1 ORDER BY id DESC LIMIT 10',[customerId])).rows
    : mem.quotes.filter(function(q){return q.customer_id===+customerId;}).slice().reverse().slice(0,10);
  var today=_iso(new Date());
  return rows.map(function(q){ var st=q.status||'발행'; if(st==='발행' && q.valid_until && q.valid_until<today) st='기간 지남';
    return {no:q.no, date:String(q.created_at instanceof Date?q.created_at.toISOString():q.created_at).slice(0,10), store:q.store, status:st, valid_until:q.valid_until, total:q.total, list_total:q.list_total,
      items:JSON.parse(q.items||'[]').map(function(l){return {name:l.name, qty:l.qty, list:l.list, disc:l.disc, amount:l.amount, pb:/^(CL|WD|SL|RD)-/.test(l.sku)};})}; });
}
async function catalogWithPolicy(){
  // 손님 앱 가격 계산용: 본사 권장가(정책)를 price로 덮어 보낸다
  var m=await _policyMap(); return CATALOG.map(function(it){ var pp=m[it.sku]; return Object.assign({},it,{price:pp?pp.list_price:it.price}); });
}
async function markQuotePaid(id){
  var q=await getQuote(id); if(!q) return {ok:false,error:'견적서가 없어요'}; if(q.status==='결제됨') return {ok:true,already:true};
  if(ready) await pool.query("UPDATE quotes SET status='결제됨', paid_at=now() WHERE id=$1",[id]);
  else { var r=mem.quotes.find(function(x){return x.id===+id;}); r.status='결제됨'; r.paid_at=new Date().toISOString(); }
  return {ok:true};
}
async function setPricePolicy(sku, list_price, max_disc){
  list_price=Math.max(0,Math.round(+list_price||0)); max_disc=Math.min(90,Math.max(0,Math.round(+max_disc||0)));
  if(ready){ await pool.query('INSERT INTO price_policy(sku,list_price,max_disc) VALUES($1,$2,$3) ON CONFLICT(sku) DO UPDATE SET list_price=$2,max_disc=$3',[sku,list_price,max_disc]); }
  else { mem.policy[sku]={list_price:list_price,max_disc:max_disc}; }
  return {ok:true, sku:sku, list_price:list_price, max_disc:max_disc};
}
async function recordSale(store, date, method, lines, customerId, redeem, fit){
  // [09.24] 판매가는 가맹점이 정한다. 본부 권장가·권장 할인 범위를 벗어나도 결제는 막지 않고 안내만 돌려준다
  //  (가격 구속 금지. 지침: 권장가까지만)
  const pol=await _policyMap(); const notices=[];
  for(const ln of lines){ var pp=pol[ln.sku]; if(pp){ var unit=ln.qty>0?ln.amount/ln.qty:0; var floor=pp.list_price*(1-(pp.max_disc||0)/100); if(unit < floor-1){ notices.push(ln.name+' — 권장 할인 범위('+(pp.max_disc||0)+'%)보다 낮은 가격'); } } }
  // lines: [{sku,name,cat,qty,amount,medical}]
  if(ready){
    const client=await pool.connect();
    try{
      await client.query('BEGIN');
      for(const ln of lines){
        if(isPBFrame(ln.sku)) continue; // PB 테는 견본 판매 → 본사 조제
        const s=await client.query('SELECT stock FROM inventory WHERE store=$1 AND sku=$2 FOR UPDATE',[store,ln.sku]);
        if(!s.rows[0] || s.rows[0].stock<ln.qty){ await client.query('ROLLBACK'); return {ok:false,error:'재고 부족: '+ln.name}; }
      }
      for(const ln of lines){
        if(isPBFrame(ln.sku)){
          await client.query('UPDATE inventory SET sold=sold+$3 WHERE store=$1 AND sku=$2',[store,ln.sku,ln.qty]);
          await client.query("INSERT INTO orders(store,sku,name,cat,qty,status) VALUES($1,$2,$3,$4,$5,'본사 조제')",[store,ln.sku,ln.name,ln.cat,ln.qty]);
        } else await client.query('UPDATE inventory SET stock=stock-$3, sold=sold+$3 WHERE store=$1 AND sku=$2',[store,ln.sku,ln.qty]);
        await client.query('INSERT INTO sales(store,date,sku,name,cat,qty,amount,medical,method,customer_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
          [store,date,ln.sku,ln.name,ln.cat,ln.qty,ln.amount,ln.medical,method,customerId||null]);
      }
      await client.query('COMMIT');
      await _afterSale(store,customerId,date,lines,fit);
      return Object.assign(await _applyPoints(store,customerId,lines,redeem),{notices:notices});
    }catch(e){ await client.query('ROLLBACK'); return {ok:false,error:'결제 처리 오류'}; }
    finally{ client.release(); }
  }
  // 메모리 폴백
  for(const ln of lines){ if(isPBFrame(ln.sku)) continue; const it=mem.inventory.find(i=>i.store===store&&i.sku===ln.sku); if(!it||it.stock<ln.qty)return{ok:false,error:'재고 부족: '+ln.name}; }
  for(const ln of lines){ const it=mem.inventory.find(i=>i.store===store&&i.sku===ln.sku);
    if(isPBFrame(ln.sku)){ if(it) it.sold+=ln.qty; mem.orders.push({id:mem.orders.length+1,store:store,sku:ln.sku,name:ln.name,cat:ln.cat,qty:ln.qty,status:'본사 조제'}); }
    else { it.stock-=ln.qty; it.sold+=ln.qty; }
    mem.sales.push({store,date,sku:ln.sku,name:ln.name,cat:ln.cat,qty:ln.qty,amount:ln.amount,medical:ln.medical,method,customer_id:customerId||null}); }
  await _afterSale(store,customerId,date,lines,fit);
  return Object.assign(await _applyPoints(store,customerId,lines,redeem),{notices:notices});
}
async function _applyPoints(store, customerId, lines, redeem){
  if(!customerId) return {ok:true};
  var total=lines.reduce(function(a,l){return a+l.amount;},0);
  var info=await getCustomer(customerId); if(!info) return {ok:true};
  var bal=info.points||0;
  var use=Math.max(0, Math.min(Math.round(+redeem||0), bal, total));
  var rate=rateOf(info.tier);
  var earned=Math.round((total-use)*rate);
  var newBal=bal-use+earned;
  if(ready){ await pool.query('UPDATE customers SET points=$2 WHERE id=$1',[customerId,newBal]); }
  else { var c=mem.customers.find(x=>x.id==customerId); if(c)c.points=newBal; }
  return {ok:true, tier:info.tier, earned:earned, used:use, points:newBal, earnRate:Math.round(rate*100)};
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
        if(isPBFrame(ln.sku)) await client.query('UPDATE inventory SET sold=GREATEST(0,sold-$3) WHERE store=$1 AND sku=$2',[store,ln.sku,ln.qty]);
        else await client.query('UPDATE inventory SET stock=stock+$3, sold=GREATEST(0,sold-$3) WHERE store=$1 AND sku=$2',[store,ln.sku,ln.qty]);
        await client.query('INSERT INTO sales(store,date,sku,name,cat,qty,amount,medical,method) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
          [store,date,ln.sku,ln.name,ln.cat,-ln.qty,-ln.amount,ln.medical,method+'환불']);
      }
      await client.query('COMMIT'); return {ok:true};
    }catch(e){ await client.query('ROLLBACK'); return {ok:false,error:'환불 처리 오류'}; }
    finally{ client.release(); }
  }
  for(const ln of lines){ const it=mem.inventory.find(i=>i.store===store&&i.sku===ln.sku);
    if(it){ if(!isPBFrame(ln.sku)) it.stock+=ln.qty; it.sold=Math.max(0,it.sold-ln.qty); }
    mem.sales.push({store,date,sku:ln.sku,name:ln.name,cat:ln.cat,qty:-ln.qty,amount:-ln.amount,medical:ln.medical,method:method+'환불'}); }
  return {ok:true};
}
async function activityFeed(limit){
  limit=limit||16;
  var items=[];
  function won(n){return '₩'+(n||0).toLocaleString('ko-KR');}
  if(ready){
    var sv=await pool.query("SELECT store,name,amount,method,EXTRACT(EPOCH FROM created_at)*1000 AS ts FROM sales WHERE amount>0 ORDER BY id DESC LIMIT 14");
    sv.rows.forEach(function(r){ items.push({ts:+r.ts||0, icon:'CARD', store:r.store, text:r.name+' '+won(r.amount)+' 결제 ('+(r.method||'카드')+')'}); });
    var ov=await pool.query("SELECT store,name,qty,status,EXTRACT(EPOCH FROM COALESCE(updated_at,created_at))*1000 AS ts FROM orders ORDER BY id DESC LIMIT 8");
    ov.rows.forEach(function(r){ items.push({ts:+r.ts||0, icon:'BOX', store:r.store, text:'발주 '+r.status+' · '+r.name+' x'+r.qty}); });
    var pv=await pool.query("SELECT store,name,kind,status,EXTRACT(EPOCH FROM created_at)*1000 AS ts FROM pickups ORDER BY id DESC LIMIT 6");
    pv.rows.forEach(function(r){ items.push({ts:+r.ts||0, icon:'BAG', store:r.store, text:'픽업 '+(r.status||'예약')+' · '+r.name}); });
    var lv=await pool.query("SELECT store,name,stock FROM inventory WHERE stock<=5 AND sku !~ '^(CL|WD|SL|RD)-' ORDER BY stock LIMIT 5");
    lv.rows.forEach(function(r){ items.push({ts:Date.now(), icon:'WARN', store:r.store, text:'재고 부족 · '+r.name+' '+r.stock+'개'}); });
  } else {
    var base=Date.now();
    mem.sales.filter(function(s){return s.amount>0;}).slice(-14).reverse().forEach(function(r,i){ items.push({ts:base-i*45000, icon:'CARD', store:r.store, text:r.name+' '+won(r.amount)+' 결제 ('+(r.method||'카드')+')'}); });
    mem.orders.slice(-8).reverse().forEach(function(r,i){ items.push({ts:base-i*120000, icon:'BOX', store:r.store, text:'발주 '+r.status+' · '+r.name+' x'+r.qty}); });
    mem.pickups.slice(-6).reverse().forEach(function(r,i){ items.push({ts:base-i*200000, icon:'BAG', store:r.store, text:'픽업 '+(r.status||'예약')+' · '+r.name}); });
    mem.inventory.filter(function(i){return i.stock<=5&&!isPBFrame(i.sku);}).slice(0,5).forEach(function(r){ items.push({ts:base, icon:'WARN', store:r.store, text:'재고 부족 · '+r.name+' '+r.stock+'개'}); });
  }
  items.sort(function(a,b){return b.ts-a.ts;});
  return items.slice(0,limit);
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
async function pushOrder(store, sku, name, cat, qty, deadline){
  // 본부 → 가맹점 발주 푸시 (가맹 응답 대기)
  if(ready){const r=await pool.query("INSERT INTO orders(store,sku,name,cat,qty,status,deadline) VALUES($1,$2,$3,$4,$5,'푸시대기',$6) RETURNING id",[store,sku,name,cat,qty,deadline||null]);return r.rows[0].id;}
  const id=mem.orders.length+1; mem.orders.push({id:id,store:store,sku:sku,name:name,cat:cat,qty:qty,status:'푸시대기',deadline:deadline||null}); return id;
}
async function respondPush(id, accept){
  // 가맹점 응답: 승인 -> '승인'(입고대기), 거절 -> '취소'
  var to = accept? '승인' : '취소';
  if(ready){ await pool.query("UPDATE orders SET status=$2, updated_at=now() WHERE id=$1 AND status='푸시대기'",[id,to]); return {ok:true}; }
  var o=mem.orders.find(function(x){return x.id===id;}); if(o&&o.status==='푸시대기')o.status=to; return {ok:true};
}
async function autoConfirmPushes(){
  // [09.24] 마감 지난 푸시대기 -> 만료. 매장이 승인하지 않은 발주는 넣지 않는다
  var nowISO=new Date().toISOString();
  if(ready){ const r=await pool.query("UPDATE orders SET status='만료', updated_at=now() WHERE status='푸시대기' AND deadline IS NOT NULL AND deadline <= $1 RETURNING id",[nowISO]); return r.rowCount; }
  var n=0; mem.orders.forEach(function(o){ if(o.status==='푸시대기'&&o.deadline&&o.deadline<=nowISO){o.status='만료';n++;} }); return n;
}
async function listOrders(store, status){
  await autoConfirmPushes();
  if(ready){const r=await pool.query('SELECT id,store,sku,name,cat,qty,status,deadline FROM orders WHERE ($1::text IS NULL OR store=$1) AND ($2::text IS NULL OR status=$2) ORDER BY id DESC',[store||null,status||null]);return r.rows;}
  return mem.orders.filter(o=>(!store||o.store===store)&&(!status||o.status===status)).slice().reverse();
}
async function updateOrder(id, status){
  // 입고완료 시 해당 지점 재고 증가
  if(ready){
    const o=await pool.query('SELECT store,sku,qty,status FROM orders WHERE id=$1',[id]);
    if(!o.rows[0]) return {ok:false,error:'발주 없음'};
    if(status==='입고완료' && o.rows[0].status!=='입고완료' && !isPBFrame(o.rows[0].sku)){
      await pool.query('UPDATE inventory SET stock=stock+$3 WHERE store=$1 AND sku=$2',[o.rows[0].store,o.rows[0].sku,o.rows[0].qty]);
    }
    await pool.query('UPDATE orders SET status=$2, updated_at=now() WHERE id=$1',[id,status]);
    return {ok:true};
  }
  const o=mem.orders.find(x=>x.id===id); if(!o)return{ok:false,error:'발주 없음'};
  if(status==='입고완료' && o.status!=='입고완료' && !isPBFrame(o.sku)){ const it=mem.inventory.find(i=>i.store===o.store&&i.sku===o.sku); if(it)it.stock+=o.qty; }
  o.status=status; return {ok:true};
}
async function lowStock(store, threshold){
  // 발주 추천: 재고 <= threshold 인 SKU
  if(ready){const r=await pool.query('SELECT sku,name,cat,stock FROM inventory WHERE store=$1 AND stock<=$2 AND sku !~ '^(CL|WD|SL|RD)-' ORDER BY stock',[store,threshold]);return r.rows;}
  return mem.inventory.filter(i=>i.store===store&&i.stock<=threshold&&!isPBFrame(i.sku)).map(i=>({sku:i.sku,name:i.name,cat:i.cat,stock:i.stock}));
}

// ---- customers ----
async function listCustomers(store, seg){
  if(ready){const r=await pool.query('SELECT id,name,phone,store,size,face,pd,rx,nose,seg,points FROM customers WHERE ($1::text IS NULL OR store=$1) AND ($2::text IS NULL OR seg=$2) ORDER BY name',[store||null,seg||null]);return r.rows;}
  return mem.customers.filter(c=>(!store||c.store===store)&&(!seg||c.seg===seg));
}
async function getCustomer(id){
  var c; if(!/^\d+$/.test(String(id))) return null;
  if(ready){const r=await pool.query('SELECT id,name,phone,store,size,face,pd,rx,nose,seg,points FROM customers WHERE id=$1',[id]);c=r.rows[0]||null;}
  else { c=mem.customers.find(x=>x.id==id)||null; }
  if(!c) return null;
  var spend=await customerSpend(id);
  var tier=tierOf(spend), nt=nextTier(spend);
  return Object.assign({}, c, {points:c.points||0, spend:spend, tier:tier, earnRate:Math.round(rateOf(tier)*100), nextTier:nt});
}
async function customerSpend(id){
  if(ready){const r=await pool.query('SELECT COALESCE(SUM(amount),0)::int AS s FROM sales WHERE customer_id=$1 AND amount>0',[id]);return r.rows[0].s;}
  return mem.sales.filter(s=>s.customer_id==id&&s.amount>0).reduce((a,s)=>a+s.amount,0);
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
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
    [o.store,o.customerId||null,o.name||'',o.phone||'',o.kind,o.items||'',o.rx||'',o.date||'',o.time||'',o.payType||'',o.amount||0,o.deposit||0,(o.kind==='R'?'주문 접수':'예약')]);
    return r.rows[0].id;}
  const id=mem.pickups.length+1; mem.pickups.push(Object.assign({id:id,status:(o.kind==='R'?'주문 접수':'예약'),pay_type:o.payType},o)); return id;
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

async function forecastAll(){
  // 지점별 30일 판매속도 -> 다음 주(7일) 수요 예측 + 권장 푸시량(약 2주치 보충)
  var today=new Date(), from=new Date(today.getTime()-30*864e5);
  var f=from.toISOString().slice(0,10), t=today.toISOString().slice(0,10);
  var out=[];
  for(const store of STORES){
    var inv=[], sold={};
    if(ready){
      var iv=await pool.query('SELECT sku,name,cat,stock FROM inventory WHERE store=$1',[store]); inv=iv.rows;
      var sv=await pool.query('SELECT sku, SUM(qty)::int AS q FROM sales WHERE store=$1 AND qty>0 AND date BETWEEN $2 AND $3 GROUP BY sku',[store,f,t]);
      sv.rows.forEach(function(r){sold[r.sku]=r.q;});
    } else {
      inv=mem.inventory.filter(function(i){return i.store===store;}).map(function(i){return {sku:i.sku,name:i.name,cat:i.cat,stock:i.stock};});
      mem.sales.filter(function(x){return x.store===store&&x.qty>0&&x.date>=f&&x.date<=t;}).forEach(function(x){sold[x.sku]=(sold[x.sku]||0)+x.qty;});
    }
    var items=[];
    inv.forEach(function(it){
      var s30=sold[it.sku]||0, rate=s30/30;
      if(rate<=0) return;
      var week=Math.round(rate*7*10)/10;            // 다음 주 예상 판매량
      var cover=Math.ceil(rate*28);                  // 약 4주치 목표 재고(데모)
      var push=Math.max(0, cover-it.stock);          // 권장 푸시량
      var daysLeft=rate>0?Math.floor(it.stock/rate):null;
      items.push({sku:it.sku,name:it.name,cat:it.cat,stock:it.stock,week:week,daysLeft:daysLeft,push:push,rate:rate});
    });
    items.sort(function(a,b){ if((b.push>0)!=(a.push>0)) return (b.push>0?1:0)-(a.push>0?1:0); return b.rate-a.rate; });
    out.push({store:store, items:items.slice(0,6)});
  }
  return out;
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
    if(isPBFrame(it.sku)) return; // PB 테는 재고를 쌓지 않는다 (D-03)
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
  // [09.24] PB = 일반 안경 9사이즈 테. 렌즈·콘택트는 반복 구매이고 본사 몫은 공급 마진이다 (사업계획서 v2.1 §8)
  var rows;
  if(ready){const r=await pool.query("SELECT store, cat, (sku ~ '^(CL|WD|SL|RD)-') AS pb, SUM(amount)::int AS amt FROM sales WHERE date BETWEEN $1 AND $2 AND amount>0 GROUP BY store,cat,pb",[from,to]);rows=r.rows;}
  else{ var m={}; mem.sales.filter(s=>s.date>=from&&s.date<=to&&s.amount>0).forEach(function(s){var pb=isPBFrame(s.sku);var k=s.store+'|'+s.cat+'|'+pb;m[k]=m[k]||{store:s.store,cat:s.cat,pb:pb,amt:0};m[k].amt+=s.amount;}); rows=Object.keys(m).map(function(k){return m[k];}); }
  var totalRetail=0, totalHQ=0, byStore={}, byCat={}, frame=0, pbFrame=0, repeat=0;
  rows.forEach(function(r){
    var rate=HQ_RATE[r.cat]!=null?HQ_RATE[r.cat]:0.1; var hq=Math.round(r.amt*rate);
    totalRetail+=r.amt; totalHQ+=hq;
    var b=byStore[r.store]=byStore[r.store]||{retail:0,hq:0,frame:0,pb:0,repeat:0};
    b.retail+=r.amt; b.hq+=hq;
    if(r.cat==='테'){ b.frame+=r.amt; frame+=r.amt; if(r.pb){ b.pb+=r.amt; pbFrame+=r.amt; } }
    if(r.cat==='렌즈'||r.cat==='콘택트'){ b.repeat+=r.amt; repeat+=r.amt; }
    byCat[r.cat]=byCat[r.cat]||{retail:0,hq:0}; byCat[r.cat].retail+=r.amt; byCat[r.cat].hq+=hq;
  });
  var pct=function(a,b){return b?Math.round(a/b*100):0;};
  var stores=Object.keys(byStore).map(function(s){var o=byStore[s];return {store:s,retail:o.retail,hq:o.hq,pbShare:pct(o.pb,o.frame),repeatShare:pct(o.repeat,o.retail)};}).sort(function(a,b){return b.hq-a.hq;});
  return {totalRetail:totalRetail, totalHQ:totalHQ, stores:stores, byCat:byCat, rates:HQ_RATE, pbShare:pct(pbFrame,frame), repeatShare:pct(repeat,totalRetail)};
}

async function analytics(from, to){
  var rows;
  if(ready){const r=await pool.query('SELECT sku,name,cat,SUM(qty)::int AS qty,SUM(amount)::int AS amt FROM sales WHERE date BETWEEN $1 AND $2 AND amount>0 GROUP BY sku,name,cat',[from,to]);rows=r.rows;}
  else{ var m={}; mem.sales.filter(s=>s.date>=from&&s.date<=to&&s.amount>0).forEach(function(s){var k=s.sku;m[k]=m[k]||{sku:s.sku,name:s.name,cat:s.cat,qty:0,amt:0};m[k].qty+=s.qty;m[k].amt+=s.amount;}); rows=Object.keys(m).map(function(k){return m[k];}); }
  var sizeMap={S:{qty:0,amt:0},M:{qty:0,amt:0},L:{qty:0,amt:0}};
  var designMap={}, catMap={};
  rows.forEach(function(r){
    catMap[r.cat]=catMap[r.cat]||{qty:0,amt:0}; catMap[r.cat].qty+=r.qty; catMap[r.cat].amt+=r.amt;
    if(r.cat==='테'||r.cat==='선글라스'){
      var parts=String(r.sku).split('-'); var sz=parts[1];
      if(sizeMap[sz]){ sizeMap[sz].qty+=r.qty; sizeMap[sz].amt+=r.amt; }
      var base=r.name.replace(/ [SML]$/,'');
      designMap[base]=designMap[base]||{qty:0,amt:0}; designMap[base].qty+=r.qty; designMap[base].amt+=r.amt;
    }
  });
  var sizes=['S','M','L'].map(function(z){return {size:z, qty:sizeMap[z].qty, amt:sizeMap[z].amt};});
  var frameQty=sizes.reduce(function(a,x){return a+x.qty;},0)||1;
  sizes.forEach(function(x){x.share=Math.round(x.qty/frameQty*100);});
  var designs=Object.keys(designMap).map(function(d){return {name:d, qty:designMap[d].qty, amt:designMap[d].amt};}).sort(function(a,b){return b.qty-a.qty;}).slice(0,6);
  var totAmt=Object.keys(catMap).reduce(function(a,c){return a+catMap[c].amt;},0)||1;
  var catMix=Object.keys(catMap).map(function(c){return {cat:c, qty:catMap[c].qty, amt:catMap[c].amt, share:Math.round(catMap[c].amt/totAmt*100)};}).sort(function(a,b){return b.amt-a.amt;});
  // 상권/지점별 PB 침투율
  var pb=await pbMargin(from,to);
  return {sizes:sizes, designs:designs, catMix:catMix, stores:pb.stores};
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

function _genToken(){ return 'tk_'+crypto.randomBytes(32).toString('hex'); }
async function login(username, pass){
  let u;
  if(ready){const r=await pool.query('SELECT id,username,pass,role,store FROM users WHERE username=$1',[username]); u=r.rows[0];}
  else { u=mem.users.find(function(x){return x.username===username;}); }
  if(!u || !checkPass(u.pass,pass)) return {ok:false,error:'아이디 또는 비밀번호가 틀렸어요'};
  var token=_genToken();
  if(ready){ await pool.query('UPDATE users SET token=$2 WHERE id=$1',[u.id,token]); }
  else { var mu=mem.users.find(function(x){return x.id===u.id;}); if(mu)mu.token=token; }
  return {ok:true, token:token, role:u.role, store:u.store||null, username:u.username};
}
async function userByToken(token){
  if(!token) return null;
  if(ready){const r=await pool.query('SELECT username,role,store FROM users WHERE token=$1',[token]); return r.rows[0]||null;}
  var u=mem.users.find(function(x){return x.token===token;}); return u? {username:u.username,role:u.role,store:u.store||null}:null;
}
async function logout(token){
  if(!token) return;
  if(ready){ await pool.query('UPDATE users SET token=NULL WHERE token=$1',[token]); }
  else { var u=mem.users.find(function(x){return x.token===token;}); if(u)u.token=null; }
}


/* ===================== [09.24] 판 다음 확인 · A/S · 측정 ===================== */
const AS_CAUSES=['검안','가공','피팅','추천'];
// [09.24] 7일째 질문 3개 (사업계획서 v2.1 §5.2): 잘 보이는지 / 흘러내리는지 / 가까운 게 보이는지
const CARE_ISSUES=['먼 곳','흘러내림','가까운 곳','기타'];
const CARE_QUESTIONS=[{k:'먼 곳',q:'멀리 있는 게 잘 보여요?'},{k:'흘러내림',q:'안경이 흘러내리지 않아요?'},{k:'가까운 곳',q:'가까운 게 잘 보여요?'}];
const CARE_JUDGE=['적응 중','다시 맞춤'];
function _iso(d){ var p=function(n){return (n<10?'0':'')+n;}; return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate()); }
function _addDays(iso,n){ var d=new Date(iso+'T00:00:00'); d.setDate(d.getDate()+n); return _iso(d); }
function _demoCare(){
  var t=new Date(); var today=_iso(t); var ago=function(n){return new Date(t.getTime()-n*864e5).toISOString();};
  var care=[
    {customer_id:1,store:'성수점',sale_date:_addDays(today,-7),due_date:today,status:'예정',fit:94},
    {customer_id:4,store:'성수점',sale_date:_addDays(today,-9),due_date:_addDays(today,-2),status:'예정',fit:88},
    {customer_id:2,store:'성수점',sale_date:_addDays(today,-12),due_date:_addDays(today,-5),status:'완료',comfort:'편함',issues:'',note:'',source:'매장 전화',done_at:ago(4),fit:92},
    {customer_id:3,store:'홍대점',sale_date:_addDays(today,-10),due_date:_addDays(today,-3),status:'완료',comfort:'불편',issues:'흘러내림',note:'코받침이 눌리고 흘러내림',source:'손님 앱',done_at:ago(2),fit:78,judge:'다시 맞춤'},
    {customer_id:6,store:'홍대점',sale_date:_addDays(today,-5),due_date:_addDays(today,2),status:'예정',fit:90},
    {customer_id:5,store:'판교점',sale_date:_addDays(today,-14),due_date:_addDays(today,-7),status:'완료',comfort:'불편',issues:'가까운 곳',note:'누진 첫 착용',source:'매장 전화',done_at:ago(6),fit:86,judge:'적응 중'},
    {customer_id:7,store:'판교점',sale_date:_addDays(today,-11),due_date:_addDays(today,-4),status:'연락 안 됨',note:'2회 통화 안 됨',source:'매장 전화',fit:83},
    {customer_id:4,store:'홍대점',sale_date:_addDays(today,-4),due_date:_addDays(today,-1),status:'완료',comfort:'불편',issues:'먼 곳',note:'오른쪽이 조금 흐림',source:'손님 앱',done_at:ago(1),fit:91}
  ];
  // 지난 확인 기록 (기준 보정용 데모): [매장, 며칠 전, 계산 적합도, 불편 항목]
  [['성수점',40,95,''],['성수점',38,93,''],['홍대점',36,91,''],['판교점',35,90,''],['성수점',33,89,''],['홍대점',31,87,'흘러내림'],
   ['판교점',29,86,''],['성수점',27,84,''],['홍대점',25,82,'흘러내림'],['판교점',24,81,''],['성수점',22,79,'흘러내림'],['홍대점',21,77,''],
   ['판교점',19,76,'흘러내림'],['성수점',18,74,'흘러내림'],['홍대점',16,96,''],['판교점',15,92,'가까운 곳']].forEach(function(h,i){
    care.push({customer_id:(i%7)+1,store:h[0],sale_date:_addDays(today,-h[1]-7),due_date:_addDays(today,-h[1]),status:'완료',comfort:h[3]?'불편':'편함',issues:h[3],note:'',source:i%2?'손님 앱':'매장 전화',done_at:ago(h[1]),fit:h[2],judge:h[3]?'다시 맞춤':null});
  });
  care.forEach(function(x){ ['comfort','issues','note','source','done_at','judge','fit'].forEach(function(k){ if(x[k]===undefined) x[k]=null; }); });
  var as=[
    {customer_id:3,store:'홍대점',symptom:'흘러내림 (7일째 확인) · 코받침이 눌리고 흘러내림',cause:null,action:null,status:'열림',closed_at:null},
    {customer_id:5,store:'판교점',symptom:'가까운 곳 (7일째 확인) · 누진 첫 착용',cause:'검안',action:'가입도 재측정 후 렌즈 재제작',status:'종결',closed_at:ago(3)},
    {customer_id:2,store:'성수점',symptom:'안경 흘러내림',cause:'피팅',action:'템플 끝 재조정',status:'종결',closed_at:ago(20)}
  ];
  return {care:care, as:as};
}
async function _afterSale(store, customerId, date, lines, fit){
  // 테·렌즈를 산 고객이면 7일째 착용 확인을 자동으로 잡는다
  if(!customerId) return;
  if(!lines.some(function(l){return l.cat==='테'||l.cat==='렌즈';})) return;
  var due=_addDays(date,7);
  fit=(fit!=null&&isFinite(+fit))?Math.max(0,Math.min(100,Math.round(+fit))):null;
  if(ready){ await pool.query("INSERT INTO aftercare(customer_id,store,sale_date,due_date,status,fit) VALUES($1,$2,$3,$4,'예정',$5)",[customerId,store,date,due,fit]); return; }
  mem.aftercare.push({id:mem.aftercare.length+1,customer_id:+customerId,store:store,sale_date:date,due_date:due,status:'예정',comfort:null,issues:null,note:null,source:null,done_at:null,judge:null,fit:fit});
}
async function _custNames(){ var m={}; if(ready){ const r=await pool.query('SELECT id,name,phone FROM customers'); r.rows.forEach(function(c){m[c.id]=c;}); } else mem.customers.forEach(function(c){m[c.id]=c;}); return m; }
async function listAftercare(store, status){
  var rows;
  if(ready){ const r=await pool.query('SELECT id,customer_id,store,sale_date,due_date,status,comfort,issues,note,source,done_at,judge,fit FROM aftercare WHERE ($1::text IS NULL OR store=$1) AND ($2::text IS NULL OR status=$2) ORDER BY due_date DESC, id DESC',[store||null,status||null]); rows=r.rows; }
  else rows=mem.aftercare.filter(function(x){return (!store||x.store===store)&&(!status||x.status===status);}).slice().sort(function(a,b){return a.due_date<b.due_date?1:-1;});
  var names=await _custNames();
  return rows.map(function(x){ var c=names[x.customer_id]||{}; return Object.assign({},x,{name:c.name||'-',phone:c.phone||''}); });
}
async function getAftercare(id){
  if(!/^\d+$/.test(String(id))) return null;
  if(ready){ const r=await pool.query('SELECT * FROM aftercare WHERE id=$1',[id]); return r.rows[0]||null; }
  return mem.aftercare.find(function(x){return x.id===+id;})||null;
}
function _cleanIssues(v){ var a=Array.isArray(v)?v:String(v||'').split(','); return a.map(function(x){return String(x).trim();}).filter(function(x){return CARE_ISSUES.indexOf(x)>=0;}).join(','); }
async function recordAftercare(id, b){
  // 손님 앱 또는 매장 전화로 질문 3개에 답한다. 하나라도 '아니요'면 불편 → 매장이 판별(적응 중 / 다시 맞춤)
  var cur=await getAftercare(id); if(!cur) return {ok:false,error:'확인 건이 없어요'};
  if(b.onlyPending && cur.status!=='예정') return {ok:false,error:'이미 확인된 건이에요'};
  var status = b.status==='연락 안 됨' ? '연락 안 됨' : '완료';
  var issues = status==='완료' ? _cleanIssues(b.issues) : '';
  var comfort = status==='완료' ? ((issues || b.comfort==='불편') ? '불편' : '편함') : null;
  var note = String(b.note||'').slice(0,300); var source = (b.source==='손님 앱'||b.source==='고객 앱')?'손님 앱':'매장 전화';
  var judge = comfort==='불편' && CARE_JUDGE.indexOf(b.judge)>=0 ? b.judge : null;
  if(ready){ await pool.query('UPDATE aftercare SET status=$2,comfort=$3,issues=$4,note=$5,source=$6,judge=$7,done_at=now() WHERE id=$1',[id,status,comfort,issues,note,source,judge]); }
  else Object.assign(cur,{status:status,comfort:comfort,issues:issues,note:note,source:source,judge:judge,done_at:new Date().toISOString()});
  var r=judge? await _applyJudge(Object.assign({},cur,{issues:issues,note:note}), judge) : {};
  return Object.assign({ok:true, status:status, comfort:comfort, judge:judge, needJudge:comfort==='불편'&&!judge}, r);
}
async function judgeAftercare(id, judge){
  // 매장이 판별한다. 적응 중 → 7일 뒤 한 번 더 확인 / 다시 맞춤 → A/S 건을 연다
  if(CARE_JUDGE.indexOf(judge)<0) return {ok:false,error:'적응 중 또는 다시 맞춤을 골라 주세요'};
  var cur=await getAftercare(id); if(!cur) return {ok:false,error:'확인 건이 없어요'};
  if(cur.comfort!=='불편') return {ok:false,error:'불편 응답이 있는 건만 판별해요'};
  if(cur.judge) return {ok:false,error:'이미 판별한 건이에요'};
  if(ready) await pool.query('UPDATE aftercare SET judge=$2 WHERE id=$1',[id,judge]); else cur.judge=judge;
  return Object.assign({ok:true, judge:judge}, await _applyJudge(cur, judge));
}
async function _applyJudge(cur, judge){
  if(judge==='다시 맞춤'){
    var r=await openAS({customer_id:cur.customer_id,store:cur.store,aftercare_id:+cur.id,symptom:(cur.issues||'불편')+' (7일째 확인)'+(cur.note?' · '+cur.note:'')});
    return {as_id:r.id};
  }
  var due=_addDays(_iso(new Date()),7);
  if(ready){ const q=await pool.query("INSERT INTO aftercare(customer_id,store,sale_date,due_date,status,note,fit) VALUES($1,$2,$3,$4,'예정','적응 확인',$5) RETURNING id",[cur.customer_id,cur.store,cur.sale_date,due,cur.fit]); return {recheck_id:q.rows[0].id, recheck_due:due}; }
  var nid=mem.aftercare.length+1; mem.aftercare.push({id:nid,customer_id:cur.customer_id,store:cur.store,sale_date:cur.sale_date,due_date:due,status:'예정',comfort:null,issues:null,note:'적응 확인',source:null,done_at:null,judge:null,fit:cur.fit});
  return {recheck_id:nid, recheck_due:due};
}
/* ===== [09.24] 시력 기록 · 검사 주기 (사업계획서 v2.1 §5.4, §10.2) ===== */
// 손님층별 검사 주기(개월). 아이 근시 3~6개월, 노안·누진은 도수가 바뀔 때, 일반 안경 2~3년. 실제 주기는 1호점에서 정해요
const CARE_GROUPS={'아이 근시':6,'노안·누진':12,'콘택트렌즈':12,'일반':24};
function _demoExams(){
  var d=function(m){var t=new Date(); t.setMonth(t.getMonth()-m); return _iso(t).slice(0,7)+'-10';};
  var ex=function(cid,member,grp,m,rs,ls,rc,lc,add){return {customer_id:cid,member:member,grp:grp,date:d(m),rx:JSON.stringify({R:{S:rs,C:rc||0,A:180},L:{S:ls,C:lc||0,A:175},ADD:add||0})};};
  return [
    ex(1,'본인','일반',48,-2.50,-2.75,-0.50,-0.25), ex(1,'본인','일반',24,-3.00,-3.25,-0.50,-0.25), ex(1,'본인','일반',7,-3.25,-3.50,-0.50,-0.25),
    ex(1,'딸 하린','아이 근시',31,-0.50,-0.50), ex(1,'딸 하린','아이 근시',25,-0.75,-0.75), ex(1,'딸 하린','아이 근시',19,-1.00,-1.25),
    ex(1,'딸 하린','아이 근시',13,-1.50,-1.50), ex(1,'딸 하린','아이 근시',7,-1.75,-1.75),
    ex(5,'본인','노안·누진',26,-1.00,-1.25,0,0,1.25), ex(5,'본인','노안·누진',14,-1.00,-1.25,0,0,1.50), ex(5,'본인','노안·누진',2,-1.00,-1.25,0,0,1.75)
  ];
}
function _se(o){ return o.S+(o.C||0)/2; }
async function listExams(customerId){
  if(ready){ const r=await pool.query('SELECT member,grp,date,rx FROM vision_exams WHERE customer_id=$1 ORDER BY date',[customerId]); return r.rows; }
  return (mem.exams||[]).filter(function(x){return +x.customer_id===+customerId;}).sort(function(a,b){return a.date<b.date?-1:1;});
}
async function visionFor(customerId){
  var rows=await listExams(customerId), by={}, today=_iso(new Date());
  rows.forEach(function(x){ (by[x.member]=by[x.member]||[]).push(x); });
  var members=Object.keys(by).map(function(m){
    var ex=by[m].map(function(x){var rx=typeof x.rx==='string'?JSON.parse(x.rx):x.rx; return {date:x.date, R:rx.R, L:rx.L, ADD:rx.ADD||0, se:Math.round((_se(rx.R)+_se(rx.L))/2*100)/100};});
    var grp=by[m][by[m].length-1].grp, months=CARE_GROUPS[grp]||24, last=ex[ex.length-1];
    var nd=new Date(last.date+'T00:00:00'); nd.setMonth(nd.getMonth()+months); var next=_iso(nd);
    var first=ex[0], yrs=Math.max(0.5,(new Date(last.date)-new Date(first.date))/3.156e10);
    return {member:m, grp:grp, months:months, exams:ex, last:last.date, next:next, due:next<=today,
      change:Math.round((last.se-first.se)*100)/100, perYear:ex.length>1?Math.round((last.se-first.se)/yrs*100)/100:null};
  });
  members.sort(function(a,b){return a.member==='본인'?-1:b.member==='본인'?1:0;});
  return {members:members, groups:CARE_GROUPS};
}
/* ===== [09.24] 테 판정 · 가공 지시서 (사업계획서 v2.1 §5.1, §5.5) =====
   판정 기준값은 시작값이에요. 1호점 안경사와 자문 안경사가 확정하고 착용 결과로 고쳐요(D-04). */
const FRAME_SPECS=(function(){
  var o={}, base={CL:{a:[50,53,56],B:[40,41,42],dbl:[16,18,19]},WD:{a:[51,54,57],B:[38,39,40],dbl:[16,18,19]},SL:{a:[49,52,55],B:[36,37,38],dbl:[17,18,19]},RD:{a:[48,51,54],B:[46,47,48],dbl:[18,19,20]}};
  Object.keys(base).forEach(function(k){ ['S','M','L'].forEach(function(z,i){ o[k+'-'+z]={a:base[k].a[i],B:base[k].B[i],dbl:base[k].dbl[i],temple:[140,145,150][i],pad:'조절형',mat:'아세테이트'}; }); });
  o['Y1']={a:53,B:41,dbl:18,temple:145,pad:'조절형',mat:'티타늄'}; o['Y2']={a:51,B:43,dbl:19,temple:140,pad:'고정형',mat:'아세테이트'};
  return o;
})();
const JUDGE_RULE={version:'v0.4', face:[4,8], temple:[0,5], blank:[70,75]};
function _num1(v){ var m=String(v||'').match(/-?\d+(\.\d+)?/); return m?parseFloat(m[0]):null; }
function _rxFromText(t){ var m=String(t||'').match(/OD\s*([+-]?\d+(\.\d+)?).*OS\s*([+-]?\d+(\.\d+)?)/); return m?{R:{S:+m[1],C:0,A:0},L:{S:+m[3],C:0,A:0},ADD:0}:null; }
function _idx(se){ var m=Math.abs(se); return m>=6?1.74:(m>=4?1.67:(m>=2?1.60:1.56)); }
function _eyeCalc(e, monoPD, sp){
  var se=e.S+(e.C||0)/2, dec=Math.round(((sp.a+sp.dbl)/2-monoPD)*10)/10, ED=Math.round(sp.a*1.1*10)/10; // 유효경은 입고 측정값으로 바꿔요
  var mbs=Math.round((ED+2*Math.abs(dec)+2)*10)/10, n=_idx(se);
  var r=ED/2+Math.abs(dec), edge= se<0 ? Math.round((1.2+Math.abs(se)*r*r/(2*(n-1)*1000))*10)/10 : 1.2;
  return {S:e.S,C:e.C||0,A:e.A||0,se:Math.round(se*100)/100,pd:monoPD,dec:dec,ocH:Math.round(sp.B/2*10)/10,ed:ED,mbs:mbs,idx:n.toFixed(2),edge:edge};
}
function judgeFrame(c, rx, sp, pb){
  var face=_num1(c.face), pd=_num1(c.pd)||63, t=(String(c.size||'').match(/T(\d)/)||[])[1], need=c.templeLen?Math.round(+c.templeLen/5)*5:[140,145,150][(+t||2)-1];
  if(c.templeLen && !t) t=need<=140?1:(need>=150?3:2);
  var frameW=2*sp.a+sp.dbl+14, fd=face!=null?Math.round(frameW-face):0, td=sp.temple-need;
  var R=rx?_eyeCalc(rx.R,pd/2,sp):null, L=rx?_eyeCalc(rx.L,pd/2,sp):null, mbs=rx?Math.max(R.mbs,L.mbs):0;
  var lv=0, why=[];
  function mark(l,t){ if(l>lv) lv=l; if(l>0) why.push(t); }
  var af=Math.abs(fd);
  mark(af<=JUDGE_RULE.face[0]?0:(af<=JUDGE_RULE.face[1]?1:2), '프론트가 얼굴보다 '+af+'mm '+(fd>0?'넓어요':'좁아요')+(af<=JUDGE_RULE.face[1]?'. 템플 벌림으로 맞춰요':''));
  var at=Math.abs(td);
  if(pb && at>0){ why.push('PB라 템플을 T'+(+t||2)+' 길이로 바꿔 조립해요'); at=0; td=0; }
  mark(at<=JUDGE_RULE.temple[0]?0:(at<=JUDGE_RULE.temple[1]?1:2), '템플이 '+at+'mm '+(td>0?'길어요':'짧아요')+(at<=JUDGE_RULE.temple[1]?'. 템플 끝 굽힘으로 맞춰요':''));
  if(rx) mark(mbs<=JUDGE_RULE.blank[0]?0:(mbs<=JUDGE_RULE.blank[1]?1:2), '최소 블랭크 '+mbs+'mm'+(mbs<=JUDGE_RULE.blank[1]?'. 큰 블랭크로 주문해요':'. 가공할 수 없어요'));
  var score=Math.max(0,Math.min(100,Math.round(100-2.5*af-1.5*at-Math.max(0,mbs-65)*1.5)));
  return {level:['가능','조정 필요','불가'][lv], lv:lv, why:why, score:score, frameW:frameW, faceDiff:fd, templeDiff:td, R:R, L:L, spec:sp};
}
async function _custRx(customerId){
  var c=await getCustomer(customerId); if(!c) return {};
  var ex=(await listExams(customerId)).filter(function(x){return x.member==='본인';});
  var rx= ex.length ? (typeof ex[ex.length-1].rx==='string'?JSON.parse(ex[ex.length-1].rx):ex[ex.length-1].rx) : _rxFromText(c.rx);
  return {c:c, rx:rx, rxDate: ex.length?ex[ex.length-1].date:null};
}
async function judgeFrames(customerId, store){
  var o=await _custRx(customerId); if(!o.c) return {ok:false,error:'손님이 없어요'}; if(!o.rx) return {ok:false,error:'처방 기록이 없어요. 검안부터 해 주세요'};
  var inv=(await getInventory(store||o.c.store)).filter(function(i){return i.cat==='테'&&FRAME_SPECS[i.sku];});
  var items=inv.map(function(i){ return Object.assign({sku:i.sku,name:i.name,price:i.price,stock:i.stock,pb:isPBFrame(i.sku)}, judgeFrame(o.c,o.rx,FRAME_SPECS[i.sku],isPBFrame(i.sku))); });
  items.sort(function(a,b){ return a.lv-b.lv || b.score-a.score; });
  return {ok:true, customer:{id:o.c.id,name:o.c.name,size:o.c.size,face:o.c.face,pd:o.c.pd}, rx:o.rx, rxDate:o.rxDate, rule:JUDGE_RULE, items:items};
}
// 손님 앱: 측정값만으로 판정 (처방이 있으면 블랭크까지). 쓸 수 없는 테는 빼고 보여줘요
async function judgeByMeasure(q){
  var face=+q.face, temple=+q.temple, pd=+q.pd||63; if(!(face>100&&face<180)) return {ok:false,error:'얼굴 폭 값이 이상해요'};
  var rx=null; if(q.customer_id){ var o=await _custRx(q.customer_id); rx=o.rx||null; }
  var store=q.store||'성수점', inv=(await getInventory(store)).filter(function(i){return i.cat==='테'&&FRAME_SPECS[i.sku];});
  var c={face:face+'mm', pd:pd+'mm', templeLen:temple||145};
  var items=inv.map(function(i){ var j=judgeFrame(c,rx,FRAME_SPECS[i.sku],isPBFrame(i.sku)); return {sku:i.sku,name:i.name,price:i.price,pb:isPBFrame(i.sku),level:j.level,lv:j.lv,score:j.score,why:j.why,spec:j.spec,faceDiff:j.faceDiff}; });
  items.sort(function(a,b){ return a.lv-b.lv || b.score-a.score; });
  return {ok:true, store:store, withRx:!!rx, items:items.filter(function(x){return x.lv<2;}), hidden:items.filter(function(x){return x.lv===2;}).length};
}
async function createWorkorder(b){
  var o=await _custRx(b.customer_id); if(!o.c||!o.rx) return {ok:false,error:'손님이나 처방 기록이 없어요'};
  var sp=FRAME_SPECS[b.sku]; if(!sp) return {ok:false,error:'치수를 모르는 테예요'};
  var j=judgeFrame(o.c,o.rx,sp,isPBFrame(b.sku)); if(j.lv===2) return {ok:false,error:'가공할 수 없는 조합이에요: '+j.why.filter(function(w){return w.indexOf('PB라')<0;}).join(' / ')};
  var item=CATALOG.find(function(x){return x.sku===b.sku;})||{name:b.sku};
  var row={store:b.store||o.c.store, customer_id:o.c.id, sku:b.sku, frame:item.name, lens:String(b.lens||'').slice(0,60), rx:JSON.stringify(o.rx), calc:JSON.stringify(j), status:'발행', created_at:new Date().toISOString()};
  if(ready){ const r=await pool.query('INSERT INTO workorders(store,customer_id,sku,frame,lens,rx,calc,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,created_at',[row.store,row.customer_id,row.sku,row.frame,row.lens,row.rx,row.calc,row.status]); row.id=r.rows[0].id; row.created_at=r.rows[0].created_at; }
  else { mem.workorders=mem.workorders||[]; row.id=mem.workorders.length+1; mem.workorders.push(row); }
  return {ok:true, workorder:Object.assign({},row,{calc:j,rx:o.rx,name:o.c.name})};
}
async function listWorkorders(store){
  var rows;
  if(ready){ rows=(await pool.query('SELECT id,store,customer_id,sku,frame,lens,status,created_at FROM workorders WHERE ($1::text IS NULL OR store=$1) ORDER BY id DESC LIMIT 20',[store||null])).rows; }
  else rows=(mem.workorders||[]).filter(function(x){return !store||x.store===store;}).slice().reverse();
  var names=await _custNames(); return rows.map(function(x){ return {id:x.id,store:x.store,sku:x.sku,frame:x.frame,lens:x.lens,status:x.status,created_at:x.created_at,name:(names[x.customer_id]||{}).name||'-'}; });
}
/* ===== [09.24] 기준 보정 · 기준 관리 (구조기능도해 v2.1 6단계) ===== */
function _demoStandards(){
  var d=function(n){return new Date(Date.now()-n*864e5).toISOString();};
  return [
    {kind:'판정 규칙',version:'v0.3',note:'측정 설계서 v0.3 기준. 코 높이 구간 3단계',released_at:d(20)},
    {kind:'판정 규칙',version:'v0.4',note:'적합도 80% 미만 흘러내림이 많아 코받침 기준을 좁힘',released_at:d(2)},
    {kind:'안경테 DB',version:'2026.09',note:'PB 로마 4종 + 수입 A 라인 입고 측정',released_at:d(12)}
  ].map(function(x,i){return Object.assign({id:i+1},x);});
}
function _demoDeploy(){
  return [{store:'성수점',kind:'판정 규칙',version:'v0.4'},{store:'홍대점',kind:'판정 규칙',version:'v0.3'},{store:'판교점',kind:'판정 규칙',version:'v0.3'},
          {store:'성수점',kind:'안경테 DB',version:'2026.09'},{store:'홍대점',kind:'안경테 DB',version:'2026.09'},{store:'판교점',kind:'안경테 DB',version:'2026.09'}];
}
async function listStandards(){
  var st, dp;
  if(ready){ st=(await pool.query('SELECT id,kind,version,note,released_at FROM standards ORDER BY released_at DESC, id DESC')).rows; dp=(await pool.query('SELECT store,kind,version FROM standard_deploy')).rows; }
  else { st=mem.standards.slice().sort(function(a,b){return a.released_at<b.released_at?1:-1;}); dp=mem.deploy; }
  var latest={}; st.forEach(function(x){ if(!latest[x.kind]) latest[x.kind]=x.version; });
  var stores={}; STORES.forEach(function(s){ stores[s]={}; }); dp.forEach(function(x){ (stores[x.store]=stores[x.store]||{})[x.kind]=x.version; });
  return {standards:st, latest:latest, stores:stores};
}
async function deployStandard(kind){
  var info=await listStandards(); var v=info.latest[kind]; if(!v) return {ok:false,error:'배포할 기준이 없어요'};
  for(const s of STORES){
    if(ready) await pool.query('INSERT INTO standard_deploy(store,kind,version,at) VALUES($1,$2,$3,now()) ON CONFLICT(store,kind) DO UPDATE SET version=$3, at=now()',[s,kind,v]);
    else { var row=mem.deploy.find(function(x){return x.store===s&&x.kind===kind;}); if(row) row.version=v; else mem.deploy.push({store:s,kind:kind,version:v}); }
  }
  return {ok:true, kind:kind, version:v};
}
async function calibration(){
  // 계산한 적합도와 실제 만족도(7일째 불편 없음 비율)를 구간별로 비교한다
  var rows=(await listAftercare(null,'완료')).filter(function(x){return x.fit!=null;});
  var bands=[{name:'90% 이상',min:90,max:101},{name:'80~89%',min:80,max:90},{name:'80% 미만',min:0,max:80}];
  return {total:rows.length, overrides:await overrideSummary(), bands:bands.map(function(b){
    var r=rows.filter(function(x){return x.fit>=b.min&&x.fit<b.max;}); var ok=r.filter(function(x){return x.comfort==='편함';}).length;
    var slip=r.filter(function(x){return String(x.issues||'').indexOf('흘러내림')>=0;}).length;
    return {name:b.name, n:r.length, ok:ok, rate:r.length?Math.round(ok/r.length*100):null, slip:slip};
  })};
}
/* [09.24] D-12 본사는 막지 않고 기록한다: 순서 건너뛰기 · 기준 미달 건넴은 사유를 남기고 넘어간다 */
const OVERRIDE_REASONS={
  step_skip:['손님이 급함','다른 기기에서 이미 함','다시 온 손님','안경사 판단','기타'],
  fit_below:['손님이 급함','손님이 이 테를 원함','안경사 판단','기타']
};
async function recordOverride(b, who){
  var kind=OVERRIDE_REASONS[b.kind]?b.kind:null; if(!kind) return {ok:false,error:'종류가 없어요'};
  var reason=OVERRIDE_REASONS[kind].indexOf(b.reason)>=0?b.reason:null; if(!reason) return {ok:false,error:'사유를 골라 주세요'};
  var row={kind:kind, step:String(b.step||'').slice(0,40), reason:reason, detail:String(b.detail||'').slice(0,200),
    customer_id:/^\d+$/.test(String(b.customer_id||''))?+b.customer_id:null, store:(who&&who.store)||b.store||null, username:who?who.username:null};
  if(!row.store && row.customer_id){ var c=await getCustomer(row.customer_id); if(c) row.store=c.store||null; }
  if(ready){ const r=await pool.query('INSERT INTO overrides(kind,step,reason,detail,customer_id,store,username) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id',[row.kind,row.step,row.reason,row.detail,row.customer_id,row.store,row.username]); return {ok:true,id:r.rows[0].id}; }
  row.id=mem.overrides.length+1; row.at=new Date().toISOString(); mem.overrides.push(row); return {ok:true,id:row.id};
}
async function overrideSummary(){
  var rows = ready ? (await pool.query('SELECT * FROM overrides ORDER BY id DESC LIMIT 2000')).rows : mem.overrides.slice().reverse();
  var byReason={}; rows.forEach(function(x){ var k=x.kind+'|'+x.reason; byReason[k]=(byReason[k]||0)+1; });
  // 기준 미달로 건넨 손님의 7일째 결과: 같은 손님, 기록 뒤에 완료된 확인
  var done=(await listAftercare(null,'완료')), fb=rows.filter(function(x){return x.kind==='fit_below'&&x.customer_id;}), checked=0, ok=0;
  fb.forEach(function(o){ var t=new Date(o.at).getTime(); var a=done.filter(function(c){return +c.customer_id===+o.customer_id && new Date(c.done_at||0).getTime()>=t;})[0];
    if(a){ checked++; if(a.comfort==='편함') ok++; } });
  return {total:rows.length, step_skip:rows.filter(function(x){return x.kind==='step_skip';}).length, fit_below:rows.filter(function(x){return x.kind==='fit_below';}).length,
    reasons:Object.keys(byReason).map(function(k){var p=k.split('|'); return {kind:p[0],reason:p[1],n:byReason[k]};}).sort(function(a,b){return b.n-a.n;}),
    fitBelow:{n:fb.length, checked:checked, ok:ok, rate:checked?Math.round(ok/checked*100):null},
    recent:rows.slice(0,5).map(function(x){return {kind:x.kind,step:x.step,reason:x.reason,store:x.store,at:x.at};})};
}
async function pendingAftercareFor(customerId){
  // 고객 앱용: 개인정보 없이 날짜만
  var rows=(await listAftercare(null,'예정')).filter(function(x){return +x.customer_id===+customerId;});
  return rows.map(function(x){return {id:x.id, due_date:x.due_date, sale_date:x.sale_date};});
}
async function openAS(a){
  var symptom=String(a.symptom||'').slice(0,300); if(!symptom) return {ok:false,error:'증상을 적어 주세요'};
  if(ready){ const r=await pool.query("INSERT INTO as_cases(customer_id,store,aftercare_id,symptom,status) VALUES($1,$2,$3,$4,'열림') RETURNING id",[a.customer_id||null,a.store||null,a.aftercare_id||null,symptom]); return {ok:true,id:r.rows[0].id}; }
  var id=mem.ascases.length+1; mem.ascases.push({id:id,customer_id:a.customer_id||null,store:a.store||null,aftercare_id:a.aftercare_id||null,symptom:symptom,cause:null,action:null,status:'열림',opened_at:new Date().toISOString(),closed_at:null}); return {ok:true,id:id};
}
async function getAS(id){ if(!/^\d+$/.test(String(id))) return null; if(ready){ const r=await pool.query('SELECT * FROM as_cases WHERE id=$1',[id]); return r.rows[0]||null; } return mem.ascases.find(function(x){return x.id===+id;})||null; }
async function listAS(store, status){
  var rows;
  if(ready){ const r=await pool.query('SELECT id,customer_id,store,aftercare_id,symptom,cause,action,status,opened_at,closed_at FROM as_cases WHERE ($1::text IS NULL OR store=$1) AND ($2::text IS NULL OR status=$2) ORDER BY status DESC, id DESC',[store||null,status||null]); rows=r.rows; }
  else rows=mem.ascases.filter(function(x){return (!store||x.store===store)&&(!status||x.status===status);}).slice().sort(function(a,b){return a.status===b.status?b.id-a.id:(a.status==='열림'?-1:1);});
  var names=await _custNames();
  return rows.map(function(x){ var c=names[x.customer_id]||{}; return Object.assign({},x,{name:c.name||'-'}); });
}
async function closeAS(id, cause, action){
  // 원인(검안·가공·피팅·추천) 하나를 골라야 종결된다
  if(AS_CAUSES.indexOf(cause)<0) return {ok:false,error:'원인을 검안·가공·피팅·추천 중에서 골라 주세요'};
  var cur=await getAS(id); if(!cur) return {ok:false,error:'A/S 건이 없어요'};
  if(cur.status==='종결') return {ok:false,error:'이미 종결된 건이에요'};
  action=String(action||'').slice(0,300);
  if(ready) await pool.query("UPDATE as_cases SET cause=$2,action=$3,status='종결',closed_at=now() WHERE id=$1",[id,cause,action]);
  else Object.assign(cur,{cause:cause,action:action,status:'종결',closed_at:new Date().toISOString()});
  return {ok:true};
}
async function careSummary(store){
  var care=await listAftercare(store,null), as=await listAS(store,null), today=_iso(new Date());
  var due=care.filter(function(x){return x.due_date<=today;});
  var done=due.filter(function(x){return x.status==='완료';});
  var uncomf=done.filter(function(x){return x.comfort==='불편';});
  var issues={}; uncomf.forEach(function(x){ String(x.issues||'').split(',').filter(Boolean).forEach(function(k){issues[k]=(issues[k]||0)+1;}); });
  var causes={}; AS_CAUSES.forEach(function(c){causes[c]=0;}); as.forEach(function(a){ if(a.status==='종결'&&causes[a.cause]!=null) causes[a.cause]++; });
  var byStore={}; due.forEach(function(x){ var b=byStore[x.store]=byStore[x.store]||{due:0,done:0,uncomf:0}; b.due++; if(x.status==='완료'){b.done++; if(x.comfort==='불편')b.uncomf++;} });
  return { due:due.length, done:done.length, overdue:due.filter(function(x){return x.status==='예정';}).length,
    noreach:due.filter(function(x){return x.status==='연락 안 됨';}).length, uncomf:uncomf.length, issues:issues,
    needJudge:uncomf.filter(function(x){return !x.judge;}).length, adapting:uncomf.filter(function(x){return x.judge==='적응 중';}).length, refit:uncomf.filter(function(x){return x.judge==='다시 맞춤';}).length,
    as_open:as.filter(function(a){return a.status==='열림';}).length, as_closed:as.filter(function(a){return a.status==='종결';}).length, causes:causes, byStore:byStore };
}
/* 측정 (설계서 v0.3 §4·§5) */
function _num(v){ var n=parseFloat(v); return isFinite(n)?Math.round(n*10)/10:null; }
/* [09.24] 9사이즈 규칙 — public/assets/bv-size-engine.js 와 같은 값. 〔1호점에서 확인〕
   프론트: 얼굴 가로폭 146 미만 F1 / 158 미만 F2 / 그 이상 F3
   템플: 각막~귀 앞뒤 + 정점거리 12 + 귀 뒤 25 → 140(T1)·145(T2)·150(T3) 중 가까운 것 */
var SIZE_RULE={front:[146,158], vd:12, tail:25, temples:[140,145,150]};
function sizeFromMeasure(faceWidth, earDepth, vd, prev){
  var p=String(prev||'').match(/F(\d)\s*[×x·]\s*T(\d)/)||[], F=p[1]||null, T=p[2]||null, need=null;
  if(faceWidth!=null) F=faceWidth<SIZE_RULE.front[0]?1:(faceWidth<SIZE_RULE.front[1]?2:3);
  if(earDepth!=null){ need=Math.round(earDepth+(vd||SIZE_RULE.vd)+SIZE_RULE.tail); var bi=0;
    SIZE_RULE.temples.forEach(function(z,i){ if(Math.abs(z-need)<Math.abs(SIZE_RULE.temples[bi]-need)) bi=i; }); T=bi+1; }
  return {code:(F&&T)?('F'+F+'×T'+T):null, need:need};
}
async function createMeasureSession(b){
  var device=['phone','ipad','rig'].indexOf(b.device)>=0?b.device:'ipad';
  if(ready){ const r=await pool.query('INSERT INTO measure_sessions(customer_id,device,store,operator) VALUES($1,$2,$3,$4) RETURNING id,customer_id,device,store,operator,status,created_at',[b.customer_id||null,device,b.store||null,b.operator||null]); return r.rows[0]; }
  var row={id:mem.msessions.length+1,customer_id:b.customer_id||null,device:device,store:b.store||null,operator:b.operator||null,status:'대기',created_at:new Date().toISOString()}; mem.msessions.push(row); return row;
}
async function getMeasureSession(id){ if(!/^\d+$/.test(String(id))) return null; if(ready){ const r=await pool.query('SELECT * FROM measure_sessions WHERE id=$1',[id]); return r.rows[0]||null; } return mem.msessions.find(function(x){return x.id===+id;})||null; }
async function saveMeasurement(sessionId, b, who){
  // 원칙: 영상·프레임은 받지 않는다(수치+메타만) / confidence<0.7 → provisional / 확정값만 고객 캐시 갱신
  var sess=null; if(sessionId && sessionId!=='adhoc'){ sess=await getMeasureSession(sessionId); if(!sess) return {ok:false,error:'세션이 없어요'}; }
  var cid=sess?sess.customer_id:(b.customer_id||null); if(!cid || !/^\d+$/.test(String(cid))) return {ok:false,error:'customer_id 필요'};
  var conf=Math.max(0,Math.min(1,parseFloat(b.confidence)||0));
  var anon=!who; // 로그인 안 한 고객 자가측정 → 항상 임시값
  var provisional = anon ? true : (conf<0.7 || b.provisional===true);
  var row={customer_id:+cid, session_id:sess?sess.id:null, store:sess?sess.store:(b.store||null), device:anon?'phone':(sess?sess.device:(['phone','ipad','rig'].indexOf(b.device)>=0?b.device:'ipad')),
    pd:_num(b.pd), face_width:_num(b.face_width), nose_height:_num(b.nose_height), nose_angle:_num(b.nose_angle),
    ear_l:_num(b.ear_left), ear_r:_num(b.ear_right), wrap_angle:_num(b.wrap_angle), ear_depth:_num(b.ear_depth),
    pow_json:b.pow?JSON.stringify(b.pow).slice(0,2000):null, confidence:conf, provisional:provisional,
    method:['truedepth','iris_scale','rig_stereo','manual'].indexOf(b.method)>=0?b.method:'iris_scale',
    operator:who?who.username:null, source:anon?'고객 자가측정':'매장'};
  if(row.pd==null && row.face_width==null) return {ok:false,error:'측정값이 없어요'};
  var cust=await getCustomer(row.customer_id), sz=sizeFromMeasure(row.face_width,row.ear_depth,_num(b.vd),cust?cust.size:null);
  row.size_code=sz.code;
  if(!row.store && cust) row.store=cust.store||null;
  var id;
  if(ready){ const r=await pool.query('INSERT INTO measurements(customer_id,session_id,store,device,pd,face_width,nose_height,nose_angle,ear_l,ear_r,wrap_angle,pow_json,confidence,provisional,method,operator,source,ear_depth,size_code) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING id',
      [row.customer_id,row.session_id,row.store,row.device,row.pd,row.face_width,row.nose_height,row.nose_angle,row.ear_l,row.ear_r,row.wrap_angle,row.pow_json,row.confidence,row.provisional,row.method,row.operator,row.source,row.ear_depth,row.size_code]); id=r.rows[0].id;
    if(sess) await pool.query("UPDATE measure_sessions SET status='완료' WHERE id=$1",[sess.id]); }
  else { id=mem.measurements.length+1; row.id=id; row.measured_at=new Date().toISOString(); mem.measurements.push(row); if(sess) sess.status='완료'; }
  var cacheUpdated=false;
  if(!provisional){
    var pdTxt=row.pd!=null?row.pd.toFixed(1)+'mm':null;
    var faceOf=function(face){ return row.face_width!=null ? (Math.round(row.face_width)+'mm'+(face&&face.indexOf('/')>=0?' /'+face.split('/').slice(1).join('/'):'')) : face; };
    if(ready){ const c=await pool.query('SELECT face FROM customers WHERE id=$1',[row.customer_id]);
      await pool.query('UPDATE customers SET pd=COALESCE($2,pd), face=$3, size=COALESCE($4,size) WHERE id=$1',[row.customer_id,pdTxt,faceOf(c.rows[0]?c.rows[0].face:null),sz.code]); }
    else { var mc=mem.customers.find(function(x){return x.id===row.customer_id;}); if(mc){ if(pdTxt)mc.pd=pdTxt; mc.face=faceOf(mc.face); if(sz.code) mc.size=sz.code; } }
    cacheUpdated=true;
  }
  await logMeasureAccess(who?who.username:'(고객 앱)', row.customer_id, 'write');
  return {ok:true, id:id, provisional:provisional, cache_updated:cacheUpdated, size:sz.code, prev_size:cust?cust.size:null, temple_need:sz.need};
}
async function listMeasurements(customerId){
  if(ready){ const r=await pool.query('SELECT id,session_id,store,device,measured_at,pd,face_width,nose_height,nose_angle,ear_l,ear_r,wrap_angle,ear_depth,size_code,confidence,provisional,method,operator,source FROM measurements WHERE customer_id=$1 ORDER BY id DESC',[customerId]); return r.rows; }
  return mem.measurements.filter(function(m){return m.customer_id===+customerId;}).slice().reverse();
}
async function logMeasureAccess(username, customerId, action){
  if(ready){ await pool.query('INSERT INTO measure_access_log(username,customer_id,action) VALUES($1,$2,$3)',[username||null,customerId||null,action]); return; }
  mem.accesslog.push({username:username,customer_id:customerId,action:action,at:new Date().toISOString()});
}

module.exports={ init, quotesForCustomer, catalogWithPolicy, createQuote, getQuote, listQuotes, markQuotePaid, QUOTE_VALID_DAYS, OVERRIDE_REASONS, recordOverride, overrideSummary, judgeFrames, judgeByMeasure, createWorkorder, listWorkorders, FRAME_SPECS, visionFor, CARE_GROUPS, AS_CAUSES, CARE_ISSUES, CARE_QUESTIONS, CARE_JUDGE, judgeAftercare, calibration, listStandards, deployStandard, isPBFrame, listAftercare, getAftercare, recordAftercare, pendingAftercareFor, openAS, getAS, listAS, closeAS, careSummary, createMeasureSession, getMeasureSession, saveMeasurement, listMeasurements, logMeasureAccess, STORES, CATALOG, refundSale, recentSales, createOrder, pushOrder, respondPush, autoConfirmPushes, listOrders, updateOrder, lowStock, salesRange, restockSuggest, pbMargin, settlement, login, userByToken, logout,
  createPickup, listPickups, updatePickup,
  listCustomers, getCustomer, customerHistory, addCustomer, moveCustomer, segCounts,
  listBookings, countSlot, addBooking,
  getInventory, getStock, restock,
  recordSale, salesSummary, salesDaily, listPricePolicy, setPricePolicy, analytics, forecastAll, activityFeed,
  get ready(){return ready;} };
