const Database = require('better-sqlite3');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

// Sur Railway, les volumes sont montés dans /data
const DB_PATH = process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'smartride.db')
  : path.join(__dirname, 'smartride.db');

console.log('[DB] Chemin:', DB_PATH);
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// ═══════════════════════════════════════
// CRÉATION DES TABLES
// ═══════════════════════════════════════

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT,
    name TEXT DEFAULT '',
    phone TEXT DEFAULT '',
    role TEXT DEFAULT 'USER',
    plan TEXT DEFAULT 'free',
    device_id TEXT,
    google_id TEXT UNIQUE,
    email_verified INTEGER DEFAULT 0,
    email_verify_token TEXT,
    stripe_customer_id TEXT,
    stripe_subscription_id TEXT,
    banned INTEGER DEFAULT 0,
    ban_reason TEXT,
    expires_at TEXT,
    reset_token TEXT,
    reset_token_expires TEXT,
    last_seen TEXT DEFAULT (datetime('now')),
    last_heartbeat TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS ride_calculations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    prix REAL,
    distance_km REAL,
    duree_min REAL,
    approche_min REAL,
    score REAL,
    brut_h REAL,
    rentabilite_h REAL,
    depart TEXT DEFAULT '',
    arrivee TEXT DEFAULT '',
    calculated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    email TEXT,
    subject TEXT DEFAULT '',
    message TEXT NOT NULL,
    status TEXT DEFAULT 'NEW',
    admin_reply TEXT,
    replied_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS broadcasts (
    id TEXT PRIMARY KEY,
    title TEXT DEFAULT '',
    message TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS analytics_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT,
    event_type TEXT NOT NULL,
    event_data TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS daily_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    date TEXT NOT NULL,
    app_opens INTEGER DEFAULT 0,
    rides_accepted INTEGER DEFAULT 0,
    analyses_done INTEGER DEFAULT 0,
    results_viewed INTEGER DEFAULT 0,
    UNIQUE(user_id, date),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
  CREATE INDEX IF NOT EXISTS idx_users_device ON users(device_id);
  CREATE INDEX IF NOT EXISTS idx_users_google ON users(google_id);
  CREATE INDEX IF NOT EXISTS idx_rides_user ON ride_calculations(user_id);
  CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id);
  CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status);
  CREATE INDEX IF NOT EXISTS idx_analytics_user ON analytics_events(user_id);
  CREATE INDEX IF NOT EXISTS idx_analytics_type ON analytics_events(event_type);
  CREATE INDEX IF NOT EXISTS idx_daily_user_date ON daily_usage(user_id, date);
