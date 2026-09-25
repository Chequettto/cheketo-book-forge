'use strict';

/**
 * aiService.js
 * ---------------------------------------------------------------------------
 * Esteira tripla sequencial para geração de blocos de e-book:
 *
 *   ETAPA 1 (Gemini 1.5 Flash)   -> "O Arquiteto Denso"
 *   ETAPA 2 (Groq / Llama 3.3)   -> "O Refinador de Cadência"
 *   ETAPA 3 (Mistral Small)      -> "O Humanizador Executivo"
 *
 * Cada etapa usa um pool rotativo de 6 chaves (18 no total). Se uma chave
 * falha (429/500/timeout), tenta a próxima chave do mesmo pool. Se as 6
 * chaves do provedor falharem na mesma rodada, o serviço faz uma PAUSA
 * TÉCNICA de 10s e tenta a rodada inteira novamente, indefinidamente, até
 * obter sucesso — nunca descarta o progresso do bloco.
 * ---------------------------------------------------------------------------
 */

const fetch = require('node-fetch');

const REQUEST_TIMEOUT_MS = 15_000; // timeout individual por chamada (AbortController)
const TECHNICAL_PAUSE_MS = 10_000; // pausa técnica quando um pool inteiro falha

// -----------------------------------------------------------------------
// Clichês de IA a eliminar na Etapa 3 (usados no prompt do Humanizador)
// -----------------------------------------------------------------------
const AI_CLICHES = [
  'no mundo moderno',
  'é crucial ressaltar',
  'em suma',
  'além disso',
  'mergulhar fundo',
  'portanto',
  'é importante notar',
  'em um mundo cada vez mais',
  'no cenário atual',
  'vale ressaltar',
  'em última análise',
  'dito isso',
];

// -----------------------------------------------------------------------
// Pools de chaves (18 no total, 6 por provedor)
// -----------------------------------------------------------------------
function buildPool(prefix) {
  const keys = [];
  for (let i = 1; i <= 6; i += 1) {
    const value = process.env[`${prefix}_${i}`];
    if (value && value.trim().length > 0) {
      keys.push(value.trim());
    }
  }
  return keys;
}

const pools = {
  gemini: buildPool('GEMINI_KEY'),
  groq: buildPool('GROQ_KEY'),
  mistral: buildPool('MISTRAL_KEY'),
};

// Cursor de rotação independente por provedor, para distribuir carga entre chamadas
const rotationCursor = { gemini: 0, groq: 0, mistral: 0 };

function nextStartIndex(provider) {
  const pool = pools[provider];
  if (!pool || pool.length === 0) return 0;
  const idx = rotationCursor[provider] % pool.length;
  rotationCursor[provider] = (rotationCursor[provider] + 1) % pool.length;
  return idx;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(stage, message) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [${stage}] ${message}`);
}

// -----------------------------------------------------------------------
// Chamadores HTTP de cada provedor (uma tentativa, uma chave, com timeout)
// -----------------------------------------------------------------------

async function callGeminiOnce(apiKey, prompt) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.9,
          topP: 0.95,
          maxOutputTokens: 2048,
        },
      }),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      const err = new Error(`Gemini HTTP ${response.status}: ${errText.slice(0, 300)}`);
      err.status = response.status;
      throw err;
    }

    const data = await response.json();
    const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('\n');
    if (!text || !text.trim()) {
      throw new Error('Gemini retornou resposta vazia.');
    }
    return text.trim();
  } finally {
    clearTimeout(timer);
  }
}

async function callGroqOnce(apiKey, prompt) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        temperature: 0.85,
        max_tokens: 2048,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      const err = new Error(`Groq HTTP ${response.status}: ${errText.slice(0, 300)}`);
      err.status = response.status;
      throw err;
    }

    const data = await response.json();
    const text = data?.choices?.[0]?.message?.content;
    if (!text || !text.trim()) {
      throw new Error('Groq retornou resposta vazia.');
    }
    return text.trim();
  } finally {
    clearTimeout(timer);
  }
}

async function callMistralOnce(apiKey, prompt) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch('https://api.mistral.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: 'mistral-small-latest',
        temperature: 0.8,
        max_tokens: 2048,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      const err = new Error(`Mistral HTTP ${response.status}: ${errText.slice(0, 300)}`);
      err.status = response.status;
      throw err;
    }

    const data = await response.json();
    const text = data?.choices?.[0]?.message?.content;
    if (!text || !text.trim()) {
      throw new Error('Mistral retornou resposta vazia.');
    }
    return text.trim();
  } finally {
    clearTimeout(timer);
  }
}

const CALLERS = {
  gemini: callGeminiOnce,
  groq: callGroqOnce,
  mistral: callMistralOnce,
};

// -----------------------------------------------------------------------
// Motor de resiliência: percorre as 6 chaves do pool; se todas falharem,
// pausa técnica de 10s e recomeça a rodada — indefinidamente.
// -----------------------------------------------------------------------
async function callWithResilience(provider, prompt, stageLabel) {
  const pool = pools[provider];
  if (!pool || pool.length === 0) {
    throw new Error(
      `Nenhuma chave configurada para o provedor "${provider}". Verifique as variáveis de ambiente ${provider.toUpperCase()}_KEY_1..6.`
    );
  }

  const caller = CALLERS[provider];
  let round = 1;

  // Loop externo: rodadas. Cada rodada percorre todas as chaves do pool.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const startIndex = nextStartIndex(provider);
    let lastError = null;

    for (let offset = 0; offset < pool.length; offset += 1) {
      const keyIndex = (startIndex + offset) % pool.length;
      const apiKey = pool[keyIndex];
      try {
        log(stageLabel, `Tentando chave #${keyIndex + 1}/${pool.length} (rodada ${round})`);
        const result = await caller(apiKey, prompt);
        log(stageLabel, `Sucesso com a chave #${keyIndex + 1} na rodada ${round}.`);
        return result;
      } catch (error) {
        lastError = error;
        log(
          stageLabel,
          `Falha na chave #${keyIndex + 1}: ${error.message}. Alternando para a próxima chave do pool.`
        );
      }
    }

    // Todas as chaves do pool falharam nesta rodada.
    log(
      stageLabel,
      `Todas as ${pool.length} chaves de ${provider} falharam na rodada ${round} (último erro: ${
        lastError ? lastError.message : 'desconhecido'
      }). Pausa técnica de ${TECHNICAL_PAUSE_MS / 1000}s antes de tentar novamente. O bloco NÃO será descartado.`
    );
    await sleep(TECHNICAL_PAUSE_MS);
    round += 1;
  }
}

