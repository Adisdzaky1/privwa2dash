# WhatsGate - Simple WhatsApp API Gateway

## 🚀 Fitur Utama

- ✅ Kirim pesan WhatsApp via API
- ✅ Dashboard modern dan responsif
- ✅ Sistem autentikasi dengan email verification (Supabase Auth)
- ✅ reCAPTCHA v3 protection
- ✅ Rate limiting per user
- ✅ Admin panel untuk manage users
- ✅ Real-time statistics
- ✅ API logging & monitoring
- ✅ Multi-plan system (Free, Pro, Enterprise, Custom)
- ✅ Automatic daily request reset (6 AM)

## 📋 Prerequisites

- Node.js 18+ 
- Supabase Account
- Google reCAPTCHA v3 Account

## 🛠️ Installation

### 1. Clone & Install Dependencies

```bash
# Clone repository
git clone <your-repo-url>
cd whatsgate-api

# Install dependencies
npm install
```

### 2. Setup Supabase

1. Buat project baru di [Supabase](https://supabase.com)
2. Copy `SUPABASE_URL` dan `SUPABASE_ANON_KEY` dari Project Settings > API
3. Jalankan SQL schema di SQL Editor:
   - Copy semua isi file `supabase-schema.sql`
   - Paste di Supabase SQL Editor
   - Run query

4. **Enable Email Auth di Supabase:**
   - Pergi ke Authentication > Settings
   - Enable "Email" provider
   - Konfigurasi email templates (optional)
   - **PENTING:** Di "Email Auth" settings, pastikan "Enable email confirmations" diaktifkan

5. **Configure Email Domain Whitelist (Optional):**
   - Di Authentication > Settings > Email Auth
   - Tambahkan domain yang diizinkan atau set ke "Allow all"

### 3. Setup Environment Variables

```bash
# Copy .env.example ke .env
cp .env.example .env

# Edit .env dengan credentials Anda
nano .env
```

Isi file `.env`:

```env
# Server Configuration
NODE_ENV=production
PORT=3000
FRONTEND_URL=https://yourdomain.com

# Session Secret (generate random string)
SESSION_SECRET=your-very-secret-random-string-here

# Supabase Configuration
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your-anon-key-here

# reCAPTCHA Configuration
RECAPTCHA_SITE_KEY=6LdPSlEsAAAAADG81kKvOHpuA-sT4p7mQWaB8tML
RECAPTCHA_SECRET_KEY=6LdPSlEsAAAAAJ8MIoT8bXxa4NZk33rgNZB7zbd4
```

### 4. Setup reCAPTCHA (Gunakan Keys yang Sudah Ada)

Keys sudah disediakan dalam code:
- **Site Key:** `6LdPSlEsAAAAADG81kKvOHpuA-sT4p7mQWaB8tML`
- **Secret Key:** `6LdPSlEsAAAAAJ8MIoT8bXxa4NZk33rgNZB7zbd4`

Atau jika ingin keys sendiri:
1. Pergi ke [Google reCAPTCHA](https://www.google.com/recaptcha/admin)
2. Register site baru dengan reCAPTCHA v3
3. Copy Site Key dan Secret Key ke `.env`

### 5. Test Locally

```bash
npm run dev
```

Buka browser: `http://localhost:3000`

## 🚀 Deploy ke Vercel

### 1. Install Vercel CLI

```bash
npm install -g vercel
```

### 2. Deploy

```bash
# Login ke Vercel
vercel login

# Deploy
vercel --prod
```

### 3. Set Environment Variables di Vercel

Di Vercel Dashboard > Project Settings > Environment Variables, tambahkan semua variables dari `.env`

## 📖 Struktur Database

### Table: users
- `id` - UUID (Primary Key, references auth.users)
- `username` - Unique username
- `email` - User email
- `full_name` - Full name
- `api_key` - Unique API key untuk setiap user
- `role` - 'user' or 'admin'
- `plan` - 'free', 'pro', 'enterprise', 'custom'
- `daily_limit` - Request limit per hari
- `requests_used_today` - Request yang sudah digunakan hari ini
- `total_requests` - Total request sepanjang waktu
- `plan_expires_at` - Tanggal expiry plan (NULL = tidak expire)
- `last_reset_date` - Tanggal terakhir reset

### Table: api_logs
- Logging semua API requests
- Menyimpan endpoint, method, IP, user agent, timestamp

### Table: whatsapp_sessions
- Menyimpan WhatsApp session data
- Dari code API Anda yang sudah ada

## 🎯 Cara Penggunaan

### 1. Register User Baru

- Kunjungi `/register`
- Isi form dengan email dari provider terkenal (Gmail, Yahoo, Outlook, etc.)
- Complete reCAPTCHA
- Verify email dari inbox
- Login di `/login`

### 2. Default Admin Account

```
Email: admin@whatsgate.com
Password: Admin123!
```

**PENTING:** Ubah password admin setelah first login!

### 3. API Usage

Setelah login, user mendapatkan API key di dashboard.

**Send Message:**
```bash
curl -X GET "https://yourdomain.com/api/send?nomor=628123456789&tujuan=628987654321&message=Hello" \
  -H "x-api-key: YOUR_API_KEY"
```

**Get Pairing Code:**
```bash
curl -X GET "https://yourdomain.com/api/getcode?nomor=628123456789" \
  -H "x-api-key: YOUR_API_KEY"
```

## 👨‍💼 Admin Features

Admin dapat:
- Melihat semua users
- Edit plan user (Free, Pro, Enterprise, Custom)
- Set custom daily limit untuk setiap user
- Set durasi plan (berapa hari berlaku)
- Delete users
- Downgrade/upgrade plans

### Cara Edit User Plan:

1. Login sebagai admin
2. Pergi ke `/admin`
3. Klik "Edit" pada user
4. Pilih plan dan set daily limit
5. Set plan duration (days):
   - 0 atau kosong = tidak expire
   - 30 = expire dalam 30 hari
   - Custom number = expire sesuai jumlah hari

## ⚙️ System Features

### Daily Request Reset
- Automatic reset setiap jam 6 pagi
- Reset `requests_used_today` menjadi 0
- Update `last_reset_date`

### Plan Expiration
- Automatic downgrade ke Free plan jika plan expire
- Check dilakukan setiap hari
- User diberi notifikasi

### Rate Limiting
- User tidak bisa menggunakan API jika daily limit tercapai
- Response 429 Too Many Requests

### Email Verification
- Hanya email dari trusted providers yang diizinkan
- Email harus verified sebelum bisa login

### Security
- Helmet.js security headers
- Rate limiting per IP
- CORS protection
- Input validation
- Password hashing (Supabase Auth)
- Session management
- API key authentication

## 🔧 Maintenance

### View Logs di Supabase

```sql
-- View all API logs
SELECT * FROM api_logs ORDER BY created_at DESC LIMIT 100;

-- View user statistics
SELECT 
    username, 
    plan, 
    daily_limit, 
    requests_used_today, 
    total_requests 
FROM users 
ORDER BY total_requests DESC;

-- View expired plans
SELECT * FROM users WHERE plan_expires_at < NOW();
```

### Manual Reset Daily Requests

```sql
SELECT reset_daily_requests();
```

### Manual Expire Plans

```sql
SELECT expire_plans();
```

## 📞 Support

- Telegram: [@yourtelegram](https://t.me/yourtelegram)
- Email: support@whatsgate.com

## 📝 License

MIT License

## ⚠️ Important Notes

1. **Email Verification:** User HARUS verify email sebelum bisa login
2. **Allowed Email Domains:** Gmail, Yahoo, Outlook, Hotmail, iCloud, ProtonMail, AOL
3. **API Keys:** Never share atau expose API keys
4. **Admin Password:** Segera ubah default admin password
5. **Database Backup:** Setup automatic backup di Supabase
6. **Environment Variables:** Jangan commit `.env` ke Git
7. **reCAPTCHA:** Keys sudah disediakan, tapi bisa diganti dengan keys sendiri

## 🎨 Customization

### Ubah Telegram Link
Ganti semua `https://t.me/yourtelegram` dengan link Telegram Anda di:
- `views/index.ejs`
- `views/dashboard.ejs`
- `views/verify-email.ejs`

### Ubah Domain
Replace `yourdomain.com` dengan domain Anda di:
- `views/index.ejs`
- `views/dashboard.ejs`
- `.env` (FRONTEND_URL)

### Tambah Plan Baru
Edit di `supabase-schema.sql`:
```sql
plan VARCHAR(50) DEFAULT 'free' CHECK (plan IN ('free', 'pro', 'enterprise', 'custom', 'yourplan'))
```

Lalu update di form admin panel.

## 🐛 Troubleshooting

### Error: "Email not verified"
- Check inbox dan spam folder
- Resend verification email dari Supabase Dashboard

### Error: "Daily limit reached"
- Wait sampai jam 6 pagi untuk automatic reset
- Atau admin bisa manual reset di database

### Error: "Invalid API key"
- Pastikan API key benar
- Check di dashboard user

### Error: "reCAPTCHA verification failed"
- Check internet connection
- Verify reCAPTCHA keys di `.env`

---

Made with ❤️ by WhatsGate Team