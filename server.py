from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
import json
import pyodbc
from datetime import datetime, timedelta
from typing import Optional
import hashlib
import secrets
import asyncio
from collections import defaultdict

app = FastAPI()

# MSSQL Bağlantısı
DB_CONFIG = {
    "server": ".",
    "database": "ChatDB",
    "driver": "{ODBC Driver 17 for SQL Server}"
}

def get_db_connection():
    conn_str = (
        f"DRIVER={DB_CONFIG['driver']};"
        f"SERVER={DB_CONFIG['server']};"
        f"DATABASE={DB_CONFIG['database']};"
        f"Trusted_Connection=yes;"
        f"Connection Timeout=30;"
    )
    return pyodbc.connect(conn_str)

# WebSocket bağlantıları ve lock
clients = {}  # websocket -> {"username": str, "channel": str}
channels = {}  # channel_name -> [websockets]
typing_users = {}  # channel -> {username: timestamp}
user_message_count = defaultdict(list)  # username -> [timestamps]
clients_lock = asyncio.Lock()

# Rate limiting ayarları
MAX_MESSAGES_PER_MINUTE = 20
MUTE_DURATION = 60  # saniye

# Pydantic Modeller
class LoginRequest(BaseModel):
    username: str
    password: str

class RegisterRequest(BaseModel):
    username: str
    password: str
    email: str

# Şifre Hash (Salt ile)
def hash_password(password: str, salt: str = None) -> tuple:
    if salt is None:
        salt = secrets.token_hex(16)
    
    hashed = hashlib.sha256((password + salt).encode()).hexdigest()
    return hashed, salt

# Veritabanı Tabloları
def init_database():
    conn = get_db_connection()
    cursor = conn.cursor()
    
    # Users Tablosu (salt eklendi)
    cursor.execute("""
        IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='users' AND xtype='U')
        CREATE TABLE users (
            id INT IDENTITY(1,1) PRIMARY KEY,
            username NVARCHAR(50) UNIQUE NOT NULL,
            password NVARCHAR(64) NOT NULL,
            salt NVARCHAR(32) NOT NULL,
            email NVARCHAR(100),
            created_at DATETIME DEFAULT GETDATE()
        )
    """)
    
    # Channels Tablosu
    cursor.execute("""
        IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='channels' AND xtype='U')
        CREATE TABLE channels (
            id INT IDENTITY(1,1) PRIMARY KEY,
            name NVARCHAR(50) UNIQUE NOT NULL,
            created_at DATETIME DEFAULT GETDATE()
        )
    """)
    
    # Messages Tablosu (message_id eklendi)
    cursor.execute("""
        IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='messages' AND xtype='U')
        CREATE TABLE messages (
            id INT IDENTITY(1,1) PRIMARY KEY,
            username NVARCHAR(50) NOT NULL,
            channel NVARCHAR(100) NOT NULL,
            message NVARCHAR(MAX) NOT NULL,
            created_at DATETIME DEFAULT GETDATE(),
            deleted BIT DEFAULT 0
        )
    """)
    
    # Varsayılan kanallar
    default_channels = ['genel', 'destek', 'duyurular']
    for channel in default_channels:
        cursor.execute("""
            IF NOT EXISTS (SELECT * FROM channels WHERE name=?)
            INSERT INTO channels (name) VALUES (?)
        """, (channel, channel))
    
    conn.commit()
    conn.close()

init_database()

# Rate Limiting Kontrolü
def check_rate_limit(username: str) -> bool:
    now = datetime.now()
    
    # Son 1 dakikadaki mesajları filtrele
    user_message_count[username] = [
        ts for ts in user_message_count[username]
        if now - ts < timedelta(minutes=1)
    ]
    
    # Limit kontrolü
    if len(user_message_count[username]) >= MAX_MESSAGES_PER_MINUTE:
        return False
    
    user_message_count[username].append(now)
    return True

