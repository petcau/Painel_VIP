const path = require('path');
const fs = require('fs');
const express = require('express');
const sql = require('mssql');

// Carrega .env sem dependência extra (process.loadEnvFile existe no Node >= 20.12)
const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile) && process.loadEnvFile) process.loadEnvFile(envFile);

const config = {
  server: process.env.DB_SERVER,
  port: Number(process.env.DB_PORT || 1433),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  options: { encrypt: true, trustServerCertificate: false },
  pool: { max: 5, min: 0, idleTimeoutMillis: 30000 },
  requestTimeout: 30000,
};

let poolPromise;
const getPool = () => (poolPromise ??= new sql.ConnectionPool(config).connect().catch((e) => {
  poolPromise = undefined;
  throw e;
}));

const IMG_BASE = (process.env.IMG_BASE || 'https://vip.uesc.br/storage/uesc').replace(/\/$/, '');
const imgUrl = (pasta, hash) => (hash ? `${IMG_BASE}/${pasta}/${encodeURIComponent(hash)}` : null);

const app = express();
// Campos do legado vêm com espaços em branco; normaliza para null
app.set('json replacer', (k, v) => (typeof v === 'string' ? v.trim() || null : v));
app.use(express.static(path.join(__dirname, 'public')));

// Falhas de rede/conexão (o Azure SQL derruba conexões ociosas): recria o pool e tenta mais uma vez.
const erroDeConexao = (e) => ['ESOCKET', 'ECONNCLOSED', 'ETIMEOUT', 'ECONNRESET', 'ENOTOPEN'].includes(e.code)
  || /socket hang up|Connection lost|closed/i.test(e.message);

const wrap = (fn) => async (req, res) => {
  try {
    try {
      await fn(req, res);
    } catch (e) {
      if (!erroDeConexao(e) || res.headersSent) throw e;
      console.warn(`Conexão com o banco falhou (${e.message}); tentando de novo.`);
      const velho = poolPromise;
      poolPromise = undefined;
      velho?.then((p) => p.close()).catch(() => {});
      await fn(req, res);
    }
  } catch (e) {
    console.error(e.message);
    if (!res.headersSent) res.status(500).json({ erro: 'Falha ao consultar o banco de dados.' });
  }
};

const LAB_BASE = `
  FROM EPF_Espaco_Fisico e
  JOIN TEPF_Tipo_EspFisico t ON t.tepf_cd_tipo_espaco_fisico = e.epf_cd_tipo_epf
  JOIN LOC_Localizacao l ON l.loc_cd_localizacao = e.epf_cd_localizacao
  JOIN CAM_Campus c ON c.cam_cd_campus = l.loc_cd_campus
  JOIN INS_Instituicao i ON i.ins_cd_instituicao = c.cam_cd_instituicao
  WHERE e.epf_status = 'A'`;

// Monta o WHERE dos filtros (compartilhado entre a lista e o resumo) e registra os parâmetros em `r`.
function filtrosLab(query, r) {
  const { q, tipo, local, campus, finalidade, multiusuario } = query;
  let where = '';

  const termo = (q || '').trim().slice(0, 100);
  if (termo) {
    r.input('q', sql.VarChar(102), `%${termo}%`);
    where += ` AND (e.epf_nm_espfisico LIKE @q OR e.epf_sg_espfisico LIKE @q OR e.epf_ds_espfisico LIKE @q
      OR e.epf_ds_areas LIKE @q OR e.epf_ds_atividades LIKE @q OR e.epf_ds_palavras_chave LIKE @q
      OR l.loc_nm_localizacao LIKE @q OR e.epf_cd_sala LIKE @q
      OR EXISTS (SELECT 1 FROM EQP_Equipamento q WHERE q.eqp_cd_espaco_fisico = e.epf_cd_espfisico
                 AND q.eqp_status = 'A' AND (q.eqp_nm_equipamento LIKE @q OR q.eqp_outras_denominacoes LIKE @q)))`;
  }
  for (const [nome, valor, col] of [['tipo', tipo, 't.tepf_cd_tipo_espaco_fisico'],
    ['local', local, 'l.loc_cd_localizacao'], ['campus', campus, 'c.cam_cd_campus']]) {
    const n = parseInt(valor, 10);
    if (Number.isInteger(n)) { r.input(nome, sql.Int, n); where += ` AND ${col} = @${nome}`; }
  }
  const col = { ensino: 'epf_st_ensino', pesquisa: 'epf_st_pesquisa', extensao: 'epf_st_extensao' }[finalidade];
  if (col) where += ` AND e.${col} = 'S'`;
  if (multiusuario === '1') where += ` AND e.epf_st_multiusuario = 'S'`;
  return where;
}

