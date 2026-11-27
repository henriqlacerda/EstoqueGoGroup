# EstoqueGoGroup

Aplicação Next.js (App Router, TypeScript) para o planejamento de reposição da Fase 3: demanda, lead time, política de estoque, alocação de orçamento e um agente que valida e justifica as decisões.

## Como rodar

```bash
npm install
npm run dev     # http://localhost:3000
npm run build   # verificação de produção
```

Na página, selecione os quatro arquivos (`skus.csv`, `vendas_diarias.csv`, `estoque_diario.csv` e `compras.csv`) e clique em **Calcular análise**. Os cálculos rodam no navegador; os CSVs não são enviados a nenhuma API e não estão neste repositório.

Variáveis de ambiente (opcionais, somente no servidor):

- `GROQ_API_KEY`: chave usada apenas pela rota `/api/agent`. Sem ela, o painel usa as decisões determinísticas. Nunca use prefixo `NEXT_PUBLIC_`.
- `GROQ_MODEL`: modelo da Groq (padrão `openai/gpt-oss-120b`).

`ESTOQUE_DATA_DIR` é usado só pelo script de desenvolvimento `npm run data:inspect` (`scripts/dev-read-data.mjs`), que lê os CSVs de um diretório local para inspeção. O painel não depende dele. Opcionalmente, `ESTOQUE_TRACE_SKUS` aceita SKUs separados por vírgula para o rastreio detalhado desse script.

`fornecedores.csv` não é usado: o fornecedor vem da coluna `fornecedor` de `skus.csv` e de `compras.csv`.

## Organização

- `src/lib/config.ts`: datas, campanhas, orçamento, horizonte, prazo alvo e níveis de serviço.
- `src/lib/phase3/reader.ts`: leitura, validação de colunas e normalização dos CSVs.
- `src/lib/phase3/calendar.ts`: demanda base, dispersão, sazonalidade, projeção e preenchimento do estoque.
- `src/lib/phase3/lead-time.ts`: amostras de recebimentos válidos e cascata de lead time.
- `src/lib/phase3/policy.ts`: estoque de segurança, ponto de pedido, nível alvo, alocação do orçamento e simulação diária.
- `src/lib/phase3/quality.ts`: duplicatas, cadastro, estoque negativo, pedidos abertos e unidades.
- `src/lib/phase3/aggregation.ts`: cenários, curva de orçamento e métricas para a interface.
- `src/app/api/agent/route.ts`: validação e chamada ao modelo.
- `src/components/ClientDashboard.tsx`: painel, cálculo no navegador e envio dos resumos ao agente.

## Regras de cálculo

- **Duplicatas de vendas:** a chave é `(sku, data)`. Mantém-se a primeira linha e as demais são contadas como duplicatas. Não há soma.
- **Estoque negativo:** ao calcular o saldo de um SKU, valores negativos são limitados a zero.
- **Lead time:** só entram recebimentos com data de recebimento igual ou posterior ao pedido e não posterior à data de referência. Média em dias arredondada para cima e desvio amostral. Cascata: SKU (com pelo menos 3 amostras), depois fornecedor (pelo menos 3), depois global.
- **Sazonalidade:** para cada categoria, fator = média diária na campanha de 2025 ÷ média diária da base de 02/07 a 29/09/2025. Black Friday: 20/11 a 30/11. Natal: 01/12 a 22/12. Fora dessas datas, fator 1.
- **Política:** estoque de segurança SS = z·√(L̄·σd² + d̄²·σL²). Ponto de pedido ROP = demanda projetada em L̄ dias + SS. Nível alvo S = demanda projetada em L̄ + T dias + SS, com T = 30. Quantidade Q = max(0, S − posição), arredondada para cima em múltiplos do MOQ (caixa de 12 unidades).
- **Alocação do orçamento:** em rodadas e em passos de MOQ, ordenada por score = (preço realizado − custo) × demanda base ÷ custo, ou seja, margem por real, com cobertura como desempate. Cada pedido recebe status financiado, parcial ou não financiado. Depois de um corte, o SKU não recebe mais unidades.
- **Cenário A:** só entram pedidos com chegada até 29/12, fim do horizonte. Pedidos reais abertos com chegada prevista antes de 01/10 são recebidos no primeiro dia do horizonte.
- **Níveis de serviço:** 95% (z = 1,645), 98% (z = 2,054, oficial) e 99% (z = 2,326).
- **Custo de carregamento:** 2,7% ao mês sobre o estoque médio, por 3 meses.

## Resultados

Cenário A, T = 30, SS = 98%, orçamento oficial de R$ 1,97 mi e recomendado de R$ 5,0 mi:

| Orçamento | Gasto | Atendimento de unidades | SKU-dias sem ruptura |
|---|---|---|---|
| R$ 1,97 mi (oficial) | R$ 1.969.994,92 | 79,99% | 83,57% |
| R$ 4,4 mi | R$ 4.399.978,00 | 95,55% | 91,41% |
| **R$ 5,0 mi (recomendado)** | R$ 4.999.987,74 | **98,03%** | 95,76% |
| R$ 5,3 mi | — | 99,44% | 99,31% |

