# Leia antes de subir

Este zip tem o repositório inteiro, organizado para os dois projetos pararem de brigar entre si:

- **Tudo na raiz** (`src/`, `public/`, `supabase/`, `drizzle/`, `package.json` da raiz, etc.) — é o projeto grande do Lovable, como já estava, só com 2 arquivos atualizados: `src/lib/groq.server.ts` e `src/lib/mistral.server.ts` (agora com o revezamento entre Groq, Gemini e Mistral, sem depender de pagamento).

- **A pasta `render-backend/`** — é o gerador simples que criamos para o Render. Tem o próprio `package.json` dele, separado do da raiz, para nunca mais um sobrescrever o outro.

## O que fazer no GitHub

1. Apague todos os arquivos do repositório atual (ou crie um repositório novo).
2. Suba TODO o conteúdo deste zip no lugar.

## O que fazer no Render

Como o gerador agora está dentro da pasta `render-backend/` (não mais na raiz), é preciso avisar o Render disso:

1. No painel do seu serviço no Render, vá em **Settings**.
2. Procure o campo **Root Directory**.
3. Coloque: `render-backend`
4. Salve — o Render vai reiniciar sozinho usando essa pasta.

Depois disso, **o próprio endereço do seu site no Render já abre a página pronta** — não precisa mais baixar nenhum arquivo `.html`. Exemplo: `https://cheketo-book-forge.onrender.com/` já mostra o gerador funcionando, com o endereço preenchido sozinho.

Para conferir rapidamente se o servidor está de pé (em formato de texto/JSON), use: `https://SEU-APP.onrender.com/api/status`
