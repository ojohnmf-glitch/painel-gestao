'use strict';

const {
  Plugin, ItemView, Modal, PluginSettingTab, Setting, TFile, TFolder,
  MarkdownRenderer, Notice, setIcon, normalizePath, moment,
} = require('obsidian');

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

const VIEW_TYPE = 'keep-notes-view';

// Paleta do Google Keep (claro / escuro). O id é o que vai no frontmatter.
const CORES = [
  { id: 'default',    nome: 'Padrão' },
  { id: 'coral',      nome: 'Coral' },
  { id: 'pessego',    nome: 'Pêssego' },
  { id: 'areia',      nome: 'Areia' },
  { id: 'menta',      nome: 'Menta' },
  { id: 'salvia',     nome: 'Sálvia' },
  { id: 'nevoa',      nome: 'Névoa' },
  { id: 'ceu',        nome: 'Céu' },
  { id: 'tempestade', nome: 'Tempestade' },
  { id: 'rosa',       nome: 'Rosa' },
  { id: 'giz',        nome: 'Giz' },
  { id: 'cinza',      nome: 'Cinza' },
];
const CORES_IDS = new Set(CORES.map((c) => c.id));

const DEFAULT_SETTINGS = {
  pasta: 'Notas rápidas',
  corPadrao: 'areia',
  incluirSubpastas: true,
  larguraCard: 240,
};

const RE_FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;
const RE_MARCADOR_LISTA = /^(?:[-*+]|\d+\.)\s+(?:\[[ xX]\]\s+)?/;
const RE_TAREFA = /^(\s*(?:[-*+]|\d+\.)\s+\[)( |x|X)(\])/;

// ---------------------------------------------------------------------------
// Utilitários
// ---------------------------------------------------------------------------

function separarFrontmatter(texto) {
  const m = texto.match(RE_FRONTMATTER);
  if (!m) return { fm: '', corpo: texto };
  return { fm: m[0], corpo: texto.slice(m[0].length) };
}

function sanitizarNome(nome) {
  return nome.replace(/[\\/:*?"<>|#^[\]]/g, '').replace(/\s+/g, ' ').trim();
}

function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => { t = null; fn(...args); }, ms);
  };
}

// Barra de formatação para um <textarea> com Markdown.
// Cada ação opera sobre a seleção e devolve o foco ao campo.
class Formatador {
  constructor(textarea, aoMudar) {
    this.ta = textarea;
    this.aoMudar = aoMudar;
  }

  _set(valor, ini, fim) {
    this.ta.value = valor;
    this.ta.setSelectionRange(ini, fim);
    this.ta.focus();
    this.aoMudar && this.aoMudar();
  }

  envolver(antes, depois = antes) {
    const { value: v, selectionStart: s, selectionEnd: e } = this.ta;
    const sel = v.slice(s, e);
    // Já está envolvido? Então remove.
    if (v.slice(s - antes.length, s) === antes && v.slice(e, e + depois.length) === depois) {
      const novo = v.slice(0, s - antes.length) + sel + v.slice(e + depois.length);
      return this._set(novo, s - antes.length, e - antes.length);
    }
    if (sel.startsWith(antes) && sel.endsWith(depois) && sel.length >= antes.length + depois.length) {
      const miolo = sel.slice(antes.length, sel.length - depois.length);
      return this._set(v.slice(0, s) + miolo + v.slice(e), s, s + miolo.length);
    }
    const novo = v.slice(0, s) + antes + sel + depois + v.slice(e);
    this._set(novo, s + antes.length, e + antes.length);
  }

