import { addDays, buildCalendars, dateRange, dayDifference } from "./calendar";
import { buildLeadTimes } from "./lead-time";
import { buildScenario } from "./policy";
import { buildQualityReport, getOpenOrderUnits } from "./quality";
import { toUnits } from "./reader";
import type { Dataset, EndingInventoryMetric, Phase3Config, Phase3Report, ScenarioSummary } from "./types";

export const BUDGET_CURVE = Array.from({ length: 63 }, (_, index) => 1_000_000 + index * 100_000);
export const RECOMMENDED_BUDGET = 5_000_000;

function endingInventoryMetrics(data: Dataset, scenario: ScenarioSummary, calendar: ReturnType<typeof buildCalendars>, leads: ReturnType<typeof buildLeadTimes>, config: Phase3Config): Record<string, EndingInventoryMetric> {
  const skuById = new Map(data.skus.map((sku) => [sku.sku, sku]));
  const receipts = new Map<string, number>();
  const addReceipt = (sku: string, day: string, units: number) => {
    if (day < config.horizonStart || day > config.horizonEnd) return;
    receipts.set(sku, (receipts.get(sku) ?? 0) + units);
  };
  for (const purchase of data.purchases) {
    if (purchase.receiptDate || dayDifference(config.referenceDate, purchase.orderDate) > config.openOrderMaxAgeDays) continue;
    const lead = leads.get(purchase.sku);
    if (!lead || !skuById.has(purchase.sku)) continue;
    const expected = addDays(purchase.orderDate, lead.meanDays);
    addReceipt(purchase.sku, expected < config.horizonStart ? config.horizonStart : expected,
      toUnits(purchase.quantity, purchase.unit, config.caseUnits));
  }
  for (const order of scenario.orders) if (order.units > 0) addReceipt(order.sku, order.arrivalDate, order.units);

  return Object.fromEntries(scenario.policies.map((policy) => {
    const sku = skuById.get(policy.sku)!;
    const startPhysicalStock = Math.max(0, calendar.stockAt(policy.sku, config.referenceDate) - policy.baseMean);
    const endingStock = Math.max(0, startPhysicalStock + (receipts.get(policy.sku) ?? 0) - policy.projectedServedUnits);
    const excess365Units = policy.status === "ativo" && policy.baseMean > 0
      ? Math.max(0, endingStock - policy.baseMean * 365) : 0;
    return [policy.sku, {
      endingStock,
      endingCoverageDays: policy.baseMean > 0 ? endingStock / policy.baseMean : null,
      excess365Units,
      excess365Value: excess365Units * sku.unitCost,
    } satisfies EndingInventoryMetric];
  }));
}

export function aggregatePhase3(data: Dataset, config: Phase3Config): Phase3Report {
  const calendar = buildCalendars(data, config);
  const leads = buildLeadTimes(data, config);
  const quality = buildQualityReport(data, calendar.filledStockDaysBySku, leads, config);
  const open = getOpenOrderUnits(data, config);
  const officialZ = config.serviceScenarios.find((scenario) => scenario.service === config.officialService)!.z;
  const serviceCurve = BUDGET_CURVE.map((budget) => buildScenario(data, calendar, leads, config.officialService, officialZ, config, budget, null, true));
  const zeroBudget = buildScenario(data, calendar, leads, config.officialService, officialZ, config, 0, null, true);
  for (let index = 0; index < serviceCurve.length; index += 1) {
    const current = serviceCurve[index];
    const previous = index === 0 ? zeroBudget : serviceCurve[index - 1];
    const deltaBudget = current.budget - previous.budget;
    current.marginalGainPer100k = Number.isFinite(deltaBudget) && deltaBudget > 0
      ? ((current.netGainIncludingFinal - previous.netGainIncludingFinal) / deltaBudget) * 100_000 : null;
  }
  const official = buildScenario(data, calendar, leads, config.officialService, officialZ, config, config.budget, null, true);
  const recommended = serviceCurve.find((scenario) => scenario.budget === RECOMMENDED_BUDGET)
    ?? buildScenario(data, calendar, leads, config.officialService, officialZ, config, RECOMMENDED_BUDGET, null, true);
  const noBudget = buildScenario(data, calendar, leads, config.officialService, officialZ, config, Number.POSITIVE_INFINITY, null, true);
  const unboundedServiceScenarios: ScenarioSummary[] = config.serviceScenarios.map(({ service, z }) =>
    service === config.officialService ? noBudget : buildScenario(data, calendar, leads, service, z, config, Number.POSITIVE_INFINITY, null, true),
  );
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
  const topUnmetSkus = [...recommended.policies].filter((policy) => policy.projectedUnmetUnits > 0)
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
    recommended,
    endingInventoryByScenario: {
      official: endingInventoryMetrics(data, official, calendar, leads, config),
      recommended: endingInventoryMetrics(data, recommended, calendar, leads, config),
    },
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
