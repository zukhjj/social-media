/* ══════════════════════════════════════════════════════════════
   home.js  –  Social Grid  (multi-image + slider support)
   ══════════════════════════════════════════════════════════════ */

const isMessagesPage = window.location.pathname.includes('messages.html');

let tempFiles = [];          // NEW: array of File objects (images)
let tempVideoFile = null;    // single video
let currentEditId = null;
let currentEditContent = "";
let currentEditImage = "";
let currentEditVideo = null;
let currentEditVisibility = "public";

// ─────────────────────── UTILITIES ───────────────────────────
function getSafePic(pic) {
    return (pic && pic !== "unknown" && pic !== "unkown") ? pic : "unkown.png";
}

function escapeHtml(text) {
    if (!text) return "";
    const d = document.createElement("div");
    d.textContent = text;
    return d.innerHTML;
}

function getTimeAgo(dateStr) {
    if (!dateStr) return "";
    const clean = dateStr.replace(" ", "T");
    const date = new Date(clean.includes("Z") ? clean : clean + "Z");
    if (isNaN(date)) return "";
    const diff = Math.floor((Date.now() - date) / 1000);
    if (diff < 5)     return "now";
    if (diff < 60)    return diff + "s";
    if (diff < 3600)  return Math.floor(diff / 60) + "m";
    if (diff < 86400) return Math.floor(diff / 3600) + "h";
    if (diff < 604800) return Math.floor(diff / 86400) + "d";
    return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function setActive(el, e) {
    if (e) e.preventDefault();
    document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
    el.classList.add('active');
}

// ─────────────────────── TOASTS ──────────────────────────────
function showToast(message, type = "info", duration = 4000) {
    const container = document.getElementById("toast-container");
    if (!container) return;
    const icons = { success: "✅", error: "❌", warning: "⚠️", info: "ℹ️" };
    const toast = document.createElement("div");
    toast.className = `toast ${type}`;
    toast.innerHTML = `
        <span class="toast-icon">${icons[type] || "ℹ️"}</span>
        <span class="toast-message">${escapeHtml(message)}</span>
        <button class="toast-close" onclick="this.parentElement.remove()">×</button>`;
    container.appendChild(toast);
    setTimeout(() => {
        toast.classList.add("hiding");
        setTimeout(() => toast.remove(), 260);
    }, duration);
}
const showSuccess = msg => showToast(msg, "success");
const showError   = msg => showToast(msg, "error");
const showWarn    = msg => showToast(msg, "warning");

// ─────────────────────── MULTI-IMAGE PREVIEW ─────────────────
function cancelAllMedia() {
    tempFiles = [];
    tempVideoFile = null;
    const pi = document.getElementById("post-image"); if (pi) pi.value = "";
    const pv = document.getElementById("post-video"); if (pv) pv.value = "";
    const w  = document.getElementById("preview-wrap");
    if (w) { w.innerHTML = ""; w.style.display = "none"; }
}

/** Renders thumbnail grid for selected images in the add-post box */
function renderImagePreviews() {
    const wrap = document.getElementById("preview-wrap");
    if (!wrap) return;
    wrap.innerHTML = "";

    if (tempVideoFile) {
        // Video preview
        const vid = document.createElement("video");
        vid.src = URL.createObjectURL(tempVideoFile);
        vid.controls = true; vid.playsInline = true; vid.muted = true;
        vid.style.cssText = "max-width:100%;max-height:260px;border-radius:12px;display:block;margin:0 auto;";
        wrap.appendChild(vid);
        const cancelBtn = document.createElement("button");
        cancelBtn.className = "cancel-btn";
        cancelBtn.textContent = "✕";
        cancelBtn.onclick = cancelAllMedia;
        wrap.appendChild(cancelBtn);
        wrap.style.display = "block";
        return;
    }

    if (!tempFiles.length) {
        wrap.style.display = "none";
        return;
    }

    // Multi-image grid preview
    const grid = document.createElement("div");
    grid.className = "preview-img-grid";
    const count = tempFiles.length;
    grid.dataset.count = count;

    tempFiles.forEach((file, idx) => {
        const cell = document.createElement("div");
        cell.className = "preview-img-cell";
        const img = document.createElement("img");
        img.src = URL.createObjectURL(file);
        img.alt = `Image ${idx + 1}`;
        const rm = document.createElement("button");
        rm.className = "preview-img-remove";
        rm.textContent = "✕";
        rm.title = "Remove this image";
        rm.onclick = (e) => {
            e.stopPropagation();
            tempFiles.splice(idx, 1);
            renderImagePreviews();
        };
        cell.appendChild(img);
        cell.appendChild(rm);
        grid.appendChild(cell);
    });

    // Cancel-all button
    const cancelAll = document.createElement("button");
    cancelAll.className = "cancel-btn";
    cancelAll.textContent = "✕";
    cancelAll.title = "Remove all images";
    cancelAll.onclick = cancelAllMedia;
    wrap.appendChild(grid);
    wrap.appendChild(cancelAll);

    // Count badge
    if (count > 1) {
        const badge = document.createElement("div");
        badge.className = "preview-count-badge";
        badge.textContent = `${count} photo${count > 1 ? "s" : ""}`;
        wrap.appendChild(badge);
    }

    wrap.style.display = "block";
}

// ─────────────────────── MEDIA INPUT WIRING ──────────────────
if (!isMessagesPage) {
    document.addEventListener("DOMContentLoaded", () => {
        const postImage = document.getElementById("post-image");
        const postVideo = document.getElementById("post-video");

        if (postImage) {
            // Allow multiple selection
            postImage.setAttribute("multiple", "true");
            postImage.onchange = function () {
                const files = Array.from(this.files);
                if (!files.length) { cancelAllMedia(); return; }
                // Max 10 images
                const allowed = files.filter(f => f.type.startsWith("image/")).slice(0, 10);
                if (allowed.length < files.length) {
                    showWarn(`Only image files accepted. Max 10 selected.`);
                }
                tempVideoFile = null;
                const pv = document.getElementById("post-video"); if (pv) pv.value = "";
                // Merge or replace
                const combined = [...tempFiles, ...allowed].slice(0, 10);
                tempFiles = combined;
                renderImagePreviews();
            };
        }

        if (postVideo) {
            postVideo.onchange = function () {
                const file = this.files[0]; if (!file) { cancelAllMedia(); return; }
                if (file.size > 20 * 1024 * 1024) { showError("Video too large – max 20 MB."); this.value = ""; return; }
                if (!file.type.startsWith("video/")) { showError("Invalid file type. Use MP4 or WebM."); this.value = ""; return; }
                const pi = document.getElementById("post-image"); if (pi) pi.value = "";
                tempFiles = [];
                tempVideoFile = file;
                renderImagePreviews();
            };
        }
    });
}

// ─────────────────────── SEARCH ──────────────────────────────
let searchTimeout = null;

function initSearch() {
    const input = document.getElementById("search-input");
    if (!input) return;
    const container = input.closest(".search-container");
    if (!container) return;
    container.style.position = "relative";
    const dropdown = document.createElement("div");
    dropdown.id = "search-results";
    container.appendChild(dropdown);

    input.addEventListener("input", () => {
        clearTimeout(searchTimeout);
        const q = input.value.trim();
        if (!q) { dropdown.innerHTML = ""; dropdown.classList.remove("open"); return; }
        searchTimeout = setTimeout(() => runSearch(q, dropdown), 280);
    });

    document.addEventListener("click", e => {
        if (!container.contains(e.target)) dropdown.classList.remove("open");
    });

    input.addEventListener("keydown", e => {
        if (e.key === "Enter") { clearTimeout(searchTimeout); runSearch(input.value.trim(), dropdown); }
        if (e.key === "Escape") { dropdown.classList.remove("open"); input.blur(); }
    });
}

async function runSearch(q, dropdown) {
    if (!q) return;
    const token = localStorage.getItem("token");
    try {
        const res = await fetch(`/search_users?q=${encodeURIComponent(q)}`, {
            headers: { "Authorization": "Bearer " + (token || "") }
        });
        if (!res.ok) { dropdown.classList.remove("open"); return; }
        const users = await res.json();
        dropdown.innerHTML = "";
        if (!users.length) {
            dropdown.innerHTML = `<div class="search-no-results">No users found for "<strong>${escapeHtml(q)}</strong>"</div>`;
        } else {
            users.forEach(u => {
                const item = document.createElement("div");
                item.className = "search-result-item";
                item.innerHTML = `
                    <img src="${getSafePic(u.profile_picture)}" alt="">
                    <div>
                        <div class="sr-name">${escapeHtml(u.name || u.username)}</div>
                        <div class="sr-user">@${escapeHtml(u.username)}</div>
                    </div>`;
                item.onclick = () => {
                    dropdown.classList.remove("open");
                    document.getElementById("search-input").value = "";
                    loadUserPage(u.username);
                };
                dropdown.appendChild(item);
            });
        }
        dropdown.classList.add("open");
    } catch (err) {
        console.error("Search error:", err);
    }
}

// ─────────────────────── ADD POST ────────────────────────────
function addPost() {
    const text = document.getElementById("post-content")?.value.trim();
    if (!text && !tempFiles.length && !tempVideoFile) {
        showWarn("Write something or add an image/video first.");
        return;
    }

    const confirmBox = document.getElementById("confirm-post")?.querySelector(".confirm-box");
    if (!confirmBox) return;

    const ct = document.getElementById("confirm-text");
    if (ct) ct.innerText = text || "";

    document.getElementById("confirm-media")?.remove();
    document.getElementById("confirm-visibility-wrap")?.remove();

    // Media preview in dialog
    const mediaDiv = document.createElement("div");
    mediaDiv.id = "confirm-media";
    mediaDiv.style.margin = "12px 0";

    if (tempVideoFile) {
        const vid = document.createElement("video");
        vid.src = URL.createObjectURL(tempVideoFile);
        vid.controls = true; vid.playsInline = true;
        vid.style.cssText = "max-width:100%;max-height:200px;border-radius:10px;display:block;margin:0 auto;";
        mediaDiv.appendChild(vid);
    } else if (tempFiles.length === 1) {
        const img = document.createElement("img");
        img.src = URL.createObjectURL(tempFiles[0]);
        img.style.cssText = "max-width:100%;max-height:200px;border-radius:10px;display:block;margin:0 auto;object-fit:cover;";
        mediaDiv.appendChild(img);
    } else if (tempFiles.length > 1) {
        // Mini grid preview in confirm dialog
        const miniGrid = document.createElement("div");
        miniGrid.style.cssText = "display:grid;grid-template-columns:repeat(auto-fill,minmax(80px,1fr));gap:6px;";
        tempFiles.slice(0, 4).forEach((f, i) => {
            const img = document.createElement("img");
            img.src = URL.createObjectURL(f);
            img.style.cssText = "width:100%;height:80px;object-fit:cover;border-radius:8px;";
            if (i === 3 && tempFiles.length > 4) {
                const overlay = document.createElement("div");
                overlay.style.cssText = "position:relative;";
                overlay.appendChild(img);
                const badge = document.createElement("div");
                badge.style.cssText = "position:absolute;inset:0;background:rgba(0,0,0,0.55);display:flex;align-items:center;justify-content:center;border-radius:8px;color:#fff;font-weight:700;font-size:18px;";
                badge.textContent = `+${tempFiles.length - 3}`;
                overlay.appendChild(badge);
                miniGrid.appendChild(overlay);
            } else {
                miniGrid.appendChild(img);
            }
        });
        mediaDiv.appendChild(miniGrid);
        const countNote = document.createElement("p");
        countNote.style.cssText = "font-size:12px;color:var(--text-muted);text-align:center;margin-top:6px;";
        countNote.textContent = `${tempFiles.length} photos selected`;
        mediaDiv.appendChild(countNote);
    }

    const currentVisibility = document.getElementById("post-visibility")?.value || "public";
    const visWrap = document.createElement("div");
    visWrap.id = "confirm-visibility-wrap";
    visWrap.innerHTML = `
        <label for="confirm-visibility" style="font-size:12.5px;color:var(--text-secondary);font-weight:500;">👁 Visibility</label>
        <select id="confirm-visibility">
            <option value="public"  ${currentVisibility === "public"  ? "selected" : ""}>🌍 Public</option>
            <option value="friends" ${currentVisibility === "friends" ? "selected" : ""}>👥 Friends Only</option>
            <option value="private" ${currentVisibility === "private" ? "selected" : ""}>🔒 Private</option>
        </select>`;

    const actions = confirmBox.querySelector(".confirm-actions");
    confirmBox.insertBefore(visWrap, actions);
    confirmBox.insertBefore(mediaDiv, visWrap);

    document.getElementById("confirm-post")?.showModal();
}

function closeConfirm() { document.getElementById("confirm-post")?.close(); }

// ─────────────────────── CLOUDINARY UPLOAD ───────────────────
async function uploadToCloudinary(file) {
    const isVideo = file.type.startsWith("video/");
    const preset = "video_posts";
    const resourceType = isVideo ? "video" : "image";
    const cloudName = "dlimysibj";
    const formData = new FormData();
    formData.append("file", file, file.name);
    formData.append("upload_preset", preset);
    formData.append("resource_type", resourceType);
    const res = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/${resourceType}/upload`, {
        method: "POST", body: formData
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error?.message || "Upload failed");
    return data.secure_url;
}

// ─────────────────────── SUBMIT POST ─────────────────────────
async function submitPost() {
    const token = localStorage.getItem("token");
    if (!token) { window.location.href = "/root.html"; return; }

    const text = document.getElementById("post-content")?.value || "";
    const visibility = document.getElementById("confirm-visibility")?.value || "public";

    const confirmBtn = document.querySelector("#confirm-post .confirm-actions button:first-child");
    if (confirmBtn) { confirmBtn.disabled = true; confirmBtn.textContent = "Posting…"; }

    let imageUrls = [];
    let videoUrl = null;

    try {
        if (tempVideoFile) {
            videoUrl = await uploadToCloudinary(tempVideoFile);
        } else if (tempFiles.length > 0) {
            // Upload all images concurrently
            const uploadPromises = tempFiles.map(f => uploadToCloudinary(f));
            imageUrls = await Promise.all(uploadPromises);
        }
    } catch (err) {
        showError("Media upload failed. Try again.");
        if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.textContent = "Publish"; }
        return;
    }

    const formData = new FormData();
    if (text.trim()) formData.append("content", text.trim());
    if (videoUrl)    formData.append("video_url", videoUrl);
    if (imageUrls.length === 1) {
        // Legacy single URL for backwards compat
        formData.append("image_url", imageUrls[0]);
    } else if (imageUrls.length > 1) {
        // NEW: send as JSON array
        formData.append("images_json", JSON.stringify(imageUrls));
    }
    formData.append("visibility", visibility);

    try {
        const res  = await fetch("/add_post", {
            method: "POST",
            headers: { "Authorization": "Bearer " + token },
            body: formData
        });
        const data = await res.json();
        if (!res.ok) {
            showError(data.msg || "Failed to post.");
            if (["token_expired","invalid_token","no_token"].includes(data.msg)) {
                localStorage.removeItem("token");
                window.location.href = "/root.html";
            }
            return;
        }
        document.getElementById("post-content").value = "";
        const pv = document.getElementById("post-visibility"); if (pv) pv.value = "public";
        cancelAllMedia();
        closeConfirm();
        showSuccess("Post published! 🎉");
        await loadPosts();
    } catch (err) {
        console.error("Post error:", err);
        showError("Connection error. Check your network.");
    } finally {
        if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.textContent = "Publish"; }
    }
}

// ─────────────────────── IMAGE SLIDER ────────────────────────
/**
 * Creates a beautiful Instagram-style image slider.
 * @param {string[]} images - Array of image URLs
 * @param {number} postId   - Used for unique IDs
 */
function createImageSlider(images, postId) {
    if (!images || images.length === 0) return "";
    if (images.length === 1) {
        return `<img src="${images[0]}" loading="lazy" onclick="openFull(this.src)" alt="Post image" class="post-single-img">`;
    }

    const sliderId = `slider-${postId}`;
    const slides = images.map((url, i) => `
        <div class="slide" data-index="${i}">
            <img src="${url}" loading="lazy" onclick="openFull(this.src)" alt="Image ${i+1}">
        </div>`).join("");

    const dots = images.map((_, i) =>
        `<button class="slider-dot ${i === 0 ? 'active' : ''}" data-index="${i}" onclick="goToSlide('${sliderId}', ${i})" aria-label="Go to image ${i+1}"></button>`
    ).join("");

    return `
        <div class="img-slider" id="${sliderId}" data-current="0" data-total="${images.length}">
            <div class="slider-track">
                ${slides}
            </div>
            <button class="slider-arrow slider-prev" onclick="slideStep('${sliderId}', -1)" aria-label="Previous image">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"/></svg>
            </button>
            <button class="slider-arrow slider-next" onclick="slideStep('${sliderId}', 1)" aria-label="Next image">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 6 15 12 9 18"/></svg>
            </button>
            <div class="slider-dots">${dots}</div>
            <div class="slider-counter">${1} / ${images.length}</div>
        </div>`;
}

function goToSlide(sliderId, index) {
    const slider = document.getElementById(sliderId);
    if (!slider) return;
    const total = parseInt(slider.dataset.total);
    const clamped = Math.max(0, Math.min(index, total - 1));
    slider.dataset.current = clamped;
    const track = slider.querySelector(".slider-track");
    if (track) track.style.transform = `translateX(-${clamped * 100}%)`;
    slider.querySelectorAll(".slider-dot").forEach((d, i) => d.classList.toggle("active", i === clamped));
    const counter = slider.querySelector(".slider-counter");
    if (counter) counter.textContent = `${clamped + 1} / ${total}`;
    // Show/hide arrows
    const prev = slider.querySelector(".slider-prev");
    const next = slider.querySelector(".slider-next");
    if (prev) prev.style.opacity = clamped === 0 ? "0.3" : "1";
    if (next) next.style.opacity = clamped === total - 1 ? "0.3" : "1";
}

function slideStep(sliderId, dir) {
    const slider = document.getElementById(sliderId);
    if (!slider) return;
    const current = parseInt(slider.dataset.current);
    goToSlide(sliderId, current + dir);
}

// Touch/swipe support for sliders
function addSliderSwipe(slider) {
    let startX = 0, isDragging = false;
    slider.addEventListener("touchstart", e => { startX = e.touches[0].clientX; isDragging = true; }, { passive: true });
    slider.addEventListener("touchend", e => {
        if (!isDragging) return;
        const diff = startX - e.changedTouches[0].clientX;
        if (Math.abs(diff) > 40) slideStep(slider.id, diff > 0 ? 1 : -1);
        isDragging = false;
    }, { passive: true });
    // Mouse drag
    let mouseStart = 0, mouseDragging = false;
    slider.addEventListener("mousedown", e => { mouseStart = e.clientX; mouseDragging = true; e.preventDefault(); });
    slider.addEventListener("mouseup", e => {
        if (!mouseDragging) return;
        const diff = mouseStart - e.clientX;
        if (Math.abs(diff) > 40) slideStep(slider.id, diff > 0 ? 1 : -1);
        mouseDragging = false;
    });
    slider.addEventListener("mouseleave", () => { mouseDragging = false; });
}

// ─────────────────────── FEED ────────────────────────────────
function visIcon(v) {
    return { public: "🌍", friends: "👥", private: "🔒" }[v] || "🌍";
}

function createPostHTML(p) {
    const onUserPage = !!document.getElementById("user-posts-feed");
    const currentUsername = localStorage.getItem("username") || "";
    const isOwner = p.username === currentUsername;

    const followBtn = !onUserPage && !isOwner
        ? `<button class="follow-btn" data-user="${p.username}" onclick="event.stopPropagation(); toggleFollow('${p.username}')">Follow</button>`
        : "";

    const optionsBtn = onUserPage && isOwner
        ? `<button class="post-options-btn" onclick="openPostOptions(this)"
               data-id="${p.id}"
               data-content="${escapeHtml(p.content || '')}"
               data-image="${p.image || ''}"
               data-video="${p.video || ''}"
               data-visibility="${p.visibility || 'public'}">⋯</button>`
        : "";

    // Decide media rendering
    let mediaHtml = "";
    const images = p.images || (p.image ? [p.image] : []);
    if (p.video) {
        mediaHtml = `<video controls preload="metadata" playsinline>
            <source src="${p.video}" type="video/mp4">
            Your browser doesn't support video.
        </video>`;
    } else if (images.length > 0) {
        mediaHtml = createImageSlider(images, p.id);
    }

    return `
        <div class="post-header">
            <img src="${getSafePic(p.profile_picture)}" class="post-avatar" onclick="loadUserPage('${p.username}')">
            <span class="post-username" onclick="loadUserPage('${p.username}')">
                ${escapeHtml(p.username)}
                <span style="font-size:11px;opacity:0.45;" title="${p.visibility || 'public'}">${visIcon(p.visibility)}</span>
            </span>
            ${followBtn}${optionsBtn}
        </div>
        <div class="post-content">
            ${p.content ? `<p>${escapeHtml(p.content)}</p>` : ""}
            ${mediaHtml}
        </div>
        <div class="post-actions">
            <button class="action-btn" onclick="likePost(${p.id}, this)" title="Like">
                <img src="heart.png" class="action-icon">
                <span class="action-count">${p.likes || 0}</span>
            </button>
            <button class="action-btn comment-toggle" data-comment-toggle="${p.id}" onclick="toggleComments(${p.id})" title="Comment">
                <img src="chat.png" class="action-icon">
                <span class="action-count" data-comment-count="${p.id}">${p.comments || 0}</span>
            </button>
            <button class="action-btn" onclick="repostPost(${p.id}, this)" title="Repost">
                <img src="repost.png" class="action-icon">
                <span class="action-count">${p.reposts || 0}</span>
            </button>
        </div>
        <div id="comments-section-${p.id}" class="comment-container">
            <div id="comments-list-${p.id}" class="comments-list"></div>
            <div class="comment-input-wrap">
                <input type="text" id="comment-input-${p.id}" class="comment-input" placeholder="Write a comment…"
                    onkeydown="if(event.key==='Enter')submitComment(${p.id})">
                <button class="comment-send" onclick="submitComment(${p.id})">Send</button>
            </div>
        </div>`;
}

function showSkeletons(count = 3) {
    const feed = document.getElementById("feed-container");
    if (!feed) return;
    const addDiv = document.getElementById("add-post");
    feed.innerHTML = "";
    if (addDiv) feed.appendChild(addDiv);
    for (let i = 0; i < count; i++) {
        const sk = document.createElement("div");
        sk.className = "skeleton skeleton-post";
        feed.appendChild(sk);
    }
}

async function loadPosts() {
    if (isMessagesPage) return;
    const token = localStorage.getItem("token");
    const currentUsername = localStorage.getItem("username") || "";

    showSkeletons();

    let followStates = { following: [], friends: [] };
    try {
        const r = await fetch("/my_follows", { headers: { "Authorization": "Bearer " + token } });
        if (r.ok) followStates = await r.json();
    } catch (_) {}

    try {
        const res = await fetch("/get_posts", {
            headers: { "Authorization": "Bearer " + (token || "") }
        });
        if (!res.ok) throw new Error("Failed to fetch posts");
        const allPosts = await res.json();
        const posts = allPosts.filter(p => p.username !== currentUsername);

        const feed = document.getElementById("feed-container");
        const addDiv = document.getElementById("add-post");
        if (!feed) return;
        feed.innerHTML = "";
        if (addDiv) feed.appendChild(addDiv);

        if (!posts.length) {
            feed.innerHTML += `
                <div class="empty-state">
                    <div class="empty-state-icon">👋</div>
                    No posts yet. Follow someone to see their posts!
                </div>`;
            return;
        }

        posts.forEach(p => {
            const status = followStates.friends.includes(p.username)   ? "Friends"
                         : followStates.following.includes(p.username) ? "Following"
                         : "Follow";
            const el = document.createElement("article");
            el.className = "post-card";
            el.dataset.visibility = p.visibility || "public";
            el.innerHTML = createPostHTML(p);

            const btn = el.querySelector('.follow-btn');
            if (btn) {
                btn.textContent = status;
                if (status !== "Follow") btn.classList.add("following");
            }
            feed.appendChild(el);

            // Init swipe on sliders
            const slider = el.querySelector(".img-slider");
            if (slider) addSliderSwipe(slider);
        });
    } catch (err) {
        console.error("Load posts error:", err);
        const feed = document.getElementById("feed-container");
        if (feed) {
            const addDiv = document.getElementById("add-post");
            feed.innerHTML = "";
            if (addDiv) feed.appendChild(addDiv);
            feed.innerHTML += `<div class="empty-state"><div class="empty-state-icon">⚠️</div>Failed to load posts. Check your connection.</div>`;
        }
    }
}

// ─────────────────────── LIKE / REPOST ───────────────────────
async function likePost(postId, btn) {
    const token = localStorage.getItem("token");
    if (!token) { window.location.href = "/root.html"; return; }
    try {
        const res = await fetch("/like_post", {
            method: "POST",
            headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" },
            body: JSON.stringify({ post_id: postId })
        });
        const data = await res.json();
        if (data.msg === "done" && typeof data.liked === "boolean") {
            const span = btn.querySelector(".action-count");
            if (span) {
                const cur = parseInt(span.textContent) || 0;
                span.textContent = data.liked ? cur + 1 : Math.max(0, cur - 1);
            }
            btn.classList.toggle("active", data.liked);
        }
    } catch (err) { console.error("Like error:", err); }
}

async function repostPost(postId, btn) {
    const token = localStorage.getItem("token");
    if (!token) { window.location.href = "/root.html"; return; }
    try {
        const res = await fetch("/repost_post", {
            method: "POST",
            headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" },
            body: JSON.stringify({ post_id: postId })
        });
        const data = await res.json();
        if (data.msg === "done") {
            const span = btn.querySelector(".action-count");
            const wasActive = btn.classList.contains("active");
            if (span) {
                const cur = parseInt(span.textContent) || 0;
                span.textContent = wasActive ? Math.max(0, cur - 1) : cur + 1;
            }
            btn.classList.toggle("active", !wasActive);
        }
    } catch (err) { console.error("Repost error:", err); }
}

// ─────────────────────── COMMENTS ────────────────────────────
function toggleComments(postId) {
    const section = document.getElementById(`comments-section-${postId}`);
    if (!section) return;
    section.classList.toggle("active");
    if (section.classList.contains("active")) loadComments(postId);
}

async function loadComments(postId) {
    const list = document.getElementById(`comments-list-${postId}`);
    const currentUser = localStorage.getItem("username") || "";
    if (!list) return;
    list.innerHTML = `<p style="color:var(--text-muted);font-size:12px;text-align:center;padding:8px;">Loading…</p>`;
    try {
        const res = await fetch(`/get_comments/${postId}`);
        const comments = await res.json();
        list.innerHTML = "";
        if (!comments.length) {
            list.innerHTML = `<p style="color:var(--text-muted);font-size:13px;text-align:center;padding:8px;">No comments yet</p>`;
            return;
        }
        comments.forEach(c => {
            const isOwner = c.username === currentUser;
            const actions = isOwner ? `
                <button class="comment-edit-btn" onclick="startEditComment(this)">
                    <img src="pencil.png" class="comment-icon">
                </button>
                <button class="comment-delete-btn" onclick="deleteComment(${c.id})">
                    <img src="trash.png" class="comment-icon">
                </button>` : "";
            const div = document.createElement("div");
            div.className = "comment-item";
            div.dataset.commentId = c.id;
            div.innerHTML = `
                <img src="${getSafePic(c.profile_picture)}" class="comment-avatar" onclick="loadUserPage('${c.username}')">
                <div class="comment-body">
                    <div class="comment-header">
                        <span class="comment-user" onclick="loadUserPage('${c.username}')">${escapeHtml(c.username)}</span>
                        <span class="comment-time">${getTimeAgo(c.created_at)}</span>
                        <div class="comment-actions">${actions}</div>
                    </div>
                    <p class="comment-text">${escapeHtml(c.content)}</p>
                </div>`;
            list.appendChild(div);
        });
    } catch (err) {
        list.innerHTML = `<p style="color:#ef4444;font-size:12px;text-align:center;">Failed to load comments.</p>`;
    }
}

function startEditComment(btn) {
    const item = btn.closest(".comment-item"); if (!item) return;
    const textP = item.querySelector(".comment-text"); if (!textP) return;
    const current = textP.textContent.trim();
    textP.innerHTML = `<input type="text" class="edit-comment-input" value="${escapeHtml(current).replace(/"/g,'&quot;')}">`;
    item.querySelector(".edit-comment-input").focus();
    const actions = item.querySelector(".comment-actions");
    const container = item.closest(".comment-container");
    const postId = container?.id.split("-")[2];
    if (actions) {
        actions.innerHTML = `
            <button class="comment-save-btn" onclick="saveEditComment(${item.dataset.commentId})">
                <img src="yes.png" style="width:14px;opacity:0.8;">
            </button>
            <button class="comment-cancel-btn" onclick="loadComments(${postId})">
                <img src="no.png" style="width:14px;opacity:0.8;">
            </button>`;
    }
}