`);

// Migrations pour les anciennes bases
try { db.exec('ALTER TABLE users ADD COLUMN phone TEXT DEFAULT \'\''); } catch (_) {}
try { db.exec('ALTER TABLE users ADD COLUMN role TEXT DEFAULT \'USER\''); } catch (_) {}
try { db.exec('ALTER TABLE users ADD COLUMN last_heartbeat TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE users ADD COLUMN email_verified INTEGER DEFAULT 0'); } catch (_) {}
try { db.exec('ALTER TABLE users ADD COLUMN email_verify_token TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE users ADD COLUMN password_hash TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE users ADD COLUMN google_id TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE users ADD COLUMN stripe_customer_id TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE users ADD COLUMN stripe_subscription_id TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE users ADD COLUMN reset_token TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE users ADD COLUMN reset_token_expires TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE users ADD COLUMN device_id TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE users ADD COLUMN premium_since TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE users ADD COLUMN subscription_type TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE users ADD COLUMN cancelled_at TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE ride_calculations ADD COLUMN depart TEXT DEFAULT \'\''); } catch (_) {}
try { db.exec('ALTER TABLE ride_calculations ADD COLUMN arrivee TEXT DEFAULT \'\''); } catch (_) {}

// Paramètres par défaut
const initSetting = db.prepare('INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?)');
initSetting.run('maintenance', 'false');
initSetting.run('maintenance_message', 'SmartRide AI est en maintenance. Veuillez réessayer plus tard.');
initSetting.run('min_app_version', '1.0');
initSetting.run('latest_app_version', '1.0');
initSetting.run('admin_password', 'smartride2024');
initSetting.run('analysis_month_limit', '6000');
initSetting.run('free_access', 'true');
initSetting.run('app_active', 'true');
initSetting.run('app_redirect_url', 'https://smartride-ai.com');
initSetting.run('app_kill_message', 'App désactivée. Téléchargez la nouvelle version.');

// UI Config — contrôle à distance de l'affichage app
initSetting.run('ui_config', JSON.stringify({
  // Pages
  tab_courses: true,
  tab_stats: true,
  tab_settings: true,
  // Réglages
  setting_vehicle: true,
  setting_seuils: true,
  setting_approche: true,
  setting_course: true,
  setting_zones: true,
  setting_notification: true,
  setting_server_url: true,
  setting_account: true
}));

console.log('[DB] Base initialisée');

// ═══════════════════════════════════════
// UTILISATEURS
// ═══════════════════════════════════════

function getUserById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

function getUserByEmail(email) {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(email);
}

function getUserByDeviceId(deviceId) {
  return db.prepare('SELECT * FROM users WHERE device_id = ?').get(deviceId);
}

function getAllUsers() {
  return db.prepare('SELECT * FROM users ORDER BY last_seen DESC').all();
}

function createAccount(email, passwordHash, name, phone, verifyToken) {
  const id = uuidv4();
  db.prepare(`INSERT INTO users (id, email, password_hash, name, phone, email_verify_token, email_verified)
    VALUES (?, ?, ?, ?, ?, ?, 0)`).run(id, email, passwordHash, name || '', phone || '', verifyToken);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

function verifyEmailToken(token) {
  const user = db.prepare('SELECT * FROM users WHERE email_verify_token = ?').get(token);
  if (!user) return null;
  db.prepare('UPDATE users SET email_verified = 1, email_verify_token = NULL WHERE id = ?').run(user.id);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
}

function createGoogleAccount(email, name, googleId) {
  const id = uuidv4();
  db.prepare(`INSERT INTO users (id, email, name, google_id, email_verified)
    VALUES (?, ?, ?, ?, 1)`).run(id, email, name || '', googleId);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

function linkGoogleId(userId, googleId) {
  db.prepare('UPDATE users SET google_id = ? WHERE id = ?').run(googleId, userId);
}

// ═══════════════════════════════════════
// DEVICE LOCK (1 appareil par compte)
// ═══════════════════════════════════════

function setDeviceId(userId, deviceId) {
  db.prepare('UPDATE users SET device_id = ? WHERE id = ?').run(deviceId, userId);
}

function resetDeviceId(userId) {
  db.prepare('UPDATE users SET device_id = NULL WHERE id = ?').run(userId);
}

function checkDeviceLock(userId, deviceId) {
  const user = db.prepare('SELECT device_id FROM users WHERE id = ?').get(userId);
  if (!user) return { allowed: false, reason: 'Utilisateur introuvable' };
  // Premier appareil → enregistrer
  if (!user.device_id) {
    setDeviceId(userId, deviceId);
    return { allowed: true, reason: 'Appareil enregistré' };
  }
  // Même appareil → OK
  if (user.device_id === deviceId) {
    return { allowed: true, reason: 'OK' };
  }
  // Appareil différent → BLOQUÉ
  return { allowed: false, reason: 'Ce compte est déjà lié à un autre appareil. Contactez le support.' };
}

// ═══════════════════════════════════════
// PLAN & ACCÈS
// ═══════════════════════════════════════

function setUserPlan(userId, plan, durationDays) {
  const expiresAt = durationDays
    ? new Date(Date.now() + durationDays * 24 * 60 * 60 * 1000).toISOString()
    : null;
  db.prepare('UPDATE users SET plan = ?, expires_at = ? WHERE id = ?').run(plan, expiresAt, userId);
}

function banUser(userId, reason) {
  db.prepare('UPDATE users SET banned = 1, ban_reason = ? WHERE id = ?').run(reason || 'Banni par admin', userId);
}

function unbanUser(userId) {
  db.prepare('UPDATE users SET banned = 0, ban_reason = NULL WHERE id = ?').run(userId);
}

function deleteUser(userId) {
  db.prepare('DELETE FROM ride_calculations WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM messages WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM users WHERE id = ?').run(userId);
}

function isUserPremium(user) {
  if (!user) return false;
  if (user.plan !== 'premium') return false;
  if (user.banned) return false;
  if (!user.expires_at) return true; // Lifetime
  return new Date(user.expires_at) > new Date();
}

function getEffectivePlan(user) {
  if (!user) return 'free';
  if (isUserPremium(user)) return 'premium';
  // Si le plan est premium mais expiré → downgrader en DB
  if (user.plan === 'premium' && user.expires_at && new Date(user.expires_at) <= new Date()) {
    db.prepare('UPDATE users SET plan = ? WHERE id = ?').run('free', user.id);
  }
  return 'free';
}

// Vérifie si l'utilisateur a accès à l'app
function checkAccess(user) {
  if (!user) return { allowed: false, reason: 'Utilisateur introuvable' };
  if (user.banned) return { allowed: false, reason: user.ban_reason || 'Compte suspendu' };

  // Premium → toujours accès
  if (isUserPremium(user)) return { allowed: true, plan: 'premium' };

  const freeAccess = getSetting('free_access') === 'true';

  // FREE_ACCESS ON → accès gratuit
  if (freeAccess) return { allowed: true, plan: 'free' };

  // FREE_ACCESS OFF → paywall
  return { allowed: false, reason: 'paywall', showPaywall: true };
}

// ═══════════════════════════════════════
// STRIPE
// ═══════════════════════════════════════

function setStripeCustomer(userId, customerId) {
  db.prepare('UPDATE users SET stripe_customer_id = ? WHERE id = ?').run(customerId, userId);
}

function setStripeSubscription(userId, subscriptionId, plan, expiresAt, subscriptionType) {
  if (plan === 'premium') {
    // Enregistrer la date de passage en premium + type d'abonnement
    const user = db.prepare('SELECT premium_since FROM users WHERE id = ?').get(userId);
    const premiumSince = (user && user.premium_since) ? user.premium_since : new Date().toISOString();
    db.prepare('UPDATE users SET stripe_subscription_id = ?, plan = ?, expires_at = ?, premium_since = ?, subscription_type = ?, cancelled_at = NULL WHERE id = ?')
      .run(subscriptionId, plan, expiresAt, premiumSince, subscriptionType || null, userId);
  } else {
    // Passage en free = résiliation
    db.prepare('UPDATE users SET stripe_subscription_id = ?, plan = ?, expires_at = ?, cancelled_at = ? WHERE id = ?')
      .run(subscriptionId, plan, expiresAt, new Date().toISOString(), userId);
  }
}

function getUserByStripeCustomer(customerId) {
  return db.prepare('SELECT * FROM users WHERE stripe_customer_id = ?').get(customerId);
}

// ═══════════════════════════════════════
// MOT DE PASSE
// ═══════════════════════════════════════

function setResetToken(userId, token) {
  const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  db.prepare('UPDATE users SET reset_token = ?, reset_token_expires = ? WHERE id = ?').run(token, expires, userId);
}

function getUserByResetToken(token) {
  return db.prepare(`SELECT * FROM users WHERE reset_token = ? AND reset_token_expires > datetime('now')`).get(token);
}

function resetPassword(userId, passwordHash) {
  db.prepare('UPDATE users SET password_hash = ?, reset_token = NULL, reset_token_expires = NULL WHERE id = ?').run(passwordHash, userId);
}

function updateLastSeen(userId) {
  db.prepare("UPDATE users SET last_seen = datetime('now') WHERE id = ?").run(userId);
}

// ═══════════════════════════════════════
// MESSAGES / CONTACT
// ═══════════════════════════════════════

function createMessage(userId, email, subject, message) {
  const id = uuidv4();
  db.prepare('INSERT INTO messages (id, user_id, email, subject, message) VALUES (?, ?, ?, ?, ?)')
    .run(id, userId, email || '', subject || '', message);
  return db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
}

function getAllMessages() {
  return db.prepare(`
    SELECT m.*, u.name as user_name, u.email as user_email, u.plan as user_plan
    FROM messages m LEFT JOIN users u ON m.user_id = u.id
    ORDER BY m.created_at DESC
  `).all();
}

function getMessageById(id) {
  return db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
}

function markMessageRead(id) {
  db.prepare("UPDATE messages SET status = 'READ' WHERE id = ?").run(id);
}

function replyMessage(id, replyText) {
  db.prepare("UPDATE messages SET admin_reply = ?, status = 'REPLIED', replied_at = datetime('now') WHERE id = ?")
    .run(replyText, id);
}

function deleteMessage(id) {
  db.prepare('DELETE FROM messages WHERE id = ?').run(id);
}

function getUnreadMessageCount() {
  return db.prepare("SELECT COUNT(*) as total FROM messages WHERE status = 'NEW'").get().total;
}

// Messages d'un utilisateur (avec réponses admin)
function getUserMessages(userId) {
  return db.prepare('SELECT * FROM messages WHERE user_id = ? ORDER BY created_at DESC').all(userId);
}

// ═══════════════════════════════════════
// BROADCASTS (messages admin → tous)
// ═══════════════════════════════════════

function createBroadcast(title, message) {
  const id = uuidv4();
  db.prepare('INSERT INTO broadcasts (id, title, message) VALUES (?, ?, ?)').run(id, title, message);
  return db.prepare('SELECT * FROM broadcasts WHERE id = ?').get(id);
}

function getAllBroadcasts() {
  return db.prepare('SELECT * FROM broadcasts ORDER BY created_at DESC').all();
}

function getRecentBroadcasts(since) {
  if (since) {
    return db.prepare('SELECT * FROM broadcasts WHERE created_at > ? ORDER BY created_at DESC').all(since);
  }
  return db.prepare('SELECT * FROM broadcasts ORDER BY created_at DESC LIMIT 10').all();
}

function deleteBroadcast(id) {
  db.prepare('DELETE FROM broadcasts WHERE id = ?').run(id);
}

// ═══════════════════════════════════════
// COURSES
// ═══════════════════════════════════════

function saveRideCalculation(userId, data) {
  db.prepare(`INSERT INTO ride_calculations (user_id, prix, distance_km, duree_min, approche_min, score, brut_h, rentabilite_h, depart, arrivee)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    userId, data.prix, data.distanceKm, data.dureeMin, data.approcheMin, data.score, data.brutH, data.rentabiliteH, data.depart || '', data.arrivee || ''
  );
}

