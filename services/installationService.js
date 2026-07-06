// Per-workspace installation store (public distribution / OAuth mode).
// Bot tokens are encrypted at rest with AES-256-GCM; the key never touches
// the database. Requires DATABASE_URL + TOKEN_ENCRYPTION_KEY.
const crypto = require('crypto');
const { isDbEnabled, query, withTx } = require('../utils/db');

function encryptionKey() {
  const raw = process.env.TOKEN_ENCRYPTION_KEY;
  if (!raw) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('TOKEN_ENCRYPTION_KEY is required in production to store workspace tokens');
    }
    return crypto.createHash('sha256').update('dev-insecure-token-key').digest();
  }
  // Accept any string secret — derive a 32-byte key deterministically.
  return crypto.createHash('sha256').update(raw).digest();
}

function encryptToken(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join('.');
}

function decryptToken(enc) {
  const [v, ivB64, tagB64, ctB64] = String(enc).split('.');
  if (v !== 'v1') throw new Error('Unknown token encryption version');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
}

/** Upsert an installation after a successful oauth.v2.access exchange. */
async function saveInstallation({ teamId, teamName, enterpriseId, botUserId, botToken, scopes, installedBy }) {
  if (!isDbEnabled()) throw new Error('Installation store requires DATABASE_URL (multi-workspace mode)');
  await query(`
    INSERT INTO installations (team_id, team_name, enterprise_id, bot_user_id, bot_token_enc, scopes, installed_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT (team_id) DO UPDATE SET
      team_name = EXCLUDED.team_name,
      enterprise_id = EXCLUDED.enterprise_id,
      bot_user_id = EXCLUDED.bot_user_id,
      bot_token_enc = EXCLUDED.bot_token_enc,
      scopes = EXCLUDED.scopes,
      installed_by = EXCLUDED.installed_by,
      updated_at = now()
  `, [teamId, teamName || null, enterpriseId || null, botUserId || null, encryptToken(botToken), scopes || null, installedBy || null]);
}

/** Returns {teamId, teamName, botUserId, botToken, scopes} or null. */
async function getInstallation(teamId) {
  if (!isDbEnabled() || !teamId) return null;
  const { rows } = await query('SELECT * FROM installations WHERE team_id = $1', [teamId]);
  if (!rows.length) return null;
  const r = rows[0];
  return {
    teamId: r.team_id,
    teamName: r.team_name,
    enterpriseId: r.enterprise_id,
    botUserId: r.bot_user_id,
    botToken: decryptToken(r.bot_token_enc),
    scopes: r.scopes
  };
}

async function listInstallations() {
  if (!isDbEnabled()) return [];
  const { rows } = await query('SELECT team_id, team_name FROM installations ORDER BY installed_at');
  return rows.map(r => ({ teamId: r.team_id, teamName: r.team_name }));
}

/**
 * Remove an installation. When wipeData is true (app_uninstalled), also delete
 * that workspace's campaigns and audit entries — we hold no data for
 * workspaces that removed the app.
 */
async function deleteInstallation(teamId, { wipeData = false } = {}) {
  if (!isDbEnabled() || !teamId) return;
  await withTx(async client => {
    await client.query('DELETE FROM installations WHERE team_id = $1', [teamId]);
    if (wipeData) {
      await client.query('DELETE FROM campaigns WHERE team_id = $1', [teamId]);
      await client.query('DELETE FROM audit_log WHERE team_id = $1', [teamId]);
    }
  });
}

module.exports = { saveInstallation, getInstallation, listInstallations, deleteInstallation, encryptToken, decryptToken };