async function saveEditComment(commentId) {
    const input = document.querySelector(`[data-comment-id="${commentId}"] .edit-comment-input`);
    const newContent = input?.value.trim(); if (!newContent) return;
    const token = localStorage.getItem("token");
    try {
        const res = await fetch(`/edit_comment/${commentId}`, {
            method: "PUT",
            headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" },
            body: JSON.stringify({ content: newContent })
        });
        const data = await res.json();
        const postId = document.querySelector(`[data-comment-id="${commentId}"]`)
            ?.closest(".comment-container")?.id.split("-")[2];
        if (res.ok) loadComments(postId);
        else showError(data.msg || "Failed to edit comment.");
    } catch (err) { console.error("Edit comment error:", err); }
}

async function deleteComment(commentId) {
    if (!confirm("Delete this comment?")) return;
    const token = localStorage.getItem("token");
    try {
        const res = await fetch(`/delete_comment/${commentId}`, {
            method: "DELETE",
            headers: { "Authorization": "Bearer " + token }
        });
        const data = await res.json();
        if (data.msg === "deleted") {
            const container = document.querySelector(`[data-comment-id="${commentId}"]`)
                ?.closest(".comment-container");
            if (container) {
                const postId = container.id.split("-")[2];
                loadComments(postId);
                const counter = document.querySelector(`[data-comment-count="${postId}"]`);
                if (counter) counter.textContent = Math.max(0, (parseInt(counter.textContent) || 0) - 1);
            }
        }
    } catch (err) { console.error("Delete comment error:", err); }
}

