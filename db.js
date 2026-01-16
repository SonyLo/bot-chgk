const sqlite3 = require("sqlite3").verbose();

function openDb(dbPath) {
	const db = new sqlite3.Database(dbPath);

	function run(sql, params = []) {
		return new Promise((resolve, reject) => {
			db.run(sql, params, function (err) {
				if (err) return reject(err);
				resolve(this);
			});
		});
	}

	function get(sql, params = []) {
		return new Promise((resolve, reject) => {
			db.get(sql, params, (err, row) => {
				if (err) return reject(err);
				resolve(row);
			});
		});
	}

	function all(sql, params = []) {
		return new Promise((resolve, reject) => {
			db.all(sql, params, (err, rows) => {
				if (err) return reject(err);
				resolve(rows);
			});
		});
	}

	async function init() {
		await run(`PRAGMA journal_mode = WAL;`);
		await run(`CREATE TABLE IF NOT EXISTS chat_admins (
      chat_id INTEGER NOT NULL,
      admin_user_id INTEGER NOT NULL,
      added_by INTEGER,
      added_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (chat_id, admin_user_id)
    )`);

		await run(`CREATE TABLE IF NOT EXISTS super_admins (
      user_id INTEGER PRIMARY KEY
    )`);

		await run(`CREATE TABLE IF NOT EXISTS chat_settings (
      chat_id INTEGER PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 1
    )`);

		await run(`CREATE TABLE IF NOT EXISTS user_chat_context (
      user_id INTEGER PRIMARY KEY,
      chat_id INTEGER NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    )`);


		await run(`CREATE TABLE IF NOT EXISTS usage_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,              -- 'quest', 'delete_question', 'start'
  chat_id INTEGER,
  chat_type TEXT,
  user_id INTEGER,
  username TEXT,
  first_name TEXT,
  last_name TEXT,
  ok INTEGER NOT NULL DEFAULT 1,
  meta TEXT,
  created_at TEXT DEFAULT (datetime('now'))
)`);

		await run(`CREATE INDEX IF NOT EXISTS idx_usage_events_event_time ON usage_events(event_type, created_at)`);
		await run(`CREATE INDEX IF NOT EXISTS idx_usage_events_user_time ON usage_events(user_id, created_at)`);
		await run(`CREATE INDEX IF NOT EXISTS idx_usage_events_chat_time ON usage_events(chat_id, created_at)`);



	}

	async function seedSuperAdmins(superAdmins = []) {
		for (const id of superAdmins) {
			if (!Number.isFinite(id)) continue;
			await run(`INSERT OR IGNORE INTO super_admins(user_id) VALUES (?)`, [id]);
		}
	}

	async function isSuperAdmin(userId) {
		const row = await get(`SELECT 1 AS ok FROM super_admins WHERE user_id=?`, [userId]);
		return !!row;
	}

	async function isChatAdmin(chatId, userId) {
		const row = await get(
			`SELECT 1 AS ok FROM chat_admins WHERE chat_id=? AND admin_user_id=?`,
			[chatId, userId]
		);
		return !!row;
	}

	async function canManageChat(chatId, userId) {
		if (await isSuperAdmin(userId)) return true;
		return await isChatAdmin(chatId, userId);
	}

	async function setUserChatContext(userId, chatId) {
		await run(
			`INSERT INTO user_chat_context (user_id, chat_id) VALUES (?,?)
       ON CONFLICT(user_id) DO UPDATE SET chat_id=excluded.chat_id, updated_at=datetime('now')`,
			[userId, chatId]
		);
	}

	async function getUserChatContext(userId) {
		const row = await get(`SELECT chat_id FROM user_chat_context WHERE user_id=?`, [userId]);
		return row?.chat_id ?? null;
	}

	async function addChatAdmin(chatId, adminUserId, addedBy) {
		await run(
			`INSERT OR IGNORE INTO chat_admins(chat_id, admin_user_id, added_by) VALUES (?,?,?)`,
			[chatId, adminUserId, addedBy]
		);
	}

	async function delChatAdmin(chatId, adminUserId) {
		await run(`DELETE FROM chat_admins WHERE chat_id=? AND admin_user_id=?`, [chatId, adminUserId]);
	}

	async function listChatAdmins(chatId) {
		return await all(
			`SELECT admin_user_id FROM chat_admins WHERE chat_id=? ORDER BY admin_user_id`,
			[chatId]
		);
	}

	async function getAdminsForChat(chatId) {
		const rows = await listChatAdmins(chatId);
		return rows.map(r => r.admin_user_id);
	}

	async function isEnabledForChat(chatId) {
		const row = await get(`SELECT enabled FROM chat_settings WHERE chat_id=?`, [chatId]);
		return row ? row.enabled === 1 : true; // default ON
	}

	async function setEnabledForChat(chatId, enabled) {
		const v = enabled ? 1 : 0;
		await run(
			`INSERT INTO chat_settings(chat_id, enabled) VALUES (?,?)
       ON CONFLICT(chat_id) DO UPDATE SET enabled=excluded.enabled`,
			[chatId, v]
		);
	}

	async function logEvent(evt) {
		const {
			event_type,
			chat_id = null,
			chat_type = null,
			user_id = null,
			username = null,
			first_name = null,
			last_name = null,
			ok = 1,
			meta = null
		} = evt;

		await run(
			`INSERT INTO usage_events(event_type, chat_id, chat_type, user_id, username, first_name, last_name, ok, meta)
     VALUES (?,?,?,?,?,?,?,?,?)`,
			[
				event_type,
				chat_id,
				chat_type,
				user_id,
				username,
				first_name,
				last_name,
				ok ? 1 : 0,
				meta ? JSON.stringify(meta) : null
			]
		);
	}

	async function getStatsSummary(days = 30) {
		// SQLite: datetime('now','-30 days')
		const rows = await all(
			`SELECT
       COUNT(*) as total_events,
       SUM(CASE WHEN ok=1 THEN 1 ELSE 0 END) as ok_events,
       SUM(CASE WHEN ok=0 THEN 1 ELSE 0 END) as fail_events,
       COUNT(DISTINCT user_id) as unique_users,
       COUNT(DISTINCT chat_id) as unique_chats
     FROM usage_events
     WHERE created_at >= datetime('now', ?)`,
			[`-${Number(days)} days`]
		);
		return rows[0];
	}

	async function getTopUsers(days = 30, limit = 20) {
		return await all(
			`SELECT
       user_id,
       COALESCE(username, (first_name || ' ' || last_name)) as name,
       COUNT(*) as cnt
     FROM usage_events
     WHERE event_type='quest'
       AND created_at >= datetime('now', ?)
       AND user_id IS NOT NULL
     GROUP BY user_id
     ORDER BY cnt DESC
     LIMIT ?`,
			[`-${Number(days)} days`, Number(limit)]
		);
	}

	async function getTopChats(days = 30, limit = 20) {
		return await all(
			`SELECT
       chat_id,
       chat_type,
       COUNT(*) as cnt
     FROM usage_events
     WHERE event_type='quest'
       AND created_at >= datetime('now', ?)
       AND chat_id IS NOT NULL
     GROUP BY chat_id, chat_type
     ORDER BY cnt DESC
     LIMIT ?`,
			[`-${Number(days)} days`, Number(limit)]
		);
	}
	return {
		db,
		init,
		seedSuperAdmins,
		isSuperAdmin,
		isChatAdmin,
		canManageChat,
		setUserChatContext,
		getUserChatContext,
		addChatAdmin,
		delChatAdmin,
		listChatAdmins,
		getAdminsForChat,
		isEnabledForChat,
		setEnabledForChat,
		logEvent,
		getStatsSummary,
		getTopUsers,
		getTopChats
	};
}

module.exports = { openDb };
