let ws;
let currentChannel = "genel";
let username = localStorage.getItem("chat_username");
let typingTimeout = null;
let isTyping = false;
let typingUsers = new Set();

// DOM Elements
const loginScreen = document.getElementById("login-screen");
const registerScreen = document.getElementById("register-screen");
const chatScreen = document.getElementById("chat-screen");
const chatBox = document.getElementById("chat-box");
const messageInput = document.getElementById("message");
const statusElement = document.getElementById("status");
const usersList = document.getElementById("users");
const channelsList = document.getElementById("channels");
const currentChannelHeader = document.getElementById("current-channel");
const currentUserElement = document.getElementById("current-user");
const typingIndicator = document.getElementById("typing-indicator");

// Sayfa Yüklendiğinde
window.addEventListener('DOMContentLoaded', () => {
    if (username) {
        showChat();
        loadChannels();
        connectWebSocket();
    } else {
        showLogin();
    }
});

// Login İşlemi
async function login() {
    const usernameInput = document.getElementById("login-username").value.trim();
    const password = document.getElementById("login-password").value;
    const errorEl = document.getElementById("login-error");

    if (!usernameInput || !password) {
        errorEl.textContent = "Lütfen tüm alanları doldurun";
        return;
    }

    try {
        const response = await fetch("/api/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ username: usernameInput, password })
        });

        if (!response.ok) {
            const error = await response.json();
            errorEl.textContent = error.detail || "Giriş başarısız";
            return;
        }

        const data = await response.json();
        username = data.username;
        localStorage.setItem("chat_username", username);
        
        showChat();
        loadChannels();
        connectWebSocket();
    } catch (error) {
        errorEl.textContent = "Bağlantı hatası";
    }
}

// Kayıt İşlemi
async function register() {
    const usernameInput = document.getElementById("register-username").value.trim();
    const email = document.getElementById("register-email").value.trim();
    const password = document.getElementById("register-password").value;
    const errorEl = document.getElementById("register-error");

    if (!usernameInput || !email || !password) {
        errorEl.textContent = "Lütfen tüm alanları doldurun";
        return;
    }

    if (password.length < 6) {
        errorEl.textContent = "Şifre en az 6 karakter olmalı";
        return;
    }

    try {
        const response = await fetch("/api/register", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ username: usernameInput, email, password })
        });

        if (!response.ok) {
            const error = await response.json();
            errorEl.textContent = error.detail || "Kayıt başarısız";
            return;
        }

        const data = await response.json();
        username = data.username;
        localStorage.setItem("chat_username", username);
        
        showChat();
        loadChannels();
        connectWebSocket();
    } catch (error) {
        errorEl.textContent = "Bağlantı hatası";
    }
}

// WebSocket Bağlantısı
function connectWebSocket() {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${protocol}//${window.location.host}/ws`);

    ws.onopen = () => {
        ws.send(JSON.stringify({
            username: username,
            channel: currentChannel
        }));
        statusElement.textContent = "Bağlı";
        statusElement.className = "status connected";
        currentUserElement.textContent = `👤 ${username}`;
        
        loadMessages(currentChannel);
    };

    ws.onmessage = (event) => {
        const data = JSON.parse(event.data);

        if (data.type === "error") {
            showNotification(data.message, "error");
            return;
        }

        if (data.type === "message") {
            displayMessage(data.user, data.text, data.timestamp, data.id);
        }

        if (data.type === "users") {
            updateUsersList(data.users);
        }

        if (data.type === "typing") {
            handleTypingIndicator(data.user, data.status);
        }

        if (data.type === "message_deleted") {
            removeMessage(data.message_id);
        }
    };

    ws.onclose = () => {
        statusElement.textContent = "Bağlantı Kesildi";
        statusElement.className = "status disconnected";
        setTimeout(connectWebSocket, 3000);
    };

    ws.onerror = () => {
        statusElement.textContent = "Hata";
        statusElement.className = "status disconnected";
    };
}

