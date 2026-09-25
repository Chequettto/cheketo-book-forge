'use strict';

require('dotenv').config();

const express = require('express');
const cors = require('cors');

const { generateBlock, pools } = require('./aiService');
const { generateCoverUrl } = require('./coverService');

const app = express();
const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// Middlewares
// ---------------------------------------------------------------------------
const corsOrigin = process.env.CORS_ORIGIN && process.env.CORS_ORIGIN !== '*'
  ? process.env.CORS_ORIGIN.split(',').map((o) => o.trim())
  : '*';

app.use(cors({ origin: corsOrigin }));
app.use(express.json({ limit: '2mb' }));

// Log simples de todas as requisições
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ---------------------------------------------------------------------------
// Healthcheck (útil para o Render monitorar o serviço)
// ---------------------------------------------------------------------------
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'ebook-ai-backend',
    keysConfigured: {
      gemini: pools.gemini.length,
      groq: pools.groq.length,
      mistral: pools.mistral.length,
    },
  });
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'healthy', uptimeSeconds: process.uptime() });
});

// ---------------------------------------------------------------------------
// POST /api/generate-block
// Gera 1 bloco (~350-400 palavras) de um capítulo, passando pela esteira
// tripla sequencial (Gemini -> Groq -> Mistral). Dividido em blocos pequenos
// para nunca ultrapassar o timeout de 30s do Render.
// ---------------------------------------------------------------------------
app.post('/api/generate-block', async (req, res) => {
  const { bookTitle, chapterTitle, blockNumber, niche, targetAudience, tone, recentContext } = req.body || {};

  const missing = [];
  if (!bookTitle) missing.push('bookTitle');
  if (!chapterTitle) missing.push('chapterTitle');
  if (!blockNumber) missing.push('blockNumber');
  if (!niche) missing.push('niche');
  if (!targetAudience) missing.push('targetAudience');
  if (!tone) missing.push('tone');

  if (missing.length > 0) {
    return res.status(400).json({
      error: 'Campos obrigatórios ausentes no body.',
      missingFields: missing,
    });
  }

  const blockNum = Number(blockNumber);
  if (!Number.isInteger(blockNum) || blockNum < 1 || blockNum > 8) {
    return res.status(400).json({
      error: 'blockNumber deve ser um número inteiro entre 1 e 8.',
    });
  }

  try {
    const result = await generateBlock({
      bookTitle,
      chapterTitle,
      blockNumber: blockNum,
      niche,
      targetAudience,
      tone,
      recentContext: recentContext || '',
    });

    return res.json({
      success: true,
      bookTitle,
      chapterTitle,
      blockNumber: blockNum,
      ...result,
    });
  } catch (error) {
    console.error(`Erro ao gerar bloco ${blockNum} de "${chapterTitle}":`, error);
    return res.status(500).json({
      success: false,
      error: 'Falha ao gerar o bloco após esgotar as estratégias de resiliência.',
      details: error.message,
    });
  }
});

// ---------------------------------------------------------------------------
// POST /api/generate-cover
// Gera a URL da capa via Pollinations FLUX (800x1200, sem texto na imagem).
// ---------------------------------------------------------------------------
app.post('/api/generate-cover', (req, res) => {
  const { title, niche, stylePreference } = req.body || {};

  if (!title || !niche) {
    return res.status(400).json({
      error: 'Campos obrigatórios ausentes no body.',
      missingFields: [!title && 'title', !niche && 'niche'].filter(Boolean),
    });
  }

  try {
    const cover = generateCoverUrl({ title, niche, stylePreference });
    return res.json({ success: true, ...cover });
  } catch (error) {
    console.error('Erro ao gerar capa:', error);
    return res.status(500).json({
      success: false,
      error: 'Falha ao gerar a URL da capa.',
      details: error.message,
    });
  }
});

// ---------------------------------------------------------------------------
// 404 e handler de erro genérico
// ---------------------------------------------------------------------------
app.use((req, res) => {
  res.status(404).json({ error: 'Rota não encontrada.' });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('Erro não tratado:', err);
  res.status(500).json({ error: 'Erro interno do servidor.', details: err.message });
});

// ---------------------------------------------------------------------------
// Inicialização
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`✅ Servidor rodando na porta ${PORT}`);
  console.log(
    `🔑 Chaves configuradas — Gemini: ${pools.gemini.length}/6 | Groq: ${pools.groq.length}/6 | Mistral: ${pools.mistral.length}/6`
  );
});
