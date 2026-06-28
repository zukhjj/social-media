let googleLoading = false;

function show() {
    let img = document.getElementById("ic2");
    
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
    let img = document.getElementById("ii");
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
        
        if (result.needs_welcome) {
           
            localStorage.setItem("token", result.token);
            sessionStorage.setItem("google_pending_data", JSON.stringify({
                name: result.name,
                username: result.username,
                profile_picture: result.profile_picture
            }));
            window.location.href = "/welcome_google.html";
        } else if (result.token) {
           
            localStorage.setItem("token", result.token);
            localStorage.setItem("username", result.username || "");
            localStorage.setItem("profile_picture", result.profile_picture || "unknown");
            window.location.href = "/home.html";
        } else {
            document.getElementById("toperror").textContent = result.msg || "Google login failed";
        }
    } catch (err) {
        document.getElementById("toperror").textContent = "server error";
    } finally {
        googleLoading = false;
    }
}async function login(e) {
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
        
        
        if (data.msg === "otp_sent") {
            document.getElementById("box").style.display = "none";
            document.getElementById("auth").hidden = false;     
            document.querySelector("#auth p span").textContent = email; 
            return; 
        }
       
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
async function codeAuth() {
    const inputs = document.querySelectorAll('.otp-input');
    let fullCode = "";
    inputs.forEach(input => fullCode += input.value);
    
    if (fullCode.length !== 6) {
        showOtpError("Please enter the full 6-digit code.");
        shakeOtpContainer();
        return;
    }
    
    const email = document.querySelector("#auth p span").textContent;
    const sendBtn = document.querySelector("#auth input[type='button']");
    const originalText = sendBtn.value;
    sendBtn.value = "Verifying...";
    sendBtn.disabled = true;
    
    try {
       
        const isSignup = window.location.pathname.includes("sign_up.html");
        const endpoint = isSignup ? "/verify_signup_otp" : "/verify_login_otp";
        
        let res = await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email: email, otp_code: fullCode })
        });
        let data = await res.json();
        
        if (data.token) {
            localStorage.setItem("token", data.token);
            
            if (isSignup) {
               
                localStorage.setItem("username", data.username);
                sendBtn.value = "✓ Success!";
                sendBtn.style.background = "#1bc35e";
                setTimeout(() => window.location.href = "/welcome.html", 500);
            } else {
                
                localStorage.setItem("username", data.username || "");
                localStorage.setItem("profile_picture", data.profile_picture || "unknown");
                sendBtn.value = "✓ Success!";
                sendBtn.style.background = "#1bc35e";
                setTimeout(() => window.location.href = "/home.html", 500);
            }
        } else {
            const errorMsg = data.error || "Invalid code";
            showOtpError(errorMsg);
            shakeOtpContainer();
            
            if (data.msg === "otp_expired") {
                showResendButton(email);
            }
            
            inputs.forEach(input => {
                input.value = "";
                input.classList.remove("filled");
            });
            inputs[0].focus();
        }
    } catch (err) {
        showOtpError("Connection error. Please try again.");
        shakeOtpContainer();
    } finally {
        sendBtn.value = originalText;
        sendBtn.disabled = false;
    }
}
function showOtpError(message) {
    const topError = document.getElementById("toperror");
    if (topError) {
        topError.textContent = message;
        topError.style.color = "#ef4444";
        topError.style.animation = "fadeIn 0.3s ease";
        
 
        setTimeout(() => {
            topError.textContent = "";
        }, 5000);
    }
}

function shakeOtpContainer() {
    const container = document.getElementById("otpContainer");
    if (container) {
        container.style.animation = "shake 0.5s ease";
        setTimeout(() => {
            container.style.animation = "";
        }, 500);
    }
}

