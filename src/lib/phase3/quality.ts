import { dayDifference } from "./calendar";
import { validReceivedPurchases } from "./lead-time";
import { toUnits } from "./reader";
import type { Dataset, LeadTimeStats, Phase3Config, QualityReport } from "./types";

function duplicateRows<T>(rows: T[], key: (row: T) => string): number {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(key(row), (counts.get(key(row)) ?? 0) + 1);
  return [...counts.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0);
}

export function buildQualityReport(
  data: Dataset,
  filledStockDaysBySku: Record<string, number>,
  leadTimes: Map<string, LeadTimeStats>,
  config: Phase3Config,
): QualityReport {
  const skuMap = new Map(data.skus.map((sku) => [sku.sku, sku]));
  const validReceipts = validReceivedPurchases(data.purchases, config);
  const openOver90 = data.purchases.filter((row) => !row.receiptDate && dayDifference(config.referenceDate, row.orderDate) > config.openOrderMaxAgeDays);
  const levels: QualityReport["leadTimeLevels"] = { SKU: 0, Fornecedor: 0, Global: 0 };
  for (const row of leadTimes.values()) levels[row.source] += 1;
  const unitMismatches = data.purchases.flatMap((row) => {
    const sku = skuMap.get(row.sku);
    return sku && row.unit.trim().toLowerCase() !== sku.purchaseUnit.trim().toLowerCase()
      ? [{ sku: row.sku, poId: row.id, purchaseUnit: row.unit, catalogUnit: sku.purchaseUnit }] : [];
  });
  const filled = Object.values(filledStockDaysBySku).reduce((sum, days) => sum + days, 0);
  return {
    duplicateRows: {
      skus: duplicateRows(data.skus, (row) => row.sku),
      vendas_diarias: data.salesDuplicateRows,
      estoque_diario: duplicateRows(data.stock, (row) => `${row.sku}|${row.date}`),
      compras: duplicateRows(data.purchases, (row) => `${row.id}|${row.sku}`),
    },
    duplicateSalesConflicts: data.salesDuplicateConflicts,
    negativeStockTreatment: "Saldos abaixo de zero tratados como zero na posição e na simulação; dias com saldo final ≤ 0 e venda contam como ruptura.",
    outOfCatalog: {
      vendas_diarias: data.sales.filter((row) => !skuMap.has(row.sku)).length,
      estoque_diario: data.stock.filter((row) => !skuMap.has(row.sku)).length,
      compras: data.purchases.filter((row) => !skuMap.has(row.sku)).length,
    },
    negativeStockRows: data.stock.filter((row) => row.units < 0).length,
    receiptBeforeOrder: data.purchases.filter((row) => row.receiptDate && row.receiptDate < row.orderDate).length,
    openOver90Days: openOver90.length,
    openOrdersExcluded: openOver90.length,
    filledStockDays: filled,
    filledStockDaysBySku,
    unitMismatches,
    validReceipts: validReceipts.length,
    leadTimeLevels: levels,
  };
}

export function getOpenOrderUnits(data: Dataset, config: Phase3Config) {
  const skuMap = new Map(data.skus.map((sku) => [sku.sku, sku]));
  const bySku = new Map<string, number>();
  const excluded = new Set<string>();
  for (const row of data.purchases) {
    if (row.receiptDate) continue;
    if (dayDifference(config.referenceDate, row.orderDate) > config.openOrderMaxAgeDays) { excluded.add(row.sku); continue; }
    if (!skuMap.has(row.sku)) continue;
    bySku.set(row.sku, (bySku.get(row.sku) ?? 0) + toUnits(row.quantity, row.unit, config.caseUnits));
  }
  return { bySku, excluded };
}
