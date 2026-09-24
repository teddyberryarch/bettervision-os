/* BETTERVISION OS — 상단 메뉴 · 가맹점 하위 메뉴 · 응대 순서 (2026.09.24)
   메뉴 3묶음: [홈 · 사업 개요] [손님 앱 · 가맹점 · 본사] + 가맹점 아래 [매장 홈 · 접객 · 검안 · 피팅]
   접객 → 검안 → 피팅 순서는 이 브라우저 탭 안에서만 기억한다(sessionStorage). 막히면 "건너뛰고 보기"로 볼 수 있다. */
(function(){
  var page = location.pathname.split('/').pop() || 'index.html';
  var STORE_PAGES = ['store.html','flow.html','exam.html','workorder.html','fit.html','quote.html'];
  var STEPS = [
    {p:'flow.html', n:'1', t:'접객', done:'접객 마치고 검안으로'},
    {p:'exam.html', n:'2', t:'검안', done:'검안 마치고 테 판정으로'},
    {p:'workorder.html', n:'3', t:'테 판정 · 가공', done:'가공 마치고 피팅으로'},
    {p:'fit.html',  n:'4', t:'피팅', done:'피팅 확인 마치기'}
  ];

  // 1) 상단 메뉴 active
  document.querySelectorAll('.nav-links a').forEach(function(a){
    var h = a.getAttribute('href');
    if(h === page) a.classList.add('active');
    if(a.parentNode.classList.contains('nav-dd') && STORE_PAGES.indexOf(page) >= 0 && a.parentNode.firstElementChild === a) a.classList.add('active');
  });
  var mark = document.querySelector('.brand');
  if(mark && !mark.closest('a')){ mark.style.cursor='pointer'; mark.addEventListener('click', function(){ location.href='index.html'; }); }

  // 0) 용어 설명: 오른쪽 아래 "용어" 버튼을 누르면 뜨는 작은 창
  var TERMS=[
    ['프론트','안경 앞부분. 렌즈를 끼우는 테예요. 9사이즈의 F(F1·F2·F3)가 프론트 폭이에요.'],
    ['템플','안경다리. 귀에 걸리는 부분이에요. 9사이즈의 T(T1·T2·T3)가 템플 길이예요.'],
    ['브리지','코 위에서 두 렌즈를 잇는 부분이에요.'],
    ['코받침','코에 닿는 받침(노즈패드)이에요. 조절형과 일체형이 있어요.'],
    ['벌림각','템플이 바깥으로 벌어진 각도예요. 얼굴 폭에 맞춰 휘어요.'],
    ['PD','두 눈동자 사이 거리예요. 한쪽씩 잰 값이 단안 PD예요.'],
    ['OH','동공 높이. 렌즈 아래 끝에서 눈동자까지 높이예요.'],
    ['판토(경사각)','렌즈가 앞으로 기울어진 각도예요. 보통 8~12°예요.'],
    ['정점거리(VD)','눈과 렌즈 뒷면 사이 거리예요. 보통 12mm 안팎이에요.'],
    ['광학중심(OC)','렌즈에서 초점이 맞는 중심점이에요. 눈동자 앞에 와야 해요.'],
    ['편심','렌즈 중심을 테 중심에서 옮기는 양이에요. PD에 맞추려고 해요.'],
    ['블랭크','깎기 전 동그란 렌즈 원판이에요. 지름이 작으면 가공할 수 없어요.'],
    ['평균 도수(SE)','구면 도수에 난시 도수의 절반을 더한 값이에요. 시력 변화를 볼 때 써요.'],
    ['9사이즈','프론트 폭 3단계(F1~F3) × 템플 길이 3단계(T1~T3)로 나눈 PB 사이즈예요.']
  ];
  (function(){
    var b=document.createElement('button'); b.type='button'; b.className='bv-gloss-btn'; b.textContent='용어'; b.setAttribute('aria-label','용어 설명 열기');
    var d=document.createElement('div'); d.className='bv-gloss'; d.hidden=true;
    d.innerHTML='<div class="bv-gloss-h"><b>용어 설명</b><button type="button" aria-label="닫기">닫기</button></div>'+TERMS.map(function(t){return '<div class="bv-gloss-r"><b>'+t[0]+'</b><span>'+t[1]+'</span></div>';}).join('');
    b.addEventListener('click',function(){ d.hidden=!d.hidden; });
    d.querySelector('button').addEventListener('click',function(){ d.hidden=true; });
    document.body.appendChild(b); document.body.appendChild(d);
  })();

  if(STORE_PAGES.indexOf(page) < 0) return;

  // [09.24] D-12 막지 않고 기록: 넘어가려면 사유 하나 선택 → 본사 기준 보정에 집계
  var REASONS={
    step_skip:['손님이 급함','다른 기기에서 이미 함','다시 온 손님','안경사 판단','기타'],
    fit_below:['손님이 급함','손님이 이 테를 원함','안경사 판단','기타']
  };
  function askReason(anchor, kind, step, detail, title, onOk){
    var old=document.querySelector('.bv-ovr'); if(old) old.remove();
    var box=document.createElement('div'); box.className='bv-ovr';
    box.innerHTML='<div class="subnav-in" style="flex-direction:column;align-items:stretch;gap:8px">'+
      '<div><b>'+title+'</b>'+(detail?' <span style="color:var(--muted)">· '+detail+'</span>':'')+'</div>'+
      '<div class="bv-ovr-r">'+REASONS[kind].map(function(r){return '<button type="button" class="chip" data-r="'+r+'">'+r+'</button>';}).join('')+'</div>'+
      '<input class="bv-ovr-m" placeholder="메모 (선택)" maxlength="200">'+
      '<div style="display:flex;gap:8px;align-items:center"><button type="button" class="btn small bv-ovr-ok" disabled>사유 남기고 넘어가기</button><button type="button" class="btn small ghost bv-ovr-x">취소</button>'+
      '<span style="font-size:15px;color:var(--muted)">막지 않음. 사유는 본사 기준 보정에 쌓임</span></div></div>';
    anchor.parentNode.insertBefore(box, anchor.nextSibling);
    var pick=null, ok=box.querySelector('.bv-ovr-ok');
    box.querySelectorAll('[data-r]').forEach(function(b){ b.addEventListener('click',function(){
      box.querySelectorAll('[data-r]').forEach(function(x){x.classList.remove('active');}); b.classList.add('active'); pick=b.getAttribute('data-r'); ok.disabled=false; }); });
    box.querySelector('.bv-ovr-x').addEventListener('click',function(){ box.remove(); });
    ok.addEventListener('click',function(){
      var rec=null; try{ rec=JSON.parse(sessionStorage.getItem('bv_active_record')||'null'); }catch(e){}
      var body={kind:kind, step:step, reason:pick, detail:[detail,box.querySelector('.bv-ovr-m').value].filter(Boolean).join(' · '), customer_id:rec&&rec.customerId};
      ok.disabled=true;
      fetch('/api/overrides',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
        .catch(function(){}).then(function(){ box.remove(); onOk(); });
    });
  }
  window.BVOverride={ask:askReason, reasons:REASONS};

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
      g.innerHTML = '<div class="subnav-in"><span><b>'+prev.t+' 먼저.</b> 응대 순서: 접객 → 검안 → 테 판정·가공 → 피팅</span>'+
        '<span style="display:flex;gap:8px"><a class="btn small" href="'+prev.p+'">'+prev.t+'으로 가기</a><button class="btn small ghost" type="button">건너뛰고 보기</button></span></div>';
      bar.parentNode.insertBefore(g, bar.nextSibling);
      g.querySelector('button').addEventListener('click', function(){ askReason(g, 'step_skip', prev.t+' 건너뜀 → '+STEPS[idx].t, '', prev.t+' 건너뛰는 사유', function(){ g.remove(); }); });
    }
  }
  var btn = bar.querySelector('.sn-done');
  function finishStep(){
    var d = idx===0 ? {} : get();            // 접객을 마치면 새 손님으로 본다
    d[STEPS[idx].p.replace('.html','')] = 1; set(d);
    if(idx < STEPS.length-1){ location.href = STEPS[idx+1].p; }
    else { set({}); location.href = 'store.html#care'; }
  }
  // 페이지가 window.BV_STEP_CHECK()로 기준 미달을 알려 주면 사유를 받고 넘어간다 (예: 피팅)
  if(btn) btn.addEventListener('click', function(){
    var issue = (typeof window.BV_STEP_CHECK==='function') ? window.BV_STEP_CHECK() : null;
    if(issue) askReason(bar, 'fit_below', STEPS[idx].t, issue, '기준 미달로 넘어가는 사유', finishStep);
    else finishStep();
  });
})();
