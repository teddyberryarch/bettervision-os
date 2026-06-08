// BETTERVISION OS — 정적 서빙 + 예약 API (PostgreSQL)
// 확장 염두: db.js의 init()에 테이블 추가, /api/* 라우트만 늘리면 됨
const http = require('http');
const fs = require('fs');
const path = require('path');
const db = require('./db');

const ROOT = path.join(__dirname, 'public');
const PORT = process.env.PORT || 3000;
const TYPES = {
  '.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8',
  '.js':'text/javascript; charset=utf-8','.json':'application/json',
  '.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg',
  '.ico':'image/x-icon','.woff2':'font/woff2'
};
const CAP = 2; // 30분당 정원

function send(res, code, obj, extraHeaders){ var h={'content-type':'application/json; charset=utf-8'}; if(extraHeaders)for(var k in extraHeaders)h[k]=extraHeaders[k]; res.writeHead(code, h); res.end(JSON.stringify(obj)); }
const AUTH_ON = process.env.AUTH_ON === 'true';
function getCookie(req,name){ var c=req.headers.cookie||''; var m=c.match(new RegExp('(?:^|; )'+name+'=([^;]+)')); return m?decodeURIComponent(m[1]):null; }
function body(req){ return new Promise(function(resolve){ let d=''; req.on('data',function(c){d+=c;}); req.on('end',function(){ try{resolve(d?JSON.parse(d):{});}catch(e){resolve({});} }); }); }

