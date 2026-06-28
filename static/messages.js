// ===== UTILITIES =====
function getSafePic(pic) { return (pic && pic !== "unknown") ? pic : "unkown.png"; }
function escapeHtml(text) { let d = document.createElement("div"); d.textContent = text; return d.innerHTML; }
function getTimeAgo(dateStr) {
    if (!dateStr) return "";
    const d = new Date(dateStr.replace(" ", "T") + "Z"), diff = Math.floor((Date.now() - d) / 1000);
    return diff < 60 ? "now" : diff < 3600 ? Math.floor(diff / 60) + "m" : diff < 86400 ? Math.floor(diff / 3600) + "h" : Math.floor(diff / 86400) + "d";
}

// ══════════════════════════════════════════════════════════════
// 📤 CLOUDINARY UPLOAD HELPER (Required for multi-image send)
// ══════════════════════════════════════════════════════════════
async function uploadToCloudinary(file) {
    const isVideo = file.type.startsWith('video/');
    const preset = 'video_posts';
    const resourceType = isVideo ? 'video' : 'image';
    const cloudName = 'dlimysibj';
    
    const formData = new FormData();
    formData.append('file', file, file.name);
    formData.append('upload_preset', preset);
    formData.append('resource_type', resourceType);
    
    try {
        const res = await fetch(
            `https://api.cloudinary.com/v1_1/${cloudName}/${resourceType}/upload`,
            { method: 'POST', body: formData }
        );
        const data = await res.json();
        
        if (!res.ok || data.error) {
            throw new Error(data.error?.message || 'Upload failed');
        }
        return data.secure_url;
    } catch (err) {
        console.error('Cloudinary upload error:', err);
        throw err;
    }
}

// ✅ Simple toggle function - works on ALL devices
window.toggleMessageActions = function(bubble) {
    if (event.target.closest('.msg-action-btn')) return;
    const actions = bubble.querySelector('.message-actions');
    if (!actions) return;
    const isVisible = actions.style.opacity === '1';
    
    document.querySelectorAll('.message-actions').forEach(a => {
        a.style.opacity = '0';
        a.style.pointerEvents = 'none';
        a.style.transform = 'translateY(10px)';
        a.closest('.message-bubble')?.classList.remove('actions-visible');
    });
    
    if (isVisible) {
        actions.style.opacity = '0';
        actions.style.pointerEvents = 'none';
        actions.style.transform = 'translateY(10px)';
        bubble.classList.remove('actions-visible');
    } else {
        actions.style.opacity = '1';
        actions.style.pointerEvents = 'auto';
        actions.style.transform = 'translateY(0)';
        bubble.classList.add('actions-visible');
    }
    event.stopPropagation();
};

function showToast(message, type = "info", duration = 3000) {
    const container = document.getElementById("toast-container");
    if (!container) { alert(message); return; }
    const toast = document.createElement("div");
    toast.className = `toast ${type}`;
    toast.innerHTML = `<span class="toast-message">${message}</span>`;
    container.appendChild(toast);
    setTimeout(() => { toast.style.opacity = "0"; setTimeout(() => toast.remove(), 300); }, duration);
}

function cancelEdit(msgId) {
    const bubble = document.querySelector(`.message-item[data-msg-id="${msgId}"] .message-bubble`);
    if (!bubble || !bubble.dataset.original) return;
    const input = bubble.querySelector('textarea');
    if (!input) return;
    const textNode = document.createTextNode(bubble.dataset.original);
    bubble.replaceChild(textNode, input);
    delete bubble.dataset.original;
    const btnBox = bubble.querySelector('div[style*="justify-content"]');
    if (btnBox) btnBox.remove();
}

// ===== SAFE FETCH =====
async function safeFetch(url, opts = {}) {
    try {
        const res = await fetch(url, opts);
        const ct = res.headers.get("content-type");
        if (!ct || !ct.includes("application/json")) { console.error("❌ Non-JSON from", url, res.status); return null; }
        return await res.json();
    } catch (e) { console.error("❌ Fetch error:", e); return null; }
}

// ===== STATE =====
let currentReply = null;
let currentChatUser = null;
let chatPollInterval = null;
let smartRefresh = { friends: null, conversations: null, active: false };
let longPressTimer = null;
let editState = { msgId: null, originalContent: "", input: null };

// ===== MEDIA STATE =====
let pendingMedia = null;

// ===== FORMAT FILE SIZE =====
function formatBytes(bytes, decimals = 1) {
    if (bytes === 0) return '0 B';
    const k = 1024, dm = decimals < 0 ? 0 : decimals;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

// ===== GET FILE ICON =====
function getFileIcon(filename) {
    const ext = filename.split('.').pop().toLowerCase();
    const icons = {
        // Images
        'jpg': '🖼️', 'jpeg': '🖼️', 'png': '🖼️', 'gif': '🎬', 'webp': '🖼️', 'svg': '🎨', 'bmp': '🖼️',
        // Videos
        'mp4': '🎬', 'webm': '🎬', 'mov': '🎬', 'avi': '🎬', 'mkv': '🎬', 'flv': '🎬',
        // Audio
        'mp3': '🎵', 'wav': '🎵', 'ogg': '🎵', 'aac': '🎵', 'flac': '🎵', 'm4a': '🎵',
        // Documents
        'pdf': '📄', 'doc': '📝', 'docx': '📝', 'txt': '📃', 'rtf': '📄',
        'xls': '📊', 'xlsx': '📊', 'csv': '📊',
        'ppt': '📽️', 'pptx': '📽️',
        // Archives
        'zip': '', 'rar': '', '7z': '', 'tar': '📦', 'gz': '📦',
        // Code
        'js': '💻', 'py': '💻', 'java': '💻', 'cpp': '💻', 'c': '💻', 'html': '🌐', 'css': '🎨',
        // Other
        'exe': '⚙️', 'apk': '📱', 'dmg': '💿'
    };
    return icons[ext] || '📎';
}

// ===== COMPRESS IMAGE (Client-side) =====
function compressImage(file, maxWidth = 1920, quality = 0.8) {
    return new Promise((resolve) => {
        const img = new Image();
        const reader = new FileReader();
        reader.onload = (e) => {
            img.onload = () => {
                const canvas = document.createElement('canvas');
                let { width, height } = img;
                if (width > maxWidth) {
                    height = Math.round(height * (maxWidth / width));
                    width = maxWidth;
                }
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);
                canvas.toBlob((blob) => {
                    if (blob.size > file.size * 0.9) {
                        resolve(file);
                    } else {
                        const compressed = new File([blob], file.name, { type: 'image/jpeg', lastModified: Date.now() });
                        resolve(compressed);
                    }
                }, 'image/jpeg', quality);
            };
            img.src = e.target.result;
        };
        reader.readAsDataURL(file);
    });
}

// ===== HANDLE FILE SELECTION =====
async function handleMediaSelect(event) {
    const files = Array.from(event.target.files);
    if (!files.length) return;
    
    // Filter to images only for multi-select
    const imageFiles = files.filter(f => f.type.startsWith('image/')).slice(0, 10);
    
    if (imageFiles.length === 0) {
        // Fallback to original single-file handling
        const file = files[0];
        if (!file) return;
        
        const maxSize = file.type.startsWith('video/') ? 50*1024*1024 :
                        file.type.startsWith('audio/') ? 20*1024*1024 :
                        file.type.startsWith('image/') ? 10*1024*1024 :
                        100*1024*1024; 
        
        if (file.size > maxSize) {
            const maxMB = maxSize / (1024*1024);
            showToast(`File too large (max ${maxMB}MB)`, "error");
            event.target.value = '';
            return;
        }
        
        const preview = document.getElementById('preview-content');
        const previewWrap = document.getElementById('media-preview');
        
        if (file.type.startsWith('image/')) {
            const compressed = await compressImage(file);
            pendingMedia = { file: compressed, type: 'image', name: file.name, size: compressed.size };
            const reader = new FileReader();
            reader.onload = e => {
                preview.innerHTML = `
                    <img src="${e.target.result}" alt="preview">
                    <div class="preview-info">
                        <div class="preview-name">${escapeHtml(file.name)}</div>
                        <div class="preview-size">${formatBytes(compressed.size)}</div>
                    </div>
                `;
                previewWrap.classList.remove('hidden');
            };
            reader.readAsDataURL(compressed);
        } else if (file.type.startsWith('video/')) {
            pendingMedia = { file, type: 'video', name: file.name, size: file.size };
            const url = URL.createObjectURL(file);
            preview.innerHTML = `
                <video src="${url}" muted></video>
                <div class="preview-info">
                    <div class="preview-name">${escapeHtml(file.name)}</div>
                    <div class="preview-size">${formatBytes(file.size)}</div>
                </div>
            `;
            previewWrap.classList.remove('hidden');
        } else if (file.type.startsWith('audio/')) {
            pendingMedia = { file, type: 'audio', name: file.name, size: file.size };
            const url = URL.createObjectURL(file);
            const icon = getFileIcon(file.name);
            preview.innerHTML = `
                <div style="font-size:40px;text-align:center;">${icon}</div>
                <div class="preview-info">
                    <div class="preview-name">${escapeHtml(file.name)}</div>
                    <div class="preview-size">${formatBytes(file.size)}</div>
                    <div style="font-size:11px;color:var(--text-muted);">Audio</div>
                </div>
            `;
            previewWrap.classList.remove('hidden');
        } else {
            pendingMedia = { file, type: 'document', name: file.name, size: file.size };
            const icon = getFileIcon(file.name);
            preview.innerHTML = `
                <div style="font-size:40px;text-align:center;">${icon}</div>
                <div class="preview-info">
                    <div class="preview-name">${escapeHtml(file.name)}</div>
                    <div class="preview-size">${formatBytes(file.size)}</div>
                    <div style="font-size:11px;color:var(--text-muted);">Document</div>
                </div>
            `;
            previewWrap.classList.remove('hidden');
        }
        event.target.value = '';
        return;
    }
    
    // Multi-image handling
    const compressed = await Promise.all(imageFiles.map(f => compressImage(f)));
    pendingMedia = { files: compressed, type: 'multi-image', count: compressed.length };
    
    renderMultiImagePreview(compressed);
    event.target.value = ''; // Reset input
}

