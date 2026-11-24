# Meu Painel de Gestão

Painel pessoal de gestão do John (Marketing Manager, JBS). É só dele: separado do Painel de Pautas
(`ojohnmf-glitch/pauta_mkt`, que o time acompanha) e do Farol. Idioma da interface e das respostas: português.

## O que é

Um único `index.html` (HTML, CSS e JS inline, sem build e sem dependências). Seis abas:
Visão geral, Áreas, Dani (pontos de atenção da gestora e projetos para o 1:1), Prioridades, Time, Desenvolvimento.

## Como o código está organizado

- `TIPOS`: esquema de cada tipo de registro (`area`, `atencao`, `projeto`, `prioridade`, `pessoa`, `avaliacao`, `devponto`).
  A gaveta de edição (`openDrawer`) é gerada a partir dele. Campo novo = uma linha em `campos`.
- `VIEWS`: uma função por aba, que devolve o DOM da tela. `render()` redesenha tudo a cada mudança.
- `h(tag, attrs, ...filhos)`: único jeito de criar DOM. Texto do usuário entra sempre como nó de texto, nunca como HTML.
- Dados: todos os registros ficam numa coleção `itens`, um documento por registro, com o campo `tipo`.
  `put` / `patch` / `del` gravam; `init()` escolhe o armazenamento.

## Armazenamento

- Como artifact no claude.ai: banco do artifact (`claude.use("db")`), regra de leitura e escrita só do dono.
- Hospedado (GitHub Pages): Supabase, projeto `painel-gestao` (ref `dyugezzehsewxjwhpqnw`, região sa-east-1), separado
  do `pauta_mkt`. Tabela `public.itens` (`id`, `user_id`, `tipo`, `dados` jsonb, `ordem`) com RLS por usuário.
  Login por link mágico (`signInWithOtp`); um trigger em `auth.users` só deixa criar conta para e-mails listados em
  `privado.emails_permitidos`. A biblioteca `supabase-js` é carregada do jsDelivr só neste modo; a chave publicável
  no `index.html` é pública por desenho. Não repetir o modelo do `pauta_mkt` (aberto para quem tem o link).
- `file://` ou falha ao carregar a biblioteca: `localStorage` (chave `painel-gestao-v1`). Na primeira entrada com a
  conta e a nuvem vazia, o conteúdo local é importado e a chave apagada.
- Configuração manual no painel do Supabase (Authentication → URL Configuration): Site URL e Redirect URL apontando
  para a URL do GitHub Pages, senão o link do e-mail volta para localhost.

## Regras

- O painel guarda avaliações e comentários sobre pessoas do time. Nunca colocar dados reais no repositório
  (ele é público): nada de seeds com conteúdo, nada de dados em commits, issues ou exemplos.
- Visual: mesma linguagem do Painel de Pautas. Tokens no `:root`; faixas de cor por área (`.c-lime`, `.c-mint`,
  `.c-lav`, `.c-forest`, `.c-sand`, `.c-gray`); cartões de raio 22px; um único verde de ação; tema claro apenas.
- Sem `alert` / `confirm` / `prompt`: exclusão é em dois cliques no próprio botão.

## Testar

Abrir `index.html` direto no navegador (cai no modo local). Checagem rápida de sintaxe:
extrair o `<script>` e rodar `node --check`.