async function api(req, res, url){
  try{
    // ===== 인증 게이트 (AUTH_ON일 때만) =====
    // 로그인/세션
    if(req.method==='POST' && url.pathname==='/api/login'){
      const b=await body(req); const r=await db.login(b.username, b.pass);
      if(!r.ok) return send(res,401,r);
      return send(res,200,{ok:true,role:r.role,store:r.store,username:r.username},
        {'Set-Cookie':'bv_token='+r.token+'; Path=/; Max-Age=86400; SameSite=Lax'});
    }
    if(req.method==='POST' && url.pathname==='/api/logout'){
      await db.logout(getCookie(req,'bv_token'));
      return send(res,200,{ok:true},{'Set-Cookie':'bv_token=; Path=/; Max-Age=0'});
    }
    if(req.method==='GET' && url.pathname==='/api/me'){
      const u=await db.userByToken(getCookie(req,'bv_token'));
      return send(res,200,{ok:true, authOn:AUTH_ON, user:u||null});
    }
    if(AUTH_ON){
      const PUBLIC=['/api/login','/api/logout','/api/me','/api/catalog','/api/bookings','/api/pickups','/api/customer'];
      const isPublic = PUBLIC.some(function(pp){ return url.pathname===pp; });
      // /api/customer (단건) 공개, /api/customers (목록)은 보호
      if(!isPublic){
        const u=await db.userByToken(getCookie(req,'bv_token'));
        if(!u) return send(res,401,{ok:false,error:'로그인이 필요해요'});
        if(u.role==='store'){
          const HQ_ONLY=['/api/sales/range','/api/pb-margin','/api/orders/status','/api/customers/move'];
          if(HQ_ONLY.indexOf(url.pathname)>=0) return send(res,403,{ok:false,error:'본부 전용이에요'});
          const qs=url.searchParams.get('store');
          if(qs && qs!==u.store) return send(res,403,{ok:false,error:'다른 지점 데이터는 볼 수 없어요'});
        }
      }
    }
    // GET /api/bookings?store=&date=  -> 목록
    if(req.method==='GET' && url.pathname==='/api/bookings'){
      const store=url.searchParams.get('store'), date=url.searchParams.get('date');
      const rows=await db.listBookings(store, date);
      return send(res,200,{ok:true, cap:CAP, bookings:rows});
    }
    // POST /api/bookings  {store,date,time,name,phone} -> 생성(정원 체크)
    if(req.method==='POST' && url.pathname==='/api/bookings'){
      const b=await body(req);
      if(!b.store||!b.date||!b.time||!b.name) return send(res,400,{ok:false,error:'필수값 누락'});
      const cnt=await db.countSlot(b.store,b.date,b.time);
      if(cnt>=CAP) return send(res,409,{ok:false,error:'마감(정원 초과)'});
      const row=await db.addBooking(b);
      return send(res,201,{ok:true, booking:row});
    }
    // GET /api/pickups?store=&status= -> 픽업/주문 목록
    if(req.method==='GET' && url.pathname==='/api/pickups'){
      return send(res,200,{ok:true, pickups:await db.listPickups(url.searchParams.get('store'), url.searchParams.get('status'))});
    }
    // POST /api/pickups {store,kind,items,rx,date,time,payType,amount,deposit,name,phone,customerId}
    if(req.method==='POST' && url.pathname==='/api/pickups'){
      const b=await body(req);
      if(!b.store||!b.kind) return send(res,400,{ok:false,error:'필수값 누락'});
      return send(res,201,{ok:true, id:await db.createPickup(b)});
    }
    // POST /api/pickups/status {id,status}
    if(req.method==='POST' && url.pathname==='/api/pickups/status'){
      const b=await body(req); return send(res,200, await db.updatePickup(b.id,b.status));
    }
    // GET /api/customers?store=&seg= -> 고객 목록
    if(req.method==='GET' && url.pathname==='/api/customers'){
      return send(res,200,{ok:true, customers:await db.listCustomers(url.searchParams.get('store'), url.searchParams.get('seg'))});
    }
    // GET /api/customer?id= -> 고객 1명 + 구매이력
    if(req.method==='GET' && url.pathname==='/api/customer'){
      const id=url.searchParams.get('id'); const c=await db.getCustomer(id);
      if(!c) return send(res,404,{ok:false,error:'고객 없음'});
      return send(res,200,{ok:true, customer:c, history:await db.customerHistory(id)});
    }
    // POST /api/customers/move {id,toStore} -> 고객 소속 지점 변경(데이터 귀속 데모)
    if(req.method==='POST' && url.pathname==='/api/customers/move'){
      const b=await body(req); if(!b.id||!b.toStore) return send(res,400,{ok:false,error:'필수값 누락'});
      return send(res,200, await db.moveCustomer(b.id, b.toStore));
    }
    // POST /api/customers {name,phone,store,...} -> 추가
    if(req.method==='POST' && url.pathname==='/api/customers'){
      const b=await body(req); if(!b.name) return send(res,400,{ok:false,error:'이름 필요'});
      return send(res,201,{ok:true, id:await db.addCustomer(b)});
    }
    // GET /api/segcounts?store= -> 마케팅 세그먼트 집계
    if(req.method==='GET' && url.pathname==='/api/segcounts'){
      return send(res,200,{ok:true, counts:await db.segCounts(url.searchParams.get('store'))});
    }
    // GET /api/catalog -> SKU 목록(공통)
    if(req.method==='GET' && url.pathname==='/api/catalog'){
      return send(res,200,{ok:true, stores:db.STORES, catalog:db.CATALOG});
    }
    // GET /api/inventory?store= -> 지점 재고
    if(req.method==='GET' && url.pathname==='/api/inventory'){
      const store=url.searchParams.get('store'); if(!store) return send(res,400,{ok:false,error:'store 필요'});
      return send(res,200,{ok:true, store:store, items:await db.getInventory(store)});
    }
    // POST /api/inventory/restock {store,threshold,add}
    if(req.method==='POST' && url.pathname==='/api/inventory/restock'){
      const b=await body(req); const n=await db.restock(b.store, b.threshold||5, b.add||15);
      return send(res,200,{ok:true, restocked:n});
    }
    // POST /api/sales {store,date,method,lines:[{sku,name,cat,qty,amount,medical}]}
    if(req.method==='POST' && url.pathname==='/api/sales'){
      const b=await body(req);
      if(!b.store||!b.date||!b.lines||!b.lines.length) return send(res,400,{ok:false,error:'필수값 누락'});
      const r=await db.recordSale(b.store, b.date, b.method||'카드', b.lines, b.customerId, b.redeem);
      return send(res, r.ok?201:409, r);
    }
    // GET /api/sales/summary?store=&date= -> {total,byCat}
    if(req.method==='GET' && url.pathname==='/api/sales/summary'){
      const store=url.searchParams.get('store'), date=url.searchParams.get('date');
      return send(res,200,{ok:true, summary:await db.salesSummary(store,date)});
    }
    // GET /api/orders?store=&status= -> 발주 목록
    if(req.method==='GET' && url.pathname==='/api/orders'){
      return send(res,200,{ok:true, orders:await db.listOrders(url.searchParams.get('store'), url.searchParams.get('status'))});
    }
    // GET /api/activity -> 전 지점 실시간 활동 피드
    if(req.method==='GET' && url.pathname==='/api/activity'){
      return send(res,200,{ok:true, feed:await db.activityFeed(16)});
    }
    // GET /api/forecast -> 지점별 수요 예측 + 권장 푸시
    if(req.method==='GET' && url.pathname==='/api/forecast'){
      return send(res,200,{ok:true, stores:await db.forecastAll()});
    }
    // GET /api/analytics?from=&to= -> 본부 분석 리포트
    if(req.method==='GET' && url.pathname==='/api/analytics'){
      const from=url.searchParams.get('from'), to=url.searchParams.get('to');
      return send(res,200,{ok:true, ...(await db.analytics(from,to))});
    }
    // GET /api/price-policy -> 본부 가격 정책 목록
    if(req.method==='GET' && url.pathname==='/api/price-policy'){
      return send(res,200,{ok:true, policy:await db.listPricePolicy()});
    }
    // POST /api/price-policy {sku,list_price,max_disc} -> 본부 정책 수정
    if(req.method==='POST' && url.pathname==='/api/price-policy'){
      if(AUTH_ON){ const u=await db.userByToken(getCookie(req,'bv_token')); if(u && u.role!=='hq') return send(res,403,{ok:false,error:'본부 전용이에요'}); }
      const b=await body(req);
      if(!b.sku) return send(res,400,{ok:false,error:'sku 필요'});
      return send(res,200, await db.setPricePolicy(b.sku, b.list_price, b.max_disc));
    }
    // POST /api/orders/push {store,sku,name,cat,qty,deadline} -> 본부가 가맹점에 발주 푸시
    if(req.method==='POST' && url.pathname==='/api/orders/push'){
      const b=await body(req);
      if(!b.store||!b.sku||!b.qty) return send(res,400,{ok:false,error:'필수값 누락'});
      const id=await db.pushOrder(b.store,b.sku,b.name||b.sku,b.cat||'',b.qty,b.deadline||null);
      return send(res,201,{ok:true, id:id});
    }
    // POST /api/orders/respond {id,accept} -> 가맹점 푸시 응답(승인/거절)
    if(req.method==='POST' && url.pathname==='/api/orders/respond'){
      const b=await body(req); return send(res,200, await db.respondPush(b.id, !!b.accept));
    }
    // POST /api/orders {store,sku,name,cat,qty} -> 발주 생성(대기)
    if(req.method==='POST' && url.pathname==='/api/orders'){
      const b=await body(req);
      if(!b.store||!b.sku||!b.qty) return send(res,400,{ok:false,error:'필수값 누락'});
      return send(res,201,{ok:true, order:await db.createOrder(b.store,b.sku,b.name||b.sku,b.cat||'',b.qty)});
    }
    // POST /api/orders/status {id,status} -> 승인/입고완료 (입고 시 재고 증가)
    if(req.method==='POST' && url.pathname==='/api/orders/status'){
      const b=await body(req); const r=await db.updateOrder(b.id, b.status);
      return send(res, r.ok?200:404, r);
    }
    // GET /api/restock-suggest?store= -> 자동 발주 제안(재고+판매속도)
    if(req.method==='GET' && url.pathname==='/api/restock-suggest'){
      const store=url.searchParams.get('store'); if(!store) return send(res,400,{ok:false,error:'store 필요'});
      return send(res,200,{ok:true, items:await db.restockSuggest(store)});
    }
    // GET /api/lowstock?store=&threshold= -> 발주 추천
    if(req.method==='GET' && url.pathname==='/api/lowstock'){
      return send(res,200,{ok:true, items:await db.lowStock(url.searchParams.get('store'), +(url.searchParams.get('threshold')||5))});
    }
    // POST /api/refund {store,date,method,lines}
    if(req.method==='POST' && url.pathname==='/api/refund'){
      const b=await body(req);
      if(!b.store||!b.date||!b.lines||!b.lines.length) return send(res,400,{ok:false,error:'필수값 누락'});
      const r=await db.refundSale(b.store, b.date, b.method||'카드', b.lines);
      return send(res, r.ok?201:409, r);
    }
    // GET /api/sales/recent?store= -> 최근 결제(환불 대상)
    if(req.method==='GET' && url.pathname==='/api/sales/recent'){
      const store=url.searchParams.get('store');
      return send(res,200,{ok:true, sales:await db.recentSales(store, 20)});
    }
    // GET /api/pb-margin?from=&to= -> 본부 PB 마진 집계
    if(req.method==='GET' && url.pathname==='/api/pb-margin'){
      const r=await db.pbMargin(url.searchParams.get('from'), url.searchParams.get('to'));
      return send(res,200,Object.assign({ok:true}, r));
    }
    // GET /api/settlement?store=&from=&to= -> 정산·세무 리포트
    if(req.method==='GET' && url.pathname==='/api/settlement'){
      const store=url.searchParams.get('store'); if(!store) return send(res,400,{ok:false,error:'store 필요'});
      const r=await db.settlement(store, url.searchParams.get('from'), url.searchParams.get('to'));
      return send(res,200,Object.assign({ok:true},r));
    }
    // GET /api/sales/range?from=&to= -> 기간 전지점/카테고리 집계 (대시보드)
    if(req.method==='GET' && url.pathname==='/api/sales/range'){
      const from=url.searchParams.get('from'), to=url.searchParams.get('to');
      const r=await db.salesRange(from,to);
      return send(res,200,{ok:true, total:r.total, stores:r.stores, byCat:r.byCat});
    }
    // GET /api/sales/daily?store=&from=&to= -> 일별 매출
    if(req.method==='GET' && url.pathname==='/api/sales/daily'){
      const store=url.searchParams.get('store')||null, from=url.searchParams.get('from'), to=url.searchParams.get('to');
      return send(res,200,{ok:true, days:await db.salesDaily(store,from,to)});
    }
    return send(res,404,{ok:false,error:'not found'});
  }catch(e){ console.error(e); return send(res,500,{ok:false,error:'server error'}); }
}

