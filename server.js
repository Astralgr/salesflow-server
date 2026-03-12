const express = require('express');
const cors = require('cors');

// ── Railway sets PORT automatically — MUST use process.env.PORT ─────────
const PORT = process.env.PORT || 3001;

const app = express();

// ── CORS — allow your frontend to call this server ─────────────────────
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
}));

app.use(express.json());

// ── Initialize Stripe safely (won't crash if key is missing) ───────────
let stripe = null;
const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY || '';

if (STRIPE_SECRET && STRIPE_SECRET.startsWith('sk_')) {
  try {
    stripe = require('stripe')(STRIPE_SECRET);
    console.log('✅ Stripe initialized successfully');
  } catch (err) {
    console.error('❌ Stripe init error:', err.message);
  }
} else {
  console.warn('⚠️  STRIPE_SECRET_KEY not set or invalid');
}

// ── Price IDs from environment variables ────────────────────────────────
const PRICES = {
  starter: {
    monthly: process.env.PRICE_STARTER_MONTHLY || '',
    annual:  process.env.PRICE_STARTER_ANNUAL  || '',
  },
  pro: {
    monthly: process.env.PRICE_PRO_MONTHLY || '',
    annual:  process.env.PRICE_PRO_ANNUAL  || '',
  },
  unlimited: {
    monthly: process.env.PRICE_UNLIMITED_MONTHLY || '',
    annual:  process.env.PRICE_UNLIMITED_ANNUAL  || '',
  },
};

const FRONTEND_URL = process.env.FRONTEND_URL || 'https://your-frontend.com';

// ═══════════════════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════════════════

// ── Health check (Railway pings this to know server is alive) ───────────
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    message: 'Salesflow payment server is running',
    time: new Date().toISOString(),
    stripe: stripe ? 'connected' : 'not configured',
    prices: {
      starter:   { monthly: !!PRICES.starter.monthly,   annual: !!PRICES.starter.annual },
      pro:       { monthly: !!PRICES.pro.monthly,       annual: !!PRICES.pro.annual },
      unlimited: { monthly: !!PRICES.unlimited.monthly,  annual: !!PRICES.unlimited.annual },
    }
  });
});

