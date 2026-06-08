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

function send(res, code, obj){ res.writeHead(code, {'content-type':'application/json; charset=utf-8'}); res.end(JSON.stringify(obj)); }
function body(req){ return new Promise(function(resolve){ let d=''; req.on('data',function(c){d+=c;}); req.on('end',function(){ try{resolve(d?JSON.parse(d):{});}catch(e){resolve({});} }); }); }

async function api(req, res, url){
  try{
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
      const r=await db.recordSale(b.store, b.date, b.method||'카드', b.lines, b.customerId);
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