async function submitComment(postId) {
    const input = document.getElementById(`comment-input-${postId}`);
    const content = input?.value.trim(); if (!content) return;
    const token = localStorage.getItem("token"); if (!token) return;
    const sendBtn = document.querySelector(`#comments-section-${postId} .comment-send`);
    if (sendBtn) sendBtn.disabled = true;
    try {
        const res = await fetch("/add_comment", {
            method: "POST",
            headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" },
            body: JSON.stringify({ post_id: postId, content })
        });
        const data = await res.json();
        if (data.msg === "comment_added") {
            input.value = "";
            loadComments(postId);
            const counter = document.querySelector(`[data-comment-count="${postId}"]`);
            if (counter) counter.textContent = (parseInt(counter.textContent) || 0) + 1;
        } else {
            showError(data.msg || "Failed to post comment.");
        }
    } catch (err) { console.error("Submit comment error:", err); }
    finally { if (sendBtn) sendBtn.disabled = false; }
}

// ─────────────────────── USER PAGE ───────────────────────────
async function loadUserPage(username) {
    if (!username) return;
    const token = localStorage.getItem("token");
    const currentUser = localStorage.getItem("username");

    let followStates = { following: [], friends: [] };
    try {
        const r = await fetch("/my_follows", { headers: { "Authorization": "Bearer " + token } });
        if (r.ok) followStates = await r.json();
    } catch (_) {}

    const res = await fetch(`/user/${username}`, {
        headers: { "Authorization": "Bearer " + (token || "") }
    });
    if (!res.ok) { showError("User not found."); return; }
    const user = await res.json();

    const isSelf = username === currentUser;
    let btnText = "Follow", btnBg = "transparent";
    if (followStates.friends.includes(user.username))        { btnText = "Friends";   btnBg = "var(--accent-soft)"; }
    else if (followStates.following.includes(user.username)) { btnText = "Following"; btnBg = "var(--bg-tertiary)"; }

    const centerFeed = document.querySelector(".center-feed");
    if (!centerFeed) return;
    centerFeed.innerHTML = `
        <button onclick="backToFeed()" style="
            display:inline-flex;align-items:center;gap:6px;
            background:transparent;border:1px solid var(--border-color);
            color:var(--text-secondary);padding:7px 16px;border-radius:99px;
            font-size:13px;cursor:pointer;margin-bottom:20px;
            transition:var(--transition);font-family:var(--font-body);"
            onmouseover="this.style.borderColor='var(--accent)';this.style.color='var(--accent)'"
            onmouseout="this.style.borderColor='var(--border-color)';this.style.color='var(--text-secondary)'">
            ← Back
        </button>
        <div style="background:var(--bg-secondary);border:1px solid var(--border-color);border-radius:var(--radius-xl);padding:28px;text-align:center;margin-bottom:22px;">
            <img src="${getSafePic(user.profile_picture)}"
                style="width:80px;height:80px;border-radius:50%;object-fit:cover;border:3px solid var(--border-color);margin-bottom:14px;">
            <h2 style="margin:0 0 4px;font-size:20px;font-weight:800;letter-spacing:-0.02em;">${escapeHtml(user.name || user.username)}</h2>
            <p style="color:var(--text-muted);margin:0 0 16px;font-size:13.5px;">@${escapeHtml(user.username)}</p>
            <div style="display:flex;justify-content:center;gap:28px;margin-bottom:18px;">
                <div><strong style="font-size:18px;font-weight:700;">${user.followers}</strong><br><span style="font-size:12px;color:var(--text-muted);">Followers</span></div>
                <div style="width:1px;background:var(--border-color);"></div>
                <div><strong style="font-size:18px;font-weight:700;">${user.following}</strong><br><span style="font-size:12px;color:var(--text-muted);">Following</span></div>
            </div>
            ${!isSelf ? `<button class="follow-btn" data-user="${user.username}" onclick="toggleFollow('${user.username}')" style="background:${btnBg};">${btnText}</button>` : ""}
            ${isSelf  ? `<button class="edit-profile-btn" onclick="openEditProfile()">✏️ Edit Profile</button>` : ""}
        </div>
        <div id="user-posts-feed"></div>`;

    const feed = document.getElementById("user-posts-feed");
    if (!feed) return;

    if (!user.posts || !user.posts.length) {
        feed.innerHTML = `<div class="empty-state"><div class="empty-state-icon">📭</div>No posts yet</div>`;
    } else {
        user.posts.forEach(p => {
            const el = document.createElement("article");
            el.className = "post-card";
            el.dataset.visibility = p.visibility || "public";
            el.innerHTML = createPostHTML(p);
            feed.appendChild(el);
            
            const slider = el.querySelector(".img-slider");
            if (slider) addSliderSwipe(slider);
        });
    }

    loadFriends();
}

