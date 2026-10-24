// Netlify Function: vídeo com o Google.
// - Gemini transforma a ideia solta num prompt detalhado
// - Veo gera o vídeo (com áudio e fala, feitos pelo próprio Veo)
// A chave fica só no servidor, na variável de ambiente GOOGLE_API_KEY.
//
// Como o Veo demora (1 a 4 minutos) e a função do Netlify tem tempo curto,
// o trabalho é dividido em 4 ações rápidas: melhorar, iniciar, status, baixar.

const BASE = "https://generativelanguage.googleapis.com/v1beta";
const MODELO_TEXTO = "gemini-2.5-flash";
const MODELO_VIDEO = "veo-3.1-generate-preview";
const LIMITE_MP4 = 4.5 * 1024 * 1024; // resposta da função no Netlify aceita ~6 MB (em base64)

const SISTEMA = `Você é diretor de vídeo e escreve prompts para o modelo Veo 3.1, que gera UM clipe de 8 segundos com áudio.
Transforme a ideia da pessoa em um prompt detalhado, em um único parágrafo, que inclua:
- cena, ambiente e personagens (aparência, roupa, expressão);
- ação principal, do começo ao fim dos 8 segundos;
- câmera (plano, movimento), iluminação e estilo visual;
- áudio: som ambiente e trilha;
- se houver fala, escreva a fala entre aspas, em português do Brasil, curta o bastante para caber em 8 segundos.
Não coloque textos nem legendas na tela. Se vier uma imagem, ela é o primeiro quadro do vídeo: descreva o movimento a partir dela e mantenha o que aparece nela.
Responda somente com o prompt, sem títulos e sem explicações.`;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (status, obj) => ({
  statusCode: status,
  headers: { ...cors, "Content-Type": "application/json" },
  body: JSON.stringify(obj),
});

function msgGoogle(texto) {
  try { return JSON.parse(texto).error.message; } catch { return texto.slice(0, 300); }
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: cors, body: "" };
  if (event.httpMethod !== "POST") return json(405, { erro: "Use POST." });

  const chave = process.env.GOOGLE_API_KEY;
  if (!chave) return json(500, { erro: "Variável GOOGLE_API_KEY não configurada no Netlify." });

  let d;
  try { d = JSON.parse(event.body || "{}"); }
  catch { return json(400, { erro: "JSON inválido." }); }

  const H = { "x-goog-api-key": chave, "Content-Type": "application/json" };

  try {
    // 1) Gemini melhora a ideia
    if (d.acao === "melhorar") {
      const ideia = String(d.ideia || "").trim().slice(0, 2000);
      if (!ideia && !d.imagem) return json(400, { erro: "Escreva a ideia ou envie uma imagem." });
      const partes = [];
      if (d.imagem) partes.push({ inline_data: { mime_type: d.mimeType || "image/jpeg", data: d.imagem } });
      partes.push({ text: "Ideia da pessoa: " + (ideia || "(sem texto, use só a imagem)") });
      const r = await fetch(`${BASE}/models/${MODELO_TEXTO}:generateContent`, {
        method: "POST", headers: H,
        body: JSON.stringify({
          system_instruction: { parts: [{ text: SISTEMA }] },
          contents: [{ role: "user", parts: partes }],
          generationConfig: { temperature: 0.8 },
        }),
      });
      const t = await r.text();
      if (!r.ok) return json(r.status, { erro: "Google: " + msgGoogle(t) });
      const j = JSON.parse(t);
      const prompt = (j.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("").trim();
      if (!prompt) return json(502, { erro: "O Gemini não devolveu texto. Tente de novo." });
      return json(200, { prompt });
    }

    // 2) Veo começa a gerar (devolve o nome da operação)
    if (d.acao === "iniciar") {
      const prompt = String(d.prompt || "").trim().slice(0, 4000);
      if (!prompt) return json(400, { erro: "Prompt vazio." });
      const instancia = { prompt };
      if (d.imagem) instancia.image = { bytesBase64Encoded: d.imagem, mimeType: d.mimeType || "image/jpeg" };
      const proporcao = ["9:16", "16:9"].includes(d.proporcao) ? d.proporcao : "9:16";
      const r = await fetch(`${BASE}/models/${MODELO_VIDEO}:predictLongRunning`, {
        method: "POST", headers: H,
        body: JSON.stringify({ instances: [instancia], parameters: { aspectRatio: proporcao } }),
      });
      const t = await r.text();
      if (!r.ok) return json(r.status, { erro: "Google: " + msgGoogle(t) });
      const j = JSON.parse(t);
      if (!j.name) return json(502, { erro: "O Google não devolveu o código da operação." });
      return json(200, { operacao: j.name });
    }

    // 3) Pergunta se o vídeo já ficou pronto
    if (d.acao === "status") {
      const op = String(d.operacao || "");
      if (!/^models\/[\w.\-]+\/operations\/[\w\-]+$/.test(op)) return json(400, { erro: "Operação inválida." });
      const r = await fetch(`${BASE}/${op}`, { headers: { "x-goog-api-key": chave } });
      const t = await r.text();
      if (!r.ok) return json(r.status, { erro: "Google: " + msgGoogle(t) });
      const j = JSON.parse(t);
      if (!j.done) return json(200, { pronto: false });
      if (j.error) return json(200, { pronto: true, erro: "Google: " + (j.error.message || "falha ao gerar") });
      const resp = j.response?.generateVideoResponse || {};
      const uri = resp.generatedSamples?.[0]?.video?.uri;
      if (!uri) {
        const motivo = (resp.raiMediaFilteredReasons || []).join(" ") || "O Google bloqueou ou não devolveu o vídeo. Mude a ideia e tente de novo.";
        return json(200, { pronto: true, erro: motivo });
      }
      return json(200, { pronto: true, uri });
    }

    // 4) Baixa o mp4 e entrega ao navegador
    if (d.acao === "baixar") {
      const uri = String(d.uri || "");
      if (!uri.startsWith("https://generativelanguage.googleapis.com/")) return json(400, { erro: "Endereço do vídeo inválido." });
      const r = await fetch(uri, { headers: { "x-goog-api-key": chave }, redirect: "follow" });
      if (!r.ok) return json(r.status, { erro: "Google: não consegui baixar o vídeo (" + r.status + ")." });
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > LIMITE_MP4) {
        return json(413, { erro: "O vídeo ficou grande demais (" + (buf.length / 1048576).toFixed(1) + " MB) para passar pela função do Netlify. Gere de novo com uma ideia mais simples." });
      }
      return json(200, { mp4: buf.toString("base64") });
    }

    return json(400, { erro: "Ação desconhecida." });
  } catch (e) {
    return json(502, { erro: "Falha ao falar com o Google: " + e.message });
  }
};
