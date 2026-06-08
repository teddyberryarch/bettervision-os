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
