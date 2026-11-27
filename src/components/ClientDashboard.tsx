"use client";

import { useMemo, useState } from "react";
import { aggregatePhase3 } from "@/lib/phase3/aggregation";
import { parseUploadedData } from "@/lib/phase3/reader";
import type { CsvUploadTexts } from "@/lib/phase3/reader";
import type { Dataset, Phase3Config, Phase3Report, SkuPolicy } from "@/lib/phase3/types";

type FileKey = keyof CsvUploadTexts;
type UploadedFiles = Record<FileKey, File | null>;

const fileRequirements: Array<{ key: FileKey; filename: string; label: string }> = [
  { key: "skus", filename: "skus.csv", label: "Cadastro de SKUs" },
  { key: "sales", filename: "vendas_diarias.csv", label: "Vendas diárias" },
  { key: "stock", filename: "estoque_diario.csv", label: "Estoque diário" },
  { key: "purchases", filename: "compras.csv", label: "Compras" },
];

const money = (value: number) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
const number = (value: number) => new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2 }).format(value);
const percent = (value: number) => new Intl.NumberFormat("pt-BR", { style: "percent", maximumFractionDigits: 2 }).format(value);
const budgetName = (value: number) => Number.isFinite(value) ? money(value) : "Sem limite";

function Metric({ label, value, note }: { label: string; value: string; note: string }) {
  return <article className="metric"><span className="metric-label">{label}</span><strong>{value}</strong><span className="metric-note">{note}</span></article>;
}

function SampleTable({ rows }: { rows: Array<{ label: string; policy: SkuPolicy | null }> }) {
  const fields: Array<[string, (policy: SkuPolicy) => string]> = [
    ["Demanda média base / dia", (p) => number(p.baseMean)],
    ["σd amostral", (p) => number(p.baseSigma)],
    ["L̄ / σL", (p) => `${p.leadTime.meanDays} dias / ${number(p.leadTime.sigmaDays)} dias`],
    ["Fonte do lead time", (p) => `${p.leadTime.source} · ${p.leadTime.sourceKey}`],
    ["Posição no gatilho", (p) => number(p.decisionPosition)],
    ["ROP(t)", (p) => number(p.reorderPoint)],
    ["S(t)", (p) => number(p.targetLevel)],
    ["Q calculado / financiado", (p) => `${number(p.orderQuantity)} / ${number(p.fundedQuantity)}`],
    ["Data do gatilho", (p) => p.firstOrderDate ?? "Sem gatilho"],
    ["Cobertura", (p) => `${number(p.coverage)} dias`],
  ];
  return <div className="table-wrap"><table><thead><tr><th>Métrica</th>{rows.map((r) => <th key={r.label}>{r.label}{r.policy ? <small>{r.policy.sku}</small> : null}</th>)}</tr></thead><tbody>{fields.map(([label, value]) => <tr key={label}><th scope="row">{label}</th>{rows.map((row) => <td key={row.label}>{row.policy ? value(row.policy) : "—"}</td>)}</tr>)}</tbody></table></div>;
}

