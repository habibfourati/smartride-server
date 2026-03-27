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
  const password = req.headers['x-admin-password'];
  const adminPwd = db.getSetting('admin_password');
  if (password !== adminPwd) {
    return res.status(401).json({ error: 'Accès refusé' });
  }
  next();
}

// Debug volume (temporaire)
app.get('/api/debug-db', (req, res) => {
  const dbPath = process.env.RAILWAY_VOLUME_MOUNT_PATH
    ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'smartride.db')
    : path.join(__dirname, 'smartride.db');
  const fs = require('fs');
  res.json({
    RAILWAY_VOLUME_MOUNT_PATH: process.env.RAILWAY_VOLUME_MOUNT_PATH || 'NOT SET',
    dbPath,
    dbExists: fs.existsSync(dbPath),
    userCount: db.getAllUsers().length,
    users: db.getAllUsers().map(u => ({ email: u.email, plan: u.plan }))
  });
});

// ═══════════════════════════════════════════════════════
// API PUBLIQUE (appelée par l'app Android)
// ═══════════════════════════════════════════════════════

// Calcul de score — JWT obligatoire
app.post('/api/calculate', checkMaintenance, (req, res) => {
  const { prix, distance_km, duree_min, approche_min, approche_km, zone_distance_km, depart, arrivee } = req.body;

  // Authentification JWT obligatoire
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentification requise' });
  }
  const decoded = verifyToken(authHeader.substring(7));
  if (!decoded) return res.status(401).json({ error: 'Token invalide ou expiré' });

  const user = db.getUserById(decoded.userId);
  if (!user) return res.status(404).json({ error: 'Utilisateur non trouvé' });
  if (user.banned) return res.status(403).json({ error: 'Compte suspendu' });

  // Vérifier accès : premium OU free_access activé
  const freeAccess = db.getSetting('free_access') === 'true';
  if (!db.isUserPremium(user) && !freeAccess) {
    return res.status(403).json({ error: 'Abonnement requis', showPaywall: true });
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

  // Sauvegarder le calcul + analytics
  db.saveRideCalculation(user.id, {
    prix, distanceKm: distance_km, dureeMin: duree_min,
    approcheMin: approche_min, score, brutH, rentabiliteH,
    depart: depart || '', arrivee: arrivee || ''
  });
  db.incrementDailyUsage(user.id, 'analyses_done');

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
  db.setHeartbeatByDevice(device_id);
  res.json({ status: 'ok' });
});

// Chauffeur hors ligne
app.post('/api/offline', (req, res) => {
  const { device_id } = req.body;
  if (!device_id) return res.status(400).json({ error: 'device_id requis' });
  db.setOfflineByDevice(device_id);
  res.json({ status: 'ok' });
});

// Status de l'app (maintenance, version min, kill switch)
app.get('/api/status', (req, res) => {
  const killSwitch = db.getKillSwitchStatus();
  res.json({
    maintenance: db.isMaintenanceMode(),
    maintenance_message: db.getSetting('maintenance_message'),
    min_version: db.getSetting('min_app_version'),
    latest_version: db.getSetting('latest_app_version'),
    is_active: killSwitch.is_active,
    redirect_url: killSwitch.redirect_url,
    kill_message: killSwitch.message
  });
});

// ═══════════════════════════════════════════════════════
// ANALYTICS — événements envoyés par l'app
// ═══════════════════════════════════════════════════════

