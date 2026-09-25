'use strict';

require('dotenv').config();

const express = require('express');
const cors = require('cors');

const { generateBlock, pools } = require('./aiService');
const { generateCoverUrl } = require('./coverService');
const { buildPdf, buildEpub } = require('./bookBuildService');

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
    const statusCode = error.retryable ? 503 : 500;
    return res.status(statusCode).json({
      success: false,
      retryable: Boolean(error.retryable),
      provider: error.provider || null,
      error: error.retryable
        ? 'Sem cota disponível agora nesse provedor. Tente este mesmo bloco novamente em alguns minutos.'
        : 'Falha ao gerar o bloco.',
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
// POST /api/build-book
// Monta o PDF e o EPUB finais a partir dos capítulos já gerados (texto puro).
// NÃO chama nenhuma IA aqui — só formata o que já foi gerado, então é rápido
// e nunca esbarra no limite de 30s do Render. Não exige login.
// Body esperado:
// {
//   "title": "...", "subtitle": "...", "author": "...",
//   "chapters": [ { "position": 1, "title": "...", "content": "..." }, ... ],
//   "coverUrl": "https://...">  (opcional — imagem da capa, ex: a do /api/generate-cover)
// }
// ---------------------------------------------------------------------------
app.post('/api/build-book', async (req, res) => {
  const { title, subtitle, author, chapters, coverUrl } = req.body || {};

  if (!title || !author || !Array.isArray(chapters) || chapters.length === 0) {
    return res.status(400).json({
      error: 'Campos obrigatórios ausentes: title, author e chapters (lista não vazia).',
    });
  }

  try {
    let coverBytes = null;
    let coverMime = null;
    if (coverUrl) {
      try {
        const fetch = require('node-fetch');
        const imgRes = await fetch(coverUrl);
        if (imgRes.ok) {
          const buf = await imgRes.buffer();
          coverBytes = new Uint8Array(buf);
          coverMime = imgRes.headers.get('content-type') || 'image/png';
        }
      } catch (imgErr) {
        console.error('Não foi possível baixar a capa, seguindo sem ela:', imgErr.message);
      }
    }

    const buildInput = {
      title,
      subtitle: subtitle || null,
      author,
      chapters: chapters.map((c, i) => ({
        position: c.position || i + 1,
        title: c.title || `Capítulo ${i + 1}`,
        content: c.content || '',
      })),
      coverBytes,
      coverMime,
    };

    const pdfBytes = await buildPdf(buildInput);
    const epubBytes = buildEpub(buildInput);

    return res.json({
      success: true,
      pdfBase64: Buffer.from(pdfBytes).toString('base64'),
      epubBase64: Buffer.from(epubBytes).toString('base64'),
      pdfSizeBytes: pdfBytes.length,
      epubSizeBytes: epubBytes.length,
    });
  } catch (error) {
    console.error('Erro ao montar o livro:', error);
    return res.status(500).json({
      success: false,
      error: 'Falha ao montar o PDF/EPUB.',
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
