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
