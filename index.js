const TelegramBot = require("node-telegram-bot-api");
const { openDb } = require("./db");
const { fetchRandomQuestion, formatQuestionForUser, formatQuestionForAdmins } = require("./chgk");

const API_KEY_BOT = process.env.TELEGRAM_TOKEN;
if (!API_KEY_BOT) {
	console.error("TELEGRAM_TOKEN is required");
	process.exit(1);
}

const DB_PATH = process.env.DB_PATH || "./bot.db";

const SUPER_ADMINS = (process.env.SUPER_ADMINS || "")
	.split(",")
	.map(s => s.trim())
	.filter(Boolean)
	.map(Number)
	.filter(n => Number.isFinite(n));

const bot = new TelegramBot(API_KEY_BOT, { polling: true });

bot.setMyCommands([
	{ command: "quest", description: "Случайный вопрос ЧГК" },
	{ command: "start", description: "Что умеет бот" }
]);

const db = openDb(DB_PATH);

// связка: (chatId:messageId) -> [{chatId, messageId}] админских сообщений
const questionToAdminMessages = new Map();
const MAX_LINKS = 500;

function makeKey(chatId, messageId) {
	return `${chatId}:${messageId}`;
}

async function safeDeleteMessage(chatId, messageId) {
	try {
		await bot.deleteMessage(chatId, messageId);
		return true;
	} catch {
		return false;
	}
}

// ===== init db =====
(async () => {
	await db.init();
	await db.seedSuperAdmins(SUPER_ADMINS);
	console.log("DB ready:", DB_PATH);
	if (SUPER_ADMINS.length) console.log("Super admins:", SUPER_ADMINS.join(", "));
})().catch(err => {
	console.error("DB init failed", err);
	process.exit(1);
});

// ===== /start =====
bot.onText(/\/start/i, msg => {
	const isGroup = msg.chat.type !== "private";
	const help = [
		"Привет! Я приношу случайные вопросы ЧГК.",
		isGroup
			? "В чате вызывайте команду /quest (или /quest@BotName)."
			: "Напиши /quest, чтобы получить новый вопрос.",
		"",
		"Админы по чатам:",
		"1) В нужном чате: /admin_here",
		"2) В личке со мной: /admin_list, /admin_add <id>, /admin_del <id>"
	];
	bot.sendMessage(msg.chat.id, help.join("\n"));
});

// ===== /quest =====
const QUEST_COMMAND = /\/quest(?:@[\w_]+)?/i;

bot.onText(QUEST_COMMAND, async msg => {
	await db.logEvent({
		event_type: "quest",
		chat_id: msg.chat.id,
		chat_type: msg.chat.type,
		user_id: msg.from?.id,
		username: msg.from?.username || null,
		first_name: msg.from?.first_name || null,
		last_name: msg.from?.last_name || null,
		ok: 1
	});
	try {

		const question = await fetchRandomQuestion();

		// 1) вопрос в чат (без ответов)
		const userText = formatQuestionForUser(question);
		const sentQuestion = await bot.sendMessage(msg.chat.id, userText, {
			parse_mode: "HTML",
			disable_web_page_preview: true,
			reply_markup: {
				inline_keyboard: [[{ text: "Удалить вопрос", callback_data: "delete_question" }]]
			}
		});

		// 2) админам этого чата — ответ
		const enabled = await db.isEnabledForChat(msg.chat.id);
		if (!enabled) return;

		const adminIds = await db.getAdminsForChat(msg.chat.id);
		if (!adminIds.length) return;

		const adminText = formatQuestionForAdmins(question, msg);
		const adminMessageIds = [];

		for (const adminUserId of adminIds) {
			try {
				const a = await bot.sendMessage(adminUserId, adminText, {
					parse_mode: "HTML",
					disable_web_page_preview: true
				});
				adminMessageIds.push({ chatId: adminUserId, messageId: a.message_id });
			} catch (e) {
				// чаще всего: 403 (admin не нажал /start в личке)
				console.error(`Admin notify failed to user ${adminUserId}`, e?.message || e);
			}
		}

		if (adminMessageIds.length) {
			const key = makeKey(sentQuestion.chat.id, sentQuestion.message_id);
			questionToAdminMessages.set(key, adminMessageIds);

			if (questionToAdminMessages.size > MAX_LINKS) {
				const firstKey = questionToAdminMessages.keys().next().value;
				questionToAdminMessages.delete(firstKey);
			}
		}
	} catch (error) {
		await db.logEvent({
			event_type: "quest",
			chat_id: msg.chat.id,
			chat_type: msg.chat.type,
			user_id: msg.from?.id,
			username: msg.from?.username || null,
			first_name: msg.from?.first_name || null,
			last_name: msg.from?.last_name || null,
			ok: 0,
			meta: { error: String(error?.message || error) }
		});

		console.error("Failed to send question", error);
		await bot.sendMessage(msg.chat.id, "Не смог получить вопрос, попробуйте еще раз через минуту.");
	}
});