function getUserRides(userId) {
  return db.prepare(`SELECT * FROM ride_calculations WHERE user_id = ? ORDER BY calculated_at DESC`).all(userId);
}

function getAllRides() {
  return db.prepare(`
    SELECT r.*, u.email, u.name FROM ride_calculations r
    LEFT JOIN users u ON r.user_id = u.id
    ORDER BY r.calculated_at DESC
  `).all();
}

function getUserRideStats(userId) {
  return db.prepare(`
    SELECT COUNT(*) as total_rides, ROUND(AVG(score), 1) as avg_score,
    ROUND(AVG(brut_h), 1) as avg_brut_h, ROUND(SUM(prix), 2) as total_revenue,
    ROUND(MAX(brut_h), 1) as best_brut_h
    FROM ride_calculations WHERE user_id = ?
  `).get(userId);
}

// ═══════════════════════════════════════
// PARAMÈTRES
// ═══════════════════════════════════════

function getSetting(key) {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setSetting(key, value) {
  db.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)').run(key, value);
}

function isMaintenanceMode() {
  return getSetting('maintenance') === 'true';
}

// ═══════════════════════════════════════
// HEARTBEAT & ONLINE
// ═══════════════════════════════════════

function setHeartbeat(userId) {
  db.prepare("UPDATE users SET last_heartbeat = datetime('now') WHERE id = ?").run(userId);
}

