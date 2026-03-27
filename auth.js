const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const nodemailer = require('nodemailer');

const JWT_SECRET = process.env.JWT_SECRET || 'smartride_secret';
const APP_URL = process.env.APP_URL || 'http://localhost:3000';

// ═══════════════════════════════════════
// EMAIL (OVH SMTP)
// ═══════════════════════════════════════

function createTransporter() {
  return nodemailer.createTransport({
    host: 'ssl0.ovh.net',
    port: 465,
    secure: true,
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS
    }
  });
}

async function sendVerificationEmail(email, token, name) {
  const link = `${APP_URL}/api/auth/verify-email?token=${token}`;
  if (!process.env.EMAIL_USER || process.env.EMAIL_USER.includes('REMPLACER')) {
    console.log(`[EMAIL SIMULÉ] Vérification pour ${email}: ${link}`);
    return false;
  }
  try {
    const transporter = createTransporter();
    await transporter.sendMail({
      from: `SmartRide AI <${process.env.EMAIL_USER}>`,
      to: email,
      subject: 'Activez votre compte SmartRide AI',
      html: `
        <div style="font-family:sans-serif;max-width:500px;margin:0 auto;background:#0f1923;color:#e0e0e0;padding:32px;border-radius:12px">
          <h1 style="color:#00e676;margin-bottom:8px">SmartRide AI</h1>
          <p>Bonjour ${name || ''},</p>
          <p>Cliquez sur le bouton ci-dessous pour activer votre compte :</p>
          <a href="${link}"
             style="display:inline-block;background:#00e676;color:#000;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:bold;margin:16px 0">
            Activer mon compte
          </a>
          <p style="color:#546e7a;font-size:12px">Ce lien expire dans 24 heures.</p>
        </div>
      `
    });
    console.log(`[EMAIL] Vérification envoyée à ${email}`);
    return true;
  } catch (e) {
    console.error(`[EMAIL ERREUR]`, e.message);
    return false;
  }
}

async function sendWelcomeEmail(email, name) {
  if (!process.env.EMAIL_USER || process.env.EMAIL_USER.includes('REMPLACER')) return;
  try {
    const transporter = createTransporter();
    await transporter.sendMail({
      from: `SmartRide AI <${process.env.EMAIL_USER}>`,
      to: email,
      subject: 'Bienvenue sur SmartRide AI !',
      html: `
        <div style="font-family:sans-serif;max-width:500px;margin:0 auto;background:#0f1923;color:#e0e0e0;padding:32px;border-radius:12px">
          <h1 style="color:#00e676">Bienvenue ${name || ''} !</h1>
          <p>Votre compte SmartRide AI est activé.</p>
          <p>Téléchargez l'app et connectez-vous pour commencer à analyser vos courses.</p>
          <p style="color:#546e7a;font-size:12px">L'équipe SmartRide AI</p>
        </div>
      `
    });
  } catch (_) {}
}

// ═══════════════════════════════════════
// JWT
// ═══════════════════════════════════════

function generateToken(userId) {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: '30d' });
}

function verifyToken(token) {
  try { return jwt.verify(token, JWT_SECRET); }
  catch (_) { return null; }
}

function requireAuth(req, res, next) {
  const token = req.headers['authorization']?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Token requis' });
  const decoded = verifyToken(token);
  if (!decoded) return res.status(401).json({ error: 'Token invalide ou expiré' });
  req.userId = decoded.userId;
  next();
}

// ═══════════════════════════════════════
// ROUTES AUTH
// ═══════════════════════════════════════