// ===== delete button =====
bot.on("callback_query", async query => {
	await db.logEvent({
		event_type: "delete_question",
		chat_id: query.message.chat.id,
		chat_type: query.message.chat.type,
		user_id: query.from?.id,
		username: query.from?.username || null,
		first_name: query.from?.first_name || null,
		last_name: query.from?.last_name || null,
		ok: 1
	});
	if (query.data !== "delete_question" || !query.message) {
		return bot.answerCallbackQuery(query.id);
	}

	try {
		const chatId = query.message.chat.id;
		const messageId = query.message.message_id;

		// удалить вопрос в чате
		await safeDeleteMessage(chatId, messageId);

		// удалить связанные админские сообщения (если были)
		const key = makeKey(chatId, messageId);
		const adminMsgs = questionToAdminMessages.get(key) || [];
		for (const m of adminMsgs) {
			await safeDeleteMessage(m.chatId, m.messageId);
		}
		questionToAdminMessages.delete(key);

		await bot.answerCallbackQuery(query.id);
	} catch (error) {
		console.error("Failed to delete message(s)", error);
		await bot.answerCallbackQuery(query.id, {
			text: "Не получилось удалить сообщение.",
			show_alert: true
		});
	}
});

bot.on("polling_error", console.error);


bot.onText(/^\/stats(?:\s+(\d+))?$/i, async (msg, m) => {
	const days = m?.[1] ? Number(m[1]) : 30;

	// только супер-админ
	if (!(await db.isSuperAdmin(msg.from.id))) {
		return bot.sendMessage(msg.chat.id, "Нет прав.");
	}

	const sum = await db.getStatsSummary(days);
	const topUsers = await db.getTopUsers(days, 10);
	const topChats = await db.getTopChats(days, 10);

	const lines = [];
	lines.push(`📊 Статистика за ${days} дн.`);
	lines.push(`• Всего событий: ${sum.total_events}`);
	lines.push(`• Успешно: ${sum.ok_events}, Ошибки: ${sum.fail_events}`);
	lines.push(`• Уникальных пользователей: ${sum.unique_users}`);
	lines.push(`• Уникальных чатов: ${sum.unique_chats}`);
	lines.push("");

	lines.push("👤 Топ пользователей (/quest):");
	if (!topUsers.length) lines.push("— нет данных —");
	for (const u of topUsers) {
		lines.push(`• ${u.user_id} (${u.name || "unknown"}): ${u.cnt}`);
	}
	lines.push("");

	lines.push("💬 Топ чатов (/quest):");
	if (!topChats.length) lines.push("— нет данных —");
	for (const c of topChats) {
		lines.push(`• ${c.chat_id} [${c.chat_type}]: ${c.cnt}`);
	}

	return bot.sendMessage(msg.chat.id, lines.join("\n"));
});

// ===== Админка по чатам =====

// в чате: выбрать текущий чат для настройки в личке
bot.onText(/^\/admin_here(?:@[\w_]+)?$/i, async msg => {
	if (msg.chat.type === "private") {
		return bot.sendMessage(msg.chat.id, "Эту команду вызывай именно в том чате, который хочешь настроить.");
	}

	try {
		// права: либо супер-админ, либо уже админ чата
		const allowed = await db.canManageChat(msg.chat.id, msg.from.id);
		if (!allowed) {
			return bot.sendMessage(msg.chat.id, "Нет прав. (Нужен супер-админ или ты должен быть админом этого чата)");
		}

		await db.setUserChatContext(msg.from.id, msg.chat.id);
		await bot.sendMessage(msg.chat.id, "Ок. Чат выбран. Дальше продолжай в личке: /admin_list, /admin_add <id>, /admin_del <id>");
	} catch (e) {
		console.error(e);
		await bot.sendMessage(msg.chat.id, "Не смог сохранить контекст чата.");
	}
});