  // Alterna um prefixo de linha em todas as linhas selecionadas.
  // `tem` reconhece o prefixo desejado; `remover` reconhece qualquer marcador
  // de lista a ser trocado (ex.: "- " vira "- [ ] ").
  prefixo(pref, tem, remover = tem) {
    const { value: v, selectionStart: s, selectionEnd: e } = this.ta;
    const iniLinha = v.lastIndexOf('\n', s - 1) + 1;
    let fimLinha = v.indexOf('\n', e);
    if (fimLinha === -1) fimLinha = v.length;
    const bloco = v.slice(iniLinha, fimLinha);
    const linhas = bloco.split('\n');
    const todasTem = linhas.every((l) => tem.test(l.replace(/^\s*/, '')));
    const novas = linhas.map((l, i) => {
      const semIndent = l.replace(/^\s*/, '');
      const indent = l.slice(0, l.length - semIndent.length);
      const limpa = semIndent.replace(remover, '');
      if (todasTem) return indent + limpa;
      const p = pref.replace('%n', String(i + 1));
      return indent + p + limpa;
    });
    const novoBloco = novas.join('\n');
    const novo = v.slice(0, iniLinha) + novoBloco + v.slice(fimLinha);
    this._set(novo, iniLinha, iniLinha + novoBloco.length);
  }

