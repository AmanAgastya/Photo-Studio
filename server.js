const http = require('http');
const fs = require('fs');
const path = require('path');

const root = __dirname;
const MAX_BODY_BYTES = 15 * 1024 * 1024;
const STATIC_FILES = new Set(['photostudio.html', 'photostudio.css', 'photostudio.js']);

function loadLocalEnv() {
  try {
    fs.readFileSync(path.join(root, '.env'), 'utf8').split(/\r?\n/).forEach(line => {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
    });
  } catch (_) { /* Environment variables are supplied by Vercel in production. */ }
}
loadLocalEnv();

function sendJson(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
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

function parseInsightJson(text) {
  const clean = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  try { return JSON.parse(clean); }
  catch (_) {
    const match = clean.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('Grok did not return JSON insights');
    return JSON.parse(match[0]);
  }
}

function grokError(status) {
  if (status === 401 || status === 403) return 'Grok authentication failed. Set XAI_API_KEY to a valid xAI API key (not a Groq gsk_ key).';
  if (status === 429) return 'Grok rate limit or account quota reached. Please try again shortly.';
  if (status === 404) return 'The configured Grok model is unavailable. Check GROK_MODEL or remove it to use grok-4.5.';
  return `Grok API request failed (${status}). Check the Vercel function logs for details.`;
}

async function createRollInsights(images) {
  const apiKey = process.env.XAI_API_KEY || process.env.GROK_API_KEY;
  if (!apiKey) throw new Error('Missing XAI_API_KEY or GROK_API_KEY on the server');
  if (apiKey.startsWith('gsk_')) throw new Error('Grok requires an xAI API key. The configured gsk_ key belongs to Groq and cannot call api.x.ai.');

  const content = [{
    type: 'input_text',
    text: 'Analyze these images as one photo roll. Return ONLY valid JSON with string fields caption (warm Hinglish or Hindi social caption, 16-26 words), hashtags (6-8 space-separated hashtags), song (a real Hindi song title), artist (artist name), and reason (16 words maximum). Make one cohesive recommendation for the complete set.'
  }];
  images.forEach(image => content.push({ type: 'input_image', image_url: image, detail: 'low' }));

  const upstream = await fetch('https://api.x.ai/v1/responses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: process.env.GROK_MODEL || 'grok-4.5',
      input: [{ role: 'user', content }],
      max_output_tokens: 300
    })
  });
  const raw = await upstream.text();
  if (!upstream.ok) {
    console.error('Grok upstream response:', upstream.status, raw.slice(0, 500));
    throw new Error(grokError(upstream.status));
  }
  let responseData;
  try { responseData = JSON.parse(raw); }
  catch (_) { throw new Error('Grok returned an unreadable response'); }
  const result = parseInsightJson(outputText(responseData));
  if (!result.caption || !result.song || !result.artist) throw new Error('Grok returned an incomplete result');
  return result;
}

function serveFile(res, filePath, contentType) {
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

async function handler(req, res) {
  if (req.method === 'POST' && req.url.split('?')[0] === '/api/roll-insights') {
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
        error: isConfigError ? 'Grok is not configured. Add XAI_API_KEY in Vercel environment variables.' : error.message
      });
    }
  }

  const pathname = decodeURIComponent(req.url.split('?')[0]);
  const requested = pathname === '/' ? 'photostudio.html' : pathname.replace(/^\//, '');
  if (!STATIC_FILES.has(requested)) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return; }
  const ext = path.extname(requested).toLowerCase();
  const contentType = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8' }[ext];
  serveFile(res, path.join(root, requested), contentType);
}

module.exports = handler;

if (require.main === module) {
  http.createServer(handler).listen(3000, () => console.log('Server running at http://localhost:3000'));
}
