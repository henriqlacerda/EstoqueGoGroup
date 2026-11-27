import type { Dataset, DemandStats, Phase3Config, Sale, StockRecord } from "./types";

export function dateRange(start: string, end: string): string[] {
  const result: string[] = [];
  const cursor = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  while (cursor <= last) {
    result.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return result;
}

export function addDays(date: string, days: number): string {
  const result = new Date(`${date}T00:00:00Z`);
  result.setUTCDate(result.getUTCDate() + days);
  return result.toISOString().slice(0, 10);
}

export function dayDifference(later: string, earlier: string): number {
  return Math.round((Date.parse(`${later}T00:00:00Z`) - Date.parse(`${earlier}T00:00:00Z`)) / 86_400_000);
}

export function makeStockLookup(stock: StockRecord[]) {
  const grouped = new Map<string, StockRecord[]>();
  for (const row of stock) {
    const rows = grouped.get(row.sku);
    if (rows) rows.push(row);
    else grouped.set(row.sku, [row]);
  }
  for (const rows of grouped.values()) rows.sort((a, b) => a.date.localeCompare(b.date));
  return (sku: string, date: string): number => {
    const rows = grouped.get(sku) ?? [];
    let low = 0;
    let high = rows.length - 1;
    let found = -1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (rows[mid].date <= date) { found = mid; low = mid + 1; }
      else high = mid - 1;
    }
    return found >= 0 ? Math.max(0, rows[found].units) : 0;
  };
}

function sampleSd(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1));
}

function average(values: number[]): number { return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0; }

export interface CalendarResult {
  stats: Map<string, DemandStats>;
  stockAt: (sku: string, date: string) => number;
  filledStockDaysBySku: Record<string, number>;
  seasonalityByCategory: Map<string, { blackFriday: number; christmas: number }>;
}

export function buildCalendars(data: Dataset, config: Phase3Config): CalendarResult {
  const stockAt = makeStockLookup(data.stock);
  const skuCategory = new Map(data.skus.map((sku) => [sku.sku, sku.category]));
  const categoryByDay = new Map<string, number>();
  for (const sale of data.sales) {
    const category = skuCategory.get(sale.sku);
    if (category) {
      const key = `${category}|${sale.date}`;
      categoryByDay.set(key, (categoryByDay.get(key) ?? 0) + sale.units);
    }
  }
  const salesBySkuDate = new Map<string, Sale>();
  for (const sale of data.sales) {
    const key = `${sale.sku}|${sale.date}`;
    const previous = salesBySkuDate.get(key);
    salesBySkuDate.set(key, previous
      ? { ...previous, units: previous.units + sale.units, revenue: previous.revenue + sale.revenue }
      : sale);
  }
  const baseDays = dateRange(config.baseStart, config.baseEnd);
  const seasonBaseDays = dateRange(config.seasonalityBaseStart, config.seasonalityBaseEnd);
  const campaignDays = config.campaigns.map((campaign) => dateRange(campaign.sourceStart, campaign.sourceEnd));
  const categories = [...new Set(data.skus.map((sku) => sku.category))];
  const seasonalityByCategory = new Map<string, { blackFriday: number; christmas: number }>();
  for (const category of categories) {
    const totalForDays = (days: string[]) => days.map((day) => categoryByDay.get(`${category}|${day}`) ?? 0);
    const baseline = average(totalForDays(seasonBaseDays));
    const factors = campaignDays.map((days) => baseline === 0 ? 1 : average(totalForDays(days)) / baseline);
    seasonalityByCategory.set(category, { blackFriday: factors[0], christmas: factors[1] });
  }

  const projectedDays = dateRange(config.horizonStart, config.horizonEnd);
  const stats = new Map<string, DemandStats>();
  const filledStockDaysBySku: Record<string, number> = {};
  const rowsBySku = new Map<string, StockRecord[]>();
  for (const row of data.stock) {
    const rows = rowsBySku.get(row.sku);
    if (rows) rows.push(row);
    else rowsBySku.set(row.sku, [row]);
  }
  for (const rows of rowsBySku.values()) rows.sort((a, b) => a.date.localeCompare(b.date));

  for (const sku of data.skus) {
    const dailyDemand = new Map(baseDays.map((day) => [day, salesBySkuDate.get(`${sku.sku}|${day}`)?.units ?? 0]));
    const baseValues = [...dailyDemand.values()];
    const baseMean = average(baseValues);
    const baseUnits = baseValues.reduce((sum, value) => sum + value, 0);
    const baseRevenue = baseDays.reduce((sum, day) => sum + (salesBySkuDate.get(`${sku.sku}|${day}`)?.revenue ?? 0), 0);
    const factors = seasonalityByCategory.get(sku.category) ?? { blackFriday: 1, christmas: 1 };
    const projectedDemand = new Map<string, number>();
    for (const day of projectedDays) {
      const factor = day >= config.campaigns[0].start && day <= config.campaigns[0].end ? factors.blackFriday
        : day >= config.campaigns[1].start && day <= config.campaigns[1].end ? factors.christmas : 1;
      projectedDemand.set(day, baseMean * factor);
    }
    const positiveStockValues = baseDays.filter((day) => stockAt(sku.sku, day) > 0).map((day) => dailyDemand.get(day) ?? 0);
    const stockRows = rowsBySku.get(sku.sku) ?? [];
    const firstStockDate = stockRows[0]?.date;
    const stockDates = new Set(stockRows.map((row) => row.date));
    filledStockDaysBySku[sku.sku] = firstStockDate && firstStockDate <= config.referenceDate
      ? dateRange(firstStockDate, config.referenceDate).filter((day) => !stockDates.has(day)).length : 0;
    const realizedPrice = baseUnits > 0 ? baseRevenue / baseUnits : null;
    const historicalRuptureDays = baseDays.filter((day) => stockAt(sku.sku, day) <= 0 && (dailyDemand.get(day) ?? 0) > 0).length;
    stats.set(sku.sku, {
      sku, baseMean, baseSigma: sampleSd(baseValues), baseUnits, baseRevenue, realizedPrice,
      positiveStockMean: average(positiveStockValues), positiveStockDays: positiveStockValues.length, historicalRuptureDays,
      dailyDemand, projectedDemand,
      projectedAverage: average([...projectedDemand.values()]),
      projected30DayAverage: average([...projectedDemand.values()].slice(0, config.targetDays)),
      seasonality: factors,
    });
  }
  return { stats, stockAt, filledStockDaysBySku, seasonalityByCategory };
}

export function getDailySalesMap(sales: Sale[]): Map<string, Sale> {
  const result = new Map<string, Sale>();
  for (const sale of sales) {
    const key = `${sale.sku}|${sale.date}`;
    const previous = result.get(key);
    result.set(key, previous
      ? { ...previous, units: previous.units + sale.units, revenue: previous.revenue + sale.revenue }
      : sale);
  }
  return result;
}