// Typing Indicator
messageInput.addEventListener('input', () => {
    if (!isTyping && messageInput.value.length > 0) {
        isTyping = true;
        sendTypingStatus(true);
    }
    
    clearTimeout(typingTimeout);
    
    typingTimeout = setTimeout(() => {
        isTyping = false;
        sendTypingStatus(false);
    }, 2000);
});

function sendTypingStatus(status) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: "typing",
            status: status
        }));
    }
}

function handleTypingIndicator(user, status) {
    if (status) {
        typingUsers.add(user);
    } else {
        typingUsers.delete(user);
    }
    
    updateTypingIndicator();
}

function updateTypingIndicator() {
    if (typingUsers.size === 0) {
        typingIndicator.style.display = "none";
    } else {
        const users = Array.from(typingUsers).slice(0, 3);
        let text = users.join(", ");
        
        if (typingUsers.size === 1) {
            text += " yazıyor...";
        } else {
            text += " yazıyorlar...";
        }
        
        typingIndicator.textContent = text;
        typingIndicator.style.display = "block";
    }
}

// Kanalları Yükle
async function loadChannels() {
    try {
        const response = await fetch("/api/channels");
        const data = await response.json();
        
        channelsList.innerHTML = "";
        data.channels.forEach(channel => {
            const li = document.createElement("li");
            li.textContent = `# ${channel}`;
            li.onclick = () => changeChannel(channel);
            
            if (channel === currentChannel) {
                li.classList.add("active");
            }
            
            channelsList.appendChild(li);
        });
    } catch (error) {
        console.error("Kanallar yüklenemedi:", error);
    }
}

// Kanal Değiştir
function changeChannel(channel) {
    if (channel === currentChannel) return;
    
    currentChannel = channel;
    currentChannelHeader.textContent = `# ${channel}`;
    chatBox.innerHTML = "";
    typingUsers.clear();
    updateTypingIndicator();
    
    // WebSocket'e kanal değişimini bildir
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: "change_channel",
            channel: channel
        }));
    }
    
    loadMessages(channel);
    loadChannels(); // Aktif kanalı güncelle
}

// Mesaj Geçmişini Yükle
async function loadMessages(channel) {
    try {
        const response = await fetch(`/api/messages/${channel}?limit=50`);
        const data = await response.json();
        
        chatBox.innerHTML = "";
        data.messages.forEach(msg => {
            displayMessage(msg.username, msg.message, msg.timestamp, msg.id, true);
        });
        chatBox.scrollTop = chatBox.scrollHeight;
    } catch (error) {
        console.error("Mesajlar yüklenemedi:", error);
    }
}

// Mesaj Göster
function displayMessage(user, text, timestamp, messageId, isHistory = false) {
    const msg = document.createElement("div");
    msg.classList.add("message");
    msg.setAttribute("data-message-id", messageId);

    if (user === username) {
        msg.classList.add("self");
        
        const textDiv = document.createElement("div");
        textDiv.className = "text";
        textDiv.textContent = text;
        msg.appendChild(textDiv);
        
        const timeDiv = document.createElement("div");
        timeDiv.className = "timestamp";
        timeDiv.textContent = formatTime(timestamp);
        timeDiv.title = formatFullDate(timestamp);
        msg.appendChild(timeDiv);
        
        // Sağ tık menüsü
        msg.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            showContextMenu(e, messageId);
        });
    } else {
        msg.classList.add("other");
        
        const userDiv = document.createElement("div");
        userDiv.className = "username";
        userDiv.textContent = user;
        msg.appendChild(userDiv);
        
        const textDiv = document.createElement("div");
        textDiv.className = "text";
        textDiv.textContent = text;
        msg.appendChild(textDiv);
        
        const timeDiv = document.createElement("div");
        timeDiv.className = "timestamp";
        timeDiv.textContent = formatTime(timestamp);
        timeDiv.title = formatFullDate(timestamp);
        msg.appendChild(timeDiv);
    }

    chatBox.appendChild(msg);
    
    if (!isHistory) {
        chatBox.scrollTop = chatBox.scrollHeight;
    }
}

