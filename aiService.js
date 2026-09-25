'use strict';

/**
 * aiService.js
 * ---------------------------------------------------------------------------
 * Esteira tripla sequencial para geração de blocos de e-book:
 *
 *   ETAPA 1 -> "O Arquiteto Denso"        (preferência: Gemini, depois Groq, depois Mistral)
 *   ETAPA 2 -> "O Refinador de Cadência"  (preferência: Groq, depois Mistral, depois Gemini)
 *   ETAPA 3 -> "O Humanizador Executivo"  (preferência: Mistral, depois Gemini, depois Groq)
 *
 * As 18 chaves (6 Gemini + 6 Groq + 6 Mistral) funcionam como UM ÚNICO ANEL
 * de resiliência: se as 6 chaves do provedor preferido de uma etapa falharem
 * (cota esgotada, 429, 500, timeout), o sistema passa a usar as chaves dos
 * outros dois provedores para realizar aquele mesmo trabalho, em vez de
 * ficar parado esperando só um provedor voltar. Só se as 18 chaves falharem
 * na mesma rodada é que o serviço faz uma PAUSA TÉCNICA de 10s e tenta tudo
 * de novo, por até 3 rodadas — depois disso, desiste do bloco de forma
 * controlada (avisando "tente mais tarde") em vez de travar para sempre.
 * ---------------------------------------------------------------------------
 */

const fetch = require('node-fetch');

const REQUEST_TIMEOUT_MS = 15_000; // timeout individual por chamada (AbortController)
const TECHNICAL_PAUSE_MS = 10_000; // pausa técnica quando as 18 chaves falham numa rodada
const MAX_GLOBAL_ROUNDS = 3; // rodadas completas pelas 18 chaves antes de desistir deste bloco

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
// Motor de resiliência TOTAL: para cada etapa, tenta primeiro o provedor
// preferido (percorrendo suas 6 chaves) e, se todas falharem, passa para o
// PRÓXIMO PROVEDOR (as outras 6 chaves), e depois o terceiro — usando as
// 18 chaves como um único anel, não 3 anéis isolados. Só se as 18 chaves
// falharem na mesma rodada é que o sistema faz uma pausa técnica de 10s e
// tenta tudo de novo. Depois de MAX_GLOBAL_ROUNDS rodadas sem sucesso,
// desiste deste bloco de forma controlada (nunca trava para sempre).
// -----------------------------------------------------------------------
async function callWithFullResilience(providerOrder, prompt, roleLabel) {
  let lastError = null;

  for (let round = 1; round <= MAX_GLOBAL_ROUNDS; round += 1) {
    for (const provider of providerOrder) {
      const pool = pools[provider];
      const caller = CALLERS[provider];
      if (!pool || pool.length === 0) continue; // provedor sem chaves configuradas, pula

      const startIndex = nextStartIndex(provider);
      for (let offset = 0; offset < pool.length; offset += 1) {
        const keyIndex = (startIndex + offset) % pool.length;
        const apiKey = pool[keyIndex];
        try {
          log(roleLabel, `Tentando ${provider} chave #${keyIndex + 1}/${pool.length} (rodada ${round}/${MAX_GLOBAL_ROUNDS})`);
          const result = await caller(apiKey, prompt);
          log(roleLabel, `Sucesso com ${provider} chave #${keyIndex + 1} na rodada ${round}.`);
          return result;
        } catch (error) {
          lastError = error;
          log(roleLabel, `Falha em ${provider} chave #${keyIndex + 1}: ${error.message}.`);
        }
      }
      log(roleLabel, `Todas as chaves de ${provider} falharam. Passando para o próximo provedor disponível.`);
    }

    if (round >= MAX_GLOBAL_ROUNDS) break;

    // As 18 chaves falharam nesta rodada.
    log(
      roleLabel,
      `As 18 chaves falharam na rodada ${round} (último erro: ${
        lastError ? lastError.message : 'desconhecido'
      }). Pausa técnica de ${TECHNICAL_PAUSE_MS / 1000}s antes de tentar novamente.`
    );
    await sleep(TECHNICAL_PAUSE_MS);
  }

  // Esgotou as rodadas com as 18 chaves: desiste deste bloco de forma controlada.
  const finalError = new Error(
    `As 18 chaves (Gemini + Groq + Mistral) falharam após ${MAX_GLOBAL_ROUNDS} rodadas para a etapa "${roleLabel}". ` +
      `Último erro: ${lastError ? lastError.message : 'desconhecido'}. ` +
      `Tente novamente este mesmo bloco mais tarde — os blocos já gerados com sucesso não são perdidos.`
  );
  finalError.retryable = true;
  throw finalError;
}

