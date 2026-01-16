const https = require("https");
const { JSDOM } = require("jsdom");

function fetchRandomQuestion() {
	return new Promise((resolve, reject) => {
		https
			.get("https://db.chgk.info/random/limit1", res => {
				let body = "";
				res.on("data", chunk => (body += chunk));
				res.on("end", () => {
					try {
						resolve(parseRandomQuestion(body));
					} catch (error) {
						reject(error);
					}
				});
			})
			.on("error", reject);
	});
}

function parseRandomQuestion(html) {
	const dom = new JSDOM(html);
	const doc = dom.window.document;
	const randomBlock = doc.querySelector(".random_question");
	const answerBlock = randomBlock?.querySelector(".collapsible");

	if (!randomBlock || !answerBlock) {
		throw new Error("Не смог разобрать страницу с вопросом");
	}

	const sourceLink = randomBlock.querySelector("p a");
	const sourceTitle = sourceLink?.textContent?.trim() || "";
	const sourceUrl = sourceLink
		? `https://db.chgk.info${sourceLink.getAttribute("href")}`
		: "";

	const rawLabel = randomBlock.querySelector("strong")?.textContent || "";
	const questionLabel = rawLabel.replace(/\s+/g, " ").replace(/:$/, "") || "Вопрос";

	const questionText = extractQuestionText(dom, randomBlock, answerBlock);

	const paragraphs = Array.from(answerBlock.querySelectorAll("p"));
	const answer = extractField(paragraphs, /^Ответ:/i);
	const accept = extractField(paragraphs, /^Зачёт:/i);
	const comment = extractField(paragraphs, /^Комментарий:/i);
	const author = extractField(paragraphs, /^Автор:/i);

	return {
		questionLabel,
		questionText,
		answer,
		accept,
		comment,
		author,
		sourceTitle,
		sourceUrl
	};
}

function extractQuestionText(dom, randomBlock, answerBlock) {
	const Node = dom.window.Node;
	const questionTitle = randomBlock.querySelector("strong");
	let text = "";

	let current = questionTitle ? questionTitle.nextSibling : randomBlock.firstChild;
	while (current && current !== answerBlock) {
		if (current.nodeType === Node.TEXT_NODE) {
			text += current.textContent || "";
		} else if (current.nodeType === Node.ELEMENT_NODE) {
			if (current.tagName === "BR") {
				text += "\n";
			} else if (current.tagName !== "P") {
				text += current.textContent || "";
			}
		}
		current = current.nextSibling;
	}

	return text.replace(/\s+/g, " ").trim();
}

function extractField(paragraphs, matcher) {
	for (const p of paragraphs) {
		const text = (p.textContent || "").replace(/\s+/g, " ").trim();
		if (!matcher.test(text)) continue;
		return text.replace(matcher, "").trim();
	}
	return "";
}

function escapeHtml(str = "") {
	return str
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

function formatQuestionForUser(question) {
	const parts = [];

	if (question.sourceTitle) {
		const titleLink = question.sourceUrl
			? `<a href="${escapeHtml(question.sourceUrl)}">${escapeHtml(question.sourceTitle)}</a>`
			: escapeHtml(question.sourceTitle);
		parts.push(`🎲 ${titleLink}`);
	} else {
		parts.push("🎲 Случайный вопрос");
	}

	parts.push("");
	parts.push(`❓ <b>${escapeHtml(question.questionLabel)}</b> ${escapeHtml(question.questionText)}`);

	return parts.filter(Boolean).join("\n");
}

function formatQuestionForAdmins(question, msg) {
	const parts = [];
	parts.push("🛡 <b>Ответ админам</b>");

	const who = [
		msg.from?.username ? `@${msg.from.username}` : null,
		[msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(" ").trim() || null,
		msg.from?.id ? `id:${msg.from.id}` : null
	]
		.filter(Boolean)
		.join(" | ");

	const where = `${msg.chat?.type || "chat"}:${msg.chat?.id}`;

	parts.push(`👤 ${escapeHtml(who || "unknown")}`);
	parts.push(`📍 ${escapeHtml(where)}`);

	if (question.sourceTitle) {
		const titleLink = question.sourceUrl
			? `<a href="${escapeHtml(question.sourceUrl)}">${escapeHtml(question.sourceTitle)}</a>`
			: escapeHtml(question.sourceTitle);
		parts.push(`🔗 ${titleLink}`);
	}

	parts.push("");
	parts.push(`❓ <b>${escapeHtml(question.questionLabel)}</b> ${escapeHtml(question.questionText)}`);

	if (question.accept) {
		parts.push(`<tg-spoiler>✅ Зачёт: ${escapeHtml(question.accept)}</tg-spoiler>`);
	}
	if (question.comment) {
		parts.push(`<tg-spoiler>💬 Комментарий: ${escapeHtml(question.comment)}</tg-spoiler>`);
	}

	parts.push(
		`<tg-spoiler>💡 Ответ: ${escapeHtml(question.answer || "Не удалось получить ответ")}</tg-spoiler>`
	);

	if (question.author) {
		parts.push(`✍️ ${escapeHtml(question.author)}`);
	}

	return parts.filter(Boolean).join("\n");
}

module.exports = {
	fetchRandomQuestion,
	formatQuestionForUser,
	formatQuestionForAdmins
};