// в личке: показать выбранный чат
bot.onText(/^\/admin_chat$/i, async msg => {
	if (msg.chat.type !== "private") return;

	const chatId = await db.getUserChatContext(msg.from.id);
	if (!chatId) return bot.sendMessage(msg.chat.id, "Контекст не выбран. В нужном чате вызови /admin_here.");

	return bot.sendMessage(msg.chat.id, `Текущий выбранный чат: ${chatId}`);
});

// в личке: вручную выбрать чат (только супер-админ)
bot.onText(/^\/admin_chat\s+(-?\d+)$/i, async (msg, m) => {
	if (msg.chat.type !== "private") return;

	const ok = await db.isSuperAdmin(msg.from.id);
	if (!ok) return bot.sendMessage(msg.chat.id, "Только для супер-админа.");

	const chatId = Number(m[1]);
	await db.setUserChatContext(msg.from.id, chatId);
	return bot.sendMessage(msg.chat.id, `Ок. Выбран чат ${chatId}.`);
});

// в личке: список админов чата
bot.onText(/^\/admin_list$/i, async msg => {
	if (msg.chat.type !== "private") return;

	const chatId = await db.getUserChatContext(msg.from.id);
	if (!chatId) return bot.sendMessage(msg.chat.id, "Сначала в нужном чате вызови /admin_here.");

	if (!(await db.canManageChat(chatId, msg.from.id))) {
		return bot.sendMessage(msg.chat.id, "Нет прав управлять админами этого чата.");
	}

	const admins = await db.listChatAdmins(chatId);
	const text = admins.length
		? `Админы чата ${chatId}:\n` + admins.map(a => `- ${a.admin_user_id}`).join("\n")
		: `В чате ${chatId} пока нет админов.`;

	return bot.sendMessage(msg.chat.id, text);
});

// в личке: добавить админа
bot.onText(/^\/admin_add\s+(\d+)$/i, async (msg, m) => {
	if (msg.chat.type !== "private") return;

	const adminUserId = Number(m[1]);
	const chatId = await db.getUserChatContext(msg.from.id);
	if (!chatId) return bot.sendMessage(msg.chat.id, "Сначала в нужном чате вызови /admin_here.");

	if (!(await db.canManageChat(chatId, msg.from.id))) {
		return bot.sendMessage(msg.chat.id, "Нет прав управлять админами этого чата.");
	}

	await db.addChatAdmin(chatId, adminUserId, msg.from.id);
	return bot.sendMessage(msg.chat.id, `Ок. Добавил ${adminUserId} в админы чата ${chatId}.`);
});

// в личке: удалить админа
bot.onText(/^\/admin_del\s+(\d+)$/i, async (msg, m) => {
	if (msg.chat.type !== "private") return;

	const adminUserId = Number(m[1]);
	const chatId = await db.getUserChatContext(msg.from.id);
	if (!chatId) return bot.sendMessage(msg.chat.id, "Сначала в нужном чате вызови /admin_here.");

	if (!(await db.canManageChat(chatId, msg.from.id))) {
		return bot.sendMessage(msg.chat.id, "Нет прав управлять админами этого чата.");
	}

	await db.delChatAdmin(chatId, adminUserId);
	return bot.sendMessage(msg.chat.id, `Ок. Удалил ${adminUserId} из админов чата ${chatId}.`);
});

// (опционально) включить/выключить отправку ответов для чата
bot.onText(/^\/admin_on$/i, async msg => {
	if (msg.chat.type !== "private") return;

	const chatId = await db.getUserChatContext(msg.from.id);
	if (!chatId) return bot.sendMessage(msg.chat.id, "Сначала в нужном чате вызови /admin_here.");
	if (!(await db.canManageChat(chatId, msg.from.id))) return bot.sendMessage(msg.chat.id, "Нет прав.");

	await db.setEnabledForChat(chatId, true);
	return bot.sendMessage(msg.chat.id, `Ок. Для чата ${chatId} отправка ответов включена.`);
});

bot.onText(/^\/admin_off$/i, async msg => {
	if (msg.chat.type !== "private") return;

	const chatId = await db.getUserChatContext(msg.from.id);
	if (!chatId) return bot.sendMessage(msg.chat.id, "Сначала в нужном чате вызови /admin_here.");
	if (!(await db.canManageChat(chatId, msg.from.id))) return bot.sendMessage(msg.chat.id, "Нет прав.");

	await db.setEnabledForChat(chatId, false);
	return bot.sendMessage(msg.chat.id, `Ок. Для чата ${chatId} отправка ответов выключена.`);
});