function backToFeed() {
    const centerFeed = document.querySelector(".center-feed");
    if (!centerFeed) return;
    centerFeed.id = "feed-container";
    centerFeed.innerHTML = `
        <div id="add-post">
            <div class="add-post-header">
                <img src="${getSafePic(localStorage.getItem("profile_picture"))}" id="text">
                <textarea id="post-content" placeholder="What's happening?"></textarea>
            </div>
            <div class="preview-wrap" id="preview-wrap" style="display:none;"></div>
            <div class="add-post-actions">
                <div class="add-icons">
                    <label for="post-image" title="Add Images (up to 10)">
                        <img src="image.png" alt="Image">
                    </label>
                    <input type="file" id="post-image" accept="image/*" multiple style="display:none;">
                    <label for="post-video" title="Add Video (Max 20MB)">
                        <img src="video.png" alt="Video" style="opacity:0.8;width:27px;">
                    </label>
                    <input type="file" id="post-video" accept="video/mp4,video/webm,video/quicktime" style="display:none;">
                </div>
                <select id="post-visibility" title="Who can see this post">
                    <option value="public">🌍 Public</option>
                    <option value="friends">👥 Friends</option>
                    <option value="private">🔒 Private</option>
                </select>
                <a class="post-btn" onclick="addPost()"><img src="post.png" alt="Post"></a>
            </div>
        </div>`;
    const pi = document.getElementById("post-image");
    const pv = document.getElementById("post-video");
    if (pi) {
        pi.setAttribute("multiple", "true");
        pi.onchange = function() {
            const files = Array.from(this.files);
            if (!files.length) { cancelAllMedia(); return; }
            tempVideoFile = null;
            const pv2 = document.getElementById("post-video"); if (pv2) pv2.value = "";
            tempFiles = [...tempFiles, ...files.filter(f => f.type.startsWith("image/"))].slice(0, 10);
            renderImagePreviews();
        };
    }
    if (pv) pv.onchange = function() {
        const f = this.files[0]; if (!f) { cancelAllMedia(); return; }
        if (f.size > 20 * 1024 * 1024) { showError("Video too large – max 20 MB."); this.value = ""; return; }
        if (!f.type.startsWith("video/")) { showError("Invalid file type."); this.value = ""; return; }
        const pi2 = document.getElementById("post-image"); if (pi2) pi2.value = "";
        tempFiles = []; tempVideoFile = f; renderImagePreviews();
    };
    tempFiles = []; tempVideoFile = null;
    loadPosts();
}

