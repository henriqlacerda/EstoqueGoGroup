export type CsvRow = Record<string, string>;

export interface Sku {
  sku: string;
  brand: string;
  description: string;
  category: string;
  status: string;
  unitCost: number;
  retailPrice: number;
  supplier: string;
  purchaseUnit: string;
  moq: number;
}

export interface Sale { sku: string; date: string; units: number; revenue: number }
export interface StockRecord { sku: string; date: string; units: number }
export interface Purchase {
  id: string;
  supplier: string;
  sku: string;
  orderDate: string;
  receiptDate: string | null;
  quantity: number;
  unit: string;
}
export interface Supplier { supplier: string; name: string }

export interface Phase3Config {
  referenceDate: string;
  baseStart: string;
  baseEnd: string;
  horizonStart: string;
  horizonEnd: string;
  seasonalityBaseStart: string;
  seasonalityBaseEnd: string;
  campaigns: Array<{ name: string; start: string; end: string; sourceStart: string; sourceEnd: string }>;
  targetDays: number;
  openOrderMaxAgeDays: number;
  budget: number;
  monthlyHoldingRate: number;
  serviceScenarios: Array<{ service: number; z: number }>;
  officialService: number;
  caseUnits: number;
}

export interface Dataset {
  skus: Sku[];
  sales: Sale[];
  stock: StockRecord[];
  purchases: Purchase[];
  salesDuplicateRows: number;
  salesDuplicateConflicts: number;
}

export interface DemandStats {
  sku: Sku;
  baseMean: number;
  baseSigma: number;
  baseUnits: number;
  baseRevenue: number;
  realizedPrice: number | null;
  positiveStockMean: number;
  positiveStockDays: number;
  historicalRuptureDays: number;
  dailyDemand: Map<string, number>;
  projectedDemand: Map<string, number>;
  projectedAverage: number;
  projected30DayAverage: number;
  seasonality: { blackFriday: number; christmas: number };
}

export interface LeadTimeStats {
  sku: string;
  source: "SKU" | "Fornecedor" | "Global";
  sourceKey: string;
  count: number;
  meanDays: number;
  sigmaDays: number;
  rawMeanDays: number;
}

export interface QualityReport {
  duplicateRows: Record<string, number>;
  duplicateSalesConflicts: number;
  negativeStockTreatment: string;
  outOfCatalog: Record<string, number>;
  negativeStockRows: number;
  receiptBeforeOrder: number;
  openOver90Days: number;
  openOrdersExcluded: number;
  filledStockDays: number;
  filledStockDaysBySku: Record<string, number>;
  unitMismatches: Array<{ sku: string; poId: string; purchaseUnit: string; catalogUnit: string }>;
  validReceipts: number;
  leadTimeLevels: Record<"SKU" | "Fornecedor" | "Global", number>;
}

export interface SimulatedOrder {
  sku: string;
  date: string;
  arrivalDate: string;
  units: number;
  moqUnits: number;
  coverage: number;
  cost: number;
  status: "financiado" | "parcial" | "não financiado";
}

export interface SkuPolicy {
  sku: string;
  category: string;
  status: string;
  moq: number;
  purchaseUnit: string;
  baseMean: number;
  baseSigma: number;
  leadTime: LeadTimeStats;
  safetyStock: number;
  openingStock: number;
  openOrders: number;
  openingPosition: number;
  decisionPosition: number;
  reorderPoint: number;
  targetLevel: number;
  orderQuantity: number;
  fundedQuantity: number;
  firstOrderDate: string | null;
  coverage: number;
  stockoutDays: number;
  estimatedLostUnits: number;
  estimatedLostValue: number;
  projectedService: number;
  projectedUnmetUnits: number;
  projectedDemandUnits: number;
  projectedServedUnits: number;
  capitalIdle: number;
  liquidationDiscount: number | null;
  liquidationPrice: number | null;
  review: boolean;
}

export interface ScenarioSummary {
  service: number;
  z: number;
  budget: number;
  orders: SimulatedOrder[];
  policies: SkuPolicy[];
  orderCount: number;
  totalUnits: number;
  totalCost: number;
  serviceDaysWithoutStockout: number;
  serviceDays: number;
  serviceRate: number;
  fillRate: number;
  demandedUnits: number;
  servedUnits: number;
  unmetUnits: number;
  unrealizedMargin: number;
  recoveredMargin: number;
  averageInventoryValue: number;
  endingInventoryUnits: number;
  endingInventoryValue: number;
  positionIdentityViolations: number;
  physicalBalanceViolations: number;
  holdingCost: number;
  finalInventoryHoldingCost: number;
  holdingCostIncludingFinal: number;
  netGain: number;
  netGainIncludingFinal: number;
  marginalGainPer100k: number | null;
  eligibleSkuCount: number;
  eligibleSkuDays: number;
  unfundedSkus: Array<{ sku: string; estimatedLostUnits: number; estimatedLostValue: number }>;
}

export interface Phase3Report {
  referenceDate: string;
  quality: QualityReport;
  leadTimeLevelCounts: Record<"SKU" | "Fornecedor" | "Global", number>;
  scenarios: ScenarioSummary[];
  unboundedServiceScenarios: ScenarioSummary[];
  official: ScenarioSummary;
  capitalIdle: number;
  monthlyHoldingCost: number;
  discontinuedLiquidations: SkuPolicy[];
  activeNoSales: SkuPolicy[];
  sampleWithSales: SkuPolicy | null;
  sampleInRupture: SkuPolicy | null;
  skuCount: number;
  topUnmetSkus: SkuPolicy[];
  salesWithKnownSku: number;
  purchaseUnitCounts: Record<string, number>;
}
