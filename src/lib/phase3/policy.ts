import { addDays, dateRange, dayDifference } from "./calendar";
import { getOpenOrderUnits } from "./quality";
import { toUnits } from "./reader";
import type { CalendarResult } from "./calendar";
import type { Dataset, DemandStats, LeadTimeStats, Phase3Config, ScenarioSummary, SimulatedOrder, SkuPolicy } from "./types";

interface CandidateOrder extends SimulatedOrder { demandStats: DemandStats; priorityScore: number }
interface SimulationSkuTotals { safeDays: number; stockoutDays: number; demandedUnits: number; servedUnits: number; unmetUnits: number }
interface SimulationTotals {
  bySku: Map<string, SimulationSkuTotals>;
  safeSkuDays: number;
  eligibleSkuDays: number;
  demandedUnits: number;
  servedUnits: number;
  unmetUnits: number;
  averageInventoryValue: number;
  endingInventoryUnits: number;
  endingInventoryValue: number;
  positionIdentityViolations: number;
  physicalBalanceViolations: number;
}

function factorAt(stats: DemandStats, date: string, config: Phase3Config): number {
  if (date >= config.campaigns[0].start && date <= config.campaigns[0].end) return stats.seasonality.blackFriday;
  if (date >= config.campaigns[1].start && date <= config.campaigns[1].end) return stats.seasonality.christmas;
  return 1;
}

function demandOn(stats: DemandStats, date: string, config: Phase3Config): number {
  return stats.baseMean * factorAt(stats, date, config);
}

function futureDemand(stats: DemandStats, date: string, days: number, config: Phase3Config): number {
  let total = 0;
  for (let offset = 0; offset < days; offset += 1) total += demandOn(stats, addDays(date, offset), config);
  return total;
}

function avgFutureDemand(stats: DemandStats, date: string, days: number, config: Phase3Config): number {
  return futureDemand(stats, date, days, config) / days;
}

function safetyStock(stats: DemandStats, lead: LeadTimeStats, z: number): number {
  return z * Math.sqrt(lead.meanDays * stats.baseSigma ** 2 + stats.baseMean ** 2 * lead.sigmaDays ** 2);
}

function roundToMoq(quantity: number, moqUnits: number): number {
  return quantity <= 0 || moqUnits <= 0 ? 0 : Math.ceil(quantity / moqUnits) * moqUnits;
}

function createCandidates(
  data: Dataset,
  calendar: CalendarResult,
  leads: Map<string, LeadTimeStats>,
  openBySku: Map<string, number>,
  z: number,
  config: Phase3Config,
): CandidateOrder[] {
  const candidates: CandidateOrder[] = [];
  for (const sku of data.skus) {
    const stats = calendar.stats.get(sku.sku)!;
    const lead = leads.get(sku.sku)!;
    if (sku.status !== "ativo" || stats.baseUnits === 0 || stats.baseMean <= 0) continue;
    const moqUnits = toUnits(sku.moq, sku.purchaseUnit, config.caseUnits);
    let position = calendar.stockAt(sku.sku, config.referenceDate) + (openBySku.get(sku.sku) ?? 0) - stats.baseMean;
    const ss = safetyStock(stats, lead, z);
    for (const date of dateRange(config.horizonStart, config.horizonEnd)) {
      const rop = futureDemand(stats, date, lead.meanDays, config) + ss;
      if (position <= rop) {
        const target = futureDemand(stats, date, lead.meanDays + config.targetDays, config) + ss;
        const quantity = roundToMoq(Math.max(0, target - position), moqUnits);
        if (quantity > 0) {
          candidates.push({
            sku: sku.sku, date, arrivalDate: addDays(date, lead.meanDays), units: quantity, moqUnits,
            coverage: position / avgFutureDemand(stats, date, config.targetDays, config),
            cost: quantity * sku.unitCost, status: "financiado", demandStats: stats,
            priorityScore: (((stats.realizedPrice ?? sku.retailPrice) - sku.unitCost) * stats.baseMean) / sku.unitCost,
          });
          position += quantity;
        }
      }
      position -= demandOn(stats, date, config);
    }
  }
  return candidates;
}

