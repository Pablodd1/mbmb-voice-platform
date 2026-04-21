
const express = require('express');
const Stripe = require('stripe');
const axios = require('axios');
const { Pool } = require('pg');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const router = express.Router();

// Database connection
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// MBMB Pricing Plans
const mbmbPlans = {
    'starter': {
        name: 'MBMB Starter',
        price: 49900, // $499 in cents
        features: ['500 claims/month', 'AI voice agent', 'FL Medicaid integration'],
        stripePriceId: process.env.STRIPE_STARTER_PRICE_ID
    },
    'professional': {
        name: 'MBMB Professional', 
        price: 99900, // $999 in cents
        features: ['2000 claims/month', 'Advanced AI', 'All payer integrations', 'Analytics'],
        stripePriceId: process.env.STRIPE_PRO_PRICE_ID
    },
    'enterprise': {
        name: 'MBMB Enterprise',
        price: 'custom',
        features: ['Unlimited claims', 'Custom AI training', 'White-label', 'API access'],
        stripePriceId: 'custom'
    }
};

// LawHelper Pricing Plans
const lawhelperPlans = {
    'starter': {
        name: 'LawHelper Starter',
        price: 9900, // $99 in cents
        features: ['50 documents/month', 'Basic templates', 'Limited research'],
        stripePriceId: process.env.STRIPE_LH_STARTER_PRICE_ID
    },
    'professional': {
        name: 'LawHelper Professional',
        price: 29900, // $299 in cents
        features: ['Unlimited documents', 'All templates', 'Advanced research', 'Contract analysis'],
        stripePriceId: process.env.STRIPE_LH_PRO_PRICE_ID
    }
};

// Create Checkout Session
router.post('/create-checkout-session', async (req, res) => {
    try {
        const { plan, product, customerInfo } = req.body;
        
        // Validate plan
        const planData = product === 'mbmb' ? mbmbPlans[plan] : lawhelperPlans[plan];
        if (!planData) {
            return res.status(400).json({ error: 'Invalid plan selected' });
        }

        // Create or retrieve customer
        let customer;
        if (customerInfo.customerId) {
            customer = { id: customerInfo.customerId };
        } else {
            customer = await stripe.customers.create({
                email: customerInfo.email,
                name: customerInfo.name,
                metadata: {
                    practiceName: customerInfo.practiceName,
                    phone: customerInfo.phone,
                    specialty: customerInfo.specialty
                }
            });
        }

        // Create checkout session
        const session = await stripe.checkout.sessions.create({
            customer: customer.id,
            payment_method_types: ['card'],
            line_items: [{
                price: planData.stripePriceId,
                quantity: 1
            }],
            mode: 'subscription',
            success_url: `${process.env.FRONTEND_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${process.env.FRONTEND_URL}/pricing`,
            metadata: {
                plan: plan,
                product: product,
                practiceName: customerInfo.practiceName,
                specialty: customerInfo.specialty
            }
        });

        res.json({ sessionId: session.id });
        
    } catch (error) {
        console.error('Checkout session error:', error);
        res.status(500).json({ error: 'Failed to create checkout session' });
    }
});

// Handle Stripe Webhooks
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;

    try {
        event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        console.error('Webhook signature verification failed:', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Handle the event
    switch (event.type) {
        case 'checkout.session.completed':
            await handleSubscriptionCreated(event.data.object);
            break;
        case 'customer.subscription.created':
            await handleSubscriptionCreated(event.data.object);
            break;
        case 'customer.subscription.updated':
            await handleSubscriptionUpdated(event.data.object);
            break;
        case 'customer.subscription.deleted':
            await handleSubscriptionCancelled(event.data.object);
            break;
        case 'invoice.payment_succeeded':
            await handlePaymentSucceeded(event.data.object);
            break;
        case 'invoice.payment_failed':
            await handlePaymentFailed(event.data.object);
            break;
        default:
            console.log(`Unhandled event type ${event.type}`);
    }

    res.json({ received: true });
});

