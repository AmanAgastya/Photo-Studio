(function(){
  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('fileInput');
  const filmstrip = document.getElementById('filmstrip');
  const queueSection = document.getElementById('queueSection');
  const contactSheet = document.getElementById('contactSheet');
  const emptyNote = document.getElementById('emptyNote');
  const frameCountEl = document.getElementById('frameCount');
  const toastEl = document.getElementById('toast');
  const mixtape = document.getElementById('mixtape');
  const mixtapeBody = document.getElementById('mixtapeBody');
  const mixtapeRegenBtn = document.getElementById('mixtapeRegenBtn');

  let idCounter = 0;
  let frameNumber = 0;
  const queue = [];      // waiting/processing items {id, file, thumbUrl, status}
  let isRunning = false;
  const developedPhotos = []; // { dataUrl, mime } for every enhanced photo, whole-roll song picks off this

  function showToast(msg){
    if(!toastEl) return;
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(()=> toastEl.classList.remove('show'), 2200);
  }

  function setQueueVisible(visible){
    if(queueSection) queueSection.style.display = visible ? '' : 'none';
  }

  // ---------- file intake ----------
  if(dropzone && fileInput){
    dropzone.addEventListener('click', ()=> fileInput.click());
    dropzone.addEventListener('keydown', e=>{
      if(e.key === 'Enter' || e.key === ' '){ e.preventDefault(); fileInput.click(); }
    });
    dropzone.addEventListener('dragover', e=>{ e.preventDefault(); dropzone.classList.add('drag'); });
    dropzone.addEventListener('dragleave', ()=> dropzone.classList.remove('drag'));
    dropzone.addEventListener('drop', e=>{
      e.preventDefault(); dropzone.classList.remove('drag');
      handleFiles(e.dataTransfer.files);
    });
    fileInput.addEventListener('change', e=> { handleFiles(e.target.files); fileInput.value=''; });
  }

  function handleFiles(fileList){
    const files = Array.from(fileList).filter(f=> f.type.startsWith('image/'));
    if(!files.length){ showToast('Only image files, please.'); return; }
    files.forEach(addToQueue);
    if(!isRunning) runQueue();
  }

  function addToQueue(file){
    const id = 'f' + (++idCounter);
    const item = { id, file, status:'waiting', thumbUrl:null };
    queue.push(item);
    setQueueVisible(true);
    const reader = new FileReader();
    reader.onload = e => { item.thumbUrl = e.target.result; renderFilmstrip(); };
    reader.readAsDataURL(file);
    renderFilmstrip();
  }

  function renderFilmstrip(){
    const nodes = queue.map(item => {
      const div = document.createElement('div');
      div.className = 'frame-thumb ' + item.status;
      const img = document.createElement('img');
      if(item.thumbUrl) img.src = item.thumbUrl;
      div.appendChild(img);
      if(item.status === 'processing'){
        const bar = document.createElement('div');
        bar.className = 'scanbar';
        div.appendChild(bar);
      }
      const badge = document.createElement('div');
      badge.className = 'badge';
      badge.innerHTML = `<span>${item.status}</span>`;
      div.appendChild(badge);
      return div;
    });
    filmstrip.querySelectorAll('.frame-thumb').forEach(n=>n.remove());
    nodes.forEach(n => filmstrip.appendChild(n));
  }

  // ---------- processing queue (sequential) ----------
  async function runQueue(){
    isRunning = true;
    while(queue.some(i=> i.status==='waiting')){
      const item = queue.find(i=> i.status==='waiting');
      item.status = 'processing';
      renderFilmstrip();
      try{
        const { originalUrl, enhancedUrl, mime } = await enhanceImage(item.file);
        frameNumber++;
        const card = addCard(frameNumber, originalUrl, enhancedUrl, mime, item.file.name);
        developedPhotos.push({ dataUrl: enhancedUrl, mime });
        // remove from queue once handed to contact sheet
        const idx = queue.indexOf(item);
        if(idx>-1) queue.splice(idx,1);
        renderFilmstrip();
        if(!queue.length) setQueueVisible(false);
        // fire caption request (non-blocking for the queue, but sequential is fine here since it's fast)
        requestCaption(card);
      }catch(err){
        console.error(err);
        showToast('Could not develop that frame — skipping.');
        const idx = queue.indexOf(item);
        if(idx>-1) queue.splice(idx,1);
        renderFilmstrip();
      }
    }
    isRunning = false;
    // whole batch has drained — pick one song for the roll as a group, not per photo
    if(developedPhotos.length) requestGroupSong();
  }

  // ---------- enhancement pipeline ----------
  function loadImage(file){
    // Use a data URL (FileReader) rather than URL.createObjectURL — blob URLs
    // can silently fail to load inside the sandboxed artifact frame, which
    // was causing every upload to error out.
    return new Promise((resolve,reject)=>{
      const reader = new FileReader();
      reader.onerror = ()=> reject(new Error('Could not read file'));
      reader.onload = ()=>{
        const img = new Image();
        img.onload = ()=> resolve({ img, dataUrl:reader.result });
        img.onerror = ()=> reject(new Error('Could not decode image'));
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  async function enhanceImage(file){
    const { img } = await loadImage(file);
    let { width, height } = img;
    const longSide = Math.max(width, height);

    // Increase the effective output resolution while keeping the export lightweight.
    let scale = 1;
    if(longSide < 1200) scale = 2.2;
    else if(longSide < 1800) scale = 1.8;
    else if(longSide < 2400) scale = 1.35;
    else scale = 1.1;

    const w = Math.round(width * scale);
    const h = Math.round(height * scale);

    // original preview (same size, for a fair before/after comparison)
    const origCanvas = document.createElement('canvas');
    origCanvas.width = w; origCanvas.height = h;
    const origCtx = origCanvas.getContext('2d');
    origCtx.imageSmoothingEnabled = true;
    origCtx.imageSmoothingQuality = 'high';
    origCtx.drawImage(img, 0, 0, w, h);
    const originalUrl = origCanvas.toDataURL('image/jpeg', 0.96);

    // enhanced version: draw at a higher-res target, then run a softer
    // lighting/color pass to keep details crisp without making the photo look washed out.
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.filter = 'contrast(1.03) saturate(1.04) brightness(0.985)';
    ctx.drawImage(img, 0, 0, w, h);
    ctx.filter = 'none';

    const imageData = ctx.getImageData(0, 0, w, h);
    autoLevels(imageData);
    liftShadowsAndPop(imageData);
    sharpen(imageData, 0.38);
    ctx.putImageData(imageData, 0, 0);

    const enhancedUrl = canvas.toDataURL('image/jpeg', 0.97);
    return { originalUrl, enhancedUrl, mime:'image/jpeg' };
  }

  function clampByte(v){ return v<0 ? 0 : v>255 ? 255 : v; }

  // Stretches each channel's histogram to use the full 0-255 range,
  // clipping the darkest/brightest 0.5% as outliers — this is what actually
  // fixes flat, dull, or underlit photos (real levels correction, not just
  // a flat brightness multiplier).
  function autoLevels(imageData){
    const { data, width:w, height:h } = imageData;
    const histR = new Uint32Array(256), histG = new Uint32Array(256), histB = new Uint32Array(256);
    for(let i=0; i<data.length; i+=4){
      histR[data[i]]++; histG[data[i+1]]++; histB[data[i+2]]++;
    }
    const total = w*h, clip = total*0.002;
    function bounds(hist){
      let lo=0, hi=255, count=0;
      for(let i=0;i<256;i++){ count+=hist[i]; if(count>clip){ lo=i; break; } }
      count=0;
      for(let i=255;i>=0;i--){ count+=hist[i]; if(count>clip){ hi=i; break; } }
      if(hi<=lo){ lo=0; hi=255; }
      return [lo,hi];
    }
    const [rl,rh]=bounds(histR), [gl,gh]=bounds(histG), [bl,bh]=bounds(histB);
    for(let i=0;i<data.length;i+=4){
      data[i]   = clampByte((data[i]-rl)   * 255/(rh-rl));
      data[i+1] = clampByte((data[i+1]-gl) * 255/(gh-gl));
      data[i+2] = clampByte((data[i+2]-bl) * 255/(bh-bl));
    }
  }

  // Gently lifts shadows/midtones (gamma) and boosts saturation around
  // each pixel's own luminance, for a "more light, more pop" look.
  function liftShadowsAndPop(imageData){
    const data = imageData.data;
    const gamma = 0.92, sat = 1.06, lift = 4;
    for(let i=0; i<data.length; i+=4){
      let r = 255*Math.pow(data[i]/255, gamma) + lift;
      let g = 255*Math.pow(data[i+1]/255, gamma) + lift;
      let b = 255*Math.pow(data[i+2]/255, gamma) + lift;
      const lum = 0.299*r + 0.587*g + 0.114*b;
      data[i]   = clampByte(lum + (r-lum)*sat);
      data[i+1] = clampByte(lum + (g-lum)*sat);
      data[i+2] = clampByte(lum + (b-lum)*sat);
    }
  }

  function sharpen(imageData, amount){
    const { width:w, height:h, data } = imageData;
    const src = new Uint8ClampedArray(data);
    const k = [0,-1,0, -1,5,-1, 0,-1,0];
    for(let y=1; y<h-1; y++){
      for(let x=1; x<w-1; x++){
        for(let c=0; c<3; c++){
          let sum=0, ki=0;
          for(let ky=-1; ky<=1; ky++){
            for(let kx=-1; kx<=1; kx++){
              sum += src[((y+ky)*w+(x+kx))*4+c] * k[ki++];
            }
          }
          const idx = (y*w+x)*4+c;
          data[idx] = src[idx]*(1-amount) + sum*amount;
        }
      }
    }
    return imageData;
  }

  // Apply a lightweight lighting/exposure adjust to a dataURL image and
  // return a new dataURL. `amount` is integer -40..40 where positive brightens.
  function applyLightingAdjust(dataUrl, amount){
    return new Promise((resolve,reject)=>{
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = ()=>{
        const w = img.width, h = img.height;
        const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img,0,0,w,h);
        try{
          const id = ctx.getImageData(0,0,w,h);
          const data = id.data;
          // exposure factor
          const f = 1 + (amount/100);
          // small contrast tweak based on amount
          const contrast = 1 + (Math.abs(amount)/400);
          const intercept = 128*(1-contrast);
          for(let i=0; i<data.length; i+=4){
            // apply exposure
            let r = data[i]*f;
            let g = data[i+1]*f;
            let b = data[i+2]*f;
            // apply contrast around mid (simple linear contrast)
            r = clampByte(r*contrast + intercept);
            g = clampByte(g*contrast + intercept);
            b = clampByte(b*contrast + intercept);
            data[i] = r; data[i+1] = g; data[i+2] = b;
          }
          ctx.putImageData(id,0,0);
          const out = canvas.toDataURL('image/jpeg',0.94);
          resolve(out);
        }catch(err){ reject(err); }
      };
      img.onerror = ()=> reject(new Error('Could not decode image for lighting adjust'));
      img.src = dataUrl;
    });
  }

  // ---------- contact sheet cards ----------
  function addCard(num, originalUrl, enhancedUrl, mime, filename){
    if(emptyNote) emptyNote.style.display = 'none';
    if(frameCountEl) frameCountEl.textContent = num;

    const card = document.createElement('div');
    card.className = 'frame-card';
    card.dataset.filename = filename.replace(/\.[^.]+$/, '') || ('frame-' + num);

    card.innerHTML = `
      <div class="compare">
        <img class="before-img" src="${originalUrl}" alt="Original">
        <img class="after-img" src="${enhancedUrl}" alt="Enhanced">
        <div class="divider" style="left:50%"></div>
        <div class="handle" style="left:50%">
          <svg viewBox="0 0 24 24" fill="none" stroke="#1a1512" stroke-width="2"><path d="M8 7l-5 5 5 5M16 7l5 5-5 5"/></svg>
        </div>
        <span class="tag before">before</span>
        <span class="tag after">after</span>
        <span class="framenum">No. ${String(num).padStart(2,'0')}</span>
        <input type="range" min="0" max="100" value="50" class="slider">
      </div>
      <div class="card-body">
        <div class="caption-loading"><span class="dot">●</span><span class="dot">●</span><span class="dot">●</span> writing caption</div>
        <div style="display:flex;gap:8px;align-items:center;">
          <label style="font-size:12px;color:var(--ink-dim);">Lighting:</label>
          <input type="range" min="-40" max="40" value="0" class="lighting-range" aria-label="Lighting adjust">
          <button class="btn apply-light-btn">Apply</button>
        </div>
        <div class="actions-row" style="display:none;"></div>
        <div class="card-actions">
          <button class="btn download-btn">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3v12M12 15l-4-4M12 15l4-4"/><path d="M4 18v1a2 2 0 002 2h12a2 2 0 002-2v-1"/></svg>
            Save
          </button>
          <button class="btn copy-btn">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="8" y="8" width="12" height="12" rx="1.5"/><path d="M4 15V5a2 2 0 012-2h10"/></svg>
            Copy caption
          </button>
          <button class="btn regen-btn">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 12a8 8 0 0113.9-5.4M20 12a8 8 0 01-13.9 5.4"/><path d="M17 3v5h-5M7 21v-5h5"/></svg>
            Re-caption
          </button>
        </div>
      </div>
    `;
    if(contactSheet) contactSheet.prepend(card);

    // slider wiring
    const slider = card.querySelector('.slider');
    const afterImg = card.querySelector('.after-img');
    const divider = card.querySelector('.divider');
    const handle = card.querySelector('.handle');
    slider.addEventListener('input', ()=>{
      const v = slider.value;
      afterImg.style.clipPath = `inset(0 ${100-v}% 0 0)`;
      divider.style.left = v + '%';
      handle.style.left = v + '%';
    });
    afterImg.style.clipPath = 'inset(0 50% 0 0)';

    // download
    card.querySelector('.download-btn').addEventListener('click', ()=>{
      const a = document.createElement('a');
      a.href = enhancedUrl;
      a.download = card.dataset.filename + '-enhanced.jpg';
      a.click();
      showToast('Saved.');
    });

    // copy caption
    card.querySelector('.copy-btn').addEventListener('click', ()=>{
      const box = card.querySelector('.caption-box');
      const tags = card.querySelector('.hashtags');
      const text = (box ? box.value : '') + (tags ? ('\n\n' + tags.textContent) : '');
      navigator.clipboard.writeText(text.trim()).then(()=> showToast('Caption copied.'))
        .catch(()=> showToast('Could not copy — select the text manually.'));
    });

    card._enhancedUrl = enhancedUrl;
    card._mime = mime;
    // lighting controls: apply a lightweight exposure/balance adjust on the enhanced image
    const lightRange = card.querySelector('.lighting-range');
    const applyBtn = card.querySelector('.apply-light-btn');
    applyBtn.addEventListener('click', async ()=>{
      applyBtn.disabled = true; applyBtn.textContent = 'Applying…';
      try{
        const newDataUrl = await applyLightingAdjust(card._enhancedUrl, parseInt(lightRange.value,10));
        card._enhancedUrl = newDataUrl;
        const afterImg = card.querySelector('.after-img');
        afterImg.src = newDataUrl;
        showToast('Lighting adjusted');
      }catch(e){ console.error(e); showToast('Could not apply lighting'); }
      applyBtn.disabled = false; applyBtn.textContent = 'Apply';
    });
    return card;
  }

  // ---------- caption generation via Claude ----------
  async function requestCaption(card){
    const body = card.querySelector('.caption-loading');
    if(!body) return;
    try{
      const { caption, hashtags } = await getCaption(card._enhancedUrl, card._mime);
      body.outerHTML = `
        <textarea class="caption-box" spellcheck="false">${escapeHtml(caption)}</textarea>
        <div class="hashtags">${escapeHtml(hashtags)}</div>
      `;
    }catch(err){
      console.error(err);
      body.outerHTML = `
        <textarea class="caption-box" spellcheck="false" placeholder="Write your own caption…"></textarea>
        <div class="caption-error">Couldn't reach the caption model — write your own, or hit Re-caption to retry.</div>
      `;
    }
    // wire re-caption button now that caption exists
    const regenBtn = card.querySelector('.regen-btn');
    regenBtn.onclick = async ()=>{
      const loadingHtml = `<div class="caption-loading"><span class="dot">●</span><span class="dot">●</span><span class="dot">●</span> writing caption</div>`;
      const box = card.querySelector('.caption-box');
      const tags = card.querySelector('.hashtags');
      const err = card.querySelector('.caption-error');
      if(box) box.outerHTML = loadingHtml;
      else if(err){ err.parentElement.insertAdjacentHTML('afterbegin', loadingHtml); }
      if(tags) tags.remove();
      if(err) err.remove();
      await requestCaption(card);
    };
  }

  // ---------- one song for the whole roll (group, not per-photo) ----------
  const MAX_PHOTOS_FOR_SONG = 10; // keep the request light — a representative sample is enough

  function pickSample(list, max){
    if(list.length <= max) return list;
    // evenly spaced sample across the whole set so the pick reflects the full roll, not just the end
    const out = [];
    const step = (list.length - 1) / (max - 1);
    for(let i=0; i<max; i++) out.push(list[Math.round(i*step)]);
    return out;
  }

  async function requestGroupSong(){
    if(mixtapeRegenBtn) mixtapeRegenBtn.style.display = 'none';
    if(mixtape) mixtape.style.display = 'flex';
    mixtapeBody.innerHTML = `
      <p class="mixtape-eyebrow">soundtrack for this roll</p>
      <div class="mixtape-loading"><span class="dot">●</span><span class="dot">●</span><span class="dot">●</span> picking a song for the whole set</div>
    `;
    try{
      const { song, artist, reason } = await getGroupSong(pickSample(developedPhotos, MAX_PHOTOS_FOR_SONG));
      mixtapeBody.innerHTML = `
        <p class="mixtape-eyebrow">soundtrack for this roll · ${developedPhotos.length} photo${developedPhotos.length===1?'':'s'}</p>
        <p class="mixtape-song">${escapeHtml(song)} <span class="artist">— ${escapeHtml(artist)}</span></p>
        <p class="mixtape-reason">${escapeHtml(reason)}</p>
      `;
    }catch(err){
      console.error(err);
      mixtapeBody.innerHTML = `
        <p class="mixtape-eyebrow">soundtrack for this roll</p>
        <div class="mixtape-error">Couldn't reach the model to pick a song — hit re-pick to retry.</div>
      `;
    }
    if(mixtapeRegenBtn) mixtapeRegenBtn.style.display = '';
  }

  if(mixtapeRegenBtn){
    mixtapeRegenBtn.addEventListener('click', ()=>{
      if(developedPhotos.length) requestGroupSong();
    });
  }

  function getApiConfig(){
    return {
      provider: 'groq',
      key: ''
    };
  }

  async function callVisionApi(prompt, imageDataUrl, mime){
    const { provider, key } = getApiConfig();
    if(provider === 'local' || !key) throw new Error('No API key');

    const base64 = imageDataUrl.split(',')[1];
    const endpoint = provider === 'groq'
      ? 'https://api.groq.com/openai/v1/chat/completions'
      : 'https://api.x.ai/v1/chat/completions';
    const model = provider === 'groq' ? 'llama-3.2-90b-vision-preview' : 'grok-2-latest';

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`
      },
      body: JSON.stringify({
        model,
        temperature: 0.7,
        max_tokens: 280,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}`, detail: 'high' } }
          ]
        }]
      })
    });

    if(!response.ok) throw new Error('API error ' + response.status);
    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    if(typeof content === 'string') return content.trim();
    if(Array.isArray(content)) return content.map(item => item.type === 'text' ? item.text : '').join('\n').trim();
    throw new Error('Unexpected API response');
  }

  async function getGroupSong(photos){
    const count = photos.length;
    const fallbackSong = count >= 5 ? 'Gallan Goodiyan' : 'Phir Aur Kya Chahiye';
    const fallbackArtist = count >= 5 ? 'Shankar Ehsaan Loy' : 'Arijit Singh';
    const fallbackReason = count >= 5
      ? 'Energetic and fun, perfect for a lively friend-group roll.'
      : 'Warm and nostalgic, fitting a cozy memory-filled set.';

    try{
      const prompt = `You are picking a song for a friend-group photo roll. Reply with exactly three lines and nothing else. Line 1: Hindi song title only. Line 2: artist name only. Line 3: one short reason in English or Hindi, max 16 words.`;
      const text = await callVisionApi(prompt, photos[0]?.dataUrl || '', photos[0]?.mime || 'image/jpeg');
      const lines = text.split('\n').map(l=>l.trim()).filter(Boolean);
      return {
        song: lines[0] || fallbackSong,
        artist: lines[1] || fallbackArtist,
        reason: lines[2] || fallbackReason
      };
    }catch(err){
      console.warn('API song generation failed, using fallback', err);
      return { song: fallbackSong, artist: fallbackArtist, reason: fallbackReason };
    }
  }

  function escapeHtml(str){
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  async function getCaption(dataUrl, mime){
    const fallbackCaption = 'A little glow, a lot of memories, and a whole lot of heart.';
    const fallbackHashtags = '#photoDump #yaadein #friendsForever #mood #capturedMoments';

    try{
      const prompt = `You are writing a social caption for a friend-group photo. Reply with exactly two lines and nothing else. Line 1: a warm, expressive caption in Hindi or Hinglish, 16 to 22 words, emotionally rich. Line 2: 6 to 8 hashtags, all starting with #.`;
      const text = await callVisionApi(prompt, dataUrl, mime);
      const lines = text.split('\n').map(l=>l.trim()).filter(Boolean);
      return {
        caption: lines[0] || fallbackCaption,
        hashtags: lines[1] || fallbackHashtags
      };
    }catch(err){
      console.warn('API caption generation failed, using fallback', err);
      return { caption: fallbackCaption, hashtags: fallbackHashtags };
    }
  }

})();
