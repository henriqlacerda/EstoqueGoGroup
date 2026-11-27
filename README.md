# EstoqueGoGroup

Aplicação Next.js com App Router e TypeScript para análise de demanda, reposição e qualidade de dados da Fase 3.

## Dados

Os CSVs não são copiados para este repositório. Para análise local, informe `ESTOQUE_DATA_DIR` com o diretório que contém `skus.csv`, `vendas_diarias.csv`, `estoque_diario.csv`, `compras.csv` e `fornecedores.csv`.

## Execução

```bash
npm install
npm run dev
```

O painel fica em `http://localhost:3000`. O relatório de qualidade também está disponível em `/api/phase3` como JSON.

## Organização da Fase 3

- `src/lib/config.ts`: datas, campanhas, orçamento, horizonte, prazo alvo e níveis de serviço.
- `src/lib/phase3/reader.ts`: leitura e normalização dos CSVs.
- `src/lib/phase3/calendar.ts`: calendário por SKU, demanda base, dispersão, projeção sazonal e preenchimento do estoque.
- `src/lib/phase3/lead-time.ts`: amostras de recebimentos válidos e cascata de lead time.
- `src/lib/phase3/policy.ts`: estoque de segurança, ponto de pedido, nível alvo, simulação e alocação do orçamento.
- `src/lib/phase3/quality.ts`: duplicatas, cadastros, estoque, pedidos abertos e unidades.
- `src/lib/phase3/aggregation.ts`: agregação dos cenários e dos relatórios para a interface.

As linhas repetidas de vendas com a mesma chave `(sku, data)` são somadas para a demanda; a quantidade excedente de registros é reportada como duplicata. A compra é alocada dentro do orçamento por cobertura crescente e em múltiplos do MOQ. Cada cenário de nível de serviço recebe o orçamento definido em `config.ts`. Pedidos reais abertos com chegada estimada anterior ao início do horizonte são recebidos no primeiro dia projetado.

## Aproximação de venda perdida

A venda perdida é uma aproximação: conta dias da janela base com estoque final zero e histórico de venda, estima unidades perdidas pela média diária nos dias com estoque positivo (incluindo dias sem venda) e aplica o preço médio realizado. A projeção de serviço futura também é determinística e usa a demanda diária projetada.
