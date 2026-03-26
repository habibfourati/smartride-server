const Database = require('better-sqlite3');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const db = new Database(path.join(__dirname, 'smartride.db'));

// Activer WAL pour de meilleures performances
db.pragma('journal_mode = WAL');

// ═══════════════════════════════════════
// CRÉATION DES TABLES
// ═══════════════════════════════════════

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    device_id TEXT UNIQUE NOT NULL,
    email TEXT,
    phone TEXT,
    name TEXT,
    plan TEXT DEFAULT 'free',
    banned INTEGER DEFAULT 0,
    ban_reason TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    last_seen TEXT DEFAULT (datetime('now')),
    expires_at TEXT
  );

  CREATE TABLE IF NOT EXISTS license_keys (
    id TEXT PRIMARY KEY,
    key TEXT UNIQUE NOT NULL,
    plan TEXT DEFAULT 'premium',
    duration_days INTEGER DEFAULT 30,
    used_by TEXT,
    used_at TEXT,
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
    calculated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_users_device ON users(device_id);
  CREATE INDEX IF NOT EXISTS idx_license_key ON license_keys(key);
  CREATE INDEX IF NOT EXISTS idx_rides_user ON ride_calculations(user_id);
`);

// Initialiser les paramètres par défaut
const initSetting = db.prepare('INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?)');
initSetting.run('maintenance', 'false');
initSetting.run('maintenance_message', 'SmartRide AI est en maintenance. Veuillez réessayer plus tard.');
initSetting.run('min_app_version', '1.0');
initSetting.run('latest_app_version', '1.0');
initSetting.run('admin_password', 'smartride2024');

// ═══════════════════════════════════════
// FONCTIONS UTILISATEURS
// ═══════════════════════════════════════

function registerUser(deviceId, email, phone, name) {
  const existing = db.prepare('SELECT * FROM users WHERE device_id = ?').get(deviceId);
  if (existing) {
    // Mettre à jour last_seen
    db.prepare("UPDATE users SET last_seen = datetime('now') WHERE device_id = ?").run(deviceId);
    return existing;
  }
  const id = uuidv4();
  db.prepare('INSERT INTO users (id, device_id, email, phone, name) VALUES (?, ?, ?, ?, ?)').run(id, deviceId, email || null, phone || null, name || null);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

function getUser(deviceId) {
  const user = db.prepare('SELECT * FROM users WHERE device_id = ?').get(deviceId);
  if (user) {
    db.prepare("UPDATE users SET last_seen = datetime('now') WHERE device_id = ?").run(deviceId);
  }
  return user;
}

function getUserById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

function getAllUsers() {
  return db.prepare('SELECT * FROM users ORDER BY last_seen DESC').all();
}

function banUser(userId, reason) {
  db.prepare('UPDATE users SET banned = 1, ban_reason = ? WHERE id = ?').run(reason || 'Banni par admin', userId);
}

function unbanUser(userId) {
  db.prepare('UPDATE users SET banned = 0, ban_reason = NULL WHERE id = ?').run(userId);
}

function deleteUser(userId) {
  db.prepare('DELETE FROM ride_calculations WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM users WHERE id = ?').run(userId);
}

function setUserPlan(userId, plan, durationDays) {
  const expiresAt = durationDays
    ? new Date(Date.now() + durationDays * 24 * 60 * 60 * 1000).toISOString()
    : null;
  db.prepare('UPDATE users SET plan = ?, expires_at = ? WHERE id = ?').run(plan, expiresAt, userId);
}

// ═══════════════════════════════════════
// FONCTIONS LICENCES
// ═══════════════════════════════════════

function generateLicenseKey(plan, durationDays, count) {
  const keys = [];
  const stmt = db.prepare('INSERT INTO license_keys (id, key, plan, duration_days) VALUES (?, ?, ?, ?)');
  const batch = db.transaction(() => {
    for (let i = 0; i < (count || 1); i++) {
      const id = uuidv4();
      const key = 'SR-' + uuidv4().substring(0, 8).toUpperCase() + '-' + uuidv4().substring(0, 4).toUpperCase();
      stmt.run(id, key, plan || 'premium', durationDays || 30);
      keys.push(key);
    }
  });
  batch();
  return keys;
}

function redeemLicenseKey(deviceId, key) {
  const license = db.prepare('SELECT * FROM license_keys WHERE key = ? AND used_by IS NULL').get(key);
  if (!license) return { success: false, error: 'Clé invalide ou déjà utilisée' };

  const user = getUser(deviceId);
  if (!user) return { success: false, error: 'Utilisateur non trouvé' };

  const expiresAt = new Date(Date.now() + license.duration_days * 24 * 60 * 60 * 1000).toISOString();

  const batch = db.transaction(() => {
    db.prepare("UPDATE license_keys SET used_by = ?, used_at = datetime('now') WHERE id = ?").run(user.id, license.id);
    db.prepare('UPDATE users SET plan = ?, expires_at = ? WHERE id = ?').run(license.plan, expiresAt, user.id);
  });
  batch();

  return { success: true, plan: license.plan, expires_at: expiresAt };
}

function getAllLicenseKeys() {
  return db.prepare('SELECT * FROM license_keys ORDER BY created_at DESC').all();
}

// ═══════════════════════════════════════
// FONCTIONS CALCUL (PREMIUM)
// ═══════════════════════════════════════

function saveRideCalculation(userId, data) {
  db.prepare(`INSERT INTO ride_calculations (user_id, prix, distance_km, duree_min, approche_min, score, brut_h, rentabilite_h)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    userId, data.prix, data.distanceKm, data.dureeMin, data.approcheMin, data.score, data.brutH, data.rentabiliteH
  );
}