function setHeartbeatByDevice(deviceId) {
  db.prepare("UPDATE users SET last_heartbeat = datetime('now') WHERE device_id = ?").run(deviceId);
}

function setOffline(userId) {
  db.prepare('UPDATE users SET last_heartbeat = NULL WHERE id = ?').run(userId);
}

function setOfflineByDevice(deviceId) {
  db.prepare('UPDATE users SET last_heartbeat = NULL WHERE device_id = ?').run(deviceId);
}

function getOnlineCount() {
  return db.prepare("SELECT COUNT(*) as total FROM users WHERE last_heartbeat >= datetime('now', '-3 minutes')").get().total;
}

function getMonthlyAnalysisCount() {
  return db.prepare("SELECT COUNT(*) as total FROM ride_calculations WHERE calculated_at >= date('now', 'start of month')").get().total;
}

// ═══════════════════════════════════════
// STATISTIQUES ADMIN
// ═══════════════════════════════════════

function getGlobalStats() {
  const users = db.prepare('SELECT COUNT(*) as total FROM users').get();
  const premium = db.prepare("SELECT COUNT(*) as total FROM users WHERE plan = 'premium' AND (expires_at IS NULL OR expires_at > datetime('now'))").get();
  const banned = db.prepare('SELECT COUNT(*) as total FROM users WHERE banned = 1').get();
  const rides = db.prepare('SELECT COUNT(*) as total, ROUND(AVG(score), 1) as avg_score FROM ride_calculations').get();
  const activeToday = db.prepare("SELECT COUNT(*) as total FROM users WHERE last_seen > datetime('now', '-1 day')").get();
  const activeWeek = db.prepare("SELECT COUNT(*) as total FROM users WHERE last_seen > datetime('now', '-7 day')").get();
  const unreadMessages = getUnreadMessageCount();

  return {
    totalUsers: users.total,
    premiumUsers: premium.total,
    bannedUsers: banned.total,
    totalRides: rides.total,
    avgScore: rides.avg_score,
    activeToday: activeToday.total,
    activeWeek: activeWeek.total,
    monthlyAnalyses: getMonthlyAnalysisCount(),
    analysisMonthLimit: parseInt(getSetting('analysis_month_limit') || '6000'),
    onlineNow: getOnlineCount(),
    unreadMessages,
    freeAccess: getSetting('free_access') === 'true',
    apiGoogle: getApiGoogleStats()
  };
}

