require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const db = require('./database');
const { setupAuthRoutes, requireAuth, verifyToken } = require('./auth');
const { setupPaymentRoutes } = require('./payments');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

// Le webhook Stripe a besoin du body brut — AVANT express.json()
app.use('/api/payments/webhook', express.raw({ type: 'application/json' }));

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Monter les routes auth et paiement
setupAuthRoutes(app, db);
setupPaymentRoutes(app, db, requireAuth);

// ═══════════════════════════════════════════════════════
// MIDDLEWARE - Vérifier maintenance
// ═══════════════════════════════════════════════════════

function checkMaintenance(req, res, next) {
  if (db.isMaintenanceMode() && !req.path.startsWith('/admin')) {
    return res.json({
      status: 'maintenance',
      message: db.getSetting('maintenance_message')
    });
  }
  next();
}

// Middleware admin auth (simple password dans header)
function adminAuth(req, res, next) {
  const password = req.headers['x-admin-password'] || req.query.password;
  const adminPwd = db.getSetting('admin_password');
  if (password !== adminPwd) {
    return res.status(401).json({ error: 'Accès refusé' });
  }
  next();
}

// ═══════════════════════════════════════════════════════
// API PUBLIQUE (appelée par l'app Android)
// ═══════════════════════════════════════════════════════

// Enregistrer / identifier un appareil
app.post('/api/register', checkMaintenance, (req, res) => {
  const { device_id, email, phone, name } = req.body;
  if (!device_id) return res.status(400).json({ error: 'device_id requis' });

  const user = db.registerUser(device_id, email, phone, name);

  // Vérifier si le plan premium a expiré
  let plan = user.plan;
  if (plan === 'premium' && user.expires_at && new Date(user.expires_at) < new Date()) {
    db.setUserPlan(user.id, 'free', null);
    plan = 'free';
  }

  res.json({
    status: 'ok',
    user_id: user.id,
    plan: plan,
    banned: user.banned === 1,
    expires_at: user.expires_at
  });
});

// Vérifier la licence (appelé à chaque démarrage de l'app)
app.post('/api/verify', checkMaintenance, (req, res) => {
  const { device_id } = req.body;
  if (!device_id) return res.status(400).json({ error: 'device_id requis' });

  const user = db.getUser(device_id);
  if (!user) {
    return res.json({ status: 'unknown', message: 'Appareil non enregistré' });
  }

  if (user.banned) {
    return res.json({
      status: 'banned',
      message: user.ban_reason || 'Votre compte a été suspendu'
    });
  }

  // Vérifier expiration premium
  let plan = user.plan;
  if (plan === 'premium' && user.expires_at && new Date(user.expires_at) < new Date()) {
    db.setUserPlan(user.id, 'free', null);
    plan = 'free';
  }

  res.json({
    status: 'ok',
    plan: plan,
    expires_at: user.expires_at,
    min_version: db.getSetting('min_app_version'),
    analysis_month_limit: parseInt(db.getSetting('analysis_month_limit') || '6000')
  });
});

// Activer une clé de licence
app.post('/api/redeem', checkMaintenance, (req, res) => {
  const { device_id, key } = req.body;
  if (!device_id || !key) return res.status(400).json({ error: 'device_id et key requis' });

  const result = db.redeemLicenseKey(device_id, key);
  res.json(result);
});

