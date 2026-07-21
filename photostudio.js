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
  const developedPhotos = []; // photos belonging only to the current upload batch
  let activeBatchId = 0;
  let captionDirection = '';
  const MAX_PHOTOS_PER_ROLL = 10;

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
    const selected = Array.from(fileList).filter(f=> f.type.startsWith('image/'));
    const files = selected.slice(0, MAX_PHOTOS_PER_ROLL);
    if(!files.length){ showToast('Only image files, please.'); return; }
    if(selected.length > MAX_PHOTOS_PER_ROLL) showToast('Using the first 10 photos for this roll.');
    // A fresh drop starts a fresh roll. This prevents an old upload from being
    // included when a user later analyzes one image or a new group.
    if(!isRunning && !queue.length){
      activeBatchId++;
      developedPhotos.length = 0;
      captionDirection = '';
      if(mixtape) mixtape.style.display = 'none';
    }
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
    if(developedPhotos.length) requestGroupSong(activeBatchId);
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
        <div class="caption-loading">Group caption and soundtrack are generated from the complete roll above.</div>
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

  // ---------- one song for the whole roll (group, not per-photo) ----------
  const MAX_PHOTOS_FOR_SONG = MAX_PHOTOS_PER_ROLL;

  function pickSample(list, max){
    if(list.length <= max) return list;
    // evenly spaced sample across the whole set so the pick reflects the full roll, not just the end
    const out = [];
    const step = (list.length - 1) / (max - 1);
    for(let i=0; i<max; i++) out.push(list[Math.round(i*step)]);
    return out;
  }

  async function requestGroupSong(batchId = activeBatchId){
    const photos = developedPhotos.slice();
    if(!photos.length) return;
    if(mixtapeRegenBtn) mixtapeRegenBtn.style.display = 'none';
    if(mixtape) mixtape.style.display = 'flex';
    mixtapeBody.innerHTML = `
      <p class="mixtape-eyebrow">soundtrack for this roll</p>
      <div class="mixtape-loading"><span class="dot">●</span><span class="dot">●</span><span class="dot">●</span> writing a caption and picking a song for this ${photos.length === 1 ? 'photo' : 'set'}</div>
    `;
    try{
      const { caption, hashtags, song, artist, reason } = await getGroupSong(pickSample(photos, MAX_PHOTOS_FOR_SONG), captionDirection);
      if(batchId !== activeBatchId) return;
      mixtapeBody.innerHTML = `
        <p class="mixtape-eyebrow">caption + soundtrack · ${photos.length} photo${photos.length===1?'':'s'}</p>
        <textarea class="caption-box roll-caption" aria-label="Group caption" spellcheck="false">${escapeHtml(caption)}</textarea>
        <div class="caption-style-control">
          <label for="captionDirection">Caption style</label>
          <input id="captionDirection" class="caption-style-input" type="text" maxlength="160" placeholder="e.g. funny, romantic, minimal, travel vibe">
          <button class="btn caption-style-btn" type="button">Update caption</button>
        </div>
        <div class="hashtags">${escapeHtml(hashtags)}</div>
        <p class="mixtape-song">${escapeHtml(song)} <span class="artist">— ${escapeHtml(artist)}</span></p>
        <p class="mixtape-reason">${escapeHtml(reason)}</p>
      `;
      const directionInput = mixtapeBody.querySelector('.caption-style-input');
      const directionButton = mixtapeBody.querySelector('.caption-style-btn');
      directionInput.value = captionDirection;
      directionButton.addEventListener('click', ()=>{
        captionDirection = directionInput.value.trim().slice(0, 160);
        requestGroupSong(activeBatchId);
      });
      directionInput.addEventListener('keydown', event => {
        if(event.key === 'Enter'){
          event.preventDefault();
          directionButton.click();
        }
      });
    }catch(err){
      console.error(err);
      if(batchId !== activeBatchId) return;
      mixtapeBody.innerHTML = `
        <p class="mixtape-eyebrow">caption + soundtrack</p>
        <div class="mixtape-error">${escapeHtml(err.message || "Couldn't reach Grok. Hit regenerate to retry.")}</div>
      `;
    }
    if(mixtapeRegenBtn) mixtapeRegenBtn.style.display = '';
  }

  if(mixtapeRegenBtn){
    mixtapeRegenBtn.addEventListener('click', ()=>{
      if(developedPhotos.length) requestGroupSong(activeBatchId);
    });
  }

  async function getGroupSong(photos, direction = ''){
    // Groq limits the number of direct vision inputs. A single contact-sheet
    // image lets one request reflect every photo in a roll of up to ten.
    const images = [await createAnalysisCollage(photos)];
    const response = await fetch('/api/roll-insights', {
      method: 'POST', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ images, captionPreference: direction })
    });
    const result = await response.json().catch(()=> ({}));
    if(!response.ok) throw new Error(result.error || 'Could not generate caption and song.');
    if(!result.caption || !result.song || !result.artist) throw new Error('Grok returned an incomplete caption or song recommendation.');
    return result;
  }

  function escapeHtml(str){
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  function resizeForAnalysis(dataUrl){
    return new Promise((resolve, reject)=>{
      const img = new Image();
      img.onload = ()=>{
        const scale = Math.min(1, 960 / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', 0.82));
      };
      img.onerror = reject;
      img.src = dataUrl;
    });
  }

  function createAnalysisCollage(photos){
    if(photos.length === 1) return resizeForAnalysis(photos[0].dataUrl);
    return Promise.all(photos.map(photo => new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = ()=> resolve(img);
      img.onerror = ()=> reject(new Error('Could not prepare a photo for caption analysis.'));
      img.src = photo.dataUrl;
    }))).then(images => {
      const columns = Math.ceil(Math.sqrt(images.length));
      const rows = Math.ceil(images.length / columns);
      const cell = Math.max(220, Math.floor(1200 / columns));
      const canvas = document.createElement('canvas');
      canvas.width = columns * cell;
      canvas.height = rows * cell;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#191613';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      images.forEach((img, index) => {
        const x = (index % columns) * cell;
        const y = Math.floor(index / columns) * cell;
        const scale = Math.max(cell / img.width, cell / img.height);
        const width = img.width * scale;
        const height = img.height * scale;
        ctx.drawImage(img, x + (cell - width) / 2, y + (cell - height) / 2, width, height);
      });
      return canvas.toDataURL('image/jpeg', 0.84);
    });
  }

})();
