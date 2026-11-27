"use client";

import { useMemo, useState } from "react";
import { RECOMMENDED_BUDGET } from "@/lib/phase3/aggregation";
import { aggregatePhase3 } from "@/lib/phase3/aggregation";
import { parseUploadedData } from "@/lib/phase3/reader";
import type { CsvUploadTexts } from "@/lib/phase3/reader";
import type { Dataset, EndingInventoryMetric, Phase3Config, Phase3Report, Sku, SkuPolicy } from "@/lib/phase3/types";

type FileKey = keyof CsvUploadTexts;
type UploadedFiles = Record<FileKey, File | null>;
type Action = "comprar" | "manter" | "liquidar" | "revisar";
type AgentDecision = { sku: string; action: Action; justification: string; fallback: boolean };
type DecisionSource = "agente" | "fallback" | "determinística";
const allowedActions = new Set<Action>(["comprar", "manter", "liquidar", "revisar"]);

function isAgentDecision(value: unknown): value is AgentDecision {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.sku === "string" && allowedActions.has(row.action as Action) &&
    typeof row.justification === "string" && row.justification.trim().length > 0 && typeof row.fallback === "boolean";
}

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
const actionLabel: Record<Action, string> = { comprar: "Comprar", manter: "Manter", liquidar: "Liquidar", revisar: "Revisar" };

function Metric({ label, value, note }: { label: string; value: string; note: string }) {
  return <article className="metric"><span className="metric-label">{label}</span><strong>{value}</strong><span className="metric-note">{note}</span></article>;
}

function deterministicDecision(policy: SkuPolicy, ending: EndingInventoryMetric, sku: Sku): Omit<AgentDecision, "fallback"> {
  if (policy.status === "descontinuado") {
    const eligible = policy.liquidationPrice !== null && policy.liquidationPrice >= sku.unitCost;
    return eligible && policy.openingStock > 0
      ? { sku: policy.sku, action: "liquidar", justification: `Descontinuado com estoque; preço líquido ${money(policy.liquidationPrice!)} é maior ou igual ao custo ${money(sku.unitCost)}.` }
      : { sku: policy.sku, action: "manter", justification: "Descontinuado sem estoque liquidável a preço igual ou superior ao custo." };
  }
  if (ending.endingCoverageDays !== null && ending.endingCoverageDays > 365) {
    return { sku: policy.sku, action: "revisar", justification: `[R1] cobertura final > 365 dias: ${number(ending.endingCoverageDays)} dias.` };
  }
  if (policy.review) return { sku: policy.sku, action: "revisar", justification: "[R2] sem venda na janela base: revisar cadastro e demanda." };
  if (policy.fundedQuantity > 0) return { sku: policy.sku, action: "comprar", justification: `Comprar ${number(policy.fundedQuantity)} unidades; quantidade financiada pela regra de reposição.` };
  if (policy.orderQuantity > 0) return { sku: policy.sku, action: "revisar", justification: `[R3] pedido calculado sem unidades financiadas: Q = ${number(policy.orderQuantity)} unidades.` };
  if (policy.projectedUnmetUnits > 0) return { sku: policy.sku, action: "revisar", justification: `[R4] demanda não atendida sem pedido financiado: ${number(policy.projectedUnmetUnits)} unidades.` };
  return { sku: policy.sku, action: "manter", justification: "Posição projetada suficiente; nenhum pedido foi emitido." };
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
    ["Data do pedido", (p) => p.firstOrderDate ?? "Sem pedido"],
    ["Cobertura", (p) => `${number(p.coverage)} dias`],
  ];
  return <div className="table-wrap"><table><thead><tr><th>Métrica</th>{rows.map((r) => <th key={r.label}>{r.label}{r.policy ? <small>{r.policy.sku}</small> : null}</th>)}</tr></thead><tbody>{fields.map(([label, value]) => <tr key={label}><th scope="row">{label}</th>{rows.map((row) => <td key={row.label}>{row.policy ? value(row.policy) : "—"}</td>)}</tr>)}</tbody></table></div>;
}