// Opções dos filtros
app.get('/api/filtros', wrap(async (req, res) => {
  const pool = await getPool();
  const [tipos, locais, campi] = await Promise.all([
    pool.request().query(`SELECT t.tepf_cd_tipo_espaco_fisico id, t.tepf_nm_tipo_epf nome, COUNT(*) total
      ${LAB_BASE} GROUP BY t.tepf_cd_tipo_espaco_fisico, t.tepf_nm_tipo_epf ORDER BY total DESC`),
    pool.request().query(`SELECT l.loc_cd_localizacao id, l.loc_nm_localizacao nome, COUNT(*) total
      ${LAB_BASE} GROUP BY l.loc_cd_localizacao, l.loc_nm_localizacao ORDER BY total DESC`),
    pool.request().query(`SELECT c.cam_cd_campus id, c.cam_nm_campus nome, i.ins_sg_instituicao instituicao, COUNT(*) total
      ${LAB_BASE} GROUP BY c.cam_cd_campus, c.cam_nm_campus, i.ins_sg_instituicao ORDER BY total DESC`),
  ]);
  res.json({ tipos: tipos.recordset, locais: locais.recordset, campi: campi.recordset });
}));

// Indicadores agregados dos laboratórios que passam nos filtros
app.get('/api/resumo', wrap(async (req, res) => {
  const pool = await getPool();
  const r = pool.request();
  const w = filtrosLab(req.query, r);
  const labs = `SELECT e.epf_cd_espfisico ${LAB_BASE} ${w}`;
  const run = async (sqlText) => (await r.query(sqlText)).recordset;

  const [kpi, porTipo, porLocal, finalidades, topLabs, topFabricantes, porAno, topCursos] = [
    await run(`SELECT
      (SELECT COUNT(*) FROM (${labs}) x) laboratorios,
      (SELECT COUNT(*) FROM EQP_Equipamento q WHERE q.eqp_status = 'A' AND q.eqp_cd_espaco_fisico IN (${labs})) equipamentos,
      (SELECT ISNULL(SUM(q.eqp_quantidade), 0) FROM EQP_Equipamento q WHERE q.eqp_status = 'A' AND q.eqp_cd_espaco_fisico IN (${labs})) unidades,
      (SELECT COUNT(DISTINCT e.epf_cd_localizacao) FROM EPF_Espaco_Fisico e WHERE e.epf_cd_espfisico IN (${labs})) locais,
      (SELECT COUNT(DISTINCT x.epfc_cd_crs) FROM EPFC_EspFisico_Curso x WHERE x.epfc_cd_epf IN (${labs})) cursos`),
    await run(`SELECT t.tepf_nm_tipo_epf nome, COUNT(*) total ${LAB_BASE} ${w} GROUP BY t.tepf_nm_tipo_epf ORDER BY total DESC`),
    await run(`SELECT l.loc_cd_localizacao id, l.loc_nm_localizacao nome, c.cam_nm_campus campus, c.cam_ds_endereco endereco,
        c.cam_nm_bairro bairro, c.cam_nm_cidade cidade, c.cam_sg_estado estado, i.ins_sg_instituicao instituicao,
        COUNT(*) total,
        SUM(ISNULL(ec.n, 0)) equipamentos
      ${LAB_BASE.replace('WHERE', `LEFT JOIN (SELECT eqp_cd_espaco_fisico id, COUNT(*) n FROM EQP_Equipamento
        WHERE eqp_status = 'A' GROUP BY eqp_cd_espaco_fisico) ec ON ec.id = e.epf_cd_espfisico WHERE`)} ${w}
      GROUP BY l.loc_cd_localizacao, l.loc_nm_localizacao, c.cam_nm_campus, c.cam_ds_endereco, c.cam_nm_bairro,
        c.cam_nm_cidade, c.cam_sg_estado, i.ins_sg_instituicao
      ORDER BY total DESC`),
    await run(`SELECT
      SUM(CASE WHEN e.epf_st_ensino = 'S' THEN 1 ELSE 0 END) Ensino,
      SUM(CASE WHEN e.epf_st_pesquisa = 'S' THEN 1 ELSE 0 END) Pesquisa,
      SUM(CASE WHEN e.epf_st_extensao = 'S' THEN 1 ELSE 0 END) Extensão,
      SUM(CASE WHEN e.epf_st_multiusuario = 'S' THEN 1 ELSE 0 END) Multiusuário
      ${LAB_BASE} ${w}`),
    await run(`SELECT TOP 10 e.epf_cd_espfisico id, e.epf_nm_espfisico nome, COUNT(*) total
      FROM EQP_Equipamento q JOIN EPF_Espaco_Fisico e ON e.epf_cd_espfisico = q.eqp_cd_espaco_fisico
      WHERE q.eqp_status = 'A' AND e.epf_cd_espfisico IN (${labs})
      GROUP BY e.epf_cd_espfisico, e.epf_nm_espfisico ORDER BY total DESC`),
    await run(`SELECT TOP 10 f.fab_nm_fabricante nome, COUNT(*) total
      FROM EQP_Equipamento q JOIN FAB_Fabricante f ON f.fab_cd_fabricante = q.eqp_cd_fabricante
      WHERE q.eqp_status = 'A' AND f.fab_nm_fabricante <> 'Não Informado' AND q.eqp_cd_espaco_fisico IN (${labs})
      GROUP BY f.fab_nm_fabricante ORDER BY total DESC`),
    await run(`SELECT q.eqp_nu_ano_aquisicao ano, COUNT(*) total FROM EQP_Equipamento q
      WHERE q.eqp_status = 'A' AND q.eqp_nu_ano_aquisicao > 1900 AND q.eqp_cd_espaco_fisico IN (${labs})
      GROUP BY q.eqp_nu_ano_aquisicao ORDER BY q.eqp_nu_ano_aquisicao`),
    await run(`SELECT TOP 10 r.crs_nm_curso nome, COUNT(*) total FROM EPFC_EspFisico_Curso x
      JOIN CRS_Curso r ON r.crs_cd_curso = x.epfc_cd_crs WHERE x.epfc_cd_epf IN (${labs})
      GROUP BY r.crs_nm_curso ORDER BY total DESC`),
  ];
  const f = finalidades[0] || {};
  res.json({
    kpi: kpi[0], porTipo, porLocal, topLabs, topFabricantes, porAno, topCursos,
    finalidades: Object.entries(f).map(([nome, total]) => ({ nome, total: total || 0 })),
  });
}));

