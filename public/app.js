// 공통 헬퍼 — 페이지가 늘어나도 여기만 관리
(function(){
  // 현재 페이지에 맞춰 상단 네비 active 표시
  var path = location.pathname.split('/').pop() || 'index.html';
  document.querySelectorAll('.nav-links a').forEach(function(a){
    if(a.getAttribute('href') === path) a.classList.add('active');
  });
})();
function toast(msg){
  var t=document.getElementById('toast');
  if(!t){t=document.createElement('div');t.id='toast';t.style.cssText='position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:#111;color:#fff;padding:12px 18px;border-radius:10px;font-size:14px;z-index:99;opacity:0;transition:.2s';document.body.appendChild(t);}
  t.textContent=msg;t.style.opacity='1';clearTimeout(window.__tt);window.__tt=setTimeout(function(){t.style.opacity='0';},2000);
}

/* ===== 공통 예약 모듈 (화면 내 저장 — 새로고침 시 리셋. 나중에 서버로 교체) =====
   window.BVBooking: 매장×날짜×시간 슬롯 정원(2명/30분) 관리 + 예약 목록 */
window.BVBooking = (function(){
  var CAP = 2;                       // 30분당 정원
  var SLOTS = ['10:00','10:30','11:00','11:30','14:00','14:30','15:00','15:30','16:00','16:30','17:00','17:30','18:00','18:30'];
  var STORES = ['성수점','홍대점','판교점'];
  var bookings = [];                 // {store,date,time,name,phone,ts}
  function key(s,d,t){ return s+'|'+d+'|'+t; }
  function count(s,d,t){ return bookings.filter(function(b){return b.store===s&&b.date===d&&b.time===t;}).length; }
  function left(s,d,t){ return CAP - count(s,d,t); }
  function isFull(s,d,t){ return left(s,d,t) <= 0; }
  function add(b){ if(isFull(b.store,b.date,b.time)) return false; b.ts=Date.now(); bookings.push(b); return true; }
  function listFor(s,d){ return bookings.filter(function(b){return b.store===s&&(!d||b.date===d);}).sort(function(a,b){return a.time<b.time?-1:1;}); }
  function all(){ return bookings.slice(); }
  function todayISO(){ var d=new Date(); return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,10); }
  return {CAP:CAP, SLOTS:SLOTS, STORES:STORES, count:count, left:left, isFull:isFull, add:add, listFor:listFor, all:all, todayISO:todayISO};
})();
