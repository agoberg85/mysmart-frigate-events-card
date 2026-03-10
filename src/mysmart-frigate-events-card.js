import { LitElement, html, css } from 'lit';
import Hls from 'hls.js';

class FrigateNativeCard extends LitElement {
  static get properties() {
    return {
      hass: {},
      config: {},
      _clips: { state: true },
      _allClips: { state: true },
      _thumbnails: { state: true },
      _selectedClip: { state: true },
      _videoUrl: { state: true },
      _error: { state: true },
      _loading: { state: true },
      _videoError: { state: true },
      _activeCameras: { state: true },
      _visibleClips: { state: true },
      _showCameraMenu: { state: true },
      _showLabelMenu: { state: true },
      _activeLabels: { state: true },
      _loadedClipsPerCamera: { state: true }
    };
  }

  constructor() {
    super();
    this._thumbnailUrls = new Map();
    this._intersectionObserver = null;
    this._videoErrorHandler = null;
    this._cameraToggleTimeout = null;
    this._visibleClips = new Set();
    this._allClips = [];
    this._fetchAbortController = null;
    this._thumbnailLoadQueue = new Set();
    this._showCameraMenu = false;
    this._showLabelMenu = false;
    this._activeLabels = new Set();
    this._loadedClipsPerCamera = {};
  }

  setConfig(config) {
    if (!config.entity && !config.entities) {
      throw new Error('Please define "entities" (list of cameras)');
    }
    this.config = {
      limit: 50,
      columns: 3,
      title: 'Security Feed',
      virtualScrolling: true,
      card_height: '',
      clipsPerLoad: 10,
      ...config
    };
    this._thumbnails = {};
    this._allClips = [];
    const cams = this.getTargetCameras();
    this._activeCameras = new Set(cams);

    // Initialize clips loaded count
    cams.forEach(cam => {
      this._loadedClipsPerCamera[cam] = this.config.clipsPerLoad;
    });
  }

  getTargetCameras() {
    let list = [];
    if (this.config.entities) list = this.config.entities;
    else if (this.config.entity) list = [this.config.entity];

    return list.map(name => {
      const clean = name.includes('.') ? name.split('.').pop() : name;
      return clean.toLowerCase();
    });
  }

  // Extract labels from clip titles
  extractLabels(clips) {
    const labels = new Set();
    clips.forEach(clip => {
      const title = clip.title.toLowerCase();
      // Common Frigate labels - extend this list as needed
      const knownLabels = ['person', 'car', 'dog', 'cat', 'crying', 'package', 'vehicle', 'bicycle', 'bird'];
      knownLabels.forEach(label => {
        if (title.includes(label)) {
          labels.add(label);
        }
      });
    });
    return Array.from(labels).sort();
  }

  async fetchMedia(isRefresh = false) {
    if (this._fetchAbortController) {
      this._fetchAbortController.abort();
    }
    this._fetchAbortController = new AbortController();

    this._loading = true;
    this._error = null;

    try {
      const targetCams = this.getTargetCameras();
      let allClips = [];

      const root = await this.hass.callWS({ type: 'media_source/browse_media', media_content_id: 'media-source://frigate' });
      if (!root.children || root.children.length === 0) throw new Error("Frigate Media Source empty.");
      const instance = root.children[0];

      const instanceRoot = await this.hass.callWS({ type: 'media_source/browse_media', media_content_id: instance.media_content_id });

      let eventsFolder = instanceRoot.children?.find(c => {
        const t = c.title.toLowerCase();
        return t.includes('event') || t.includes('clip') || t.includes('review');
      });

      let potentialCameraFolders = eventsFolder ? [] : (instanceRoot.children || []);

      if (eventsFolder) {
        const eventsContent = await this.hass.callWS({ type: 'media_source/browse_media', media_content_id: eventsFolder.media_content_id });
        potentialCameraFolders = eventsContent.children || [];
      }

      for (const folder of potentialCameraFolders) {
        const cleanTitle = folder.title.toLowerCase().replace(/\s*\(\d+\)$/, "");
        if (targetCams.includes(cleanTitle)) {
          const cameraClips = [];
          const limit = this._loadedClipsPerCamera[cleanTitle] || this.config.clipsPerLoad;
          await this.fetchClipsFromCameraFolder(folder, cameraClips, limit);
          cameraClips.forEach(c => c._camera = cleanTitle);
          allClips = allClips.concat(cameraClips);
        }
      }

      this.cleanupUnusedThumbnails(allClips);
      this._allClips = allClips;

      // Extract and set available labels
      const availableLabels = this.extractLabels(allClips);
      if (this._activeLabels.size === 0 && availableLabels.length > 0) {
        this._activeLabels = new Set(availableLabels);
      }

      this.updateDisplayedClips();

      if (!this.config.virtualScrolling) {
        this.loadThumbnailsBatch();
      }

    } catch (e) {
      if (e.name !== 'AbortError') {
        console.error('[FrigateCard] Media fetch error:', e);
        this._error = e.message;
      }
    } finally {
      this._loading = false;
      this._fetchAbortController = null;
    }
  }