function serveStatic(req,res,url){
  let p=decodeURIComponent(url.pathname); if(p==='/')p='/index.html';
  let fp=path.join(ROOT,p);
  if(!fp.startsWith(ROOT)){res.writeHead(403);return res.end('forbidden');}
  fs.readFile(fp,function(err,data){
    if(err){ fs.readFile(fp+'.html',function(e2,d2){
      if(!e2){res.writeHead(200,{'content-type':TYPES['.html']});return res.end(d2);}
      fs.readFile(path.join(ROOT,'index.html'),function(e3,d3){res.writeHead(e3?404:200,{'content-type':TYPES['.html']});res.end(e3?'Not found':d3);});
    }); return; }
    res.writeHead(200,{'content-type':TYPES[path.extname(fp)]||'application/octet-stream'});
    res.end(data);
  });
}

const server=http.createServer(function(req,res){
  const url=new URL(req.url,'http://x');
  if(url.pathname.startsWith('/api/')) return api(req,res,url);
  serveStatic(req,res,url);
});

db.init().then(function(){
  server.listen(PORT,function(){ console.log('BETTERVISION OS up on '+PORT+(db.ready?' (DB ready)':' (DB OFF — 메모리 폴백)')); });
}).catch(function(e){
  console.error('DB init failed, 정적만 동작:',e.message);
  server.listen(PORT,function(){ console.log('BETTERVISION OS up on '+PORT+' (DB OFF)'); });
});