function allocateBudget(candidates: CandidateOrder[], data: Dataset, budget: number) {
  let remainingCents = Number.isFinite(budget) ? Math.round(budget * 100) : Number.POSITIVE_INFINITY;
  const skuMap = new Map(data.skus.map((sku) => [sku.sku, sku]));
  const bySku = new Map<string, CandidateOrder[]>();
  for (const candidate of candidates) bySku.set(candidate.sku, [...(bySku.get(candidate.sku) ?? []), candidate]);
  for (const rows of bySku.values()) rows.sort((a, b) => a.date.localeCompare(b.date));
  const nextBySku = new Map([...bySku.keys()].map((sku) => [sku, 0]));
  const blockedSkus = new Set<string>();
  const results: SimulatedOrder[] = [];
  while (true) {
    const priorityRound = [...nextBySku.entries()].flatMap(([sku, index]) => {
      if (blockedSkus.has(sku)) return [];
      const candidate = bySku.get(sku)?.[index];
      return candidate ? [candidate] : [];
    }).sort((a, b) => b.priorityScore - a.priorityScore || a.coverage - b.coverage || a.date.localeCompare(b.date) || a.sku.localeCompare(b.sku));
    if (!priorityRound.length) break;
    for (const candidate of priorityRound) {
      const { demandStats: _stats, ...order } = candidate;
      const sku = skuMap.get(candidate.sku)!;
      const unitCostCents = Math.round(sku.unitCost * 100);
      const maxAffordableUnits = Number.isFinite(remainingCents) && unitCostCents > 0
        ? Math.floor(remainingCents / unitCostCents) : candidate.units;
      const affordableSteps = Math.floor(maxAffordableUnits / candidate.moqUnits);
      const allocatedUnits = Math.min(candidate.units, affordableSteps * candidate.moqUnits);
      if (allocatedUnits <= 0) {
        results.push({ ...order, units: 0, cost: 0, status: "não financiado" });
        blockedSkus.add(candidate.sku);
        continue;
      }
      const costCents = allocatedUnits * unitCostCents;
      const cost = costCents / 100;
      if (Number.isFinite(remainingCents)) remainingCents -= costCents;
      results.push({ ...order, units: allocatedUnits, cost, status: allocatedUnits < candidate.units ? "parcial" : "financiado" });
      if (allocatedUnits < candidate.units) blockedSkus.add(candidate.sku);
      else nextBySku.set(candidate.sku, (nextBySku.get(candidate.sku) ?? 0) + 1);
    }
  }
  return results.sort((a, b) => a.date.localeCompare(b.date) || a.sku.localeCompare(b.sku));
}