// ===== CLEAR PREVIEW =====
function clearMediaPreview() {
    pendingMedia = null;
    const previewWrap = document.getElementById('media-preview');
    if (previewWrap) {
        previewWrap.classList.add('hidden');
        document.getElementById('preview-content').innerHTML = '';
        document.getElementById('upload-progress').classList.add('hidden');
    }
}

// ===== RENDER MULTI-IMAGE PREVIEW =====
function renderMultiImagePreview(files) {
    const preview = document.getElementById('preview-content');
    if (!preview) return;
    
    if (files.length === 1) {
        // Single image preview (existing behavior)
        const reader = new FileReader();
        reader.onload = e => {
            preview.innerHTML = `
                <img src="${e.target.result}" alt="preview">
                <div class="preview-info">
                    <div class="preview-name">${escapeHtml(files[0].name)}</div>
                    <div class="preview-size">${formatBytes(files[0].size)}</div>
                </div>
            `;
        };
        reader.readAsDataURL(files[0]);
    } else {
        // Multi-image grid preview
        const grid = document.createElement('div');
        grid.style.cssText = 'display:grid;grid-template-columns:repeat(3,1fr);gap:4px;width:100%;';
        
        files.slice(0, 9).forEach((file, i) => {
            const cell = document.createElement('div');
            cell.style.cssText = 'aspect-ratio:1;border-radius:6px;overflow:hidden;position:relative;background:var(--bg-tertiary);';
            
            const img = document.createElement('img');
            img.src = URL.createObjectURL(file);
            img.style.cssText = 'width:100%;height:100%;object-fit:cover;';
            
            if (i === 8 && files.length > 9) {
                const overlay = document.createElement('div');
                overlay.style.cssText = 'position:absolute;inset:0;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;color:white;font-weight:700;font-size:14px;';
                overlay.textContent = `+${files.length - 8}`;
                cell.appendChild(img);
                cell.appendChild(overlay);
            } else {
                cell.appendChild(img);
            }
            grid.appendChild(cell);
        });
        
        preview.innerHTML = '';
        preview.appendChild(grid);
        
        // Add info below grid
        const info = document.createElement('div');
        info.style.cssText = 'margin-top:8px;font-size:12px;color:var(--text-muted);';
        info.textContent = `${files.length} photo${files.length > 1 ? 's' : ''} selected`;
        preview.appendChild(info);
    }
    
    document.getElementById('media-preview').classList.remove('hidden');
}

// ===== RENDER MEDIA BUBBLE (Supports Carousel) =====
function renderMediaBubble(m) {
    // Handle multiple images with carousel
    if (m.images && m.images.length > 0) {
        return createImageCarousel(m.images, m.id);
    }
    
    // Single image (legacy)
    if (m.media_type === 'image' && m.media_url) {
        const safeUrl = (m.media_thumbnail || m.media_url).replace(/[^\x20-\x7E]/g, '');
        return `<div class="message-media" onclick="openMediaFullscreen('${safeUrl}', 'image')">
            <img src="${safeUrl}" alt="media" loading="lazy" onerror="this.src='${safeUrl}'">
        </div>`;
    }
    
    // Video
    if (m.media_type === 'video' && m.media_url) {
        const safeUrl = m.media_url.replace(/[^\x20-\x7E]/g, '');
        return `<div class="message-media" onclick="openMediaFullscreen('${safeUrl}', 'video')">
            <video src="${safeUrl}" preload="metadata" playsinline></video>
        </div>`;
    }
    
    // Audio
    if (m.media_type === 'audio' && m.media_url) {
        const safeUrl = m.media_url.replace(/[^\x20-\x7E]/g, '');
        return `<div class="message-media message-audio">
            <audio src="${safeUrl}" controls></audio>
            <div class="media-info">
                <span class="media-name">${escapeHtml(m.media_name || 'Audio')}</span>
                <span class="media-size">${formatBytes(m.media_size || 0)}</span>
            </div>
        </div>`;
    }
    
    // Document/File
    if (m.media_url) {
        const safeUrl = m.media_url.replace(/[^\x20-\x7E]/g, '');
        const icon = getFileIcon(m.media_name);
        const ext = (m.media_name || '').split('.').pop().toUpperCase();
        const size = m.media_size ? formatBytes(m.media_size) : 'Unknown size';
        
        return `
            <a href="${safeUrl}" target="_blank" download class="message-file message-document">
                <div class="file-icon-large">${icon}</div>
                <div class="file-info">
                    <div class="file-name">${escapeHtml(m.media_name || 'File')}</div>
                    <div class="file-meta">
                        <span class="file-ext">${ext}</span>
                        <span class="file-size">${size}</span>
                    </div>
                </div>
                <div class="file-download">⬇️</div>
            </a>
        `;
    }
    
    return '';
}

// ══════════════════════════════════════════════════════════════
// 🖼️ MULTI-IMAGE CAROUSEL FUNCTIONS
// ══════════════════════════════════════════════════════════════

function createImageCarousel(images, msgId) {
    if (!images || images.length === 0) return '';
    if (images.length === 1) {
        // Single image - simple view
        return `<div class="message-media" onclick="openMediaFullscreen('${images[0]}', 'image')">
            <img src="${images[0]}" alt="message image" loading="lazy">
        </div>`;
    }
    
    // Multi-image carousel
    const carouselId = `carousel-${msgId}`;
    const slides = images.map((url, i) => 
        `<div class="carousel-slide" data-index="${i}">
            <img src="${url}" alt="Image ${i+1}" loading="lazy" onclick="openCarouselFullscreen('${carouselId}', ${i})">
        </div>`
    ).join('');
    
    const dots = images.map((_, i) => 
        `<button class="carousel-dot ${i === 0 ? 'active' : ''}" 
                data-index="${i}" 
                onclick="goToCarouselSlide('${carouselId}', ${i})"
                aria-label="Go to image ${i+1}">
        </button>`
    ).join('');
    
    return `
        <div class="message-carousel" id="${carouselId}" data-current="0" data-total="${images.length}">
            <div class="carousel-track">${slides}</div>
            <button class="carousel-arrow carousel-prev" onclick="carouselStep('${carouselId}', -1)" aria-label="Previous image">❮</button>
            <button class="carousel-arrow carousel-next" onclick="carouselStep('${carouselId}', 1)" aria-label="Next image">❯</button>
            <div class="carousel-dots">${dots}</div>
            <div class="carousel-counter">1 / ${images.length}</div>
        </div>
    `;
}

window.goToCarouselSlide = function(carouselId, index) {
    const carousel = document.getElementById(carouselId);
    if (!carousel) return;
    
    const total = parseInt(carousel.dataset.total);
    const clamped = Math.max(0, Math.min(index, total - 1));
    
    carousel.dataset.current = clamped;
    
    // Update track position
    const track = carousel.querySelector('.carousel-track');
    if (track) {
        track.style.transform = `translateX(-${clamped * 100}%)`;
    }
    
    // Update dots
    carousel.querySelectorAll('.carousel-dot').forEach((dot, i) => {
        dot.classList.toggle('active', i === clamped);
    });
    
    // Update counter
    const counter = carousel.querySelector('.carousel-counter');
    if (counter) {
        counter.textContent = `${clamped + 1} / ${total}`;
    }
    
    // Update arrow states
    updateCarouselArrows(carousel, clamped, total);
};

window.carouselStep = function(carouselId, direction) {
    const carousel = document.getElementById(carouselId);
    if (!carousel) return;
    
    const current = parseInt(carousel.dataset.current);
    goToCarouselSlide(carouselId, current + direction);
};

function updateCarouselArrows(carousel, currentIndex, total) {
    const prevBtn = carousel.querySelector('.carousel-prev');
    const nextBtn = carousel.querySelector('.carousel-next');
    
    if (prevBtn) prevBtn.disabled = currentIndex === 0;
    if (nextBtn) nextBtn.disabled = currentIndex === total - 1;
}

