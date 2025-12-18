# Kurum İçi Chat Uygulaması

## Özellikler
- WebSocket tabanlı gerçek zamanlı mesajlaşma
- Kanal sistemi
- Typing indicator
- Online kullanıcı listesi
- Mesaj silme (soft delete)
- Rate limiting
- MSSQL veritabanı

## Teknolojiler
- Backend: FastAPI, WebSocket
- Frontend: HTML, CSS, Vanilla JS
- Database: MSSQL (pyodbc)

## Kurulum
1. MSSQL veritabanını oluştur
2. `ChatDB` database'ini ayarla
3. `pip install -r requirements.txt`
4. `uvicorn main:app --reload`
