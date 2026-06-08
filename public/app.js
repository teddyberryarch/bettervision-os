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

/* ===== 공통 예약 모듈 (서버 API 사용) ===== */
window.BVBooking = (function(){
  var CAP = 2;
  var SLOTS = ['10:00','10:30','11:00','11:30','14:00','14:30','15:00','15:30','16:00','16:30','17:00','17:30','18:00','18:30'];
  var STORES = ['성수점','홍대점','판교점'];
  var cache = {};                          // 'store|date' -> [rows]
  function k(s,d){ return s+'|'+d; }
  function todayISO(){ var d=new Date(); return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,10); }
  function load(store,date){
    return fetch('/api/bookings?store='+encodeURIComponent(store)+'&date='+encodeURIComponent(date))
      .then(function(r){return r.json();})
      .then(function(j){ cache[k(store,date)] = (j&&j.bookings)||[]; return cache[k(store,date)]; })
      .catch(function(){ cache[k(store,date)] = cache[k(store,date)]||[]; return cache[k(store,date)]; });
  }
  function loadAll(date){
    return Promise.all(STORES.map(function(s){return load(s,date);}))
      .then(function(){ var out=[]; STORES.forEach(function(s){out=out.concat(cache[k(s,date)]||[]);}); return out; });
  }
  function rows(store,date){ return cache[k(store,date)]||[]; }
  function count(store,date,time){ return rows(store,date).filter(function(b){return b.time===time;}).length; }
  function left(store,date,time){ return CAP - count(store,date,time); }
  function isFull(store,date,time){ return left(store,date,time) <= 0; }
  function add(b){
    return fetch('/api/bookings',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)})
      .then(function(r){return r.json().then(function(j){return {status:r.status,j:j};});})
      .then(function(o){ if(o.j&&o.j.ok){ return load(b.store,b.date).then(function(){return {ok:true};}); }
        return {ok:false,error:(o.j&&o.j.error)||'예약 실패'}; })
      .catch(function(){ return {ok:false,error:'네트워크 오류'}; });
  }
  return {CAP:CAP, SLOTS:SLOTS, STORES:STORES, load:load, loadAll:loadAll, rows:rows,
          listFor:rows, count:count, left:left, isFull:isFull, add:add, todayISO:todayISO};
})();

/* ===== 온보딩/설명 가이드 ===== */
window.BVGuide = (function(){
  function build(){
    var g = window.__bvGuide;
    if(!g || !g.points || !g.points.length) return;
    var btn = document.createElement('button');
    btn.className = 'bvg-btn'; btn.type='button'; btn.textContent = 'ⓘ 설명';
    var panel = document.createElement('div');
    panel.className = 'bvg-panel';
    panel.innerHTML =
      '<button class="bvg-close" type="button" aria-label="닫기">×</button>'+
      '<div class="bvg-h">'+(g.title||'이 화면 가이드')+'</div>'+
      '<div class="bvg-sub">'+(g.sub||'항목을 누르면 해당 위치로 이동해 강조해요.')+'</div>'+
      g.points.map(function(p,i){
        return '<div class="bvg-item" data-sel="'+(p.sel||'')+'" data-click="'+(p.click||'')+'">'+
          '<div class="bvg-n">'+(i+1)+'</div><div><div class="bvg-t">'+p.t+'</div><div class="bvg-d">'+p.d+'</div></div></div>';
      }).join('');
    document.body.appendChild(btn);
    document.body.appendChild(panel);
    btn.addEventListener('click', function(){ panel.classList.toggle('on'); });
    panel.querySelector('.bvg-close').addEventListener('click', function(){ panel.classList.remove('on'); });
    panel.addEventListener('click', function(e){
      var it = e.target.closest('.bvg-item'); if(!it) return;
      if(it.dataset.click){ var c=document.querySelector(it.dataset.click); if(c) c.click(); }
      var sel = it.dataset.sel;
      setTimeout(function(){
        if(!sel) return; var el=document.querySelector(sel); if(!el) return;
        el.scrollIntoView({behavior:'smooth', block:'center'});
        el.classList.remove('bvg-flash'); void el.offsetWidth; el.classList.add('bvg-flash');
      }, 200);
    });
  }
  if(document.readyState!=='loading') setTimeout(build,0);
  else document.addEventListener('DOMContentLoaded', build);
  return {};
})();