// ═══════════════════════════════════════
// STATS API GOOGLE (basées sur ride_calculations)
// ═══════════════════════════════════════

function getApiGoogleStats() {
  // Chaque analyse = 2 appels API Google (approche + trajet)
  const today = db.prepare("SELECT COUNT(*) as total FROM ride_calculations WHERE calculated_at >= date('now')").get();
  const week = db.prepare("SELECT COUNT(*) as total FROM ride_calculations WHERE calculated_at >= date('now', '-7 days')").get();
  const month = db.prepare("SELECT COUNT(*) as total FROM ride_calculations WHERE calculated_at >= date('now', 'start of month')").get();
  const allTime = db.prepare("SELECT COUNT(*) as total FROM ride_calculations").get();

  // Par jour cette semaine
  const daily = db.prepare(`
    SELECT date(calculated_at) as jour, COUNT(*) as total
    FROM ride_calculations
    WHERE calculated_at >= date('now', '-7 days')
    GROUP BY date(calculated_at)
    ORDER BY jour DESC
  `).all();

  const apiCallsToday = today.total * 2;
  const apiCallsWeek = week.total * 2;
  const apiCallsMonth = month.total * 2;
  const apiCallsTotal = allTime.total * 2;

  // Coût estimé (0.005$ par requête Routes, 200$ crédit gratuit/mois)
  const coutBrutMois = apiCallsMonth * 0.005;
  const coutNetMois = Math.max(0, coutBrutMois - 200);

  return {
    analysesToday: today.total,
    analysesWeek: week.total,
    analysesMonth: month.total,
    analysesTotal: allTime.total,
    apiCallsToday,
    apiCallsWeek,
    apiCallsMonth,
    apiCallsTotal,
    coutBrutMois: Math.round(coutBrutMois * 100) / 100,
    coutNetMois: Math.round(coutNetMois * 100) / 100,
    creditGratuit: 200,
    daily: daily.map(d => ({ jour: d.jour, analyses: d.total, apiCalls: d.total * 2 }))
  };
}

// ═══════════════════════════════════════
// ANALYTICS
// ═══════════════════════════════════════

function trackEvent(userId, eventType, eventData) {
  db.prepare('INSERT INTO analytics_events (user_id, event_type, event_data) VALUES (?, ?, ?)')
    .run(userId || null, eventType, eventData ? JSON.stringify(eventData) : null);
}

