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
// [09.24] 클로즈드 베타 동안 로그인 없이 운영 (지근 결정). 실제 손님 데이터를 넣기 전에 Railway에 AUTH_ON=true 추가
const AUTH_ON = process.env.AUTH_ON === 'true';
// 로그인 없이 열리는 페이지 (고객 대면·데모)
const PUBLIC_PAGES = ['/index.html','/login.html','/customer.html','/catalog.html','/lookbook.html','/pricing.html'];
// [09.24] 서비스하지 않는 페이지 — 방향결정 v2.6 이전 내부 문서. 파일은 그대로 두고(삭제 금지) 404로 막음
//  기준 문서는 구글드라이브 01_코어·02_문서세트
function isBlockedPage(p){ return /^\/BETTERVISION_[^/]*\.html$/.test(p) || /^\/BETTERVISION_[^/.]*$/.test(p); }
// 본부 계정만 여는 페이지 (내부 전략·재무)
const HQ_PAGES = ['/hq.html','/a.html','/finance.html','/insights.html','/todo.html','/painmap.html'];
function isSecure(req){ return (req.headers['x-forwarded-proto']||'').split(',')[0].trim()==='https'; }
function tokenCookie(req, token, maxAge){ return 'bv_token='+token+'; Path=/; Max-Age='+maxAge+'; HttpOnly; SameSite=Lax'+(isSecure(req)?'; Secure':''); }
function getCookie(req,name){ var c=req.headers.cookie||''; var m=c.match(new RegExp('(?:^|; )'+name+'=([^;]+)')); return m?decodeURIComponent(m[1]):null; }
// [09.24] 가맹점 계정이면 body.store 를 본인 지점으로 고정 (다른 지점 쓰기 차단)
function body(req){ return new Promise(function(resolve){ let d=''; req.on('data',function(c){d+=c; if(d.length>1e6) req.destroy();}); req.on('end',function(){ var o; try{o=d?JSON.parse(d):{};}catch(e){o={};} if(req.bvUser&&req.bvUser.role==='store'&&o&&typeof o==='object') o.store=req.bvUser.store; resolve(o); }); }); }

