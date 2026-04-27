# MBMB Voice Platform v2.2

Miami Medical Billing AI Voice Platform - works without Twilio API!

## What's Working NOW (No Twilio Required)

### Frontend (index.html)
- Status bar showing Supabase/Twilio/MiniMax connection status
- **"Request Callback" form** - stores requests even without Twilio
- **"Schedule Demo" form** - collects demo requests
- Patient-friendly landing page explaining the platform

### API Endpoints
| Endpoint | Method | Description |
|---------|--------|------------|
| /api/callback-request | POST | Submit callback request |
| /api/demo-request | POST | Submit demo request |
| /api/callbacks | GET | List pending callbacks |
| /api/health | GET | Health check |
| /api/voice/incoming | POST | Twilio webhook (waits for config) |
| /api/voice/gather | POST | Twilio gather webhook |

## What's NOT Working (Needs Twilio)

- Actual phone calls (needs Twilio credentials)
- Outbound calling (needs Twilio credentials)
- Real voice responses (needs configured webhooks)

## Setup Required to Enable Voice

### 1. Twilio Account
Get from [twilio.com](https://twilio.com):
- Account SID
- Auth Token
- Phone Number

### 2. Environment Variables (Vercel Dashboard)
```
TWILIO_ACCOUNT_SID=ACxxxxxxxx
TWILIO_AUTH_TOKEN=your_auth_token
TWILIO_PHONE_NUMBER=+1XXXXXXXXXX
MINIMAX_API_KEY=your_api_key
```

### 3. Twilio Console Configuration
Set Voice Webhook URL to:
```
https://mbmb-voice-platform.vercel.app/api/voice/incoming
```

### 4. Supabase Tables (Optional)
Create in Supabase dashboard:
```sql
-- Callback requests table
CREATE TABLE callback_requests (
  id SERIAL PRIMARY KEY,
  name TEXT,
  phone TEXT,
  reason TEXT,
  status TEXT DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT NOW()
);

-- Demo requests table  
CREATE TABLE demo_requests (
  id SERIAL PRIMARY KEY,
  practice_name TEXT,
  full_name TEXT,
  email TEXT,
  phone TEXT,
  specialty TEXT,
  volume TEXT,
  challenges TEXT,
  status TEXT DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT NOW()
);
```

## How It Works

1. Patient visits website → fills "Request Callback" form
2. Request stored in Supabase (or logged locally)
3. When Twilio is configured → system calls patient automatically
4. AI greets patient by name from database
5. AI handles billing questions (claims, insurance, payments)

## Test Without Twilio

Visit: https://mbmb-voice-platform.vercel.app

The forms work and store data even without Twilio!

## Architecture

```
Patient        →    Website (index.html)
                     │
                     ▼
              Callback/Demo Request
                     │
                     ▼
              Supabase (or local log)
                     │
                     ▼ (when Twilio configured)
              Twilio Voice API
                     │
                     ▼
              Patient Phone Call
```

## Status Indicators

🟢 Green = Working  
🔴 Red = Not Yet Configured

- Supabase: 🟢 (connects if tables exist)
- Twilio: 🔴 (needs credentials)
- MiniMax: 🟢 (if API key provided)
- Phone Number: 🔴 (needs Twilio phone number)