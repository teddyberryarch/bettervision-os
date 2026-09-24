/* BETTERVISION OS — 상단 메뉴 · 가맹점 하위 메뉴 · 응대 순서 (2026.09.24)
   메뉴 3묶음: [홈 · 사업 개요] [손님 앱 · 가맹점 · 본사] + 가맹점 아래 [매장 홈 · 접객 · 검안 · 피팅]
   접객 → 검안 → 피팅 순서는 이 브라우저 탭 안에서만 기억한다(sessionStorage). 막히면 "건너뛰고 보기"로 볼 수 있다. */
(function(){
  var page = location.pathname.split('/').pop() || 'index.html';
  var STORE_PAGES = ['store.html','flow.html','exam.html','fit.html'];
  var STEPS = [
    {p:'flow.html', n:'1', t:'접객', done:'접객 마치고 검안으로'},
    {p:'exam.html', n:'2', t:'검안', done:'검안 마치고 피팅으로'},
    {p:'fit.html',  n:'3', t:'피팅', done:'피팅 확인 마치기'}
  ];

  // 1) 상단 메뉴 active
  document.querySelectorAll('.nav-links a').forEach(function(a){
    var h = a.getAttribute('href');
    if(h === page) a.classList.add('active');
    if(a.parentNode.classList.contains('nav-dd') && STORE_PAGES.indexOf(page) >= 0 && a.parentNode.firstElementChild === a) a.classList.add('active');
  });
  var mark = document.querySelector('.brand');
  if(mark && !mark.closest('a')){ mark.style.cursor='pointer'; mark.addEventListener('click', function(){ location.href='index.html'; }); }

  if(STORE_PAGES.indexOf(page) < 0) return;

  // 2) 가맹점 하위 메뉴
  function get(){ try{ return JSON.parse(sessionStorage.getItem('bv_steps')||'{}'); }catch(e){ return {}; } }
  function set(o){ try{ sessionStorage.setItem('bv_steps', JSON.stringify(o)); }catch(e){} }
  var done = get();
  var idx = -1; STEPS.forEach(function(s,i){ if(s.p===page) idx=i; });

  var html = '<div class="subnav-in"><a href="store.html"'+(page==='store.html'?' class="active"':'')+'>매장 홈</a><span class="sn-div"></span>'+
    STEPS.map(function(s){
      var cls = (s.p===page?'active ':'') + (done[s.p.replace('.html','')]?'done':'');
      return '<a href="'+s.p+'" class="'+cls+'"><b>'+s.n+'</b> '+s.t+'</a>';
    }).join('<span class="sn-arrow">›</span>')+
    '<span class="sn-arrow">›</span><span class="sn-wip"><b>4</b> 가공 지시서 · 준비 중</span>'+
    (idx>=0 ? '<button class="sn-done" type="button">'+STEPS[idx].done+'</button>' : '')+
    '</div>';
  var bar = document.createElement('div'); bar.className='subnav'; bar.innerHTML=html;
  var top = document.querySelector('.topbar');
  if(top && top.parentNode) top.parentNode.insertBefore(bar, top.nextSibling);

  // 3) 응대 순서: 앞 단계를 안 마쳤으면 안내
  if(idx > 0){
    var prev = STEPS[idx-1], key = prev.p.replace('.html','');
    if(!done[key]){
      var g = document.createElement('div'); g.className='sn-gate';
      g.innerHTML = '<div class="subnav-in"><span><b>'+prev.t+'을 먼저 마쳐 주세요.</b> 응대는 접객, 검안, 피팅 순서로 해요.</span>'+
        '<span style="display:flex;gap:8px"><a class="btn small" href="'+prev.p+'">'+prev.t+'으로 가기</a><button class="btn small ghost" type="button">건너뛰고 보기</button></span></div>';
      bar.parentNode.insertBefore(g, bar.nextSibling);
      g.querySelector('button').addEventListener('click', function(){ g.remove(); });
    }
  }
  var btn = bar.querySelector('.sn-done');
  if(btn) btn.addEventListener('click', function(){
    var d = idx===0 ? {} : get();            // 접객을 마치면 새 손님으로 본다
    d[STEPS[idx].p.replace('.html','')] = 1; set(d);
    if(idx < STEPS.length-1){ location.href = STEPS[idx+1].p; }
    else { set({}); location.href = 'store.html#care'; }
  });
})();
