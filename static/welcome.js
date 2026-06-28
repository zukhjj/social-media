// ══════════════════════════════════════════════════════════════
// 🎉 WELCOME PAGE LOGIC
// ══════════════════════════════════════════════════════════════

let selectedProfilePic = null;

function previewImage(input) {
    const file = input.files[0];
    if (!file) return;
    
    selectedProfilePic = file;
    const reader = new FileReader();
    reader.onload = (e) => {
        const preview = document.getElementById("pic-preview");
        preview.innerHTML = `<img src="${e.target.result}" alt="Profile preview">`;
    };
    reader.readAsDataURL(file);
}
async function completeWelcome(event) {
    event.preventDefault();
    
    const token = localStorage.getItem("token");
    if (!token) {
        window.location.href = "/login.html";
        return;
    }
    
    const formData = new FormData();
    

    if (selectedProfilePic) {
        formData.append("profile_image", selectedProfilePic);
    }
    
    
    try {
        const res = await fetch("/complete_welcome", {
            method: "POST",
            headers: { "Authorization": "Bearer " + token },
            body: formData
        });
        
        const data = await res.json();
        
        if (data.msg === "welcome_complete") {
            localStorage.setItem("token", data.token);
            localStorage.setItem("username", data.username);
            localStorage.setItem("profile_picture", data.profile_picture);
            window.location.href = "/home.html";
        } else {
            alert("Error: " + (data.msg || "Unknown error"));
        }
    } catch (err) {
        console.error("Welcome error:", err);
        alert("Connection error. Please try again.");
    }
}

async function skipWelcome() {
    const token = localStorage.getItem("token");
    if (!token) {
        window.location.href = "/login.html";
        return;
    }
    
    try {
        const formData = new FormData();
        const res = await fetch("/complete_welcome", {
            method: "POST",
            headers: { "Authorization": "Bearer " + token },
            body: formData
        });
        
        const data = await res.json();
        
        if (data.msg === "welcome_complete") {
            localStorage.setItem("token", data.token);
            localStorage.setItem("username", data.username);
            localStorage.setItem("profile_picture", data.profile_picture);
            window.location.href = "/home.html";
        }
    } catch (err) {
        console.error("Skip error:", err);
        window.location.href = "/home.html";
    }
}


async function completeGoogleWelcome(event) {
    event.preventDefault();
    
    const token = localStorage.getItem("token");
    if (!token) {
        window.location.href = "/login.html";
        return;
    }
    
    const name = document.getElementById("google-name").value.trim();
    const username = document.getElementById("google-username").value.trim();
    const password = document.getElementById("google-password").value;
    
    if (!name || !username || !password) {
        alert("Please fill all required fields");
        return;
    }
    
    if (password.length < 6) {
        alert("Password must be at least 6 characters");
        return;
    }
    
    const formData = new FormData();
    formData.append("name", name);
    formData.append("username", username);
    formData.append("password", password);
    
    if (selectedProfilePic) {
        formData.append("profile_image", selectedProfilePic);
    }
    
    try {
        const res = await fetch("/complete_google_welcome", {
            method: "POST",
            headers: { "Authorization": "Bearer " + token },
            body: formData
        });
        
        const data = await res.json();
        
        if (data.msg === "welcome_complete") {
            localStorage.setItem("token", data.token);
            localStorage.setItem("username", data.username);
            localStorage.setItem("profile_picture", data.profile_picture);
            window.location.href = "/home.html";
        } else if (data.msg === "username_taken") {
            document.getElementById("username-error").textContent = "Username already taken";
        } else {
            alert("Error: " + (data.msg || "Unknown error"));
        }
    } catch (err) {
        console.error("Google welcome error:", err);
        alert("Connection error. Please try again.");
    }
}

document.addEventListener("DOMContentLoaded", () => {
    const pendingData = sessionStorage.getItem("google_pending_data");
    if (pendingData) {
        const data = JSON.parse(pendingData);
        if (data.name) {
            document.getElementById("google-name").value = data.name;
        }
        if (data.username) {
            document.getElementById("google-username").value = data.username;
        }
        if (data.profile_picture && data.profile_picture !== "unknown") {
            const preview = document.getElementById("pic-preview");
            preview.innerHTML = `<img src="${data.profile_picture}" alt="Google profile">`;
        }
    }
});