// Calcul de score — accepte JWT Bearer OU device_id
app.post('/api/calculate', checkMaintenance, (req, res) => {
  const { prix, distance_km, duree_min, approche_min, approche_km, zone_distance_km } = req.body;

  // Essayer JWT d'abord
  let user = null;
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const decoded = verifyToken(authHeader.substring(7));
    if (decoded) user = db.getUserById(decoded.userId);
  }

  // Fallback device_id
  if (!user) {
    const { device_id } = req.body;
    if (!device_id) return res.status(400).json({ error: 'Authentification requise' });
    user = db.getUser(device_id);
    if (!user) return res.status(404).json({ error: 'Utilisateur non trouvé' });
  }

  if (user.banned) return res.status(403).json({ error: 'Compte suspendu' });

  // Vérifier premium
  let plan = user.plan;
  if (plan === 'premium' && user.expires_at && new Date(user.expires_at) < new Date()) {
    db.setUserPlan(user.id, 'free', null);
    plan = 'free';
  }
  if (plan !== 'premium') {
    return res.status(403).json({ error: 'Fonctionnalité premium requise', plan: 'free' });
  }

  // Vérifier limite globale mensuelle
  const monthlyCount = db.getMonthlyAnalysisCount();
  const monthlyLimit = parseInt(db.getSetting('analysis_month_limit') || '6000');
  if (monthlyCount >= monthlyLimit) {
    return res.status(429).json({ error: 'Limite mensuelle d\'analyses atteinte', status: 'limit_reached' });
  }

  // ═══════ CALCUL DU SCORE (côté serveur) ═══════
  // Paramètres de calcul (à terme configurable par admin)
  const COUT_KM = 0.12;         // €/km (carburant + entretien)
  const PENALTY_PER_MIN = 0.20; // €/min de pénalité approche
  const ZONE_COEF = 0.50;       // coefficient zone

  const totalH = duree_min / 60.0;
  const brutH = totalH > 0 ? prix / totalH : 0;

  // Coût total
  const coutTotal = distance_km * COUT_KM;
  const profit = prix - coutTotal;
  const rentabiliteH = totalH > 0 ? profit / totalH : 0;

  // Pénalité approche (convertie en €/h)
  const penaliteEuro = (approche_min || 0) * PENALTY_PER_MIN;
  const penaliteH = totalH > 0 ? penaliteEuro / totalH : 0;

  // Zone (convertie en €/h)
  const zoneEuro = (zone_distance_km || 0) * ZONE_COEF;
  const zoneH = totalH > 0 ? zoneEuro / totalH : 0;

  // Score final (tout en €/h)
  const score = rentabiliteH - penaliteH + zoneH;

  // Évaluation couleur
  let evaluation = 'mauvais';
  if (score >= 25) evaluation = 'bon';
  else if (score >= 15) evaluation = 'moyen';

  // Sauvegarder le calcul
  db.saveRideCalculation(user.id, {
    prix, distanceKm: distance_km, dureeMin: duree_min,
    approcheMin: approche_min, score, brutH, rentabiliteH
  });

  res.json({
    status: 'ok',
    score: Math.round(score * 10) / 10,
    brut_h: Math.round(brutH * 10) / 10,
    rentabilite_h: Math.round(rentabiliteH * 10) / 10,
    penalite_h: Math.round(penaliteH * 10) / 10,
    zone_h: Math.round(zoneH * 10) / 10,
    cout_total: Math.round(coutTotal * 100) / 100,
    profit: Math.round(profit * 100) / 100,
    evaluation: evaluation
  });
});

// Heartbeat — chauffeur en ligne
app.post('/api/heartbeat', (req, res) => {
  const { device_id } = req.body;
  if (!device_id) return res.status(400).json({ error: 'device_id requis' });
  if (db.isMaintenanceMode()) {
    return res.json({ status: 'maintenance', message: db.getSetting('maintenance_message') });
  }
  db.setHeartbeat(device_id);
  res.json({ status: 'ok' });
});

// Chauffeur hors ligne
app.post('/api/offline', (req, res) => {
  const { device_id } = req.body;
  if (!device_id) return res.status(400).json({ error: 'device_id requis' });
  db.setOffline(device_id);
  res.json({ status: 'ok' });
});

// Status de l'app (maintenance, version min)
app.get('/api/status', (req, res) => {
  res.json({
    maintenance: db.isMaintenanceMode(),
    maintenance_message: db.getSetting('maintenance_message'),
    min_version: db.getSetting('min_app_version'),
    latest_version: db.getSetting('latest_app_version')
  });
});

// ═══════════════════════════════════════════════════════
// API ADMIN (dashboard)
// ═══════════════════════════════════════════════════════

// Login admin
app.post('/admin/api/login', (req, res) => {
  const { password } = req.body;
  const adminPwd = db.getSetting('admin_password');
  if (password === adminPwd) {
    res.json({ status: 'ok' });
  } else {
    res.status(401).json({ error: 'Mot de passe incorrect' });
  }
});

