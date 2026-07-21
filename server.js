const http = require('http');
const fs = require('fs');
const path = require('path');

const root = __dirname;
const MAX_BODY_BYTES = 15 * 1024 * 1024;

// Keeps local development configuration out of source control, without adding
// a package dependency for this small static server.
function loadLocalEnv() {
  try {
    fs.readFileSync(path.join(root, '.env'), 'utf8').split(/\r?\n/).forEach(line => {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
    });
  } catch (_) { /* .env is optional in hosted environments */ }
}
loadLocalEnv();

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

function sendJson(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    // Generated captions and songs must never be reused for another roll.
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(data));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { reject(new Error('Request is too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (_) { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function outputText(data) {
  if (typeof data.output_text === 'string') return data.output_text;
  return (data.output || []).flatMap(item => item.content || [])
    .filter(item => item.type === 'output_text' || item.type === 'text')
    .map(item => item.text || '').join('\n');
}

async function createRollInsights(images) {
  const apiKey = process.envgsk_X0CK5W476zImKwcdsUUXWGdyb3FYFfyhR79SjBpAtfJ07RdiQo27 || process.env.GROK_API_KEY;
  if (!apiKey) throw new Error('Missing XAI_API_KEY or GROK_API_KEY on the server');
  const content = [{
    type: 'input_text',
    text: 'Analyze these images as one group photo roll. Return ONLY valid JSON with these string fields: caption (a warm Hinglish or Hindi social caption, 16-26 words), hashtags (6-8 space-separated hashtags), song (a real Hindi song title), artist (the artist name), reason (a concise reason, 16 words maximum). Make one cohesive recommendation for the entire set, not one per image.'
  }];
  images.forEach(image => content.push({ type: 'input_image', image_url: image, detail: 'low' }));
  const upstream = await fetch('https://api.x.ai/v1/responses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: process.env.GROK_MODEL || 'grok-4.5', input: [{ role: 'user', content }], max_output_tokens: 300 })
  });
  if (!upstream.ok) throw new Error(`Grok API returned ${upstream.status}`);
  const text = outputText(await upstream.json()).trim().replace(/^```json\s*|\s*```$/g, '');
  const result = JSON.parse(text);
  if (!result.caption || !result.song || !result.artist) throw new Error('Grok returned an incomplete result');
  return result;
}

async function handler(req, res) {
  if (req.method === 'POST' && req.url === '/api/roll-insights') {
    try {
      const { images } = await readJson(req);
      if (!Array.isArray(images) || !images.length || images.length > 8 || images.some(image => typeof image !== 'string' || !/^data:image\/(jpeg|png);base64,/.test(image))) {
        return sendJson(res, 400, { error: 'Send 1 to 8 JPEG or PNG images.' });
      }
      return sendJson(res, 200, await createRollInsights(images));
    } catch (error) {
      console.error('Roll insights error:', error.message);
      const isConfigError = error.message.startsWith('Missing XAI_API_KEY') || error.message.startsWith('Missing GROK_API_KEY');
      return sendJson(res, isConfigError ? 500 : 502, {
        error: isConfigError ? 'Grok is not configured. Add XAI_API_KEY in Vercel environment variables.' : 'Grok could not generate roll insights. Please try again.'
      });
    }
  }
  const pathname = decodeURIComponent(req.url.split('?')[0]);
  const requested = pathname === '/' ? 'photostudio.html' : pathname.replace(/^\//, '');
  const filePath = path.join(root, requested);
  if (!filePath.startsWith(root + path.sep) || !['photostudio.html', 'photostudio.css', 'photostudio.js'].includes(requested)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return;
  }
  const ext = path.extname(filePath).toLowerCase();
  const contentType = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8'
  }[ext] || 'application/octet-stream';

  serveFile(res, filePath, contentType);
}

// Vercel invokes the exported handler. Locally, retain the convenient static
// server entry point with `node server.js`.
module.exports = handler;

if (require.main === module) {
  http.createServer(handler).listen(3000, () => {
    console.log('Server running at http://localhost:3000');
  });
}