// ─────────────────────── FOLLOW ──────────────────────────────
async function toggleFollow(username) {
    const token = localStorage.getItem("token"); if (!token) return;
    try {
        const res = await fetch("/follow", {
            method: "POST",
            headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" },
            body: JSON.stringify({ username })
        });
        const data = await res.json();
        if (!res.ok) { showError(data.msg || "Error"); return; }
        document.querySelectorAll(`.follow-btn[data-user="${username}"]`).forEach(btn => {
            const label = data.status === "friends"   ? "Friends"
                        : data.status === "following" ? "Following"
                        : "Follow";
            btn.textContent = label;
            btn.classList.toggle("following", data.status !== "none" && data.status !== undefined);
        });
        if (data.msg === "followed" || data.msg === "unfollowed") loadFriends();
    } catch (err) { console.error("Follow error:", err); }
}

async function loadFriends() {
    const token = localStorage.getItem("token"); if (!token) return;
    try {
        const res = await fetch("/get_friends", {
            headers: { "Authorization": "Bearer " + token }
        });
        if (!res.ok) return;
        const friends = await res.json();
        const list = document.querySelector(".friend-list"); if (!list) return;
        list.innerHTML = "";
        if (!friends.length) {
            list.innerHTML = `<p class="empty-state" style="padding:24px 10px;font-size:13px;">No friends yet.<br>Follow someone!</p>`;
            return;
        }
        friends.forEach(f => {
            const card = document.createElement("div");
            card.className = "friend-card";
            card.innerHTML = `
                <div class="avatar-wrapper">
                    <img src="${getSafePic(f.profile_picture)}" alt="${escapeHtml(f.username)}">
                    <span class="status-dot ${f.is_online ? 'online' : 'offline'}"></span>
                </div>
                <span class="friend-name">${escapeHtml(f.name || f.username)}</span>`;
            card.onclick = () => loadUserPage(f.username);
            list.appendChild(card);
        });
    } catch (err) { console.error("Load friends error:", err); }
}