window.openCarouselFullscreen = function(carouselId, startIndex) {
    const carousel = document.getElementById(carouselId);
    if (!carousel) return;
    
    const images = Array.from(carousel.querySelectorAll('.carousel-slide img')).map(img => img.src);
    const total = images.length;
    
    // Create or reuse fullscreen modal
    let modal = document.getElementById('carousel-fullscreen');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'carousel-fullscreen';
        modal.className = 'carousel-fullscreen';
        modal.innerHTML = `
            <button class="carousel-close" onclick="closeCarouselFullscreen()">✕</button>
            <div class="carousel-track"></div>
            <button class="carousel-arrow carousel-prev" onclick="fullscreenCarouselStep(-1)">❮</button>
            <button class="carousel-arrow carousel-next" onclick="fullscreenCarouselStep(1)">❯</button>
            <div class="carousel-counter"></div>
        `;
        document.body.appendChild(modal);
        
        // Close on backdrop click
        modal.addEventListener('click', (e) => {
            if (e.target === modal) closeCarouselFullscreen();
        });
        
        // Keyboard navigation
        document.addEventListener('keydown', (e) => {
            if (!modal.classList.contains('active')) return;
            if (e.key === 'ArrowLeft') fullscreenCarouselStep(-1);
            if (e.key === 'ArrowRight') fullscreenCarouselStep(1);
            if (e.key === 'Escape') closeCarouselFullscreen();
        });
    }
    
    // Populate slides
    const track = modal.querySelector('.carousel-track');
    track.innerHTML = images.map((url, i) => 
        `<div class="carousel-slide"><img src="${url}" alt="Image ${i+1}"></div>`
    ).join('');
    
    // Set initial slide
    modal.dataset.current = startIndex;
    modal.dataset.total = total;
    goToFullscreenSlide(modal, startIndex);
    
    // Show modal
    modal.classList.add('active');
    document.body.style.overflow = 'hidden'; // Prevent background scroll
};

window.closeCarouselFullscreen = function() {
    const modal = document.getElementById('carousel-fullscreen');
    if (modal) {
        modal.classList.remove('active');
        document.body.style.overflow = '';
    }
};

window.fullscreenCarouselStep = function(direction) {
    const modal = document.getElementById('carousel-fullscreen');
    if (!modal) return;
    
    const current = parseInt(modal.dataset.current);
    const total = parseInt(modal.dataset.total);
    const newIndex = Math.max(0, Math.min(current + direction, total - 1));
    
    goToFullscreenSlide(modal, newIndex);
};

function goToFullscreenSlide(modal, index) {
    modal.dataset.current = index;
    
    // Update track
    const track = modal.querySelector('.carousel-track');
    if (track) {
        track.style.transform = `translateX(-${index * 100}%)`;
    }
    
    // Update counter
    const counter = modal.querySelector('.carousel-counter');
    const total = parseInt(modal.dataset.total);
    if (counter) {
        counter.textContent = `${index + 1} / ${total}`;
    }
    
    // Update arrows
    const prevBtn = modal.querySelector('.carousel-prev');
    const nextBtn = modal.querySelector('.carousel-next');
    if (prevBtn) prevBtn.disabled = index === 0;
    if (nextBtn) nextBtn.disabled = index === total - 1;
}

function addCarouselSwipe(carousel) {
    let startX = 0;
    let isDragging = false;
    
    carousel.addEventListener('touchstart', (e) => {
        startX = e.touches[0].clientX;
        isDragging = true;
    }, { passive: true });
    
    carousel.addEventListener('touchend', (e) => {
        if (!isDragging) return;
        const diff = startX - e.changedTouches[0].clientX;
        
        if (Math.abs(diff) > 50) { // Swipe threshold
            carouselStep(carousel.id, diff > 0 ? 1 : -1);
        }
        isDragging = false;
    }, { passive: true });
}

function initCarousels() {
    document.querySelectorAll('.message-carousel').forEach(carousel => {
        // Initialize arrows
        const current = parseInt(carousel.dataset.current) || 0;
        const total = parseInt(carousel.dataset.total) || 1;
        updateCarouselArrows(carousel, current, total);
        
        // Add swipe support
        addCarouselSwipe(carousel);
        
        // Add keyboard support for accessibility
        carousel.setAttribute('tabindex', '0');
        carousel.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowLeft') carouselStep(carousel.id, -1);
            if (e.key === 'ArrowRight') carouselStep(carousel.id, 1);
        });
    });
}

// Override loadMessages to initialize carousels after rendering
const originalLoadMessages = window.loadMessages;
window.loadMessages = async function(username) {
    await originalLoadMessages(username);
    // Initialize carousels after messages load
    setTimeout(initCarousels, 100);
};

// ===== ENHANCEMENTS =====
function scrollToNewMessage(msgId) {
    const msg = document.querySelector(`.message-item[data-msg-id="${msgId}"]`);
    if (msg) {
        msg.scrollIntoView({ behavior: 'smooth', block: 'end' });
        msg.style.animation = 'pulse 0.6s ease';
        setTimeout(() => msg.style.animation = '', 600);
    }
}

function showTypingIndicator(username) {
    const status = document.getElementById('chat-status');
    if (status && status.classList.contains('online')) {
        const original = status.title || '';
        status.title = `${username} is typing...`;
        status.style.animation = 'pulse 1s infinite';
        setTimeout(() => {
            status.title = original;
            status.style.animation = '';
        }, 3000);
    }
}

function markMessageDelivered(msgId) {
    const msg = document.querySelector(`.message-item[data-msg-id="${msgId}"] .message-time`);
    if (msg && !msg.textContent.includes('✓✓')) {
        msg.textContent += ' ✓✓';
        msg.style.color = 'var(--accent)';
    }
}

function showMediaLoading() {
    const progress = document.getElementById('upload-progress');
    if (progress) {
        progress.classList.remove('hidden');
        const fill = progress.querySelector('.progress-fill');
        const text = progress.querySelector('.progress-text');
        let p = 0;
        const interval = setInterval(() => {
            p = Math.min(p + Math.random() * 15, 95);
            if (fill) fill.style.width = `${p}%`;
            if (text) text.textContent = `${Math.round(p)}%`;
            if (p >= 95) clearInterval(interval);
        }, 200);
        return () => {
            clearInterval(interval);
            if (fill) fill.style.width = '100%';
            if (text) text.textContent = '100%';
            setTimeout(() => progress.classList.add('hidden'), 300);
        };
    }
    return () => {};
}

// ===== SCROLL =====
function scrollToBottom(force = false) {
    const container = document.getElementById("messages-container");
    if (!container) return;
    const isNearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 150;
    if (force || isNearBottom) container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
}

function setupScrollListener() {
    const container = document.getElementById("messages-container");
    const btn = document.getElementById("scroll-bottom-btn");
    if (!container || !btn) return;
    container.addEventListener("scroll", () => {
        const isNearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 150;
        btn.classList.toggle("visible", !isNearBottom);
    });
}

// ===== GLOBAL EMOJI CLICK HANDLER =====
document.addEventListener("click", (e) => {
    if (e.target.classList.contains("emoji-opt")) {
        const picker = e.target.closest(".emoji-picker");
        if (picker) {
            const msgId = picker.id.replace("picker-", "");
            selectReaction(msgId, e.target.dataset.emoji);
            picker.remove();
            e.stopPropagation();
        }
    }
});

// ===== MESSAGE ACTIONS HANDLER =====
function handleMessageActions(e) {
    const btn = e.target.closest(".msg-action-btn");
    if (!btn) return;
    const msgId = btn.dataset.id;
    const action = btn.classList.contains("reply-btn") ? "reply" : 
                   btn.classList.contains("react-btn") ? "react" : 
                   btn.classList.contains("edit-btn") ? "edit" : "delete";
    const bubble = btn.closest('.message-bubble');
    if (bubble) bubble.classList.remove('long-press');
    
    if (action === "react" && btn.closest('.message-item')?.classList.contains('mine')) {
        showToast("You can't react to your own messages", "info");
        return;
    }
    if (action === "reply") setReply(msgId);
    else if (action === "react") toggleEmojiPicker(msgId, btn);
    else if (action === "edit") {
        const msgEl = btn.closest('.message-item');
        const numericId = btn.dataset.numericId;
        const content = msgEl.querySelector('.message-bubble')?.textContent?.trim() || "";
        editMsg(msgId, numericId, content);
    }
    else if (action === "delete") confirmDelete(msgId, btn);
    e.stopPropagation();
}

// ===== MESSAGE INTERACTIONS SETUP =====
function setupMessageInteractions() {
    document.querySelectorAll('.message-bubble').forEach(bubble => {
        bubble.addEventListener('mouseenter', (e) => {
            const actions = e.currentTarget.querySelector('.message-actions');
            if (actions) {
                actions.style.opacity = '1';
                actions.style.pointerEvents = 'auto';
                actions.style.transform = 'translateY(0)';
            }
        });
        bubble.addEventListener('mouseleave', (e) => {
            const actions = e.currentTarget.querySelector('.message-actions');
            if (actions && !actions.matches(':hover')) {
                actions.style.opacity = '0';
                actions.style.pointerEvents = 'none';
                actions.style.transform = 'translateY(10px)';
            }
        });
    });
    
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.message-bubble')) {
            document.querySelectorAll('.message-actions').forEach(actions => {
                actions.style.opacity = '0';
                actions.style.pointerEvents = 'none';
                actions.style.transform = 'translateY(10px)';
                actions.closest('.message-bubble')?.classList.remove('actions-visible');
            });
        }
    });
    
    // Media click handler
    document.addEventListener('click', (e) => {
        const mediaEl = e.target.closest('.message-media');
        if (mediaEl) {
            e.stopPropagation();
            const url = mediaEl.querySelector('img, video')?.src || mediaEl.href;
            if (url) openMediaModal(url);
        }
    });
}


