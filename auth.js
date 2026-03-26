const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const nodemailer = require('nodemailer');

const JWT_SECRET = process.env.JWT_SECRET || 'smartride_secret';
const APP_URL = process.env.APP_URL || 'http://localhost:3000';

// ═══════════════════════════════════════
// EMAIL
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
  if (!process.env.EMAIL_USER) {
    console.log(`[EMAIL SIMULÉ] Vérification pour ${email}: ${APP_URL}/api/auth/verify-email?token=${token}`);
    return;
  }
  const transporter = createTransporter();
  await transporter.sendMail({
    from: `SmartRide AI <${process.env.EMAIL_USER}>`,
    to: email,
    subject: 'Activez votre compte SmartRide AI',
    html: `
      <div style="font-family:sans-serif;max-width:500px;margin:0 auto;background:#0f1923;color:#e0e0e0;padding:32px;border-radius:12px">
        <h1 style="color:#4CAF50;margin-bottom:8px">SmartRide AI</h1>
        <p>Bonjour ${name || ''},</p>
        <p>Cliquez sur le bouton ci-dessous pour activer votre compte :</p>
        <a href="${APP_URL}/api/auth/verify-email?token=${token}"
           style="display:inline-block;background:#4CAF50;color:#000;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:bold;margin:16px 0">
          Activer mon compte
        </a>
        <p style="color:#546e7a;font-size:12px">Ce lien expire dans 24 heures.</p>
      </div>
    `
  });
}

async function sendWelcomeEmail(email, name) {
  if (!process.env.EMAIL_USER) return;
  const transporter = createTransporter();
  await transporter.sendMail({
    from: `SmartRide AI <${process.env.EMAIL_USER}>`,
    to: email,
    subject: 'Bienvenue sur SmartRide AI !',
    html: `
      <div style="font-family:sans-serif;max-width:500px;margin:0 auto;background:#0f1923;color:#e0e0e0;padding:32px;border-radius:12px">
        <h1 style="color:#4CAF50">Bienvenue ${name || ''} !</h1>
        <p>Votre compte SmartRide AI est activé.</p>
        <p>Téléchargez l'app et connectez-vous avec votre email et mot de passe.</p>
        <p style="color:#546e7a;font-size:12px">L'équipe SmartRide AI</p>
      </div>
    `
  });
}

// ═══════════════════════════════════════
// JWT
// ═══════════════════════════════════════

function generateToken(userId) {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: '30d' });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (_) {
    return null;
  }
}

// Middleware auth
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

  // INSCRIPTION EMAIL
  app.post('/api/auth/register', async (req, res) => {
    try {
      const { email, password, name } = req.body;
      if (!email || !password) return res.status(400).json({ error: 'Email et mot de passe requis' });
      if (password.length < 6) return res.status(400).json({ error: 'Mot de passe trop court (min 6)' });

      const existing = db.getUserByEmail(email);
      if (existing) return res.status(409).json({ error: 'Email déjà utilisé' });

      const passwordHash = await bcrypt.hash(password, 10);
      const user = db.createAccount(email, passwordHash, name || '', null);
      // Activer le compte immédiatement (pas de vérification email requise)
      db.activateAccount(user.id);

      const token = generateToken(user.id);
      res.json({
        status: 'ok',
        token,
        message: 'Compte créé avec succès',
        user: { id: user.id, email: user.email, name: user.name || '', plan: 'free', expires_at: null }
      });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  // VÉRIFICATION EMAIL
  app.get('/api/auth/verify-email', (req, res) => {
    const { token } = req.query;
    const user = db.verifyEmailToken(token);
    if (!user) return res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#0f1923;color:#fff">
        <h2 style="color:#ef5350">Lien invalide ou expiré</h2>
        <p>Réessayez de vous inscrire.</p>
      </body></html>
    `);
    sendWelcomeEmail(user.email, user.name).catch(() => {});
    res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#0f1923;color:#fff">
        <h2 style="color:#4CAF50">✅ Compte activé !</h2>
        <p>Vous pouvez maintenant vous connecter dans l'application SmartRide AI.</p>
      </body></html>
    `);
  });

  // CONNEXION EMAIL
  app.post('/api/auth/login', async (req, res) => {
    try {
      const { email, password } = req.body;
      if (!email || !password) return res.status(400).json({ error: 'Email et mot de passe requis' });

      const user = db.getUserByEmail(email);
      if (!user) return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
      if (!user.email_verified) return res.status(403).json({ error: 'Vérifiez votre email avant de vous connecter' });
      if (user.banned) return res.status(403).json({ error: 'Compte suspendu' });

      const valid = await bcrypt.compare(password, user.password_hash);
      if (!valid) return res.status(401).json({ error: 'Email ou mot de passe incorrect' });

      db.updateLastSeen(user.id);
      const token = generateToken(user.id);

      res.json({
        status: 'ok',
        token,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          plan: user.plan,
          expires_at: user.expires_at
        }
      });
    } catch (e) {
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  // CONNEXION GOOGLE
  app.post('/api/auth/google', async (req, res) => {
    try {
      const { google_token, email, name, google_id } = req.body;
      if (!email || !google_id) return res.status(400).json({ error: 'Données Google manquantes' });

      let user = db.getUserByEmail(email);
      if (!user) {
        user = db.createGoogleAccount(email, name || '', google_id);
      } else if (!user.google_id) {
        db.linkGoogleId(user.id, google_id);
      }

      if (user.banned) return res.status(403).json({ error: 'Compte suspendu' });

      db.updateLastSeen(user.id);
      const token = generateToken(user.id);

      res.json({
        status: 'ok',
        token,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          plan: user.plan,
          expires_at: user.expires_at
        }
      });
    } catch (e) {
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  // MOI (vérifie le token et retourne le profil)
  app.get('/api/auth/me', requireAuth, (req, res) => {
    const user = db.getUserById(req.userId);
    if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });
    if (user.banned) return res.status(403).json({ error: 'Compte suspendu', status: 'banned' });

    let plan = user.plan;
    if (plan === 'premium' && user.expires_at && new Date(user.expires_at) < new Date()) {
      plan = 'free';
    }

    res.json({
      status: 'ok',
      plan,
      expires_at: user.expires_at,
      email: user.email,
      name: user.name,
      analysis_month_limit: parseInt(db.getSetting('analysis_month_limit') || '6000')
    });
  });

  // MOT DE PASSE OUBLIÉ
  app.post('/api/auth/forgot-password', async (req, res) => {
    const { email } = req.body;
    const user = db.getUserByEmail(email);
    if (!user) return res.json({ status: 'ok' }); // Ne pas révéler si l'email existe

    const resetToken = crypto.randomBytes(32).toString('hex');
    db.setResetToken(user.id, resetToken);

    if (process.env.EMAIL_USER) {
      const transporter = createTransporter();
      await transporter.sendMail({
        from: `SmartRide AI <${process.env.EMAIL_USER}>`,
        to: email,
        subject: 'Réinitialisation de mot de passe',
        html: `<p>Lien de réinitialisation : <a href="${APP_URL}/reset-password?token=${resetToken}">${APP_URL}/reset-password?token=${resetToken}</a></p><p>Expire dans 1 heure.</p>`
      });
    } else {
      console.log(`[RESET] Token pour ${email}: ${resetToken}`);
    }
    res.json({ status: 'ok', message: 'Si cet email existe, un lien a été envoyé' });
  });

  // RESET MOT DE PASSE
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
}

module.exports = { setupAuthRoutes, requireAuth, generateToken, verifyToken };
