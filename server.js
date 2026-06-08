// 의존성 0 — Node 기본 모듈만 쓰는 정적 서버 (Railway용)
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, 'public');
const PORT = process.env.PORT || 3000;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2'
};

http.createServer((req, res) => {
  let url = decodeURIComponent(req.url.split('?')[0]);
  if (url === '/') url = '/index.html';
  let fp = path.join(ROOT, url);
  if (!fp.startsWith(ROOT)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(fp, (err, data) => {
    if (err) {
      // 확장자 없으면 .html 시도, 그래도 없으면 홈으로
      fs.readFile(fp + '.html', (e2, d2) => {
        if (!e2) { res.writeHead(200, { 'content-type': TYPES['.html'] }); return res.end(d2); }
        fs.readFile(path.join(ROOT, 'index.html'), (e3, d3) => {
          res.writeHead(e3 ? 404 : 200, { 'content-type': TYPES['.html'] });
          res.end(e3 ? 'Not found' : d3);
        });
      });
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(fp)] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(PORT, () => console.log('BETTERVISION OS up on ' + PORT));