Com R$ 5,0 mi, o estoque final é de R$ 3.954.929 e o ganho líquido de R$ 30.509.272. Ganho líquido = margem recuperada − custo de carregamento.

Sensibilidade do T e do SS (cenário A):

- T = 30 e SS = 98%: R$ 5,0 mi já passa de 98%.
- T = 0 e SS = 98%: o primeiro teto acima de 98% é R$ 5,25 mi.
- T = 30 e SS = 0, ou T = 0 e SS = 0: R$ 4,75 mi.

Atendimento por janela, com orçamento de R$ 1,97 mi: antes de 20/11 99,81%; Black Friday 85,75%; Natal 59,83%; 23/12 a 29/12 49,18%. Com R$ 5,5 mi: 99,98%, 99,98%, 99,18% e 96,57%.

Diagnóstico da base (janela de 02/07 a 29/09/2026):

- **Venda perdida histórica:** 291,02 unidades e R$ 11.722,51, em 24 SKU-dias com estoque zero e venda. É uma aproximação, veja abaixo.
- **Capital parado:** R$ 125.514,16 em SKUs sem venda na base.
- **Excesso em ativos:** 20 SKUs com cobertura final acima de 365 dias, R$ 1.478.779,64 (104.652,03 unidades).
- **Descontinuados:** 53 SKUs, 32.406 unidades, custo de R$ 454.462,84. Liquidados com desconto de até 40% e sem vender abaixo do custo, a receita líquida é de R$ 1.303.004,04 se vendidos a 100% do preço, R$ 651.502 a 50% e R$ 325.751 a 25%.
- **Margem bruta:** 77,02% (receita R$ 23.531.070,40; CMV R$ 5.407.747,50). Com margem 10% e 20% menor, o atendimento não muda e o ganho líquido com R$ 1,97 mi fica em R$ 21,9 mi e R$ 19,4 mi.

## Qualidade dos dados

- 656 linhas de vendas duplicadas, todas com valores idênticos (0 conflitos).
- 120 registros de estoque negativo, em 58 SKUs.
- Compras: 1.672 recebimentos válidos de 1.762 registros; 90 pedidos sem recebimento (abertos); 0 recebimentos antes do pedido; 0 pedidos abertos com mais de 90 dias.
- Lead time: 306 SKUs com amostra própria, 194 pela média do fornecedor e 0 pela média global.

## Aproximação de venda perdida

A venda perdida histórica conta os dias da janela base com estoque final zero e histórico de venda. Estima as unidades perdidas pela média diária de venda nos dias com estoque positivo, multiplicada pelo número de dias de ruptura, e valoriza pelo preço médio realizado. A projeção de serviço futura é determinística e usa a demanda diária projetada.

## Agente

O painel envia os 30 SKUs com maior demanda não atendida projetada, em lotes de 10, para `/api/agent`. Para cada SKU, o modelo (openai/gpt-oss-120b, via Groq) sugere uma ação entre comprar, manter, liquidar e revisar, com justificativa curta, e recebe a ação determinística como referência.

- As quantidades vêm da política determinística e não podem ser alteradas pelo modelo.
- O servidor valida o formato da entrada e da resposta. Liquidação só para SKU descontinuado com preço líquido igual ou acima do custo. Ativo com cobertura final acima de 365 dias recebe revisar. Compra só com unidades financiadas.
- Resposta inválida ou que viole essas regras é substituída pela decisão determinística e marcada como fallback. Um revisar sem código de regra também é substituído pela decisão determinística e marcado como fallback.
- Códigos de revisar: [R1] cobertura final acima de 365 dias; [R2] sem venda na janela base; [R3] pedido calculado sem unidades financiadas; [R4] demanda não atendida sem pedido financiado.
- A tabela e o painel mostram a origem de cada decisão: agente, fallback ou determinística. Só respostas com `fallback: false` contam como resposta do agente.

Limitação: não medimos com que frequência o modelo diverge da política determinística. O agente explica e valida as decisões, mas não é uma fonte independente de decisão.

## Limitações

- A simulação é determinística. 98% é resultado do plano sob estas premissas, não garantia de serviço.
- A sazonalidade vem de um único ano (2025). Não há tendência de crescimento, e janeiro de 2027 não é modelado.
- No cenário A, pedidos com chegada após 29/12 ficam de fora.
- Em dias de ruptura a demanda é censurada, então a venda perdida é aproximada.
- O efeito da liquidação não é medido, pois não há dados de elasticidade.
- A margem bruta é alta (cerca de 77%). A sensibilidade está acima.
- Datas são comparadas como texto no formato AAAA-MM-DD. Estoque e compras não são deduplicados na leitura; a qualidade os reporta.
- `/api/agent` é público e não tem limite de taxa. Chamadas em excesso consomem a cota da Groq.
