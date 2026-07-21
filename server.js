const http = require('http');
const fs = require('fs');
const path = require('path');

const root = __dirname;

function serveFile(res, filePath, contentType) {
fs.readFile(filePath, (err, data) => {
    if (err) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
    return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
});
}

const server = http.createServer((req, res) => {
  let filePath = req.url === '/' ? path.join(root, 'photostudio.html') : path.join(root, req.url.replace(/^\//, ''));
  const ext = path.extname(filePath).toLowerCase();
  const contentType = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8'
  }[ext] || 'application/octet-stream';

  serveFile(res, filePath, contentType);
});

server.listen(3000, () => {
  console.log('Server running at http://localhost:3000');
});