// ===== REPLY =====
function setReply(msgId, numericId) {
    // Fallback to extracting numeric ID from msgId if not provided
    if (!numericId) {
        numericId = String(msgId).replace('id-', '');
    }
    
    const el = document.querySelector(`.message-item[data-msg-id="${msgId}"]`);
    if (!el) return;
    
    // Get only the actual message text, ignoring time/reactions/media
    const textEl = el.querySelector('.message-text');
    let previewText = "Message";
    
    if (textEl) {
        previewText = textEl.textContent.trim();
    } else {
        // If it's a media-only message (no text)
        const mediaEl = el.querySelector('.message-media, .message-document, .message-carousel');
        if (mediaEl) {
            if (mediaEl.classList.contains('message-carousel')) previewText = "📷 Photos";
            else if (mediaEl.classList.contains('message-document')) previewText = "📎 " + (mediaEl.querySelector('.file-name')?.textContent || "Attachment");
            else previewText = "🎥 Media";
        }
    }
    
    const isMine = el.classList.contains("mine");
    const senderName = isMine ? "Yourself" : document.getElementById("chat-username")?.textContent || "User";
    
    currentReply = { 
        msgId: numericId, 
        sender: senderName, 
        content: previewText 
    };
    
    document.getElementById("reply-to-name").textContent = currentReply.sender;
    document.getElementById("reply-to-content").textContent = currentReply.content;
    document.getElementById("reply-preview-bar").classList.remove("hidden");
    document.getElementById("chat-input").focus();
}
function cancelReply() { currentReply = null; document.getElementById("reply-preview-bar").classList.add("hidden"); }

// ===== EMOJI PICKER =====
window.toggleEmojiPicker = function (msgId, btn) {
    document.getElementById('emoji-popup')?.remove();
    const picker = document.createElement('div');
    picker.id = 'emoji-popup';
    const msgItem = btn.closest('.message-item');
    const activeBadges = msgItem?.querySelectorAll('.message-reactions .react-badge.active') || [];
    const userReactions = Array.from(activeBadges).map(b => b.dataset.emoji);
    const emojis = ["👍", "❤️", "😂", "😮", "😢", "🔥", "👎"];
    
    emojis.forEach(emoji => {
        const s = document.createElement('span');
        s.className = `emoji-opt ${userReactions.includes(emoji) ? 'active' : ''}`;
        s.textContent = emoji;
        let fired = false;
        const handle = (e) => {
            if (fired) return;
            fired = true;
            e.preventDefault(); e.stopPropagation();
            window.selectReaction(msgId, emoji);
            picker.classList.remove('visible');
            setTimeout(() => picker.remove(), 180);
        };
        s.addEventListener('click', handle);
        s.addEventListener('touchend', handle, { passive: false });
        picker.appendChild(s);
    });
    console.log(msgId)
    document.body.appendChild(picker);
    const rect = document.getElementById("reactions-"+msgId).getBoundingClientRect();
    const dd=btn.getBoundingClientRect()
    const pickerW = picker.offsetWidth;
    let left = rect.left + (rect.width / 2) - (pickerW / 2);
    let top = rect.top - 140;
    left = Math.max(6, Math.min(left, window.innerWidth - pickerW - 6));
    
    picker.style.left = `${left}px`;
    picker.style.top = `${top}px`;
    requestAnimationFrame(() => picker.classList.add('visible'));
    
    setTimeout(() => {
        const closeHandler = (e) => {
            if (!picker.contains(e.target) && !btn.contains(e.target)) {
                picker.classList.remove('visible');
                setTimeout(() => picker.remove(), 180);
                document.removeEventListener('click', closeHandler);
                document.removeEventListener('touchend', closeHandler);
            }
        };
        document.addEventListener('click', closeHandler);
        document.addEventListener('touchend', closeHandler, { passive: true });
    }, 10);
};

window.closeEmojiPickers = function () {
    const pickers = document.querySelectorAll(".emoji-picker");
    if (pickers.length) console.log(`🧹 Closing ${pickers.length} open picker(s)`);
    pickers.forEach(p => p.remove());
};

// ===== REACTIONS =====