// -----------------------------------------------------------------------
// Construtores de prompt dinâmicos por etapa, adaptados a niche/tone/audience
// -----------------------------------------------------------------------

function buildArchitectPrompt({ bookTitle, chapterTitle, blockNumber, niche, targetAudience, tone, recentContext, bookDescription, blocksPerChapter, language }) {
  const lang = language || 'português do Brasil';
  return `Você é um autor especialista em "${niche}", escrevendo um e-book profissional chamado "${bookTitle}", em ${lang}.
${bookDescription ? `\nSOBRE O LIVRO: ${bookDescription}\n` : ''}
CAPÍTULO ATUAL: "${chapterTitle}"
BLOCO: ${blockNumber} de ${blocksPerChapter || 8} (aproximadamente 350 a 400 palavras neste bloco)
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
  const { bookTitle, chapterTitle, blockNumber, niche, targetAudience, tone, recentContext, bookDescription, blocksPerChapter, language } = params;

  // ETAPA 1 — Gemini 1.5 Flash ("O Arquiteto Denso")
  const architectPrompt = buildArchitectPrompt({
    bookTitle,
    chapterTitle,
    blockNumber,
    niche,
    targetAudience,
    tone,
    recentContext,
    bookDescription,
    blocksPerChapter,
    language,
  });
  const draftText = await callWithFullResilience(
    ['gemini', 'groq', 'mistral'],
    architectPrompt,
    'ETAPA 1 - Arquiteto Denso'
  );

  // ETAPA 2 — Groq / Llama 3.3 70B ("O Refinador de Cadência")
  const cadencePrompt = buildCadenceRefinerPrompt({
    bookTitle,
    chapterTitle,
    niche,
    targetAudience,
    tone,
    draftText,
  });
  const refinedText = await callWithFullResilience(
    ['groq', 'mistral', 'gemini'],
    cadencePrompt,
    'ETAPA 2 - Refinador de Cadência'
  );

  // ETAPA 3 — Mistral Small ("O Humanizador Executivo")
  const humanizerPrompt = buildHumanizerPrompt({
    bookTitle,
    niche,
    tone,
    targetAudience,
    refinedText,
  });
  const finalText = await callWithFullResilience(
    ['mistral', 'gemini', 'groq'],
    humanizerPrompt,
    'ETAPA 3 - Humanizador Executivo'
  );

  return {
    blockNumber,
    text: finalText,
    wordCount: finalText.split(/\s+/).filter(Boolean).length,
  };
}

// -----------------------------------------------------------------------
// Esboço automático: a IA decide subtítulo + títulos dos capítulos,
// para a pessoa não precisar digitar nada disso.
// -----------------------------------------------------------------------
async function generateOutline({ bookTitle, niche, targetAudience, tone, numChapters, language }) {
  const lang = language || 'português do Brasil';
  const prompt = `Você é um editor-chefe especialista em "${niche}". Vai planejar a estrutura de um e-book chamado "${bookTitle}", escrito em ${lang}, para o público "${targetAudience}", com tom "${tone}".

TAREFA: Responda APENAS com um JSON válido (sem markdown, sem \`\`\`, sem texto antes ou depois), no formato exato:
{
  "subtitle": "um subtítulo curto e atrativo para o livro",
  "description": "um resumo de 2 a 3 frases sobre do que trata o livro e o que o leitor vai aprender",
  "chapters": ["Título do Capítulo 1", "Título do Capítulo 2", ...]
}

A lista "chapters" deve ter EXATAMENTE ${numChapters} títulos, em ordem lógica de progressão (do básico ao avançado, ou de um problema até a solução completa), específicos para o nicho "${niche}" — nunca genéricos como "Capítulo 1", "Introdução" sozinha, etc.`;

  const raw = await callWithFullResilience(['gemini', 'groq', 'mistral'], prompt, 'ESBOÇO - Sumário Automático');

  const cleaned = raw
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      parsed = JSON.parse(match[0]);
    } else {
      throw new Error('A IA não devolveu um esboço em formato válido. Tente novamente.');
    }
  }

  if (!Array.isArray(parsed.chapters) || parsed.chapters.length === 0) {
    throw new Error('O esboço veio sem lista de capítulos. Tente novamente.');
  }

  return {
    subtitle: parsed.subtitle || '',
    description: parsed.description || '',
    chapters: parsed.chapters.slice(0, numChapters),
  };
}

module.exports = {
  generateBlock,
  generateOutline,
  callWithFullResilience,
  pools,
};
