# HANDOFF — Hermes Cockpit (delegação para Claude Code)

> Documento de continuidade. O projeto está funcional e empacotado; este arquivo
> contém todo o contexto necessário para implementar as próximas etapas sem
> redescobrir nada. Leia inteiro antes de codar.

## 1. O que é

App desktop local (Electron 40 + React 19 + Vite 8 + Tailwind 4) que serve de
**cockpit de comando para o Hermes Agent** do Alexandre. Não modifica o Hermes:
consome o backend `hermes serve` (JSON-RPC/WS + REST) e o plugin cockpit dele
(`~/.hermes/plugins/cockpit`, FastAPI). Wireframe de referência: cockpit com
rail de bots, chat central, dock lateral (Terminal/Diff/Preview/Arquivos) e
strip de status — tudo redimensionável, modular e customizável.

- **Projeto:** `/Users/alexandre/dev/hermes-cockpit`
- **Hermes (código-fonte do backend e do app oficial):** `/Users/alexandre/.hermes/hermes-agent`
  — LEITURA APENAS. É um managed install; `hermes update` sobrescreve. Nunca
  editar nada ali; usar como referência de contrato e de implementação.
- **Plugin cockpit (dados dos painéis):** `/Users/alexandre/.hermes/plugins/cockpit/dashboard/plugin_api.py`
  — rotas REST `/api/plugins/cockpit/{foco,agenda,notion,sistema,bots,quota,inbox}`.

## 2. Estado atual (validado em 2026-11-01)

Funciona e está empacotado (`release/Hermes Cockpit-0.1.0-arm64.dmg`, Electron 40.10.2, arm64, sem assinatura):

- Main process spawna `hermes serve --host 127.0.0.1 --port 0`, captura a porta
  do sentinel `HERMES_(BACKEND|DASHBOARD)_READY port=N` (buffer merged
  stdout+stderr) e injeta token via env `HERMES_DASHBOARD_SESSION_TOKEN`.
  Backend morre com o app (`will-quit` → `stopBackend`).
- REST via proxy IPC no main (`hermes:api`) — resolve CORS e mantém o token
  fora do renderer. Strip inferior (foco/cota/inbox) já renderiza dados reais.
- Cliente JSON-RPC mínimo no renderer (`src/renderer/src/lib/rpc.ts`).
- Smoke tests passaram: REST `/api/plugins/cockpit/bots` → 200 com dados reais;
  WS `/api/ws?token=` + `profiles.list` → 9 profiles reais.

**Atualização 2026-11-01 (P0 + P1 entregues, commits `cf17dc7`..`c8240d1`):**
- Bug nº 1 resolvido pelo proxy WS no main (`src/main/wsproxy.ts`). O diagnóstico
  original (Origin `file://`) estava errado: `_ws_host_origin_reason` em
  `hermes_cli/web_server_chat.py` aceita origins não-http. A causa real não foi
  identificada; o proxy contorna. O token não vai mais ao renderer
  (`backend()` devolve `token: ''`); outras rotas WS (ex.: `/api/pty`) usam
  `window.hermes.ws.open(id, path)`.
- Validado no app empacotado (via CDP `--remote-debugging-port`, já que
  `screencapture` sai preto sem permissão de gravação): rail com os 8 bots,
  `ws aberto`, histórico do Bot Chat do chief, resize persistido, quit mata o serve.
- Pendente de validação manual: streaming ao vivo pela GUI, card de aprovação
  ponta a ponta, overlays sobre a drag region, traffic lights com escala ≠ 100%.
- Lacunas conhecidas: server requests `clarify/sudo/secret/...` sem UI (respondem
  -32000); anexos e "Delegar" não implementados; pill Telegram e swarm sem fonte
  no plugin; `dev:web` sem REST (preflight CORS do serve dá 401). Mapa de métodos
  em `docs/GATEWAY.md`.

## 3. Gotchas críticos (todos morderam; não repita a investigação)