// ─────────────────────── POST OPTIONS ────────────────────────
function openPostOptions(btn) {
    currentEditId        = btn.dataset.id;
    currentEditContent   = btn.dataset.content;
    currentEditImage     = btn.dataset.image;
    currentEditVideo     = btn.dataset.video || null;
    currentEditVisibility = btn.dataset.visibility || "public";
    document.getElementById("post-options-dialog")?.showModal();
}

function openEditDialog() {
    document.getElementById("post-options-dialog")?.close();
    document.getElementById("edit-visibility")?.remove();

    const editContent = document.getElementById("edit-content");
    if (editContent) editContent.value = currentEditContent;

    const preview = document.getElementById("edit-preview");
    if (preview) {
        if (currentEditVideo) {
            preview.innerHTML = `<video controls style="max-width:100%;border-radius:10px;"><source src="${currentEditVideo}" type="video/mp4"></video>`;
        } else if (currentEditImage) {
            preview.innerHTML = `<img src="${currentEditImage}" style="max-width:100%;border-radius:10px;">`;
        } else {
            preview.innerHTML = "";
        }
    }

    const visSelect = document.createElement("select");
    visSelect.id = "edit-visibility";
    visSelect.innerHTML = `
        <option value="public"  ${currentEditVisibility === "public"  ? "selected" : ""}>🌍 Public</option>
        <option value="friends" ${currentEditVisibility === "friends" ? "selected" : ""}>👥 Friends Only</option>
        <option value="private" ${currentEditVisibility === "private" ? "selected" : ""}>🔒 Private</option>`;
    if (preview) preview.parentNode.insertBefore(visSelect, preview);

    document.getElementById("edit-dialog")?.showModal();
}

