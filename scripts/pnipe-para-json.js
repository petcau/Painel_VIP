// Converte dados/pnipe_observatorio.xlsx em dados/pnipe.json, lido pelo servidor em /api/pnipe.
// Uso: node scripts/pnipe-para-json.js
// Sem dependências: o .xlsx é um zip de XMLs; lemos o zip com zlib e as planilhas com expressões regulares.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ORIGEM = path.join(__dirname, '..', 'dados', 'pnipe_observatorio.xlsx');
const DESTINO = path.join(__dirname, '..', 'dados', 'pnipe.json');

// --- Leitura mínima de zip (diretório central + deflate) ---
function lerZip(buf) {
  let fim = buf.length - 22;
  while (fim >= 0 && buf.readUInt32LE(fim) !== 0x06054b50) fim--;
  if (fim < 0) throw new Error('Arquivo não é um zip válido.');
  const total = buf.readUInt16LE(fim + 10);
  let p = buf.readUInt32LE(fim + 16);
  const arquivos = {};
  for (let i = 0; i < total; i++) {
    const metodo = buf.readUInt16LE(p + 10);
    const tamComp = buf.readUInt32LE(p + 20);
    const nLen = buf.readUInt16LE(p + 28);
    const xLen = buf.readUInt16LE(p + 30);
    const cLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const nome = buf.toString('utf8', p + 46, p + 46 + nLen);
    const ini = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const dados = buf.subarray(ini, ini + tamComp);
    arquivos[nome] = () => (metodo === 0 ? dados : zlib.inflateRawSync(dados)).toString('utf8');
    p += 46 + nLen + xLen + cLen;
  }
  return arquivos;
}

const desescapar = (s) =>
  s.replace(/&(lt|gt|quot|apos|amp|#\d+|#x[0-9a-f]+);/gi, (_, e) =>
    ({ lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' })[e.toLowerCase()] ??
    String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)));
// Tags podem vir com prefixo de namespace (<x:sheet>, <x:row>…); `elemento` casa os dois formatos.
// Com conteúdo: grupo 1 = atributos, grupo 2 = conteúdo. Sem conteúdo: só a tag de abertura.
const NS = '(?:[\\w]+:)?';
const elemento = (nome, flags = 'g') => new RegExp(`<${NS}${nome}(\\s[^>]*?)?(?:/>|>([\\s\\S]*?)</${NS}${nome}>)`, flags);
const abertura = (nome) => new RegExp(`<${NS}${nome}\\s[^>]*>`, 'g');
const atributo = (tag, nome) => (tag.match(new RegExp(`(?:^|\\s)${nome}="([^"]*)"`)) || [])[1];
const textoDe = (xml) => desescapar([...xml.matchAll(elemento('t'))].map((m) => m[2] || '').join(''));

function lerPlanilhas(arquivo) {
  const zip = lerZip(fs.readFileSync(arquivo));
  const compartilhadas = zip['xl/sharedStrings.xml']
    ? [...zip['xl/sharedStrings.xml']().matchAll(elemento('si'))].map((m) => textoDe(m[2] || ''))
    : [];
  const rels = Object.fromEntries(
    [...zip['xl/_rels/workbook.xml.rels']().matchAll(abertura('Relationship'))].map((m) => [
      atributo(m[0], 'Id'),
      atributo(m[0], 'Target').replace(/^\/?(xl\/)?/, 'xl/'),
    ]),
  );
  const planilhas = {};
  for (const m of zip['xl/workbook.xml']().matchAll(abertura('sheet'))) {
    const nome = desescapar(atributo(m[0], 'name'));
    const alvo = rels[atributo(m[0], 'r:id')];
    const linhas = [];
    for (const l of zip[alvo]().matchAll(elemento('row'))) {
      const linha = [];
      for (const c of (l[2] || '').matchAll(elemento('c'))) {
        const attrs = c[1] || '';
        const col = atributo(attrs, 'r').match(/[A-Z]+/)[0].split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
        const tipo = atributo(attrs, 't');
        const corpo = c[2] || '';
        const v = (corpo.match(elemento('v', '')) || [])[2];
        linha[col] = tipo === 's' ? compartilhadas[+v] : tipo === 'inlineStr' ? textoDe(corpo) : v !== undefined ? desescapar(v) : '';
      }
      linhas.push(linha);
    }
    planilhas[nome] = linhas;
  }
  return planilhas;
}

// Primeira linha = cabeçalho; devolve objetos com texto aparado.
function comoObjetos(linhas) {
  const [cab, ...resto] = linhas;
  return resto
    .filter((l) => l.some((v) => v !== undefined && v !== ''))
    .map((l) => Object.fromEntries(cab.map((c, i) => [c, l[i] === undefined ? '' : String(l[i]).trim()])));
}

const planilhas = lerPlanilhas(ORIGEM);
const aba = (nome) => {
  if (!planilhas[nome]) throw new Error(`Aba "${nome}" não encontrada na planilha.`);
  return comoObjetos(planilhas[nome]);
};

const instituicoes = aba('Instituições');
const labs = aba('Laboratórios');
const equip = aba('Equipamentos');
const verdade = (v) => v === 'True' || v === 'TRUE' || v === '1';
const numero = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};
const texto = (v) => String(v || '').trim() || null;

