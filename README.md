# PBS Map — Webapp

Auth system এর উপর নির্মিত সম্পূর্ণ responsive web application।

## ফাইল কাঠামো

```
webapp/
├── index.html          # লগইন / নিবন্ধন / পাসওয়ার্ড পুনরুদ্ধার
├── home.html           # মূল পেজ (ম্যাপ + প্রোফাইল প্যানেল)
├── terms.html          # শর্তাবলী ও গোপনীয়তা নীতি
├── css/
│   ├── style.css       # Global styles
│   ├── auth.css        # Auth page styles
│   ├── home.css        # Home/map page styles
│   └── terms.css       # Terms page styles
├── js/
│   ├── config.js       # ⚙️ Configuration (API URL, Google Client ID)
│   ├── db.js           # IndexedDB manager
│   ├── api.js          # Backend API client
│   ├── auth.js         # Auth page logic
│   └── home.js         # Home page logic
└── img/
    └── default-avatar.svg
```

## সেটআপ

### ১. Config আপডেট করুন

`js/config.js` ফাইলে:

```js
const CONFIG = {
  API_BASE: 'http://localhost:8080',        // আপনার backend URL
  GOOGLE_CLIENT_ID: 'YOUR_CLIENT_ID...',   // Google OAuth Client ID
};
```

### ২. Auth System চালু করুন

```bash
cd auth-system
cargo run --release
```

### ৩. Webapp সার্ভ করুন

যেকোনো static server দিয়ে:

```bash
# Python
python -m http.server 3000

# Node.js (npx)
npx serve webapp -p 3000

# VS Code Live Server extension
```

তারপর `http://localhost:3000` এ যান।

## ফিচার সমূহ

- **লগইন**: ইমেইল / ইউজারনেম / মোবাইল + পাসওয়ার্ড
- **Google লগইন**: One-tap Google Sign-In
- **নিবন্ধন**: ইমেইল + পাসওয়ার্ড
- **পাসওয়ার্ড পুনরুদ্ধার**: OTP ভিত্তিক (ইমেইলে)
- **ম্যাপ**: লগইনের পর active office এর Leaflet ম্যাপ
- **অফিসে যোগ দিন**: PBS → অফিস বেছে join request পাঠান
- **প্রোফাইল প্যানেল** (ডানদিকে slide-in):
  - প্রোফাইল ছবি, নাম, পদবী, অফিস
  - তথ্য সম্পাদনা (নাম, পদবী, মোবাইল, WhatsApp)
  - পাসওয়ার্ড পরিবর্তন
  - API Key দেখা / কপি / পুনরায় তৈরি
  - ইউজারনেম কপি
- **IndexedDB**: অফলাইন ক্যাশিং
- **Responsive**: মোবাইল থেকে ডেস্কটপ সব ডিভাইসে কাজ করে

## Google OAuth সেটআপ

Client ID ইতিমধ্যে `auth-system/.env` থেকে `js/config.js` এ বসানো আছে:
```
664695884113-t1tvtbe1ouojt1bero9aeea4248ggi32.apps.googleusercontent.com
```

Google Cloud Console এ **Authorized JavaScript origins** এ আপনার webapp URL যোগ করতে হবে:
- `http://localhost:3000` (বা যে port এ serve করছেন)

### কীভাবে কাজ করে
1. User Google button ক্লিক করে → Google account বেছে নেয়
2. Google GSI SDK একটি **ID Token** (JWT) দেয় frontend কে
3. Frontend সেই token `POST /api/auth/login/google` এ পাঠায়
4. Backend Google এর `tokeninfo` API দিয়ে verify করে
5. User login বা auto-register হয়