function setupAuthRoutes(app, db) {

  // ── INSCRIPTION ──
  app.post('/api/auth/register', async (req, res) => {
    try {
      const { email, password, name, phone } = req.body;
      if (!email || !password) return res.status(400).json({ error: 'Email et mot de passe requis' });
      if (!phone) return res.status(400).json({ error: 'Numéro de téléphone requis' });
      if (password.length < 6) return res.status(400).json({ error: 'Mot de passe trop court (min 6 caractères)' });

      const existing = db.getUserByEmail(email.toLowerCase().trim());
      if (existing) return res.status(409).json({ error: 'Email déjà utilisé' });

      const passwordHash = await bcrypt.hash(password, 10);
      const emailToken = crypto.randomBytes(32).toString('hex');
      const user = db.createAccount(email.toLowerCase().trim(), passwordHash, name || '', phone, emailToken);

      // Envoyer email de vérification
      const emailSent = await sendVerificationEmail(email, emailToken, name);

      if (emailSent) {
        // Email envoyé → l'utilisateur doit vérifier
        res.json({
          status: 'ok',
          message: 'Compte créé ! Vérifiez votre email pour activer votre compte.',
          needsVerification: true
        });
      } else {
        // Email non configuré → activer directement
        db.verifyEmailToken(emailToken);
        const token = generateToken(user.id);
        res.json({
          status: 'ok',
          message: 'Compte créé avec succès.',
          token,
          user: { id: user.id, email: user.email, name: user.name, phone: user.phone, plan: 'free' }
        });
      }
    } catch (e) {
      console.error('[REGISTER]', e.message);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  // ── VÉRIFICATION EMAIL ──
  app.get('/api/auth/verify-email', (req, res) => {
    const { token } = req.query;
    const user = db.verifyEmailToken(token);
    if (!user) return res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#0a0c10;color:#fff">
        <h2 style="color:#f44336">Lien invalide ou expiré</h2>
        <p>Réessayez de vous inscrire.</p>
      </body></html>
    `);
    sendWelcomeEmail(user.email, user.name).catch(() => {});
    res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#0a0c10;color:#fff">
        <h2 style="color:#00e676">✅ Compte activé !</h2>
        <p>Vous pouvez maintenant vous connecter dans l'application SmartRide AI.</p>
        <a href="https://smartride-ai.com" style="color:#00e676">Retour au site</a>
      </body></html>
    `);
  });

  // ── CONNEXION ──
  app.post('/api/auth/login', async (req, res) => {
    try {
      const { email, password, device_id } = req.body;
      if (!email || !password) return res.status(400).json({ error: 'Email et mot de passe requis' });

      const user = db.getUserByEmail(email.toLowerCase().trim());
      if (!user) return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
      if (user.banned) return res.status(403).json({ error: 'Compte suspendu', reason: user.ban_reason });

      // Vérifier email confirmé (si email configuré)
      if (process.env.EMAIL_USER && !process.env.EMAIL_USER.includes('REMPLACER') && !user.email_verified) {
        return res.status(403).json({ error: 'Veuillez d\'abord vérifier votre email. Consultez votre boîte de réception.' });
      }

      const valid = await bcrypt.compare(password, user.password_hash);
      if (!valid) return res.status(401).json({ error: 'Email ou mot de passe incorrect' });

      // Device lock
      if (device_id) {
        const lock = db.checkDeviceLock(user.id, device_id);
        if (!lock.allowed) return res.status(403).json({ error: lock.reason });
      }

      db.updateLastSeen(user.id);
      const token = generateToken(user.id);
      const access = db.checkAccess(user);

      res.json({
        status: 'ok',
        token,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          phone: user.phone,
          plan: db.getEffectivePlan(user),
          expires_at: user.expires_at || ''
        },
        access
      });
    } catch (e) {
      console.error('[LOGIN]', e.message);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  // ── CONNEXION GOOGLE ──
  app.post('/api/auth/google', async (req, res) => {
    try {
      const { email, name, google_id, device_id } = req.body;
      if (!email || !google_id) return res.status(400).json({ error: 'Données Google manquantes' });

      let user = db.getUserByEmail(email.toLowerCase().trim());
      if (!user) {
        user = db.createGoogleAccount(email.toLowerCase().trim(), name || '', google_id);
      } else if (!user.google_id) {
        db.linkGoogleId(user.id, google_id);
      }

      if (user.banned) return res.status(403).json({ error: 'Compte suspendu', reason: user.ban_reason });

      // Device lock
      if (device_id) {
        const lock = db.checkDeviceLock(user.id, device_id);
        if (!lock.allowed) return res.status(403).json({ error: lock.reason });
      }

      db.updateLastSeen(user.id);
      const token = generateToken(user.id);
      const access = db.checkAccess(user);

      res.json({
        status: 'ok',
        token,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          phone: user.phone || '',
          plan: db.getEffectivePlan(user),
          expires_at: user.expires_at || ''
        },
        access
      });
    } catch (e) {
      console.error('[GOOGLE]', e.message);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  // ── MOI (profil) ──
  app.get('/api/auth/me', requireAuth, (req, res) => {
    const user = db.getUserById(req.userId);
    if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });
    if (user.banned) return res.status(403).json({ error: 'Compte suspendu', status: 'banned' });

    const access = db.checkAccess(user);

    res.json({
      status: 'ok',
      email: user.email,
      name: user.name,
      phone: user.phone || '',
      plan: db.getEffectivePlan(user),
      expires_at: user.expires_at || '',
      access,
      free_access: db.getSetting('free_access') === 'true',
      payment_enabled: db.getSetting('payment_enabled') === 'true',
      analysis_month_limit: parseInt(db.getSetting('analysis_month_limit') || '6000')
    });
  });

  // ── MOT DE PASSE OUBLIÉ ──
  app.post('/api/auth/forgot-password', async (req, res) => {
    const { email } = req.body;
    const user = db.getUserByEmail(email);
    if (!user) return res.json({ status: 'ok' });

    const resetToken = crypto.randomBytes(32).toString('hex');
    db.setResetToken(user.id, resetToken);

    if (process.env.EMAIL_USER && !process.env.EMAIL_USER.includes('REMPLACER')) {
      try {
        const transporter = createTransporter();
        await transporter.sendMail({
          from: `SmartRide AI <${process.env.EMAIL_USER}>`,
          to: email,
          subject: 'Réinitialisation de mot de passe - SmartRide AI',
          html: `
            <div style="font-family:sans-serif;max-width:500px;margin:0 auto;background:#0f1923;color:#e0e0e0;padding:32px;border-radius:12px">
              <h1 style="color:#00e676">SmartRide AI</h1>
              <p>Vous avez demandé une réinitialisation de mot de passe.</p>
              <a href="${APP_URL}/reset-password.html?token=${resetToken}"
                 style="display:inline-block;background:#00e676;color:#000;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:bold;margin:16px 0">
                Réinitialiser mon mot de passe
              </a>
              <p style="color:#546e7a;font-size:12px">Ce lien expire dans 1 heure.</p>
            </div>
          `
        });
      } catch (e) {
        console.error('[RESET EMAIL]', e.message);
      }
    } else {
      console.log(`[RESET] Token pour ${email}: ${resetToken}`);
    }
    res.json({ status: 'ok', message: 'Si cet email existe, un lien a été envoyé' });
  });

  // ── RESET MOT DE PASSE ──
  app.post('/api/auth/reset-password', async (req, res) => {
    try {
      const { token, password } = req.body;
      if (!token || !password) return res.status(400).json({ error: 'Token et mot de passe requis' });
      if (password.length < 6) return res.status(400).json({ error: 'Mot de passe trop court (min 6)' });

      const user = db.getUserByResetToken(token);
      if (!user) return res.status(400).json({ error: 'Lien invalide ou expiré' });

      const passwordHash = await bcrypt.hash(password, 10);
      db.resetPassword(user.id, passwordHash);
      res.json({ status: 'ok', message: 'Mot de passe mis à jour' });
    } catch (e) {
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  // ── CONTACT ──
  app.post('/api/contact', requireAuth, (req, res) => {
    const { subject, message } = req.body;
    if (!message || message.trim().length < 5) return res.status(400).json({ error: 'Message trop court' });

    const user = db.getUserById(req.userId);
    if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });

    db.createMessage(user.id, user.email, subject || '', message.trim());
    res.json({ status: 'ok', message: 'Message envoyé' });
  });

  // ── MES MESSAGES (avec réponses admin) ──
  app.get('/api/messages', requireAuth, (req, res) => {
    const msgs = db.getUserMessages(req.userId);
    res.json(msgs);
  });

  // ── BROADCASTS (messages admin pour tous) ──
  app.get('/api/broadcasts', requireAuth, (req, res) => {
    const since = req.query.since || null;
    const broadcasts = db.getRecentBroadcasts(since);
    res.json(broadcasts);
  });
}

module.exports = { setupAuthRoutes, requireAuth, generateToken, verifyToken };