// -----------------------------------------------------------------------
// Construtores de prompt dinâmicos por etapa, adaptados a niche/tone/audience
// -----------------------------------------------------------------------

function buildArchitectPrompt({ bookTitle, chapterTitle, blockNumber, niche, targetAudience, tone, recentContext }) {
  return `Você é um autor especialista em "${niche}", escrevendo um e-book profissional chamado "${bookTitle}".

CAPÍTULO ATUAL: "${chapterTitle}"
BLOCO: ${blockNumber} de 8 (aproximadamente 350 a 400 palavras neste bloco)
PÚBLICO-ALVO: ${targetAudience}
TOM DESEJADO: ${tone}

CONTEXTO RECENTE (o que já foi escrito nos blocos anteriores, para dar continuidade sem repetir):
"""
${recentContext || '(Este é o primeiro bloco do capítulo — não há contexto anterior.)'}
"""

TAREFA:
Escreva o conteúdo bruto e denso deste bloco, com profundidade real de conteúdo (não superficial), trazendo exemplos, raciocínios e informação de valor prático sobre "${niche}" para o público "${targetAudience}". Mantenha continuidade natural com o contexto anterior, sem repetir o que já foi dito. Não escreva título do capítulo nem numeração de bloco — apenas o texto corrido. Extensão alvo: 350 a 400 palavras.`;
}

function buildCadenceRefinerPrompt({ bookTitle, chapterTitle, niche, targetAudience, tone, draftText }) {
  return `Você é um editor especialista em ritmo e cadência narrativa. Recebeu um rascunho denso para o e-book "${bookTitle}", capítulo "${chapterTitle}" (nicho: ${niche}; público: ${targetAudience}; tom: ${tone}).

RASCUNHO BRUTO:
"""
${draftText}
"""

TAREFA:
Reescreva este texto reestruturando a métrica, o ritmo e a fluidez narrativa. Alterne frases curtas e diretas com frases explicativas mais longas, para criar uma cadência de leitura natural e envolvente, como um autor humano experiente escreveria. Preserve TODO o conteúdo, os exemplos e as ideias do rascunho original — não corte informação, apenas melhore a forma como ela flui. Não adicione título nem comentários, apenas o texto reescrito.`;
}

function buildHumanizerPrompt({ bookTitle, niche, tone, targetAudience, refinedText }) {
  return `Você é um editor executivo especialista em dar voz humana e autêntica a textos, removendo qualquer traço de escrita robótica de IA. Este texto faz parte do e-book "${bookTitle}" (nicho: ${niche}; público: ${targetAudience}; tom: ${tone}).

TEXTO REFINADO:
"""
${refinedText}
"""

TAREFA:
Faça o polimento final de voz humana neste texto:
1. ELIMINE COMPLETAMENTE clichês típicos de IA, incluindo (mas não se limitando a): ${AI_CLICHES.map((c) => `"${c}"`).join(', ')}.
2. Substitua essas expressões por transições e conectores naturais, variados e próprios de um autor humano especialista escrevendo no tom "${tone}".
3. Preserve 100% do conteúdo e do sentido do texto original — não corte informação.
4. Não adicione título, comentários ou explicações sobre o que você fez — devolva apenas o texto final, pronto para publicação.`;
}

// -----------------------------------------------------------------------
// Orquestrador principal: roda as 3 etapas em sequência para 1 bloco
// -----------------------------------------------------------------------
async function generateBlock(params) {
  const { bookTitle, chapterTitle, blockNumber, niche, targetAudience, tone, recentContext } = params;

  // ETAPA 1 — Gemini 1.5 Flash ("O Arquiteto Denso")
  const architectPrompt = buildArchitectPrompt({
    bookTitle,
    chapterTitle,
    blockNumber,
    niche,
    targetAudience,
    tone,
    recentContext,
  });
  const draftText = await callWithResilience('gemini', architectPrompt, 'ETAPA 1 - Arquiteto Denso (Gemini)');

  // ETAPA 2 — Groq / Llama 3.3 70B ("O Refinador de Cadência")
  const cadencePrompt = buildCadenceRefinerPrompt({
    bookTitle,
    chapterTitle,
    niche,
    targetAudience,
    tone,
    draftText,
  });
  const refinedText = await callWithResilience('groq', cadencePrompt, 'ETAPA 2 - Refinador de Cadência (Groq)');

  // ETAPA 3 — Mistral Small ("O Humanizador Executivo")
  const humanizerPrompt = buildHumanizerPrompt({
    bookTitle,
    niche,
    tone,
    targetAudience,
    refinedText,
  });
  const finalText = await callWithResilience('mistral', humanizerPrompt, 'ETAPA 3 - Humanizador Executivo (Mistral)');

  return {
    blockNumber,
    text: finalText,
    wordCount: finalText.split(/\s+/).filter(Boolean).length,
  };
}

module.exports = {
  generateBlock,
  callWithResilience,
  pools,
};