  negrito()     { this.envolver('**'); }
  italico()     { this.envolver('*'); }
  sublinhado()  { this.envolver('<u>', '</u>'); }
  tachado()     { this.envolver('~~'); }
  destaque()    { this.envolver('=='); }
  codigo()      { this.envolver('`'); }
  titulo()      { this.prefixo('## ', /^#{1,6}\s+/); }
  topicos()     { this.prefixo('- ', /^[-*+]\s+(?!\[[ xX]\]\s)/, RE_MARCADOR_LISTA); }
  numerada()    { this.prefixo('%n. ', /^\d+\.\s+(?!\[[ xX]\]\s)/, RE_MARCADOR_LISTA); }
  tarefa()      { this.prefixo('- [ ] ', /^(?:[-*+]|\d+\.)\s+\[[ xX]\]\s+/, RE_MARCADOR_LISTA); }

  // Enter dentro de lista continua a lista; Enter em item vazio encerra.
  aoEnter(ev) {
    const { value: v, selectionStart: s, selectionEnd: e } = this.ta;
    if (s !== e) return false;
    const iniLinha = v.lastIndexOf('\n', s - 1) + 1;
    const linha = v.slice(iniLinha, s);
    const m = linha.match(/^(\s*)(?:([-*+])\s+(\[[ xX]\]\s+)?|(\d+)\.\s+)(.*)$/);
    if (!m) return false;
    ev.preventDefault();
    const [, indent, marcador, caixa, num, resto] = m;
    if (!resto.trim()) {
      // Item vazio: remove o marcador e sai da lista.
      this._set(v.slice(0, iniLinha) + indent + v.slice(s), iniLinha + indent.length, iniLinha + indent.length);
      return true;
    }
    let pref;
    if (num) pref = `${indent}${Number(num) + 1}. `;
    else pref = `${indent}${marcador} ${caixa ? '[ ] ' : ''}`;
    const novo = v.slice(0, s) + '\n' + pref + v.slice(s);
    this._set(novo, s + 1 + pref.length, s + 1 + pref.length);
    return true;
  }

  atalho(ev) {
    const mod = ev.ctrlKey || ev.metaKey;
    if (ev.key === 'Enter' && !mod && !ev.shiftKey) return this.aoEnter(ev);
    if (!mod) return false;
    const k = ev.key.toLowerCase();
    if (k === 'b') { ev.preventDefault(); this.negrito(); return true; }
    if (k === 'i') { ev.preventDefault(); this.italico(); return true; }
    if (k === 'u') { ev.preventDefault(); this.sublinhado(); return true; }
    if (ev.shiftKey && k === 'x') { ev.preventDefault(); this.tachado(); return true; }
    if (ev.shiftKey && k === 'c') { ev.preventDefault(); this.tarefa(); return true; }
    if (ev.shiftKey && ev.code === 'Digit8') { ev.preventDefault(); this.topicos(); return true; }
    return false;
  }
}

const BOTOES_BARRA = [
  { acao: 'negrito',    icone: 'bold',           rotulo: 'Negrito (Ctrl+B)' },
  { acao: 'italico',    icone: 'italic',         rotulo: 'Itálico (Ctrl+I)' },
  { acao: 'sublinhado', icone: 'underline',      rotulo: 'Sublinhado (Ctrl+U)' },
  { acao: 'tachado',    icone: 'strikethrough',  rotulo: 'Tachado (Ctrl+Shift+X)' },
  { acao: 'destaque',   icone: 'highlighter',    rotulo: 'Destaque' },
  { sep: true },
  { acao: 'titulo',     icone: 'heading',        rotulo: 'Título' },
  { acao: 'topicos',    icone: 'list',           rotulo: 'Lista de tópicos (Ctrl+Shift+8)' },
  { acao: 'numerada',   icone: 'list-ordered',   rotulo: 'Lista numerada' },
  { acao: 'tarefa',     icone: 'check-square',   rotulo: 'Tarefa (Ctrl+Shift+C)' },
  { sep: true },
  { acao: 'codigo',     icone: 'code',           rotulo: 'Código' },
];

function montarBarra(container, formatador) {
  const barra = container.createDiv({ cls: 'keep-toolbar' });
  for (const b of BOTOES_BARRA) {
    if (b.sep) { barra.createSpan({ cls: 'keep-toolbar-sep' }); continue; }
    const btn = barra.createEl('button', { cls: 'keep-tb-btn clickable-icon', attr: { 'aria-label': b.rotulo, title: b.rotulo, type: 'button' } });
    setIcon(btn, b.icone);
    // mousedown para não perder a seleção do textarea
    btn.addEventListener('mousedown', (ev) => { ev.preventDefault(); formatador[b.acao](); });
  }
  return barra;
}

function montarPaleta(container, corAtual, aoEscolher) {
  const pal = container.createDiv({ cls: 'keep-palette' });
  for (const c of CORES) {
    const dot = pal.createEl('button', {
      cls: 'keep-color-dot' + (c.id === corAtual ? ' is-active' : ''),
      attr: { 'data-color': c.id, 'aria-label': c.nome, title: c.nome, type: 'button' },
    });
    dot.addEventListener('click', (ev) => {
      ev.stopPropagation();
      pal.querySelectorAll('.keep-color-dot').forEach((d) => d.removeClass('is-active'));
      dot.addClass('is-active');
      aoEscolher(c.id);
    });
  }
  return pal;
}

function autoAltura(ta) {
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 480) + 'px';
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

class KeepNotesPlugin extends Plugin {
  async onload() {
    await this.carregarSettings();

    this.registerView(VIEW_TYPE, (leaf) => new KeepView(leaf, this));

    this.addRibbonIcon('sticky-note', 'Notas rápidas', () => this.abrirView());
    this.addRibbonIcon('file-plus', 'Nova nota rápida', () => this.novaNota());

    this.addCommand({ id: 'abrir', name: 'Abrir notas rápidas', callback: () => this.abrirView() });
    this.addCommand({ id: 'nova', name: 'Nova nota rápida', callback: () => this.novaNota() });

    this.addSettingTab(new KeepSettingTab(this.app, this));
  }

  onunload() {}

  async carregarSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async salvarSettings() {
    await this.saveData(this.settings);
    this.app.workspace.getLeavesOfType(VIEW_TYPE).forEach((l) => l.view.recarregar && l.view.recarregar());
  }

  get pasta() {
    return normalizePath(this.settings.pasta || DEFAULT_SETTINGS.pasta);
  }

  async garantirPasta() {
    const p = this.pasta;
    const existente = this.app.vault.getAbstractFileByPath(p);
    if (existente instanceof TFolder) return existente;
    if (existente) throw new Error(`"${p}" existe mas não é uma pasta.`);
    return this.app.vault.createFolder(p);
  }

  pertenceAPasta(file) {
    if (!(file instanceof TFile) || file.extension !== 'md') return false;
    const base = this.pasta + '/';
    if (!file.path.startsWith(base)) return false;
    if (this.settings.incluirSubpastas) return true;
    return !file.path.slice(base.length).includes('/');
  }

  listarNotas() {
    return this.app.vault.getMarkdownFiles().filter((f) => this.pertenceAPasta(f));
  }

  lerMeta(file) {
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter || {};
    const cor = CORES_IDS.has(fm.color) ? fm.color : 'default';
    const fixada = fm.pinned === true || fm.pinned === 'true';
    return { cor, fixada };
  }

  async lerCorpo(file) {
    const texto = await this.app.vault.cachedRead(file);
    return separarFrontmatter(texto).corpo;
  }

  async escreverCorpo(file, corpo) {
    const atual = await this.app.vault.read(file);
    const { fm } = separarFrontmatter(atual);
    const novo = fm + corpo;
    if (novo !== atual) await this.app.vault.modify(file, novo);
  }

  async definirCor(file, cor) {
    await this.app.fileManager.processFrontMatter(file, (fm) => { fm.color = cor; });
  }

  async definirFixada(file, fixada) {
    await this.app.fileManager.processFrontMatter(file, (fm) => { fm.pinned = !!fixada; });
  }

  async alternarTarefa(file, indice) {
    const atual = await this.app.vault.read(file);
    const { fm, corpo } = separarFrontmatter(atual);
    const linhas = corpo.split('\n');
    let n = -1;
    for (let i = 0; i < linhas.length; i++) {
      const m = linhas[i].match(RE_TAREFA);
      if (!m) continue;
      n++;
      if (n !== indice) continue;
      const marcado = m[2] !== ' ';
      linhas[i] = linhas[i].replace(RE_TAREFA, `$1${marcado ? ' ' : 'x'}$3`);
      break;
    }
    await this.app.vault.modify(file, fm + linhas.join('\n'));
  }

  nomeUnico(pasta, nome) {
    let candidato = nome;
    let i = 2;
    while (this.app.vault.getAbstractFileByPath(`${pasta}/${candidato}.md`)) {
      candidato = `${nome} ${i++}`;
    }
    return candidato;
  }

  async criarNota({ titulo = '', corpo = '', cor } = {}) {
    const pasta = await this.garantirPasta();
    const nome = this.nomeUnico(pasta.path, sanitizarNome(titulo) || `Nota ${moment().format('YYYY-MM-DD HH[h]mm')}`);
    const corFinal = CORES_IDS.has(cor) ? cor : this.settings.corPadrao;
    const conteudo = `---\ncolor: ${corFinal}\npinned: false\n---\n${corpo}`;
    return this.app.vault.create(`${pasta.path}/${nome}.md`, conteudo);
  }

  async renomear(file, novoTitulo) {
    const nome = sanitizarNome(novoTitulo);
    if (!nome || nome === file.basename) return file;
    const pastaPai = file.parent ? file.parent.path : this.pasta;
    const unico = this.nomeUnico(pastaPai, nome);
    await this.app.fileManager.renameFile(file, `${pastaPai}/${unico}.md`);
    return file;
  }

  async excluir(file) {
    await this.app.vault.trash(file, true);
  }

  async abrirView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getLeaf(false);
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
    return leaf;
  }

  async novaNota() {
    const file = await this.criarNota();
    await this.abrirView();
    new EditorModal(this.app, this, file).open();
  }
}

// ---------------------------------------------------------------------------
// Visão em grade
// ---------------------------------------------------------------------------

class KeepView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.busca = '';
    this.grades = [];
    this.recarregar = debounce(() => this.render(), 150);
    this.aoRedimensionar = debounce(() => this.redistribuirTudo(), 100);
  }

  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return 'Notas rápidas'; }
  getIcon() { return 'sticky-note'; }

  async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass('keep-root');

    // Cabeçalho: busca + botão Nova nota
    const header = root.createDiv({ cls: 'keep-header' });
    const buscaWrap = header.createDiv({ cls: 'keep-search' });
    setIcon(buscaWrap.createSpan({ cls: 'keep-search-icon' }), 'search');
    const busca = buscaWrap.createEl('input', { type: 'search', placeholder: 'Pesquisar notas', cls: 'keep-search-input' });
    busca.addEventListener('input', () => { this.busca = busca.value.trim().toLowerCase(); this.render(); });

    const btnNova = header.createEl('button', { cls: 'keep-btn-nova mod-cta' });
    setIcon(btnNova.createSpan(), 'plus');
    btnNova.createSpan({ text: 'Nova nota' });
    btnNova.addEventListener('click', () => this.plugin.novaNota());

    // Compositor rápido ("Criar uma nota...")
    this.montarCompositor(root);

    this.gridEl = root.createDiv({ cls: 'keep-sections' });
    this.ro = new ResizeObserver(() => this.aoRedimensionar());
    this.ro.observe(this.gridEl);

    const v = this.app.vault;
    const mc = this.app.metadataCache;
    const soPasta = (f) => { if (this.plugin.pertenceAPasta(f) || f instanceof TFolder) this.recarregar(); };
    this.registerEvent(v.on('create', soPasta));
    this.registerEvent(v.on('modify', soPasta));
    this.registerEvent(v.on('delete', soPasta));
    this.registerEvent(v.on('rename', (f, antigo) => {
      if (this.plugin.pertenceAPasta(f) || antigo.startsWith(this.plugin.pasta + '/')) this.recarregar();
    }));
    this.registerEvent(mc.on('changed', soPasta));

    await this.render();
  }

  montarCompositor(root) {
    const comp = root.createDiv({ cls: 'keep-composer', attr: { 'data-color': this.plugin.settings.corPadrao } });
    const titulo = comp.createEl('input', { type: 'text', placeholder: 'Título', cls: 'keep-composer-title' });
    const ta = comp.createEl('textarea', { placeholder: 'Criar uma nota...', cls: 'keep-composer-body', attr: { rows: 1 } });
    const fmt = new Formatador(ta, () => autoAltura(ta));
    const rodape = comp.createDiv({ cls: 'keep-composer-footer' });
    montarBarra(rodape, fmt);
    let cor = this.plugin.settings.corPadrao;
    montarPaleta(rodape, cor, (c) => { cor = c; comp.setAttribute('data-color', c); });
    const acoes = rodape.createDiv({ cls: 'keep-composer-actions' });
    const btnFechar = acoes.createEl('button', { text: 'Fechar', cls: 'keep-btn-ghost' });
    const btnSalvar = acoes.createEl('button', { text: 'Salvar', cls: 'mod-cta' });

    const abrir = () => { comp.addClass('is-open'); autoAltura(ta); };
    const fechar = () => {
      comp.removeClass('is-open');
      titulo.value = ''; ta.value = ''; ta.style.height = '';
      cor = this.plugin.settings.corPadrao;
      comp.setAttribute('data-color', cor);
      comp.querySelectorAll('.keep-color-dot').forEach((d) => d.toggleClass('is-active', d.dataset.color === cor));
    };
    const salvar = async () => {
      if (!titulo.value.trim() && !ta.value.trim()) return fechar();
      await this.plugin.criarNota({ titulo: titulo.value, corpo: ta.value.trim() + '\n', cor });
      fechar();
    };

    ta.addEventListener('focus', abrir);
    titulo.addEventListener('focus', abrir);
    ta.addEventListener('input', () => autoAltura(ta));
    ta.addEventListener('keydown', (ev) => {
      if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') { ev.preventDefault(); salvar(); return; }
      if (ev.key === 'Escape') { ev.preventDefault(); salvar(); ta.blur(); return; }
      fmt.atalho(ev);
    });
    titulo.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); ta.focus(); }
      if (ev.key === 'Escape') { ev.preventDefault(); salvar(); titulo.blur(); }
    });
    btnFechar.addEventListener('click', salvar); // "Fechar" no Keep também salva
    btnSalvar.addEventListener('click', salvar);
  }

  async carregarNotas() {
    const arquivos = this.plugin.listarNotas();
    const notas = await Promise.all(arquivos.map(async (file) => {
      const { cor, fixada } = this.plugin.lerMeta(file);
      const corpo = await this.plugin.lerCorpo(file);
      return { file, cor, fixada, corpo };
    }));
    notas.sort((a, b) => (b.fixada - a.fixada) || (b.file.stat.mtime - a.file.stat.mtime));
    if (!this.busca) return notas;
    return notas.filter((n) => (n.file.basename + '\n' + n.corpo).toLowerCase().includes(this.busca));
  }

  async render() {
    if (!this.gridEl) return;
    const notas = await this.carregarNotas();
    this.gridEl.empty();
    this.grades = [];
    this.gridEl.style.setProperty('--keep-card-w', `${this.plugin.settings.larguraCard}px`);

    if (!notas.length) {
      const vazio = this.gridEl.createDiv({ cls: 'keep-empty' });
      setIcon(vazio.createSpan({ cls: 'keep-empty-icon' }), 'sticky-note');
      vazio.createDiv({ text: this.busca ? 'Nenhuma nota corresponde à pesquisa.' : 'As notas que você criar aparecem aqui.' });
      return;
    }

    const fixadas = notas.filter((n) => n.fixada);
    const outras = notas.filter((n) => !n.fixada);
    if (fixadas.length) {
      this.gridEl.createDiv({ cls: 'keep-section-title', text: 'Fixadas' });
      this.montarGrade(fixadas);
      if (outras.length) this.gridEl.createDiv({ cls: 'keep-section-title', text: 'Outras' });
    }
    if (outras.length) this.montarGrade(outras);
  }

  montarGrade(notas) {
    const grade = this.gridEl.createDiv({ cls: 'keep-grid' });
    const cards = [];
    const prontos = [];
    for (const n of notas) {
      const { card, pronto } = this.montarCard(n);
      cards.push(card);
      prontos.push(pronto);
    }
    this.grades.push({ grade, cards });
    this.distribuir(grade, cards);
    // Depois que o Markdown de todos renderizou, redistribui com as alturas reais.
    Promise.all(prontos).then(() => this.distribuir(grade, cards));
  }

  // Masonry: cada cartão vai para a coluna mais baixa no momento.
  distribuir(grade, cards) {
    if (!grade.isConnected) return;
    const gap = 14;
    const largura = grade.clientWidth || this.gridEl.clientWidth || 800;
    const n = Math.max(1, Math.floor((largura + gap) / (this.plugin.settings.larguraCard + gap)));
    grade.empty();
    const cols = [];
    for (let i = 0; i < n; i++) cols.push(grade.createDiv({ cls: 'keep-col' }));
    for (const card of cards) {
      let alvo = cols[0];
      for (const c of cols) if (c.offsetHeight < alvo.offsetHeight) alvo = c;
      alvo.appendChild(card);
    }
  }

  redistribuirTudo() {
    for (const { grade, cards } of this.grades) this.distribuir(grade, cards);
  }

  montarCard(nota) {
    const { file, cor, fixada, corpo } = nota;
    const card = createDiv({ cls: 'keep-card', attr: { 'data-color': cor, 'data-path': file.path } });
    let pronto = Promise.resolve();

    // Fixar (canto superior direito)
    const pin = card.createEl('button', { cls: 'keep-card-pin clickable-icon' + (fixada ? ' is-active' : ''), attr: { 'aria-label': fixada ? 'Desafixar' : 'Fixar', title: fixada ? 'Desafixar' : 'Fixar' } });
    setIcon(pin, fixada ? 'pin-off' : 'pin');
    pin.addEventListener('click', (ev) => { ev.stopPropagation(); this.plugin.definirFixada(file, !fixada); });

    card.createDiv({ cls: 'keep-card-title', text: file.basename });

    const body = card.createDiv({ cls: 'keep-card-body markdown-rendered' });
    if (corpo.trim()) {
      pronto = MarkdownRenderer.render(this.app, corpo, body, file.path, this).then(() => {
        if (body.scrollHeight > body.clientHeight + 4) body.addClass('is-overflow');
        body.querySelectorAll('input.task-list-item-checkbox').forEach((cb, i) => {
          cb.disabled = false;
          cb.addEventListener('click', (ev) => {
            ev.stopPropagation();
            this.plugin.alternarTarefa(file, i);
          });
        });
      });
    } else {
      body.createDiv({ cls: 'keep-card-empty', text: 'Nota vazia' });
    }

    // Rodapé com ações (aparece ao passar o mouse)
    const rodape = card.createDiv({ cls: 'keep-card-footer' });
    const btnCor = rodape.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': 'Cor', title: 'Cor' } });
    setIcon(btnCor, 'palette');
    const pal = montarPaleta(rodape, cor, (c) => { this.plugin.definirCor(file, c); });
    pal.addClass('keep-palette-pop');
    btnCor.addEventListener('click', (ev) => { ev.stopPropagation(); pal.toggleClass('is-open', !pal.hasClass('is-open')); });

    const btnAbrir = rodape.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': 'Abrir como nota', title: 'Abrir como nota' } });
    setIcon(btnAbrir, 'file-text');
    btnAbrir.addEventListener('click', (ev) => { ev.stopPropagation(); this.app.workspace.getLeaf('tab').openFile(file); });

    const btnExcluir = rodape.createEl('button', { cls: 'clickable-icon keep-del', attr: { 'aria-label': 'Excluir', title: 'Excluir' } });
    setIcon(btnExcluir, 'trash-2');
    let armado = false;
    btnExcluir.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (!armado) {
        armado = true;
        btnExcluir.addClass('is-armed');
        btnExcluir.setAttribute('title', 'Clique de novo para excluir');
        setTimeout(() => { armado = false; btnExcluir.removeClass('is-armed'); btnExcluir.setAttribute('title', 'Excluir'); }, 2500);
        return;
      }
      this.plugin.excluir(file);
    });

    // Clique no cartão abre o editor (menos em links, caixas e botões)
    card.addEventListener('click', (ev) => {
      const t = ev.target;
      if (t.closest('button, input, .keep-palette')) return;
      const link = t.closest('a');
      if (link) {
        ev.preventDefault();
        if (link.hasClass('internal-link')) this.app.workspace.openLinkText(link.dataset.href || link.getAttribute('href'), file.path);
        else if (link.href) window.open(link.href);
        return;
      }
      new EditorModal(this.app, this.plugin, file).open();
    });

    // Fecha a paleta ao sair do cartão
    card.addEventListener('mouseleave', () => pal.removeClass('is-open'));
    return { card, pronto };
  }

  async onClose() {
    if (this.ro) this.ro.disconnect();
  }
}

