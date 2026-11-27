import { readFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");
require.extensions[".ts"] = (module, filename) => module._compile(ts.transpileModule(awaitlessRead(filename), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText, filename);
function awaitlessRead(filename) {
  return require("node:fs").readFileSync(filename, "utf8");
}

const sourceDir = process.env.ESTOQUE_DATA_DIR;
if (!sourceDir) throw new Error("Defina ESTOQUE_DATA_DIR para apontar ao diretório de dados de desenvolvimento.");
const names = { skus: "skus.csv", sales: "vendas_diarias.csv", stock: "estoque_diario.csv", purchases: "compras.csv" };
const texts = Object.fromEntries(await Promise.all(Object.entries(names).map(async ([key, filename]) => [key, await readFile(path.join(sourceDir, filename), "utf8")])));
const appRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const { CONFIG } = require(path.join(appRoot, "src/lib/config.ts"));
const { parseCsv, parseUploadedData, toUnits } = require(path.join(appRoot, "src/lib/phase3/reader.ts"));
const { addDays, dateRange, dayDifference, buildCalendars } = require(path.join(appRoot, "src/lib/phase3/calendar.ts"));
const { buildLeadTimes } = require(path.join(appRoot, "src/lib/phase3/lead-time.ts"));
const { getOpenOrderUnits } = require(path.join(appRoot, "src/lib/phase3/quality.ts"));
const { aggregatePhase3 } = require(path.join(appRoot, "src/lib/phase3/aggregation.ts"));
const { buildScenario } = require(path.join(appRoot, "src/lib/phase3/policy.ts"));

const data = parseUploadedData(texts);
const report = aggregatePhase3(data, CONFIG);
const calendar = buildCalendars(data, CONFIG);
const leads = buildLeadTimes(data, CONFIG);
const open = getOpenOrderUnits(data, CONFIG).bySku;
const rawSales = parseCsv(texts.sales);
const allGroups = new Map();
const baseRawUnits = new Map();
const baseSingleUnits = new Map();
for (const row of rawSales) {
  const key = `${row.sku}|${row.data}`;
  allGroups.set(key, [...(allGroups.get(key) ?? []), row]);
  if (row.data >= CONFIG.baseStart && row.data <= CONFIG.baseEnd) {
    baseRawUnits.set(key, (baseRawUnits.get(key) ?? 0) + Number(row.unidades_vendidas || 0));
    baseSingleUnits.set(key, Number(row.unidades_vendidas || 0));
  }
}
const duplicateGroups = [...allGroups.values()].filter((rows) => rows.length > 1);
const differentDuplicateGroups = duplicateGroups.filter((rows) => rows.some((row) =>
  row.unidades_vendidas !== rows[0].unidades_vendidas || row.receita !== rows[0].receita));
const baseRawTotal = [...baseRawUnits.values()].reduce((sum, value) => sum + value, 0);
const baseDedupTotal = data.sales.filter((sale) => sale.date >= CONFIG.baseStart && sale.date <= CONFIG.baseEnd).reduce((sum, sale) => sum + sale.units, 0);
const baseLastLineTotal = [...baseSingleUnits.values()].reduce((sum, value) => sum + value, 0);
const baseDaysCount = dateRange(CONFIG.baseStart, CONFIG.baseEnd).length;

function forecast(stats, date, days) {
  let total = 0;
  for (let offset = 0; offset < days; offset += 1) {
    const day = addDays(date, offset);
    const factor = day >= CONFIG.campaigns[0].start && day <= CONFIG.campaigns[0].end ? stats.seasonality.blackFriday
      : day >= CONFIG.campaigns[1].start && day <= CONFIG.campaigns[1].end ? stats.seasonality.christmas : 1;
    total += stats.baseMean * factor;
  }
  return total;
}

function traceSku(skuId) {
  const sku = data.skus.find((row) => row.sku === skuId);
  const stats = calendar.stats.get(skuId);
  const lead = leads.get(skuId);
  const z = CONFIG.serviceScenarios.find((scenario) => scenario.service === CONFIG.officialService).z;
  const ss = z * Math.sqrt(lead.meanDays * stats.baseSigma ** 2 + stats.baseMean ** 2 * lead.sigmaDays ** 2);
  const moqUnits = toUnits(sku.moq, sku.purchaseUnit, CONFIG.caseUnits);
  let position = calendar.stockAt(skuId, CONFIG.referenceDate) + (open.get(skuId) ?? 0) - stats.baseMean;
  const trace = [];
  let trigger = null;
  for (const day of dateRange(CONFIG.horizonStart, CONFIG.horizonEnd)) {
    const currentPosition = position;
    const rop = forecast(stats, day, lead.meanDays);
    const target = forecast(stats, day, lead.meanDays + CONFIG.targetDays) + ss;
    const demand = stats.projectedDemand.get(day) ?? stats.baseMean;
    const nextDays = day >= CONFIG.campaigns[0].start && day <= CONFIG.campaigns[0].end ? stats.seasonality.blackFriday
      : day >= CONFIG.campaigns[1].start && day <= CONFIG.campaigns[1].end ? stats.seasonality.christmas : 1;
    const actualRop = rop + ss;
    const q = currentPosition <= actualRop ? Math.ceil(Math.max(0, target - currentPosition) / moqUnits) * moqUnits : 0;
    if (q > 0 && !trigger) trigger = { date: day, position: currentPosition, rop: actualRop, target, q, coverage: currentPosition / (forecast(stats, day, CONFIG.targetDays) / CONFIG.targetDays) };
    trace.push({ date: day, position: currentPosition, demand, seasonFactor: nextDays });
    if (q > 0) position += q;
    position -= demand;
  }
  const point = trigger?.date ? dateRange(addDays(trigger.date, -3), trigger.date).map((date) => trace.find((row) => row.date === date)) : [];
  const policy = report.official.policies.find((row) => row.sku === skuId);
  return {
    sku: skuId, category: sku.category, moq: sku.moq, purchaseUnit: sku.purchaseUnit,
    factors: stats.seasonality, baseMean: stats.baseMean, baseSigma: stats.baseSigma,
    leadTime: { meanDays: lead.meanDays, sigmaDays: lead.sigmaDays, source: lead.source, sourceKey: lead.sourceKey, count: lead.count },
    positionAtReference: policy.openingPosition, trigger, positions3DaysBeforeAndTrigger: point,
    dailyPositionTrace: trace,
    demandNext24: trigger ? forecast(stats, trigger.date, 24) : null,
    demandNext54: trigger ? forecast(stats, trigger.date, 54) : null,
    coverageDays: policy.coverage,
    fundedQuantity: policy.fundedQuantity,
  };
}

const policies = report.official.policies;
const oldReferenceNumbers = {
  budget98: { orderCount: 114, cost: 1_969_995.16, units: 177_200, oldAllSkuDayServiceRate: 0.8791777777777777 },
  historicalLostSales: { units: 85.50803382198033, value: 3_175.421197688035 },
  capitalIdle: 125_514.16,
  unlimitedService: [
    { service: 0.95, cost: 7_099_354.10, skusWithPurchase: 349, safeSkuDays: 44_860 },
    { service: 0.98, cost: 7_235_452.66, skusWithPurchase: 353, safeSkuDays: 44_863 },
    { service: 0.99, cost: 7_338_309.74, skusWithPurchase: 354, safeSkuDays: 44_865 },
  ],
};

function scenarioBreakdown(scenario) {
  const horizon = dateRange(CONFIG.horizonStart, CONFIG.horizonEnd);
  const arrivals = new Map();
  const addArrival = (sku, day, units) => {
    const key = `${sku}|${day}`;
    arrivals.set(key, (arrivals.get(key) ?? 0) + units);
  };
  for (const purchase of data.purchases) {
    if (purchase.receiptDate || dayDifference(CONFIG.referenceDate, purchase.orderDate) > CONFIG.openOrderMaxAgeDays) continue;
    const lead = leads.get(purchase.sku);
    if (!lead || !data.skus.some((sku) => sku.sku === purchase.sku)) continue;
    const expected = addDays(purchase.orderDate, lead.meanDays);
    addArrival(purchase.sku, expected < CONFIG.horizonStart ? CONFIG.horizonStart : expected,
      toUnits(purchase.quantity, purchase.unit, CONFIG.caseUnits));
  }
  for (const order of scenario.orders) if (order.units > 0) addArrival(order.sku, order.arrivalDate, order.units);
  const windows = [
    { name: "Antes de 20/11", start: CONFIG.horizonStart, end: "2026-11-19" },
    { name: "20/11 a 30/11", start: "2026-11-20", end: "2026-11-30" },
    { name: "01/12 a 22/12", start: "2026-12-01", end: "2026-12-22" },
    { name: "23/12 a 29/12", start: "2026-12-23", end: CONFIG.horizonEnd },
  ];
  const byWindow = windows.map((window) => ({ ...window, demanded: 0, served: 0 }));
  const bySku = new Map();
  for (const sku of data.skus) {
    const stats = calendar.stats.get(sku.sku);
    let onHand = Math.max(0, calendar.stockAt(sku.sku, CONFIG.referenceDate) - stats.baseMean);
    let demanded = 0, served = 0, unmet = 0;
    for (const day of horizon) {
      onHand += arrivals.get(`${sku.sku}|${day}`) ?? 0;
      const demand = stats.projectedDemand.get(day) ?? 0;
      const fulfilled = Math.min(demand, Math.max(0, onHand));
      demanded += demand;
      served += fulfilled;
      unmet += demand - fulfilled;
      const window = byWindow.find((item) => day >= item.start && day <= item.end);
      if (window) { window.demanded += demand; window.served += fulfilled; }
      onHand = Math.max(0, onHand - demand);
    }
    bySku.set(sku.sku, { demanded, served, unmet, endingStock: onHand });
  }
  const purchasesBySku = new Map();
  for (const order of scenario.orders) {
    const current = purchasesBySku.get(order.sku) ?? { units: 0, cost: 0 };
    current.units += order.units;
    current.cost += order.cost;
    purchasesBySku.set(order.sku, current);
  }
  return { windows: byWindow.map(({ name, demanded, served }) => ({
    name, demanded, served, fillRate: demanded ? served / demanded : 1,
  })), bySku, purchasesBySku };
}

const scenarioByBudget = (budget) => report.scenarios.find((scenario) => scenario.budget === budget);
const officialZ = CONFIG.serviceScenarios.find((row) => row.service === CONFIG.officialService).z;
const scenario1970 = scenarioByBudget(1_970_000);
const scenario5500 = scenarioByBudget(5_500_000);
const scenario5800 = scenarioByBudget(5_800_000);
const scenarioA1970 = buildScenario(data, calendar, leads, CONFIG.officialService, officialZ, CONFIG, 1_970_000, null, true);
const scenarioA5500 = buildScenario(data, calendar, leads, CONFIG.officialService, officialZ, CONFIG, 5_500_000, null, true);
const detail1970 = scenarioBreakdown(scenario1970);
const detail5500 = scenarioBreakdown(scenario5500);
const detail5800 = scenarioBreakdown(scenario5800);
const detailA1970 = scenarioBreakdown(scenarioA1970);
const detailA5500 = scenarioBreakdown(scenarioA5500);
const skuById = new Map(data.skus.map((sku) => [sku.sku, sku]));
const lateOrderSummary = (scenario) => {
  const orders = scenario.orders.filter((order) => order.units > 0 && order.date >= CONFIG.horizonStart
    && order.date <= CONFIG.horizonEnd && order.arrivalDate > CONFIG.horizonEnd);
  return { orderCount: orders.length, units: orders.reduce((sum, order) => sum + order.units, 0),
    cost: orders.reduce((sum, order) => sum + order.cost, 0), orders: orders.map(({ sku, date, arrivalDate, units, cost }) => ({ sku, date, arrivalDate, units, cost })) };
};
const serviceScenarioSummary = (scenario, detail) => ({
  spent: scenario.totalCost, orderCount: scenario.orderCount, fillRate: scenario.fillRate,
  demandedUnits: scenario.demandedUnits, servedUnits: scenario.servedUnits, unmetUnits: scenario.unmetUnits,
  noRuptureSkuDayRate: scenario.serviceRate, safeSkuDays: scenario.serviceDaysWithoutStockout,
  eligibleSkuDays: scenario.eligibleSkuDays, windows: detail.windows,
});
const allocationBySku = data.skus.map((sku) => {
  const stats = calendar.stats.get(sku.sku);
  const lead = leads.get(sku.sku);
  const demand90 = dateRange(CONFIG.horizonStart, CONFIG.horizonEnd)
    .reduce((sum, day) => sum + (stats.projectedDemand.get(day) ?? 0), 0);
  const safetyStock = officialZ * Math.sqrt(lead.meanDays * stats.baseSigma ** 2 + stats.baseMean ** 2 * lead.sigmaDays ** 2);
  const positionOct1 = calendar.stockAt(sku.sku, CONFIG.referenceDate) + (open.get(sku.sku) ?? 0) - stats.baseMean;
  return { sku: sku.sku, demand90, safetyStock, unitCost: sku.unitCost,
    demandCost: demand90 * sku.unitCost, safetyStockCost: safetyStock * sku.unitCost,
    positionOct1, positionCost: positionOct1 * sku.unitCost };
});
const excessDetails = (detail) => allocationBySku.map((item) => {
  const endingStock = detail.bySku.get(item.sku)?.endingStock ?? 0;
  const excessUnits = Math.max(0, endingStock - item.demand90 - item.safetyStock);
  return { sku: item.sku, excessUnits, excessCost: excessUnits * item.unitCost, endingStock };
}).filter((row) => row.excessUnits > 1e-8).sort((a, b) => b.excessCost - a.excessCost || a.sku.localeCompare(b.sku));
const excess1970 = excessDetails(detail1970);
const excess5500 = excessDetails(detail5500);
const excessA1970 = excessDetails(detailA1970);
const excessA1970ByCategory = {};
for (const row of excessA1970) {
  const category = skuById.get(row.sku).category;
  const item = excessA1970ByCategory[category] ?? { skuCount: 0, excessCost: 0, excessUnits: 0 };
  item.skuCount += 1;
  item.excessCost += row.excessCost;
  item.excessUnits += row.excessUnits;
  excessA1970ByCategory[category] = item;
}
const historicalPurchaseCost = data.purchases.filter((purchase) => purchase.orderDate >= CONFIG.baseStart && purchase.orderDate <= CONFIG.baseEnd)
  .reduce((sum, purchase) => sum + toUnits(purchase.quantity, purchase.unit, CONFIG.caseUnits) * (skuById.get(purchase.sku)?.unitCost ?? 0), 0);
const baseSalesCost = data.sales.filter((sale) => sale.date >= CONFIG.baseStart && sale.date <= CONFIG.baseEnd)
  .reduce((sum, sale) => sum + sale.units * (skuById.get(sale.sku)?.unitCost ?? 0), 0);
const referenceStockCost = data.skus.reduce((sum, sku) => sum + calendar.stockAt(sku.sku, CONFIG.referenceDate) * sku.unitCost, 0);
const openOrdersAtCost = data.skus.reduce((sum, sku) => sum + (open.get(sku.sku) ?? 0) * sku.unitCost, 0);
const openingPositionAfterSep30AtCost = data.skus.reduce((sum, sku) =>
  sum + (calendar.stockAt(sku.sku, CONFIG.referenceDate) + (open.get(sku.sku) ?? 0) - calendar.stats.get(sku.sku).baseMean) * sku.unitCost, 0);
const liquidationRows = report.discontinuedLiquidations.map((policy) => {
  const sku = skuById.get(policy.sku);
  const units = policy.openingStock;
  const inventoryCostValue = units * sku.unitCost;
  const estimatedRevenue = units * (policy.liquidationPrice ?? 0);
  return { sku: policy.sku, category: sku.category, brand: sku.brand, status: sku.status, units,
    discount: policy.liquidationDiscount, inventoryCostValue, unitLiquidationPrice: policy.liquidationPrice,
    estimatedRevenue };
});
const idleBy = (key) => {
  const totals = new Map();
  for (const policy of report.official.policies) {
    if (!policy.capitalIdle) continue;
    const sku = skuById.get(policy.sku);
    const label = sku[key] || "(sem valor)";
    totals.set(label, (totals.get(label) ?? 0) + policy.capitalIdle);
  }
  return Object.fromEntries([...totals].sort((a, b) => b[1] - a[1]));
};
const categoryBrands = new Map();
const brandCategories = new Map();
for (const sku of data.skus) {
  const brands = categoryBrands.get(sku.category) ?? new Set();
  brands.add(sku.brand);
  categoryBrands.set(sku.category, brands);
  const categories = brandCategories.get(sku.brand) ?? new Set();
  categories.add(sku.category);
  brandCategories.set(sku.brand, categories);
}
const extraPurchaseSkus = [...new Set([...detail5500.purchasesBySku.keys(), ...detail5800.purchasesBySku.keys()])]
  .map((sku) => ({ sku, extraSpend: (detail5800.purchasesBySku.get(sku)?.cost ?? 0) - (detail5500.purchasesBySku.get(sku)?.cost ?? 0) }))
  .filter((row) => row.extraSpend > 0)
  .sort((a, b) => b.extraSpend - a.extraSpend || a.sku.localeCompare(b.sku)).slice(0, 15)
  .map(({ sku, extraSpend }) => ({
    sku, extraSpend,
    unitsBought5500: detail5500.purchasesBySku.get(sku)?.units ?? 0,
    unitsBought5800: detail5800.purchasesBySku.get(sku)?.units ?? 0,
    unmet5500: detail5500.bySku.get(sku)?.unmet ?? 0,
    unmet5800: detail5800.bySku.get(sku)?.unmet ?? 0,
    endingStock5500: detail5500.bySku.get(sku)?.endingStock ?? 0,
    endingStock5800: detail5800.bySku.get(sku)?.endingStock ?? 0,
  }));
const priorityTop10 = data.skus.map((sku) => {
  const stats = calendar.stats.get(sku.sku);
  const score = sku.status === "ativo" && stats.baseMean > 0 && sku.unitCost > 0
    ? (((stats.realizedPrice ?? sku.retailPrice) - sku.unitCost) * stats.baseMean) / sku.unitCost : 0;
  const orders1970 = scenario1970.orders.filter((order) => order.sku === sku.sku && order.units > 0);
  return { sku: sku.sku, score, baseMean: stats.baseMean, realizedPrice: stats.realizedPrice,
    unitCost: sku.unitCost, orders1970: orders1970.map((order) => ({ date: order.date, arrivalDate: order.arrivalDate, units: order.units, cost: order.cost })) };
}).filter((row) => row.score > 0).sort((a, b) => b.score - a.score || a.sku.localeCompare(b.sku)).slice(0, 10);
const traceSkus = (process.env.ESTOQUE_TRACE_SKUS ?? "").split(",").map((item) => item.trim()).filter(Boolean);
const priorityChecks = traceSkus.map((sku) => ({
  sku,
  score: priorityTop10.find((row) => row.sku === sku)?.score ?? (() => {
    const row = data.skus.find((item) => item.sku === sku), stats = calendar.stats.get(sku);
    return (((stats.realizedPrice ?? row.retailPrice) - row.unitCost) * stats.baseMean) / row.unitCost;
  })(),
  orderQuantity: scenario1970.policies.find((policy) => policy.sku === sku)?.orderQuantity ?? 0,
  fundedQuantity1970: scenario1970.orders.filter((order) => order.sku === sku && order.units > 0).reduce((sum, order) => sum + order.units, 0),
  fundedCost1970: scenario1970.orders.filter((order) => order.sku === sku && order.units > 0).reduce((sum, order) => sum + order.cost, 0),
  fundedQuantity5500: scenario5500.orders.filter((order) => order.sku === sku && order.units > 0).reduce((sum, order) => sum + order.units, 0),
}));

console.log(JSON.stringify({
  filesRead: Object.fromEntries(Object.entries(names).map(([key, filename]) => [key, filename])),
  referenceDate: CONFIG.referenceDate,
  salesDeduplication: {
    duplicateGroups: duplicateGroups.length,
    conflictingGroups: differentDuplicateGroups.length,
    baseUnitsKeepingOne: baseDedupTotal,
    baseUnitsIfSummed: baseRawTotal,
    baseUnitsIfLastLineKept: baseLastLineTotal,
    meanAfterDedupPerSkuDay: baseDedupTotal / (data.skus.length * baseDaysCount),
    meanIfSummedPerSkuDay: baseRawTotal / (data.skus.length * baseDaysCount),
    differencePerSkuDayVsPreviousSum: (baseDedupTotal - baseRawTotal) / (data.skus.length * baseDaysCount),
  },
  budgetCurve98: report.scenarios.map((scenario) => ({
    budget: Number.isFinite(scenario.budget) ? scenario.budget : "unlimited",
    committed: scenario.totalCost,
    fillRate: scenario.fillRate,
    noRuptureSkuDayRate: scenario.serviceRate,
    safeSkuDays: scenario.serviceDaysWithoutStockout,
    eligibleSkuDays: scenario.eligibleSkuDays,
    unmetUnits: scenario.unmetUnits,
    unrealizedMargin: scenario.unrealizedMargin,
    averageInventoryValue: scenario.averageInventoryValue,
    holdingCost: scenario.holdingCost,
    endingInventoryUnits: scenario.endingInventoryUnits,
    endingInventoryValue: scenario.endingInventoryValue,
    finalInventoryHoldingCost: scenario.finalInventoryHoldingCost,
    holdingCostIncludingFinal: scenario.holdingCostIncludingFinal,
    netGainWithoutFinal: scenario.netGain,
    netGainIncludingFinal: scenario.netGainIncludingFinal,
    positionIdentityViolations: scenario.positionIdentityViolations,
    physicalBalanceViolations: scenario.physicalBalanceViolations,
    recoveredMargin: scenario.recoveredMargin,
    netGain: scenario.netGain,
    marginalGainPer100k: scenario.marginalGainPer100k,
    orderCount: scenario.orderCount,
    units: scenario.totalUnits,
    uniqueSkusWithFundedPurchase: new Set(scenario.orders.filter((order) => order.units > 0).map((order) => order.sku)).size,
  })),
  unboundedServiceScenarios: report.unboundedServiceScenarios.map((scenario) => ({
    service: scenario.service, cost: scenario.totalCost,
    skusWithPurchase: new Set(scenario.orders.filter((order) => order.units > 0).map((order) => order.sku)).size,
    units: scenario.totalUnits, fillRate: scenario.fillRate,
    safeSkuDays: scenario.serviceDaysWithoutStockout, eligibleSkuDays: scenario.eligibleSkuDays,
    noRuptureSkuDayRate: scenario.serviceRate,
  })),
  historicalLoss: {
    units: policies.reduce((sum, policy) => sum + policy.estimatedLostUnits, 0),
    value: policies.reduce((sum, policy) => sum + policy.estimatedLostValue, 0),
    ruptureSkuDays: policies.reduce((sum, policy) => sum + policy.stockoutDays, 0),
  },
  capitalIdle: { value: report.capitalIdle, monthlyHolding: report.monthlyHoldingCost },
  leadTimeLevels: report.leadTimeLevelCounts,
  quality: {
    duplicateRows: report.quality.duplicateRows,
    duplicateSalesConflicts: report.quality.duplicateSalesConflicts,
    negativeStockRows: report.quality.negativeStockRows,
    negativeTreatment: report.quality.negativeStockTreatment,
    negativeAtReferenceSkus: policies.filter((policy) => policy.openingStock < 0).length,
    outOfCatalog: report.quality.outOfCatalog,
    unitMismatches: report.quality.unitMismatches.length,
    purchaseUnitCounts: report.purchaseUnitCounts,
    validReceipts: report.quality.validReceipts,
    openOver90Days: report.quality.openOver90Days,
    filledStockDays: report.quality.filledStockDays,
  },
  salesWithKnownSku: report.salesWithKnownSku,
  demandSkuCount: report.official.eligibleSkuCount,
  skuCount: report.skuCount,
  top10Unmet: report.topUnmetSkus.map((policy) => ({
    sku: policy.sku, baseMean: policy.baseMean, positionAtReference: policy.openingPosition,
    q: policy.orderQuantity, fundedQ: policy.fundedQuantity, purchaseUnit: policy.purchaseUnit,
    unmetUnits: policy.projectedUnmetUnits,
  })),
  selectedSkuDetails: traceSkus.map((sku) => traceSku(sku)),
  windowService: {
    budget1970000: { A: detailA1970.windows, B: detail1970.windows },
    budget5500000: { A: detailA5500.windows, B: detail5500.windows },
  },
  arrivalScenarios: {
    budget1970000: { A: serviceScenarioSummary(scenarioA1970, detailA1970), B: serviceScenarioSummary(scenario1970, detail1970),
      lateOrders: lateOrderSummary(scenario1970) },
    budget5500000: { A: serviceScenarioSummary(scenarioA5500, detailA5500), B: serviceScenarioSummary(scenario5500, detail5500),
      lateOrders: lateOrderSummary(scenario5500) },
  },
  allocationDiagnostic: {
    demandCost: allocationBySku.reduce((sum, item) => sum + item.demandCost, 0),
    safetyStockCost: allocationBySku.reduce((sum, item) => sum + item.safetyStockCost, 0),
    positionOct1Cost: allocationBySku.reduce((sum, item) => sum + item.positionCost, 0),
    scenarios: [
      { budget: 1_970_000, amountPositionPlusBudget: allocationBySku.reduce((sum, item) => sum + item.positionCost, 0) + 1_970_000,
        gapVsDemand: allocationBySku.reduce((sum, item) => sum + item.positionCost, 0) + 1_970_000 - allocationBySku.reduce((sum, item) => sum + item.demandCost, 0),
        spent: scenario1970.totalCost, excessSkuCount: excess1970.length,
        excessCost: excess1970.reduce((sum, row) => sum + row.excessCost, 0), excessBySku: excess1970 },
      { budget: 5_500_000, amountPositionPlusBudget: allocationBySku.reduce((sum, item) => sum + item.positionCost, 0) + 5_500_000,
        gapVsDemand: allocationBySku.reduce((sum, item) => sum + item.positionCost, 0) + 5_500_000 - allocationBySku.reduce((sum, item) => sum + item.demandCost, 0),
        spent: scenario5500.totalCost, excessSkuCount: excess5500.length,
        excessCost: excess5500.reduce((sum, row) => sum + row.excessCost, 0), excessBySku: excess5500 },
    ],
  },
  historicalReconciliation: {
    historicalPurchaseCost,
    baseSalesCost,
    referenceStockCost,
    openOrdersAtCost,
    openingPositionAfterSep30AtCost,
    comparisonBudget1970000: 1_970_000,
    differencesVs1970000: {
      historicalPurchaseCost: historicalPurchaseCost - 1_970_000,
      baseSalesCost: baseSalesCost - 1_970_000,
      referenceStockCost: referenceStockCost - 1_970_000,
    },
    curveSpend: report.scenarios.map((scenario) => ({ budget: Number.isFinite(scenario.budget) ? scenario.budget : "unlimited", spent: scenario.totalCost })),
  },
  liquidationAndIdleCapital: {
    liquidationSkuCount: liquidationRows.length,
    liquidationUnits: liquidationRows.reduce((sum, row) => sum + row.units, 0),
    liquidationInventoryCostValue: liquidationRows.reduce((sum, row) => sum + row.inventoryCostValue, 0),
    liquidationEstimatedRevenue: liquidationRows.reduce((sum, row) => sum + row.estimatedRevenue, 0),
    liquidationRevenueAtUnitSellThrough: Object.fromEntries([1, 0.5, 0.25].map((fraction) => [fraction, liquidationRows.reduce((sum, row) => sum + row.estimatedRevenue * fraction, 0)])),
    liquidationStatusCounts: Object.fromEntries([...new Set(liquidationRows.map((row) => row.status))].map((status) => [status, liquidationRows.filter((row) => row.status === status).length])),
    liquidationRows,
    idleCapitalByCategory: idleBy("category"),
    idleCapitalByBrand: idleBy("brand"),
    totalIdleCapital: report.capitalIdle,
  },
  capitalMetricsScenarioA1970: {
    capitalIdleByCategory: idleBy("category"),
    capitalIdleTotal: report.capitalIdle,
    excessByCategory: excessA1970ByCategory,
    excessBySku: excessA1970,
    excessTotal: excessA1970.reduce((sum, row) => sum + row.excessCost, 0),
    excessSkuCount: excessA1970.length,
  },
  categoryBrandMapping: {
    oneBrandPerCategory: [...categoryBrands.values()].every((brands) => brands.size === 1),
    oneCategoryPerBrand: [...brandCategories.values()].every((categories) => categories.size === 1),
    pairs: Object.fromEntries([...categoryBrands].map(([category, brands]) => [category, [...brands]])),
    categoryCounts: categoryBrands.size,
    brandCounts: brandCategories.size,
  },
  extraPurchases5500To5800: extraPurchaseSkus,
  priorityTop10,
  priorityChecks,
  oldReferenceNumbers,
  differencesVsPrevious: {
    budget98: {
      previousOrders: oldReferenceNumbers.budget98.orderCount,
      currentOrders: report.official.orderCount,
      changeOrders: report.official.orderCount - oldReferenceNumbers.budget98.orderCount,
      previousCost: oldReferenceNumbers.budget98.cost,
      currentCost: report.official.totalCost,
      changeCost: report.official.totalCost - oldReferenceNumbers.budget98.cost,
      previousUnits: oldReferenceNumbers.budget98.units,
      currentUnits: report.official.totalUnits,
      oldServiceRateAllSkuDays: oldReferenceNumbers.budget98.oldAllSkuDayServiceRate,
      comparableOldServiceRateDemandSkus: (39_563 - 17 * 90) / (483 * 90),
      currentServiceRateDemandSkus: report.official.serviceRate,
    },
    historicalLostSales: {
      previousValue: oldReferenceNumbers.historicalLostSales.value,
      currentValue: report.official.policies.reduce((sum, policy) => sum + policy.estimatedLostValue, 0),
      changeValue: report.official.policies.reduce((sum, policy) => sum + policy.estimatedLostValue, 0) - oldReferenceNumbers.historicalLostSales.value,
      previousUnits: oldReferenceNumbers.historicalLostSales.units,
      currentUnits: report.official.policies.reduce((sum, policy) => sum + policy.estimatedLostUnits, 0),
    },
    capitalIdle: { previous: oldReferenceNumbers.capitalIdle, current: report.capitalIdle, change: report.capitalIdle - oldReferenceNumbers.capitalIdle },
    noBudget98: {
      previousCost: oldReferenceNumbers.unlimitedService[1].cost,
      currentCost: report.unboundedServiceScenarios.find((scenario) => scenario.service === 0.98).totalCost,
      changeCost: report.unboundedServiceScenarios.find((scenario) => scenario.service === 0.98).totalCost - oldReferenceNumbers.unlimitedService[1].cost,
      previousSkus: oldReferenceNumbers.unlimitedService[1].skusWithPurchase,
      currentSkus: new Set(report.unboundedServiceScenarios.find((scenario) => scenario.service === 0.98).orders.filter((order) => order.units > 0).map((order) => order.sku)).size,
      previousSafeSkuDaysWithDemandOnly: oldReferenceNumbers.unlimitedService[1].safeSkuDays - 17 * 90,
      currentSafeSkuDays: report.unboundedServiceScenarios.find((scenario) => scenario.service === 0.98).serviceDaysWithoutStockout,
    },
  },
}, null, 2));
