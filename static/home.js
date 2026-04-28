const isMessagesPage = window.location.pathname.includes('messages.html');

let tempFile = null;
let currentEditId = null, currentEditContent = "", currentEditImage = "", currentEditVideo = null;

// ===== UTILITIES =====
function getSafePic(pic) { return (pic && pic !== "unknown") ? pic : "unkown.png"; }
function escapeHtml(text) { const d = document.createElement("div"); d.textContent = text; return d.innerHTML; }
function getTimeAgo(dateStr) {
    if (!dateStr) return "";
    const date = new Date(dateStr.replace(" ", "T") + "Z");
    const diff = Math.floor((Date.now() - date) / 1000);
    if (diff < 60) return "now";
    if (diff < 3600) return Math.floor(diff / 60) + "m";
    if (diff < 86400) return Math.floor(diff / 3600) + "h";
    return Math.floor(diff / 86400) + "d";
}
function toggleAction(btn) { btn.classList.toggle('active'); }
function setActive(el, e) { e.preventDefault(); document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active')); el.classList.add('active'); }

function showToast(message, type = "info", duration = 4000) {
    const container = document.getElementById("toast-container");
    if (!container) return;
    const icons = { success: "✅", error: "❌", warning: "⚠️", info: "ℹ️" };
    const toast = document.createElement("div");
    toast.className = `toast ${type}`;
    toast.innerHTML = `<span class="toast-icon">${icons[type] || "ℹ️"}</span><span class="toast-message">${message}</span><button class="toast-close" onclick="this.parentElement.remove()">×</button>`;
    container.appendChild(toast);
    setTimeout(() => { toast.classList.add("hiding"); setTimeout(() => toast.remove(), 300); }, duration);
}
function showSuccess(msg) { showToast(msg, "success"); }
function showError(msg) { showToast(msg, "error"); }

// ===== CLEAR PREVIEW & RESET =====
function cancelImage() {
    tempFile = null;
    currentEditVideo = null;
    const pi = document.getElementById("post-image"); if (pi) pi.value = "";
    const pv = document.getElementById("post-video"); if (pv) pv.value = "";
    const w = document.getElementById("preview-wrap");
    if (w) { w.innerHTML = ""; w.style.display = "none"; }
}

// ===== DYNAMIC PREVIEW HANDLERS (IMAGE & VIDEO) =====
if (!isMessagesPage) {
    const previewWrap = document.getElementById("preview-wrap");
    
    // Image Preview
    const postImage = document.getElementById("post-image");
    if (postImage && previewWrap) {
        postImage.onchange = function () {
            const file = this.files[0];
            previewWrap.innerHTML = ""; // Clear previous
            tempFile = file;
            currentEditVideo = null;
            if (file) {
                const img = document.createElement("img");
                img.id = "preview";
                img.src = URL.createObjectURL(file);
                img.style.cssText = "max-width:100%; max-height:300px; border-radius:var(--radius-md); object-fit:contain; display:block; margin:0 auto;";
                previewWrap.appendChild(img);
                previewWrap.style.display = "block";
            } else {
                previewWrap.style.display = "none";
            }
        };
    }
    
    // Video Preview
    const postVideo = document.getElementById("post-video");
    if (postVideo && previewWrap) {
        postVideo.onchange = function () {
            const file = this.files[0];
            previewWrap.innerHTML = ""; // Clear previous
            if (file) {
                if (file.size > 20 * 1024 * 1024) {
                    showToast("Video too large. Max 20MB allowed.", "error");
                    this.value = "";
                    previewWrap.style.display = "none";
                    return;
                }
                if (!file.type.startsWith("video/")) {
                    showToast("Invalid file type. Please upload MP4, WebM, or MOV.", "error");
                    this.value = "";
                    previewWrap.style.display = "none";
                    return;
                }
                const video = document.createElement("video");
                video.id = "preview";
                video.src = URL.createObjectURL(file);
                video.controls = true;
                video.playsInline = true;
                video.muted = true;
                video.style.cssText = "max-width:100%; max-height:300px; border-radius:var(--radius-md); display:block; margin:0 auto; background:#000;";
                previewWrap.appendChild(video);
                previewWrap.style.display = "block";
                tempFile = file;
                currentEditVideo = null;
                video.play().catch(() => {}); // Safe autoplay
            } else {
                previewWrap.style.display = "none";
            }
        };
    }
}

// ===== POST CREATION =====
function addPost() {
    const text = document.getElementById("post-content")?.value.trim();
    if (!text && !tempFile) return alert("Write something or add image/video 😑");
    const ct = document.getElementById("confirm-text"); if (ct) ct.innerText = text;
    
    const confirmBox = document.getElementById("confirm-post").querySelector(".confirm-box");
    let existing = confirmBox.querySelector("#confirm-media");
    if (existing) existing.remove();
    
    const mediaDiv = document.createElement("div");
    mediaDiv.id = "confirm-media";
    mediaDiv.style.margin = "12px 0";
    
    if (tempFile) {
        if (tempFile.type.startsWith("video/")) {
            const vid = document.createElement("video");
            vid.src = URL.createObjectURL(tempFile);
            vid.controls = true; vid.playsInline = true;
            vid.style.cssText = "max-width:100%; max-height:200px; border-radius:8px; display:block; margin:0 auto;";
            mediaDiv.appendChild(vid);
        } else {
            const img = document.createElement("img");
            img.src = URL.createObjectURL(tempFile);
            img.style.cssText = "max-width:100%; max-height:200px; border-radius:8px; display:block; margin:0 auto; object-fit:contain;";
            mediaDiv.appendChild(img);
        }
    }
    confirmBox.appendChild(mediaDiv);
    
    const cp = document.getElementById("confirm-post"); if (cp) cp.showModal();
}
function closeConfirm() { const cp = document.getElementById("confirm-post"); if (cp) cp.close(); }

// ===== CLOUDINARY VIDEO UPLOAD =====
async function handleVideoUpload(file) {
    console.log("📹 Starting video upload...", file.name);
    const MAX_SIZE = 20 * 1024 * 1024;
    if (file.size > MAX_SIZE) return showError("Video too large. Max 20MB."), null;
    if (!file.type.startsWith("video/")) return showError("Invalid video format."), null;

    const formData = new FormData();
    formData.append("file", file, file.name);
    formData.append("upload_preset", "video_posts");
    formData.append("resource_type", "video");
    formData.append("tags", "social_grid_posts");

    try {
        const res = await fetch("https://api.cloudinary.com/v1_1/dlimysibj/video/upload", { method: "POST", body: formData });
        const data = await res.json();
        if (!res.ok || data.error) { showError(data.error?.message || "Upload failed"); return null; }
        return data.secure_url;
    } catch (err) { console.error("🌐 Upload error:", err); showError("Connection error"); return null; }
}

// ===== SUBMIT POST =====
async function submitPost() {
    const token = localStorage.getItem("token");
    if (!token) return window.location.href = "/root.html";
    const text = document.getElementById("post-content")?.value;
    
    let imageUrl = null, videoUrl = null;
    if (tempFile) {
        if (tempFile.type.startsWith("video/")) {
            videoUrl = await handleVideoUpload(tempFile);
            if (!videoUrl) return;
        } else {
            const formData = new FormData();
            formData.append("file", tempFile);
            formData.append("upload_preset", "video_posts");
            formData.append("resource_type", "image");
            const res = await fetch("https://api.cloudinary.com/v1_1/dlimysibj/image/upload", { method: "POST", body: formData });
            const data = await res.json();
            imageUrl = data.secure_url;
            if (!imageUrl) return showError("Image upload failed");
        }
    }

    const formData = new FormData();
    if (text) formData.append("content", text);
    if (imageUrl) formData.append("image_url", imageUrl);
    if (videoUrl) formData.append("video_url", videoUrl);

    try {
        const res = await fetch("/add_post", { method: "POST", headers: { "Authorization": "Bearer " + token }, body: formData });
        const data = await res.json();
        if (!res.ok) {
            showError(data.msg || "Failed to post");
            if (["token_expired", "invalid_token", "no token"].includes(data.msg)) {
                localStorage.removeItem("token"); window.location.href = "/root.html";
            }
            return;
        }
        document.getElementById("post-content").value = "";
        cancelImage(); closeConfirm(); loadPosts(); showSuccess("Post published! 🎉");
    } catch (err) { console.error("Post error:", err); alert("Connection error"); }
}

// ===== FEED =====
function createPostHTML(p) {
    const isFeed = !document.getElementById("user-posts-feed");
    const followBtn = isFeed ? `<button class="follow-btn" data-user="${p.username}" onclick="event.stopPropagation(); toggleFollow('${p.username}')" style="margin-left:auto;background:transparent;border:1px solid var(--border-color);color:var(--text-secondary);padding:5px 14px;border-radius:99px;font-size:13px;font-weight:500;cursor:pointer;">Follow</button>` : '';
    const optionsBtn = isFeed ? '' : `
        <button class="post-options-btn" onclick="openPostOptions(this)" data-id="${p.id}" data-content="${escapeHtml(p.content || '')}" data-image="${p.image || ''}" data-video="${p.video || ''}">⋯</button>`;
    
    return `
        <div class="post-header">
            <img src="${getSafePic(p.profile_picture)}" class="post-avatar" style="cursor:pointer;" onclick="loadUserPage('${p.username}')">
            <span class="post-username" style="cursor:pointer;" onclick="loadUserPage('${p.username}')">${p.username}</span>
            ${followBtn}${optionsBtn}
        </div>
        <div class="post-content">
            ${p.content ? `<p>${escapeHtml(p.content)}</p>` : ""}
            ${p.video ? `<video controls preload="metadata" playsinline style="max-width:100%;border-radius:var(--radius-md);background:#000;margin:8px 0;"><source src="${p.video}" type="video/mp4">Browser doesn't support video.</video>` : ""}
            ${p.image && !p.video ? `<img src="${p.image}" onclick="openFull(this.src)" style="max-width:100%;border-radius:var(--radius-md);margin:8px 0;">` : ""}
        </div>
        <div class="post-actions">
            <button class="action-btn" onclick="likePost(${p.id}, this)"><img src="heart.png" class="action-icon"><span class="action-count">${p.likes}</span></button>
            <button class="action-btn comment-toggle" data-comment-toggle="${p.id}" onclick="toggleComments(${p.id})"><img src="chat.png" class="action-icon"><span class="action-count" data-comment-count="${p.id}">${p.comments}</span></button>
            <button class="action-btn" onclick="repostPost(${p.id}, this)"><img src="repost.png" class="action-icon"><span class="action-count">${p.reposts}</span></button>
        </div>
        <div id="comments-section-${p.id}" class="comment-container">
            <div id="comments-list-${p.id}" class="comments-list"></div>
            <div class="comment-input-wrap">
                <input type="text" id="comment-input-${p.id}" class="comment-input" placeholder="Write a comment...">
                <button class="comment-send" onclick="submitComment(${p.id})">Send</button>
            </div>
        </div>`;
}

async function loadPosts() {
    if (isMessagesPage) return;
    const token = localStorage.getItem("token");
    const currentUsername = localStorage.getItem("username") || "";
    let followStates = { following: [], friends: [] };
    try { const res = await fetch("/my_follows", { headers: { "Authorization": "Bearer " + token } }); if (res.ok) followStates = await res.json(); } catch (e) {}
    
    try {
        const res = await fetch("/get_posts");
        const allPosts = await res.json();
        const posts = allPosts.filter(p => p.username !== currentUsername);
        const feed = document.getElementById("feed-container");
        const addDiv = document.getElementById("add-post");
        if (!feed) return;
        feed.innerHTML = ""; if (addDiv) feed.appendChild(addDiv);
        if (posts.length === 0) { feed.innerHTML += `<p style="text-align:center;color:var(--text-muted);padding:40px;margin-top:20px;">No posts yet. Follow someone!</p>`; return; }
        
        posts.forEach(p => {
            const status = followStates.friends.includes(p.username) ? "Friends" : followStates.following.includes(p.username) ? "Following" : "Follow";
            const postEl = document.createElement("article");
            postEl.className = "post-card"; postEl.innerHTML = createPostHTML(p);
            // Update follow button state
            const btn = postEl.querySelector('.follow-btn');
            if (btn) { btn.textContent = status; btn.style.background = status === 'Follow' ? '' : 'var(--bg-tertiary)'; }
            feed.appendChild(postEl);
        });
    } catch (err) { console.error("Load posts error:", err); }
}

// ===== ACTIONS =====
async function likePost(postId, btn) {
    const token = localStorage.getItem("token"); if (!token) return;
    try {
        const res = await fetch("/like_post", { method: "POST", headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" }, body: JSON.stringify({ post_id: postId }) });
        const data = await res.json();
        if (data.msg === "liked" || data.msg === "unliked") {
            const countSpan = btn.querySelector(".action-count");
            if (countSpan) { const cur = parseInt(countSpan.textContent) || 0; countSpan.textContent = data.msg === "liked" ? cur + 1 : cur - 1; btn.classList.toggle("active", data.msg === "liked"); }
        }
    } catch (err) { console.error("Like error:", err); }
}

async function repostPost(postId, btn) {
    const token = localStorage.getItem("token"); if (!token) return;
    try {
        const res = await fetch("/repost_post", { method: "POST", headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" }, body: JSON.stringify({ post_id: postId }) });
        const data = await res.json();
        if (data.msg === "reposted" || data.msg === "unreposted") {
            const countSpan = btn.querySelector(".action-count");
            if (countSpan) { const cur = parseInt(countSpan.textContent) || 0; countSpan.textContent = data.msg === "reposted" ? cur + 1 : cur - 1; btn.classList.toggle("active", data.msg === "reposted"); }
        }
    } catch (err) { console.error("Repost error:", err); }
}

// ===== COMMENTS =====
function toggleComments(postId) {
    const section = document.getElementById(`comments-section-${postId}`);
    if (section) { section.classList.toggle("active"); if (section.classList.contains("active")) loadComments(postId); }
}

async function loadComments(postId) {
    const list = document.getElementById(`comments-list-${postId}`);
    const currentUser = localStorage.getItem("username") || "";
    if (!list) return; list.innerHTML = `<p style="color:var(--text-muted);font-size:12px;text-align:center;">Loading...</p>`;
    try {
        const res = await fetch(`/get_comments/${postId}`); const comments = await res.json();
        list.innerHTML = ""; if (!comments.length) { list.innerHTML = `<p style="color:var(--text-muted);font-size:13px;text-align:center;">No comments yet</p>`; return; }
        comments.forEach(c => {
            const isOwner = c.username === currentUser;
            const actions = isOwner ? `<button class="comment-edit-btn" onclick="startEditComment(this)"><img src="pencil.png" class="comment-icon"></button><button class="comment-delete-btn" onclick="deleteComment(${c.id})"><img src="trash.png" class="comment-icon"></button>` : '';
            const div = document.createElement("div"); div.className = "comment-item"; div.setAttribute("data-comment-id", c.id);
            div.innerHTML = `<img src="${getSafePic(c.profile_picture)}" class="comment-avatar" onclick="loadUserPage('${c.username}')"><div class="comment-body"><div class="comment-header"><span class="comment-user" onclick="loadUserPage('${c.username}')">${c.username}</span><span class="comment-time">${getTimeAgo(c.created_at)}</span><div class="comment-actions">${actions}</div></div><p class="comment-text">${escapeHtml(c.content)}</p></div>`;
            list.appendChild(div);
        });
    } catch (err) { list.innerHTML = `<p style="color:red;font-size:12px;text-align:center;">Failed</p>`; }
}

function startEditComment(btn) {
    const item = btn.closest(".comment-item"); if (!item) return;
    const textP = item.querySelector(".comment-text"); if (!textP) return;
    const currentText = textP.textContent.trim();
    textP.innerHTML = `<input type="text" class="edit-comment-input" value="${escapeHtml(currentText).replace(/"/g, '&quot;')}">`;
    item.querySelector(".edit-comment-input").focus();
    const actionsDiv = item.querySelector(".comment-actions");
    if (actionsDiv) { actionsDiv.innerHTML = `<a class="comment-save-btn" onclick="saveEditComment(${item.dataset.commentId})"><img src="yes.png"></a><a class="comment-cancel-btn" onclick="loadComments(${item.closest('.comment-container').id.split('-')[2]})"><img src="no.png"></a>`; }
}