// ---------------------------------------------------------------------------
// Modal de edição
// ---------------------------------------------------------------------------

class EditorModal extends Modal {
  constructor(app, plugin, file) {
    super(app);
    this.plugin = plugin;
    this.file = file;
    this.salvarCorpo = debounce(() => this._salvarCorpo(), 500);
    this.pendente = false;
  }

  async onOpen() {
    const { modalEl, contentEl } = this;
    modalEl.addClass('keep-modal');
    const { cor, fixada } = this.plugin.lerMeta(this.file);
    this.cor = cor;
    this.fixada = fixada;
    modalEl.setAttribute('data-color', cor);
    contentEl.empty();

    const topo = contentEl.createDiv({ cls: 'keep-modal-top' });
    this.tituloEl = topo.createEl('input', { type: 'text', cls: 'keep-modal-title', value: this.file.basename, placeholder: 'Título' });
    const pin = topo.createEl('button', { cls: 'clickable-icon keep-card-pin' + (fixada ? ' is-active' : ''), attr: { title: fixada ? 'Desafixar' : 'Fixar' } });
    setIcon(pin, fixada ? 'pin-off' : 'pin');
    pin.addEventListener('click', async () => {
      this.fixada = !this.fixada;
      await this.plugin.definirFixada(this.file, this.fixada);
      pin.toggleClass('is-active', this.fixada);
      pin.empty(); setIcon(pin, this.fixada ? 'pin-off' : 'pin');
    });

    this.ta = contentEl.createEl('textarea', { cls: 'keep-modal-body', placeholder: 'Nota', attr: { rows: 4 } });
    this.ta.value = await this.plugin.lerCorpo(this.file);
    const fmt = new Formatador(this.ta, () => { autoAltura(this.ta); this.marcarPendente(); });
    this.ta.addEventListener('input', () => { autoAltura(this.ta); this.marcarPendente(); });
    this.ta.addEventListener('keydown', (ev) => {
      if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') { ev.preventDefault(); this.close(); return; }
      fmt.atalho(ev);
    });
    this.tituloEl.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); this.ta.focus(); }
    });

    const rodape = contentEl.createDiv({ cls: 'keep-modal-footer' });
    montarBarra(rodape, fmt);
    montarPaleta(rodape, cor, async (c) => {
      this.cor = c;
      modalEl.setAttribute('data-color', c);
      await this.plugin.definirCor(this.file, c);
    });
    const acoes = rodape.createDiv({ cls: 'keep-modal-actions' });
    const btnAbrir = acoes.createEl('button', { cls: 'keep-btn-ghost', text: 'Abrir como nota' });
    btnAbrir.addEventListener('click', async () => { await this.close(); this.app.workspace.getLeaf('tab').openFile(this.file); });
    const btnExcluir = acoes.createEl('button', { cls: 'keep-btn-ghost keep-del', text: 'Excluir' });
    let armado = false;
    btnExcluir.addEventListener('click', async () => {
      if (!armado) { armado = true; btnExcluir.setText('Confirmar exclusão'); btnExcluir.addClass('is-armed'); setTimeout(() => { armado = false; btnExcluir.setText('Excluir'); btnExcluir.removeClass('is-armed'); }, 2500); return; }
      this.excluindo = true;
      await this.plugin.excluir(this.file);
      this.close();
    });
    const btnOk = acoes.createEl('button', { cls: 'mod-cta', text: 'Concluído' });
    btnOk.addEventListener('click', () => this.close());

    setTimeout(() => { autoAltura(this.ta); this.ta.focus(); this.ta.setSelectionRange(this.ta.value.length, this.ta.value.length); }, 0);
  }

  marcarPendente() { this.pendente = true; this.salvarCorpo(); }

  async _salvarCorpo() {
    if (this.excluindo || !this.pendente) return;
    this.pendente = false;
    try { await this.plugin.escreverCorpo(this.file, this.ta.value); }
    catch (e) { new Notice('Não foi possível salvar a nota: ' + e.message); }
  }

  async onClose() {
    if (this.excluindo) return;
    await this._salvarCorpo();
    const novoTitulo = this.tituloEl ? this.tituloEl.value : '';
    if (novoTitulo.trim() && sanitizarNome(novoTitulo) !== this.file.basename) {
      try { await this.plugin.renomear(this.file, novoTitulo); }
      catch (e) { new Notice('Não foi possível renomear: ' + e.message); }
    }
  }
}