1. **`ELECTRON_RUN_AS_NODE=1` pode estar no ambiente do shell** (alguns hosts
   Electron a exportam). Com ela, qualquer binário Electron vira Node puro e o
   app morre com `The requested module 'electron' does not provide an export
   named ...`. Sintoma falso de "bug no código". Para rodar de shells afetados:
   `env -u ELECTRON_RUN_AS_NODE npm run dev`. A variável NÃO existe no launchd
   do macOS — app aberto pelo Finder é imune. O main já faz
   `delete env.ELECTRON_RUN_AS_NODE` para os filhos (`src/main/backend.ts::childEnv`).
2. **Testes de GUI só valem com GUI de verdade.** Shells de agentes/daemon não
   hospedam o browser process do Electron: o binário roda em modo utilitário
   (`process.type` ausente) e tudo falha como se fosse bug de ESM. Valide com
   `env -u ELECTRON_RUN_AS_NODE open release/mac-arm64/*.app` + `ps aux | grep`.
3. **`npm install` já clobberou o `package.json`** (apagou `scripts` e deps) no
   ambiente original. Depois de qualquer `npm install`, conferir
   `grep -c '"scripts"' package.json`. O conteúdo canônico está no git/atual.
4. **App empacotado (Finder) tem PATH mínimo.** `resolveHermesBin()` em
   `src/main/backend.ts` procura `~/.local/bin/hermes`, `/opt/homebrew/bin`,
   `/usr/local/bin` antes de cair no PATH. Manter isso ao mexer no spawn.
5. **`hermes serve` sobe em ~1–2s** e imprime o sentinel no stdout; não
   reinventar health-check. Timeout atual de 90s é folgado de propósito.
6. **DMG sem assinatura** (`identity: null` de propósito): primeira abertura
   exige botão direito → Abrir.
7. **ConPTY no Windows: o filho herda os VALORES dos std handles do relay.**
   O terminal do dock usa `CreatePseudoConsole` por ctypes
   (`src/main/ipc/shell.ts::RELAY_WIN`). Ao criar o shell com
   `PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE`, o filho só usa o pseudoconsole se os
   std handles do processo que spawna forem handles de console. No relay eles
   são os pipes do Electron, e aí o shell lê/escreve nos pipes do pai: `cmd`
   manda o stderr para fora do terminal e o **bash do MSYS (git-bash) trava na
   inicialização sem imprimir nada** — parece bug de ConPTY, não é. Correção:
   `CreateFileW('CONIN$'/'CONOUT$')` + `SetStdHandle` antes do `CreateProcessW`
   (e restaurar depois). Também é obrigatório `windowsHide: true` no spawn do
   python, senão aparece um console solto.

## 4. Contratos com o backend (fontes de verdade)

| Coisa | Onde está |
|---|---|
| Catálogo completo de métodos RPC + eventos | `~/.hermes/hermes-agent/apps/shared/src/gateway-contract.openrpc.json` (gera `gateway-contract.generated.ts` — dá para copiar/gerar tipos) |
| Cliente oficial de referência (WS, envelope, retry) | `~/.hermes/hermes-agent/apps/shared/src/json-rpc-channel.ts` e `json-rpc-gateway.ts` |
| Envelope | `{jsonrpc:'2.0', id, method, params}`; respostas por `id`; server requests chegam com `id`+`method` (hoje respondemos `-32601`); eventos/notificações com `method` sem `id` |
| WS endpoint | `ws://127.0.0.1:<port>/api/ws?token=<token>` |
| REST | `http://127.0.0.1:<port>/api/...` com header `x-hermes-session-token: <token>` |
| Plugins REST | `/api/plugins/<nome>/<rota>` (mount em `hermes_cli/web_server.py`, ~linha 595) |
| Terminal PTY | WS `/api/pty?token=...`, frames PTY brutos, resize via `\x1b[RESIZE:<cols>;<rows>]` — ver `hermes_cli/pty_bridge.py` e `web/src/pages/ChatPage.tsx` |
| Bot Mode (regra da sessão canônica) | `~/.hermes/hermes-agent/apps/desktop/src/AGENTS.md` § "Bot Mode" — um chat eterno por profile identificado por (profile, sessão intitulada exatamente "Bot Chat"), resolvido via `session.list {title, include_hidden:true}`; NUNCA guardar session-id |
| Aprovações | fluxo via RPC de prompt; ver `tui_gateway/methods_prompt.py` (232 ocorrências de "approv" em tui_gateway) e como o desktop renderiza cards de aprovação |
| Bots do Alexandre | profiles: `chief, mercurio` (coordenação), `atlas, hefesto, kairos` (trabalho), `lar, vesta` (pessoal), `argos` (operações) — mapa em `src/renderer/src/lib/bots.ts`, espelho do `_BOT_GROUPS` do plugin |

