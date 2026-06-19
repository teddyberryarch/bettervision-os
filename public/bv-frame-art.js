/* BETTERVISION Frame Art — 안경테 정면 라인아트 생성기
   frameSVG(spec) → SVG 문자열. shape별 렌즈 path + 브리지 + 엔드피스 + 템플 + (브로우).
   premium minimal: 얇은 선, 무채/저채도. metal=얇은 림, acetate=두꺼운 림. */
(function(root){
  // 렌즈 path (로컬 중심 0,0, 폭 lw·높이 lh)
  function lensPath(shape, lw, lh){
    var hw=lw/2, hh=lh/2, k=0.55; // bezier 원형계수
    function E(){ // 타원형(라운드/오벌)
      return 'M '+(-hw)+' 0 '
        +'C '+(-hw)+' '+(-hh*k)+' '+(-hw*k)+' '+(-hh)+' 0 '+(-hh)+' '
        +'C '+(hw*k)+' '+(-hh)+' '+hw+' '+(-hh*k)+' '+hw+' 0 '
        +'C '+hw+' '+(hh*k)+' '+(hw*k)+' '+hh+' 0 '+hh+' '
        +'C '+(-hw*k)+' '+hh+' '+(-hw)+' '+(hh*k)+' '+(-hw)+' 0 Z';
    }
    function RR(r){ // 라운드 사각
      r=r||Math.min(hw,hh)*0.42;
      return 'M '+(-hw+r)+' '+(-hh)+' L '+(hw-r)+' '+(-hh)
        +' Q '+hw+' '+(-hh)+' '+hw+' '+(-hh+r)+' L '+hw+' '+(hh-r)
        +' Q '+hw+' '+hh+' '+(hw-r)+' '+hh+' L '+(-hw+r)+' '+hh
        +' Q '+(-hw)+' '+hh+' '+(-hw)+' '+(hh-r)+' L '+(-hw)+' '+(-hh+r)
        +' Q '+(-hw)+' '+(-hh)+' '+(-hw+r)+' '+(-hh)+' Z';
    }
    if(shape==='round') { var r0=Math.min(hw,hh); return 'M '+(-r0)+' 0 C '+(-r0)+' '+(-r0*k)+' '+(-r0*k)+' '+(-r0)+' 0 '+(-r0)+' C '+(r0*k)+' '+(-r0)+' '+r0+' '+(-r0*k)+' '+r0+' 0 C '+r0+' '+(r0*k)+' '+(r0*k)+' '+r0+' 0 '+r0+' C '+(-r0*k)+' '+r0+' '+(-r0)+' '+(r0*k)+' '+(-r0)+' 0 Z'; }
    if(shape==='oval')  return E();
    if(shape==='square') return RR();
    if(shape==='panto'){ // 보스턴/판토 — 윗변 평평·넓게, 하단 둥글게 좁아짐
      return 'M '+(-hw)+' '+(-hh*0.35)+' '
        +'C '+(-hw)+' '+(-hh*0.92)+' '+(-hw*0.5)+' '+(-hh)+' 0 '+(-hh)+' '
        +'C '+(hw*0.5)+' '+(-hh)+' '+hw+' '+(-hh*0.92)+' '+hw+' '+(-hh*0.35)+' '
        +'C '+hw+' '+(hh*0.5)+' '+(hw*0.52)+' '+hh+' 0 '+hh+' '
        +'C '+(-hw*0.52)+' '+hh+' '+(-hw)+' '+(hh*0.5)+' '+(-hw)+' '+(-hh*0.35)+' Z';
    }
    if(shape==='cateye'){ // 캣아이 — 외측(좌) 상단 뾰족·치켜올림. 우측렌즈는 frameSVG에서 반전.
      return 'M '+(-hw)+' '+(-hh*1.18)+' ' // 외측 상단 뾰족점(높이 위로)
        +'C '+(-hw*0.3)+' '+(-hh*0.96)+' '+(hw*0.5)+' '+(-hh*0.82)+' '+hw+' '+(-hh*0.42)+' ' // 윗변→내측상단(낮음)
        +'C '+(hw*1.04)+' '+(-hh*0.18)+' '+(hw*0.98)+' '+(hh*0.5)+' '+(hw*0.6)+' '+(hh*0.85)+' ' // 내측 하단 둥글
        +'C '+(hw*0.1)+' '+(hh*1.04)+' '+(-hw*0.55)+' '+(hh*0.95)+' '+(-hw*0.9)+' '+(hh*0.42)+' ' // 하단
        +'C '+(-hw*1.06)+' '+(hh*0.05)+' '+(-hw*1.1)+' '+(-hh*0.62)+' '+(-hw)+' '+(-hh*1.18)+' Z';
    }
    if(shape==='browline'){ // 하프림 느낌의 렌즈(아래 둥근 D). 브로우바는 별도.
      return 'M '+(-hw)+' '+(-hh*0.55)+' L '+hw+' '+(-hh*0.55)+' '
        +'C '+hw+' '+(hh*0.4)+' '+(hw*0.6)+' '+hh+' 0 '+hh+' '
        +'C '+(-hw*0.6)+' '+hh+' '+(-hw)+' '+(hh*0.4)+' '+(-hw)+' '+(-hh*0.55)+' Z';
    }
    if(shape==='aviator'){ // 에비에이터 물방울 — 외측(좌) 둥근 상단, 내측(우) 하단 점. 우측렌즈 반전.
      return 'M '+(-hw)+' '+(-hh*0.4)+' '
        +'C '+(-hw)+' '+(-hh*0.92)+' '+(-hw*0.5)+' '+(-hh)+' '+(hw*0.1)+' '+(-hh)+' '
        +'C '+(hw*0.72)+' '+(-hh)+' '+hw+' '+(-hh*0.68)+' '+hw+' '+(-hh*0.24)+' '
        +'C '+hw+' '+(hh*0.36)+' '+(hw*0.6)+' '+(hh*0.82)+' '+(hw*0.04)+' '+hh+' '
        +'C '+(-hw*0.46)+' '+(hh*0.8)+' '+(-hw*0.86)+' '+(hh*0.3)+' '+(-hw)+' '+(-hh*0.4)+' Z';
    }
    if(shape==='hexagon'){ // 6각
      return 'M '+(-hw*0.5)+' '+(-hh)+' L '+(hw*0.5)+' '+(-hh)+' L '+hw+' 0 '
        +'L '+(hw*0.5)+' '+hh+' L '+(-hw*0.5)+' '+hh+' L '+(-hw)+' 0 Z';
    }
    return E();
  }

  function frameSVG(spec){
    var s=spec||{};
    var shape=s.shape||'round';
    var lw=s.lw||92, lh=s.lh||40, dbl=s.dbl||18;
    var color=s.color||'#1a1a1a', tint=s.tint||'rgba(0,0,0,0.04)';
    var metal=!!s.metal, brow=s.brow||null, browColor=s.browColor||color;
    var rimW=metal?2.6:7;
    var W=s.w||300, H=s.h||130, cy=0;
    var hw=lw/2, hh=lh/2;
    var cxL=-(dbl/2+hw), cxR=(dbl/2+hw);
    var d=lensPath(shape,lw,lh);
    var g='<g transform="translate('+(W/2)+','+(H/2)+')">';

    // 템플(다리) — 엔드피스에서 바깥으로 짧게
    var edgeL=cxL-hw, edgeR=cxR+hw, ty=-hh*0.35;
    g+='<line x1="'+edgeL+'" y1="'+ty+'" x2="'+(edgeL-30)+'" y2="'+(ty-3)+'" stroke="'+color+'" stroke-width="'+(metal?2.2:5)+'" stroke-linecap="round"/>';
    g+='<line x1="'+edgeR+'" y1="'+ty+'" x2="'+(edgeR+30)+'" y2="'+(ty-3)+'" stroke="'+color+'" stroke-width="'+(metal?2.2:5)+'" stroke-linecap="round"/>';
    // 힌지 점
    g+='<circle cx="'+edgeL+'" cy="'+ty+'" r="'+(metal?1.8:2.6)+'" fill="'+color+'"/>';
    g+='<circle cx="'+edgeR+'" cy="'+ty+'" r="'+(metal?1.8:2.6)+'" fill="'+color+'"/>';

    // 렌즈 틴트(채움) + 림(선)
    g+='<path d="'+d+'" transform="translate('+cxL+','+cy+')" fill="'+tint+'" stroke="'+color+'" stroke-width="'+rimW+'" stroke-linejoin="round"/>';
    g+='<path d="'+d+'" transform="translate('+cxR+','+cy+') scale(-1,1)" fill="'+tint+'" stroke="'+color+'" stroke-width="'+rimW+'" stroke-linejoin="round"/>';

    // 브리지
    var by=(shape==='aviator'||shape==='round'||shape==='panto')?(-hh*0.45):(-hh*0.2);
    if(metal){ // 새들/더블바 느낌 — 살짝 내려오는 곡선
      g+='<path d="M '+(cxL+hw)+' '+(by)+' Q 0 '+(by+hh*0.4)+' '+(cxR-hw)+' '+(by)+'" fill="none" stroke="'+color+'" stroke-width="'+rimW+'" stroke-linecap="round"/>';
    } else { // 두꺼운 바
      g+='<line x1="'+(cxL+hw-1)+'" y1="'+by+'" x2="'+(cxR-hw+1)+'" y2="'+by+'" stroke="'+color+'" stroke-width="'+(rimW+1)+'" stroke-linecap="round"/>';
    }

    // 브로우바(브로우라인)
    if(brow){
      g+='<path d="M '+(cxL-hw)+' '+(-hh*0.62)+' '
        +'C '+(cxL)+' '+(-hh*0.95)+' '+(cxL+hw*0.6)+' '+(-hh)+' '+(cxL+hw)+' '+(-hh*0.62)+' '
        +'L '+(cxR-hw)+' '+(-hh*0.62)+' '
        +'C '+(cxR-hw*0.6)+' '+(-hh)+' '+(cxR)+' '+(-hh*0.95)+' '+(cxR+hw)+' '+(-hh*0.62)+'" '
        +'fill="none" stroke="'+browColor+'" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/>';
    }
    g+='</g>';
    return '<svg viewBox="0 0 '+W+' '+H+'" xmlns="http://www.w3.org/2000/svg" width="100%">'+g+'</svg>';
  }

  var api={ frameSVG:frameSVG, lensPath:lensPath };
  if(typeof module!=='undefined'&&module.exports) module.exports=api;
  if(root) root.BVFrameArt=api;
})(typeof window!=='undefined'?window:this);