async function deleteCurrentPost() {
    if (!confirm("Permanently delete this post?")) return;
    try {
        const res = await fetch(`/delete_post/${currentEditId}`, {
            method: "DELETE",
            headers: { "Authorization": "Bearer " + localStorage.getItem("token") }
        });
        const data = await res.json();
        if (data.msg === "deleted") {
            document.getElementById("post-options-dialog")?.close();
            showSuccess("Post deleted.");
            if (document.getElementById("user-posts-feed")) {
                loadUserPage(localStorage.getItem("username"));
            } else {
                loadPosts();
            }
        } else {
            showError(data.msg || "Failed to delete.");
        }
    } catch (err) { console.error("Delete post error:", err); }
}

async function saveEdit() {
    const token = localStorage.getItem("token");
    const formData = new FormData();
    const content    = document.getElementById("edit-content")?.value.trim();
    const visibility = document.getElementById("edit-visibility")?.value;
    if (content    !== undefined) formData.append("content", content);
    if (visibility)               formData.append("visibility", visibility);
    const file = document.getElementById("edit-image")?.files[0];
    if (file) formData.append("image", file);

    const saveBtn = document.querySelector("#edit-dialog .edit-actions button:first-child");
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = "Saving…"; }

    try {
        const res  = await fetch(`/edit_post/${currentEditId}`, {
            method: "PUT",
            headers: { "Authorization": "Bearer " + token },
            body: formData
        });
        const data = await res.json();
        if (data.msg === "updated") {
            document.getElementById("edit-dialog")?.close();
            showSuccess("Post updated!");
            if (document.getElementById("user-posts-feed")) {
                loadUserPage(localStorage.getItem("username"));
            } else {
                loadPosts();
            }
        } else {
            showError(data.msg || "Failed to update.");
        }
    } catch (err) {
        console.error("Save edit error:", err);
        showError("Connection error.");
    } finally {
        if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = "Save Changes"; }
    }
}