## 5. Roadmap (o que falta)

### P0 — Funcional conectado (fazer primeiro, nesta ordem)

1. **Proxy WS pelo main process.** IPC `hermes:ws:open|send|close`; o main abre
   o WebSocket (Node ≥22 tem `WebSocket` nativo — sem dep nova) e retransmite
   frames por `webContents.send`. Renderer mantém a API do `HermesRpc` mas sobre
   um transport IPC. Aceite: rail popula os 8 bots no app empacotado; badge "ws aberto".
2. **Chat com streaming.** Composer ativo; submit no profile selecionado;
   transcript com eventos de turno (texto incremental, spinner de turno, tool
   calls expandíveis, cancelar). Contrato em `gateway-contract.openrpc.json`
   (métodos `prompt.*`/`session.*` e eventos). Aceite: conversar com o chief,
   ver streaming token a token, histórico ao reabrir.
3. **Sessão canônica por bot** (regra do §4/Bot Mode). Clicar no bot abre o
   chat eterno dele; side-chats ficam visíveis numa lista de sessões.
4. **Aprovações.** Handler de server request no transport IPC → card
   Aprovar/Negar → resposta ao backend. Aceite: pedir algo que exija aprovação
   e aprovar pelo card.
5. **Slash commands** — `commands.catalog` (autocomplete) + `slash.exec`.
6. **Model picker por bot** — modelo atual vem no `profiles.list`.

### P1 — Adaptável + modular (fazer junto; se interdependem)

7. **Split panes** com `react-resizable-panels` (rail ↔ chat ↔ dock, alças,
   tamanhos persistidos em localStorage), panes colapsáveis e modo foco.
8. **Registry de painéis** — `{ id, título, componente, fonte, refresh }`;
   layout serializado em JSON; widgets do plugin cockpit (`/foco`, `/quota`,
   `/inbox`, `/notion`, `/sistema`) viram cards encaixáveis em qualquer região.
9. **Responsivo** — breakpoints (rail overlay, dock em abas, strip com scroll);
   corrigir padding da titlebar (`hiddenInset` colide com traffic lights).
10. **Temas** — presets sobre os tokens `@theme` em `src/renderer/src/index.css`
    (grafite/fósforo/âmbar/claro) + overrides de accent/fonte/densidade.
11. **Comandos rápidos por bot** — snippets configuráveis que viram prompt.

### P2 — Resto do wireframe

12. Terminal xterm.js sobre `/api/pty` (aba "Tela Mac"). 13. Diff/Git
(`git_probe` do backend). 14. Preview/screenshot do Mac. 15. Execuções do
swarm (subagents). 16. Busca de sessões.

## 6. Convenções e processo

- TypeScript estrito; `npm run typecheck` deve passar antes de cada entrega.
- Sem dependência nova sem justificar (o projeto é deliberadamente leve).
- Falha de qualquer fonte de dados vira chip/estado de erro no painel — nunca
  derruba a UI (mesmo contrato do plugin cockpit).
- Renderer nunca fala direto com o backend em produção: REST via proxy IPC;
  WS via proxy IPC (após P0-1). Exceção: modo `dev:web` (navegador), degradado.
- Não editar nada em `~/.hermes/hermes-agent` (read-only, managed install).
- Estilo visual: manter a identidade "grafite" (tokens em `index.css`), labels
  uppercase com tracking, accents âmbar/fósforo, scanlines discretas.
