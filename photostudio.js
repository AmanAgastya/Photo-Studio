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
  const IMAGE_FILENAME = /\.(avif|bmp|gif|heic|heif|jpe?g|png|webp)$/i;
  const HEIC_FILENAME = /\.(heic|heif)$/i;

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
    // Some phones and file managers leave File.type blank. Keep recognised
    // photo files in the queue instead of rejecting them before decoding.
    const selected = Array.from(fileList).filter(f=> f.type.startsWith('image/') || IMAGE_FILENAME.test(f.name));
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
        const sourceFile = await prepareImageFile(item.file);
        const { originalUrl, enhancedUrl, mime, width, height, usedOriginal } = await enhanceImage(sourceFile);
        frameNumber++;
        const card = addCard(frameNumber, originalUrl, enhancedUrl, mime, item.file.name, width, height);
        developedPhotos.push({ dataUrl: enhancedUrl, mime });
        if(usedOriginal) showToast('Frame added with the original image; enhancement was unavailable.');
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
  function isHeic(file){
    return /image\/(heic|heif)/i.test(file.type || '') || HEIC_FILENAME.test(file.name || '');
  }

  async function prepareImageFile(file){
    if(!isHeic(file)) return file;
    if(typeof window.heic2any !== 'function'){
      throw new Error('The HEIC converter did not load. Check the network connection and retry.');
    }
    // Convert locally—nothing is uploaded for this step—then send the JPEG
    // through the same high-resolution enhancement path as every other photo.
    const converted = await window.heic2any({ blob:file, toType:'image/jpeg', quality:0.96 });
    const jpegBlob = Array.isArray(converted) ? converted[0] : converted;
    if(!(jpegBlob instanceof Blob) || !jpegBlob.size) throw new Error('Could not convert HEIC image');
    const baseName = file.name.replace(HEIC_FILENAME, '') || 'photo';
    return new File([jpegBlob], `${baseName}.jpg`, {
      type:'image/jpeg',
      lastModified:file.lastModified || Date.now()
    });
  }

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
    const { img, dataUrl } = await loadImage(file);
    let { width, height } = img;
    const longSide = Math.max(width, height);

    // Export every frame at an HD-ready size. Small uploads are upscaled to
    // at least 1920px on the long edge; very large uploads are kept detailed
    // without creating a browser-freezing canvas.
    const targetLongSide = Math.max(1920, Math.min(2560, longSide));
    let scale = targetLongSide / longSide;
    const MAX_OUTPUT_PIXELS = 8 * 1024 * 1024;
    if(width * height * scale * scale > MAX_OUTPUT_PIXELS){
      scale = Math.sqrt(MAX_OUTPUT_PIXELS / (width * height));
    }
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));

    try{
      // original preview (same size, for a fair before/after comparison)
      const origCanvas = document.createElement('canvas');
      origCanvas.width = w; origCanvas.height = h;
      const origCtx = origCanvas.getContext('2d');
      origCtx.imageSmoothingEnabled = true;
      origCtx.imageSmoothingQuality = 'high';
      origCtx.drawImage(img, 0, 0, w, h);
      const originalUrl = origCanvas.toDataURL('image/jpeg', 0.96);

      // Enhanced version: draw at a higher-res target, then process pixels.
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.filter = 'contrast(1.02) saturate(1.035) brightness(1)';
      ctx.drawImage(img, 0, 0, w, h);
      ctx.filter = 'none';

      const imageData = ctx.getImageData(0, 0, w, h);
      autoWhiteBalance(imageData);
      autoLevels(imageData);
      liftShadowsAndPop(imageData);
      applyFilmTone(imageData);
      sharpen(imageData, 0.20);
      ctx.putImageData(imageData, 0, 0);

      const enhancedUrl = canvas.toDataURL('image/jpeg', 0.98);
      return { originalUrl, enhancedUrl, mime:'image/jpeg', width:w, height:h, usedOriginal:false };
    }catch(error){
      // A valid image can still fail pixel access due to browser canvas limits.
      // Retain it rather than dropping its frame from the roll.
      console.warn('Enhancement unavailable; keeping original image.', error);
      return { originalUrl:dataUrl, enhancedUrl:dataUrl, mime:file.type || 'image/jpeg', width, height, usedOriginal:true };
    }
  }

  function clampByte(v){ return v<0 ? 0 : v>255 ? 255 : v; }

  // A subtle gray-world white balance correction removes common indoor color
  // casts while limiting the correction so intentional warm/cool scenes keep
  // their character.
  function autoWhiteBalance(imageData){
    const data = imageData.data;
    let rTotal=0, gTotal=0, bTotal=0, count=0;
    for(let i=0; i<data.length; i+=4){
      const lum = .299*data[i] + .587*data[i+1] + .114*data[i+2];
      if(lum > 20 && lum < 235){
        rTotal += data[i]; gTotal += data[i+1]; bTotal += data[i+2]; count++;
      }
    }
    if(!count) return;
    const average = (rTotal + gTotal + bTotal) / (3*count);
    const limit = value => Math.max(.97, Math.min(1.03, value));
    const rScale = limit(average / (rTotal/count));
    const gScale = limit(average / (gTotal/count));
    const bScale = limit(average / (bTotal/count));
    for(let i=0; i<data.length; i+=4){
      data[i] = clampByte(data[i] * rScale);
      data[i+1] = clampByte(data[i+1] * gScale);
      data[i+2] = clampByte(data[i+2] * bScale);
    }
  }

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
    const total = w*h, clip = total*0.001;
    const strength = 0.45;
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
      const r = (data[i]-rl) * 255/(rh-rl);
      const g = (data[i+1]-gl) * 255/(gh-gl);
      const b = (data[i+2]-bl) * 255/(bh-bl);
      data[i]   = clampByte(data[i]   * (1-strength) + r * strength);
      data[i+1] = clampByte(data[i+1] * (1-strength) + g * strength);
      data[i+2] = clampByte(data[i+2] * (1-strength) + b * strength);
    }
  }

  // Gently lifts shadows/midtones (gamma) and boosts saturation around
  // each pixel's own luminance, for a "more light, more pop" look.
  function liftShadowsAndPop(imageData){
    const data = imageData.data;
    const gamma = 0.98, sat = 1.025, lift = 1;
    for(let i=0; i<data.length; i+=4){
      let r = 255*Math.pow(data[i]/255, gamma) + lift;
      let g = 255*Math.pow(data[i+1]/255, gamma) + lift;
      let b = 255*Math.pow(data[i+2]/255, gamma) + lift;
      // Softly compress the very brightest values instead of clipping them.
      r = r > 235 ? 235 + (r-235)*.72 : r;
      g = g > 235 ? 235 + (g-235)*.72 : g;
      b = b > 235 ? 235 + (b-235)*.72 : b;
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
          const difference = sum - src[idx];
          // Apply most sharpening to real edges and very little to flat areas,
          // which keeps skin, skies, and low-light regions from becoming noisy.
          const edgeStrength = Math.min(1, Math.abs(difference) / 20);
          data[idx] = src[idx] + difference*amount*edgeStrength;
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
          // Exposure stops and a restrained tone curve behave more naturally
          // than a flat brightness multiplier, especially in highlights.
          const exposure = Math.pow(2, amount / 120);
          const contrast = 1 + Math.abs(amount) / 550;
          const intercept = 128*(1-contrast);
          for(let i=0; i<data.length; i+=4){
            let r = data[i]*exposure;
            let g = data[i+1]*exposure;
            let b = data[i+2]*exposure;
            // Roll off bright tones before contrast to protect skies and skin.
            r = 255*(1-Math.exp(-r/255*1.35));
            g = 255*(1-Math.exp(-g/255*1.35));
            b = 255*(1-Math.exp(-b/255*1.35));
            r = clampByte(r*contrast + intercept);
            g = clampByte(g*contrast + intercept);
            b = clampByte(b*contrast + intercept);
            data[i] = r; data[i+1] = g; data[i+2] = b;
          }
          ctx.putImageData(id,0,0);
          const out = canvas.toDataURL('image/jpeg',0.98);
          resolve(out);
        }catch(err){ reject(err); }
      };
      img.onerror = ()=> reject(new Error('Could not decode image for lighting adjust'));
      img.src = dataUrl;
    });
  }

  // ---------- contact sheet cards ----------
  function addCard(num, originalUrl, enhancedUrl, mime, filename, width, height){
    if(emptyNote) emptyNote.style.display = 'none';
    if(frameCountEl) frameCountEl.textContent = num;

    const card = document.createElement('div');
    card.className = 'frame-card';
    card.dataset.filename = filename.replace(/\.[^.]+$/, '') || ('frame-' + num);
    // Keep the comparison frame aligned to the source photo. A fixed 4:3
    // frame cropped portrait, square, and panoramic uploads via object-fit.
    if(width > 0 && height > 0) card.style.setProperty('--photo-aspect-ratio', `${width} / ${height}`);

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

    // Download the current enhanced image, including any later lighting edits.
    card.querySelector('.download-btn').addEventListener('click', ()=>{
      const a = document.createElement('a');
      a.href = card._enhancedUrl;
      a.download = card.dataset.filename + '-enhanced.jpg';
      a.click();
      showToast('HD image saved.');
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

  async function requestGroupSong(batchId = activeBatchId, existingCaption = ''){
    const photos = developedPhotos.slice();
    if(!photos.length) return;
    if(mixtapeRegenBtn) mixtapeRegenBtn.style.display = 'none';
    if(mixtape) mixtape.style.display = 'flex';
    mixtapeBody.innerHTML = `
      <p class="mixtape-eyebrow">soundtrack for this roll</p>
      <div class="mixtape-loading"><span class="dot">●</span><span class="dot">●</span><span class="dot">●</span> writing a caption and picking a song for this ${photos.length === 1 ? 'photo' : 'set'}</div>
    `;
    try{
      const { caption, hashtags, song, artist, reason, preview } = await getGroupSong(pickSample(photos, MAX_PHOTOS_FOR_SONG), captionDirection, existingCaption);
      if(batchId !== activeBatchId) return;
      mixtapeBody.innerHTML = `
        <p class="mixtape-eyebrow">caption + soundtrack · ${photos.length} photo${photos.length===1?'':'s'}</p>
        <textarea class="caption-box roll-caption" aria-label="Group caption" spellcheck="false">${escapeHtml(caption)}</textarea>
        <div class="caption-style-control">
          <label for="captionDirection">Modify caption</label>
          <input id="captionDirection" class="caption-style-input" type="text" maxlength="160" placeholder="e.g. make it funnier, shorter, or more romantic">
          <button class="btn caption-style-btn" type="button">Apply suggestion</button>
        </div>
        <div class="hashtags">${escapeHtml(hashtags)}</div>
        <p class="mixtape-song">${escapeHtml(song)} <span class="artist">— ${escapeHtml(artist)}</span></p>
        <div class="music-player" ${preview ? '' : 'hidden'}>
          <span class="preview-label">30 sec preview · courtesy of iTunes</span>
          <audio class="song-preview" controls preload="none"></audio>
          <a class="preview-link" target="_blank" rel="noopener">Open song</a>
        </div>
        <p class="mixtape-reason">${escapeHtml(reason)}</p>
      `;
      const directionInput = mixtapeBody.querySelector('.caption-style-input');
      const directionButton = mixtapeBody.querySelector('.caption-style-btn');
      directionInput.value = captionDirection;
      directionButton.addEventListener('click', ()=>{
        captionDirection = directionInput.value.trim().slice(0, 160);
        const currentCaption = mixtapeBody.querySelector('.roll-caption').value.trim();
        requestGroupSong(activeBatchId, currentCaption);
      });
      directionInput.addEventListener('keydown', event => {
        if(event.key === 'Enter'){
          event.preventDefault();
          directionButton.click();
        }
      });
      if(preview){
        const audio = mixtapeBody.querySelector('.song-preview');
        const link = mixtapeBody.querySelector('.preview-link');
        audio.src = preview.previewUrl;
        if(preview.trackUrl) link.href = preview.trackUrl;
        else link.hidden = true;
      }
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

  async function getGroupSong(photos, direction = '', existingCaption = ''){
    // Groq limits the number of direct vision inputs. A single contact-sheet
    // image lets one request reflect every photo in a roll of up to ten.
    const images = [await createAnalysisCollage(photos)];
    const response = await fetch('/api/roll-insights', {
      method: 'POST', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ images, captionPreference: direction, existingCaption })
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

  // Cinematic film treatment: matte blacks, warm highlights, cool shadows,
  // and a soft edge vignette. The grade is intentionally restrained so faces
  // remain natural while uploads gain a polished photography look.
  function applyFilmTone(imageData){
    const { data, width:w, height:h } = imageData;
    const cx = (w - 1) / 2, cy = (h - 1) / 2;
    const maxDist = Math.sqrt(cx*cx + cy*cy) || 1;
    for(let y=0; y<h; y++){
      for(let x=0; x<w; x++){
      const i = (y*w + x)*4;
      let r = data[i], g = data[i+1], b = data[i+2];
      const lum = 0.299*r + 0.587*g + 0.114*b;
      const shadow = Math.max(0, (105-lum)/105);
      const highlight = Math.max(0, (lum-150)/105);
      // Lift black point slightly, cool the shadows, and add amber warmth to highlights.
      r = r*0.99 + 1.2 + 2.2*highlight - .7*shadow;
      g = g*0.99 + .8 + .9*highlight + .3*shadow;
      b = b*0.99 + 1 + 1.2*shadow - 1.0*highlight;
      const tonedLum = 0.299*r + 0.587*g + 0.114*b;
      const saturation = 1.015;
      const vignette = 1 - 0.055*Math.pow(Math.sqrt((x-cx)*(x-cx) + (y-cy)*(y-cy))/maxDist, 1.65);
      data[i] = clampByte((tonedLum + (r-tonedLum)*saturation) * vignette);
      data[i+1] = clampByte((tonedLum + (g-tonedLum)*saturation) * vignette);
      data[i+2] = clampByte((tonedLum + (b-tonedLum)*saturation) * vignette);
      }
    }
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