// Estrutura do banco: tabelas, colunas, chaves e relacionamentos (somente metadados, nenhum dado de negócio)
app.get('/api/esquema', wrap(async (req, res) => {
  const pool = await getPool();
  const run = async (q) => (await pool.request().query(q)).recordset;
  const [colunas, linhas, fks, views] = await Promise.all([
    run(`SELECT t.name tabela, c.name coluna, ty.name tipo, c.max_length tam, c.precision prec, c.scale esc,
        c.is_nullable nulo, c.is_identity ident, CASE WHEN pk.column_id IS NULL THEN 0 ELSE 1 END pk
      FROM sys.tables t
      JOIN sys.columns c ON c.object_id = t.object_id
      JOIN sys.types ty ON ty.user_type_id = c.user_type_id
      LEFT JOIN (SELECT ic.object_id, ic.column_id FROM sys.indexes i
        JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
        WHERE i.is_primary_key = 1) pk ON pk.object_id = t.object_id AND pk.column_id = c.column_id
      ORDER BY t.name, c.column_id`),
    run(`SELECT t.name tabela, SUM(p.rows) linhas FROM sys.tables t
      JOIN sys.partitions p ON p.object_id = t.object_id AND p.index_id IN (0, 1) GROUP BY t.name`),
    run(`SELECT fk.name restricao, OBJECT_NAME(fk.parent_object_id) filha, COL_NAME(fkc.parent_object_id, fkc.parent_column_id) coluna,
        OBJECT_NAME(fk.referenced_object_id) pai, COL_NAME(fkc.referenced_object_id, fkc.referenced_column_id) coluna_pai
      FROM sys.foreign_keys fk JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
      ORDER BY filha, coluna`),
    run(`SELECT v.name nome, d.referenced_entity_name tabela FROM sys.views v
      JOIN sys.schemas s ON s.schema_id = v.schema_id AND s.name = 'dbo'
      LEFT JOIN sys.sql_expression_dependencies d ON d.referencing_id = v.object_id AND d.referenced_entity_name IS NOT NULL
      ORDER BY v.name`),
  ]);

  const tipo = (c) => {
    if (/char|binary/.test(c.tipo)) {
      const n = c.tam === -1 ? 'max' : (c.tipo.startsWith('n') ? c.tam / 2 : c.tam);
      return `${c.tipo}(${n})`;
    }
    return /^(decimal|numeric)$/.test(c.tipo) ? `${c.tipo}(${c.prec},${c.esc})` : c.tipo;
  };
  // SUM de bigint chega como texto; converte para não concatenar ao somar no painel.
  const contagem = Object.fromEntries(linhas.map((l) => [l.tabela, Number(l.linhas)]));
  const porTabela = new Map();
  for (const c of colunas) {
    if (!porTabela.has(c.tabela)) porTabela.set(c.tabela, []);
    const fk = fks.find((f) => f.filha === c.tabela && f.coluna === c.coluna);
    porTabela.get(c.tabela).push({
      nome: c.coluna, tipo: tipo(c), nulo: !!c.nulo, pk: !!c.pk, identity: !!c.ident,
      fk: fk ? { tabela: fk.pai, coluna: fk.coluna_pai } : null,
    });
  }
  const viewsAgrupadas = [...new Set(views.map((v) => v.nome))].map((nome) => ({
    nome, tabelas: [...new Set(views.filter((v) => v.nome === nome && v.tabela).map((v) => v.tabela))],
  }));

  res.json({
    tabelas: [...porTabela].map(([nome, cols]) => ({ nome, linhas: contagem[nome] ?? 0, colunas: cols })),
    relacionamentos: fks.map((f) => ({ restricao: f.restricao, filha: f.filha, coluna: f.coluna, pai: f.pai, colunaPai: f.coluna_pai })),
    views: viewsAgrupadas,
  });
}));