window.selectReaction = async function (msgId, emoji) {
    if (window._reacting === msgId + emoji) return;
    window._reacting = msgId + emoji;
    setTimeout(() => delete window._reacting, 500);
    
    // ✅ FIX: Extract numeric ID directly from msgId instead of searching for .react-btn
    const id = String(msgId).replace('id-', '');
    if (!id) return;
    
    const box = document.getElementById(`reactions-${msgId}`);
    if (!box) return;
    
    const activeBadge = box.querySelector('.react-badge.active');
    const currentEmoji = activeBadge?.dataset.emoji;
    
    // Update UI instantly for smooth UX
    if (currentEmoji === emoji) {
        activeBadge.remove();
    } else {
        if (activeBadge) activeBadge.remove();
        let newBadge = box.querySelector(`.react-badge[data-emoji="${emoji}"]`);
        if (!newBadge) {
            newBadge = document.createElement('span');
            newBadge.className = 'react-badge active';
            newBadge.dataset.emoji = emoji;
            newBadge.textContent = emoji;
            box.appendChild(newBadge);
        } else {
            newBadge.classList.add('active');
        }
    }
    
    // Send to server
    const token = localStorage.getItem('token');
    const headers = { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' };
    try {
        if (currentEmoji === emoji) {
            await fetch('/remove_reaction', { method: 'POST', headers, body: JSON.stringify({ message_id: id, emoji }) });
        } else if (currentEmoji) {
            await Promise.all([
                fetch('/remove_reaction', { method: 'POST', headers, body: JSON.stringify({ message_id: id, emoji: currentEmoji }) }),
                fetch('/add_reaction', { method: 'POST', headers, body: JSON.stringify({ message_id: id, emoji }) })
            ]);
        } else {
            await fetch('/add_reaction', { method: 'POST', headers, body: JSON.stringify({ message_id: id, emoji }) });
        }
    } catch (err) {
        console.error("Sync error:", err);
        if (currentChatUser) loadMessages(currentChatUser);
    }
};

// ===== DELETE CONFIRMATION =====
function confirmDelete(msgId, deleteScope = 'me') {
    document.querySelectorAll('.delete-confirm-modal').forEach(el => el.remove());
   
    const msgEl = document.querySelector(`.message-item[data-msg-id="${msgId}"]`);
    if (!msgEl) return;
    
    const isMine = msgEl.classList.contains('mine');
    
    const modal = document.createElement('div');
    modal.className = 'delete-confirm-modal';
    modal.innerHTML = `
        <div class="modal-backdrop"></div>
        <div class="modal-content">
            <h3>Delete Message?</h3>
            <p class="modal-subtitle">Choose how to delete this message</p>
            <div class="modal-options">
                <button class="opt-btn me-btn" data-scope="me">
                    <span>🗑️</span> Delete for me
                    <small>Only you won't see it</small>
                </button>
                ${isMine ? `
                <button class="opt-btn everyone-btn danger" data-scope="everyone">
                    <span>🌍</span> Delete for everyone
                    <small>Removes it for all + media from cloud</small>
                </button>` : ''}
            </div>
            <button class="modal-cancel">Cancel</button>
        </div>
    `;
    
    document.body.appendChild(modal);
    requestAnimationFrame(() => modal.classList.add('visible'));
    
    const close = () => { modal.classList.remove('visible'); setTimeout(() => modal.remove(), 200); };
    modal.querySelector('.modal-backdrop').onclick = close;
    modal.querySelector('.modal-cancel').onclick = close;
    
    modal.querySelectorAll('.opt-btn').forEach(btn => {
        btn.onclick = async () => {
            const scope = btn.dataset.scope;
            const originalHtml = btn.innerHTML;
            btn.disabled = true;
            btn.textContent = 'Deleting...';
            
            try {
                const token = localStorage.getItem("token");
                const numericId = String(msgId).replace('id-', '');
                const res = await fetch(`/delete_message/${numericId}`, {
                    method: "POST",
                    headers: { 
                        "Authorization": "Bearer " + token, 
                        "Content-Type": "application/json" 
                    },
                    body: JSON.stringify({ delete_for: scope })
                });
                
                if (!res.ok) {
                    const errData = await res.json().catch(() => ({}));
                    if (errData.msg === 'only_sender_can_delete_for_everyone') {
                        throw new Error("only_sender");
                    }
                    throw new Error(errData.msg || "Delete failed");
                }
                
                close();
                
                if (msgEl) {
                    if (scope === "me") {
                        msgEl.style.transition = "all 0.3s ease";
                        msgEl.style.opacity = "0"; 
                        msgEl.style.transform = "scale(0.95)";
                        setTimeout(() => msgEl.remove(), 300);
                    } else {
                        const bubble = msgEl.querySelector('.message-bubble');
                        if (bubble) {
                            bubble.innerHTML = `<div class="message-text">🗑️ This message was deleted</div>`;
                            bubble.classList.add('deleted-message');
                            bubble.querySelector('.msg-options-btn')?.remove();
                            bubble.querySelector('.msg-options-menu')?.remove();
                        }
                    }
                }
                showToast(scope === "me" ? "Hidden for you" : "Deleted for everyone", "success");
                
            } catch (err) {
                console.error(err);
                if (err.message === "only_sender") {
                    showToast("You can only delete your own messages for everyone", "warning");
                } else if (err.message?.includes("unauthorized")) {
                    showToast("Permission denied", "error");
                } else {
                    showToast("Could not delete message", "error");
                }
            } finally {
                btn.disabled = false;
                btn.innerHTML = originalHtml;
            }
        };
    });
}

// ===== LOAD MESSAGES (WITH MEDIA + CAROUSEL SUPPORT) =====
async function loadMessages(username) {
    const token = localStorage.getItem("token");
    if (!token || !username) return;
    const data = await safeFetch(`/get_messages/${encodeURIComponent(username)}`, { headers: { "Authorization": "Bearer " + token } });
    if (!data) return;
    const messages = data.messages || [];
    const container = document.getElementById("messages-container");
    if (!container) return;
    if (data.other_user_picture) { 
        const avatar = document.getElementById("chat-avatar"); 
        if (avatar) avatar.src = getSafePic(data.other_user_picture); 
    }

    function getMsgId(m, index) { 
        if (m.id) return `id-${m.id}`; 
        const raw = `${m.sender_picture || ''}-${m.created_at || ''}-${m.content || ''}-${index}`; 
        let hash = 0; 
        for (let i = 0; i < raw.length; i++) hash = ((hash << 5) - hash) + raw.charCodeAt(i); 
        return `msg-${hash}-${index}`; 
    }

    const processedIds = new Set();
    messages.forEach((m, index) => {
        const msgId = getMsgId(m, index); 
        processedIds.add(msgId);
        let msgEl = container.querySelector(`.message-item[data-msg-id="${msgId}"]`);
        
        if (!msgEl) {
            msgEl = document.createElement("div");
            msgEl.className = `message-item ${m.is_mine ? "mine" : ""}`;
            msgEl.dataset.msgId = msgId;
            
            let replyHtml = '';
            if (m.reply_context && m.reply_context.content) {
                replyHtml = `<div class="reply-context"><span class="reply-label">↩️ Replying to ${escapeHtml(m.reply_context.sender_username || 'user')}:</span><span class="reply-text">${escapeHtml(m.reply_context.content.substring(0, 80))}</span></div>`;
            }
            
            let reactionsHtml = '';
            if (m.reactions && Object.keys(m.reactions).length) {
                reactionsHtml = '<div class="message-reactions">';
                for (const [emoji] of Object.entries(m.reactions)) {
                    const isActive = m.user_reactions?.includes(emoji) ? 'active' : '';
                    reactionsHtml += `<span class="react-badge ${isActive}" data-emoji="${emoji}">${emoji}</span>`;
                }
                reactionsHtml += '</div>';
            }
            
            // ✅ Media bubble content (supports carousel)
            const isMine = m.is_mine;
            const contentHtml = m.content ? `<div class="message-text">${escapeHtml(m.content)}</div>` : '';
            const mediaHtml = renderMediaBubble(m);
            const hasMedia = !!(m.media_url || (m.images && m.images.length > 0));

            const menuHtml = `
                <div class="msg-options-menu">
                    <button data-action="reply"><span><img width="15px" src="reply.png"></span> Reply</button>
                    <button data-action="react"><span><img width="15px" src="emoji.png"></span> Add Reaction</button>
                    ${isMine ? `<button data-action="edit"><span><img width="15px" src="pencil.png"></span> Edit</button>` : ''}
                    <button data-action="delete-me"><span><img width="15px" src="trash.png"></span> Delete for me</button>
                    ${isMine ? `<button data-action="delete-all" class="danger"><span>🌍</span> Delete for everyone</button>` : ''}
                </div>`;

            msgEl.innerHTML = `
                <img src="${getSafePic(m.sender_picture)}" class="message-avatar">
                <div class="message-wrapper">
                    <div class="message-bubble ${hasMedia ? '' : 'text-only'}" ${!hasMedia ? `onclick="handleTextBubbleClick(event, this)"` : ''}>
                        ${hasMedia ? `<button class="msg-options-btn" onclick="toggleMediaMenu(event, this)">⋮</button>` : ''}
                        ${menuHtml}
                        ${replyHtml}
                        ${contentHtml}
                        ${mediaHtml}
                    </div>
                    <div id="reactions-${msgId}" class="message-reactions">${reactionsHtml}</div>
                    <div class="message-time">${getTimeAgo(m.created_at)}${m.is_edited ? ' • edited' : ''}</div>
                </div>`;
            container.appendChild(msgEl);
        } else {
            // Update existing message
            const bubble = msgEl.querySelector('.message-bubble');
            const time = msgEl.querySelector('.message-time');
            const newContent = escapeHtml(m.content);
            const newTime = getTimeAgo(m.created_at);
            
            if (bubble) {
                // Update reply context
                let existingReply = bubble.querySelector('.reply-context');
                if (m.reply_context && m.reply_context.content) {
                    if (!existingReply) {
                        const replyHtml = `<div class="reply-context"><span class="reply-label">↩️ Replying to ${escapeHtml(m.reply_context.sender_username || 'user')}:</span><span class="reply-text">${escapeHtml(m.reply_context.content.substring(0, 80))}</span></div>`;
                        bubble.insertAdjacentHTML('afterbegin', replyHtml);
                    }
                } else if (existingReply) existingReply.remove();
                
                // Update text content
                const contentDiv = bubble.querySelector('.message-text');
                if (m.content) {
                    if (contentDiv) {
                        contentDiv.innerHTML = newContent;
                    } else {
                        const newDiv = document.createElement('div');
                        newDiv.className = 'message-text';
                        newDiv.innerHTML = newContent;
                        const replyEl = bubble.querySelector('.reply-context');
                        if (replyEl) replyEl.insertAdjacentElement('afterend', newDiv);
                        else bubble.insertBefore(newDiv, bubble.firstChild);
                    }
                } else if (contentDiv) contentDiv.remove();
                
                // Update media (supports carousel)
                const existingMedia = bubble.querySelector('.message-media, .message-file, .message-carousel');
                const newMediaHtml = renderMediaBubble(m);
                if (newMediaHtml) {
                    if (existingMedia) {
                        existingMedia.outerHTML = newMediaHtml;
                    } else {
                        const temp = document.createElement('div');
                        temp.innerHTML = newMediaHtml;
                        bubble.appendChild(temp.firstElementChild);
                    }
                } else if (existingMedia) {
                    existingMedia.remove();
                }
                
                // Update time
                if (time && time.textContent !== newTime + (m.is_edited ? ' • edited' : '')) {
                    time.textContent = newTime + (m.is_edited ? ' • edited' : '');
                }
            }
            
            // Update reactions
            const reactionsContainer = msgEl.querySelector('.message-reactions');
            if (reactionsContainer) {
                let reactionsHtml = '';
                if (m.reactions && Object.keys(m.reactions).length) {
                    reactionsHtml = '<div class="message-reactions">';
                    for (const [emoji] of Object.entries(m.reactions)) {
                        const isActive = m.user_reactions?.includes(emoji) ? 'active' : '';
                        reactionsHtml += `<span class="react-badge ${isActive}" data-emoji="${emoji}">${emoji}</span>`;
                    }
                    reactionsHtml += '</div>';
                }
                reactionsContainer.innerHTML = reactionsHtml;
            }
        }
    });
    
    // Remove old messages
    container.querySelectorAll('.message-item').forEach(el => { 
        if (!processedIds.has(el.dataset.msgId)) el.remove(); 
    });
    scrollToBottom(false);
}

// ===== SEND TEXT-ONLY =====
async function sendTextMessage(content) {
    const payload = { receiver_username: currentChatUser, content };
    if (currentReply) payload.reply_to_id = currentReply.msgId;
    
    const data = await safeFetch("/send_message", {
        method: "POST",
        headers: { "Authorization": "Bearer " + localStorage.getItem("token"), "Content-Type": "application/json" },
        body: JSON.stringify(payload)
    });
    
    if (!data || data.msg !== "sent") throw new Error("send failed");
}

// ===== SEND MEDIA MESSAGE (Supports Multi-Image) =====
async function sendMediaMessage(content, media) {
    const token = localStorage.getItem("token");
    
    // ✅ Handle multi-image via NEW endpoint
    if (media?.type === 'multi-image' && media.files?.length > 0) {
        // Upload all images to Cloudinary
        const uploadPromises = media.files.map(f => uploadToCloudinary(f));
        const imageUrls = await Promise.all(uploadPromises);
        
        // Send via new endpoint
        const formData = new FormData();
        formData.append("receiver_username", currentChatUser);
        if (content) formData.append("content", content);
        formData.append("images_json", JSON.stringify(imageUrls));
        if (currentReply) formData.append("reply_to_id", currentReply.msgId);
        
        const response = await fetch("/send_multi_image_message", {
            method: "POST",
            headers: { "Authorization": "Bearer " + token },
            body: formData
        });
        
        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(err.msg || "upload failed");
        }
        return await response.json();
    }
    
    // ✅ Original single-media handling (unchanged)
    const formData = new FormData();
    formData.append("receiver_username", currentChatUser);
    if (content) formData.append("content", content);
    formData.append("media", media.file, media.name);
    if (currentReply) formData.append("reply_to_id", currentReply.msgId);
    
    const progressWrap = document.getElementById('upload-progress');
    const progressFill = progressWrap?.querySelector('.progress-fill');
    const progressText = progressWrap?.querySelector('.progress-text');
    
    if (progressWrap) progressWrap.classList.remove('hidden');
    
    let progress = 0;
    const interval = setInterval(() => {
        progress = Math.min(progress + Math.random() * 25, 90);
        if (progressFill) progressFill.style.width = `${progress}%`;
        if (progressText) progressText.textContent = `${Math.round(progress)}%`;
    }, 200);
    
    const response = await fetch("/send_media_message", {
        method: "POST",
        headers: { "Authorization": "Bearer " + token },
        body: formData
    });
    
    clearInterval(interval);
    
    if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.msg || "upload failed");
    }
    
    if (progressFill) progressFill.style.width = '100%';
    if (progressText) progressText.textContent = '100%';
    if (progressWrap) setTimeout(() => progressWrap.classList.add('hidden'), 300);
    
    const data = await response.json();
    if (data.msg !== "sent") throw new Error("send failed");
    return data;
}