# API Endpoints
@app.post("/api/register")
async def register(req: RegisterRequest):
    conn = get_db_connection()
    cursor = conn.cursor()
    
    try:
        hashed_pwd, salt = hash_password(req.password)
        cursor.execute(
            "INSERT INTO users (username, password, salt, email) VALUES (?, ?, ?, ?)",
            (req.username, hashed_pwd, salt, req.email)
        )
        conn.commit()
        return {"success": True, "username": req.username}
    
    except pyodbc.IntegrityError:
        raise HTTPException(status_code=400, detail="Kullanıcı adı zaten mevcut")
    finally:
        conn.close()

@app.post("/api/login")
async def login(req: LoginRequest):
    conn = get_db_connection()
    cursor = conn.cursor()
    
    # Kullanıcıyı bul
    cursor.execute(
        "SELECT username, password, salt FROM users WHERE username=?",
        (req.username,)
    )
    
    user = cursor.fetchone()
    conn.close()
    
    if not user:
        raise HTTPException(status_code=401, detail="Kullanıcı adı veya şifre hatalı")
    
    # Şifreyi kontrol et
    hashed_pwd, _ = hash_password(req.password, user[2])
    
    if hashed_pwd != user[1]:
        raise HTTPException(status_code=401, detail="Kullanıcı adı veya şifre hatalı")
    
    return {"success": True, "username": req.username}

@app.get("/api/channels")
async def get_channels():
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT name FROM channels ORDER BY name")
    channels_list = [row[0] for row in cursor.fetchall()]
    conn.close()
    return {"channels": channels_list}

@app.get("/api/messages/{channel}")
async def get_messages(channel: str, limit: int = 50):
    # Güvenlik: channel adını whitelist et
    if not channel.replace('_', '').replace('-', '').isalnum():
        raise HTTPException(status_code=400, detail="Geçersiz kanal adı")
    
    if limit > 100:
        limit = 100
    
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute(
        "SELECT TOP (?) id, username, message, created_at FROM messages WHERE channel=? AND deleted=0 ORDER BY created_at DESC",
        (limit, channel)
    )
    
    messages = []
    for row in cursor.fetchall():
        messages.append({
            "id": row[0],
            "username": row[1],
            "message": row[2],
            "timestamp": row[3].isoformat()
        })
    
    conn.close()
    return {"messages": list(reversed(messages))}