app.post('/api/analytics/event', (req, res) => {
  const { event_type, event_data, device_id } = req.body;
  if (!event_type) return res.status(400).json({ error: 'event_type requis' });

  // Identifier l'utilisateur par token ou device_id
  let userId = null;
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const decoded = verifyToken(authHeader.substring(7));
    if (decoded) userId = decoded.userId;
  }
  if (!userId && device_id) {
    const user = db.getUserByDeviceId(device_id);
    if (user) userId = user.id;
  }

  db.trackEvent(userId, event_type, event_data);

  // Incrémenter compteurs quotidiens
  if (userId) {
    switch (event_type) {
      case 'app_open': db.incrementDailyUsage(userId, 'app_opens'); break;
      case 'ride_accepted': db.incrementDailyUsage(userId, 'rides_accepted'); break;
      case 'analysis_done': db.incrementDailyUsage(userId, 'analyses_done'); break;
      case 'result_viewed': db.incrementDailyUsage(userId, 'results_viewed'); break;
    }
  }

  res.json({ status: 'ok' });
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
  const users = db.getAllUsers().map(u => {
    const analytics = db.getUserAnalytics(u.id);
    const rideStats = db.getUserRideStats(u.id);
    const isOnline = u.last_heartbeat && new Date(u.last_heartbeat + 'Z') >= new Date(Date.now() - 3 * 60 * 1000);
    const analyticsRides = analytics?.totals?.total_rides_accepted || 0;
    const dbAnalyses = rideStats?.total_rides || 0;
    return {
      ...u,
      total_analyses: dbAnalyses,
      total_rides_accepted: Math.max(analyticsRides, dbAnalyses),
      is_online: !!isOnline
    };
  });
  res.json(users);
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

// Reset device_id d'un utilisateur
app.post('/admin/api/users/:id/reset-device', adminAuth, (req, res) => {
  db.resetDeviceId(req.params.id);
  res.json({ status: 'ok' });
});

// ── FLAG FREE_ACCESS ──
app.get('/admin/api/flags', adminAuth, (req, res) => {
  res.json({ free_access: db.getSetting('free_access') === 'true' });
});

app.post('/admin/api/flags', adminAuth, (req, res) => {
  const { free_access } = req.body;
  if (free_access !== undefined) db.setSetting('free_access', free_access ? 'true' : 'false');
  res.json({ status: 'ok', free_access: db.getSetting('free_access') === 'true' });
});

// ── MESSAGES / CONTACT ──
app.get('/admin/api/messages', adminAuth, (req, res) => {
  res.json(db.getAllMessages());
});

app.post('/admin/api/messages/:id/read', adminAuth, (req, res) => {
  db.markMessageRead(req.params.id);
  res.json({ status: 'ok' });
});

app.post('/admin/api/messages/:id/reply', adminAuth, (req, res) => {
  const { reply } = req.body;
  if (!reply) return res.status(400).json({ error: 'Réponse requise' });
  db.replyMessage(req.params.id, reply);
  res.json({ status: 'ok' });
});

app.delete('/admin/api/messages/:id', adminAuth, (req, res) => {
  db.deleteMessage(req.params.id);
  res.json({ status: 'ok' });
});

// ── BROADCASTS (message à tous) ──
app.get('/admin/api/broadcasts', adminAuth, (req, res) => {
  res.json(db.getAllBroadcasts());
});

app.post('/admin/api/broadcasts', adminAuth, (req, res) => {
  const { title, message } = req.body;
  if (!message || message.trim().length < 3) return res.status(400).json({ error: 'Message requis' });
  db.createBroadcast(title || '', message.trim());
  res.json({ status: 'ok' });
});

app.delete('/admin/api/broadcasts/:id', adminAuth, (req, res) => {
  db.deleteBroadcast(req.params.id);
  res.json({ status: 'ok' });
});

// ── COURSES ADMIN ──
app.get('/admin/api/rides', adminAuth, (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  res.json(db.getAllRides(limit));
});

app.get('/admin/api/users/:id/rides', adminAuth, (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  res.json(db.getUserRides(req.params.id, limit));
});

// ── ANALYTICS ADMIN ──
app.get('/admin/api/analytics', adminAuth, (req, res) => {
  res.json(db.getAnalyticsSummary());
});

app.get('/admin/api/users/:id/analytics', adminAuth, (req, res) => {
  res.json(db.getUserAnalytics(req.params.id));
});

// ── KILL SWITCH ADMIN ──
app.get('/admin/api/kill-switch', adminAuth, (req, res) => {
  res.json(db.getKillSwitchStatus());
});

app.post('/admin/api/kill-switch', adminAuth, (req, res) => {
  const { is_active, redirect_url, message } = req.body;
  if (is_active !== undefined) db.setSetting('app_active', is_active ? 'true' : 'false');
  if (redirect_url) db.setSetting('app_redirect_url', redirect_url);
  if (message) db.setSetting('app_kill_message', message);
  res.json({ status: 'ok', ...db.getKillSwitchStatus() });
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