// ---------------------------------------------------------------------------
// Configurações
// ---------------------------------------------------------------------------

class KeepSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName('Pasta das notas')
      .setDesc('Toda nota criada pelo plugin vai para esta pasta. É criada automaticamente se não existir.')
      .addText((t) => t.setPlaceholder('Notas rápidas').setValue(this.plugin.settings.pasta)
        .onChange(async (v) => { this.plugin.settings.pasta = v.trim() || DEFAULT_SETTINGS.pasta; await this.plugin.salvarSettings(); }));

    new Setting(containerEl)
      .setName('Cor padrão das notas novas')
      .addDropdown((d) => {
        CORES.forEach((c) => d.addOption(c.id, c.nome));
        d.setValue(this.plugin.settings.corPadrao)
          .onChange(async (v) => { this.plugin.settings.corPadrao = v; await this.plugin.salvarSettings(); });
      });

    new Setting(containerEl)
      .setName('Incluir subpastas')
      .setDesc('Mostrar também notas que estejam em subpastas da pasta das notas.')
      .addToggle((t) => t.setValue(this.plugin.settings.incluirSubpastas)
        .onChange(async (v) => { this.plugin.settings.incluirSubpastas = v; await this.plugin.salvarSettings(); }));

    new Setting(containerEl)
      .setName('Largura dos cartões')
      .setDesc('Em pixels. Padrão: 240.')
      .addSlider((s) => s.setLimits(180, 400, 10).setDynamicTooltip().setValue(this.plugin.settings.larguraCard)
        .onChange(async (v) => { this.plugin.settings.larguraCard = v; await this.plugin.salvarSettings(); }));
  }
}

module.exports = KeepNotesPlugin;