function getUserRideStats(userId) {
  return db.prepare(`
    SELECT
      COUNT(*) as total_rides,
      ROUND(AVG(score), 1) as avg_score,
      ROUND(AVG(brut_h), 1) as avg_brut_h,
      ROUND(SUM(prix), 2) as total_revenue,
      ROUND(MAX(brut_h), 1) as best_brut_h
    FROM ride_calculations WHERE user_id = ?
  `).get(userId);
}

// ═══════════════════════════════════════
// FONCTIONS PARAMÈTRES APP
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
// STATISTIQUES GLOBALES
// ═══════════════════════════════════════

function getGlobalStats() {
  const users = db.prepare('SELECT COUNT(*) as total FROM users').get();
  const premium = db.prepare("SELECT COUNT(*) as total FROM users WHERE plan = 'premium' AND (expires_at IS NULL OR expires_at > datetime('now'))").get();
  const banned = db.prepare('SELECT COUNT(*) as total FROM users WHERE banned = 1').get();
  const rides = db.prepare('SELECT COUNT(*) as total, ROUND(AVG(score), 1) as avg_score FROM ride_calculations').get();
  const activeToday = db.prepare("SELECT COUNT(*) as total FROM users WHERE last_seen > datetime('now', '-1 day')").get();
  const activeWeek = db.prepare("SELECT COUNT(*) as total FROM users WHERE last_seen > datetime('now', '-7 day')").get();

  return {
    totalUsers: users.total,
    premiumUsers: premium.total,
    bannedUsers: banned.total,
    totalRides: rides.total,
    avgScore: rides.avg_score,
    activeToday: activeToday.total,
    activeWeek: activeWeek.total
  };
}

module.exports = {
  registerUser, getUser, getUserById, getAllUsers,
  banUser, unbanUser, deleteUser, setUserPlan,
  generateLicenseKey, redeemLicenseKey, getAllLicenseKeys,
  saveRideCalculation, getUserRideStats,
  getSetting, setSetting, isMaintenanceMode,
  getGlobalStats
};
