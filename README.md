# Painel_VIP

Painel de laboratórios do VIP, com infraestrutura (equipamentos, cursos atendidos) e dados de localização (instituição, campus, pavilhão, sala).

O front segue a mesma tecnologia do [Observatorio_Tematico](https://github.com/petcau/Observatorio_Tematico): React, Babel e Tailwind carregados via CDN, JSX transformado no navegador, sem build e sem bundler.

## Como rodar

O navegador não fala direto com o SQL Server, então há um servidor Node mínimo que serve a pasta `public/` e expõe a API de dados.

```
npm install
cp .env.example .env   # preencha as credenciais do SQL Server
npm start              # http://localhost:3000
```

O `.env` não é versionado. Use um usuário do banco somente leitura. Não abra `public/index.html` direto nem pelo Live Server: sem o servidor Node, as chamadas a `/api` não funcionam.

## Estrutura

- `server.js` — API Express (`/api/filtros`, `/api/resumo`, `/api/labs`, `/api/labs/:id`, `/api/esquema`) com consultas parametrizadas e somente leitura.
- `public/index.html` — carrega as bibliotecas por CDN e os scripts na ordem.
- `public/js/config.js` — título, texto do rodapé e origem da API.
- `public/js/lib/` — formatação, cores e cliente da API.
- `public/js/components/` e `public/js/App.js` — interface em React (um arquivo por componente).
- `dados/` — dados do PNIPE para a aba "Correlação VIP × PNIPE" (seção Banco de Dados):
  - `pnipe_observatorio.xlsx` — planilha original; depois de trocá-la, rode `node scripts/pnipe-para-json.js` para gerar `pnipe.json`;
  - `dicionario_pnipe_vip.json` — campo do PNIPE ↔ coluna do VIP;
  - `correspondencia_pnipe_vip.json` — laboratório do PNIPE ↔ localização/espaço físico do VIP (feita à mão).