// ─────────────────────── PROFILE ─────────────────────────────
async function openEditProfile() {
    document.getElementById("edit-profile-dialog")?.showModal();
    try {
        const res  = await fetch("/get_my_info", {
            headers: { "Authorization": "Bearer " + localStorage.getItem("token") }
        });
        if (!res.ok) throw new Error();
        const data = await res.json();
        const map = { "edit-name": "name", "edit-username": "username", "edit-email": "email", "edit-phone": "phone" };
        Object.entries(map).forEach(([id, key]) => {
            const el = document.getElementById(id);
            if (el) el.value = data[key] || "";
        });
        const prev = document.getElementById("edit-profile-preview");
        if (prev) prev.src = getSafePic(data.profile_picture);
        const emailEl = document.getElementById("edit-email");
        const phoneEl = document.getElementById("edit-phone");
        if (emailEl) emailEl.readOnly = !!data.email;
        if (phoneEl) phoneEl.readOnly = !!data.phone;
    } catch (err) {
        showError("Failed to load profile info.");
    }
    document.getElementById("password-section").style.display = "none";
    ["edit-old-pass","edit-new-pass","edit-confirm-pass"].forEach(id => {
        const el = document.getElementById(id); if (el) el.value = "";
    });
    document.getElementById("edit-profile-image").value = "";
    ["error-user","error-email","error-phone","error-old-pass","error-new-pass"].forEach(id => {
        const el = document.getElementById(id); if (el) el.innerText = "";
    });
}

async function saveProfileChanges() {
    const token = localStorage.getItem("token");
    const formData = new FormData();
    ["edit-name","edit-username","edit-email","edit-phone"].forEach(id => {
        const el = document.getElementById(id);
        if (el) formData.append(id.replace("edit-",""), el.value.trim());
    });

    const passSec = document.getElementById("password-section");
    if (passSec?.style.display === "block") {
        const old  = document.getElementById("edit-old-pass").value;
        const newP = document.getElementById("edit-new-pass").value;
        const conf = document.getElementById("edit-confirm-pass").value;
        if (!old || !newP) { showError("Enter old & new password."); return; }
        if (newP !== conf) { showError("Passwords don't match."); return; }
        if (newP.length < 6) { showError("Password must be at least 6 characters."); return; }
        formData.append("old_password", old);
        formData.append("new_password", newP);
    }

    const img = document.getElementById("edit-profile-image").files[0];
    if (img) formData.append("profile_image", img);

    const saveBtn = document.querySelector(".save-btn");
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = "Saving…"; }

    try {
        const res  = await fetch("/update_profile", {
            method: "POST",
            headers: { "Authorization": "Bearer " + token },
            body: formData
        });
        const data = await res.json();
        if (!res.ok) {
            ["error-user","error-email","error-phone","error-old-pass","error-new-pass"].forEach(id => {
                const el = document.getElementById(id); if (el) el.innerText = "";
            });
            const errMap = {
                username_taken:         ["error-user",     "Username already taken"],
                email_used:             ["error-email",    "Email already in use"],
                phone_used:             ["error-phone",    "Phone already in use"],
                old_password_incorrect: ["error-old-pass", "Wrong password"],
                password_too_short:     ["error-new-pass", "Min 6 characters"],
            };
            if (errMap[data.msg]) {
                const [id, msg] = errMap[data.msg];
                const el = document.getElementById(id); if (el) el.innerText = msg;
            } else {
                showError(data.msg || "Failed to update profile.");
            }
            return;
        }
        localStorage.setItem("username", data.username);
        localStorage.setItem("profile_picture", data.profile_picture);
        document.getElementById("edit-profile-dialog")?.close();
        const pi = document.getElementById("profile-img"); if (pi) pi.src = getSafePic(data.profile_picture);
        showSuccess("Profile updated! ✨");
        setTimeout(() => location.reload(), 900);
    } catch (err) {
        showError("Connection error.");
    } finally {
        if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = "Save Changes"; }
    }
}

function togglePasswordSection() {
    const sec = document.getElementById("password-section");
    sec.style.display = sec.style.display === "none" ? "block" : "none";
}

// ─────────────────────── FULLSCREEN ──────────────────────────
function openFull(src) {
    const dialog = document.getElementById("v");
    if (dialog) { dialog.querySelector("img").src = src; dialog.showModal(); }
}
function closeFull() { document.getElementById("v")?.close(); }

// ─────────────────────── INIT ────────────────────────────────
document.addEventListener("DOMContentLoaded", async function () {
    if (isMessagesPage) return;

    const pic = localStorage.getItem("profile_picture");
    const p1  = document.getElementById("profile-img");
    const p2  = document.getElementById("text");
    if (p1) p1.src = getSafePic(pic);
    if (p2) p2.src = getSafePic(pic);

    if (!localStorage.getItem("token")) {
        window.location.href = "/root.html"; return;
    }

    try {
        const res = await fetch("/api/verify", {
            headers: { "Authorization": "Bearer " + localStorage.getItem("token") }
        });
        if (!res.ok) { localStorage.removeItem("token"); window.location.href = "/root.html"; return; }
        const data = await res.json();
        if (data.username && !localStorage.getItem("username")) {
            localStorage.setItem("username", data.username);
        }
    } catch (_) {}

    document.querySelectorAll("dialog").forEach(dialog => {
        dialog.addEventListener("click", e => {
            const box = dialog.querySelector(".confirm-box, .options-box, .edit-box, .edit-profile-box");
            if (box && !box.contains(e.target)) dialog.close();
        });
    });

    initSearch();
    await loadPosts();
    loadFriends();
    setInterval(loadFriends, 30000);
});
