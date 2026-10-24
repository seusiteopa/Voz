// Netlify Function: vídeo com o Google.
// - Gemini transforma a ideia solta num prompt detalhado
// - Gemini Omni Flash gera o vídeo (com áudio e fala, feitos pelo próprio modelo)
//   pela Interactions API (o Veo 3.1 foi desligado para contas novas).
// A chave fica só no servidor, na variável de ambiente GOOGLE_API_KEY.
//
// Como o vídeo demora e a função do Netlify tem tempo curto, o trabalho é
// dividido em 3 ações rápidas: melhorar, iniciar, status.

const BASE = "https://generativelanguage.googleapis.com/v1beta";
// Do mais leve e rápido ao mais completo. Se um estiver lotado ou demorar, tenta o próximo.
const MODELOS_TEXTO = [
  { nome: "gemini-3.5-flash-lite" },
  { nome: "gemini-3.8-flash", pensar: "low" },
  { nome: "gemini-3.7-flash", pensar: "low" },
];
const TEMPO_MAX_MS = 8500; // o Netlify corta a função por volta de 10 s
const MODELO_VIDEO = "gemini-omni-1.1-flash";
const LIMITE_BASE64 = 5.6 * 1024 * 1024; // a resposta da função no Netlify aceita ~6 MB

const SISTEMA = `Você é diretor de vídeo e escreve prompts para o Gemini Omni Flash, que gera UM clipe curto (cerca de 8 a 10 segundos) com áudio.
Transforme a ideia da pessoa em um prompt detalhado, em um único parágrafo, que inclua:
- cena, ambiente e personagens (aparência, roupa, expressão);
- ação principal, do começo ao fim do clipe;
- câmera (plano, movimento), iluminação e estilo visual;
- áudio: som ambiente e trilha;
- se houver fala, escreva a fala entre aspas, curta o bastante para caber no clipe, e diga que a fala é em português do Brasil.
Por padrão o modelo faz vários planos e cortes. Se a pessoa não pedir cortes, escreva "em um único plano contínuo, sem cortes de cena".
Não coloque textos nem legendas na tela, a menos que a pessoa peça. Se vier uma imagem, ela é o primeiro quadro do vídeo: descreva o movimento a partir dela e mantenha o que aparece nela.
Se a pessoa pedir um vídeo longo (por exemplo, um minuto), escreva o prompt só do primeiro clipe curto.
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
      const inicio = Date.now();
      let ultimoErro = "Nenhum modelo respondeu a tempo.";
      for (const m of MODELOS_TEXTO) {
        // se este modelo tem "pensar", tenta com e, se der erro 400, sem
        const tentativas = m.pensar ? [true, false] : [false];
        for (const comPensar of tentativas) {
          const restante = TEMPO_MAX_MS - (Date.now() - inicio);
          if (restante < 1500) return json(504, { erro: ultimoErro });
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), restante);
          try {
            const gc = { maxOutputTokens: 1500 };
            if (comPensar) gc.thinkingConfig = { thinkingLevel: m.pensar };
            const r = await fetch(`${BASE}/models/${m.nome}:generateContent`, {
              method: "POST", headers: H, signal: ctrl.signal,
              body: JSON.stringify({
                system_instruction: { parts: [{ text: SISTEMA }] },
                contents: [{ role: "user", parts: partes }],
                generationConfig: gc,
              }),
            });
            const t = await r.text();
            if (r.ok) {
              const j = JSON.parse(t);
              const prompt = (j.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("").trim();
              if (prompt) return json(200, { prompt });
              ultimoErro = "O Gemini (" + m.nome + ") não devolveu texto.";
              break; // próximo modelo
            }
            ultimoErro = "Google (" + m.nome + "): " + msgGoogle(t);
            if (r.status === 401 || r.status === 403) return json(r.status, { erro: ultimoErro }); // problema na chave
            if (r.status === 400 && comPensar) continue; // tenta o mesmo modelo sem "pensar"
            break; // lotado, não existe etc.: próximo modelo
          } catch (e) {
            ultimoErro = e.name === "AbortError" ? "O Gemini (" + m.nome + ") demorou demais." : "Falha ao falar com o Google: " + e.message;
            break; // próximo modelo
          } finally {
            clearTimeout(timer);
          }
        }
      }
      return json(502, { erro: ultimoErro });
    }

    // 2) Gemini Omni começa a gerar em segundo plano (devolve o código da interação)
    if (d.acao === "iniciar") {
      const prompt = String(d.prompt || "").trim().slice(0, 4000);
      if (!prompt) return json(400, { erro: "Prompt vazio." });
      const proporcao = ["9:16", "16:9"].includes(d.proporcao) ? d.proporcao : "9:16";
      let entrada = prompt;
      if (d.imagem) {
        // a imagem vira o primeiro quadro do vídeo
        entrada = [
          { type: "image", data: d.imagem, mime_type: d.mimeType || "image/jpeg" },
          { type: "text", text: "<FIRST_FRAME> " + prompt },
        ];
      }
      const r = await fetch(`${BASE}/interactions`, {
        method: "POST", headers: H,
        body: JSON.stringify({
          model: MODELO_VIDEO,
          input: entrada,
          response_format: { type: "video", aspect_ratio: proporcao, resolution: "720p" },
          background: true,
        }),
      });
      const t = await r.text();
      if (!r.ok) return json(r.status, { erro: "Google: " + msgGoogle(t) });
      const j = JSON.parse(t);
      if (!j.id) return json(502, { erro: "O Google não devolveu o código do vídeo." });
      return json(200, { operacao: j.id });
    }

    // 3) Pergunta se o vídeo já ficou pronto; se ficou, já devolve o mp4
    if (d.acao === "status") {
      const id = String(d.operacao || "");
      if (!/^[\w\-]{3,200}$/.test(id)) return json(400, { erro: "Código do vídeo inválido." });
      const r = await fetch(`${BASE}/interactions/${id}`, { headers: { "x-goog-api-key": chave } });
      const t = await r.text();
      if (!r.ok) return json(r.status, { erro: "Google: " + msgGoogle(t) });
      const j = JSON.parse(t);
      const status = String(j.status || "").toLowerCase();
      if (["failed", "cancelled", "canceled", "incomplete", "expired"].includes(status)) {
        // mostra o que o Google devolveu, pra descobrir o motivo (crédito, filtro de segurança etc.)
        const motivo = j.error?.message
          || (j.error ? JSON.stringify(j.error) : "")
          || JSON.stringify({ ...j, steps: (j.steps || []).map(p => ({ type: p.type, content: (p.content || []).map(c => c.text ? { type: c.type, text: String(c.text).slice(0, 200) } : { type: c.type }) })) }).slice(0, 600);
        return json(200, { pronto: true, erro: "Google (" + status + "): " + motivo });
      }
      if (status !== "completed") return json(200, { pronto: false });

      const saida = (j.steps || []).filter(p => p.type === "model_output").flatMap(p => p.content || []);
      const video = saida.find(c => c.type === "video");
      if (!video) {
        const texto = saida.filter(c => c.type === "text").map(c => c.text).join(" ").trim();
        return json(200, { pronto: true, erro: texto ? "O Google respondeu: " + texto.slice(0, 300) : "O Google não devolveu o vídeo. Mude a ideia e tente de novo." });
      }
      let b64 = video.data;
      if (!b64 && video.uri && video.uri.startsWith("https://generativelanguage.googleapis.com/")) {
        const rv = await fetch(video.uri, { headers: { "x-goog-api-key": chave }, redirect: "follow" });
        if (!rv.ok) return json(200, { pronto: true, erro: "Google: não consegui baixar o vídeo (" + rv.status + ")." });
        b64 = Buffer.from(await rv.arrayBuffer()).toString("base64");
      }
      if (!b64) return json(200, { pronto: true, erro: "O Google não devolveu os dados do vídeo." });
      if (b64.length > LIMITE_BASE64) {
        return json(200, { pronto: true, erro: "O vídeo ficou grande demais (" + (b64.length / 1048576).toFixed(1) + " MB) para passar pela função do Netlify. Gere de novo com uma ideia mais simples." });
      }
      return json(200, { pronto: true, mp4: b64 });
    }

    return json(400, { erro: "Ação desconhecida." });
  } catch (e) {
    return json(502, { erro: "Falha ao falar com o Google: " + e.message });
  }
};
