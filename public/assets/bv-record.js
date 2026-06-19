/* BETTERVISION 측정 레코드 공유 — 측정 1번 → 전 단계 자동.
   sessionStorage 기반(한 손님 접객 세션). 운영 단계에선 서버 레코드로 승격. */
window.BVRecord = (function(){
  var KEY='bv_active_record';
  function load(){ try{var r=sessionStorage.getItem(KEY);return r?JSON.parse(r):null;}catch(e){return null;} }
  function save(patch){ var cur=load()||{}; for(var k in patch) cur[k]=patch[k]; cur._ts=Date.now();
    try{ sessionStorage.setItem(KEY, JSON.stringify(cur)); }catch(e){} return cur; }
  function clear(){ try{ sessionStorage.removeItem(KEY); }catch(e){} }
  function banner(rec, stage){
    if(!rec) return '';
    var nm=rec.name||'측정 손님';
    return '<div style="display:flex;align-items:center;gap:10px;background:var(--good-soft);border:1px solid var(--good);border-radius:10px;padding:9px 13px;margin:8px 0;font-size:13px;color:var(--good);font-weight:600">'+
      '<span>📥 측정값 자동 적용 — 손님 '+nm+(stage?' · '+stage:'')+'</span>'+
      '<button onclick="BVRecord.clear();location.reload();" style="margin-left:auto;font-size:12px;border:1px solid var(--good);background:#fff;color:var(--good);border-radius:6px;padding:4px 8px;cursor:pointer">측정 비우기</button>'+
      '</div>';
  }
  return {load:load, save:save, clear:clear, banner:banner};
})();