// ===== SEND MESSAGE (MAIN) =====
async function sendChatMessage() {
    const input = document.getElementById("chat-input");
    const content = input?.value.trim();
    
    if ((!content || content === "") && !pendingMedia && !currentChatUser) return;
    
    const token = localStorage.getItem("token");
    if (!token) return window.location.href = "/root.html";
    
    input.disabled = true;
    const sendBtn = document.querySelector('.chat-send-btn');
    if (sendBtn) sendBtn.disabled = true;
    
    try {
        if (pendingMedia) {
            await sendMediaMessage(content, pendingMedia);
        } else if (content) {
            await sendTextMessage(content);
        }
        
        input.value = "";
        input.disabled = false;
        if (sendBtn) sendBtn.disabled = false;
        input.focus();
        cancelReply();
        clearMediaPreview();
        
        if (currentChatUser) {
            loadMessages(currentChatUser);
            loadConversationsOptimized();
            scrollToBottom(true);
        }
    } catch (err) {
        console.error(err);
        showToast("Failed to send", "error");
        input.disabled = false;
        if (sendBtn) sendBtn.disabled = false;
    }
}

// ===== LOAD CONVERSATIONS =====
async function loadConversationsOptimized() {
    const token = localStorage.getItem("token");
    if (!token) return;
    const data = await safeFetch("/get_conversations", { headers: { "Authorization": "Bearer " + token } });
    const list = document.getElementById("conversations-list");
    if (!list) return;
    if (!data || !data.length) { 
        list.innerHTML = `<p style="color:var(--text-muted);text-align:center;padding:20px;">No conversations yet.</p>`; 
        return; 
    }
    const activeUsernames = new Set();
    data.forEach(c => {
        activeUsernames.add(c.username);
        const hasUnread = c.unread_count > 0;
        const isOnline = c.is_online === true;
        let item = list.querySelector(`.conversation-item[data-username="${c.username}"]`);
        const previewText = c.last_message ? (c.last_message_from_me ? `You: ${c.last_message}` : c.last_message) : "Tap to chat";
        
        if (!item) {
            item = document.createElement("div");
            item.dataset.username = c.username;
            item.className = `conversation-item ${currentChatUser === c.username ? "active" : ""} ${hasUnread ? "has-unread" : ""}`;
            item.onclick = () => openChat(c.username);
            item.innerHTML = `
                <div class="conv-avatar-wrapper">
                    <img src="${getSafePic(c.profile_picture)}" class="conversation-avatar">
                    <span class="conv-status-dot ${isOnline ? 'online' : 'offline'}"></span>
                </div>
                <div class="conversation-info">
                    <div class="conversation-name">${c.name || c.username}</div>
                    <div class="conversation-preview"></div>
                </div>
                <div class="conversation-meta">
                    <div class="conversation-time"></div>
                    <div class="badge-container"></div>
                </div>
                <button class="conv-options-btn" onclick="toggleConvMenu(event, this)">⋮</button>
                <div class="conv-options-menu">
                    <button data-action="delete-conv-me"><span><img width="15px" src="trash.png"></span> Delete conversation</button>
                </div>
            `;
            list.appendChild(item);
        }
        
        const statusDot = item.querySelector('.conv-status-dot');
        if (statusDot) statusDot.className = `conv-status-dot ${isOnline ? 'online' : 'offline'}`;
        
        item.className = `conversation-item ${currentChatUser === c.username ? "active" : ""} ${hasUnread ? "has-unread" : ""}`;
        const previewEl = item.querySelector('.conversation-preview');
        if (previewEl && previewEl.textContent !== previewText) previewEl.textContent = escapeHtml(previewText);
        const timeEl = item.querySelector('.conversation-time');
        const newTime = getTimeAgo(c.last_message_time);
        if (timeEl && timeEl.textContent !== newTime) timeEl.textContent = newTime;
        const badgeEl = item.querySelector('.badge-container');
        if (badgeEl) badgeEl.innerHTML = c.unread_count > 0 ? `<span class="unread-badge">${c.unread_count}</span>` : "";
    });
    list.querySelectorAll('.conversation-item').forEach(item => { 
        if (!activeUsernames.has(item.dataset.username)) item.remove(); 
    });
}window.filterConversations = function(query) {
    const conversationsList = document.getElementById("conversations-list");
    if (!conversationsList) return;
    
    const items = conversationsList.querySelectorAll(".conversation-item");
    const normalizedQuery = query.toLowerCase().trim();
    
    items.forEach(item => {
        const username = item.querySelector(".conversation-name")?.textContent.toLowerCase() || "";
        const preview = item.querySelector(".conversation-preview")?.textContent.toLowerCase() || "";
        
        if (!normalizedQuery || username.includes(normalizedQuery) || preview.includes(normalizedQuery)) {
            item.style.display = "flex";
        } else {
            item.style.display = "none";
        }
    });
};
// ===== UPDATE CHAT HEADER STATUS =====
async function updateChatHeaderStatus(username) {
    if (!username) return;
    const token = localStorage.getItem("token");
    const statusEl = document.getElementById("chat-status");
    if (!statusEl) return;
    
    try {
        const res = await fetch(`/get_user_status/${encodeURIComponent(username)}`, {
            headers: { "Authorization": "Bearer " + token }
        });
        const data = await res.json();
        statusEl.className = `chat-status ${data.is_online ? 'online' : 'offline'}`;
    } catch (e) {
        statusEl.className = "chat-status offline";
    }
}

// ===== OPEN CHAT =====
function openChat(username) {
    currentChatUser = username;
    const emptyState = document.getElementById("empty-state");
    const chatActive = document.getElementById("chat-active");
    if (emptyState) emptyState.classList.add("hidden");
    if (chatActive) chatActive.classList.remove("hidden");
    document.getElementById("chat-username").textContent = username;
    
    updateChatHeaderStatus(username);

    const newBtn = document.getElementById("new-chat-btn");
    const emptyBtn = document.getElementById("empty-start-btn");
    if (newBtn) newBtn.style.display = "none";
    if (emptyBtn) emptyBtn.style.display = "none";
    
    loadMessages(username);
    if (chatPollInterval) clearInterval(chatPollInterval);
    chatPollInterval = setInterval(() => {
        loadMessages(username);
        updateChatHeaderStatus(username);
    }, 5000);
    
    if (window.innerWidth <= 1024) document.querySelector('.conversations-sidebar')?.classList.add('mobile-hidden');
    document.querySelectorAll(".conversation-item").forEach(el => { 
        el.classList.toggle("active", el.querySelector(".conversation-name")?.textContent === username); 
    });
}

// ===== EXIT CHAT =====
function exitChat() {
    currentChatUser = null;
    const emptyState = document.getElementById("empty-state");
    const chatActive = document.getElementById("chat-active");
    if (emptyState) emptyState.classList.remove("hidden");
    if (chatActive) chatActive.classList.add("hidden");
    const newBtn = document.getElementById("new-chat-btn");
    const emptyBtn = document.getElementById("empty-start-btn");
    if (newBtn) newBtn.style.display = "flex";
    if (emptyBtn) emptyBtn.style.display = "inline-block";
    if (chatPollInterval) { clearInterval(chatPollInterval); chatPollInterval = null; }
    if (window.innerWidth <= 1024) document.querySelector('.conversations-sidebar')?.classList.remove('mobile-hidden');
}

// ===== MODALS & FRIENDS =====
function openNewChatModal() { 
    document.getElementById("new-chat-modal").showModal(); 
    searchNewChatUsers(""); 
}

function closeNewChatModal() { 
    document.getElementById("new-chat-modal").close(); 
    document.getElementById("new-chat-search").value = ""; 
}

async function searchNewChatUsers(q) {
    const token = localStorage.getItem("token");
    if (!token) return;
    const users = await safeFetch(`/search_users?q=${encodeURIComponent(q)}`, { headers: { "Authorization": "Bearer " + token } });
    const list = document.getElementById("new-chat-users");
    if (!list) return;
    list.innerHTML = "";
    if (!users || !users.length) { 
        list.innerHTML = `<p style="color:var(--text-muted);text-align:center;padding:20px;">No users found</p>`; 
        return; 
    }
    const me = localStorage.getItem("username");
    users.forEach(u => { 
        if (u.username === me) return; 
        const item = document.createElement("div"); 
        item.className = "modal-user-item"; 
        item.onclick = () => { closeNewChatModal(); openChat(u.username); }; 
        item.innerHTML = `<img src="${getSafePic(u.profile_picture)}" class="modal-user-avatar"><div class="modal-user-info"><div class="modal-user-name">${u.name || u.username}</div><div class="modal-user-username">@${u.username}</div></div>`; 
        list.appendChild(item); 
    });
}

