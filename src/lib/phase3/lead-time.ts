import { dayDifference } from "./calendar";
import type { Dataset, LeadTimeStats, Phase3Config, Purchase } from "./types";

export function validReceivedPurchases(purchases: Purchase[], config: Phase3Config): Purchase[] {
  return purchases.filter((purchase) => purchase.receiptDate && purchase.orderDate &&
    purchase.receiptDate >= purchase.orderDate && purchase.receiptDate <= config.referenceDate);
}

function summarize(sku: string, source: LeadTimeStats["source"], sourceKey: string, rows: Purchase[]): LeadTimeStats {
  const times = rows.map((row) => dayDifference(row.receiptDate!, row.orderDate)).filter((days) => days >= 0);
  const rawMeanDays = times.reduce((sum, days) => sum + days, 0) / times.length;
  const meanDays = Math.ceil(rawMeanDays);
  const sigmaDays = Math.sqrt(times.reduce((sum, days) => sum + (days - rawMeanDays) ** 2, 0) / (times.length - 1));
  return { sku, source, sourceKey, count: times.length, meanDays, sigmaDays, rawMeanDays };
}

export function buildLeadTimes(data: Dataset, config: Phase3Config): Map<string, LeadTimeStats> {
  const valid = validReceivedPurchases(data.purchases, config);
  const allBySku = new Map<string, Purchase[]>();
  const allBySupplier = new Map<string, Purchase[]>();
  for (const row of valid) {
    allBySku.set(row.sku, [...(allBySku.get(row.sku) ?? []), row]);
    allBySupplier.set(row.supplier, [...(allBySupplier.get(row.supplier) ?? []), row]);
  }
  const result = new Map<string, LeadTimeStats>();
  for (const sku of data.skus) {
    const skuRows = allBySku.get(sku.sku) ?? [];
    const supplierRows = allBySupplier.get(sku.supplier) ?? [];
    if (skuRows.length >= 3) result.set(sku.sku, summarize(sku.sku, "SKU", sku.sku, skuRows));
    else if (supplierRows.length >= 3) result.set(sku.sku, summarize(sku.sku, "Fornecedor", sku.supplier, supplierRows));
    else result.set(sku.sku, summarize(sku.sku, "Global", "todos", valid));
  }
  return result;
}