function runServiceSimulation(
  data: Dataset,
  calendar: CalendarResult,
  leads: Map<string, LeadTimeStats>,
  simulatedOrders: SimulatedOrder[],
  config: Phase3Config,
): SimulationTotals {
  const openOrders = data.purchases.filter((row) => !row.receiptDate && dayDifference(config.referenceDate, row.orderDate) <= config.openOrderMaxAgeDays);
  const skuMap = new Map(data.skus.map((sku) => [sku.sku, sku]));
  const horizon = dateRange(config.horizonStart, config.horizonEnd);
  const arrivals = new Map<string, Map<string, number>>();
  const addArrival = (sku: string, date: string, units: number) => {
    const byDay = arrivals.get(sku) ?? new Map<string, number>();
    byDay.set(date, (byDay.get(date) ?? 0) + units);
    arrivals.set(sku, byDay);
  };
  for (const order of openOrders) {
    const lead = leads.get(order.sku);
    if (!lead || !skuMap.has(order.sku)) continue;
    const units = toUnits(order.quantity, order.unit, config.caseUnits);
    const expected = addDays(order.orderDate, lead.meanDays);
    addArrival(order.sku, expected < config.horizonStart ? config.horizonStart : expected, units);
  }
  for (const order of simulatedOrders) if (order.units > 0) addArrival(order.sku, order.arrivalDate, order.units);

  const bySku = new Map<string, SimulationSkuTotals>();
  let safeSkuDays = 0, eligibleSkuDays = 0, demandedUnits = 0, servedUnits = 0, unmetUnits = 0;
  let inventoryValueSum = 0;
  let endingInventoryUnits = 0, endingInventoryValue = 0, positionIdentityViolations = 0, physicalBalanceViolations = 0;
  const demandBySku = new Map(data.skus.map((sku) => [sku.sku, calendar.stats.get(sku.sku)!.baseMean]));
  const ordersBySkuDay = new Map<string, number>();
  for (const order of simulatedOrders) if (order.units > 0) ordersBySkuDay.set(`${order.sku}|${order.date}`, (ordersBySkuDay.get(`${order.sku}|${order.date}`) ?? 0) + order.units);
  const skuCountWithDemand = data.skus.filter((sku) => calendar.stats.get(sku.sku)!.baseMean > 0).length;
  for (const sku of data.skus) {
    let onHand = Math.max(0, calendar.stockAt(sku.sku, config.referenceDate) - (demandBySku.get(sku.sku) ?? 0));
    const openingPhysicalStock = onHand;
    let totalReceipts = 0;
    const openingPosition = calendar.stockAt(sku.sku, config.referenceDate) + (openOrders.filter((row) => row.sku === sku.sku).reduce((sum, row) => sum + toUnits(row.quantity, row.unit, config.caseUnits), 0)) - (demandBySku.get(sku.sku) ?? 0);
    let position = openingPosition;
    let cumulativeDemand = 0, cumulativeIssued = 0;
    let skuSafeDays = 0, skuRuptureDays = 0, skuDemanded = 0, skuServed = 0, skuUnmet = 0;
    const stats = calendar.stats.get(sku.sku)!;
    for (const day of horizon) {
      const receivedToday = arrivals.get(sku.sku)?.get(day) ?? 0;
      totalReceipts += receivedToday;
      onHand += receivedToday;
      const demand = stats.projectedDemand.get(day) ?? 0;
      const issued = ordersBySkuDay.get(`${sku.sku}|${day}`) ?? 0;
      const independentlyRebuiltPosition = openingPosition - cumulativeDemand + cumulativeIssued;
      if (Math.abs(position - independentlyRebuiltPosition) > 1e-8) positionIdentityViolations += 1;
      const available = Math.max(0, onHand);
      if (stats.baseMean > 0) {
        eligibleSkuDays += 1;
        skuDemanded += demand;
        demandedUnits += demand;
        const served = Math.min(demand, available);
        const unmet = Math.max(0, demand - available);
        skuServed += served;
        servedUnits += served;
        skuUnmet += unmet;
        unmetUnits += unmet;
        if (demand > 0 && available < demand) skuRuptureDays += 1;
        else skuSafeDays += 1;
        safeSkuDays += demand > 0 && available < demand ? 0 : 1;
      }
      onHand = Math.max(0, onHand - demand);
      position = position - demand + issued;
      cumulativeDemand += demand;
      cumulativeIssued += issued;
      inventoryValueSum += onHand * sku.unitCost;
    }
    if (Math.abs(position - (openingPosition - cumulativeDemand + cumulativeIssued)) > 1e-8) positionIdentityViolations += 1;
    endingInventoryUnits += onHand;
    endingInventoryValue += onHand * sku.unitCost;
    if (Math.abs(openingPhysicalStock + totalReceipts - skuServed - onHand) > 1e-6) physicalBalanceViolations += 1;
    bySku.set(sku.sku, { safeDays: skuSafeDays, stockoutDays: skuRuptureDays, demandedUnits: skuDemanded, servedUnits: skuServed, unmetUnits: skuUnmet });
  }
  return {
    bySku, safeSkuDays, eligibleSkuDays, demandedUnits, servedUnits, unmetUnits,
    averageInventoryValue: inventoryValueSum / horizon.length,
    endingInventoryUnits, endingInventoryValue, positionIdentityViolations, physicalBalanceViolations,
  };
}