function showResendButton(email) {
    const authSection = document.getElementById("auth");
    if (!authSection) return;
    

    if (document.getElementById("resend-otp-btn")) return;
    
    const resendBtn = document.createElement("button");
    resendBtn.id = "resend-otp-btn";
    resendBtn.textContent = "🔄 Resend Code";
    resendBtn.style.cssText = `
        margin-top: 15px;
        padding: 10px 20px;
        background: transparent;
        border: 1px solid #1bc35e;
        color: #1bc35e;
        border-radius: 99px;
        cursor: pointer;
        font-size: 14px;
        font-weight: 600;
        transition: all 0.2s ease;
    `;
    resendBtn.onmouseover = () => {
        resendBtn.style.background = "#1bc35e";
        resendBtn.style.color = "white";
    };
    resendBtn.onmouseout = () => {
        resendBtn.style.background = "transparent";
        resendBtn.style.color = "#1bc35e";
    };
    
    resendBtn.onclick = async () => {
        resendBtn.disabled = true;
        resendBtn.textContent = "Sending...";
        
        try {
            let res = await fetch("/request_login_otp", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ email: email })
            });
            let data = await res.json();
            
            if (data.msg === "otp_sent") {
                resendBtn.textContent = "✓ Code Sent!";
                showOtpError("New code sent to your email!");
                document.getElementById("toperror").style.color = "#1bc35e";
                setTimeout(() => {
                    resendBtn.remove();
                    document.getElementById("toperror").textContent = "";
                }, 3000);
            } else {
                resendBtn.disabled = false;
                resendBtn.textContent = "🔄 Resend Code";
                showOtpError("Failed to resend. Try again later.");
            }
        } catch (err) {
            resendBtn.disabled = false;
            resendBtn.textContent = "🔄 Resend Code";
            showOtpError("Connection error");
        }
    };
    
    authSection.querySelector("form").appendChild(resendBtn);
}
async function sign_up(e) {
    e.preventDefault();
    clear();
    
    const submitBtn = document.querySelector('input[type="submit"]');
    

    let user = document.getElementById("user").value.trim();
    let name = document.getElementById("name").value.trim();
    let password = document.getElementById("password").value;
    let repassword = document.getElementById("repassword").value;
    
    let email = "", phone = "";
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
        document.getElementById("usererror").textContent = "need email or phone";
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
        document.getElementById("repassworderror").textContent = "passwords don't match";
        return;
    }
    if (password.length < 6) {
        document.getElementById("passworderror").textContent = "password too short";
        return;
    }
    
    setButtonLoading(submitBtn, "Sending code...");
    
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
        
        if (data.msg === "otp_sent") {
            setButtonSuccess(submitBtn, "✓ Code sent!");
            
            localStorage.setItem("pending_signup_email", email);
            
            setTimeout(() => {
                document.getElementById("box").style.display = "none";
                document.getElementById("auth").hidden = false;
                
                const emailDisplay = document.getElementById("otp-email-display");
                if (emailDisplay) {
                    emailDisplay.textContent = email;
                }
            }, 800);
            
        } else if (data.msg === "email_used") {
            setButtonError(submitBtn);
            document.getElementById("usererror").textContent = data.error || "Email already registered";
        } else if (data.msg === "pending_exists") {
            setButtonError(submitBtn);
            document.getElementById("usererror").textContent = data.error || "Verification already sent";
        } else {
            setButtonError(submitBtn);
            document.getElementById("usererror").textContent = data.error || data.msg || "Signup failed";
        }
    } catch (err) {
        console.error("Signup error:", err);
        setButtonError(submitBtn);
        document.getElementById("usererror").textContent = "Connection error";
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
        
        // ✅ FIX: Changed "auth" to "Authorization" and added "Bearer " prefix!
        let res = await fetch("/api/verify", {
            headers: { "Authorization": "Bearer " + token } 
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
    
    const inputIds = ["user", "name", "password", "repassword"];
    inputIds.forEach(id => {
        const input = document.getElementById(id);
        if (input) {  
            input.addEventListener("focus", clear);
        }
    });
});
document.addEventListener('DOMContentLoaded', () => {
    const inputs = document.querySelectorAll('.otp-input');

    inputs.forEach((input, index) => {
        // 1. Handle Typing & Auto-Jump
        input.addEventListener('input', (e) => {
            // Remove anything that isn't a number
            let val = e.target.value.replace(/\D/g, '');
            e.target.value = val;

            if (val.length > 0) {
                input.classList.add('filled');
                // Jump to next box
                if (index < inputs.length - 1) {
                    inputs[index + 1].focus();
                }
            } else {
                input.classList.remove('filled');
            }
        });


        input.addEventListener('keydown', (e) => {
            if (e.key === 'Backspace') {
                if (!e.target.value && index > 0) {
                    inputs[index - 1].focus();
                    inputs[index - 1].value = '';
                    inputs[index - 1].classList.remove('filled');
                } else {
                    e.target.classList.remove('filled');
                }
            }
        });


        input.addEventListener('paste', (e) => {
            e.preventDefault();
            const text = e.clipboardData.getData('text').replace(/\D/g, '');
            
            if (text) {
                for (let i = 0; i < text.length && index + i < inputs.length; i++) {
                    inputs[index + i].value = text[i];
                    inputs[index + i].classList.add('filled');
                }

                const nextIndex = Math.min(index + text.length, inputs.length - 1);
                inputs[nextIndex].focus();
            }
        });
    });


    inputs[0].focus();
});

function backToLogin() {
    document.getElementById("fo").style.display = "block";
    document.getElementById("auth").hidden = true;
    

    document.querySelectorAll('.otp-input').forEach(input => {
        input.value = '';
        input.classList.remove('filled');
    });
}


function forgotPassword() {
    const email = document.getElementById("user").value.trim();
    
    if (!email || !email.includes("@")) {
        document.getElementById("usererror").textContent = "Please enter your email first!";
        return;
    }
    

    document.getElementById("fo").style.display = "none";
    document.getElementById("auth").hidden = false;
    document.getElementById("otp-email-display").textContent = email;
    

    requestOtp(email);
}

async function requestOtp(email) {
    try {
        let res = await fetch("/request_login_otp", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email: email })
        });
        let data = await res.json();
        
        if (data.msg !== "otp_sent") {
            document.getElementById("toperror").textContent = data.msg;
            backToLogin();
        }
    } catch (err) {
        document.getElementById("toperror").textContent = "Connection error";
        backToLogin();
    }
}
// ══════════════════════════════════════════════════════════════
// 🔘 BUTTON STATE MANAGEMENT
// ══════════════════════════════════════════════════════════════

