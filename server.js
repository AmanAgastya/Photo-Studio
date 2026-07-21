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
    if (match) {
      try { return JSON.parse(match[0]); }
      catch (_) { /* Try the readable-label fallback below. */ }
    }

    // Some vision models answer with readable labels despite being asked for
    // JSON. Accept that useful response instead of discarding the caption.
    const fields = {};
    clean.split(/\r?\n/).forEach(line => {
      const normalized = line.replace(/\*\*/g, '').replace(/^\s*[-*]\s*/, '').trim();
      const label = normalized.match(/^(caption|hashtags|song|artist|reason)\s*[:\-]\s*(.+)$/i);
      if (label) fields[label[1].toLowerCase()] = label[2].trim().replace(/^['"]|['"]$/g, '');
    });
    if (fields.caption && fields.song) {
      return {
        caption: fields.caption,
        hashtags: fields.hashtags || '',
        song: fields.song,
        artist: fields.artist || 'Artist not specified',
        reason: fields.reason || ''
      };
    }
    throw new Error('The AI provider returned an unusable caption format');
  }
}

function providerError(provider, status, raw) {
  let detail = '';
  try {
    const body = JSON.parse(raw);
    detail = body?.error?.message || body?.error || body?.message || '';
  } catch (_) { /* Use the status-specific fallback below. */ }
  if (!detail && raw) {
    // xAI occasionally returns a plain-text/HTML gateway error instead of a
    // JSON error object. Make it visible without returning a huge page.
    detail = raw.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  }
  if (detail) return `${provider} rejected the request: ${String(detail).slice(0, 300)}`;
  if (status === 401 || status === 403) return `${provider} authentication failed. Check its API key in the deployment environment variables.`;
  if (status === 413) return `The uploaded image is too large for ${provider}. Try a smaller image.`;
  if (status === 429) return `${provider} rate limit or account quota reached. Please try again shortly.`;
  if (status === 404) return `The configured ${provider} model is unavailable. Check the model environment variable.`;
  return `${provider} API request failed (${status}). Check the server logs for details.`;
}

async function createRollInsights(images) {
  // This project already has a GROQ_API_KEY. Prefer it because it cannot be
  // used with xAI/Grok, then support XAI_API_KEY when an xAI key is supplied.
  // A previous setup placed a Groq gsk_ key in XAI_API_KEY; accept that legacy
  // configuration too, so the browser upload works without exposing a key.
  const groqKey = process.env.GROQ_API_KEY || (/^gsk_/.test(process.env.XAI_API_KEY || '') ? process.env.XAI_API_KEY : '');
  const xaiKey = groqKey ? '' : process.env.XAI_API_KEY;
  const config = groqKey ? {
    provider: 'Groq',
    apiKey: groqKey,
    endpoint: 'https://api.groq.com/openai/v1/chat/completions',
    model: process.env.GROQ_MODEL || 'qwen/qwen3.6-27b'
  } : xaiKey ? {
    provider: 'Grok',
    apiKey: xaiKey,
    endpoint: 'https://api.x.ai/v1/chat/completions',
    model: process.env.XAI_MODEL || 'grok-4.5'
  } : null;
  if (!config) throw new Error('Missing GROQ_API_KEY or XAI_API_KEY on the server');

  // Both supported APIs accept base64 image data URLs. The key remains on the
  // server and is never included in browser code.
  const content = images.map(image => ({
    type: 'image_url',
    image_url: { url: image, detail: 'high' }
  }));
  content.push({
    type: 'text',
    text: 'Analyze these images as one photo roll. Return ONLY one valid JSON object with these string fields: caption (warm Hinglish or Hindi social caption, 16-26 words), hashtags (6-8 space-separated hashtags), song (a real Hindi song title), artist (artist name), and reason (16 words maximum). Make one cohesive recommendation for the complete set. Do not use markdown or add any text outside the JSON object.'
  });

  const upstream = await fetch(config.endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify({
      model: config.model,
      messages: [{ role: 'user', content }],
      ...(config.provider === 'Groq' ? { max_completion_tokens: 300 } : {})
    })
  });
  const raw = await upstream.text();
  if (!upstream.ok) {
    console.error(`${config.provider} upstream response:`, upstream.status, raw.slice(0, 500));
    throw new Error(providerError(config.provider, upstream.status, raw));
  }
  let responseData;
  try { responseData = JSON.parse(raw); }
  catch (_) { throw new Error(`${config.provider} returned an unreadable response`); }
  const text = responseData.choices?.[0]?.message?.content || '';
  if (!text) throw new Error(`${config.provider} returned an empty response`);
  const result = parseInsightJson(text);
  if (!result.caption || !result.song || !result.artist) throw new Error(`${config.provider} returned an incomplete result`);
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
      const isConfigError = error.message.startsWith('Missing GROQ_API_KEY or XAI_API_KEY');
      return sendJson(res, isConfigError ? 500 : 502, {
        error: isConfigError ? 'No AI key is configured. Add GROQ_API_KEY or XAI_API_KEY in your deployment environment variables.' : error.message
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