- Commits pequenos e temáticos; rebuild da DMG com `npm run dist` ao final de
  cada etapa entregue (usuário instala por DMG).

## 7. Comandos

```bash
cd /Users/alexandre/dev/hermes-cockpit
npm install                                  # depois: grep -c '"scripts"' package.json (gotcha §3.3)
npm run dev                                  # dev (se falhar: env -u ELECTRON_RUN_AS_NODE npm run dev)
npm run typecheck && npm run build
npm run dist                                 # DMG em release/
env -u ELECTRON_RUN_AS_NODE open "release/mac-arm64/Hermes Cockpit.app"   # validar empacotado
ps aux | grep "Hermes Cockpit" | grep -v grep                              # app vivo?
ps aux | grep "serve --host" | grep -v grep                                # backend do app vivo?
```

## 8. Critério de "pronto" do P0

Abrir o app empacotado pelo Finder: rail mostra os 8 bots agrupados; clicar no
chief abre o chat eterno dele; mandar mensagem e ver streaming; receber um
pedido de aprovação e aprovar pelo card; fechar o app mata o `hermes serve`
filho. Sem nada rodando solto (`ps aux | grep` limpo).

## 9. Rodada v2 (2026-11-01) — views, swarm, ops, transcriber, devtools

**O que existe.** A área central tem 4 views trocadas por abas na topbar
(⌘1..⌘4, `UiPrefs.view`): **Chat · Swarm · Ops · Transcrever**. Chat fica sempre
montado; as outras montam na 1ª visita e depois ficam vivas escondidas
(`useViewActive()` em `components/layout/views.tsx`). Paleta ⌘K reescrita
(views, bots, sessões recentes, comandos/skills, repos, layout). Kit de UI em
`components/ui/` (Button, Tabs, Badge, Skeleton, ConfirmButton de 2 cliques,
Toaster...). Utilitárias de animação `hc-*` em `index.css` (respeitam
`prefers-reduced-motion`).

- **Chat**: abas (Bot Chat fixo + side-chats salvos em `localStorage`), drawer de
  sessões (busca, renomear, exportar, apagar com 2 cliques), Markdown melhor,
  cards de tool call, ditado no composer via `useDictation`.
- **Seleção de modelo**: `chat/ModelPicker.tsx` (busca, grupos por provider,
  badges local/cloud, escopo "este chat" vs "padrão do bot", teclado) e, na
  view Ops > Modelos, a tabela "Bots × modelo padrão" (PUT
  `/api/profiles/{name}/model`) + gestão do Ollama (pull/descarregar/remover).
  Codex escondido nos dois.
- **Transcriber**: `src/main/ipc/transcriber.ts` sobe/reusa o `server.py` na
  porta 7100 (tudo pelo main: o FastAPI não manda CORS). View com Arquivo,
  YouTube, Tempo real (mic/sistema/ambos) e Histórico. Morre com o app
  (`stopTranscriber()` no quit; só mata o processo que o cockpit subiu).
- **Swarm** (Claude Code): runner/MCP em `swarm/`, contrato em
  `docs/SWARM-SPEC.md`; view com runs agrupadas, stream, diff, aprovações e
  "continuar conversa"; aba "Subagents Hermes".
- **Ops**: portas, aplicações/processos, projetos (`~/dev`, `~/Documents`),
  containers (Docker parado = estado vazio honesto), modelos, armazenamento.
  Matar/remover sempre com confirmação inline de 2 cliques.
- **Dock**: Terminal (xterm sobre `/api/pty`), Diff · Git, Arquivos, Preview,
  Swarm, Tela Mac (`ops:screenshot`).

**Instalar o swarm.** `npm run swarm:install` copia `swarm/` para
`~/.hermes/cockpit/swarm-bin/`, cria o estado em `~/.hermes/cockpit/swarm/` e
registra o MCP `claude_swarm` nos profiles que existem de fato (backup
`config.yaml.bak-<data>`). Sem `--profiles`, a lista vem de
`<raiz do Hermes>/profiles/*/config.yaml` — a raiz é resolvida por
`hermesHome()` (HERMES_HOME aponta para o perfil ativo, então a raiz é o avô;
no Windows é `%LOCALAPPDATA%\hermes`, não `~/.hermes`). Rode de novo sempre que
`swarm/` mudar. Processos
Hermes já vivos só enxergam o MCP depois de reiniciar/recarregar a config.
Worktrees em `~/.hermes/cockpit/worktrees/<repo>-<runId>` (branch
`hermes/<runId>`).