export default function ClientDashboard({ config }: { config: Phase3Config }) {
  const [files, setFiles] = useState<UploadedFiles>({ skus: null, sales: null, stock: null, purchases: null });
  const [report, setReport] = useState<Phase3Report | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [agentStatus, setAgentStatus] = useState("");
  const [agentBusy, setAgentBusy] = useState(false);
  const ready = fileRequirements.every(({ key }) => files[key] !== null);
  const samples = useMemo(() => report ? [
    { label: "Com vendas", policy: report.sampleWithSales },
    { label: "Com ruptura", policy: report.sampleInRupture },
  ] : [], [report]);

  const selectFile = (key: FileKey, file: File | null) => {
    setFiles((current) => ({ ...current, [key]: file }));
    setReport(null);
    setError("");
    setAgentStatus("");
  };

  async function calculate() {
    if (!ready) return;
    setBusy(true); setError(""); setReport(null);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    try {
      const sources = {} as CsvUploadTexts;
      for (const { key } of fileRequirements) sources[key] = await files[key]!.text();
      const data: Dataset = parseUploadedData(sources);
      setReport(aggregatePhase3(data, config));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Não foi possível processar os arquivos selecionados.");
    } finally { setBusy(false); }
  }

  async function sendAgentSummary() {
    if (!report) return;
    const selected = [...report.official.policies].filter((policy) => policy.baseMean > 0)
      .sort((a, b) => b.projectedUnmetUnits - a.projectedUnmetUnits || a.sku.localeCompare(b.sku)).slice(0, 30);
    if (selected.length !== 30) { setAgentStatus("A base precisa ter pelo menos 30 SKUs com demanda para enviar o resumo."); return; }
    setAgentBusy(true); setAgentStatus("");
    const summary = selected.map((policy) => ({
      sku: policy.sku, status: policy.status, demandMean: policy.baseMean, position: policy.openingPosition,
      reorderPoint: policy.reorderPoint, targetLevel: policy.targetLevel, suggestedUnits: policy.orderQuantity,
      fundedUnits: policy.fundedQuantity, coverageDays: policy.coverage, unmetUnits: policy.projectedUnmetUnits,
    }));
    try {
      const response = await fetch("/api/agent", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ selectedSkus: summary }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Falha ao enviar resumo.");
      setAgentStatus(`Resumo de ${result.received} SKUs enviado; ${result.atRisk} estão com unidades não atendidas.`);
    } catch (reason) { setAgentStatus(reason instanceof Error ? reason.message : "Falha ao enviar resumo."); }
    finally { setAgentBusy(false); }
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="/" aria-label="EstoqueGoGroup, início"><span className="brand-mark">E</span><span>Estoque<span className="brand-light">Go</span></span></a>
        <p className="nav-caption">PLANEJAMENTO</p>
        <nav aria-label="Navegação principal">
          <a className="nav-link active" href="#resumo"><span>▦</span> Resumo</a>
          <a className="nav-link" href="#orcamento"><span>◷</span> Curva de orçamento</a>
          <a className="nav-link" href="#sanidade"><span>✓</span> Sanidade</a>
          <a className="nav-link" href="#qualidade"><span>⌕</span> Qualidade</a>
        </nav>
        <div className="sidebar-bottom"><span className="status-dot" /> Cálculo local no navegador</div>
      </aside>

      <section className="main-area">
        <header className="topbar"><div className="crumb">Estoque <span>/</span> Planejamento</div><div className="date-chip"><span className="chip-dot" /> Referência · {config.referenceDate.split("-").reverse().join("/")}</div></header>
        <div className="content">
          <section className="intro" id="resumo"><div><p className="eyebrow">REPOSIÇÃO E CAPITAL DE GIRO</p><h1>Plano de compras</h1><p className="subtitle">Selecione os quatro arquivos. A análise roda neste navegador e os CSVs não são enviados.</p></div><div className="official-badge"><span>OFICIAL</span><strong>98% serviço</strong><small>z = 2,054</small></div></section>

          <section className="panel upload-panel">
            <div className="panel-heading"><div><p className="eyebrow">ENTRADA LOCAL</p><h2>Carregue os CSVs</h2></div><span className="subtle">4 arquivos · somente no navegador</span></div>
            <div className="upload-grid">{fileRequirements.map(({ key, filename, label }) => <label className="upload-field" key={key}><span className="upload-icon">↑</span><span className="upload-title">{label}</span><small>{files[key]?.name ?? filename}</small><input type="file" accept=".csv,text/csv" onChange={(event) => selectFile(key, event.target.files?.[0] ?? null)} /></label>)}</div>
            <div className="upload-actions"><button className="primary-button" type="button" disabled={!ready || busy} onClick={calculate}>{busy ? "Calculando no navegador…" : "Calcular análise"}</button><span className="subtle">Nenhum CSV é enviado à API.</span></div>
            {error ? <p className="error-message" role="alert">{error}</p> : null}
          </section>

          {!report ? <div className="waiting-card"><span className="waiting-mark">▧</span><strong>O relatório aparecerá aqui</strong><span>Escolha os quatro arquivos CSV e inicie o cálculo.</span></div> : <>
            <section className="metric-grid" aria-label="Resumo do cenário oficial">
              <Metric label="Pedidos financiados" value={number(report.official.orderCount)} note={`${number(report.official.totalUnits)} unidades financiadas`} />
              <Metric label="Capital comprometido" value={money(report.official.totalCost)} note={`${number(report.official.totalUnits)} unidades em ${report.official.orderCount} pedidos`} />
              <Metric label="Taxa de atendimento" value={percent(report.official.fillRate)} note={`${number(report.official.servedUnits)} de ${number(report.official.demandedUnits)} unidades`} />
              <Metric label="SKU-dias sem ruptura" value={percent(report.official.serviceRate)} note={`${number(report.official.serviceDaysWithoutStockout)} / ${number(report.official.eligibleSkuDays)}; sem demanda excluídos`} />
              <Metric label="Custo de manter" value={money(report.official.holdingCost)} note={`Média de estoque ${money(report.official.averageInventoryValue)} × 2,7% × 3`} />
            </section>
            <section className="metric-grid secondary-metrics" aria-label="Capital parado e perdas históricas">
              <Metric label="Capital parado" value={money(report.capitalIdle)} note={`${money(report.monthlyHoldingCost)} por mês a 2,7%`} />
              <Metric label="Venda perdida histórica" value={money(report.official.policies.reduce((sum, policy) => sum + policy.estimatedLostValue, 0))} note={`${number(report.official.policies.reduce((sum, policy) => sum + policy.estimatedLostUnits, 0))} unidades estimadas`} />
              <Metric label="SKUs para revisar" value={number(report.activeNoSales.length)} note="Ativos sem venda na janela base" />
              <Metric label="Itens para liquidação" value={number(report.discontinuedLiquidations.length)} note="Descontinuados com desconto elegível" />
              <Metric label="Nível de serviço" value="98%" note="Cenário oficial · z = 2,054" />
            </section>

            <section className="panel" id="orcamento">
              <div className="panel-heading"><div><p className="eyebrow">CENÁRIO OFICIAL · 98%</p><h2>Curva por orçamento</h2></div><span className="subtle">Limite de capital vs. resultado projetado</span></div>
              <p className="formula-note">Margem não realizada = unidades não atendidas × (preço de venda − custo). Margem recuperada = unidades atendidas × (preço de venda − custo). Ganho líquido = margem recuperada − custo de manter. Marginal = variação do ganho líquido ÷ variação do limite × R$ 100 mil.</p>
              <div className="table-wrap"><table><thead><tr><th>Limite</th><th>Capital comprometido</th><th>Taxa de atendimento</th><th>SKU-dias sem ruptura</th><th>Unidades não atendidas</th><th>Margem não realizada</th><th>Custo de manter</th><th>Ganho líquido</th><th>Marginal / R$ 100 mil</th></tr></thead><tbody>{report.scenarios.map((scenario) => <tr className={scenario.budget === config.budget ? "official-row" : ""} key={scenario.budget}><th>{budgetName(scenario.budget)}{scenario.budget === config.budget ? <span className="tag">Oficial</span> : null}</th><td>{money(scenario.totalCost)}</td><td>{percent(scenario.fillRate)}</td><td>{percent(scenario.serviceRate)}</td><td>{number(scenario.unmetUnits)}</td><td>{money(scenario.unrealizedMargin)}</td><td>{money(scenario.holdingCost)}</td><td>{money(scenario.netGain)}</td><td>{scenario.marginalGainPer100k === null ? "—" : money(scenario.marginalGainPer100k)}</td></tr>)}</tbody></table></div>
              <div className="subsection"><h3>Serviço sem limite de orçamento</h3><div className="table-wrap"><table><thead><tr><th>Alvo</th><th>Compras</th><th>SKUs com compra</th><th>Capital</th><th>Taxa de atendimento</th><th>SKU-dias sem ruptura</th></tr></thead><tbody>{report.unboundedServiceScenarios.map((scenario) => <tr key={scenario.service}><th>{percent(scenario.service)}</th><td>{scenario.orderCount}</td><td>{new Set(scenario.orders.filter((order) => order.units > 0).map((order) => order.sku)).size}</td><td>{money(scenario.totalCost)}</td><td>{percent(scenario.fillRate)}</td><td>{percent(scenario.serviceRate)}</td></tr>)}</tbody></table></div></div>
            </section>

            <section className="panel" id="sanidade">
              <div className="panel-heading"><div><p className="eyebrow">CENÁRIO R$ 1,97 MI</p><h2>10 maiores faltas projetadas</h2></div><span className="subtle">Ordenadas por unidades não atendidas</span></div>
              <div className="table-wrap"><table><thead><tr><th>SKU</th><th>Demanda base / dia</th><th>Posição em 29/09</th><th>Q calculado</th><th>Q financiado</th><th>Unidade de compra</th><th>Unidades não atendidas</th></tr></thead><tbody>{report.topUnmetSkus.map((policy) => <tr key={policy.sku}><th>{policy.sku}</th><td>{number(policy.baseMean)}</td><td>{number(policy.openingPosition)}</td><td>{number(policy.orderQuantity)}</td><td>{number(policy.fundedQuantity)}</td><td>{policy.purchaseUnit}</td><td>{number(policy.projectedUnmetUnits)}</td></tr>)}</tbody></table></div>
              <div className="sanity-strip"><span>Conversão aplicada: <b>1 cx 12 un = 12 un</b></span><span>Divergências de unidade: <b>{report.quality.unitMismatches.length}</b></span><span>SKUs com vendas conhecidos no cadastro: <b>{report.salesWithKnownSku}</b></span><span>Vendas fora do cadastro: <b>{report.quality.outOfCatalog.vendas_diarias}</b></span></div>
              <button className="secondary-button" type="button" disabled={agentBusy} onClick={sendAgentSummary}>{agentBusy ? "Enviando resumo…" : "Enviar resumo dos 30 SKUs mais críticos"}</button>{agentStatus ? <p className="agent-status" role="status">{agentStatus}</p> : null}
            </section>

            <section className="panel" id="qualidade">
              <div className="panel-heading"><div><p className="eyebrow">CONFERÊNCIA DA BASE</p><h2>Relatório de qualidade</h2></div><span className="subtle">Gerado no navegador a partir dos quatro arquivos</span></div>
              <div className="quality-grid">
                <div className="quality-item"><span>Duplicatas de vendas removidas</span><strong>{report.quality.duplicateRows.vendas_diarias}</strong><small>{report.quality.duplicateSalesConflicts} grupos com valores divergentes</small></div>
                <div className="quality-item"><span>Estoque negativo</span><strong>{report.quality.negativeStockRows}</strong><small>tratado como zero; ≤ 0 com venda conta ruptura</small></div>
                <div className="quality-item"><span>SKUs fora do cadastro</span><strong>{Object.values(report.quality.outOfCatalog).reduce((sum, value) => sum + value, 0)}</strong><small>em vendas, estoque e compras</small></div>
                <div className="quality-item"><span>Recebimento antes do pedido</span><strong>{report.quality.receiptBeforeOrder}</strong><small>excluídos da amostra de lead time</small></div>
                <div className="quality-item"><span>Pedidos abertos &gt; 90 dias</span><strong>{report.quality.openOver90Days}</strong><small>fora da posição</small></div>
                <div className="quality-item"><span>Dias preenchidos no estoque</span><strong>{number(report.quality.filledStockDays)}</strong><small>último saldo carregado adiante</small></div>
                <div className="quality-item"><span>Divergências de unidade</span><strong>{report.quality.unitMismatches.length}</strong><small>unidade da compra vs. cadastro</small></div>
                <div className="quality-item"><span>Recebimentos válidos</span><strong>{number(report.quality.validReceipts)}</strong><small>usados na cascata do lead time</small></div>
              </div>
              <div className="quality-bottom"><div><h3>SKUs por fonte de lead time</h3><div className="source-list"><span>Histórico do SKU <b>{report.quality.leadTimeLevels.SKU}</b></span><span>Histórico do fornecedor <b>{report.quality.leadTimeLevels.Fornecedor}</b></span><span>Histórico global <b>{report.quality.leadTimeLevels.Global}</b></span></div></div><div><h3>Unidades em compras.csv</h3><div className="source-list">{Object.entries(report.purchaseUnitCounts).map(([unit, count]) => <span key={unit}>{unit}<b>{count}</b></span>)}</div></div></div>
              {report.quality.unitMismatches.length > 0 ? <details className="detail-list"><summary>Ver divergências ({report.quality.unitMismatches.length})</summary><div className="table-wrap"><table><thead><tr><th>SKU</th><th>Pedido</th><th>Unidade da compra</th><th>Unidade cadastrada</th></tr></thead><tbody>{report.quality.unitMismatches.map((row, index) => <tr key={`${row.poId}-${index}`}><td>{row.sku}</td><td>{row.poId}</td><td>{row.purchaseUnit}</td><td>{row.catalogUnit}</td></tr>)}</tbody></table></div></details> : null}
            </section>

            <section className="panel" id="amostras"><div className="panel-heading"><div><p className="eyebrow">DETALHE DO CÁLCULO</p><h2>SKUs de referência</h2></div><span className="subtle">Cenário oficial de 98%</span></div><SampleTable rows={samples} /></section>
            <footer className="footer">Arquivos processados localmente no navegador; apenas resumos selecionados podem ser enviados à rota de agente.</footer>
          </>}
        </div>
      </section>
    </main>
  );
}