// Percentual de registros com cada campo preenchido (para o dicionário de campos).
const preenchimento = (lista) => {
  const cols = Object.keys(lista[0] || {});
  return Object.fromEntries(cols.map((c) => [c, lista.length ? lista.filter((r) => r[c] !== '').length / lista.length : 0]));
};

const siglas = [...new Set(instituicoes.map((i) => i.observatorio_sigla))];
const saida = {
  fonte: 'Plataforma Nacional de Infraestrutura de Pesquisa (PNIPE/MCTI) — https://pnipe.mcti.gov.br',
  gerado_em: new Date().toISOString().slice(0, 10),
  instituicoes: siglas.map((sigla) => {
    const cads = instituicoes.filter((i) => i.observatorio_sigla === sigla);
    const ls = labs.filter((l) => l.observatorio_sigla === sigla);
    const es = equip.filter((e) => e.observatorio_sigla === sigla);
    return {
      sigla,
      nome: cads[0].social_reason,
      cnpjs: cads.map((i) => i.cnpj),
      laboratorios: ls.length,
      laboratorios_compartilhados: ls.filter((l) => verdade(l.hasSharing)).length,
      equipamentos: es.length,
      equipamentos_ativos: es.filter((e) => e.situation === 'ACTIVE').length,
      equipamentos_declarados: cads.reduce((s, i) => s + (+i.totalEquip || 0), 0),
    };
  }),
  preenchimento: {
    instituicao: preenchimento(instituicoes),
    laboratorio: preenchimento(labs),
    equipamento: preenchimento(equip),
  },
  laboratorios: labs.map((l) => ({
    id: l.idAsset,
    sigla_instituicao: l.observatorio_sigla,
    nome: l.name,
    sigla: l.initials,
    cidade: l.list_city,
    estado: l.list_state,
    descricao: texto(l.about),
    instituicao_nome: texto(l.institution_name),
    cep: texto(l.address_zipCode),
    logradouro: texto(l.address_street),
    numero: texto(l.address_number),
    complemento: texto(l.address_complement),
    bairro: texto(l.address_district),
    latitude: numero(l.latitude),
    longitude: numero(l.longitude),
    compartilhado: verdade(l.hasSharing),
    compartilhamento: texto(l.sharingType),
    areas: texto(l.areas_expertise),
    tecnicas: texto(l.techniques),
    estruturas: texto(l.organizational_structures),
    contato: texto(l.contact_name),
    telefone: texto(l.contact_phone),
    email: texto(l.email),
    website: texto(l.website),
    imagem: texto(l.primary_image_url),
    url: l.public_url,
  })),
  equipamentos: equip.map((e) => ({
    id: e.idAsset,
    lab: e.idLab,
    sigla_instituicao: e.observatorio_sigla,
    nome: e.name,
    sigla: texto(e.initials),
    codigo: texto(e.code),
    descricao: texto(e.about),
    marca: e.brand,
    modelo: e.model,
    ano: +e.purchaseYear || null,
    ativo: e.situation === 'ACTIVE',
    laboratorio_nome: texto(e.laboratory_name),
    cidade: texto(e.laboratory_city),
    estado: texto(e.laboratory_state),
    multiusuario: verdade(e.multiuser),
    compartilhado: verdade(e.hasSharing),
    compartilhamento: texto(e.sharingType),
    contato: texto(e.contact_name),
    telefone: texto(e.contact_phone),
    email: texto(e.email),
    website: texto(e.website),
    denominacoes: texto(e.denominations),
    tecnicas: texto(e.techniques),
    parametros: texto(e.parameters),
    imagem: texto(e.primary_image_url),
    url: texto(e.public_url),
  })),
};

fs.writeFileSync(DESTINO, JSON.stringify(saida));
console.log(`${path.relative(process.cwd(), DESTINO)}: ${saida.instituicoes.length} instituições, ${saida.laboratorios.length} laboratórios, ${saida.equipamentos.length} equipamentos.`);