async function loadFriendsList() {
    const token = localStorage.getItem("token");
    if (!token) return;
    const friends = await safeFetch("/get_friends_list", { headers: { "Authorization": "Bearer " + token } });
    const list = document.getElementById("friends-list");
    if (!list) return;
    if (!friends || !friends.length) { 
        if (!list.querySelector('.no-friends-msg')) { 
            list.innerHTML = `<p class="no-friends-msg" style="color:var(--text-muted);font-size:12px;padding:0 16px;">No friends yet</p>`; 
        } 
        return; 
    }
    const placeholder = list.querySelector('.no-friends-msg'); 
    if (placeholder) placeholder.remove();
    friends.forEach(f => {
        let item = list.querySelector(`.friend-item[data-username="${f.username}"]`);
        if (!item) {
            item = document.createElement("div");
            item.className = "friend-item";
            item.dataset.username = f.username;
            item.onclick = () => openChat(f.username);
            item.innerHTML = `<div class="friend-avatar-wrapper"><img src="${getSafePic(f.profile_picture)}" class="friend-avatar ${f.is_online ? 'online' : 'offline'}"><span class="status-indicator ${f.is_online ? 'online' : 'offline'}"></span></div><div class="friend-name-short">${f.name || f.username}</div>`;
            list.appendChild(item);
        } else {
            const avatar = item.querySelector('.friend-avatar');
            const status = item.querySelector('.status-indicator');
            if (avatar) avatar.className = `friend-avatar ${f.is_online ? 'online' : 'offline'}`;
            if (status) status.className = `status-indicator ${f.is_online ? 'online' : 'offline'}`;
        }
    });
}

function startSmartRefresh() {
    if (smartRefresh.active) return;
    smartRefresh.active = true;
    smartRefresh.friends = setInterval(() => loadFriendsList(), 10000);
    smartRefresh.conversations = setInterval(() => loadConversationsOptimized(), 15000);
}

function stopSmartRefresh() {
    if (smartRefresh.friends) clearInterval(smartRefresh.friends);
    if (smartRefresh.conversations) clearInterval(smartRefresh.conversations);
    smartRefresh.friends = null; 
    smartRefresh.conversations = null; 
    smartRefresh.active = false;
}

// ===== EDIT MESSAGE =====
function editMsg(msgId, numericId, originalContent) {
    const msgItem = document.querySelector(`.message-item[data-msg-id="${msgId}"]`);
    if (!msgItem || msgItem.querySelector('.edit-message-input')) return;
    
    const bubble = msgItem.querySelector('.message-bubble');
    if (!bubble) return;
    
    let textEl = bubble.querySelector('.message-text');
    const currentText = textEl ? textEl.textContent.trim() : (originalContent || "");
    bubble.dataset.originalText = currentText;
    
    const textarea = document.createElement('textarea');
    textarea.className = 'edit-message-input';
    textarea.value = currentText;
    
    if (textEl) {
        textEl.replaceWith(textarea);
    } else {
        bubble.insertBefore(textarea, bubble.firstChild);
    }
    textarea.focus();
    
    const btnBox = document.createElement('div');
    btnBox.className = 'edit-actions';
    btnBox.innerHTML = `<button class="edit-cancel-btn">Cancel</button><button class="edit-save-btn">Save</button>`;
    bubble.appendChild(btnBox);
    
    const cleanup = () => {
        textarea.remove();
        btnBox.remove();
        if (!bubble.querySelector('.message-text')) {
            const restored = document.createElement('div');
            restored.className = 'message-text';
            restored.textContent = bubble.dataset.originalText;
            const ref = bubble.querySelector('.message-media') || bubble.querySelector('.message-actions') || null;
            bubble.insertBefore(restored, ref);
        }
        delete bubble.dataset.originalText;
    };
    
    btnBox.querySelector('.edit-cancel-btn').onclick = cleanup;
    
    btnBox.querySelector('.edit-save-btn').onclick = async () => {
        const newContent = textarea.value.trim();
        if (!newContent) return showToast("Message can't be empty", "error");
        const saveBtn = btnBox.querySelector('.edit-save-btn');
        saveBtn.disabled = true;
        
        try {
            const token = localStorage.getItem("token");
            const res = await fetch(`/edit_message/${msgId}`, {
                method: "PUT",
                headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" },
                body: JSON.stringify({ content: newContent })
            });
            if (!res.ok) throw new Error("Edit failed");
            
            cleanup();
          
            let newTextEl = bubble.querySelector('.message-text');
            if (!newTextEl) {
                newTextEl = document.createElement('div');
                newTextEl.className = 'message-text';
                const ref = bubble.querySelector('.message-media') || bubble.querySelector('.message-actions') || null;
                bubble.insertBefore(newTextEl, ref);
            }
            newTextEl.textContent = newContent;
            
            const timeEl = msgItem.querySelector('.message-time');
            if (timeEl && !timeEl.textContent.includes('edited')) {
                timeEl.textContent += ' • edited';
            }
            showToast("Message updated", "success");
        } catch (err) {
            console.error(err);
            showToast("Failed to save", "error");
            saveBtn.disabled = false;
        }
    };
}

async function saveEdit(msgId, numericId) {
    const bubble = document.querySelector(`.message-item[data-msg-id="${msgId}"] .message-bubble`);
    if (!bubble) return;
    
    const input = bubble.querySelector('textarea');
    if (!input) return;
    
    const newContent = input.value.trim();
    if (!newContent) return showToast("Message can't be empty", "error");
    
    const saveBtn = bubble.querySelector('.edit-save-btn');
    if (saveBtn) saveBtn.disabled = true;
    
    const token = localStorage.getItem("token");
    if (!token) return window.location.href = "/root.html";
    
    try {
        const res = await fetch(`/edit_message/${numericId}`, {
            method: "PUT",
            headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" },
            body: JSON.stringify({ content: newContent })
        });
        
        if (!res.ok) throw new Error(`Server returned ${res.status}`);

        input.remove();
        const controls = bubble.querySelector('.edit-actions');
        if (controls) controls.remove();
        
        Array.from(bubble.childNodes).forEach(node => {
            if (node.nodeType === Node.TEXT_NODE) node.remove();
        });

        bubble.appendChild(document.createTextNode(newContent));
        const actions = bubble.querySelector('.message-actions');
        if (actions) bubble.appendChild(actions);
        
        const timeEl = bubble.closest('.message-item')?.querySelector('.message-time');
        if (timeEl && !timeEl.textContent.includes('edited')) {
            timeEl.textContent += ' • edited';
        }
    } catch (err) {
        console.error("Edit failed:", err);
        showToast("Failed to save", "error");
        cancelEdit(msgId);
    }
}

// ===== GLOBAL STATE =====
let fullscreenVideoModal = null;
let activeMenu = null;
let activeConvMenu = null;

// ===== TOGGLE OPTIONS MENU =====
window.toggleMessageMenu = function(btn) {
    const menu = btn.nextElementSibling;
    const isShowing = menu.classList.contains('show');
    
    document.querySelectorAll('.msg-options-menu.show').forEach(m => m.classList.remove('show'));
    activeMenu = null;
    
    if (!isShowing) {
        menu.classList.add('show');
        activeMenu = menu;
    }
    event.stopPropagation();
};

// ===== TOGGLE MENU FOR MEDIA MESSAGES =====
window.toggleMediaMenu = function(e, btn) {
    e.stopPropagation();
    const menu = btn.nextElementSibling;
    const isOpen = menu.classList.contains('show');
    document.querySelectorAll('.msg-options-menu.show').forEach(m => m.classList.remove('show'));
    if (!isOpen) { menu.classList.add('show'); activeMenu = menu; }
};

// ===== CLICK HANDLER FOR TEXT-ONLY MESSAGES =====
window.handleTextBubbleClick = function(e, bubble) {
    if (e.target.closest('.msg-options-menu') || e.target.closest('button')) return;
    const menu = bubble.querySelector('.msg-options-menu');
    if (!menu) return;
    
    const isOpen = menu.classList.contains('show');
    document.querySelectorAll('.msg-options-menu.show').forEach(m => m.classList.remove('show'));
    if (!isOpen) { menu.classList.add('show'); activeMenu = menu; }
    e.stopPropagation();
};

// ===== CLOSE MENU ON OUTSIDE CLICK =====
document.addEventListener('click', (e) => {
    if (activeMenu && !e.target.closest('.msg-options-menu') && !e.target.closest('.msg-options-btn')) {
        activeMenu.classList.remove('show');
        document.getElementById("messages-container").style.setProperty('padding-bottom', '120px', 'important');

        activeMenu = null;
    }
    if (activeConvMenu && !e.target.closest('.conv-options-menu') && !e.target.closest('.conv-options-btn')) {
        activeConvMenu.classList.remove('show');
        document.getElementById("messages-container").style.setProperty('padding-bottom', '120px', 'important');
        activeConvMenu = null;
    }
});

// ===== MENU ACTION ROUTER =====
document.addEventListener('click', (e) => {
    const btn = e.target.closest('.msg-options-menu button');
    

    if (!btn) return;
    
    const menu = btn.closest('.msg-options-menu');
    const msgItem = menu.closest('.message-item');
    const bubble = menu.closest('.message-bubble');
    const msgId = msgItem.dataset.msgId;
    const numericId = btn.closest('.msg-action-btn')?.dataset.numericId || msgId.replace('id-', '');
    
    const action = btn.dataset.action;
    menu.classList.remove('show');
     document.getElementById("messages-container").style.setProperty('padding-bottom', '400px', 'important');
    activeMenu = null;
    
    if (action === 'reply') setReply(msgId);
    else if (action === 'react') toggleEmojiPicker(msgId, btn);
    else if (action === 'edit') {
        const content = bubble.querySelector('.message-text')?.textContent?.trim() || '';
        editMsg(msgId, numericId, content);
    }
    else if (action === 'delete-me') confirmDelete(msgId, 'me');
    else if (action === 'delete-all') confirmDelete(msgId, 'everyone');
    
    e.stopPropagation();
});

