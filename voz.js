// Netlify Function: gera narração com a OpenAI e devolve MP3 em base64.
// A chave fica só no servidor, na variável de ambiente OPENAI_API_KEY.

const MODELOS = ["gpt-4o-mini-tts", "tts-1", "tts-1-hd"];
const VOZES = ["onyx", "echo", "ash", "ballad", "cedar", "alloy", "fable", "nova", "sage", "shimmer", "verse", "coral", "marin"];

exports.handler = async (event) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: cors, body: "" };
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: cors, body: JSON.stringify({ erro: "Use POST." }) };
  }

  const chave = process.env.OPENAI_API_KEY;
  if (!chave) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ erro: "Variável OPENAI_API_KEY não configurada no Netlify." }) };
  }

  let dados;
  try { dados = JSON.parse(event.body || "{}"); }
  catch { return { statusCode: 400, headers: cors, body: JSON.stringify({ erro: "JSON inválido." }) }; }

  const texto = String(dados.texto || "").trim();
  if (!texto) return { statusCode: 400, headers: cors, body: JSON.stringify({ erro: "Texto vazio." }) };
  if (texto.length > 1500) return { statusCode: 400, headers: cors, body: JSON.stringify({ erro: "Texto longo demais (máx. 1500 caracteres por fala)." }) };

  const modelo = MODELOS.includes(dados.modelo) ? dados.modelo : "gpt-4o-mini-tts";
  const voz = VOZES.includes(dados.voz) ? dados.voz : "onyx";
  const velocidade = Math.min(4, Math.max(0.25, Number(dados.velocidade) || 1));

  const corpo = { model: modelo, input: texto, voice: voz, response_format: "mp3", speed: velocidade };
  // "instructions" só funciona no gpt-4o-mini-tts
  if (modelo === "gpt-4o-mini-tts") {
    corpo.instructions = String(dados.estilo || "Fale em português do Brasil, voz masculina grave e calma, tom inspirador e confiante, ritmo de narração para Reels.").slice(0, 600);
  }

  try {
    const r = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: { "Authorization": "Bearer " + chave, "Content-Type": "application/json" },
      body: JSON.stringify(corpo),
    });
    if (!r.ok) {
      const t = await r.text();
      let msg = t;
      try { msg = JSON.parse(t).error.message; } catch {}
      return { statusCode: r.status, headers: cors, body: JSON.stringify({ erro: "OpenAI: " + msg }) };
    }
    const buf = Buffer.from(await r.arrayBuffer());
    return { statusCode: 200, headers: { ...cors, "Content-Type": "application/json" }, body: JSON.stringify({ mp3: buf.toString("base64") }) };
  } catch (e) {
    return { statusCode: 502, headers: cors, body: JSON.stringify({ erro: "Falha ao falar com a OpenAI: " + e.message }) };
  }
};
