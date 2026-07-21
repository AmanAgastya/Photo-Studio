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

function parseInsightJson(text) {
  const clean = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  try { return JSON.parse(clean); }
  catch (_) {
    const match = clean.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('Groq did not return JSON insights');
    return JSON.parse(match[0]);
  }
}

function groqError(status) {
  if (status === 401 || status === 403) return 'Groq authentication failed. Check that GROQ_API_KEY is a valid, active key from console.groq.com/keys.';
  if (status === 429) return 'Groq rate limit or account quota reached. Please try again shortly.';
  if (status === 404) return 'The configured Groq model is unavailable. Check GROQ_MODEL or remove it to use qwen/qwen3.6-27b.';
  return `Groq API request failed (${status}). Check the Vercel function logs for details.`;
}

async function createRollInsights(images) {
  const apiKey = process.env.GROQ_API_KEY || process.env.XAI_API_KEY;
  if (!apiKey) throw new Error('Missing GROQ_API_KEY on the server');

  const content = [{
    type: 'text',
    text: 'Analyze these images as one photo roll. Return ONLY valid JSON with string fields caption (warm Hinglish or Hindi social caption, 16-26 words), hashtags (6-8 space-separated hashtags), song (a real Hindi song title), artist (artist name), and reason (16 words maximum). Make one cohesive recommendation for the complete set.'
  }];
  images.forEach(image => content.push({ type: 'image_url', image_url: { url: image } }));

  const upstream = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: process.env.GROQ_MODEL || 'qwen/qwen3.6-27b',
      messages: [{ role: 'user', content }],
      response_format: { type: 'json_object' },
      max_completion_tokens: 300
    })
  });
  const raw = await upstream.text();
  if (!upstream.ok) {
    console.error('Groq upstream response:', upstream.status, raw.slice(0, 500));
    throw new Error(groqError(upstream.status));
  }
  let responseData;
  try { responseData = JSON.parse(raw); }
  catch (_) { throw new Error('Groq returned an unreadable response'); }
  const text = responseData.choices && responseData.choices[0] && responseData.choices[0].message
    ? responseData.choices[0].message.content : '';
  const result = parseInsightJson(text);
  if (!result.caption || !result.song || !result.artist) throw new Error('Groq returned an incomplete result');
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
      if (!Array.isArray(images) || !images.length || images.length > 5 || images.some(image => typeof image !== 'string' || !/^data:image\/(jpeg|png);base64,/.test(image))) {
        return sendJson(res, 400, { error: 'Send 1 to 5 JPEG or PNG images.' });
      }
      return sendJson(res, 200, await createRollInsights(images));
    } catch (error) {
      console.error('Roll insights error:', error.message);
      const isConfigError = error.message.startsWith('Missing GROQ_API_KEY');
      return sendJson(res, isConfigError ? 500 : 502, {
        error: isConfigError ? 'Groq is not configured. Add GROQ_API_KEY in Vercel environment variables.' : error.message
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