export function buildScenario(
  data: Dataset,
  calendar: CalendarResult,
  leads: Map<string, LeadTimeStats>,
  service: number,
  z: number,
  config: Phase3Config,
  budget: number,
  marginalGainPer100k: number | null = null,
  arrivalWithinHorizonOnly = false,
): ScenarioSummary {
  const open = getOpenOrderUnits(data, config);
  const allCandidates = createCandidates(data, calendar, leads, open.bySku, z, config);
  const candidates = arrivalWithinHorizonOnly
    ? allCandidates.filter((candidate) => candidate.arrivalDate <= config.horizonEnd)
    : allCandidates;
  const orders = allocateBudget(candidates, data, budget);
  const simulation = runServiceSimulation(data, calendar, leads, orders, config);
  const orderGroups = new Map<string, SimulatedOrder[]>();
  for (const order of orders) if (order.units > 0) orderGroups.set(order.sku, [...(orderGroups.get(order.sku) ?? []), order]);
  const candidateGroups = new Map<string, CandidateOrder[]>();
  for (const candidate of candidates) candidateGroups.set(candidate.sku, [...(candidateGroups.get(candidate.sku) ?? []), candidate]);

  const policies: SkuPolicy[] = data.skus.map((sku) => {
    const stats = calendar.stats.get(sku.sku)!;
    const lead = leads.get(sku.sku)!;
    const openingStock = calendar.stockAt(sku.sku, config.referenceDate);
    const openUnits = open.bySku.get(sku.sku) ?? 0;
    const openingPosition = openingStock + openUnits - stats.baseMean;
    const ss = safetyStock(stats, lead, z);
    const firstDate = config.horizonStart;
    const rop = futureDemand(stats, firstDate, lead.meanDays, config) + ss;
    const target = futureDemand(stats, firstDate, lead.meanDays + config.targetDays, config) + ss;
    const firstCandidate = (candidateGroups.get(sku.sku) ?? []).sort((a, b) => a.date.localeCompare(b.date))[0];
    const firstApproved = firstCandidate
      ? orders.find((order) => order.sku === sku.sku && order.date === firstCandidate.date && order.units > 0)
      : undefined;
    const decisionDate = firstCandidate?.date ?? firstDate;
    let decisionPosition = openingPosition;
    for (const day of dateRange(config.horizonStart, decisionDate)) if (day < decisionDate) decisionPosition -= demandOn(stats, day, config);
    const decisionRop = futureDemand(stats, decisionDate, lead.meanDays, config) + ss;
    const decisionTarget = futureDemand(stats, decisionDate, lead.meanDays + config.targetDays, config) + ss;
    const historicalLostUnits = stats.positiveStockMean * stats.historicalRuptureDays;
    const historicalLostValue = historicalLostUnits * (stats.realizedPrice ?? 0);
    const simulationSku = simulation.bySku.get(sku.sku)!;
    const review = sku.status === "ativo" && stats.baseUnits === 0;
    const liquidationDiscount = sku.status === "descontinuado" && openingStock > 0 && sku.retailPrice > 0
      ? Math.min(0.4, 1 - sku.unitCost / sku.retailPrice) : null;
    const fundedOrdersForSku = orderGroups.get(sku.sku) ?? [];
    return {
      sku: sku.sku, category: sku.category, status: sku.status, moq: sku.moq, purchaseUnit: sku.purchaseUnit,
      baseMean: stats.baseMean, baseSigma: stats.baseSigma, leadTime: lead,
      safetyStock: ss, openingStock, openOrders: openUnits, openingPosition,
      decisionPosition, reorderPoint: decisionRop, targetLevel: decisionTarget,
      orderQuantity: firstCandidate?.units ?? 0, fundedQuantity: firstApproved?.units ?? 0,
      firstOrderDate: firstCandidate?.date ?? null,
      coverage: firstCandidate?.coverage ?? (avgFutureDemand(stats, firstDate, config.targetDays, config) > 0 ? openingPosition / avgFutureDemand(stats, firstDate, config.targetDays, config) : 0),
      stockoutDays: stats.historicalRuptureDays,
      estimatedLostUnits: historicalLostUnits, estimatedLostValue: historicalLostValue,
      projectedService: stats.baseMean > 0 ? simulationSku.safeDays / dateRange(config.horizonStart, config.horizonEnd).length : 1,
      projectedUnmetUnits: simulationSku.unmetUnits,
      projectedDemandUnits: simulationSku.demandedUnits,
      projectedServedUnits: simulationSku.servedUnits,
      capitalIdle: stats.baseUnits === 0 ? openingStock * sku.unitCost : 0,
      liquidationDiscount: liquidationDiscount !== null && liquidationDiscount > 0 ? liquidationDiscount : null,
      liquidationPrice: liquidationDiscount !== null && liquidationDiscount > 0 ? sku.retailPrice * (1 - liquidationDiscount) : null,
      review,
    };
  });

  const eligibleSkuCount = data.skus.filter((sku) => calendar.stats.get(sku.sku)!.baseMean > 0).length;
  const eligibleSkuDays = simulation.eligibleSkuDays;
  const safeDays = simulation.safeSkuDays;
  const fundedOrders = orders.filter((order) => order.units > 0);
  const totalCost = fundedOrders.reduce((sum, order) => sum + order.cost, 0);
  const totalUnits = fundedOrders.reduce((sum, order) => sum + order.units, 0);
  const holdingCost = simulation.averageInventoryValue * config.monthlyHoldingRate * 3;
  const finalInventoryHoldingCost = simulation.endingInventoryValue * config.monthlyHoldingRate * 3;
  const realizedMargin = policies.reduce((sum, policy) => {
    const sku = data.skus.find((row) => row.sku === policy.sku)!;
    return sum + policy.projectedServedUnits * ((calendar.stats.get(policy.sku)!.realizedPrice ?? sku.retailPrice) - sku.unitCost);
  }, 0);
  const unrealizedMargin = policies.reduce((sum, policy) => {
    const sku = data.skus.find((row) => row.sku === policy.sku)!;
    return sum + policy.projectedUnmetUnits * ((calendar.stats.get(policy.sku)!.realizedPrice ?? sku.retailPrice) - sku.unitCost);
  }, 0);
  const unfundedSkus = [...new Set(orders.filter((order) => order.status === "não financiado").map((order) => order.sku))].map((sku) => {
    const policy = policies.find((row) => row.sku === sku)!;
    return { sku, estimatedLostUnits: policy.projectedUnmetUnits, estimatedLostValue: policy.projectedUnmetUnits * (calendar.stats.get(sku)!.realizedPrice ?? 0) };
  });
  return {
    service, z, budget, orders, policies,
    orderCount: fundedOrders.length, totalUnits, totalCost,
    serviceDaysWithoutStockout: safeDays, serviceDays: eligibleSkuDays,
    serviceRate: eligibleSkuDays ? safeDays / eligibleSkuDays : 1,
    fillRate: simulation.demandedUnits ? simulation.servedUnits / simulation.demandedUnits : 1,
    demandedUnits: simulation.demandedUnits, servedUnits: simulation.servedUnits, unmetUnits: simulation.unmetUnits,
    unrealizedMargin, recoveredMargin: realizedMargin,
    averageInventoryValue: simulation.averageInventoryValue, holdingCost,
    finalInventoryHoldingCost, holdingCostIncludingFinal: holdingCost + finalInventoryHoldingCost,
    endingInventoryUnits: simulation.endingInventoryUnits, endingInventoryValue: simulation.endingInventoryValue,
    netGain: realizedMargin - holdingCost,
    netGainIncludingFinal: realizedMargin - holdingCost - finalInventoryHoldingCost,
    marginalGainPer100k, eligibleSkuCount, eligibleSkuDays,
    positionIdentityViolations: simulation.positionIdentityViolations,
    physicalBalanceViolations: simulation.physicalBalanceViolations,
    unfundedSkus,
  };
}
