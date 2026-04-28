let googleLoading = false;

function show() {
    let img = document.getElementById("ic");
    let passInput = document.getElementById("password");
    if (!img || !passInput) return;
    let currentSrc = img.getAttribute("src");
    if (currentSrc && currentSrc.includes("open.png")) {
        img.setAttribute("src", "closed.png");
        passInput.type = "text";
    } else {
        img.setAttribute("src", "open.png");
        passInput.type = "password";
    }
}

function show1() {
    let img = document.getElementById("ic2");
    let passInput = document.getElementById("repassword");
    if (!img || !passInput) return;
    let currentSrc = img.getAttribute("src");
    if (currentSrc && currentSrc.includes("open.png")) {
        img.setAttribute("src", "closed.png");
        passInput.type = "text";
    } else {
        img.setAttribute("src", "open.png");
        passInput.type = "password";
    }
}

function hide() {
    let img = document.getElementById("ic");
    if (img) img.style.display = "block";
}

function hide1() {
    let img = document.getElementById("ic2");
    if (img) img.style.display = "block";
}

function parseJwt(token) {
    try {
        const base64Url = token.split('.')[1];
        const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
        const jsonPayload = decodeURIComponent(atob(base64).split('').map(function(c) {
            return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
        }).join(''));
        return JSON.parse(jsonPayload);
    } catch (e) {
        return {};
    }
}
async function handleCredentialResponse(response) {
    if (googleLoading) return;
    googleLoading = true;
    try {
        let profile = parseJwt(response.credential);
        let email = profile.email;
        let name = profile.name;
        let picture = profile.picture || "unknown";
        let res = await fetch("/google-login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email: email, name: name, picture: picture })
        });
        let result = await res.json();
        if (result.token) {
            localStorage.setItem("token", result.token);
            localStorage.setItem("username", result.username || "");
            localStorage.setItem("profile_picture", result.profile_picture || "unknown");
            window.location.href = "/home.html";
        } else {
            document.getElementById("toperror").textContent = result.msg;
        }
    } catch (err) {
        document.getElementById("toperror").textContent = "server error";
    } finally {
        googleLoading = false;
    }
}
async function login(e) {
    e.preventDefault();
    document.getElementById("usererror").textContent = "";
    document.getElementById("passworderror").textContent = "";
    let user = document.getElementById("user").value.trim();
    let password = document.getElementById("password").value;
    if (!password) {
        document.getElementById("passworderror").textContent = "password required";
        return;
    }
    let email = "";
    let phone = "";
    if (!isNaN(user)) {
        phone = user;
    } else {
        email = user;
    }
    if (phone && phone.length !== 8) {
        document.getElementById("usererror").textContent = "phone number invalid";
        return;
    }
    if (email) {
        let pattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!pattern.test(email)) {
            document.getElementById("usererror").textContent = "email invalid";
            return;
        }
    }
    try {
        let res = await fetch("/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email: email, phone: phone, password: password })
        });
        let data = await res.json();
        if (data.token) {
            localStorage.setItem("token", data.token);
            window.location.href = "/home.html";
        } else {
            document.getElementById("usererror").textContent = data.msg;
        }
    } catch (err) {
        document.getElementById("usererror").textContent = "connection_error";
    }
}

async function sign_up(e) {
    e.preventDefault();
    document.getElementById("usererror").textContent = "";
    document.getElementById("nameerror").textContent = "";
    document.getElementById("passworderror").textContent = "";
    document.getElementById("repassworderror").textContent = "";
    let user = document.getElementById("user").value.trim();
    let name = document.getElementById("name").value.trim();
    let password = document.getElementById("password").value;
    let repassword = document.getElementById("repassword").value;
    let email = "";
    let phone = "";
    if (!isNaN(user)) {
        phone = user;
    } else {
        email = user;
    }
    if (phone && phone.length !== 8) {
        document.getElementById("usererror").textContent = "phone number invalid";
        return;
    }
    if (email) {
        let pattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!pattern.test(email)) {
            document.getElementById("usererror").textContent = "email invalid";
            return;
        }
    }
    if (!email && !phone) {
        document.getElementById("usererror").textContent = "need_email_or_phone";
        return;
    }
    if (!name) {
        document.getElementById("nameerror").textContent = "name required";
        return;
    }
    if (!password) {
        document.getElementById("passworderror").textContent = "password required";
        return;
    }
    if (password !== repassword) {
        document.getElementById("repassworderror").textContent = "retype the password correctly";
        return;
    }
    if (password.length < 6) {
        document.getElementById("passworderror").textContent = "password too short";
        return;
    }
    try {
        let res = await fetch("/signup", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                phone: phone,
                email: email,
                password: password,
                name: name
            })
        });
        let data = await res.json();
        if (data.token) {
            localStorage.setItem("token", data.token);
            localStorage.setItem("username", data.username || "");
            window.location.href = "/home.html";
        } else {
            document.getElementById("usererror").textContent = data.msg || "signup_failed";
        }
    } catch (err) {
        document.getElementById("usererror").textContent = "connection_error";
    }
}

async function checkAuth() {
    console.log("[checkAuth] Start - pathname:", window.location.pathname);
    let token = localStorage.getItem("token");
    console.log("[checkAuth] Token:", token ? "EXISTS" : "NOT FOUND");
    if (!token) {
        if (!window.location.pathname.includes("login.html") && !window.location.pathname.includes("sign_up.html") && !window.location.pathname.includes("root.html")) {
            console.log("[checkAuth] No token → redirecting to /login.html");
            window.location.href = "/login.html";
        }
        return;
    }
    try {
        console.log("[checkAuth] Verifying token with server...");
        let res = await fetch("/api/verify", {
            headers: { "auth": token }
        });
        let data = await res.json();
        console.log("[checkAuth] Server response:", data);
        if (data.msg !== "ok") {
            console.log("[checkAuth] Invalid token → clearing & redirecting");
            localStorage.removeItem("token");
            localStorage.removeItem("username");
            if (!window.location.pathname.includes("login.html")) {
                window.location.href = "/login.html";
            }
            return;
        }
        if (data.username) {
            localStorage.setItem("username", data.username);
        }
        if (!window.location.pathname.includes("home.html")) {
            console.log("[checkAuth] Auth OK → redirecting to /home.html");
            window.location.href = "/home.html";
        }
        return;
    } catch (err) {
        console.warn("[checkAuth] Error:", err);
        if (!window.location.pathname.includes("login.html")) {
            window.location.href = "/login.html";
        }
    }
}

function logout() {
    localStorage.removeItem("token");
    localStorage.removeItem("username");
    window.location.href = "/login.html";
}

function clear() {
    const errorIds = ["usererror", "passworderror", "nameerror", "repassworderror", "toperror"];
    errorIds.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.textContent = "";
    });
}

document.addEventListener("DOMContentLoaded", async function() {
    await checkAuth();
    ["user", "name", "password", "repassword"].forEach(id => {
        const input = document.getElementById(id);
        if (input) {
            input.addEventListener("focus", clear);
        }
    });
    const password = document.getElementById("password");
    const repassword = document.getElementById("repassword");
    const eye1 = document.getElementById("ic");
    const eye2 = document.getElementById("ic2");
    if (password && eye1) {
        password.addEventListener("focus", () => { if (password.value) eye1.style.display = "block"; });
        password.addEventListener("blur", () => { if (!password.value) eye1.style.display = "none"; });
    }
    if (repassword && eye2) {
        repassword.addEventListener("focus", () => { if (repassword.value) eye2.style.display = "block"; });
        repassword.addEventListener("blur", () => { if (!repassword.value) eye2.style.display = "none"; });
    }
});