// Busca de laboratórios
app.get('/api/labs', wrap(async (req, res) => {
  const r = (await getPool()).request();
  const where = filtrosLab(req.query, r);
  const out = await r.query(`
    SELECT e.epf_cd_espfisico id, e.epf_nm_espfisico nome, e.epf_sg_espfisico sigla, e.epf_cd_sala sala,
      e.epf_ds_espfisico descricao, e.epf_ds_areas areas, e.epf_nu_capacidade capacidade,
      CASE WHEN e.epf_st_ensino = 'S' THEN 1 ELSE 0 END ensino,
      CASE WHEN e.epf_st_pesquisa = 'S' THEN 1 ELSE 0 END pesquisa,
      CASE WHEN e.epf_st_extensao = 'S' THEN 1 ELSE 0 END extensao,
      CASE WHEN e.epf_st_multiusuario = 'S' THEN 1 ELSE 0 END multiusuario,
      t.tepf_nm_tipo_epf tipo, l.loc_nm_localizacao local, c.cam_nm_campus campus, c.cam_nm_cidade cidade,
      i.ins_sg_instituicao instituicao,
      (SELECT COUNT(*) FROM EQP_Equipamento q WHERE q.eqp_cd_espaco_fisico = e.epf_cd_espfisico AND q.eqp_status = 'A') equipamentos,
      (SELECT TOP 1 m.epfi_nm_hash FROM EPFI_EspFisico_Imagem m WHERE m.epfi_cd_epf = e.epf_cd_espfisico AND m.epfi_status = 'A' ORDER BY m.epfi_cd_img) foto_hash
    ${LAB_BASE} ${where}
    ORDER BY e.epf_nm_espfisico`);
  res.json(out.recordset.map(({ foto_hash, ...l }) => ({ ...l, foto: imgUrl('epf', foto_hash) })));
}));