  cleanupUnusedThumbnails(currentClips) {
    const currentIds = new Set(currentClips.map(c => c.media_content_id));
    const thumbnailIds = Object.keys(this._thumbnails);

    for (const id of thumbnailIds) {
      if (!currentIds.has(id)) {
        const url = this._thumbnailUrls.get(id);
        if (url) {
          URL.revokeObjectURL(url);
          this._thumbnailUrls.delete(id);
        }
        delete this._thumbnails[id];
      }
    }
    if (thumbnailIds.length !== Object.keys(this._thumbnails).length) {
      this.requestUpdate('_thumbnails');
    }
  }

  updateDisplayedClips() {
    if (!this._allClips) return;

    const filtered = this._allClips.filter(clip => {
      if (!clip._camera || !this._activeCameras.has(clip._camera)) return false;

      // Label filtering
      if (this._activeLabels.size > 0) {
        const title = clip.title.toLowerCase();
        const hasActiveLabel = Array.from(this._activeLabels).some(label =>
          title.includes(label.toLowerCase())
        );
        if (!hasActiveLabel) return false;
      }

      return true;
    });

    filtered.sort((a, b) => b.title.localeCompare(a.title));
    this._clips = filtered;
  }

  async fetchClipsFromCameraFolder(folder, collection, limit = Infinity) {
    const content = await this.hass.callWS({ type: 'media_source/browse_media', media_content_id: folder.media_content_id });
    if (!content.children || content.children.length === 0) return;

    const isDateStructure = content.children[0].can_expand;

    if (isDateStructure) {
      const sortedFolders = content.children.sort((a, b) => b.title.localeCompare(a.title));
      for (const dateFolder of sortedFolders) {
        if (collection.length >= limit) break;
        const dateContent = await this.hass.callWS({ type: 'media_source/browse_media', media_content_id: dateFolder.media_content_id });
        if (dateContent.children) {
          const sortedClips = dateContent.children.sort((a, b) => b.title.localeCompare(a.title));
          for (const c of sortedClips) {
            if (collection.length >= limit) break;
            if (!c.can_expand) collection.push(c);
          }
        }
      }
    } else {
      const sortedClips = content.children.sort((a, b) => b.title.localeCompare(a.title));
      for (const c of sortedClips) {
        if (collection.length >= limit) break;
        if (!c.can_expand) collection.push(c);
      }
    }
  }

  async loadThumbnailsBatch() {
    if (!this._clips) return;
    const clipsToLoad = this._clips.filter(clip =>
      !this._thumbnails[clip.media_content_id] &&
      !this._thumbnailLoadQueue.has(clip.media_content_id)
    );
    const concurrencyLimit = 5;
    for (let i = 0; i < clipsToLoad.length; i += concurrencyLimit) {
      const batch = clipsToLoad.slice(i, i + concurrencyLimit);
      await Promise.all(batch.map(clip => this.loadSingleThumbnail(clip)));
    }
  }

  async loadSingleThumbnail(clip) {
    const id = clip.media_content_id;

    if (this._thumbnails[id] || this._thumbnailLoadQueue.has(id)) return;

    this._thumbnailLoadQueue.add(id);

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);

