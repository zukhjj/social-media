// ===== UTILITIES =====
function getSafePic(pic) { return (pic && pic !== "unknown") ? pic : "unkown.png"; }
function escapeHtml(text) { let d = document.createElement("div"); d.textContent = text; return d.innerHTML; }
function getTimeAgo(dateStr) {
    if (!dateStr) return "";
    const d = new Date(dateStr.replace(" ", "T") + "Z"), diff = Math.floor((Date.now() - d) / 1000);
    return diff < 60 ? "now" : diff < 3600 ? Math.floor(diff / 60) + "m" : diff < 86400 ? Math.floor(diff / 3600) + "h" : Math.floor(diff / 86400) + "d";
}
function showToast(message, type = "info", duration = 3000) {
    const container = document.getElementById("toast-container");
    if (!container) { alert(message); return; }
    const toast = document.createElement("div");
    toast.className = `toast ${type}`;
    toast.innerHTML = `<span class="toast-message">${message}</span>`;
    container.appendChild(toast);
    setTimeout(() => { toast.style.opacity = "0"; setTimeout(() => toast.remove(), 300); }, duration);
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

// ===== GLOBAL EMOJI CLICK HANDLER (Always ready) =====
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

// ===== LONG-PRESS DETECTION (PERSISTENT) =====
function setupLongPress(element, onLongPress, onShortClick) {
    let pressTimer;

    const start = (e) => {
        e.preventDefault();
        pressTimer = setTimeout(() => {
            onLongPress(element);
            element.classList.add('long-press');
            document.addEventListener('click', hideActionsOutside, { once: true });
        }, 500);
    };

    const end = () => {
        clearTimeout(pressTimer);
        if (pressTimer && onShortClick) onShortClick(element);
        pressTimer = null;
    };

    const hideActionsOutside = (e) => {
        if (!element.contains(e.target)) {
            element.classList.remove('long-press');
        }
    };

    element.addEventListener('touchstart', start, { passive: false });
    element.addEventListener('touchend', end);
    element.addEventListener('touchcancel', end);
    element.addEventListener('mousedown', start);
    element.addEventListener('mouseup', end);
    element.addEventListener('mouseleave', end);
}

// ===== MESSAGE ACTIONS =====
function handleMessageActions(e) {
    const btn = e.target.closest(".msg-action-btn");
    if (!btn) return;

    const msgId = btn.dataset.id;
    const action = btn.classList.contains("reply-btn") ? "reply" :
        btn.classList.contains("react-btn") ? "react" : "delete";

    const bubble = btn.closest('.message-bubble');
    if (bubble) bubble.classList.remove('long-press');

    if (action === "reply") setReply(msgId);
    else if (action === "react") toggleEmojiPicker(msgId, btn);
    else if (action === "delete") confirmDelete(msgId, btn);

    e.stopPropagation();
}

function setupMessageInteractions() {
    document.querySelectorAll('.message-bubble').forEach(bubble => {
        setupLongPress(bubble, (el) => {
            const actions = el.querySelector('.message-actions');
            if (actions) { actions.style.opacity = '1'; actions.style.pointerEvents = 'auto'; actions.style.transform = 'translateY(0)'; }
        }, null);
    });
}

// ===== REPLY =====
function setReply(msgId) {
    const btn = document.querySelector(`.reply-btn[data-id="${msgId}"]`);
    if (!btn) return;
    const numericId = btn.dataset.numericId;
    if (!numericId) { showToast("Cannot reply to unsent message", "error"); return; }
    const el = document.querySelector(`.message-item[data-msg-id="${msgId}"]`);
    if (!el) return;
    const sender = el.querySelector(".message-bubble")?.textContent || "Unknown";
    const isMine = el.classList.contains("mine");
    currentReply = { msgId: numericId, sender: isMine ? "Yourself" : document.getElementById("chat-username").textContent, content: sender };
    document.getElementById("reply-to-name").textContent = currentReply.sender;
    document.getElementById("reply-to-content").textContent = currentReply.content;
    document.getElementById("reply-preview-bar").classList.remove("hidden");
    document.getElementById("chat-input").focus();
}
function cancelReply() { currentReply = null; document.getElementById("reply-preview-bar").classList.add("hidden"); }
function handleMessageActions(e) {
    const btn = e.target.closest(".msg-action-btn");
    if (!btn) return;

    const msgId = btn.dataset.id;
    const action = btn.classList.contains("reply-btn") ? "reply" : 
                   btn.classList.contains("react-btn") ? "react" : "delete";

    const bubble = btn.closest('.message-bubble');
    if (bubble) bubble.classList.remove('long-press');

    // ✅ NEW: Block reactions on your own messages
    if (action === "react" && btn.closest('.message-item')?.classList.contains('mine')) {
        showToast("You can't react to your own messages", "info");
        return;
    }

    if (action === "reply") setReply(msgId);
    else if (action === "react") toggleEmojiPicker(msgId, btn);
    else if (action === "delete") confirmDelete(msgId, btn);

    e.stopPropagation();
}
window.toggleEmojiPicker = function (msgId, btn) {
    // Remove existing picker
    document.getElementById('emoji-popup')?.remove();

    const picker = document.createElement('div');
    picker.id = 'emoji-popup';
    
    // Find current user reactions
    const msgItem = btn.closest('.message-item');
    const activeBadges = msgItem?.querySelectorAll('.message-reactions .react-badge.active') || [];
    const userReactions = Array.from(activeBadges).map(b => b.dataset.emoji);

    const emojis = ["👍", "❤️", "😂", "😮", "😢", "🔥", "👎"];
    emojis.forEach(emoji => {
        const s = document.createElement('span');
        s.className = `emoji-opt ${userReactions.includes(emoji) ? 'active' : ''}`;
        s.textContent = emoji;

        // ✅ Single-fire handler (prevents mobile double-tap)
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

    document.body.appendChild(picker);

    // ✅ Position exactly above the clicked button
    const rect = btn.getBoundingClientRect();
    const pickerW = picker.offsetWidth;
    let left = rect.left + (rect.width / 2) - (pickerW / 2);
    let top = rect.top - 50; // Height of picker + small gap

    // Keep inside screen edges
    left = Math.max(6, Math.min(left, window.innerWidth - pickerW - 6));
    top = Math.max(6, top);

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
window.selectReaction = async function (msgId, emoji) {
     if (window._reacting === msgId + emoji) return;
    window._reacting = msgId + emoji;
    setTimeout(() => delete window._reacting, 500);

    const btn = document.querySelector(`.react-btn[data-id="${msgId}"]`);
    const id = btn?.dataset.numericId;
    if (!id) return;

    const box = document.getElementById(`reactions-${msgId}`);
    if (!box) return;

    // 1. Find user's currently active reaction
    const activeBadge = box.querySelector('.react-badge.active');
    const currentEmoji = activeBadge?.dataset.emoji;

    // 2. Instant UI Update (Toggle or Switch)
    if (currentEmoji === emoji) {
        activeBadge.remove(); // Toggle off
    } else {
        if (activeBadge) activeBadge.remove(); // Remove old

        let newBadge = box.querySelector(`.react-badge[data-emoji="${emoji}"]`);
        if (!newBadge) {
            newBadge = document.createElement('span');
            newBadge.className = 'react-badge active';
            newBadge.dataset.emoji = emoji;
            newBadge.textContent = emoji;
            box.appendChild(newBadge);
        } else {
            newBadge.classList.add('active'); // Highlight existing
        }
    }

    // 3. Sync with Backend
    const token = localStorage.getItem('token');
    const headers = { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' };

    try {
        if (currentEmoji === emoji) {
            await fetch('/remove_reaction', { method: 'POST', headers, body: JSON.stringify({ message_id: id, emoji }) });
        } else if (currentEmoji) {
            // Switch: remove old, add new
            await Promise.all([
                fetch('/remove_reaction', { method: 'POST', headers, body: JSON.stringify({ message_id: id, emoji: currentEmoji }) }),
                fetch('/add_reaction', { method: 'POST', headers, body: JSON.stringify({ message_id: id, emoji }) })
            ]);
        } else {
            await fetch('/add_reaction', { method: 'POST', headers, body: JSON.stringify({ message_id: id, emoji }) });
        }
    } catch (err) {
        console.error("Sync error:", err);
        // Optional: reload messages to revert UI if network fails
        if (currentChatUser) loadMessages(currentChatUser);
    }
};
function confirmDelete(msgId, btn) {
    document.querySelectorAll('.delete-confirm').forEach(el => el.remove());
    const confirmModal = document.createElement("div");
    confirmModal.className = "delete-confirm";
    confirmModal.innerHTML = `<p>Delete this message?</p><div class="delete-confirm-buttons"><button class="cancel-btn">Cancel</button><button class="confirm-btn">Delete</button></div>`;
    const rect = btn.getBoundingClientRect();
    confirmModal.style.top = `${rect.top - 100}px`; confirmModal.style.left = `${rect.left}px`;
    document.body.appendChild(confirmModal);
    const confirmBtn = confirmModal.querySelector('.confirm-btn');
    const cancelBtn = confirmModal.querySelector('.cancel-btn');
    confirmBtn.focus();
    const cleanup = () => { confirmModal.remove(); document.removeEventListener('keydown', handleKey); };
    const handleKey = (e) => { if (e.key === 'Escape') cleanup(); };
    document.addEventListener('keydown', handleKey);
    cancelBtn.onclick = cleanup;
    confirmBtn.onclick = async () => {
        cleanup();
        const numericId = btn.dataset.numericId;
        if (!numericId) { showToast("Cannot delete unsent message", "error"); return; }
        const token = localStorage.getItem("token");
        const res = await safeFetch(`/delete_message/${numericId}`, { method: "DELETE", headers: { "Authorization": "Bearer " + token } });
        if (res && res.msg === "deleted") {
            const el = document.querySelector(`.message-item[data-msg-id="${msgId}"]`);
            if (el) { el.style.animation = "fadeOut 0.2s ease forwards"; setTimeout(() => el.remove(), 200); }
            showToast("Message deleted", "success");
        } else { showToast("Could not delete message", "error"); }
    };
}

// ===== LOAD MESSAGES (DIFF-BASED) =====
async function loadMessages(username) {
    const token = localStorage.getItem("token");
    if (!token || !username) return;
    const data = await safeFetch(`/get_messages/${encodeURIComponent(username)}`, { headers: { "Authorization": "Bearer " + token } });
    if (!data) return;
    const messages = data.messages || [];
    const container = document.getElementById("messages-container");
    if (!container) return;
    if (data.other_user_picture) { const avatar = document.getElementById("chat-avatar"); if (avatar) avatar.src = getSafePic(data.other_user_picture); }

    function getMsgId(m, index) { if (m.id) return `id-${m.id}`; const raw = `${m.sender_picture || ''}-${m.created_at || ''}-${m.content || ''}-${index}`; let hash = 0; for (let i = 0; i < raw.length; i++) hash = ((hash << 5) - hash) + raw.charCodeAt(i); return `msg-${hash}-${index}`; }

    const processedIds = new Set();
    messages.forEach((m, index) => {
        const msgId = getMsgId(m, index); processedIds.add(msgId);
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
            msgEl.innerHTML = `
                <img src="${getSafePic(m.sender_picture)}" class="message-avatar">
                <div class="message-wrapper">
                    <div class="message-bubble" style="position: relative;">
                        ${replyHtml}
                        ${escapeHtml(m.content)}
                        <div class="message-actions">
    ${!m.is_mine ? `<button class="msg-action-btn react-btn" data-id="${msgId}" data-numeric-id="${m.id || ''}"><img src="emoji.png" alt="React"></button>` : ''}
    <button class="msg-action-btn reply-btn" data-id="${msgId}" data-numeric-id="${m.id || ''}"><img src="reply.png" alt="Reply"></button>
    ${m.is_mine ? `<button class="msg-action-btn delete-btn" data-id="${msgId}" data-numeric-id="${m.id || ''}"><img src="trash.png" alt="Delete"></button>` : ''}
</div>
                    </div>
                    <div id="reactions-${msgId}" class="message-reactions">${reactionsHtml}</div>
                    <div class="message-time">${getTimeAgo(m.created_at)}</div>
                </div>
            `;
            container.appendChild(msgEl);
        } else {
            const bubble = msgEl.querySelector('.message-bubble');
            const time = msgEl.querySelector('.message-time');
            const newContent = escapeHtml(m.content);
            const newTime = getTimeAgo(m.created_at);
            if (bubble && !bubble.textContent.includes(newContent)) {
                let existingReply = bubble.querySelector('.reply-context');
                if (m.reply_context && m.reply_context.content) {
                    if (!existingReply) {
                        const replyHtml = `<div class="reply-context"><span class="reply-label">↩️ Replying to ${escapeHtml(m.reply_context.sender_username || 'user')}:</span><span class="reply-text">${escapeHtml(m.reply_context.content.substring(0, 80))}</span></div>`;
                        bubble.insertAdjacentHTML('afterbegin', replyHtml);
                    }
                } else if (existingReply) existingReply.remove();
                const contentNode = bubble.childNodes.length ? bubble.childNodes[bubble.childNodes.length - 1] : null;
                if (contentNode && contentNode.nodeType === Node.TEXT_NODE) contentNode.textContent = newContent;
                else bubble.appendChild(document.createTextNode(newContent));
            }
            if (time && time.textContent !== newTime) time.textContent = newTime;
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
    container.querySelectorAll('.message-item').forEach(el => { if (!processedIds.has(el.dataset.msgId)) el.remove(); });
    scrollToBottom(false);

}

// ===== SEND MESSAGE =====
async function sendChatMessage() {
    const input = document.getElementById("chat-input");
    const content = input?.value.trim();
    if (!content || !currentChatUser) return;
    const token = localStorage.getItem("token");
    if (!token) return window.location.href = "/root.html";
    const payload = { receiver_username: currentChatUser, content };
    if (currentReply) payload.reply_to_id = currentReply.msgId;
    const data = await safeFetch("/send_message", { method: "POST", headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    if (data && data.msg === "sent") { input.value = ""; cancelReply(); loadMessages(currentChatUser); setTimeout(() => loadConversationsOptimized(), 300); scrollToBottom(true); }
}

// ===== CONVERSATIONS (OPTIMIZED) =====
async function loadConversationsOptimized() {
    const token = localStorage.getItem("token");
    if (!token) return;
    const data = await safeFetch("/get_conversations", { headers: { "Authorization": "Bearer " + token } });
    const list = document.getElementById("conversations-list");
    if (!list) return;
    if (!data || !data.length) { list.innerHTML = `<p style="color:var(--text-muted);text-align:center;padding:20px;">No conversations yet.</p>`; return; }
    const activeUsernames = new Set();
    data.forEach(c => {
        activeUsernames.add(c.username);
        const hasUnread = c.unread_count > 0;
        let item = list.querySelector(`.conversation-item[data-username="${c.username}"]`);
        const previewText = c.last_message ? (c.last_message_from_me ? `You: ${c.last_message}` : c.last_message) : "Tap to chat";
        if (!item) {
            item = document.createElement("div");
            item.dataset.username = c.username;
            item.className = `conversation-item ${currentChatUser === c.username ? "active" : ""} ${hasUnread ? "has-unread" : ""}`;
            item.onclick = () => openChat(c.username);
            item.innerHTML = `
                <img src="${getSafePic(c.profile_picture)}" class="conversation-avatar">
                <div class="conversation-info">
                    <div class="conversation-name">${c.name || c.username}</div>
                    <div class="conversation-preview"></div>
                </div>
                <div class="conversation-meta">
                    <div class="conversation-time"></div>
                    <div class="badge-container"></div>
                </div>
            `;
            list.appendChild(item);
        }
        item.className = `conversation-item ${currentChatUser === c.username ? "active" : ""} ${hasUnread ? "has-unread" : ""}`;
        const previewEl = item.querySelector('.conversation-preview');
        if (previewEl && previewEl.textContent !== previewText) previewEl.textContent = escapeHtml(previewText);
        const timeEl = item.querySelector('.conversation-time');
        const newTime = getTimeAgo(c.last_message_time);
        if (timeEl && timeEl.textContent !== newTime) timeEl.textContent = newTime;
        const badgeEl = item.querySelector('.badge-container');
        if (badgeEl) badgeEl.innerHTML = c.unread_count > 0 ? `<span class="unread-badge">${c.unread_count}</span>` : "";
    });
    list.querySelectorAll('.conversation-item').forEach(item => { if (!activeUsernames.has(item.dataset.username)) item.remove(); });
}
function filterConversations(q) { const lower = q.toLowerCase(); document.querySelectorAll(".conversation-item").forEach(el => { const n = el.querySelector(".conversation-name")?.textContent.toLowerCase() || ""; el.style.display = n.includes(lower) ? "flex" : "none"; }); }

// ===== CHAT WINDOW =====
function openChat(username) {
    currentChatUser = username;
    const emptyState = document.getElementById("empty-state");
    const chatActive = document.getElementById("chat-active");
    if (emptyState) emptyState.classList.add("hidden");
    if (chatActive) chatActive.classList.remove("hidden");
    document.getElementById("chat-username").textContent = username;
    const newBtn = document.getElementById("new-chat-btn");
    const emptyBtn = document.getElementById("empty-start-btn");
    if (newBtn) newBtn.style.display = "none";
    if (emptyBtn) emptyBtn.style.display = "none";
    loadMessages(username);
    if (chatPollInterval) clearInterval(chatPollInterval);
    chatPollInterval = setInterval(() => loadMessages(username), 5000);
    if (window.innerWidth <= 1024) document.querySelector('.conversations-sidebar')?.classList.add('mobile-hidden');
    document.querySelectorAll(".conversation-item").forEach(el => { el.classList.toggle("active", el.querySelector(".conversation-name")?.textContent === username); });
}
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

// ===== NEW CHAT MODAL =====
function openNewChatModal() { document.getElementById("new-chat-modal").showModal(); searchNewChatUsers(""); }
function closeNewChatModal() { document.getElementById("new-chat-modal").close(); document.getElementById("new-chat-search").value = ""; }
async function searchNewChatUsers(q) {
    const token = localStorage.getItem("token");
    if (!token) return;
    const users = await safeFetch(`/search_users?q=${encodeURIComponent(q)}`, { headers: { "Authorization": "Bearer " + token } });
    const list = document.getElementById("new-chat-users");
    if (!list) return;
    list.innerHTML = "";
    if (!users || !users.length) { list.innerHTML = `<p style="color:var(--text-muted);text-align:center;padding:20px;">No users found</p>`; return; }
    const me = localStorage.getItem("username");
    users.forEach(u => { if (u.username === me) return; const item = document.createElement("div"); item.className = "modal-user-item"; item.onclick = () => { closeNewChatModal(); openChat(u.username); }; item.innerHTML = `<img src="${getSafePic(u.profile_picture)}" class="modal-user-avatar"><div class="modal-user-info"><div class="modal-user-name">${u.name || u.username}</div><div class="modal-user-username">@${u.username}</div></div>`; list.appendChild(item); });
}

// ===== FRIENDS LIST (OPTIMIZED) =====
async function loadFriendsList() {
    const token = localStorage.getItem("token");
    if (!token) return;
    const friends = await safeFetch("/get_friends_list", { headers: { "Authorization": "Bearer " + token } });
    const list = document.getElementById("friends-list");
    if (!list) return;
    if (!friends || !friends.length) { if (!list.querySelector('.no-friends-msg')) { list.innerHTML = `<p class="no-friends-msg" style="color:var(--text-muted);font-size:12px;padding:0 16px;">No friends yet</p>`; } return; }
    const placeholder = list.querySelector('.no-friends-msg'); if (placeholder) placeholder.remove();
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
    smartRefresh.friends = null; smartRefresh.conversations = null; smartRefresh.active = false;
}

// ===== INIT =====
document.addEventListener("DOMContentLoaded", async function () {
    const token = localStorage.getItem("token");
    if (!token) return window.location.href = "/root.html";
    const p = document.getElementById("profile-img"); if (p) p.src = getSafePic(localStorage.getItem("profile_picture"));
    await loadFriendsList();
    await loadConversationsOptimized();
    document.getElementById("search-input")?.addEventListener("input", e => filterConversations(e.target.value));
    startSmartRefresh();
    setupScrollListener();
    const container = document.getElementById("messages-container");
    if (container) { container.addEventListener("click", handleMessageActions); container.addEventListener("click", closeEmojiPickers); }
    document.getElementById("new-chat-btn")?.addEventListener("click", openNewChatModal);
    document.getElementById("empty-start-btn")?.addEventListener("click", openNewChatModal);
    document.getElementById("close-reply-btn")?.addEventListener("click", cancelReply);
    setupMessageInteractions();
});
document.addEventListener("visibilitychange", () => { if (document.hidden) stopSmartRefresh(); else { loadFriendsList(); loadConversationsOptimized(); startSmartRefresh(); } });
window.addEventListener("beforeunload", stopSmartRefresh);