// Subscription Management
async function handleSubscriptionCreated(session) {
    try {
        const { plan, product, practiceName, specialty } = session.metadata;
        const customer = await stripe.customers.retrieve(session.customer);
        
        // Store in database
        const result = await pool.query(
            `INSERT INTO subscriptions 
             (customer_id, email, plan, product, status, practice_name, specialty, 
              stripe_subscription_id, created_at) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) 
             RETURNING id`,
            [session.customer, customer.email, plan, product, 'active', 
             practiceName, specialty, session.subscription, new Date()]
        );
        
        // Send to CRM (HubSpot)
        await sendToHubSpot({
            email: customer.email,
            firstname: customer.name?.split(' ')[0],
            lastname: customer.name?.split(' ').slice(1).join(' '),
            company: practiceName,
            specialty: specialty,
            plan: plan,
            product: product,
            lifecyclestage: 'customer'
        });
        
        // Send welcome email
        await sendWelcomeEmail(customer.email, customer.name, plan, product);
        
        console.log(`✅ New subscription created: ${customer.email} - ${product} ${plan}`);
        
    } catch (error) {
        console.error('Error handling subscription creation:', error);
    }
}

async function handleSubscriptionUpdated(subscription) {
    try {
        await pool.query(
            'UPDATE subscriptions SET status = $1, updated_at = $2 WHERE stripe_subscription_id = $3',
            [subscription.status, new Date(), subscription.id]
        );
        
        // Update CRM
        const customer = await stripe.customers.retrieve(subscription.customer);
        await updateHubSpotContact(customer.email, {
            subscription_status: subscription.status
        });
        
    } catch (error) {
        console.error('Error handling subscription update:', error);
    }
}

async function handleSubscriptionCancelled(subscription) {
    try {
        await pool.query(
            'UPDATE subscriptions SET status = $1, cancelled_at = $2 WHERE stripe_subscription_id = $3',
            ['cancelled', new Date(), subscription.id]
        );
        
        // Send cancellation survey
        const customer = await stripe.customers.retrieve(subscription.customer);
        await sendCancellationSurvey(customer.email);
        
        // Update CRM
        await updateHubSpotContact(customer.email, {
            subscription_status: 'cancelled',
            churn_date: new Date()
        });
        
    } catch (error) {
        console.error('Error handling subscription cancellation:', error);
    }
}

// HubSpot Integration
async function sendToHubSpot(contactData) {
    if (!process.env.HUBSPOT_API_KEY) {
        console.log('HubSpot API key not configured');
        return;
    }
    
    try {
        const response = await axios.post(
            `https://api.hubapi.com/crm/v3/objects/contacts`,
            {
                properties: {
                    email: contactData.email,
                    firstname: contactData.firstname,
                    lastname: contactData.lastname,
                    company: contactData.company,
                    specialty: contactData.specialty,
                    lifecyclestage: contactData.lifecyclestage
                }
            },
            {
                headers: {
                    'Authorization': `Bearer ${process.env.HUBSPOT_API_KEY}`,
                    'Content-Type': 'application/json'
                }
            }
        );
        
        console.log(`✅ Contact created in HubSpot: ${contactData.email}`);
        
    } catch (error) {
        if (error.response?.status === 409) {
            // Contact exists, update instead
            await updateHubSpotContact(contactData.email, contactData);
        } else {
            console.error('HubSpot integration error:', error.response?.data || error.message);
        }
    }
}

