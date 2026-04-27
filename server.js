
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');
const axios = require('axios');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

// Twilio setup (lazy init)
let twilioClient = null;
function getTwilioClient() {
    if (!twilioClient && process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
        twilioClient = require('twilio')(
            process.env.TWILIO_ACCOUNT_SID,
            process.env.TWILIO_AUTH_TOKEN
        );
    }
    return twilioClient;
}

// MiniMax TTS function
async function generateSpeech(text, voiceId = 'male-qn-qingse') {
    try {
        const response = await axios.post(
            'https://api.minimax.chat/v1/t2a_v2',
            {
                text: text,
                model: 't2a-100k',
                voice_setting: {
                    voice_id: voiceId,
                    speed: 1.0,
                    vol: 1.0,
                    pitch: 0
                }
            },
            {
                headers: {
                    'Authorization': `Bearer ${process.env.MINIMAX_API_KEY}`,
                    'Content-Type': 'application/json'
                },
                timeout: 10000
            }
        );
        
        if (response.data.code === 0 && response.data.data && response.data.data.audio) {
            return {
                success: true,
                audioData: response.data.data.audio,
                audio_format: response.data.data.audio_format
            };
        }
        return { success: false, error: 'TTS generation failed' };
    } catch (error) {
        console.error('TTS Error:', error.message);
        return { success: false, error: error.message };
    }
}

// Supabase setup for patient lookup
function getSupabaseClient() {
    const { createClient } = require('@supabase/supabase-js');
    return createClient(
        process.env.SUPABASE_URL || 'https://vodhhauwowkalvaxzqyv.supabase.co',
        process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZvZGhoYXV3b3drYWx2YXh6cXl2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDYyNzIwMDAsImV4cCI6MjA2MTg0ODAwMH0.fake_key'
    );
}

// Patient lookup by phone
async function findPatientByPhone(phoneNumber) {
    try {
        const supabase = getSupabaseClient();
        const cleanPhone = phoneNumber.replace(/\D/g, '');
        
        // Try to find patient by phone
        const { data, error } = await supabase
            .from('patients')
            .select('*')
            .or(`phone.eq.${cleanPhone},phone.contains.${cleanPhone})`)
            .limit(1)
            .single();
        
        if (error || !data) {
            // Try alternative table
            const { data: altData } = await supabase
                .from('patient_demographics')
                .select('*')
                .or(`phone_number.eq.${cleanPhone},phone_number.contains.${cleanPhone})`)
                .limit(1)
                .single();
            
            return altData || null;
        }
        
        return data;
    } catch (error) {
        console.error('Patient lookup error:', error.message);
        return null;
    }
}