**Limitações conhecidas.**
- `/api/pty` roda `hermes --tui` do profile, não um shell, e ignora cwd. O
  shell de verdade do dock vem do relay de PTY no main (`ops:shell.*` em
  `src/main/ipc/shell.ts`), que segue o workspace: POSIX via `pty.fork` +
  `$SHELL -l`; Windows via ConPTY (ver gotcha §3.7), shell = git-bash se
  existir (incl. o git portátil de `<hermes>/tools/git-*`), senão
  `powershell.exe`; `HERMES_COCKPIT_SHELL` sobrepõe. Depende de python3 — no
  Windows o relay usa o venv do Hermes ou `<hermes>/tools/python-*`.
- Swarm no Windows: as fronteiras de plataforma estão em `swarm/lib/platform.mjs`
  (BIN_DIRS/PATHEXT, `killTree` por `taskkill /T`, linha de comando de um pid por
  `Win32_Process`, `spawnSpec` para .cmd). Três armadilhas: (a) o Windows **não
  entrega SIGTERM** — `TerminateProcess` é imediato, o handler do runner nunca
  roda, então quem cancela (`cancelRun` em `lib/runs.mjs` e `cancel()` em
  `src/main/ipc/swarm.ts`) derruba a árvore e grava a meta ele mesmo; (b) um
  `.cmd` não pode ir ao `CreateProcess` (CVE-2024-27980) — se for shim do npm,
  `spawnSpec` chama o `node` no `cli.js` de destino (sem perdas), senão passa
  pelo `cmd.exe`, onde `%VAR%` é expandido e argumento com quebra de linha é
  truncado; (c) `env.PATH = ...` sobre um `{...process.env}` cria uma SEGUNDA
  chave (a do Windows é `Path`) e o filho fica com PATH ambíguo — sempre apagar
  a chave antiga primeiro e juntar com `path.delimiter`.
- Swarm: Bash somente-leitura é autoaprovado pelo Claude Code (não gera card).
  Workers rodam com `--setting-sources=` (nenhuma fonte: sem plugins/hooks nem
  settings do repo, que poderiam liberar tools sem aprovação);
  `SWARM_SETTING_SOURCES=user|local|all` (all = user,local) reabilita — `project` nunca.
- Transcriber: o servidor não emite parciais (janelas de ~4s, só `append`);
  `server.py` antigo sem `/api/audio-devices` precisa ser reiniciado à mão.
  Arquivo arrastado > 1 GB: use "escolher arquivo".
- Seleção de modelo: escopo "este chat" no Bot Chat dura até o próximo resume;
  contexto só aparece para o modelo atual; providers cloud da Ops vêm de um
  profile só.
- Nada desta rodada foi validado com GUI (o app estava em uso): falta testar
  drag de abas, overlays, mic/MediaRecorder, xterm/resize, iframe do Preview,
  captura de tela. Zoom CSS do `#root` ≠ 1 pode deslocar a seleção no xterm.
- Integração (esta rodada): `serve` agora sobe com `cwd = $HOME` (default-cwd
  útil); `hermes:api` valida `..` só no pathname; `ops:open` aceita também
  `x-apple.systempreferences:...?Privacy_*`; `stopSwarmWatch()` no quit.
## 10. Teclado e clipboard do Terminal integrado (2026-11-02)

O Terminal do dock (`components/devtools/XtermView.tsx` + relay de PTY em
`src/main/ipc/shell.ts`) passou a seguir o padrão Windows Terminal / VS Code.

