
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');
const axios = require('axios');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 3000;

// Database connection
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

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
        issues.push(`Prior authorization required for: ${servicesRequiringAuth.map(s => s.type).join(', ')}`);
        confidence -= 30;
    }
    
    // Check timely filing
    const serviceDate = new Date(claimData.serviceDate);
    const daysSinceService = Math.floor((new Date() - serviceDate) / (1000 * 60 * 60 * 24));
    
    if (daysSinceService > payerRules.maxTimelyFiling) {
        issues.push(`Claim exceeds timely filing limit of ${payerRules.maxTimelyFiling} days`);
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

async function handleVoiceAgent(action, parameters) {
    // Simulate AI voice agent response
    const responses = {
        'check_claim_status': {
            message: 'I'll check that claim status for you right away. Let me access the payer system.',
            nextAction: 'query_payer_system',
            estimatedTime: '30 seconds'
        },
        'appeal_denial': {
            message: 'I can help you appeal that denial. Let me gather the necessary information and initiate the appeal process.',
            nextAction: 'initiate_appeal',
            requirements: ['denial_reason', 'claim_number', 'supporting_documents']
        },
        'verify_eligibility': {
            message: 'I'll verify the patient's eligibility with their insurance. This will just take a moment.',
            nextAction: 'verify_insurance',
            language: parameters.language || 'en-US'
        }
    };
    
    return responses[action] || {
        message: 'I'm connecting you with our specialized billing team who can assist you further.',
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
    console.log(`🏥 MBMB Medical Billing Platform v2.0 running on port ${PORT}`);
    console.log(`🚀 Advanced AI features enabled`);
    console.log(`🇵️ Florida-specific payer rules loaded`);
});