function incrementDailyUsage(userId, field) {
  const today = new Date().toISOString().slice(0, 10);
  db.prepare(`INSERT INTO daily_usage (user_id, date, ${field}) VALUES (?, ?, 1)
    ON CONFLICT(user_id, date) DO UPDATE SET ${field} = ${field} + 1`).run(userId, today);
}

function getUserDailyUsage(userId, date) {
  const d = date || new Date().toISOString().slice(0, 10);
  return db.prepare('SELECT * FROM daily_usage WHERE user_id = ? AND date = ?').get(userId, d);
}

function getAnalyticsSummary() {
  const today = new Date().toISOString().slice(0, 10);
  const todayStats = db.prepare(`
    SELECT COALESCE(SUM(app_opens),0) as total_opens,
           COALESCE(SUM(rides_accepted),0) as total_rides_accepted,
           COALESCE(SUM(analyses_done),0) as total_analyses,
           COALESCE(SUM(results_viewed),0) as total_results_viewed,
           COUNT(DISTINCT user_id) as active_users
    FROM daily_usage WHERE date = ?
  `).get(today);

  const weekStats = db.prepare(`
    SELECT COALESCE(SUM(app_opens),0) as total_opens,
           COALESCE(SUM(rides_accepted),0) as total_rides_accepted,
           COALESCE(SUM(analyses_done),0) as total_analyses,
           COALESCE(SUM(results_viewed),0) as total_results_viewed,
           COUNT(DISTINCT user_id) as active_users
    FROM daily_usage WHERE date >= date('now', '-7 days')
  `).get();

  const last7days = db.prepare(`
    SELECT date, SUM(app_opens) as opens, SUM(rides_accepted) as rides,
           SUM(analyses_done) as analyses, COUNT(DISTINCT user_id) as users
    FROM daily_usage WHERE date >= date('now', '-7 days')
    GROUP BY date ORDER BY date
  `).all();

  return { today: todayStats, week: weekStats, last7days };
}

function getUserAnalytics(userId) {
  const usage = db.prepare(`
    SELECT date, app_opens, rides_accepted, analyses_done, results_viewed
    FROM daily_usage WHERE user_id = ? ORDER BY date DESC LIMIT 30
  `).all(userId);
  const totals = db.prepare(`
    SELECT COALESCE(SUM(app_opens),0) as total_opens,
           COALESCE(SUM(rides_accepted),0) as total_rides_accepted,
           COALESCE(SUM(analyses_done),0) as total_analyses,
           COALESCE(SUM(results_viewed),0) as total_results_viewed
    FROM daily_usage WHERE user_id = ?
  `).get(userId);
  return { usage, totals };
}

// ═══════════════════════════════════════
// KILL SWITCH
// ═══════════════════════════════════════

function getKillSwitchStatus() {
  return {
    is_active: getSetting('app_active') !== 'false',
    redirect_url: getSetting('app_redirect_url') || 'https://smartride-ai.com',
    message: getSetting('app_kill_message') || 'App désactivée.'
  };
}

module.exports = {
  getUserById, getUserByEmail, getUserByDeviceId, getAllUsers,
  createAccount, verifyEmailToken, createGoogleAccount, linkGoogleId,
  setDeviceId, resetDeviceId, checkDeviceLock,
  setUserPlan, banUser, unbanUser, deleteUser,
  isUserPremium, getEffectivePlan, checkAccess,
  setStripeCustomer, setStripeSubscription, getUserByStripeCustomer,
  setResetToken, getUserByResetToken, resetPassword, updateLastSeen,
  createMessage, getAllMessages, getMessageById, markMessageRead, replyMessage, deleteMessage, getUnreadMessageCount, getUserMessages,
  createBroadcast, getAllBroadcasts, getRecentBroadcasts, deleteBroadcast,
  saveRideCalculation, getUserRideStats, getUserRides, getAllRides,
  getSetting, setSetting, isMaintenanceMode,
  setHeartbeat, setHeartbeatByDevice, setOffline, setOfflineByDevice, getOnlineCount,
  getMonthlyAnalysisCount, getGlobalStats,
  trackEvent, incrementDailyUsage, getUserDailyUsage, getAnalyticsSummary, getUserAnalytics,
  getKillSwitchStatus, getApiGoogleStats
};