// Context Menu (Sağ Tık)
function showContextMenu(event, messageId) {
    // Eski menüyü kaldır
    const oldMenu = document.querySelector(".context-menu");
    if (oldMenu) oldMenu.remove();
    
    const menu = document.createElement("div");
    menu.className = "context-menu";
    menu.style.left = event.pageX + "px";
    menu.style.top = event.pageY + "px";
    
    const deleteBtn = document.createElement("div");
    deleteBtn.className = "context-menu-item";
    deleteBtn.textContent = "🗑️ Sil";
    deleteBtn.onclick = () => {
        deleteMessage(messageId);
        menu.remove();
    };
    
    menu.appendChild(deleteBtn);
    document.body.appendChild(menu);
    
    // Dışarı tıklanınca kapat
    setTimeout(() => {
        document.addEventListener("click", () => menu.remove(), { once: true });
    }, 0);
}

// Mesaj Sil
async function deleteMessage(messageId) {
    try {
        const response = await fetch(`/api/messages/${messageId}?username=${username}`, {
            method: "DELETE"
        });
        
        if (!response.ok) {
            const error = await response.json();
            showNotification(error.detail, "error");
        }
    } catch (error) {
        showNotification("Mesaj silinemedi", "error");
    }
}

// Mesajı DOM'dan Kaldır
function removeMessage(messageId) {
    const msgElement = document.querySelector(`[data-message-id="${messageId}"]`);
    if (msgElement) {
        msgElement.style.opacity = "0";
        setTimeout(() => msgElement.remove(), 300);
    }
}

// Kullanıcı Listesini Güncelle
function updateUsersList(users) {
    usersList.innerHTML = "";
    users.forEach(u => {
        const li = document.createElement("li");
        li.textContent = u;
        
        // DM özelliği için (gelecek)
        if (u !== username) {
            li.style.cursor = "pointer";
            li.title = "Özel mesaj gönder";
            li.onclick = () => showNotification("DM özelliği yakında!", "info");
        }
        
        usersList.appendChild(li);
    });
}

// Mesaj Gönder
function sendMessage() {
    if (!messageInput.value.trim()) return;
    
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: "message",
            text: messageInput.value
        }));
        messageInput.value = "";
        
        // Typing indicator'ı kapat
        isTyping = false;
        sendTypingStatus(false);
    }
}

// Enter Tuşu
function handleKeyPress(e) {
    if (e.key === "Enter") sendMessage();
}

// Bildirim Göster
function showNotification(message, type = "info") {
    const notification = document.createElement("div");
    notification.className = `notification ${type}`;
    notification.textContent = message;
    document.body.appendChild(notification);
    
    setTimeout(() => {
        notification.classList.add("show");
    }, 10);
    
    setTimeout(() => {
        notification.classList.remove("show");
        setTimeout(() => notification.remove(), 300);
    }, 3000);
}

// Çıkış
function logout() {
    if (ws) ws.close();
    localStorage.removeItem("chat_username");
    username = null;
    showLogin();
}

// Ekran Geçişleri
function showLogin() {
    loginScreen.style.display = "block";
    registerScreen.style.display = "none";
    chatScreen.style.display = "none";
}

function showRegister() {
    loginScreen.style.display = "none";
    registerScreen.style.display = "block";
    chatScreen.style.display = "none";
}

function showChat() {
    loginScreen.style.display = "none";
    registerScreen.style.display = "none";
    chatScreen.style.display = "flex";
}

// Zaman Formatlama
function formatTime(timestamp) {
    const date = new Date(timestamp);
    const hours = date.getHours().toString().padStart(2, '0');
    const minutes = date.getMinutes().toString().padStart(2, '0');
    return `${hours}:${minutes}`;
}

function formatFullDate(timestamp) {
    const date = new Date(timestamp);
    return date.toLocaleString('tr-TR', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    });
}