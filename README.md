# Cheketo AI E-books

Atue como um Engenheiro de Software Sênior, Arquiteto de Sistemas de IA e Desenvolvedor Full Stack. 

Preciso que você desenvolva o código completo, funcional, limpo e estruturado de uma aplicação web de ponta a ponta para um poderoso Gerador Automatizado de E-books com Inteligência Artificial chamado **Cheketo** (com dois T's). 

A aplicação deve conter rigorosamente todos os requisitos e fluxos detalhados abaixo:

## 1. Identidade do Sistema

* **Nome da Plataforma:** O sistema deve exibir a marca **Chequetto** de forma elegante e destacada em toda a interface (cabeçalho, painel, telas de carregamento e checkout).

## 2. Configuração Global de Chaves do Administrador (Backend / .env)

* **Chaves Globais do Gemini:** O sistema deve prever um local centralizado de configuração (como arquivo `.env`) onde o administrador insere **6 chaves de API diferentes do Gemini** que servirão como padrão global para toda a plataforma. O usuário final não insere chaves de API.

* **Motor de Rotação e Failover Automático:** O backend gerenciará uma fila inteligente com essas 6 chaves globais. O processo inicia na Chave 1. Se ocorrer qualquer erro de requisição ou limite de cota estourado (`Rate Limit / Quota Exceeded`), o sistema captura o erro instantaneamente, registra a falha e alterna de forma transparente e automática para a próxima chave em sequência (da 1 até a 6), garantindo que nenhuma geração de e-book falhe.

## 3. Painel de Criação do E-book (Interface do Usuário)

O usuário terá acesso a um formulário intuitivo contendo exatamente os seguintes campos:

* **Título do E-book:** Campo de texto livre.

* **Subtítulo do E-book:** Campo de texto livre.

* **Nome do Autor:** Campo de texto livre.

* **Descrição do Nicho / Conteúdo:** Uma área de texto ampla (textarea) para o usuário detalhar o tema, o objetivo e os pontos centrais que devem ser abordados.

* **Descrição da Capa:** Uma área de texto para o usuário detalhar visualmente o estilo, cores e elementos da capa desejada.

* **Quantidade de Capítulos:** Seletor numérico.

* **Quantidade de Páginas (Meta de Volume):** Seletor numérico para direcionar a profundidade e extensão do conteúdo.

## 4. Fluxo Inteligente de Geração, Leitura e Auto-Correção (Anti-Enrolação Funcional)

Para garantir que o e-book entregue exatamente o que foi pedido com altíssima qualidade editorial e sem repetições vazias ("gags" ou redundâncias típicas de IA), **cada capítulo gerado deve obrigatoriamente executar o seguinte pipeline automatizado**:

1. **Geração do Rascunho Bruto:** O Gemini gera o conteúdo inicial do capítulo com base na descrição e na meta de páginas.

2. **Leitura e Auditoria Crítica Real:** Imediatamente após gerar, o sistema envia o texto de volta para o modelo atuando como um **Revisor Editorial implacável**. O sistema programa o modelo para ler o texto buscando ativamente por: repetições cansativas, enrolação, falta de profundidade prática ou desvios do tema proposto.

3. **Correção e Lapidação Automática:** Com base na auditoria da leitura, o próprio sistema reescreve e limpa o texto em tempo de execução, eliminando redundâncias, elevando o nível técnico e literário, e garantindo a entrega rigorosa e polida antes de salvar o capítulo na estrutura final.

## 5. Geração da Capa

* O sistema deve utilizar a descrição visual fornecida pelo usuário e integrá-la com a API de geração de imagens (via Gemini/Imagen ou equivalente compatível, utilizando as chaves globais) para gerar, renderizar e exibir a imagem oficial da capa do e-book em alta resolução.

## 6. Fluxo de Conversão e Pagamento (Asaas)

* **Regra de Negócio do Fluxo:** O usuário preenche todos os dados e clica em gerar. O sistema processa a criação da estrutura, dos capítulos (com a auto-correção) e da capa. Assim que o e-book estiver totalmente gerado (ou pronto para visualização prévia), **o usuário é direcionado automaticamente para a área de pagamento/checkout**.

* **Integração com Asaas:** O sistema deve integrar o gateway de pagamento **Asaas** para gerenciar as cobranças.

* **Planos Disponíveis:**

  - **Plano Mensal:** R$ 99,00 / mês (assinatura recorrente).

  - **Plano Vitalício:** R$ 299,00 (pagamento único / lifetime).

* **Liberação de Download:** Após a confirmação do pagamento via webhook do Asaas, o acesso é liberado e o usuário pode baixar o e-book completo compilado (em formato PDF ou EPUB, contendo capa, metadados e todos os capítulos corrigidos).

Por favor, forneça o código completo da aplicação **Cheketo** (Frontend e Backend integrados, rotas, lógica de rotação das 6 chaves, pipeline real de auto-correção de texto e integração de pagamento Asaas), estruturado, limpo e pronto para execução.

This project was built with [Lovable](https://lovable.dev).

**Live app**: https://cheketo-book-forge.lovable.app

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/32e6cc16-efd6-45ec-a887-55ac1e415442).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```