async function saveEditComment(commentId) {
    const input = document.querySelector(`[data-comment-id="${commentId}"] .edit-comment-input`);
    const newContent = input?.value.trim(); if (!newContent) return;
    const token = localStorage.getItem("token");
    try {
        const res = await fetch(`/edit_comment/${commentId}`, { method: "PUT", headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" }, body: JSON.stringify({ content: newContent }) });
        const data = await res.json();
        if (res.ok) loadComments(document.querySelector(`[data-comment-id="${commentId}"]`)?.closest(".comment-container")?.id.split("-")[2]);
        else showError(data.msg || "Failed to edit");
    } catch (err) { console.error("Edit comment error:", err); }
}

async function deleteComment(commentId) {
    if (!confirm("Delete this comment?")) return;
    const token = localStorage.getItem("token");
    try {
        const res = await fetch(`/delete_comment/${commentId}`, { method: "DELETE", headers: { "Authorization": "Bearer " + token } });
        const data = await res.json();
        if (data.msg === "deleted") {
            const container = document.querySelector(`[data-comment-id="${commentId}"]`)?.closest(".comment-container");
            if (container) { loadComments(container.id.split("-")[2]); const counter = document.querySelector(`[data-comment-count="${container.id.split('-')[2]}"]`); if (counter) counter.textContent = Math.max(0, (parseInt(counter.textContent)||0) - 1); }
        }
    } catch (err) { console.error("Delete comment error:", err); }
}

async function submitComment(postId) {
    const input = document.getElementById(`comment-input-${postId}`);
    const content = input?.value.trim(); if (!content) return;
    const token = localStorage.getItem("token"); if (!token) return;
    try {
        const res = await fetch("/add_comment", { method: "POST", headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" }, body: JSON.stringify({ post_id: postId, content }) });
        const data = await res.json();
        if (data.msg === "comment_added") { input.value = ""; loadComments(postId); const counter = document.querySelector(`[data-comment-count="${postId}"]`); if (counter) counter.textContent = (parseInt(counter.textContent)||0) + 1; }
    } catch (err) { console.error("Submit comment error:", err); }
}

// ===== USER PAGE & FOLLOWS =====
async function loadUserPage(username) {
    const token = localStorage.getItem("token");
    let followStates = { following: [], friends: [] };
    try { const res = await fetch("/my_follows", { headers: { "Authorization": "Bearer " + token } }); if (res.ok) followStates = await res.json(); } catch (e) {}
    
    const res = await fetch(`/user/${username}`); if (!res.ok) return alert("User not found");
    const user = await res.json();
    const currentUser = localStorage.getItem("username");
    let btnText = "Follow", btnBg = "transparent", showBtn = username !== currentUser;
    if (followStates.friends.includes(user.username)) { btnText = "Friends"; btnBg = "var(--accent-soft)"; }
    else if (followStates.following.includes(user.username)) { btnText = "Following"; btnBg = "var(--bg-tertiary)"; }
    
    const layout = document.querySelector(".layout"); if (!layout) return;
    layout.innerHTML = `
        <nav class="sidebar left-sidebar">
            <a href="/home.html" class="nav-item active"><img src="home.png" class="nav-icon"><span class="nav-label">Home</span></a>
            <a href="/messages.html" class="nav-item"><img src="chat.png" class="nav-icon"><span class="nav-label">Messages</span></a>
            <a href="#" class="nav-item" onclick="setActive(this,event)"><img src="search2.png" class="nav-icon"><span class="nav-label">Explore</span></a>
            <a href="#" class="nav-item" onclick="setActive(this,event)"><img src="save.png" class="nav-icon"><span class="nav-label">Saved</span></a>
            <a href="#" class="nav-item" onclick="setActive(this,event)"><img src="setting.png" class="nav-icon"><span class="nav-label">Settings</span></a>
        </nav>
        <section class="center-feed" style="padding:20px;">
            <div style="background:var(--bg-secondary);border:1px solid var(--border-color);border-radius:var(--radius-lg);padding:24px;text-align:center;margin-bottom:20px;">
                <img src="${getSafePic(user.profile_picture)}" style="width:80px;height:80px;border-radius:50%;object-fit:cover;margin-bottom:12px;">
                <h2 style="margin:0 0 4px;">${user.name || user.username}</h2>
                <p style="color:var(--text-muted);margin:0 0 12px;">@${user.username}</p>
                <div style="display:flex;justify-content:center;gap:24px;margin-bottom:16px;">
                    <span><strong>${user.followers}</strong> Followers</span><span><strong>${user.following}</strong> Following</span>
                </div>
                ${showBtn ? `<button class="follow-btn" data-user="${user.username}" onclick="toggleFollow('${user.username}')" style="background:${btnBg};color:var(--text-secondary);padding:6px 18px;border-radius:99px;font-size:13px;cursor:pointer;border:1px solid var(--border-color);">${btnText}</button>` : ""}
                ${username === currentUser ? `<button class="edit-profile-btn" onclick="openEditProfile()">Edit Profile</button>` : ""}
            </div>
            <div id="user-posts-feed"></div>
        </section>
        <aside class="sidebar right-sidebar"><h3 class="sidebar-title">Friends</h3><div class="friend-list"></div></aside>`;
        
    const feed = document.getElementById("user-posts-feed"); if (!feed) return;
    if (!user.posts || user.posts.length === 0) { feed.innerHTML = `<p style="text-align:center;color:var(--text-muted);padding:40px;">No posts yet</p>`; }
    else { user.posts.forEach(p => { const el = document.createElement("article"); el.className = "post-card"; el.innerHTML = createPostHTML(p); feed.appendChild(el); }); }
    loadFriends();
}

async function toggleFollow(username) {
    const token = localStorage.getItem("token"); if (!token) return;
    try {
        const res = await fetch("/follow", { method: "POST", headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" }, body: JSON.stringify({ username }) });
        const data = await res.json();
        if (data.msg) {
            const btn = document.querySelector(`.follow-btn[data-user="${username}"]`);
            if (btn) { btn.textContent = data.status === "friends" ? "Friends" : data.status === "following" ? "Following" : "Follow"; btn.classList.toggle("following", data.status.includes("friends") || data.status === "following"); }
            if (data.msg === "friends" || data.msg === "unfollowed") loadFriends();
        }
    } catch (err) { console.error("Follow error:", err); }
}

async function loadFriends() {
    const token = localStorage.getItem("token"); if (!token) return;
    try {
        const res = await fetch("/get_friends", { headers: { "Authorization": "Bearer " + token } }); if (!res.ok) return;
        const friends = await res.json();
        const list = document.querySelector(".friend-list"); if (!list) return; list.innerHTML = "";
        if (!friends.length) { list.innerHTML = `<p style="color:var(--text-muted);text-align:center;padding:20px;font-size:13px;">No friends yet.</p>`; return; }
        friends.forEach(f => {
            const card = document.createElement("div"); card.className = "friend-card";
            card.innerHTML = `<div class="avatar-wrapper"><img src="${getSafePic(f.profile_picture)}" alt="${f.username}"><span class="status-dot ${f.is_online ? 'online' : 'offline'}"></span></div><span class="friend-name">${f.name || f.username}</span>`;
            card.onclick = () => loadUserPage(f.username); list.appendChild(card);
        });
    } catch (err) { console.error("Load friends error:", err); }
}

// ===== POST EDIT/DELETE =====
function openPostOptions(btn) {
    currentEditId = btn.dataset.id; currentEditContent = btn.dataset.content;
    currentEditImage = btn.dataset.image; currentEditVideo = btn.dataset.video;
    document.getElementById("post-options-dialog")?.showModal();
}
function openEditDialog() {
    document.getElementById("post-options-dialog")?.close();
    document.getElementById("edit-content").value = currentEditContent;
    const preview = document.getElementById("edit-preview");
    if (currentEditVideo) preview.innerHTML = `<video controls style="max-width:100%;border-radius:8px;"><source src="${currentEditVideo}" type="video/mp4"></video>`;
    else if (currentEditImage) preview.innerHTML = `<img src="${currentEditImage}">`;
    else preview.innerHTML = "";
    document.getElementById("edit-dialog")?.showModal();
}
async function deleteCurrentPost() {
    if (!confirm("Delete this post?")) return;
    try {
        const res = await fetch(`/delete_post/${currentEditId}`, { method: "DELETE", headers: { "Authorization": "Bearer " + localStorage.getItem("token") } });
        if ((await res.json()).msg === "deleted") {
            document.getElementById("post-options-dialog")?.close();
            document.getElementById("user-posts-feed") ? loadUserPage(localStorage.getItem("username")) : loadPosts();
        }
    } catch (err) { console.error("Delete error:", err); }
}
async function saveEdit() {
    const token = localStorage.getItem("token");
    const formData = new FormData();
    const content = document.getElementById("edit-content")?.value.trim();
    if (content) formData.append("content", content);
    const file = document.getElementById("edit-image")?.files[0];
    if (file) formData.append("image", file);
    try {
        if ((await fetch(`/edit_post/${currentEditId}`, { method: "PUT", headers: { "Authorization": "Bearer " + token }, body: formData })).json().msg === "updated") {
            document.getElementById("edit-dialog")?.close();
            document.getElementById("user-posts-feed") ? loadUserPage(localStorage.getItem("username")) : loadPosts();
        }
    } catch (err) { console.error("Edit error:", err); }
}

// ===== PROFILE EDIT =====
async function openEditProfile(e) {
    if (e) e.preventDefault();
    document.getElementById("edit-profile-dialog")?.showModal();
    try {
        const res = await fetch("/get_my_info", { headers: { "Authorization": "Bearer " + localStorage.getItem("token") } });
        if (!res.ok) throw new Error(await res.text());
        const data = await res.json();
        ["edit-name", "edit-username", "edit-email", "edit-phone"].forEach(id => { const el = document.getElementById(id); if (el) el.value = data[id.replace("edit-", "")] || ""; });
        document.getElementById("edit-profile-preview").src = getSafePic(data.profile_picture);
        if (data.email) document.getElementById("edit-email").readOnly = true;
        if (data.phone) document.getElementById("edit-phone").readOnly = true;
    } catch (err) { console.error("Failed to load profile:", err); }
    document.getElementById("password-section").style.display = "none";
    ["edit-old-pass", "edit-new-pass", "edit-confirm-pass"].forEach(id => document.getElementById(id).value = "");
    document.getElementById("edit-profile-image").value = "";
}

async function saveProfileChanges() {
    const token = localStorage.getItem("token");
    const formData = new FormData();
    ["edit-name", "edit-username", "edit-email", "edit-phone"].forEach(id => { const el = document.getElementById(id); if (el) formData.append(id.replace("edit-", ""), el.value.trim()); });
    const passSec = document.getElementById("password-section");
    if (passSec.style.display === "block") {
        const old = document.getElementById("edit-old-pass").value, newP = document.getElementById("edit-new-pass").value, conf = document.getElementById("edit-confirm-pass").value;
        if (!old || !newP) return showError("Enter old & new password");
        if (newP !== conf) return showError("Passwords don't match");
        formData.append("old_password", old); formData.append("new_password", newP);
    }
    const img = document.getElementById("edit-profile-image").files[0];
    if (img) formData.append("profile_image", img);
    try {
        const res = await fetch("/update_profile", { method: "POST", headers: { "Authorization": "Bearer " + token }, body: formData });
        const data = await res.json();
        if (!res.ok) {
            ["error-user", "error-email", "error-phone", "error-old-pass", "error-new-pass"].forEach(id => { const el = document.getElementById(id); if (el) el.innerText = ""; });
            if (data.msg === "username_taken") document.getElementById("error-user").innerText = "Taken";
            else if (data.msg === "email_used") document.getElementById("error-email").innerText = "Used";
            else if (data.msg === "phone_used") document.getElementById("error-phone").innerText = "Used";
            else if (data.msg === "old_password_incorrect") document.getElementById("error-old-pass").innerText = "Wrong";
            else if (data.msg === "password_too_short") document.getElementById("error-new-pass").innerText = "Min 6 chars";
            return;
        }
        localStorage.setItem("username", data.username); localStorage.setItem("profile_picture", data.profile_picture);
        document.getElementById("edit-profile-dialog").close();
        document.getElementById("profile-img").src = getSafePic(data.profile_picture);
        showSuccess("Profile updated! ✨");
        setTimeout(() => location.reload(), 1000);
    } catch (err) { alert("Connection error"); }
}
function togglePasswordSection() { document.getElementById("password-section").style.display = document.getElementById("password-section").style.display === "none" ? "block" : "none"; }

// ===== INIT =====
document.addEventListener("DOMContentLoaded", async function () {
    if (isMessagesPage) return;
    const p1 = document.getElementById("profile-img"), p2 = document.getElementById("text");
    const pic = localStorage.getItem("profile_picture");
    if (p1) p1.src = getSafePic(pic); if (p2) p2.src = getSafePic(pic);
    if (!localStorage.getItem("token")) return window.location.href = "/root.html";
    await loadPosts(); loadFriends(); setInterval(loadFriends, 30000);
});