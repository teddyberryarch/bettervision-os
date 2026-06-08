# BETTERVISION OS — 웹앱 (정적 멀티페이지)

구조:
- public/index.html  : 랜딩(역할 선택)
- public/customer.html / store.html / hq.html : 역할별 페이지(껍데기)
- public/assets/app.css, app.js : 공통 스타일/스크립트
- server.js : 의존성 0 정적 서버 (Railway가 npm start로 실행)

로컬 확인:  node server.js  → http://localhost:3000

배포: GitHub에 푸시 → Railway에서 New Project → Deploy from GitHub repo.
자세한 단계는 DEPLOY.md 참고.
