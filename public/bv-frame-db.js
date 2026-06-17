/* BETTERVISION ② 타사 안경 DB · 큐레이팅 엔진
   각인 파싱 + 소재 휨한계 + 적합도 매칭(9사이즈 환산엔진 호출). */
window.BVFrameDB = (function(){
  var E=window.BVSizeEngine;
  // 소재 → 최대 벌림 조정폭(mm) 〔확인〕 초벌 (engine/매뉴얼과 동기)
  var MAT={titan:{n:'티탄',adj:8},metal:{n:'금속',adj:6},tr:{n:'TR·울템',adj:4},acet:{n:'경질 아세테이트',adj:1}};
  // 프레임 치수 → 등급 경계 〔확인〕 (얼굴 코드와 라벨 정합되게 보정)
  var cfg={ front:{bounds:[122,130],labels:['S','M','L'],range:[108,144]},   // a*2+DBL
            temple:{bounds:[142,148],labels:['S','M','L'],range:[130,158]} }; // 템플 길이

  function parseEngraving(str){ // "54□18-145" / "54-18-145" / "54 18 145"
    var m=String(str||'').match(/(\d{2})\s*[\u25a1\u33d8oO\-\s]\s*(\d{2})\s*[-\s]\s*(\d{3})/);
    if(!m) return null;
    var a=+m[1], dbl=+m[2], temple=+m[3];
    return {a:a, dbl:dbl, temple:temple, frontSpan:a*2+dbl};
  }
  function band(v,ax){var c=cfg[ax];if(v==null)return null;if(v<c.bounds[0])return c.labels[0];if(v<c.bounds[1])return c.labels[1];return c.labels[2];}
  function frameCode(f){return {front:band(f.frontSpan,'front'), temple:band(f.temple,'temple')};}

  function match(face, frame){
    var fc=E.toCode(face);            // 얼굴 코드
    var gc=frameCode(frame);          // 프레임 코드
    var fm=(fc.front===gc.front), tm=(fc.temple===gc.temple);
    var size = (fm&&tm)?96 : ((fm||tm)?82:64);
    var reqAdj=Math.round((face.wrap||0)*0.4*10)/10;   // 안면각 → 필요 벌림 mm
    var matAdj=(MAT[frame.material]||{adj:4}).adj;
    var splayOK = reqAdj<=matAdj;
    var fit = splayOK ? size : Math.max(45, size-18);
    var reason = !splayOK
      ? ('안면각 '+(face.wrap||0)+'° → 필요 벌림 '+reqAdj+'mm > '+MAT[frame.material].n+' 한계 '+matAdj+'mm — 소재상 못 맞춤')
      : ((fm&&tm)?'사이즈·소재 모두 적합' : ((fm?'템플':'프론트')+' 등급 불일치'));
    return {fit:fit, faceCode:fc.front+'·'+fc.temple, frameCode:(gc.front||'?')+'·'+(gc.temple||'?'),
            sizeMatch:size, splayOK:splayOK, reqAdj:reqAdj, matAdj:matAdj, reason:reason};
  }

  // 시드: PB + 타사 견본 (각인·소재)
  var seed=[
    {brand:'BETTERVISION', model:'SAGA-01', color:'매트블랙', eng:'54□18-145', material:'titan', pb:true},
    {brand:'BETTERVISION', model:'SAGA-04', color:'브라운', eng:'52□18-148', material:'metal', pb:true},
    {brand:'젠틀몬스터', model:'MM-001', color:'블랙', eng:'52□20-145', material:'acet'},
    {brand:'톰포드', model:'TF5634', color:'하바나', eng:'54□17-145', material:'acet'},
    {brand:'레이밴', model:'RB5154', color:'블랙', eng:'51□21-140', material:'metal'},
    {brand:'린드버그', model:'Air-T', color:'실버', eng:'48□19-150', material:'titan'}
  ];
  return {MAT, cfg, parseEngraving, frameCode, match, seed};
})();