// ── Create Checkout Session ─────────────────────────────────────────────
app.post('/create-checkout-session', async (req, res) => {
  console.log('POST /create-checkout-session', req.body);

  if (!stripe) {
    console.error('Stripe not initialized');
    return res.status(500).json({
      error: 'Payment system not configured. Set STRIPE_SECRET_KEY in Railway variables.'
    });
  }

  try {
    const { plan, billing, userId, userEmail } = req.body;

    // Validate
    if (!plan || !userId || !userEmail) {
      return res.status(400).json({
        error: 'Missing required fields: plan, userId, userEmail'
      });
    }

    // Look up price
    const billingPeriod = billing || 'monthly';
    const priceId = PRICES[plan]?.[billingPeriod];

    if (!priceId) {
      console.error('No price for:', plan, billingPeriod);
      console.error('Available prices:', JSON.stringify(PRICES));
      return res.status(400).json({
        error: `No price configured for plan="${plan}" billing="${billingPeriod}". Add PRICE_${plan.toUpperCase()}_${billingPeriod.toUpperCase()} to Railway variables.`
      });
    }

    // Create session
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      customer_email: userEmail,
      line_items: [{ price: priceId, quantity: 1 }],
      metadata: { userId, userEmail, plan },
      success_url: `${FRONTEND_URL}/index.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${FRONTEND_URL}/index.html`,
    });

    console.log('✅ Checkout session created:', session.id);
    res.json({ url: session.url });

  } catch (err) {
    console.error('❌ Checkout error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Verify Session ──────────────────────────────────────────────────────
app.get('/verify-session', async (req, res) => {
  if (!stripe) {
    return res.status(500).json({ error: 'Stripe not configured' });
  }

  try {
    const { session_id } = req.query;
    if (!session_id) {
      return res.status(400).json({ error: 'Missing session_id parameter' });
    }

    const session = await stripe.checkout.sessions.retrieve(session_id);

    if (session.payment_status === 'paid') {
      const plan = session.metadata?.plan || 'starter';
      
      // Get subscription details for period end date
      let periodEnd = null;
      let billing = 'monthly';
      
      if (session.subscription) {
        const subscription = await stripe.subscriptions.retrieve(session.subscription);
        periodEnd = new Date(subscription.current_period_end * 1000).toISOString();
        
        // Detect billing period from interval
        const interval = subscription.items?.data?.[0]?.price?.recurring?.interval;
        billing = interval === 'year' ? 'annual' : 'monthly';
      }
      
      console.log('✅ Payment verified, plan:', plan, 'period ends:', periodEnd);
      
      res.json({ 
        plan, 
        status: 'active',
        billing: billing,
        stripeCustomerId: session.customer,
        stripeSubscriptionId: session.subscription,
        periodEnd: periodEnd
      });
    } else {
      res.json({ plan: null, status: session.payment_status });
    }

  } catch (err) {
    console.error('❌ Verify error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Cancel Subscription ─────────────────────────────────────────────────
app.post('/cancel-subscription', async (req, res) => {
  if (!stripe) {
    return res.status(500).json({ error: 'Stripe not configured' });
  }

  try {
    const { stripeSubscriptionId, userId } = req.body;

    if (!stripeSubscriptionId) {
      return res.status(400).json({ error: 'Missing stripeSubscriptionId' });
    }

    console.log('Cancelling subscription:', stripeSubscriptionId, 'for user:', userId);

    // Cancel at period end (user keeps access until billing period ends)
    // Change to stripe.subscriptions.cancel() for immediate cancellation
    const subscription = await stripe.subscriptions.update(stripeSubscriptionId, {
      cancel_at_period_end: true
    });

    console.log('✅ Subscription cancelled:', subscription.id);
    console.log('   Cancels at:', new Date(subscription.current_period_end * 1000).toISOString());

    res.json({ 
      success: true, 
      message: 'Subscription will cancel at end of billing period',
      cancelAt: new Date(subscription.current_period_end * 1000).toISOString()
    });

  } catch (err) {
    console.error('❌ Cancel error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Cancel Subscription (at end of billing period) ──────────────────────
app.post('/cancel-subscription', async (req, res) => {
  if (!stripe) {
    return res.status(500).json({ error: 'Stripe not configured' });
  }

  try {
    const { stripeSubscriptionId, userId } = req.body;

    if (!stripeSubscriptionId) {
      return res.status(400).json({ error: 'Missing stripeSubscriptionId' });
    }

    console.log('Cancelling subscription at period end:', stripeSubscriptionId);

    // Cancel at period end — user keeps access until billing period ends
    const subscription = await stripe.subscriptions.update(stripeSubscriptionId, {
      cancel_at_period_end: true
    });

    const periodEnd = new Date(subscription.current_period_end * 1000).toISOString();

    console.log('✅ Subscription set to cancel at:', periodEnd);

    res.json({ 
      success: true, 
      cancelAt: periodEnd,
      plan: subscription.metadata?.plan || 'starter'
    });

  } catch (err) {
    console.error('❌ Cancel error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Reactivate Subscription (undo cancellation) ─────────────────────────
app.post('/reactivate-subscription', async (req, res) => {
  if (!stripe) {
    return res.status(500).json({ error: 'Stripe not configured' });
  }

  try {
    const { stripeSubscriptionId } = req.body;

    if (!stripeSubscriptionId) {
      return res.status(400).json({ error: 'Missing stripeSubscriptionId' });
    }

    console.log('Reactivating subscription:', stripeSubscriptionId);

    // Remove the cancel_at_period_end flag
    const subscription = await stripe.subscriptions.update(stripeSubscriptionId, {
      cancel_at_period_end: false
    });

    console.log('✅ Subscription reactivated:', subscription.id);

    res.json({ 
      success: true, 
      message: 'Subscription reactivated'
    });

  } catch (err) {
    console.error('❌ Reactivate error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Customer Portal (manage/cancel subscription) ────────────────────────
app.post('/create-portal-session', async (req, res) => {
  if (!stripe) {
    return res.status(500).json({ error: 'Stripe not configured' });
  }

  try {
    const { stripeCustomerId } = req.body;
    if (!stripeCustomerId) {
      return res.status(400).json({ error: 'Missing stripeCustomerId' });
    }

    const portal = await stripe.billingPortal.sessions.create({
      customer: stripeCustomerId,
      return_url: `${FRONTEND_URL}/index.html`,
    });

    res.json({ url: portal.url });

  } catch (err) {
    console.error('❌ Portal error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Handle OPTIONS preflight for CORS ───────────────────────────────────
app.options('*', cors());

// ── Catch-all for unknown routes ────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Not found', path: req.path });
});

// ═══════════════════════════════════════════════════════════════════════
// START SERVER — MUST bind to 0.0.0.0 for Railway
// ═══════════════════════════════════════════════════════════════════════
app.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('╔══════════════════════════════════════╗');
  console.log('║  ✅ Payment Server Running            ║');
  console.log(`║  Port: ${PORT}                          ║`);
  console.log('╚══════════════════════════════════════╝');
  console.log('');
  console.log('Config:');
  console.log('  Stripe:', stripe ? '✅ Connected' : '❌ Not set');
  console.log('  Frontend:', FRONTEND_URL);
  console.log('  Prices:');
  Object.entries(PRICES).forEach(([plan, periods]) => {
    Object.entries(periods).forEach(([period, id]) => {
      console.log(`    ${plan}/${period}: ${id ? '✅ ' + id.substring(0, 20) + '...' : '❌ Missing'}`);
    });
  });
  console.log('');
});