async function updateHubSpotContact(email, properties) {
    try {
        // Find contact by email
        const searchResponse = await axios.post(
            'https://api.hubapi.com/crm/v3/objects/contacts/search',
            {
                filterGroups: [{
                    filters: [{
                        propertyName: 'email',
                        operator: 'EQ',
                        value: email
                    }]
                }]
            },
            {
                headers: {
                    'Authorization': `Bearer ${process.env.HUBSPOT_API_KEY}`,
                    'Content-Type': 'application/json'
                }
            }
        );
        
        if (searchResponse.data.results.length > 0) {
            const contactId = searchResponse.data.results[0].id;
            
            // Update contact
            await axios.patch(
                `https://api.hubapi.com/crm/v3/objects/contacts/${contactId}`,
                { properties },
                {
                    headers: {
                        'Authorization': `Bearer ${process.env.HUBSPOT_API_KEY}`,
                        'Content-Type': 'application/json'
                    }
                }
            );
            
            console.log(`✅ Contact updated in HubSpot: ${email}`);
        }
        
    } catch (error) {
        console.error('HubSpot update error:', error.response?.data || error.message);
    }
}

// Email Integration (SendGrid)
async function sendWelcomeEmail(email, name, plan, product) {
    const planData = product === 'mbmb' ? mbmbPlans[plan] : lawhelperPlans[plan];
    
    const emailData = {
        to: email,
        from: 'welcome@mbmb.com',
        subject: `Welcome to ${product === 'mbmb' ? 'MBMB' : 'LawHelper'}!`,
        html: `
            <h1>Welcome ${name}!</h1>
            <p>Thank you for subscribing to the ${planData.name} plan.</p>
            <h3>Your plan includes:</h3>
            <ul>
                ${planData.features.map(feature => `<li>${feature}</li>`).join('')}
            </ul>
            <p>Get started by logging into your dashboard:</p>
            <a href="${process.env.FRONTEND_URL}/dashboard" 
               style="background: #667eea; color: white; padding: 10px 20px; text-decoration: none;">
                Access Dashboard
            </a>
            <p>Need help? Contact us at support@mbmb.com</p>
        `
    };
    
    // Here you would integrate with SendGrid
    console.log(`Welcome email queued for ${email}`);
}

// Analytics and Reporting
router.get('/analytics', async (req, res) => {
    try {
        const { days = 30 } = req.query;
        
        // Get subscription metrics
        const metrics = await pool.query(`
            SELECT 
                COUNT(*) as total_subscriptions,
                COUNT(CASE WHEN status = 'active' THEN 1 END) as active_subscriptions,
                COUNT(CASE WHEN product = 'mbmb' THEN 1 END) as mbmb_subscriptions,
                COUNT(CASE WHEN product = 'lawhelper' THEN 1 END) as lawhelper_subscriptions,
                SUM(CASE WHEN status = 'active' AND plan = 'professional' THEN 1 ELSE 0 END) as professional_subscriptions,
                SUM(CASE WHEN status = 'active' AND plan = 'starter' THEN 1 ELSE 0 END) as starter_subscriptions
            FROM subscriptions 
            WHERE created_at >= NOW() - INTERVAL '${days} days'
        `);
        
        // Get revenue metrics
        const revenue = await pool.query(`
            SELECT 
                product,
                plan,
                COUNT(*) as count,
                CASE 
                    WHEN plan = 'starter' AND product = 'mbmb' THEN 499
                    WHEN plan = 'professional' AND product = 'mbmb' THEN 999
                    WHEN plan = 'starter' AND product = 'lawhelper' THEN 99
                    WHEN plan = 'professional' AND product = 'lawhelper' THEN 299
                    ELSE 0
                END as monthly_revenue
            FROM subscriptions 
            WHERE status = 'active'
            GROUP BY product, plan
        `);
        
        const totalMRR = revenue.rows.reduce((sum, row) => sum + (row.monthly_revenue * row.count), 0);
        
        res.json({
            success: true,
            period: `${days} days`,
            metrics: metrics.rows[0],
            revenue: {
                breakdown: revenue.rows,
                total_mrr: totalMRR
            }
        });
        
    } catch (error) {
        console.error('Analytics error:', error);
        res.status(500).json({ error: 'Failed to retrieve analytics' });
    }
});

module.exports = router;
