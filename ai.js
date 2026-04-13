const https = require("https");

async function checkAnswer({ questionText, correctAnswer, accept, userAnswer, attempts = 1 }) {
	// 	const systemPrompt = `Ты судья в игре "Что? Где? Когда?".
	// Тебе дают вопрос, правильный ответ (и зачётные варианты если есть) и ответ игрока.
	// Отвечай СТРОГО только валидным JSON без markdown: {"verdict": "yes"|"close"|"no", "comment": "..."}
	// - yes: ответ верный или близкий к зачёту — можно поздравить
	// - close: почти правильно — дай намёк, но не раскрывай ответ
	// - no: неверно — можно подбодрить, но не раскрывай ответ
	// Комментарий — 1-2 предложения, по-русски.`;


	const hintLevel = attempts === 1
		? "Намёк очень лёгкий — только направление мысли, не более."
		: attempts === 2
			? "Намёк конкретнее — можно назвать область, эпоху, категорию."
			: attempts === 3
				? "Намёк совсем конкретный — почти ответ, но не сам ответ."
				: "Намёк максимально конкретный, можно назвать почти всё кроме самого слова.";

	const systemPrompt = `Ты судья в игре "Что? Где? Когда?".
Оцениваешь ответ игрока и даёшь намёк если он не угадал.
${hintLevel}

Отвечай СТРОГО только валидным JSON без markdown:
{"verdict": "yes"|"close"|"no", "comment": "..."}
- yes: ответ верный или засчитывается по зачёту
- close: почти верно — намекни по правилу выше
- no: неверно — намекни по правилу выше
Никогда не раскрывай правильный ответ полностью.
Обращайся к игроку на "вы", комментарий 1-2 предложения, по-русски.`;

	const userPrompt = `Вопрос: ${questionText}
Правильный ответ: ${correctAnswer}${accept ? `\nЗачётные варианты: ${accept}` : ""}
Ответ игрока: ${userAnswer}`;

	const body = JSON.stringify({
		model: "llama-3.3-70b-versatile",
		max_tokens: 200,
		temperature: 0.3,
		messages: [
			{ role: "system", content: systemPrompt },
			{ role: "user", content: userPrompt }
		]
	});

	return new Promise((resolve, reject) => {
		const req = https.request({
			hostname: "api.groq.com",
			path: "/openai/v1/chat/completions",
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Authorization": `Bearer ${process.env.GROQ_API_KEY}`,
				"Content-Length": Buffer.byteLength(body)
			}
		}, res => {
			let data = "";
			res.on("data", chunk => data += chunk);
			res.on("end", () => {
				try {
					const parsed = JSON.parse(data);

					if (parsed.error) {
						return reject(new Error(parsed.error.message || "Groq error"));
					}

					const text = parsed.choices?.[0]?.message?.content || "{}";
					const clean = text.replace(/```json|```/g, "").trim();
					resolve(JSON.parse(clean));
				} catch (e) {
					reject(new Error("AI parse error: " + e.message));
				}
			});
		});

		req.on("error", reject);
		req.write(body);
		req.end();
	});
}

module.exports = { checkAnswer };