export default function ClientDashboard({ config }: { config: Phase3Config }) {
  const [files, setFiles] = useState<UploadedFiles>({ skus: null, sales: null, stock: null, purchases: null });
  const [report, setReport] = useState<Phase3Report | null>(null);
  const [catalog, setCatalog] = useState<Sku[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [agentStatus, setAgentStatus] = useState("");
  const [agentBusy, setAgentBusy] = useState(false);
  const [agentDecisions, setAgentDecisions] = useState<Record<string, AgentDecision>>({});
  const [agentPreview, setAgentPreview] = useState<AgentDecision[]>([]);
  const [agentReceivedCount, setAgentReceivedCount] = useState(0);
  const [agentPanelVisible, setAgentPanelVisible] = useState(false);
  const missingFiles = fileRequirements.filter(({ key }) => !files[key]);
  const ready = missingFiles.length === 0;
  const catalogBySku = useMemo(() => new Map(catalog.map((sku) => [sku.sku, sku])), [catalog]);
  const samples = useMemo(() => report ? [
    { label: "Com vendas", policy: report.sampleWithSales },
    { label: "Com ruptura", policy: report.sampleInRupture },
  ] : [], [report]);
  const activeExcessOfficial = report ? Object.values(report.endingInventoryByScenario.official)
    .reduce((sum, row) => sum + row.excess365Value, 0) : 0;
  const officialEnding: Array<[string, EndingInventoryMetric]> = report ? Object.entries(report.endingInventoryByScenario.official) : [];
  const topCoverage = officialEnding.reduce(
    (best, [sku, row]) => (row.endingCoverageDays ?? 0) > best.days ? { sku, days: row.endingCoverageDays ?? 0 } : best,
    { sku: "", days: 0 },
  );

  const selectFile = (key: FileKey, file: File | null) => {
    setFiles((current) => ({ ...current, [key]: file }));
    setReport(null); setCatalog([]); setError(""); setAgentStatus(""); setAgentDecisions({}); setAgentPreview([]); setAgentReceivedCount(0); setAgentPanelVisible(false);
  };

  async function calculate() {
    if (!ready) return;
    setBusy(true); setError(""); setReport(null); setAgentDecisions({}); setAgentPreview([]);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    try {
      const sources = {} as CsvUploadTexts;
      for (const { key } of fileRequirements) sources[key] = await files[key]!.text();
      const data: Dataset = parseUploadedData(sources);
      setCatalog(data.skus);
      setReport(aggregatePhase3(data, config));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Não foi possível processar os arquivos selecionados.");
    } finally { setBusy(false); }
  }

  async function sendAgentSummary() {
    if (!report) return;
    const endMetrics = report.endingInventoryByScenario.recommended;
    const selected = [...report.recommended.policies].filter((policy) => policy.baseMean > 0)
      .sort((a, b) => b.projectedUnmetUnits - a.projectedUnmetUnits || a.sku.localeCompare(b.sku)).slice(0, 30);
    if (selected.length !== 30) { setAgentStatus("A base precisa ter pelo menos 30 SKUs com demanda para enviar o resumo."); return; }
    const summary = selected.map((policy) => {
      const sku = catalogBySku.get(policy.sku)!;
      const ending = endMetrics[policy.sku];
      const decision = deterministicDecision(policy, ending, sku);
      return {
        sku: policy.sku, status: policy.status, demandMean: policy.baseMean, position: policy.openingPosition,
        reorderPoint: policy.reorderPoint, targetLevel: policy.targetLevel, suggestedUnits: policy.orderQuantity,
        fundedUnits: policy.fundedQuantity, coverageDays: policy.coverage, unmetUnits: policy.projectedUnmetUnits,
        endingStock: ending.endingStock, endingCoverageDays: ending.endingCoverageDays, excess365Value: ending.excess365Value,
        unitCost: sku.unitCost, liquidationAllowed: policy.liquidationPrice !== null && policy.liquidationPrice >= sku.unitCost,
        liquidationPrice: policy.liquidationPrice, deterministicAction: decision.action, deterministicReason: decision.justification,
      };
    });
    setAgentBusy(true); setAgentStatus(""); setAgentDecisions({}); setAgentPreview([]); setAgentReceivedCount(0); setAgentPanelVisible(true);
    const collected: AgentDecision[] = [];
    try {
      for (let start = 0; start < summary.length; start += 10) {
        const batch = summary.slice(start, start + 10);
        setAgentDecisions((current) => ({
          ...current,
          ...Object.fromEntries(batch.map((row) => [row.sku, {
            sku: row.sku, action: row.deterministicAction, justification: row.deterministicReason, fallback: true,
          } satisfies AgentDecision])),
        }));
        const response = await fetch("/api/agent", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ selectedSkus: batch }),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error ?? "Falha ao enviar resumo.");
        const expectedSkus = new Set(batch.map((row) => row.sku));
        const receivedSkus = new Set<string>();
        const decisions: AgentDecision[] = [];
        const rawDecisions: unknown = result.decisions;
        if (Array.isArray(rawDecisions)) {
          for (const value of rawDecisions as unknown[]) {
            if (!isAgentDecision(value) || !expectedSkus.has(value.sku) || receivedSkus.has(value.sku)) continue;
            receivedSkus.add(value.sku);
            decisions.push(value);
          }
        }
        collected.push(...decisions);
        setAgentDecisions((current) => ({ ...current, ...Object.fromEntries(decisions.map((decision) => [decision.sku, decision])) }));
        setAgentReceivedCount(collected.filter((decision) => !decision.fallback).length);
      }
      setAgentPreview(collected);
      const agentCount = collected.filter((decision) => !decision.fallback).length;
      setAgentStatus(`Respostas do agente: ${agentCount} de ${summary.length}. Fallback determinístico: ${collected.length - agentCount}.`);
    } catch (reason) {
      setAgentStatus(reason instanceof Error ? reason.message : "Falha ao enviar os resumos.");
    } finally { setAgentBusy(false); }
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="/" aria-label="EstoqueGoGroup, início"><span className="brand-mark">E</span><span>Estoque<span className="brand-light">Go</span></span></a>
        <p className="nav-caption">PLANEJAMENTO</p>
        <nav aria-label="Navegação principal">
          <a className="nav-link active" href="#resumo"><span>▦</span> Resumo</a>
          <a className="nav-link" href="#orcamento"><span>◷</span> Curva</a>
          <a className="nav-link" href="#skus"><span>≡</span> SKUs</a>
          <a className="nav-link" href="#qualidade"><span>✓</span> Qualidade</a>
        </nav>
        <div className="sidebar-bottom"><span className="status-dot" /> Cálculo local no navegador</div>
      </aside>

      <section className="main-area">
        <header className="topbar"><div className="crumb">Estoque <span>/</span> Planejamento</div><div className="date-chip"><span className="chip-dot" /> Referência · {config.referenceDate.split("-").reverse().join("/")}</div></header>
        <div className="content">
          <section className="intro" id="resumo"><div><p className="eyebrow">REPOSIÇÃO E CAPITAL DE GIRO</p><h1>Plano de compras</h1><p className="subtitle">Selecione os quatro arquivos. A análise roda neste navegador e os CSVs não são enviados.</p></div><div className="official-badge"><span>CENÁRIO OFICIAL</span><strong>R$ 1,97 mi · 98%</strong><small>z = 2,054 · referência fixa</small></div></section>

          <section className="panel upload-panel">
            <div className="panel-heading"><div><p className="eyebrow">ENTRADA LOCAL</p><h2>Carregue os CSVs</h2></div><span className="subtle">4 arquivos · somente no navegador</span></div>
            <div className="upload-grid">{fileRequirements.map(({ key, filename, label }) => <label className={`upload-field ${files[key] ? "upload-selected" : ""}`} key={key}><span className="upload-icon">↑</span><span className="upload-title">{label}</span><small>{files[key]?.name ?? filename}</small><input aria-label={`Selecionar ${filename}`} type="file" accept=".csv,text/csv" onChange={(event) => selectFile(key, event.target.files?.[0] ?? null)} /></label>)}</div>
            <div className="upload-actions"><button className="primary-button" type="button" disabled={!ready || busy} onClick={calculate}>{busy ? "Calculando no navegador…" : "Calcular análise"}</button><span className="subtle">Nenhum CSV é enviado à API.</span></div>
            {!ready ? <p className="upload-hint">{missingFiles.length === fileRequirements.length ? "Envie os quatro arquivos para começar." : "Falta selecionar: "}{missingFiles.map((file) => file.filename).join(", ")}</p> : null}
            {error ? <p className="error-message" role="alert">{error}</p> : null}
          </section>

          {!report ? <div className="waiting-card"><span className="waiting-mark">▧</span><strong>O relatório aparecerá aqui</strong><span>Selecione skus.csv, vendas_diarias.csv, estoque_diario.csv e compras.csv; depois inicie o cálculo.</span></div> : <>
            <section className="warning-grid" aria-label="Avisos do plano">
              <article><b>Projeção do plano</b><span>98% é resultado do plano, não uma garantia de serviço.</span></article>
              <article><b>Recomendação depende dos parâmetros</b><span>R$ 5,0 mi usa T = 30 e SS = 98%. Com T = 0, o primeiro teto acima de 98% é R$ 5,25 mi.</span></article>
              <article><b>Excesso em ativos · {money(activeExcessOfficial)}</b><span>Valor no cenário oficial acima de 365 dias de cobertura.</span></article>
              <article><b>Maior cobertura final · {topCoverage.sku || "—"} · {number(topCoverage.days)} dias</b><span>SKU com maior cobertura no cenário oficial; revisar cadastro e unidade de demanda.</span></article>
            </section>

            <section className="scenario-grid" aria-label="Cenário oficial e recomendado">
              {[{ label: "Oficial", scenario: report.official, end: report.endingInventoryByScenario.official }, { label: "Recomendado · cenário A", scenario: report.recommended, end: report.endingInventoryByScenario.recommended }].map(({ label, scenario, end }) => {
                const excess = Object.values(end).reduce((sum, row) => sum + row.excess365Value, 0);
                return <article className="scenario-card" key={label}><div className="scenario-card-heading"><div><p className="eyebrow">{label}</p><h2>{budgetName(scenario.budget)}</h2></div><span className="scenario-chip">98% · T=30</span></div><div className="scenario-stats"><div><span>Atendimento</span><b>{percent(scenario.fillRate)}</b><small>{number(scenario.servedUnits)} unidades</small></div><div><span>SKU-dias sem ruptura</span><b>{percent(scenario.serviceRate)}</b><small>Sem SKUs sem demanda</small></div><div><span>Estoque final · 29/12</span><b>{money(scenario.endingInventoryValue)}</b><small>{number(scenario.endingInventoryUnits)} unidades</small></div><div><span>Ganho líquido</span><b>{money(scenario.netGainIncludingFinal)}</b><small>Inclui custo do estoque final</small></div><div><span>Capital comprometido</span><b>{money(scenario.totalCost)}</b><small>{number(scenario.totalUnits)} unidades compradas</small></div><div><span>Excesso ativo &gt;365 dias</span><b>{money(excess)}</b><small>Valorizado a custo</small></div></div></article>;
              })}
            </section>
            <section className="metric-grid secondary-metrics" aria-label="Outros indicadores">
              <Metric label="Capital parado" value={money(report.capitalIdle)} note="Estoque a custo em SKUs sem venda na janela base" />
              <Metric label="Custo mensal do capital parado" value={money(report.monthlyHoldingCost)} note="2,7% ao mês sobre capital parado" />
              <Metric label="Venda perdida histórica" value={money(report.official.policies.reduce((sum, policy) => sum + policy.estimatedLostValue, 0))} note={`${number(report.official.policies.reduce((sum, policy) => sum + policy.estimatedLostUnits, 0))} unidades estimadas`} />
              <Metric label="SKUs para revisar" value={number(report.activeNoSales.length)} note="Ativos sem venda na janela base" />
            </section>

            <section className="panel" id="orcamento">
              <div className="panel-heading"><div><p className="eyebrow">CENÁRIO A · CHEGADA ATÉ 29/12</p><h2>Curva por orçamento</h2></div><span className="subtle">Política atual · SS=98% · T=30</span></div>
              <p className="formula-note">Ganho líquido = margem recuperada − custo de manter estoque médio − custo de manter o estoque final por mais três meses. A taxa de atendimento usa unidades atendidas ÷ unidades demandadas; SKU-dias exclui SKUs sem demanda.</p>
              <div className="table-wrap"><table><thead><tr><th>Teto</th><th>Capital comprometido</th><th>Unidades atendidas</th><th>Atendimento</th><th>SKU-dias sem ruptura</th><th>Estoque final · 29/12</th><th>Ganho líquido</th><th>Marginal / R$ 100 mil</th></tr></thead><tbody>{report.scenarios.map((scenario) => <tr className={scenario.budget === RECOMMENDED_BUDGET ? "recommended-row" : ""} key={scenario.budget}><th>{budgetName(scenario.budget)}{scenario.budget === RECOMMENDED_BUDGET ? <span className="tag">Recomendado</span> : null}</th><td>{money(scenario.totalCost)}</td><td>{number(scenario.servedUnits)}</td><td>{percent(scenario.fillRate)}</td><td>{percent(scenario.serviceRate)}</td><td>{money(scenario.endingInventoryValue)}</td><td>{money(scenario.netGainIncludingFinal)}</td><td>{scenario.marginalGainPer100k === null ? "—" : money(scenario.marginalGainPer100k)}</td></tr>)}</tbody></table></div>
            </section>

            <section className="panel" id="skus">
              <div className="panel-heading"><div><p className="eyebrow">DETALHE POR SKU</p><h2>Plano e decisão</h2></div><span className="subtle">Cenário recomendado · {report.recommended.policies.length} SKUs</span></div>
              <p className="formula-note">A tela envia até 30 SKUs em três requisições de 10 para /api/agent. Q permanece calculado pela regra de reposição.</p>
              <div className="table-wrap sku-table-wrap"><table><thead><tr><th>SKU</th><th>Status</th><th>Demanda base/dia</th><th>σd</th><th>L̄ / σL</th><th>Fonte lead time</th><th>Posição</th><th>ROP</th><th>S</th><th>Q calculado / financiado</th><th>Data do pedido</th><th>Cobertura na decisão</th><th>Estoque final</th><th>Cobertura final</th><th>Excesso a custo</th><th>Não atendidas</th><th>Decisão</th><th>Justificativa</th></tr></thead><tbody>{[...report.recommended.policies].sort((a, b) => a.sku.localeCompare(b.sku)).map((policy) => {
                const sku = catalogBySku.get(policy.sku)!;
                const ending = report.endingInventoryByScenario.recommended[policy.sku];
                const localDecision = deterministicDecision(policy, ending, sku);
                const receivedDecision = agentDecisions[policy.sku];
                const decision = receivedDecision ?? localDecision;
                const decisionSource: DecisionSource = receivedDecision ? (receivedDecision.fallback ? "fallback" : "agente") : "determinística";
                return <tr key={policy.sku}><th>{policy.sku}</th><td>{policy.status}</td><td>{number(policy.baseMean)}</td><td>{number(policy.baseSigma)}</td><td>{policy.leadTime.meanDays} / {number(policy.leadTime.sigmaDays)} d</td><td>{policy.leadTime.source} · {policy.leadTime.sourceKey}</td><td>{number(policy.decisionPosition)}</td><td>{number(policy.reorderPoint)}</td><td>{number(policy.targetLevel)}</td><td>{number(policy.orderQuantity)} / {number(policy.fundedQuantity)}</td><td>{policy.firstOrderDate ?? "—"}</td><td>{number(policy.coverage)} d</td><td>{number(ending.endingStock)} un.</td><td>{ending.endingCoverageDays === null ? "Sem demanda" : `${number(ending.endingCoverageDays)} d`}</td><td>{money(ending.excess365Value)}</td><td>{number(policy.projectedUnmetUnits)}</td><td><span className={`decision-pill decision-${decision.action}`}>{actionLabel[decision.action]}</span><small className="decision-source">{decisionSource}</small></td><td className="justification-cell">{decision.justification}</td></tr>;
              })}</tbody></table></div>
              <button className="secondary-button" type="button" disabled={agentBusy} onClick={sendAgentSummary}>{agentBusy ? "Analisando lotes de 10…" : "Analisar os 30 SKUs críticos"}</button>{agentStatus ? <p className="agent-status" role="status">{agentStatus}</p> : null}
              {agentPanelVisible ? <div className="agent-preview"><h3>Resposta do agente · {agentReceivedCount} SKUs</h3>{agentPreview.length ? <div className="agent-preview-grid">{agentPreview.map((decision) => <article key={decision.sku}><b>{decision.sku} · {actionLabel[decision.action]}</b><span className="decision-source">{decision.fallback ? "fallback" : "agente"}</span><span>{decision.justification}</span></article>)}</div> : <p className="agent-status">Nenhuma resposta válida recebida.</p>}</div> : null}
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

            <section className="panel"><div className="panel-heading"><div><p className="eyebrow">DETALHE DO CÁLCULO</p><h2>SKUs de referência</h2></div><span className="subtle">Cenário oficial de 98%</span></div><SampleTable rows={samples} /></section>
            <footer className="footer">Arquivos processados localmente no navegador. A API recebe apenas resumos dos 30 SKUs selecionados, em lotes de 10.</footer>
          </>}
        </div>
      </section>
    </main>
  );
}