// ===== FULLSCREEN MEDIA VIEWER =====
window.openMediaFullscreen = function(url, type) {
    let modal = document.getElementById('media-fullscreen');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'media-fullscreen';
        modal.className = 'media-fullscreen';
        modal.innerHTML = `<button class="media-close-btn">✕</button><div class="media-container"></div>`;
        document.body.appendChild(modal);
        modal.querySelector('.media-close-btn').onclick = () => modal.classList.remove('active');
        modal.addEventListener('click', (e) => { if(e.target === modal) modal.classList.remove('active'); });
    }
    const container = modal.querySelector('.media-container');
    if (type === 'video') {
        container.innerHTML = `<video src="${url}" controls playsinline autoplay style="max-width:100vw;max-height:100vh;"></video>`;
    } else {
        container.innerHTML = `<img src="${url}" style="max-width:100vw;max-height:100vh;object-fit:contain;cursor:zoom-out;" onclick="document.getElementById('media-fullscreen').classList.remove('active')">`;
    }
    modal.classList.add('active');
};

// ===== FULLSCREEN VIDEO PLAYER =====
window.openFullscreenVideo = function(videoUrl, senderName) {
    if (!fullscreenVideoModal) {
        fullscreenVideoModal = document.createElement('div');
        fullscreenVideoModal.className = 'video-fullscreen-modal';
        fullscreenVideoModal.innerHTML = `
            <button class="video-fullscreen-close">✕</button>
            <video controls playsinline autoplay></video>
            <div class="video-fullscreen-info"></div>
        `;
        document.body.appendChild(fullscreenVideoModal);
        
        fullscreenVideoModal.querySelector('.video-fullscreen-close').onclick = closeFullscreenVideo;
        fullscreenVideoModal.addEventListener('click', (e) => { if(e.target === fullscreenVideoModal) closeFullscreenVideo(); });
    }
    
    const vid = fullscreenVideoModal.querySelector('video');
    const info = fullscreenVideoModal.querySelector('.video-fullscreen-info');
    vid.src = videoUrl;
    info.textContent = `Video • ${senderName || 'Message'}`;
    fullscreenVideoModal.classList.add('active');
    vid.play().catch(() => {});
};

function closeFullscreenVideo() {
    if (!fullscreenVideoModal) return;
    const vid = fullscreenVideoModal.querySelector('video');
    vid.pause(); vid.src = '';
    fullscreenVideoModal.classList.remove('active');
}

// ===== ATTACH VIDEO CLICK LISTENER =====
function attachMediaListeners() {
    document.querySelectorAll('.message-media video').forEach(vid => {
        if (!vid.dataset.fullscreenBound) {
            vid.style.cursor = 'pointer';
            vid.addEventListener('click', (e) => {
                e.stopPropagation();
                const msgItem = vid.closest('.message-item');
                const sender = msgItem.querySelector('.chat-username, .conversation-name')?.textContent || 'Video';
                openFullscreenVideo(vid.src, sender);
            });
            vid.dataset.fullscreenBound = 'true';
        }
    });
}

// ===== CONVERSATION OPTIONS =====
window.toggleConvMenu = function(e, btn) {
    e.stopPropagation();
    const menu = btn.nextElementSibling;
    const isOpen = menu.classList.contains('show');
    
    document.querySelectorAll('.conv-options-menu.show').forEach(m => {
        if (m !== menu) m.classList.remove('show');
    });
    
    if (!isOpen) {
        menu.classList.add('show');
        activeConvMenu = menu;
    } else {
        menu.classList.remove('show');
        activeConvMenu = null;
    }
};

// Handle conversation menu actions
document.addEventListener('click', (e) => {
    const btn = e.target.closest('.conv-options-menu button');
    if (!btn) return;
    
    const menu = btn.closest('.conv-options-menu');
    const convItem = menu.closest('.conversation-item');
    const username = convItem.dataset.username;
    const action = btn.dataset.action;
    
    menu.classList.remove('show');
    activeConvMenu = null;
    
    if (action === 'delete-conv-me') {
        confirmDeleteConversation(username, 'me', convItem);
    } else if (action === 'delete-conv-all') {
        confirmDeleteConversation(username, 'everyone', convItem);
    }
    e.stopPropagation();
});

// Confirmation modal for deleting conversation
function confirmDeleteConversation(username, scope, convItem) {
    const modal = document.createElement('div');
    modal.className = 'delete-confirm-modal';
    modal.innerHTML = `
        <div class="modal-backdrop"></div>
        <div class="modal-content">
            <h3>Delete Conversation?</h3>
            <p class="modal-subtitle">
                ${scope === 'me' 
                    ? 'This will hide the conversation from your view only.' 
                    : 'This will permanently delete ALL messages for both users.'}
            </p>
            <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:20px;">
                <button class="modal-cancel">Cancel</button>
                <button class="primary-btn danger">Delete</button>
            </div>
        </div>
    `;
    
    document.body.appendChild(modal);
    requestAnimationFrame(() => modal.classList.add('visible'));
    
    const close = () => { modal.classList.remove('visible'); setTimeout(() => modal.remove(), 200); };
    modal.querySelector('.modal-backdrop').onclick = close;
    modal.querySelector('.modal-cancel').onclick = close;
    
    modal.querySelector('.primary-btn').onclick = async () => {
        try {
            const token = localStorage.getItem("token");
            const res = await fetch(`/delete_conversation/${username}`, {
                method: "POST",
                headers: { 
                    "Authorization": "Bearer " + token, 
                    "Content-Type": "application/json" 
                },
                body: JSON.stringify({ delete_for: scope })
            });
            
            if (!res.ok) throw new Error("Delete failed");
            
            close();
            
            if (convItem) {
                convItem.style.transition = "all 0.3s ease";
                convItem.style.opacity = "0";
                convItem.style.transform = "translateX(-20px)";
                setTimeout(() => convItem.remove(), 300);
            }
            
            if (currentChatUser === username) {
                exitChat();
            }
            
            showToast(scope === 'me' ? "Conversation hidden" : "Conversation deleted for everyone", "success");
            loadConversationsOptimized();
            
        } catch (err) {
            console.error(err);
            showToast("Could not delete conversation", "error");
        }
    };
}

// ===== DOMContentLoaded =====
document.addEventListener("DOMContentLoaded", async function () {
    const token = localStorage.getItem("token");
    if (!token) return window.location.href = "/root.html";
    
    const p = document.getElementById("profile-img"); 
    if (p) p.src = getSafePic(localStorage.getItem("profile_picture"));
    
    await loadFriendsList();
    await loadConversationsOptimized();
    
    document.getElementById("search-input")?.addEventListener("input", e => filterConversations(e.target.value));
    startSmartRefresh();
    setupScrollListener();
    
    const container = document.getElementById("messages-container");
    if (container) { 
        container.addEventListener("click", handleMessageActions); 
        container.addEventListener("click", closeEmojiPickers); 
    }
    
    document.getElementById("new-chat-btn")?.addEventListener("click", openNewChatModal);
    document.getElementById("empty-start-btn")?.addEventListener("click", openNewChatModal);
    document.getElementById("close-reply-btn")?.addEventListener("click", cancelReply);
    
    // Media input handler - enable multiple selection
    const mediaInput = document.getElementById("media-input");
    if (mediaInput) {
        mediaInput.setAttribute('multiple', '');
        mediaInput.setAttribute('accept', 'image/*');
        mediaInput.addEventListener("change", handleMediaSelect);
    }
    
    setupMessageInteractions();
    
    // Add smooth hover/tap effects
    document.querySelectorAll('.conversation-item').forEach(item => {
        item.addEventListener('mouseenter', function() {
            this.style.transform = 'translateX(4px)';
        });
        item.addEventListener('mouseleave', function() {
            this.style.transform = '';
        });
    });
    
    document.querySelectorAll('.message-bubble, .friend-item, .modal-user-item').forEach(el => {
        el.addEventListener('touchstart', function() {
            this.style.transform = 'scale(0.98)';
        });
        el.addEventListener('touchend', function() {
            this.style.transform = '';
        });
    });
    
    // Auto-focus chat input when chat opens
    const chatInput = document.getElementById('chat-input');
    if (chatInput) {
        const observer = new MutationObserver(() => {
            if (!document.getElementById('empty-state')?.classList.contains('hidden')) {
                chatInput.focus();
            }
        });
        observer.observe(document.getElementById('chat-active'), { attributes: true, attributeFilter: ['class'] });
    }
});

document.addEventListener("visibilitychange", () => { 
    if (document.hidden) stopSmartRefresh(); 
    else { loadFriendsList(); loadConversationsOptimized(); startSmartRefresh(); } 
});

window.addEventListener("beforeunload", stopSmartRefresh);

// Export for potential WebSocket integration later
window.MessagingEnhancements = {
    scrollToNewMessage,
    showTypingIndicator,
    markMessageDelivered,
    showMediaLoading,
    uploadToCloudinary,
    createImageCarousel,
    initCarousels
};