async function api(req, res, url){
  try{
    // ===== 인증 게이트 (AUTH_ON일 때만) =====
    // 로그인/세션
    if(req.method==='POST' && url.pathname==='/api/login'){
      const b=await body(req); const r=await db.login(b.username, b.pass);
      if(!r.ok) return send(res,401,r);
      return send(res,200,{ok:true,role:r.role,store:r.store,username:r.username},
        {'Set-Cookie':tokenCookie(req,r.token,86400)});
    }
    if(req.method==='POST' && url.pathname==='/api/logout'){
      await db.logout(getCookie(req,'bv_token'));
      return send(res,200,{ok:true},{'Set-Cookie':tokenCookie(req,'',0)});
    }
    if(req.method==='GET' && url.pathname==='/api/me'){
      const u=await db.userByToken(getCookie(req,'bv_token'));
      return send(res,200,{ok:true, authOn:AUTH_ON, user:u||null});
    }
    if(AUTH_ON){
      // [09.24] 공개는 "고객이 로그인 없이 하는 행동"만. 개인정보를 돌려주는 조회는 전부 로그인 필요
      //  - GET  /api/catalog            상품 목록
      //  - GET  /api/bookings           → 로그인 없으면 시간대별 인원수만 (이름·전화 없음)
      //  - POST /api/bookings, /api/pickups  고객 예약·주문 접수
      //  /api/customer(단건)는 공개 예외에서 제외
      const PUBLIC_ANY=['/api/catalog'];
      //  - 고객 앱: 7일째 착용 확인 응답(본인 건만), 자가측정 결과 제출(항상 임시값으로 저장)
      const PUBLIC_GET=['/api/bookings','/api/aftercare/mine'];
      const PUBLIC_POST=['/api/bookings','/api/pickups','/api/aftercare/respond'];
      const isPublic = PUBLIC_ANY.indexOf(url.pathname)>=0
        || (req.method==='POST' && /^\/api\/measure\/sessions\/[^/]+\/result$/.test(url.pathname))
        || (req.method==='GET' && PUBLIC_GET.indexOf(url.pathname)>=0)
        || (req.method==='POST' && PUBLIC_POST.indexOf(url.pathname)>=0);
      const u=await db.userByToken(getCookie(req,'bv_token'));
      req.bvUser=u||null;
      if(!isPublic){
        if(!u) return send(res,401,{ok:false,error:'로그인이 필요해요'});
        if(u.role==='store'){
          const HQ_ONLY=['/api/sales/range','/api/pb-margin','/api/orders/status','/api/customers/move',
            '/api/analytics','/api/forecast','/api/activity','/api/orders/push','/api/price-policy'];
          const HQ_ONLY_GET_OK=['/api/price-policy']; // 권장가 조회는 가맹점도 가능, 수정은 본부만
          if(HQ_ONLY.indexOf(url.pathname)>=0 && !(req.method==='GET' && HQ_ONLY_GET_OK.indexOf(url.pathname)>=0))
            return send(res,403,{ok:false,error:'본사 전용이에요'});
          const qs=url.searchParams.get('store');
          if(qs && qs!==u.store) return send(res,403,{ok:false,error:'다른 지점 데이터는 볼 수 없어요'});
          // store 파라미터를 빼고 호출하면 전 지점이 나오던 문제 → 본인 지점으로 고정
          url.searchParams.set('store', u.store);
        }
      }
    }
    // GET /api/bookings?store=&date=  -> 목록
    if(req.method==='GET' && url.pathname==='/api/bookings'){
      const store=url.searchParams.get('store'), date=url.searchParams.get('date');
      const rows=await db.listBookings(store, date);
      // [09.24] 로그인 안 한 요청(고객 앱)에는 시간대별 인원수만. 이름·전화번호 안 내보냄
      if(AUTH_ON && !req.bvUser){
        const slots={}; rows.forEach(function(r){ var k=r.date+' '+r.time; slots[k]=(slots[k]||0)+1; });
        return send(res,200,{ok:true, cap:CAP, slots:slots});
      }
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
    // [09.24] GET /api/customers/:id/vision -> 시력 기록, 가족, 다음 검사일
    { const m=url.pathname.match(/^\/api\/customers\/(\d+)\/vision$/);
      if(req.method==='GET' && m) return send(res,200,Object.assign({ok:true}, await db.visionFor(+m[1]))); }
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
      if(req.bvUser && req.bvUser.role==='store' && c.store!==req.bvUser.store) return send(res,403,{ok:false,error:'다른 지점 고객이에요'});
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
      const r=await db.recordSale(b.store, b.date, b.method||'카드', b.lines, b.customerId, b.redeem, b.fit);
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
      if(AUTH_ON){ const u=await db.userByToken(getCookie(req,'bv_token')); if(u && u.role!=='hq') return send(res,403,{ok:false,error:'본사 전용이에요'}); }
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

    // ===== [09.24] 판 다음 확인 (7일째 착용 확인) =====
    const U=req.bvUser; const scopeOK=function(st){ return !U || U.role!=='store' || st===U.store; };
    if(req.method==='GET' && url.pathname==='/api/aftercare'){
      return send(res,200,{ok:true, items:await db.listAftercare(url.searchParams.get('store'), url.searchParams.get('status')), issues:db.CARE_ISSUES, questions:db.CARE_QUESTIONS, judges:db.CARE_JUDGE});
    }
    if(req.method==='POST' && url.pathname==='/api/aftercare/judge'){
      const b=await body(req); const cur=await db.getAftercare(b.id);
      if(!cur) return send(res,404,{ok:false,error:'확인 건이 없어요'});
      if(!scopeOK(cur.store)) return send(res,403,{ok:false,error:'다른 지점 건이에요'});
      const r=await db.judgeAftercare(b.id, b.judge); return send(res, r.ok?200:400, r);
    }
    if(req.method==='POST' && url.pathname==='/api/aftercare/record'){
      const b=await body(req); const cur=await db.getAftercare(b.id);
      if(!cur) return send(res,404,{ok:false,error:'확인 건이 없어요'});
      if(!scopeOK(cur.store)) return send(res,403,{ok:false,error:'다른 지점 건이에요'});
      const r=await db.recordAftercare(b.id, Object.assign({},b,{source:'매장 전화'})); return send(res, r.ok?200:400, r);
    }
    if(req.method==='GET' && url.pathname==='/api/aftercare/mine'){
      const cid=url.searchParams.get('customer_id'); if(!cid) return send(res,400,{ok:false,error:'customer_id 필요'});
      return send(res,200,{ok:true, items:await db.pendingAftercareFor(cid), issues:db.CARE_ISSUES, questions:db.CARE_QUESTIONS});
    }
    if(req.method==='POST' && url.pathname==='/api/aftercare/respond'){
      const b=await body(req); const cur=await db.getAftercare(b.id);
      if(!cur || +cur.customer_id!==+b.customer_id) return send(res,404,{ok:false,error:'확인 건이 없어요'});
      const r=await db.recordAftercare(b.id,{comfort:b.comfort,issues:b.issues,note:b.note,source:'손님 앱',onlyPending:true});
      return send(res, r.ok?200:400, {ok:r.ok, error:r.error, comfort:r.comfort});
    }
    // ===== [09.24] A/S — 원인(검안·가공·피팅·추천)을 골라야 종결 =====
    if(req.method==='GET' && url.pathname==='/api/as'){
      return send(res,200,{ok:true, items:await db.listAS(url.searchParams.get('store'), url.searchParams.get('status')), causes:db.AS_CAUSES});
    }
    if(req.method==='POST' && url.pathname==='/api/as'){
      const b=await body(req); if(!b.store) return send(res,400,{ok:false,error:'store 필요'});
      const r=await db.openAS(b); return send(res, r.ok?201:400, r);
    }
    if(req.method==='POST' && url.pathname==='/api/as/close'){
      const b=await body(req); const cur=await db.getAS(b.id);
      if(!cur) return send(res,404,{ok:false,error:'A/S 건이 없어요'});
      if(!scopeOK(cur.store)) return send(res,403,{ok:false,error:'다른 지점 건이에요'});
      const r=await db.closeAS(b.id, b.cause, b.action); return send(res, r.ok?200:400, r);
    }
    // ===== [09.24] 기준 보정 · 기준 관리 (본사) =====
    if(req.method==='GET' && url.pathname==='/api/calibration'){ return send(res,200,Object.assign({ok:true}, await db.calibration())); }
    if(req.method==='GET' && url.pathname==='/api/standards'){ return send(res,200,Object.assign({ok:true}, await db.listStandards())); }
    if(req.method==='POST' && url.pathname==='/api/standards/deploy'){
      if(U && U.role!=='hq') return send(res,403,{ok:false,error:'본사만 배포할 수 있어요'});
      const b=await body(req); const r=await db.deployStandard(b.kind); return send(res, r.ok?200:400, r);
    }
    if(req.method==='GET' && url.pathname==='/api/care/summary'){
      return send(res,200,Object.assign({ok:true}, await db.careSummary(url.searchParams.get('store'))));
    }
    // ===== [09.24] 측정 (설계서 v0.3 §4) =====
    if(req.method==='POST' && url.pathname==='/api/measure/sessions'){
      const b=await body(req); if(!b.customer_id) return send(res,400,{ok:false,error:'customer_id 필요'});
      const c=await db.getCustomer(b.customer_id); if(!c) return send(res,404,{ok:false,error:'고객 없음'});
      if(!scopeOK(c.store)) return send(res,403,{ok:false,error:'다른 지점 고객이에요'});
      b.operator=U?U.username:null; if(!b.store) b.store=c.store;
      return send(res,201,{ok:true, session:await db.createMeasureSession(b)});
    }
    let mm;
    if(req.method==='GET' && (mm=url.pathname.match(/^\/api\/measure\/sessions\/(\d+)$/))){
      const ss=await db.getMeasureSession(mm[1]); if(!ss) return send(res,404,{ok:false,error:'세션이 없어요'});
      if(!scopeOK(ss.store)) return send(res,403,{ok:false,error:'다른 지점 세션이에요'});
      return send(res,200,{ok:true, session:ss});
    }
    if(req.method==='POST' && (mm=url.pathname.match(/^\/api\/measure\/sessions\/([^/]+)\/result$/))){
      const b=await body(req);
      if(U && U.role==='store'){
        const ss=mm[1]!=='adhoc'?await db.getMeasureSession(mm[1]):null;
        const c=await db.getCustomer(ss?ss.customer_id:b.customer_id);
        if(!c || !scopeOK(c.store)) return send(res,403,{ok:false,error:'다른 지점 고객이에요'});
      }
      if(AUTH_ON && !U){ // 로그인 안 한 자가측정: 고객 존재만 확인, 결과는 임시값
        if(!/^\d+$/.test(String(b.customer_id||''))) return send(res,400,{ok:false,error:'customer_id 필요'});
        const c=await db.getCustomer(b.customer_id); if(!c) return send(res,404,{ok:false,error:'고객 없음'});
      }
      const r=await db.saveMeasurement(mm[1], b, AUTH_ON?U:(U||{username:'(인증 꺼짐)'}));
      return send(res, r.ok?201:400, r);
    }
    if(req.method==='GET' && (mm=url.pathname.match(/^\/api\/customers\/(\d+)\/measurements$/))){
      const c=await db.getCustomer(mm[1]); if(!c) return send(res,404,{ok:false,error:'고객 없음'});
      if(!scopeOK(c.store)) return send(res,403,{ok:false,error:'다른 지점 고객이에요'});
      await db.logMeasureAccess(U?U.username:null, +mm[1], 'read');
      return send(res,200,{ok:true, items:await db.listMeasurements(mm[1])});
    }
    return send(res,404,{ok:false,error:'not found'});
  }catch(e){ console.error(e); return send(res,500,{ok:false,error:'server error'}); }
}

// [09.24] 페이지 접근 제한 — 화면 안의 로그인 체크는 HTML이 이미 내려간 뒤라 우회 가능. 서버에서 막는다
async function pageGate(req,res,p){
  if(!AUTH_ON) return true;
  var page=p.endsWith('.html')?p:(path.extname(p)?null:p+'.html');
  if(!page || PUBLIC_PAGES.indexOf(page)>=0) return true;   // css·js·이미지, 공개 페이지
  const u=await db.userByToken(getCookie(req,'bv_token'));
  var need = HQ_PAGES.indexOf(page)>=0 ? 'hq' : 'any';
  if(u && (need==='any' || u.role==='hq')) return true;
  if(u){ res.writeHead(403,{'content-type':TYPES['.html']}); res.end('본사 계정만 볼 수 있는 페이지예요. <a href="/index.html">처음으로</a>'); return false; }
  res.writeHead(302,{location:'/login.html?next='+encodeURIComponent(page.slice(1))}); res.end(); return false;
}

async function serveStatic(req,res,url){
  let p; try{ p=decodeURIComponent(url.pathname); }catch(e){ res.writeHead(400); return res.end('bad request'); }
  if(p==='/')p='/index.html';
  if(isBlockedPage(p)){ res.writeHead(404,{'content-type':TYPES['.html']}); return res.end('Not found'); }
  if(!(await pageGate(req,res,p))) return;
  let fp=path.join(ROOT,p);
  if(!fp.startsWith(ROOT)){res.writeHead(403);return res.end('forbidden');}
  fs.readFile(fp,function(err,data){
    if(err){ fs.readFile(fp+'.html',function(e2,d2){
      if(!e2){res.writeHead(200,{'content-type':TYPES['.html']});return res.end(d2);}
      // [09.24] 없는 페이지는 홈 대신 404 (깨진 링크가 홈으로 보여서 안 보이던 문제)
      res.writeHead(404,{'content-type':TYPES['.html']}); res.end('<!doctype html><meta charset="utf-8"><title>없는 페이지</title><body style="font-family:Pretendard,sans-serif;background:#F7F6F3;color:#1C1C1A;padding:48px;font-size:17px">없는 페이지예요. <a href="/index.html" style="color:#9A7B4F">처음으로</a></body>');
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