      const res = await window.fetch(clip.thumbnail, {
        headers: { 'Authorization': `Bearer ${this.hass?.auth?.data?.access_token || ''}` },
        signal: controller.signal
      });

      clearTimeout(timeout);

      if (res.ok) {
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        this._thumbnailUrls.set(id, url);

        this._thumbnails[id] = url;
        this.requestUpdate('_thumbnails');
      } else {
        console.warn(`[FrigateCard] Thumbnail failed for ${clip.title}: ${res.status}`);
      }
    } catch (e) {
      if (e.name !== 'AbortError') {
        console.warn(`[FrigateCard] Thumbnail error for ${clip.title}:`, e.message);
      }
    } finally {
      this._thumbnailLoadQueue.delete(id);
    }
  }

  async updated(changedProps) {
    if (changedProps.has('hass') && !this._clips && !this._loading) {
      this.fetchMedia();
    }
    if (this._selectedClip && this._videoUrl && changedProps.has('_videoUrl')) {
      await this.updateComplete;
      this.initPlayer();
      // Scroll video into view
      this.scrollPlayerIntoView();
    }
    if (changedProps.has('_clips') && this.config.virtualScrolling) {
      this.setupIntersectionObserver();
    }
  }

  scrollPlayerIntoView() {
    this.updateComplete.then(() => {
      const playerEl = this.shadowRoot.querySelector('.player-full-row');
      if (playerEl) {
        playerEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    });
  }

  setupIntersectionObserver() {
    if (this._intersectionObserver) {
      this._intersectionObserver.disconnect();
      this._intersectionObserver = null;
    }

    this._intersectionObserver = new IntersectionObserver(
      (entries) => {
        let needsUpdate = false;
        entries.forEach(entry => {
          const clipId = entry.target.dataset.clipId;
          if (entry.isIntersecting) {
            if (!this._visibleClips.has(clipId)) {
              this._visibleClips.add(clipId);
              needsUpdate = true;
            }
            const clip = this._clips?.find(c => c.media_content_id === clipId);
            if (clip && !this._thumbnails[clipId] && !this._thumbnailLoadQueue.has(clipId)) {
              this.loadSingleThumbnail(clip);
            }
          } else {
            if (this._visibleClips.has(clipId)) {
              this._visibleClips.delete(clipId);
              needsUpdate = true;
            }
          }
        });
        if (needsUpdate) {
          this.requestUpdate();
        }
      },
      { root: null, rootMargin: '200px', threshold: 0.01 }
    );

    this.updateComplete.then(() => {
      this.shadowRoot.querySelectorAll('.thumbnail').forEach(el => {
        this._intersectionObserver.observe(el);
      });
    });
  }

  initPlayer() {
    const videoEl = this.shadowRoot.querySelector('video');
    if (!videoEl || !this._videoUrl) return;

    if (this._hls) {
      this._hls.destroy();
      this._hls = null;
    }
    if (this._videoErrorHandler) {
      videoEl.removeEventListener('error', this._videoErrorHandler);
    }

    videoEl.removeAttribute('src');
    videoEl.load();

    this._videoErrorHandler = (e) => {
      if (!this._hls) {
        this._videoError = "Playback Failed. Check connection/codec.";
      }
    };
    videoEl.addEventListener('error', this._videoErrorHandler);

    let authUrl = this._videoUrl;
    if (this._videoUrl && this.hass?.auth?.data?.access_token) {
      const separator = this._videoUrl.includes('?') ? '&' : '?';
      authUrl = `${this._videoUrl}${separator}authSig=${this.hass.auth.data.access_token}`;
    }

    if (Hls.isSupported()) {
      this._hls = new Hls({
        maxMaxBufferLength: 30,
        maxBufferSize: 60 * 1000 * 1000,
        maxBufferLength: 30
      });
      this._hls.loadSource(authUrl);
      this._hls.attachMedia(videoEl);
      this._hls.on(Hls.Events.ERROR, (event, data) => {
        if (data.fatal) {
          console.warn("[FrigateCard] HLS Fatal Error:", data.type, data.details);
          this._videoError = `HLS Error: ${data.details}`;
          this._hls.destroy();
          this._hls = null;
          videoEl.src = authUrl;
        }
      });
    } else if (videoEl.canPlayType('application/vnd.apple.mpegurl')) {
      videoEl.src = authUrl;
    } else {
      videoEl.src = authUrl;
    }
  }

  async openClip(clip) {
    if (this._selectedClip && this._selectedClip.media_content_id === clip.media_content_id) {
      this.closeClip();
      return;
    }
    this._selectedClip = clip;
    this._videoUrl = null;
    this._videoError = null;
    try {
      const result = await this.hass.callWS({
        type: 'media_source/resolve_media',
        media_content_id: clip.media_content_id
      });
      this._videoUrl = result.url;
    } catch (e) {
      this._videoError = `Could not resolve video: ${e.message}`;
    }
  }

  closeClip() {
    const videoEl = this.shadowRoot.querySelector('video');
    if (videoEl) {
      if (this._videoErrorHandler) {
        videoEl.removeEventListener('error', this._videoErrorHandler);
        this._videoErrorHandler = null;
      }
      videoEl.pause();
      videoEl.removeAttribute('src');
      videoEl.load();
    }

    if (this._hls) {
      this._hls.destroy();
      this._hls = null;
    }

    this._selectedClip = null;
    this._videoUrl = null;
    this._videoError = null;
  }

  toggleCamera(camName) {
    if (this._activeCameras.has(camName)) {
      this._activeCameras.delete(camName);
    } else {
      this._activeCameras.add(camName);
    }

    this._activeCameras = new Set(this._activeCameras);
    this.updateDisplayedClips();

    if (this._cameraToggleTimeout) clearTimeout(this._cameraToggleTimeout);
    this._cameraToggleTimeout = setTimeout(() => {
      if (this.config.virtualScrolling) this.setupIntersectionObserver();
    }, 300);
  }

  toggleLabel(label) {
    if (this._activeLabels.has(label)) {
      this._activeLabels.delete(label);
    } else {
      this._activeLabels.add(label);
    }

    this._activeLabels = new Set(this._activeLabels);
    this.updateDisplayedClips();

    if (this._cameraToggleTimeout) clearTimeout(this._cameraToggleTimeout);
    this._cameraToggleTimeout = setTimeout(() => {
      if (this.config.virtualScrolling) this.setupIntersectionObserver();
    }, 300);
  }

  handleRefresh() {
    this.fetchMedia(true);
  }

  handleLoadMore() {
    const cams = this.getTargetCameras();
    cams.forEach(cam => {
      this._loadedClipsPerCamera[cam] = (this._loadedClipsPerCamera[cam] || this.config.clipsPerLoad) + this.config.clipsPerLoad;
    });
    this.fetchMedia();
  }

  toggleCameraMenu() {
    this._showCameraMenu = !this._showCameraMenu;
    if (this._showCameraMenu) this._showLabelMenu = false;
  }

  toggleLabelMenu() {
    this._showLabelMenu = !this._showLabelMenu;
    if (this._showLabelMenu) this._showCameraMenu = false;
  }

  disconnectedCallback() {
    super.disconnectedCallback();

    this._thumbnailUrls.forEach(url => URL.revokeObjectURL(url));
    this._thumbnailUrls.clear();

    if (this._hls) {
      this._hls.destroy();
      this._hls = null;
    }

    if (this._intersectionObserver) {
      this._intersectionObserver.disconnect();
      this._intersectionObserver = null;
    }

    if (this._cameraToggleTimeout) {
      clearTimeout(this._cameraToggleTimeout);
      this._cameraToggleTimeout = null;
    }

    if (this._fetchAbortController) {
      this._fetchAbortController.abort();
      this._fetchAbortController = null;
    }

    const videoEl = this.shadowRoot?.querySelector('video');
    if (videoEl && this._videoErrorHandler) {
      videoEl.removeEventListener('error', this._videoErrorHandler);
    }
  }

  render() {
    if (this._error) return html`<ha-card style="padding:16px; background:#550000; color:white;">${this._error}</ha-card>`;

    const visibleClips = this._clips || [];
    const cams = this.getTargetCameras();
    const columns = this.config.columns || 3;
    const cardHeight = this.config.card_height;
    const availableLabels = this.extractLabels(this._allClips || []);

    const itemsToRender = [];
    let selectedIndex = -1;

    if (this._selectedClip) {
      selectedIndex = visibleClips.findIndex(c => c.media_content_id === this._selectedClip.media_content_id);
    }

    let insertionIndex = -1;
    if (selectedIndex !== -1) {
      const rowEnd = Math.ceil((selectedIndex + 1) / columns) * columns;
      insertionIndex = Math.min(rowEnd, visibleClips.length);
    }

    let playerRendered = false;

    visibleClips.forEach((clip, index) => {
      itemsToRender.push(this.renderThumbnail(clip));
      if (index === insertionIndex - 1) {
        itemsToRender.push(this.renderPlayer());
        playerRendered = true;
      }
    });

    if (selectedIndex !== -1 && !playerRendered) {
      itemsToRender.push(this.renderPlayer());
    }

    const scrollerStyle = cardHeight ? `height: ${cardHeight}; overflow-y: auto;` : '';
    const activeCamCount = this._activeCameras.size;
    const activeLabelCount = this._activeLabels.size;

    return html`
      <ha-card>
        <div class="header">
          <div class="title-row">
            <div class="title">${this.config.title}</div>
            <div class="action-buttons">
              ${availableLabels.length > 0 ? html`
                <button class="icon-btn ${this._showLabelMenu ? 'active' : ''}" @click=${this.toggleLabelMenu} title="Filter by label">
                  <ha-icon icon="mdi:filter-variant"></ha-icon>
                  ${activeLabelCount < availableLabels.length ? html`<span class="badge">${activeLabelCount}</span>` : ''}
                </button>
              ` : ''}
              ${cams.length > 1 ? html`
                <button class="icon-btn ${this._showCameraMenu ? 'active' : ''}" @click=${this.toggleCameraMenu} title="Select cameras">
                  <ha-icon icon="mdi:cctv"></ha-icon>
                  ${activeCamCount < cams.length ? html`<span class="badge">${activeCamCount}</span>` : ''}
                </button>
              ` : ''}
              <button class="icon-btn" @click=${this.handleRefresh} title="Refresh clips" ?disabled=${this._loading}>
                <ha-icon icon="mdi:refresh" class="${this._loading ? 'spinning' : ''}"></ha-icon>
              </button>
            </div>
          </div>

          ${this._showCameraMenu ? html`
            <div class="menu-panel">
              <div class="menu-title">Cameras</div>
              <div class="filters">
                ${cams.map(cam => html`
                  <button 
                    class="chip ${this._activeCameras.has(cam) ? 'active' : ''}"
                    @click=${() => this.toggleCamera(cam)}
                  >
                    ${cam}
                  </button>
                `)}
              </div>
            </div>
          ` : ''}

          ${this._showLabelMenu ? html`
            <div class="menu-panel">
              <div class="menu-title">Labels</div>
              <div class="filters">
                ${availableLabels.map(label => html`
                  <button 
                    class="chip ${this._activeLabels.has(label) ? 'active' : ''}"
                    @click=${() => this.toggleLabel(label)}
                  >
                    ${label}
                  </button>
                `)}
              </div>
            </div>
          ` : ''}
        </div>

        <div class="scroller" style="${scrollerStyle}">
          <div class="grid-container" style="--column-count: ${columns}">
            ${!this._clips ? html`<div class="loading-text">Loading...</div>` : ''}
            ${this._clips && visibleClips.length === 0 ? html`<div class="empty-state">No clips found.</div>` : ''}
            ${itemsToRender}
          </div>

          ${this._clips && visibleClips.length > 0 ? html`
            <div class="load-more-container">
              <button class="load-more-btn" @click=${this.handleLoadMore} ?disabled=${this._loading}>
                ${this._loading ? 'Loading...' : 'Load More Clips'}
              </button>
            </div>
          ` : ''}
        </div>
      </ha-card>
    `;
  }

  renderThumbnail(clip) {
    const thumbUrl = this._thumbnails[clip.media_content_id];
    const isSelected = this._selectedClip && this._selectedClip.media_content_id === clip.media_content_id;
    return html`
      <div 
        class="thumbnail ${isSelected ? 'selected' : ''}" 
        data-clip-id="${clip.media_content_id}"
        @click=${() => this.openClip(clip)}
      >
        ${thumbUrl ?
        html`<img src="${thumbUrl}" loading="lazy" alt="${clip.title}" />` :
        html`<div class="loading-thumb"></div>`
      }
        <div class="badge-bottom">${clip.title}</div>
      </div>
    `;
  }

  renderPlayer() {
    if (!this._selectedClip) return html``;
    return html`
      <div class="player-full-row">
        <div class="player-wrapper">
          <div class="player-info">
            <span>${this._selectedClip.title}</span>
            <button class="close-btn" @click=${this.closeClip} aria-label="Close video">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>              
            </button>
          </div>
          
          <div class="video-box">
            ${this._videoUrl ? html`
              <video 
                autoplay 
                loop 
                muted 
                playsinline 
                controls
              ></video>
            ` : html`<div class="spinner">Loading...</div>`}

            ${this._videoError ? html`
              <div class="error-overlay">
                <p>⚠️ ${this._videoError}</p>
                <div class="error-details">
                   If on Linux/LibreWolf, you may be missing codecs (H.265/HLS).
                </div>
                ${!this._videoError.includes("H.265") && this._videoUrl ? html`
                  <a href="${this._videoUrl}" download="${this._selectedClip.title}.mp4" target="_blank" class="dl-btn">Download File</a>
                ` : ''}
              </div>
            ` : ''}
          </div>
        </div>
      </div>
    `;
  }

  static get styles() {
    return css`
      :host { display: block; --active-color: var(--primary-color, #03a9f4); }
      ha-card { overflow: hidden; background: var(--ha-card-background, #1c1c1c); }

      .header { padding: 16px; display: flex; flex-direction: column; gap: 12px; }
      
      .title-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 12px;
      }
      
      .title { 
        font-size: 18px; 
        font-weight: 500; 
        color: var(--primary-text-color);
        flex: 1;
      }

      .action-buttons {
        display: flex;
        gap: 8px;
        align-items: center;
      }

      .icon-btn {
        position: relative;
        background: var(--gray200, rgba(128,128,128,0.2));
        border: none;
        border-radius: 50%;
        width: 40px;
        height: 40px;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        transition: all 0.2s;
        color: var(--primary-text-color);
      }

      .icon-btn:hover:not(:disabled) {
        background: var(--gray300, rgba(128,128,128,0.3));
      }

      .icon-btn.active {
        background: var(--active-big);
        color: var(--gray100, white);
      }

      .icon-btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .icon-btn .badge {
        position: absolute;
        top: -4px;
        right: -4px;
        background: var(--error-color, #f44336);
        color: white;
        border-radius: 10px;
        padding: 2px 6px;
        font-size: 10px;
        font-weight: 600;
        min-width: 16px;
        text-align: center;
      }

      @keyframes spin {
        from { transform: rotate(0deg); }
        to { transform: rotate(360deg); }
      }

      .spinning {
        animation: spin 1s linear infinite;
      }

      .menu-panel {
        background: var(--gray100, rgba(128,128,128,0.1));
        border-radius: 12px;
        padding: 0;
        animation: slideDown 0.2s ease-out;
      }

      .menu-title {
        font-size: 12px;
        font-weight: 600;
        color: var(--secondary-text-color);
        margin-bottom: 8px;
        text-transform: uppercase;
        letter-spacing: 0.5px;
      }

      @keyframes slideDown {
        from {
          opacity: 0;
          transform: translateY(-10px);
        }
        to {
          opacity: 1;
          transform: translateY(0);
        }
      }

      .filters { display: flex; gap: 8px; flex-wrap: wrap; }
      
      .chip {
        background: var(--gray200, rgba(128,128,128,0.2));
        border: none;
        border-radius: 16px;
        padding: 6px 12px;
        color: var(--gray1000, inherit);
        font-size: 12px;
        font-weight: 500;
        cursor: pointer;
        transition: all 0.2s;
        text-transform: capitalize;
      }
      .chip.active { background: var(--active-big); color: var(--gray100, white);}
      .chip:hover { opacity: 0.8; }

      .scroller {
        scrollbar-width: thin;
        scrollbar-color: rgba(128,128,128,0.5) transparent;
      }
      .scroller::-webkit-scrollbar { width: 6px; }
      .scroller::-webkit-scrollbar-track { background: transparent; }
      .scroller::-webkit-scrollbar-thumb { background-color: rgba(128,128,128,0.5); border-radius: 3px; }

      .grid-container { 
        display: grid; 
        grid-template-columns: repeat(var(--column-count), 1fr); 
        gap: 8px; 
        padding: 0 16px 16px 16px;
      }
      
      .thumbnail { 
        position: relative; cursor: pointer; aspect-ratio: 16/9; background: #2a2a2a; border-radius: 12px; overflow: hidden; 
        border: 3px solid transparent; transition: border 0.2s;
      }
      .thumbnail.selected { border-color: rgb(242, 133, 201); opacity: 0.7; }
      .thumbnail img { width: 100%; height: 100%; object-fit: cover; animation: fade-in 0.3s; }
      .badge-bottom { 
        position: absolute; bottom: 0; left: 0; width: 100%; background: rgba(0,0,0,0.7); color: white; 
        font-size: 10px; padding: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; 
      }

      .player-full-row {
        grid-column: 1 / -1;
        background: var(--active-big, #000);
        border-radius: 20px;
        overflow: hidden;
        margin-top: 4px;
        margin-bottom: 12px;
        animation: slide-down 0.4s ease-out;
        transform-origin: top;
      }
      
      .player-wrapper { padding: 12px; }
      .player-info { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; color: var(--gray100, #ddd); font-size: 14px; }
      .close-btn { 
        background: rgb(51, 51, 51); color: rgb(255, 255, 255); border: none; border-radius: 50%;
        cursor: pointer; width: 40px; height: 40px; padding: 0; display: flex; justify-content: center; align-items: center;
      }
      .close-btn:hover { opacity: 0.8; }
      
      .video-box { position: relative; width: 100%; aspect-ratio: 16/9; background: #000; display: flex; justify-content: center; align-items: center; border-radius: 12px; overflow: hidden; }
      video { width: 100%; height: 100%; display: block; }
      
      .spinner { color: #888; font-size: 12px; }
      .error-overlay { position: absolute; inset: 0; background: rgba(0,0,0,0.8); color: white; display: flex; flex-direction: column; justify-content: center; align-items: center; text-align: center; padding: 16px; }
      .error-details { font-size: 11px; margin-top: 8px; opacity: 0.7; }
      .dl-btn { margin-top: 10px; background: #333; color: white; padding: 6px 12px; border-radius: 4px; text-decoration: none; font-size: 12px; }
      .dl-btn:hover { background: #444; }

      .loading-text, .empty-state { grid-column: 1/-1; text-align: center; padding: 20px; color: var(--secondary-text-color); }
      .loading-thumb { width: 100%; height: 100%; background: #333; opacity: 0.1; }

      .load-more-container {
        display: flex;
        justify-content: center;
        padding: 16px;
      }

      .load-more-btn {
        background: var(--gray200);
        border: none;
        border-radius: 20px;
        padding: 12px 24px;
        color: var(--primary-text-color);
        font-size: 14px;
        font-weight: 500;
        cursor: pointer;
        transition: all 0.2s;
      }

      .load-more-btn:hover:not(:disabled) {
        background: var(--gray300, rgba(128,128,128,0.3));
      }

      .load-more-btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      @keyframes fade-in { from { opacity: 0; } to { opacity: 1; } }
      @keyframes slide-down { from { max-height: 0; opacity: 0; transform: scaleY(0); } to { max-height: 600px; opacity: 1; transform: scaleY(1); } }
    `;
  }
}
customElements.define('mysmart-frigate-gallery', FrigateNativeCard);
window.customCards = window.customCards || [];
window.customCards.push({ type: "mysmart-frigate-gallery", name: "MySmart Frigate Gallery", description: "Clips Gallery for your Frigate cameras" });