const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// ═══════════════════════════════════════
// STRIPE PAYMENTS
// ═══════════════════════════════════════

function setupPaymentRoutes(app, db, requireAuth) {
  const APP_URL = process.env.APP_URL || 'http://localhost:3000';

  // Créer une session de paiement Stripe Checkout
  app.post('/api/payments/checkout', requireAuth, async (req, res) => {
    try {
      const { priceId } = req.body;
      const user = db.getUserById(req.userId);
      if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });

      // Récupérer ou créer le customer Stripe
      let customerId = user.stripe_customer_id;
      if (!customerId) {
        const customer = await stripe.customers.create({
          email: user.email,
          name: user.name || undefined,
          metadata: { userId: user.id }
        });
        customerId = customer.id;
        db.setStripeCustomer(user.id, customerId);
      }

      // Utiliser le priceId fourni ou les prix depuis .env
      const finalPriceId = priceId
        || (req.body.interval === 'year' ? process.env.STRIPE_PRICE_YEARLY : process.env.STRIPE_PRICE_MONTHLY);

      if (!finalPriceId || finalPriceId.includes('REMPLACER')) {
        return res.status(400).json({ error: 'Prix Stripe non configuré. Créez les prix dans le dashboard Stripe.' });
      }

      const session = await stripe.checkout.sessions.create({
        customer: customerId,
        mode: 'subscription',
        payment_method_types: ['card'],
        line_items: [{ price: finalPriceId, quantity: 1 }],
        success_url: `${APP_URL}/payment-success.html?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${APP_URL}/payment-cancel.html`,
        metadata: { userId: user.id }
      });

      res.json({ url: session.url, sessionId: session.id });
    } catch (e) {
      console.error('[Stripe]', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // Webhook Stripe (reçoit les événements de paiement)
  // Note: le body brut est déjà appliqué dans server.js avant express.json()
  app.post('/api/payments/webhook', async (req, res) => {
      const sig = req.headers['stripe-signature'];
      const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

      let event;
      try {
        event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
      } catch (e) {
        console.error('[Webhook] Signature invalide:', e.message);
        return res.status(400).send(`Webhook Error: ${e.message}`);
      }

      try {
        await handleStripeEvent(event, db);
        res.json({ received: true });
      } catch (e) {
        console.error('[Webhook] Erreur traitement:', e.message);
        res.status(500).json({ error: e.message });
      }
    }
  );

  // Portail client Stripe (gérer abonnement, annuler, changer carte)
  app.post('/api/payments/portal', requireAuth, async (req, res) => {
    try {
      const user = db.getUserById(req.userId);
      if (!user || !user.stripe_customer_id) {
        return res.status(400).json({ error: 'Aucun abonnement actif' });
      }

      const session = await stripe.billingPortal.sessions.create({
        customer: user.stripe_customer_id,
        return_url: `${APP_URL}/`
      });

      res.json({ url: session.url });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Statut abonnement
  app.get('/api/payments/status', requireAuth, (req, res) => {
    const user = db.getUserById(req.userId);
    if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });

    let plan = user.plan;
    if (plan === 'premium' && user.expires_at && new Date(user.expires_at) < new Date()) {
      plan = 'free';
    }

    res.json({
      plan,
      expires_at: user.expires_at,
      has_subscription: !!user.stripe_subscription_id
    });
  });
}

// ═══════════════════════════════════════
// GESTION DES ÉVÉNEMENTS STRIPE
// ═══════════════════════════════════════

async function handleStripeEvent(event, db) {
  console.log(`[Stripe] Event reçu: ${event.type}`);

  switch (event.type) {

    case 'checkout.session.completed': {
      const session = event.data.object;
      const userId = session.metadata?.userId;
      if (!userId) { console.log('[Stripe] Pas de userId dans metadata'); break; }

      if (session.mode === 'subscription' && session.subscription) {
        const sub = await stripe.subscriptions.retrieve(session.subscription);
        const expiresAt = new Date(sub.current_period_end * 1000).toISOString();
        db.setStripeSubscription(userId, sub.id, 'premium', expiresAt);
        console.log(`[Stripe] ✅ Premium activé user=${userId} jusqu'au ${expiresAt}`);
      } else if (session.mode === 'payment') {
        // Lifetime
        db.setStripeSubscription(userId, null, 'premium', null);
        console.log(`[Stripe] ✅ Premium lifetime activé user=${userId}`);
      }
      break;
    }

    // Ancienne API
    case 'invoice.paid':
    // Nouvelle API Stripe 2026
    case 'invoice.payment_paid':
    case 'invoice_payment.paid': {
      const invoice = event.data.object;
      const customerId = invoice.customer;
      const user = db.getUserByStripeCustomer(customerId);
      if (user) {
        let expiresAt = null;
        if (invoice.subscription) {
          try {
            const sub = await stripe.subscriptions.retrieve(invoice.subscription);
            expiresAt = new Date(sub.current_period_end * 1000).toISOString();
          } catch(e) {}
        }
        if (!expiresAt) expiresAt = new Date(Date.now() + 32*24*60*60*1000).toISOString();
        db.setStripeSubscription(user.id, invoice.subscription || null, 'premium', expiresAt);
        console.log(`[Stripe] ✅ Facture payée — user=${user.id} jusqu'au ${expiresAt}`);
      }
      break;
    }

    case 'customer.subscription.deleted':
    case 'invoice.payment_failed': {
      const obj = event.data.object;
      const customerId = obj.customer;
      const user = db.getUserByStripeCustomer(customerId);
      if (user) {
        db.setStripeSubscription(user.id, null, 'free', null);
        console.log(`[Stripe] ❌ Abonnement annulé pour user=${user.id}`);
      }
      break;
    }

    default:
      console.log(`[Stripe] Événement ignoré: ${event.type}`);
      break;
  }
}

module.exports = { setupPaymentRoutes };