@app.delete("/api/messages/{message_id}")
async def delete_message(message_id: int, username: str):
    conn = get_db_connection()
    cursor = conn.cursor()
    
    # Mesajın sahibini kontrol et
    cursor.execute(
        "SELECT username, channel FROM messages WHERE id=? AND deleted=0",
        (message_id,)
    )
    
    result = cursor.fetchone()
    
    if not result:
        conn.close()
        raise HTTPException(status_code=404, detail="Mesaj bulunamadı")
    
    if result[0] != username:
        conn.close()
        raise HTTPException(status_code=403, detail="Bu mesajı silemezsiniz")
    
    # Mesajı sil (soft delete)
    cursor.execute(
        "UPDATE messages SET deleted=1 WHERE id=?",
        (message_id,)
    )
    conn.commit()
    conn.close()
    
    return {"success": True, "message_id": message_id, "channel": result[1]}

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    username = None
    channel = None

    try:
        # İlk mesaj: kullanıcı adı ve kanal
        init_data = await websocket.receive_text()
        init = json.loads(init_data)
        
        username = init.get("username")
        channel = init.get("channel", "genel")
        
        if not username:
            await websocket.send_text(json.dumps({"type": "error", "message": "Kullanıcı adı gerekli"}))
            await websocket.close()
            return
        
        # Kullanıcıyı kaydet (lock ile)
        async with clients_lock:
            clients[websocket] = {"username": username, "channel": channel}
            
            if channel not in channels:
                channels[channel] = []
            channels[channel].append(websocket)
        
        # Online kullanıcıları gönder
        await broadcast_users(channel)

        while True:
            data = await websocket.receive_text()
            msg = json.loads(data)

            if msg["type"] == "message":
                # Rate limiting kontrolü
                if not check_rate_limit(username):
                    await websocket.send_text(json.dumps({
                        "type": "error",
                        "message": f"Çok hızlı mesaj gönderiyorsunuz. {MUTE_DURATION} saniye bekleyin."
                    }))
                    continue
                
                # Mesajı veritabanına kaydet ve ID al
                message_id = save_message(username, channel, msg["text"])
                
                # Mesajı broadcast et
                await broadcast_message(channel, username, msg["text"], message_id)
            
            elif msg["type"] == "typing":
                # Typing indicator
                await broadcast_typing(channel, username, msg.get("status", False))
            
            elif msg["type"] == "change_channel":
                new_channel = msg["channel"]
                
                async with clients_lock:
                    # Eski kanaldan çıkar
                    if channel in channels and websocket in channels[channel]:
                        channels[channel].remove(websocket)
                        await broadcast_users(channel)
                    
                    # Yeni kanala ekle
                    channel = new_channel
                    clients[websocket]["channel"] = channel
                    
                    if channel not in channels:
                        channels[channel] = []
                    channels[channel].append(websocket)
                
                await broadcast_users(channel)
            
            elif msg["type"] == "delete_message":
                message_id = msg.get("message_id")
                if message_id:
                    try:
                        result = await delete_message(message_id, username)
                        # Silme işlemini broadcast et
                        await broadcast_delete(result["channel"], message_id)
                    except Exception as e:
                        await websocket.send_text(json.dumps({
                            "type": "error",
                            "message": str(e)
                        }))

    except WebSocketDisconnect:
        pass
    except Exception as e:
        print(f"WebSocket hatası: {e}")
    finally:
        # Cleanup (lock ile güvenli)
        async with clients_lock:
            if websocket in clients:
                user_data = clients[websocket]
                channel = user_data["channel"]
                
                clients.pop(websocket, None)
                
                if channel in channels and websocket in channels[channel]:
                    channels[channel].remove(websocket)
                
                await broadcast_users(channel)

def save_message(username: str, channel: str, message: str) -> int:
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute(
            "INSERT INTO messages (username, channel, message) OUTPUT INSERTED.id VALUES (?, ?, ?)",
            (username, channel, message)
        )
        message_id = cursor.fetchone()[0]
        conn.commit()
        conn.close()
        return message_id
    except Exception as e:
        print(f"Mesaj kaydetme hatası: {e}")
        return 0

async def broadcast_message(channel: str, username: str, text: str, message_id: int):
    payload = {
        "type": "message",
        "id": message_id,
        "user": username,
        "text": text,
        "timestamp": datetime.now().isoformat()
    }
    
    if channel in channels:
        for client in list(channels[channel]):
            try:
                await client.send_text(json.dumps(payload))
            except:
                pass

async def broadcast_typing(channel: str, username: str, status: bool):
    payload = {
        "type": "typing",
        "user": username,
        "status": status
    }
    
    if channel in channels:
        for client in list(channels[channel]):
            try:
                if clients.get(client, {}).get("username") != username:
                    await client.send_text(json.dumps(payload))
            except:
                pass

async def broadcast_delete(channel: str, message_id: int):
    payload = {
        "type": "message_deleted",
        "message_id": message_id
    }
    
    if channel in channels:
        for client in list(channels[channel]):
            try:
                await client.send_text(json.dumps(payload))
            except:
                pass

async def broadcast_users(channel: str):
    if channel not in channels:
        return
    
    users = [clients[ws]["username"] for ws in channels[channel] if ws in clients]
    
    payload = {
        "type": "users",
        "users": users
    }
    
    for client in list(channels[channel]):
        try:
            await client.send_text(json.dumps(payload))
        except:
            pass

app.mount("/", StaticFiles(directory="static", html=True), name="static")