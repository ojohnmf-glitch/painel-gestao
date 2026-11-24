# Meu Painel de Gestão

Painel pessoal de gestão: visão por área, pontos de atenção da Pan, projetos para o 1:1,
prioridades, time e desenvolvimento. Um único arquivo, `index.html`, sem dependências.

## Onde os dados ficam

| Situação | Armazenamento |
|---|---|
| Aberto como artifact no claude.ai | Banco do artifact, leitura e escrita só do dono |
| Hospedado (GitHub Pages) | Supabase (projeto `painel-gestao`): login por link no e-mail, só para o e-mail autorizado, e cada usuário lê e grava apenas os próprios registros (RLS). Sincroniza entre dispositivos |
| Aberto direto do arquivo (`file://`) ou sem conexão com o Supabase | `localStorage` do navegador: os dados ficam só naquele navegador |

Na primeira entrada com a conta, o que havia no `localStorage` daquele navegador é trazido para a conta.

Este repositório não contém dados, só a estrutura do painel.

## Hospedar no GitHub Pages

Settings → Pages → Deploy from a branch → `main`, pasta `/ (root)`.