/**
 * Set button to loading state
 * @param {HTMLElement} button - The button element
 * @param {string} loadingText - Optional loading text
 */
function setButtonLoading(button, loadingText = null) {
    if (!button) return;
    
    // Store original text
    button.dataset.originalText = button.textContent || button.value;
    
    // Disable button
    button.disabled = true;
    
    // Add loading class
    button.classList.add('btn-loading');
    
    // Update text if provided
    if (loadingText) {
        if (button.tagName === 'INPUT') {
            button.value = loadingText;
        } else {
            button.textContent = loadingText;
        }
    }
}

/**
 * Set button to success state
 * @param {HTMLElement} button - The button element
 * @param {string} successText - Success message
 */
function setButtonSuccess(button, successText = '✓ Success!') {
    if (!button) return;
    
    button.classList.remove('btn-loading', 'btn-error');
    button.classList.add('btn-success');
    
    if (button.tagName === 'INPUT') {
        button.value = successText;
    } else {
        button.textContent = successText;
    }
}

/**
 * Set button to error state
 * @param {HTMLElement} button - The button element
 * @param {string} errorText - Optional error message
 */
function setButtonError(button, errorText = null) {
    if (!button) return;
    
    button.classList.remove('btn-loading', 'btn-success');
    button.classList.add('btn-error');
    
    // Re-enable after animation
    setTimeout(() => {
        button.classList.remove('btn-error');
        button.disabled = false;
        
        // Restore original text
        if (button.dataset.originalText) {
            if (button.tagName === 'INPUT') {
                button.value = button.dataset.originalText;
            } else {
                button.textContent = button.dataset.originalText;
            }
        }
    }, 2000);
    
    // Update text if provided
    if (errorText) {
        if (button.tagName === 'INPUT') {
            button.value = errorText;
        } else {
            button.textContent = errorText;
        }
    }
}

/**
 * Reset button to original state
 * @param {HTMLElement} button - The button element
 */
function resetButton(button) {
    if (!button) return;
    
    button.classList.remove('btn-loading', 'btn-success', 'btn-error');
    button.disabled = false;
    
    // Restore original text
    if (button.dataset.originalText) {
        if (button.tagName === 'INPUT') {
            button.value = button.dataset.originalText;
        } else {
            button.textContent = button.dataset.originalText;
        }
    }
}