// Stats globales
app.get('/admin/api/stats', adminAuth, (req, res) => {
  res.json(db.getGlobalStats());
});

// Liste des utilisateurs
app.get('/admin/api/users', adminAuth, (req, res) => {
  res.json(db.getAllUsers());
});

// Bannir un utilisateur
app.post('/admin/api/users/:id/ban', adminAuth, (req, res) => {
  db.banUser(req.params.id, req.body.reason);
  res.json({ status: 'ok' });
});

// Débannir
app.post('/admin/api/users/:id/unban', adminAuth, (req, res) => {
  db.unbanUser(req.params.id);
  res.json({ status: 'ok' });
});

// Supprimer un utilisateur
app.delete('/admin/api/users/:id', adminAuth, (req, res) => {
  db.deleteUser(req.params.id);
  res.json({ status: 'ok' });
});

// Changer le plan d'un utilisateur
app.post('/admin/api/users/:id/plan', adminAuth, (req, res) => {
  const { plan, duration_days } = req.body;
  db.setUserPlan(req.params.id, plan, duration_days);
  res.json({ status: 'ok' });
});

// Stats d'un utilisateur
app.get('/admin/api/users/:id/stats', adminAuth, (req, res) => {
  const user = db.getUserById(req.params.id);
  const rideStats = db.getUserRideStats(req.params.id);
  res.json({ user, rideStats });
});

// Générer des clés de licence
app.post('/admin/api/licenses/generate', adminAuth, (req, res) => {
  const { plan, duration_days, count } = req.body;
  const keys = db.generateLicenseKey(plan, duration_days, count);
  res.json({ keys });
});

// Lister les clés
app.get('/admin/api/licenses', adminAuth, (req, res) => {
  res.json(db.getAllLicenseKeys());
});

// Compteur en ligne (léger, pour auto-refresh)
app.get('/admin/api/online', adminAuth, (req, res) => {
  res.json({ onlineNow: db.getOnlineCount() });
});

// Limite globale analyses/mois
app.get('/admin/api/analysis-limit', adminAuth, (req, res) => {
  res.json({
    limit: parseInt(db.getSetting('analysis_month_limit') || '6000'),
    current: db.getMonthlyAnalysisCount()
  });
});

app.post('/admin/api/analysis-limit', adminAuth, (req, res) => {
  const { limit } = req.body;
  if (!limit || isNaN(limit) || limit < 1) return res.status(400).json({ error: 'Limite invalide' });
  db.setSetting('analysis_month_limit', String(limit));
  res.json({ status: 'ok', limit });
});

// Paramètres maintenance
app.post('/admin/api/maintenance', adminAuth, (req, res) => {
  const { enabled, message } = req.body;
  db.setSetting('maintenance', enabled ? 'true' : 'false');
  if (message) db.setSetting('maintenance_message', message);
  res.json({ status: 'ok', maintenance: enabled });
});

// Changer mot de passe admin
app.post('/admin/api/password', adminAuth, (req, res) => {
  const { new_password } = req.body;
  if (!new_password || new_password.length < 6) {
    return res.status(400).json({ error: 'Mot de passe trop court (min 6 caractères)' });
  }
  db.setSetting('admin_password', new_password);
  res.json({ status: 'ok' });
});

// Paramètres version
app.post('/admin/api/version', adminAuth, (req, res) => {
  const { min_version, latest_version } = req.body;
  if (min_version) db.setSetting('min_app_version', min_version);
  if (latest_version) db.setSetting('latest_app_version', latest_version);
  res.json({ status: 'ok' });
});

// ═══════════════════════════════════════════════════════
// DÉMARRAGE
// ═══════════════════════════════════════════════════════

app.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║       SmartRide AI - Serveur v1.0        ║');
  console.log('╠══════════════════════════════════════════╣');
  console.log(`║  API:    http://localhost:${PORT}/api       ║`);
  console.log(`║  Admin:  http://localhost:${PORT}/admin     ║`);
  console.log('╚══════════════════════════════════════════╝');
  console.log('');
  console.log(`Mot de passe admin: ${db.getSetting('admin_password')}`);
  console.log('');
});