// Generate TwiML response
function generateTwiML(text, voiceId = 'male-qn-qingse') {
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="alice" language="en-US">${text}</Say>
    <Gather input="speech" action="/api/voice/gather" method="POST" numDigits="1" timeout="3">
        <Say voice="alice" language="en-US">Press 1 to repeat, or say what you need help with.</Say>
    </Gather>
    <Say voice="alice" language="en-US">Thank you for calling MBMB. Goodbye.</Say>
</Response>`;
    
    return twiml;
}

const app = express();
const PORT = process.env.PORT || 3000;

// Database connection - lazy init
let pool = null;
function getPool() {
    if (!pool && process.env.DATABASE_URL) {
        pool = new Pool({
            connectionString: process.env.DATABASE_URL,
            ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
        });
    }
    return pool;
}

// Middleware
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            scriptSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", "data:", "https:"],
            connectSrc: ["'self'", "https://api.openai.com"]
        },
    },
}));

app.use(compression());
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: 'Too many requests from this IP'
});
app.use('/api/', limiter);

// Florida Payer Rules Engine
const floridaPayers = {
    'FLORIDA_MEDICAID': {
        rules: [
            'Provider must be enrolled in Florida Medicaid',
            'NPI must be active and valid',
            'Service must be prior authorized if required',
            'Claim must be submitted within 12 months'
        ],
        priorAuthRequired: ['specialist_visits', 'imaging', 'procedures'],
        maxTimelyFiling: 365,
        specialRequirements: ['medicaid_id_verification']
    },
    'SUNSHINE_HEALTH': {
        rules: [
            'Member eligibility must be verified',
            'PCP referral required for specialists',
            'Specific coding requirements for Miami-Dade'
        ],
        priorAuthRequired: ['out_of_network', 'durable_medical_equipment'],
        maxTimelyFiling: 180,
        specialRequirements: ['miami_dade_provider_network']
    },
    'BAPTIST_HEALTH': {
        rules: [
            'Provider must be in Baptist Health network',
            'Pre-certification for inpatient services',
            'Specific documentation requirements'
        ],
        priorAuthRequired: ['inpatient', 'surgery', 'outpatient_procedures'],
        maxTimelyFiling: 90,
        specialRequirements: ['baptist_network_verification']
    }
};

// AI Voice Agent Configuration
const voiceAgentConfig = {
    languages: ['en-US', 'es-US'],
    voiceModels: {
        'en-US': 'en-US-Wavenet-D',
        'es-US': 'es-US-Wavenet-A'
    },
    medicalTerminology: true,
    empathyMode: 'high',
    persistenceLevel: 'assertive'
};

// MBMB Core APIs

// Demo Request Handler
app.post('/api/demo-request', async (req, res) => {
    try {
        const { practiceName, fullName, email, phone, specialty, monthlyClaims, message } = req.body;
        
        // Validate data
        if (!practiceName || !fullName || !email || !phone) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        
        // Store in database
        const result = await pool.query(
            'INSERT INTO demo_requests (practice_name, contact_name, email, phone, specialty, monthly_claims, message, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id',
            [practiceName, fullName, email, phone, specialty, monthlyClaims, message, new Date()]
        );
        
        // Trigger AI demo scheduling
        await scheduleAIDemo({
            id: result.rows[0].id,
            practiceName,
            contactName: fullName,
            email,
            specialty,
            monthlyClaims
        });
        
        res.json({ 
            success: true, 
            message: 'Demo scheduled successfully. Our AI will contact you within 2 hours.',
            demoId: result.rows[0].id
        });
        
    } catch (error) {
        console.error('Demo request error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// AI Demo Scheduler
async function scheduleAIDemo(demoData) {
    // Integrate with AI scheduling system
    console.log('Scheduling AI demo for:', demoData);
    
    // Here you would integrate with:
    // - Calendar system (Google Calendar, Calendly API)
    // - Email automation (SendGrid, Mailgun)
    // - CRM system (Salesforce, HubSpot)
    
    return {
        scheduled: true,
        aiAgent: 'MBMB-Demo-Bot-v2.1',
        estimatedContactTime: new Date(Date.now() + 2 * 60 * 60 * 1000) // 2 hours
    };
}

// Claim Scrubbing API
app.post('/api/scrub-claim', async (req, res) => {
    try {
        const { claimData, payerId } = req.body;
        
        // Run AI scrubbing
        const scrubbingResults = await scrubClaimWithAI(claimData, payerId);
        
        res.json({
            success: true,
            scrubbingResults,
            confidenceScore: scrubbingResults.confidence,
            estimatedSuccessRate: scrubbingResults.successRate
        });
        
    } catch (error) {
        console.error('Claim scrubbing error:', error);
        res.status(500).json({ error: 'Scrubbing failed' });
    }
});

// AI Claim Scrubbing
async function scrubClaimWithAI(claimData, payerId) {
    const payerRules = floridaPayers[payerId] || floridaPayers['FLORIDA_MEDICAID'];
    
    let issues = [];
    let confidence = 0;
    
    // Check provider credentials
    if (!claimData.providerNpi) {
        issues.push('Missing provider NPI');
        confidence -= 20;
    }
    
    // Check prior auth requirements
    const servicesRequiringAuth = claimData.services?.filter(service => 
        payerRules.priorAuthRequired.includes(service.type)
    );
    
    if (servicesRequiringAuth.length > 0 && !claimData.priorAuthNumber) {
        issues.push('Prior authorization required for: ${servicesRequiringAuth.map(s => s.type).join(', ')}');
        confidence -= 30;
    }
    
    // Check timely filing
    const serviceDate = new Date(claimData.serviceDate);
    const daysSinceService = Math.floor((new Date() - serviceDate) / (1000 * 60 * 60 * 24));
    
    if (daysSinceService > payerRules.maxTimelyFiling) {
        issues.push('Claim exceeds timely filing limit of ${payerRules.maxTimelyFiling} days');
        confidence -= 50;
    }
    
    // Calculate final confidence
    confidence = Math.max(0, 100 - (issues.length * 15));
    
    return {
        issues,
        confidence,
        successRate: confidence > 80 ? 'High' : confidence > 60 ? 'Medium' : 'Low',
        recommendations: generateRecommendations(issues),
        payerSpecific: payerRules.specialRequirements
    };
}

function generateRecommendations(issues) {
    const recommendations = [];
    
    if (issues.includes('Missing provider NPI')) {
        recommendations.push('Verify provider NPI is active and correctly formatted');
    }
    
    if (issues.some(i => i.includes('Prior authorization'))) {
        recommendations.push('Submit prior authorization request before claim submission');
    }
    
    if (issues.some(i => i.includes('timely filing'))) {
        recommendations.push('Consider appeal process for late filing with justification');
    }
    
    return recommendations;
}

// Voice Agent API
app.post('/api/voice-agent', async (req, res) => {
    try {
        const { action, parameters } = req.body;
        
        const voiceResponse = await handleVoiceAgent(action, parameters);
        
        res.json({
            success: true,
            voiceResponse,
            sessionId: generateSessionId()
        });
        
    } catch (error) {
        console.error('Voice agent error:', error);
        res.status(500).json({ error: 'Voice agent unavailable' });
    }
});

// ============================================
// TWILIO VOICE CALL ENDPOINTS
// ============================================

// Incoming call webhook - Twilio hits this when someone calls our number
app.post('/api/voice/incoming', async (req, res) => {
    try {
        const { From, CallSid } = req.body;
        console.log(`Incoming call from ${From}, CallSid: ${CallSid}`);
        
        // Look up patient by phone
        const patient = await findPatientByPhone(From);
        
        let welcomeMessage;
        if (patient) {
            welcomeMessage = `Hello ${patient.name || patient.first_name || 'there'}! Thank you for calling MBMB Medical Billing. How may I help you today?`;
        } else {
            welcomeMessage = "Thank you for calling MBMB Medical Billing in Miami. How may I help you today?";
        }
        
        // Generate TwiML response
        const twiml = generateTwiML(welcomeMessage);
        
        res.type('text/xml');
        res.send(twiml);
        
    } catch (error) {
        console.error('Incoming call error:', error);
        res.type('text/xml');
        res.send(generateTwiML("Thank you for calling MBMB. Please hold and our team will assist you."));
    }
});

// Gather voice input
app.post('/api/voice/gather', async (req, res) => {
    try {
        const { SpeechResult, Digits, From } = req.body;
        
        console.log(`Speech result: ${SpeechResult}, Digits: ${Digits}, From: ${From}`);
        
        let responseText = "I did not understand. Let me connect you with our billing team.";
        
        // Analyze what they said
        if (SpeechResult) {
            const lowerSpeech = SpeechResult.toLowerCase();
            
            if (lowerSpeech.includes('claim') || lowerSpeech.includes('bill')) {
                responseText = "I can help you with your claim. Can you provide your date of birth or account number?";
            } else if (lowerSpeech.includes('insurance') || lowerSpeech.includes('coverage')) {
                responseText = "I will verify your insurance coverage. Please hold for a moment.";
            } else if (lowerSpeech.includes('payment') || lowerSpeech.includes('pay')) {
                responseText = "I can help you make a payment. Would you like to pay by card or set up a payment plan?";
            } else if (lowerSpeech.includes('yes') || lowerSpeech.includes('correct')) {
                responseText = "Great! Is there anything else I can help you with?";
            } else if (lowerSpeech.includes('no') || lowerSpeech.includes('thank')) {
                responseText = "Thank you for calling MBMB. Have a great day!";
            } else {
                responseText = "I understand. Let me connect you with a specialist who can better assist you.";
            }
        }
        
        const twiml = generateTwiML(responseText);
        
        res.type('text/xml');
        res.send(twiml);
        
    } catch (error) {
        console.error('Gather error:', error);
        res.type('text/xml');
        res.send(generateTwiML("Please hold and our team will assist you."));
    }
});

// Outbound call - initiate a call to patient
app.post('/api/call/outbound', async (req, res) => {
    try {
        const { to, message, patientId } = req.body;
        
        if (!to) {
            return res.status(400).json({ error: 'Phone number required' });
        }
        
        const twilio = getTwilioClient();
        
        if (!twilio) {
            // Fallback: just log the call request if no Twilio
            console.log(`Outbound call request to ${to}: ${message}`);
            return res.json({
                success: true,
                message: 'Call queued',
                fallback: true,
                note: 'Twilio not configured - set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN'
            });
        }
        
        // Get patient name if provided
        let patientName = '';
        if (patientId) {
            const patient = await findPatientByPhone(to);
            if (patient) {
                patientName = patient.name || patient.first_name || '';
            }
        }
        
        const callMessage = message || `Hello ${patientName}. This is MBMB Medical Billing calling. Please call us back at 786-643-2099 if you have questions about your account.`;
        
        // Make the call
        const call = await twilio.calls.create({
            to: to,
            from: process.env.TWILIO_PHONE_NUMBER || '+1234567890',
            twiml: `<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="alice" language="en-US">${callMessage}</Say></Response>`,
            statusCallback: process.env.TWILIO_STATUS_CALLBACK_URL || undefined,
            statusCallbackEvent: ['completed', 'failed']
        });
        
        console.log(`Outbound call initiated: ${call.sid}`);
        
        res.json({
            success: true,
            callSid: call.sid,
            status: call.status
        });
        
    } catch (error) {
        console.error('Outbound call error:', error);
        res.status(500).json({ error: 'Failed to initiate call' });
    }
});

// Twilio status webhook
app.post('/api/call/status', (req, res) => {
    const { CallSid, CallStatus, CallDuration } = req.body;
    console.log(`Call ${CallSid} status: ${CallStatus}, Duration: ${CallDuration}s`);
    
    res.sendStatus(200);
});

async function handleVoiceAgent(action, parameters) {
    // Simulate AI voice agent response
    const responses = {
        'check_claim_status': {
            message: 'I will check that claim status for you right away. Let me access the payer system.',
            nextAction: 'query_payer_system',
            estimatedTime: '30 seconds'
        },
        'appeal_denial': {
            message: 'I can help you appeal that denial. Let me gather the necessary information and initiate the appeal process.',
            nextAction: 'initiate_appeal',
            requirements: ['denial_reason', 'claim_number', 'supporting_documents']
        },
        'verify_eligibility': {
            message: 'I will verify the patient eligibility with their insurance. This will just take a moment.',
            nextAction: 'verify_insurance',
            language: parameters.language || 'en-US'
        }
    };
    
    return responses[action] || {
        message: ' I am  connecting you with our specialized billing team who can assist you further.',
        nextAction: 'transfer_to_human'
    };
}

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'healthy',
        service: 'MBMB Medical Billing Platform',
        version: '2.0.0',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        environment: process.env.NODE_ENV || 'development'
    });
});

// Serve static files
app.use(express.static('public'));

// Error handling
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ error: 'Something went wrong!' });
});

app.listen(PORT, () => {
    console.log('🏥 MBMB Medical Billing Platform v2.0 running on port ${PORT}');
    console.log('🚀 Advanced AI features enabled');
    console.log('🇵️ Florida-specific payer rules loaded');
});