**Mapa (fonte de verdade: `src/renderer/src/lib/term-keys.ts`, testado em
`term-keys.test.ts`).** A função pura `keyAction({key,ctrl,shift,meta,alt,
hasSelection,platform})` devolve `copy | paste | sigint | select-all |
zoom-in | zoom-out | zoom-reset | pass`; `pass` e `sigint` seguem para o xterm
(que manda ao PTY), o resto o XtermView executa e cancela a tecla.

| Tecla | Windows/Linux | macOS |
|---|---|---|
| Ctrl+C | com seleção: copia + limpa seleção · sem seleção: `\x03` | sempre `\x03` |
| ⌘C | — | com seleção copia; sem seleção passa (menu Edit) |
| Ctrl+V · Ctrl+Shift+V · Shift+Insert | cola (`term.paste`) | ⌘V cola; Ctrl+V = `\x16` |
| Ctrl+Shift+C · Ctrl+Insert | copia (nunca interrompe) | ⌘⇧C copia |
| Ctrl+A | vai ao shell (início da linha) | ⌘A seleciona o buffer; Ctrl+A ao shell |
| Ctrl+Shift+A | seleciona o buffer | ⌘A |
| Ctrl+= / Ctrl+- / Ctrl+0 | fonte do terminal (8–28px, padrão 12) | ⌘=/⌘-/⌘0 |
| Botão direito | com seleção copia, senão cola | igual |
| Alt / AltGr (ctrl+alt) | sempre vai ao shell (teclado ABNT2) | igual |

**Clipboard pelo main.** `ops:clipboard.read|write` (`src/main/ipc/clipboard.ts`,
domínio `ops`, sem mudança no preload) — `navigator.clipboard.readText()` é
negado pelo `setPermissionCheckHandler` de `src/main/index.ts`, que só libera
`media`. Helper do renderer: `lib/clipboard.ts` (cai no `navigator.clipboard`
no `dev:web`). Copiar usa `term.getSelection()` (linhas sem espaço à direita,
CRLF no Windows); colar usa `term.paste()` (CRLF→CR + bracketed paste).

**Menu Edit (gotcha novo).** No Windows/Linux os aceleradores do menu são
registrados NO SISTEMA e chegam antes do renderer: com `role: 'editMenu'` cru,
Ctrl+C virava `webContents.copy()` (o PTY nunca via `\x03`) e Ctrl+A chamava
`selectAll()` do Chromium. `src/main/menu.ts` monta o Edit com
`registerAccelerator: false` em undo/redo/cut/copy/paste/delete/selectAll — os
itens e os rótulos continuam no menu, e o Chromium segue tratando
copiar/colar/selecionar nativamente em inputs e em seleção de texto comum
(ambos validados no app). No macOS o menu fica intacto (`role: 'editMenu'`).
Testes: `src/main/menu.test.ts`.

**Atalhos globais × terminal.** `App.tsx` chama `terminalWantsEvent(e)` antes de
tratar os atalhos: com o foco dentro de um `[data-term-host]`, as teclas do
terminal vencem (Ctrl+Shift+V = colar, não ditado; Ctrl+=/-/0 = fonte do PTY,
não escala da UI). Todo o resto (⌘K, views ⌘1..⌘9, espaços ⌘⇧1/2/3, ⌘B, ⌘J,
⌘T, ⌘.) continua global, inclusive com o terminal focado — ou seja, Ctrl+B,
Ctrl+J, Ctrl+K e Ctrl+T NÃO chegam ao shell (tmux/readline), que é o
comportamento anterior, mantido de propósito.

**Smoke.** `node scripts/smoke-term-keys.mjs` (CDP, app de verdade; usa
`release/win-unpacked` se existir, senão o Electron de dev sobre `out/`).
Substitui o `hermes serve` por um stub via `HERMES_BIN` — sem isso, com um
Hermes já rodando na máquina o `serve` recusa a segunda instância, o
`hermes:backend` rejeita e o App troca o cockpit pela tela "Falha ao subir o
backend" (o Terminal desmonta e qualquer teste de GUI falha por motivo errado;
vale para `smoke:win` também). O item 7 (injeção de tecla do SO) sai PULADO
quando a janela não está em primeiro plano no SO.