// Detalhe: infraestrutura e localização
app.get('/api/labs/:id', wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ erro: 'ID inválido.' });
  const pool = await getPool();
  const rq = () => pool.request().input('id', sql.Int, id);

  const lab = (await rq().query(`
    SELECT e.epf_cd_espfisico id, e.epf_nm_espfisico nome, e.epf_sg_espfisico sigla, e.epf_cd_sala sala,
      e.epf_ds_espfisico descricao, e.epf_ds_areas areas, e.epf_ds_atividades atividades,
      e.epf_ds_palavras_chave palavras_chave, e.epf_website website, e.epf_tel_contato telefone,
      e.epf_ds_regulamento regulamento, e.epf_nu_capacidade capacidade,
      CASE WHEN e.epf_st_ensino = 'S' THEN 1 ELSE 0 END ensino,
      CASE WHEN e.epf_st_pesquisa = 'S' THEN 1 ELSE 0 END pesquisa,
      CASE WHEN e.epf_st_extensao = 'S' THEN 1 ELSE 0 END extensao,
      CASE WHEN e.epf_st_multiusuario = 'S' THEN 1 ELSE 0 END multiusuario,
      t.tepf_nm_tipo_epf tipo, l.loc_nm_localizacao local, l.loc_url_regulamento url_regulamento_local,
      c.cam_nm_campus campus, c.cam_ds_endereco endereco, c.cam_ds_complemento complemento,
      c.cam_nm_bairro bairro, c.cam_nm_cidade cidade, c.cam_sg_estado estado, c.cam_nu_cep cep,
      i.ins_sg_instituicao instituicao, i.ins_nm_nome instituicao_nome,
      (SELECT TOP 1 p.pes_nm_pessoa FROM USU_Usuario u JOIN PES_Pessoa p ON p.pes_cd_pessoa = u.usu_cd_pessoa
        WHERE u.usu_cd_usuario = e.epf_cd_usuario_responsavel) responsavel
    ${LAB_BASE} AND e.epf_cd_espfisico = @id`)).recordset[0];
  if (!lab) return res.status(404).json({ erro: 'Laboratório não encontrado.' });

  const [equip, cursos, fotos, fotosLocal] = await Promise.all([
    rq().query(`SELECT q.eqp_cd_equipamento id, q.eqp_nm_equipamento nome, q.eqp_sigla sigla,
        q.eqp_ds_modelo modelo, q.eqp_quantidade quantidade, f.fab_nm_fabricante fabricante,
        NULLIF(q.eqp_nu_ano_aquisicao, 1900) ano,
        (SELECT TOP 1 m.eqpi_nm_hash FROM EQPI_Equipamento_Imagem m WHERE m.eqpi_cd_eqp = q.eqp_cd_equipamento AND m.eqpi_status = 'A' ORDER BY m.eqpi_cd_img) foto_hash
      FROM EQP_Equipamento q JOIN FAB_Fabricante f ON f.fab_cd_fabricante = q.eqp_cd_fabricante
      WHERE q.eqp_cd_espaco_fisico = @id AND q.eqp_status = 'A' ORDER BY q.eqp_nm_equipamento`),
    rq().query(`SELECT r.crs_nm_curso nome FROM EPFC_EspFisico_Curso x
      JOIN CRS_Curso r ON r.crs_cd_curso = x.epfc_cd_crs WHERE x.epfc_cd_epf = @id ORDER BY r.crs_nm_curso`),
    rq().query(`SELECT epfi_nm_hash h FROM EPFI_EspFisico_Imagem WHERE epfi_cd_epf = @id AND epfi_status = 'A' ORDER BY epfi_cd_img`),
    rq().query(`SELECT m.loci_nm_hash h FROM LOCI_Localizacao_Imagem m JOIN EPF_Espaco_Fisico e ON e.epf_cd_localizacao = m.loci_cd_localizacao
      WHERE e.epf_cd_espfisico = @id AND m.loci_status = 'A' ORDER BY m.loci_cd_img`),
  ]);
  res.json({
    ...lab,
    fotos: fotos.recordset.map((f) => imgUrl('epf', f.h)),
    fotos_local: fotosLocal.recordset.map((f) => imgUrl('loc', f.h)),
    equipamentos: equip.recordset.map(({ foto_hash, ...e }) => ({ ...e, foto: imgUrl('eqp', foto_hash) })),
    cursos: cursos.recordset.map((c) => c.nome),
  });
}));

const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`Painel VIP em http://localhost:${port}`));
