/* BETTERVISION 9사이즈 환산엔진 — 본사 핵심 IP (단일 진실 공급원)
   측정 raw(mm) → S/M/L 등급 → 9코드 + 적합도%.
   경계값(bounds)·모집단 분포(pop)가 전부 변수 = 언제든 튜닝/자기교정. */
window.BVSizeEngine = (function(){

  // ── 설정(IP): 〔확인〕 초벌값. engine.html에서 튜닝 → 여기로 반영 ──
  var config = {
    front: {  // 프론트 폭 = 얼굴 가로폭 기반
      key:'faceWidth', name:'프론트 폭(얼굴 가로)',
      bounds:[146,158], labels:['S','M','L'], range:[130,172]
    },
    temple: { // 템플 = 귀 윗부분 간격 기반
      key:'earGap', name:'템플(귀 윗부분 간격)',
      bounds:[156,168], labels:['S','M','L'], range:[140,182]
    },
    // 모집단 분포(사이즈코리아 초벌 — 〔확인〕). M·M이 최빈이 되도록 경계 설계
    pop: { faceWidth:{mean:152, sd:7.5}, earGap:{mean:162, sd:7} } /* 사이즈코리아: 얼굴가로 남157/여147→152, 머리너비 남168/여159→162 */
  };

  function erf(x){var s=x<0?-1:1;x=Math.abs(x);var t=1/(1+0.3275911*x);
    var y=1-(((((1.061405429*t-1.453152027)*t)+1.421413741)*t-0.284496736)*t+0.254829592)*t*Math.exp(-x*x);return s*y;}
  function cdf(x,m,sd){return 0.5*(1+erf((x-m)/(sd*Math.SQRT2)));}

  function band(v, ax){ // ax='front'|'temple'
    var c=config[ax]; if(v==null||isNaN(v)) return null;
    if(v<c.bounds[0]) return c.labels[0];
    if(v<c.bounds[1]) return c.labels[1];
    return c.labels[2];
  }
  function bandRange(ax, label){ // 등급의 [lo,hi]
    var c=config[ax];
    if(label===c.labels[0]) return [c.range[0], c.bounds[0]];
    if(label===c.labels[1]) return [c.bounds[0], c.bounds[1]];
    return [c.bounds[1], c.range[1]];
  }
  function axisFit(v, ax){ // 등급 안에서 얼마나 중앙인가 → 80~98
    var lb=band(v,ax); if(lb==null) return 0;
    var r=bandRange(ax,lb), c=(r[0]+r[1])/2, half=(r[1]-r[0])/2;
    var central = half>0 ? Math.max(0,1-Math.abs(v-c)/half) : 1;
    return Math.round(80+18*central);
  }
  function toCode(m){ // m={faceWidth, earGap}
    var f=band(m.faceWidth,'front'), t=band(m.earGap,'temple');
    if(f==null||t==null) return {front:f,temple:t,code:null,fit:0};
    return {front:f, temple:t, code:f+'·'+t,
      fit: Math.round((axisFit(m.faceWidth,'front')+axisFit(m.earGap,'temple'))/2),
      fitFront: axisFit(m.faceWidth,'front'), fitTemple: axisFit(m.earGap,'temple')};
  }

  function axisDist(ax){ // 모집단의 [pS,pM,pL] %
    var c=config[ax], p=config.pop[c.key];
    var a=cdf(c.bounds[0],p.mean,p.sd), b=cdf(c.bounds[1],p.mean,p.sd);
    return [a, b-a, 1-b];
  }
  function cellDist(){ // 9칸 % (front행 × temple열)
    var fr=axisDist('front'), te=axisDist('temple'), out=[];
    for(var i=0;i<3;i++){var row=[];for(var j=0;j<3;j++){row.push(fr[i]*te[j]);}out.push(row);}
    return out; // [[SS,SM,SL],[MS,MM,ML],[LS,LM,LL]]
  }
  function setBound(ax,i,v){ config[ax].bounds[i]=parseFloat(v); }
  function setPop(key,field,v){ config.pop[key][field]=parseFloat(v); }

  return {config, band, bandRange, axisFit, toCode, axisDist, cellDist, setBound, setPop, cdf};
})();
