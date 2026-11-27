import { buildCalendars } from "./calendar";
import { buildLeadTimes } from "./lead-time";
import { buildScenario } from "./policy";
import { buildQualityReport, getOpenOrderUnits } from "./quality";
import type { Dataset, Phase3Config, Phase3Report, ScenarioSummary } from "./types";

export const BUDGET_CURVE = [...Array.from({ length: 63 }, (_, index) => 1_000_000 + index * 100_000), 1_970_000, Number.POSITIVE_INFINITY].sort((a, b) => a - b);

const budgetLabel = (value: number) => Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;

export function aggregatePhase3(data: Dataset, config: Phase3Config): Phase3Report {
  const calendar = buildCalendars(data, config);
  const leads = buildLeadTimes(data, config);
  const quality = buildQualityReport(data, calendar.filledStockDaysBySku, leads, config);
  const open = getOpenOrderUnits(data, config);
  const officialZ = config.serviceScenarios.find((scenario) => scenario.service === config.officialService)!.z;
  const serviceCurve = BUDGET_CURVE.map((budget) => buildScenario(data, calendar, leads, config.officialService, officialZ, config, budget));
  const noBudget = serviceCurve[serviceCurve.length - 1];
  const zeroBudget = buildScenario(data, calendar, leads, config.officialService, officialZ, config, 0);
  for (let index = 0; index < serviceCurve.length; index += 1) {
    const current = serviceCurve[index];
    const comparisonBudget = current.budget === 1_970_000 ? 1_900_000
      : current.budget === Number.POSITIVE_INFINITY ? Number.POSITIVE_INFINITY
        : current.budget === 1_000_000 ? 0 : current.budget - 100_000;
    const previous = comparisonBudget === 0 ? zeroBudget
      : serviceCurve.find((scenario) => scenario.budget === comparisonBudget) ?? serviceCurve[index - 1];
    const deltaBudget = current.budget - previous.budget;
    current.marginalGainPer100k = Number.isFinite(deltaBudget) && deltaBudget > 0
      ? ((current.netGainIncludingFinal - previous.netGainIncludingFinal) / deltaBudget) * 100_000 : null;
  }
  const unboundedServiceScenarios: ScenarioSummary[] = config.serviceScenarios.map(({ service, z }) =>
    service === config.officialService ? noBudget : buildScenario(data, calendar, leads, service, z, config, Number.POSITIVE_INFINITY),
  );
  const official = serviceCurve.find((scenario) => scenario.budget === config.budget)!;
  const policies = official.policies;
  const capitalIdle = policies.reduce((sum, policy) => sum + policy.capitalIdle, 0);
  const sampleWithSales = policies.filter((policy) => policy.baseMean > 0 && policy.stockoutDays === 0).sort((a, b) => a.sku.localeCompare(b.sku))[0]
    ?? policies.filter((policy) => policy.baseMean > 0).sort((a, b) => a.sku.localeCompare(b.sku))[0] ?? null;
  const sampleInRupture = policies.filter((policy) => policy.sku !== sampleWithSales?.sku && policy.stockoutDays > 0)
    .sort((a, b) => b.stockoutDays - a.stockoutDays || a.sku.localeCompare(b.sku))[0]
    ?? policies.filter((policy) => policy.sku !== sampleWithSales?.sku && policy.projectedService < 1 && policy.baseMean > 0)
      .sort((a, b) => a.projectedService - b.projectedService || a.sku.localeCompare(b.sku))[0] ?? null;
  const catalogSkus = new Set(data.skus.map((sku) => sku.sku));
  const skuWithDemand = new Set(data.sales.filter((sale) => catalogSkus.has(sale.sku)).map((sale) => sale.sku)).size;
  const topUnmetSkus = [...policies].filter((policy) => policy.projectedUnmetUnits > 0)
    .sort((a, b) => b.projectedUnmetUnits - a.projectedUnmetUnits || a.sku.localeCompare(b.sku)).slice(0, 10);
  const purchaseUnitCounts: Record<string, number> = {};
  for (const purchase of data.purchases) purchaseUnitCounts[purchase.unit] = (purchaseUnitCounts[purchase.unit] ?? 0) + 1;
  return {
    referenceDate: config.referenceDate,
    quality,
    leadTimeLevelCounts: quality.leadTimeLevels,
    scenarios: serviceCurve,
    unboundedServiceScenarios,
    official,
    capitalIdle,
    monthlyHoldingCost: capitalIdle * config.monthlyHoldingRate,
    discontinuedLiquidations: policies.filter((policy) => policy.status === "descontinuado" && policy.liquidationDiscount !== null),
    activeNoSales: policies.filter((policy) => policy.review),
    sampleWithSales,
    sampleInRupture,
    skuCount: data.skus.length,
    topUnmetSkus,
    salesWithKnownSku: skuWithDemand,
    purchaseUnitCounts,
  };
}
